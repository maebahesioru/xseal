/**
 * xseal — X(旧Twitter)投稿用「暗号封筒」
 * v1: AES-GCM + deflate-raw + base64url/base85      (互換用に維持)
 * v2: AES-GCM + (deflate-raw | 静的Huffman) + base1024 (容量最大)
 *
 * v1: <mark>x1> + ENCODE( flags(1) || iv(12) || ct || tag )
 *     flags bit0=1 → deflate-raw 済み
 * v2: <mark>x2> + ALPHA1024( flags(1) || iv(12) || ct || tag )
 *     flags bit0-1 = codec (0=無圧縮 1=deflate 2=huffman), bit2-4 = 末尾0詰めバイト数
 * AAD は版ごとに固定（他プロトコルとの取り違え防止）
 *
 * 設計上の約束:
 *   - 暗号プリミティブは自作しない(WebCrypto の AES-GCM をそのまま使う)
 *   - IV は必ずメッセージごとにランダム生成。固定IV/連番の使い回しは禁止
 *   - 認証タグを削らない(削ると改ざん・なりすましが通る)
 */

import { ALPHA } from './alpha1024.mjs';
import { ALPHA2048 } from './alpha2048.mjs';
import { hufCompress, hufDecompress } from './huff.mjs';
import { loadModel, acEncode, acDecode } from './ac.mjs';
import * as ACDEFAULT from './ac_model_1024.mjs';
import * as ACSELF from './ac_model_s2.mjs';   // 疎な次数2上書き表つき（自分の文章向け）
/** 既定の算術符号モデル。パーソナルモデルに差し替えられる（cfg.acModel が優先） */
let _defaultAc = ACDEFAULT;
export function setDefaultAcModel(m) { _defaultAc = m; }
export function getDefaultAcModel() { return _defaultAc; }

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ------------------------------------------------------------------ *
 * X の weighted length (twitter-text の configurations.json 準拠)
 * 既定 200 / 次の範囲だけ 100: [0,4351] [8192,8205] [8208,8223] [8242,8247]
 * URL は 23 として数える
 * ------------------------------------------------------------------ */
const W100 = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
const URL_RE = /https?:\/\/\S+/g;

export function weightedLength(text, { countUrls = true } = {}) {
  if (countUrls) {
    const urls = text.match(URL_RE) || [];
    if (urls.length) return weightedLength(text.replace(URL_RE, ''), { countUrls: false }) + urls.length * 23;
  }
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    n += W100.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return n;
}

/* ------------------------------------------------------------------ *
 * エンコーディング
 *   b64  : base64url (A-Za-z0-9-_) — どこでも安全。標準プロファイル
 *   b85  : 85文字アルファベット — 1.25倍で済む。# @ . / : " ' \ は避ける
 * ------------------------------------------------------------------ */
const B85 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!$%&()*+-;<=>?[]^_{|}~`';

function toB64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64u(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// base85 は 4 バイト → 5 文字の完全ブロックのみ扱う。
// 端数を自前で丸めると復号が壊れる(実測で踏んだ)ので、
// 呼び出し側で 0 詰めして 4 の倍数にしてから渡す。
function toB85(bytes) {
  if (bytes.length % 4 !== 0) throw new Error('xseal: base85 は4の倍数バイトのみ');
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) {
    let n = ((bytes[i] * 256 + bytes[i + 1]) * 256 + bytes[i + 2]) * 256 + bytes[i + 3];
    const c = new Array(5);
    for (let k = 4; k >= 0; k--) { c[k] = B85[n % 85]; n = Math.floor(n / 85); }
    out += c.join('');
  }
  return out;
}
function fromB85(str) {
  if (str.length % 5 !== 0) throw new Error('xseal: base85 の長さが不正');
  const out = new Uint8Array((str.length / 5) * 4);
  let o = 0;
  for (let i = 0; i < str.length; i += 5) {
    let n = 0;
    for (let k = 0; k < 5; k++) {
      const d = B85.indexOf(str[i + k]);
      if (d < 0) throw new Error(`xseal: 不正な文字 '${str[i + k]}'`);
      n = n * 85 + d;
    }
    if (n > 0xffffffff) throw new Error('xseal: base85 の値域超過');
    out[o++] = (n >>> 24) & 255;
    out[o++] = (n >>> 16) & 255;
    out[o++] = (n >>> 8) & 255;
    out[o++] = n & 255;
  }
  return out;
}
/* base1024: 4文字で 5バイト(40bit)。1024文字なので 1文字=10bit=1.25バイト。 */
const A_CHARS = Array.from(ALPHA);
const A_IDX = new Map(A_CHARS.map((c, i) => [c, i]));

function toA1024(bytes) {
  const pad = (5 - (bytes.length % 5)) % 5;
  const n = bytes.length + pad;
  let out = '';
  for (let i = 0; i < n; i += 5) {
    const b0 = bytes[i] || 0, b1 = bytes[i + 1] || 0, b2 = bytes[i + 2] || 0;
    const b3 = bytes[i + 3] || 0, b4 = bytes[i + 4] || 0;
    const hi = (b0 << 12) | (b1 << 4) | (b2 >>> 4);              // 20bit
    const lo = ((b2 & 15) << 16) | (b3 << 8) | b4;               // 20bit
    out += A_CHARS[hi >>> 10] + A_CHARS[hi & 1023] + A_CHARS[lo >>> 10] + A_CHARS[lo & 1023];
  }
  return out;
}

function fromA1024(str) {
  const cps = Array.from(str);
  if (cps.length % 4) throw new Error('xseal: base1024 の長さが不正です');
  const out = new Uint8Array((cps.length / 4) * 5);
  let o = 0;
  for (let i = 0; i < cps.length; i += 4) {
    const c0 = A_IDX.get(cps[i]), c1 = A_IDX.get(cps[i + 1]);
    const c2 = A_IDX.get(cps[i + 2]), c3 = A_IDX.get(cps[i + 3]);
    if (c0 === undefined || c1 === undefined || c2 === undefined || c3 === undefined) {
      throw new Error('xseal: base1024 に無い文字が含まれています');
    }
    const hi = (c0 << 10) | c1, lo = (c2 << 10) | c3;
    out[o++] = hi >>> 12;
    out[o++] = (hi >>> 4) & 0xff;
    out[o++] = ((hi & 15) << 4) | (lo >>> 16);
    out[o++] = (lo >>> 8) & 0xff;
    out[o++] = lo & 0xff;
  }
  return out;
}

const encodeBytes = (alpha, bytes) =>
  alpha === 'b85' ? toB85(bytes) : alpha === 'a1024' ? toA1024(bytes) : toB64u(bytes);
const decodeBytes = (alpha, str) =>
  alpha === 'b85' ? fromB85(str) : alpha === 'a1024' ? fromA1024(str) : fromB64u(str);

/* ------------------------------------------------------------------ *
 * v3: ビット単位パッキング（base1024 = 10bit / base2048 = 11bit）
 *   バイト列を上位ビットから bpc ビットずつ切り出して文字に落とす。
 *   端数の曖昧さを消すため、バイト列側を group バイトの倍数に0詰めする
 *   （10bit → 5バイト = 4文字、11bit → 11バイト = 8文字で端数ゼロ）。
 *   詰めたバイト数は flags bit2-5 に記録する。
 * ------------------------------------------------------------------ */
const A1024_CHARS = Array.from(ALPHA);
const A1024_IDX = new Map(A1024_CHARS.map((c, i) => [c, i]));
const A2048_CHARS = Array.from(ALPHA2048);
const A2048_IDX = new Map(A2048_CHARS.map((c, i) => [c, i]));

function packBits(bytes, chars, bpc) {
  const mask = (1 << bpc) - 1;
  if ((bytes.length * 8) % bpc) throw new Error('xseal: バイト長が bpc の倍数ではありません');
  let acc = 0, n = 0, out = '';
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | bytes[i];
    n += 8;
    while (n >= bpc) {
      n -= bpc;
      out += chars[(acc >> n) & mask];
      acc &= n ? (1 << n) - 1 : 0;
    }
  }
  return out;
}

function unpackBits(str, idx, bpc) {
  const syms = Array.from(str).length;
  const totalBits = syms * bpc;
  if (totalBits % 8) throw new Error('xseal: ビット長が不正です');
  const out = new Uint8Array(totalBits / 8);
  let acc = 0, n = 0, o = 0;
  for (const c of str) {
    const s = idx.get(c);
    if (s === undefined) throw new Error('xseal: 未知の文字が含まれています');
    acc = (acc << bpc) | s;
    n += bpc;
    while (n >= 8) {
      n -= 8;
      out[o++] = (acc >> n) & 0xff;
      acc &= n ? (1 << n) - 1 : 0;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * プロファイル
 * ------------------------------------------------------------------ */
export const PROFILES = {
  /** v1 標準。可搬性最優先。base64url + deflate */
  std: { alphabet: 'b64', tagBits: 128, mark: 'x1', aad: 'xseal-v1' },
  /** v1 容量優先。base85 + 64bitタグ */
  tight: { alphabet: 'b85', tagBits: 64, mark: 'x1', aad: 'xseal-v1' },
  /** v2 容量優先。base1024 + 静的Huffman */
  max: { alphabet: 'a1024', tagBits: 128, mark: 'x2', aad: 'xseal-v2', v2: true },
  /** v3 base1024 + 次数1算術符号。フォント被覆が安全な範囲で最大容量 */
  deep: { alphabet: 'a1024', tagBits: 96, mark: 'x3', aad: 'xseal-v3', v3: true },
  /** v3 base2048 + 次数1算術符号。理論最大（端末フォントのフォールバック前提） */
  ultra: { alphabet: 'a2048', tagBits: 64, mark: 'x4', aad: 'xseal-v3', v3: true },
  self: { alphabet: 'a2048', tagBits: 64, mark: 'x5', aad: 'xseal-v3', v3: true, lenModel: ACSELF },
  /** 鍵なし（暗号化しない）。圧縮だけで検索に引っかからなくする用途の既定 */
  plain: { alphabet: 'a2048', tagBits: 0, mark: 'xo', aad: 'xseal-plain', v3: true, plain: true },
};
const V3_CHARS = { a1024: A1024_CHARS, a2048: A2048_CHARS };
const V3_IDX = { a1024: A1024_IDX, a2048: A2048_IDX };
const V3_BPC = { a1024: 10, a2048: 11 };

/* ------------------------------------------------------------------ *
 * deflate-raw (Chrome 103+ / Firefox 113+ / Safari 16.4+)
 * ------------------------------------------------------------------ */
async function deflateRaw(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

/* ------------------------------------------------------------------ *
 * 鍵導出
 *   PBKDF2-SHA256 210,000 回。salt は 16B ランダム(秘密ではない/設定に保存する)
 *   グループが変わったら salt もパスフレーズも別にする
 * ------------------------------------------------------------------ */
export const DEFAULT_ITERATIONS = 210000;

export async function deriveKey(passphrase, { salt, iterations = DEFAULT_ITERATIONS } = {}) {
  const saltBytes = salt ? (typeof salt === 'string' ? fromB64u(salt) : salt) : crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { key, salt: toB64u(saltBytes), iterations };
}

/* ------------------------------------------------------------------ *
 * 封印 / 開封
 * ------------------------------------------------------------------ */
const COMPRESS_MIN_BYTES = 48; // これ未満は deflate しても小さくならないことが多い

/** 本文の圧縮。v2/v3 では「無圧縮 / deflate / 静的Huffman / 次数1算術」の最小を選ぶ */
async function packBody(text, raw, auto, ac = false, lenAc = false) {   // ac/lenAc: 算術符号モデル(モジュール) or false
  let body = raw;
  let codec = 0;
  let alt = false;
  if (!auto) {
    if (raw.length >= COMPRESS_MIN_BYTES) {
      const z = await deflateRaw(raw);
      if (z.length < raw.length) { body = z; codec = 1; }
    }
    return { body, codec, alt };
  }
  const cands = [];
  if (raw.length >= COMPRESS_MIN_BYTES) {
    try { cands.push([1, await deflateRaw(raw)]); } catch { /* 非対応環境 */ }
  }
  try { cands.push([2, hufCompress(text)]); } catch { /* モデル読込失敗など */ }
  if (ac) {
    try { const M = await loadModel(ac); cands.push([3, acEncode(M, text), false]); } catch { /* 算術符号器が使えない環境 */ }
  }
  if (lenAc) {
    try { const M = await loadModel(lenAc); cands.push([3, acEncode(M, text), true]); } catch { /* 専用モデルが無い環境 */ }
  }
  for (const [id, buf, a] of cands) {
    if (buf.length < body.length) { body = buf; codec = id; alt = !!a; }
  }
  return { body, codec, alt };
}

export async function seal(cfg, key, text) {
  const raw = enc.encode(text);
  const isV3 = !!cfg.v3;
  const acModel = isV3 ? (cfg.acModel || _defaultAc) : false;
  const { body, codec, alt } = await packBody(text, raw, !!(cfg.v2 || cfg.v3), acModel, isV3 ? cfg.lenModel : false);
  if (cfg.plain) {
    // 鍵なし: ヘッダ1バイト + 圧縮本文だけ。IVもタグも持たない
    const bpc = V3_BPC[cfg.alphabet];
    const group = bpc === 11 ? 11 : 5;
    const total = 1 + body.length;
    const pad = (group - (total % group)) % group;
    const buf = new Uint8Array(total + pad);
    buf[0] = codec | (pad << 2) | (alt ? 0x40 : 0);
    buf.set(body, 1);
    return cfg.mark + packBits(buf, V3_CHARS[cfg.alphabet], bpc);
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: cfg.tagBits, additionalData: enc.encode(cfg.aad) },
    key,
    body,
  ));
  const total = 1 + 12 + ct.length;
  if (isV3) {
    const bpc = V3_BPC[cfg.alphabet];
    const group = bpc === 11 ? 11 : 5;          // 5B=40bit=4文字 / 11B=88bit=8文字
    const pad = (group - (total % group)) % group;
    const buf = new Uint8Array(total + pad);
    buf[0] = codec | (pad << 2) | (alt ? 0x40 : 0);
    buf.set(iv, 1);
    buf.set(ct, 13);
    return cfg.mark + packBits(buf, V3_CHARS[cfg.alphabet], bpc);
  }
  const out = new Uint8Array(total);
  let flags = codec;
  if (cfg.v2) {
    const pad = (5 - (total % 5)) % 5;   // base1024 は5バイト単位
    flags |= pad << 2;
    out[0] = flags;
    out.set(iv, 1);
    out.set(ct, 13);
    return cfg.mark + toA1024(out);
  }
  out[0] = flags;
  out.set(iv, 1);
  out.set(ct, 13);
  return cfg.mark + encodeBytes(cfg.alphabet, padForB85(cfg, out));
}

/** base85 用に 4 の倍数まで 0 詰めし、詰めた数を flags の bit1-2 に記録する */
function padForB85(cfg, bytes) {
  if (cfg.alphabet !== 'b85') return bytes;
  const pad = (4 - (bytes.length % 4)) % 4;
  if (!pad) return bytes;
  const out = new Uint8Array(bytes.length + pad);
  out.set(bytes);
  out[0] = bytes[0] | (pad << 1);
  return out;
}

export function isSealed(cfg, text) {
  const t = text.trim();
  if (!t.startsWith(cfg.mark)) return false;
  const body = t.slice(cfg.mark.length);
  if (cfg.v3) {
    const bpc = V3_BPC[cfg.alphabet];
    const group = bpc === 11 ? 11 : 5;
    const minBytes = cfg.plain ? 1 : 1 + 12 + cfg.tagBits / 8;
    const minChars = Math.ceil(minBytes / group) * (group * 8 / bpc);
    const syms = Array.from(body).length;
    if (syms < minChars) return false;
    if ((syms * bpc) % 8) return false;
    const idx = V3_IDX[cfg.alphabet];
    for (const c of body) if (!idx.has(c)) return false;
    return true;
  }
  if (body.length < 24) return false;
  if (cfg.alphabet === 'a1024') {
    if (Array.from(body).length % 4) return false;
    for (const c of body) if (!A_IDX.has(c)) return false;
    return true;
  }
  const re = cfg.alphabet === 'b85'
    ? /^[A-Za-z0-9!$%&()*+\-;<=>?\[\]^_{|}~`]+$/
    : /^[A-Za-z0-9_-]+$/;
  return re.test(body);
}

export async function open(cfg, keys, message) {
  const t = message.trim();
  if (!isSealed(cfg, t)) throw new Error('xseal: 暗号投稿の形式ではありません');
  const bodyStr = t.slice(cfg.mark.length);
  const minLen = 1 + 12 + cfg.tagBits / 8;
  let raw, bytes, codec, iv, ct, useAlt = false;
  if (cfg.v3) {
    raw = unpackBits(bodyStr, V3_IDX[cfg.alphabet], V3_BPC[cfg.alphabet]);
    const flags = raw[0];
    codec = flags & 3;
    const pad = (flags >>> 2) & 15;
    useAlt = !!(flags & 0x40);
    if (pad > 10) throw new Error('xseal: パディング情報が不正です');
    bytes = raw.subarray(0, raw.length - pad);
    if (cfg.plain) {
      const payload = bytes.subarray(1);
      if (codec === 0) return dec.decode(payload);
      if (codec === 1) return dec.decode(await inflateRaw(payload));
      if (codec === 2) return hufDecompress(payload);
      return acDecode(await loadModel(useAlt && cfg.lenModel ? cfg.lenModel : (cfg.acModel || _defaultAc)), payload);
    }
    if (bytes.length < minLen) throw new Error('xseal: データが短すぎます');
    iv = bytes.subarray(1, 13);
    ct = bytes.subarray(13);
  } else {
    raw = decodeBytes(cfg.alphabet, bodyStr);
  }
  if (cfg.v2) {
    const flags = raw[0];
    codec = flags & 3;
    const pad = (flags >>> 2) & 7;
    if (pad > 4) throw new Error('xseal: パディング情報が不正です');
    bytes = raw.subarray(0, raw.length - pad);
    if (bytes.length < minLen) throw new Error('xseal: データが短すぎます');
    iv = bytes.subarray(1, 13);
    ct = bytes.subarray(13);
  } else if (!cfg.v3) {
    const flags = raw[0];
    codec = flags & 1;
    const pad = (flags >> 1) & 3;
    const end = raw.length - pad;
    if (end < minLen) throw new Error('xseal: データが短すぎます');
    iv = raw.subarray(1, 13);
    ct = raw.subarray(13, end);
  }
  if (codec > 3) throw new Error('xseal: 未知の圧縮方式です');
  const list = Array.isArray(keys) ? keys : [keys];
  let lastErr;
  for (const key of list) {
    let body;
    try {
      body = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, tagLength: cfg.tagBits, additionalData: enc.encode(cfg.aad) },
        key,
        ct,
      ));
    } catch (e) { lastErr = e; continue; }
    if (codec === 0) return dec.decode(body);
    if (codec === 1) return dec.decode(await inflateRaw(body));
    if (codec === 2) return hufDecompress(body);
    return acDecode(await loadModel(useAlt && cfg.lenModel ? cfg.lenModel : (cfg.acModel || _defaultAc)), body);
  }
  throw new Error('xseal: 復号できません(鍵が違うか、本文が改ざんされています)');
}

/* ------------------------------------------------------------------ *
 * 280 に収まらないときは自動でスレッド分割
 * ------------------------------------------------------------------ */
export async function splitThread(cfg, key, text, budget = 280) {
  const chars = [...text];
  const parts = [];
  let i = 0;
  while (i < chars.length) {
    let lo = 1, hi = chars.length - i, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const env = await seal(cfg, key, chars.slice(i, i + mid).join(''));
      if (weightedLength(env) <= budget) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (!best) throw new Error('xseal: 1文字も入りません(予算が小さすぎます)');
    parts.push(await seal(cfg, key, chars.slice(i, i + best).join('')));
    i += best;
  }
  return parts;
}

/** 復号せずに「何文字入るか」を見積もる(コンポーザの残量表示用・下限値) */
export function estimateCapacity(cfg, budget = 280) {
  const overheadBytes = 1 + 12 + cfg.tagBits / 8;
  const bitsPerChar =
    cfg.alphabet === 'a2048' ? 11 : cfg.alphabet === 'a1024' ? 10 : cfg.alphabet === 'b85' ? 8 : 6;
  const usableBits = (budget - weightedLength(cfg.mark)) * bitsPerChar;
  const usableBytes = Math.floor(usableBits / 8) - overheadBytes;
  // 圧縮なし・日本語3バイト/字 の下限
  return Math.max(0, Math.floor(usableBytes / 3));
}
