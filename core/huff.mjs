// 静的0次Huffman符号化 (日本語用)。依存ゼロ。
// ストリーム形式: [varint コードポイント数][Huffmanビット列][0詰めでバイト境界]
import { MODEL } from './ja_model.mjs';

const MAXLEN = 24;

function buildTables(lens) {
  const maxLen = Math.max(...lens);
  if (maxLen > MAXLEN) throw new Error('code length too deep: ' + maxLen);
  // canonical: 長さ昇順 → 同長は記号番号順に連番を振る
  const order = lens.map((l, i) => [l, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const code = new Int32Array(lens.length);
  let cur = 0;
  let prev = order[0][0];
  for (const [l, sym] of order) {
    cur <<= l - prev;
    code[sym] = cur;
    cur += 1;
    prev = l;
  }
  // 復号表: tables[l][prefix] = symbol  (-1 = 該当なし)
  const tables = [];
  for (let l = 0; l <= maxLen; l++) tables.push(new Int32Array(1 << l).fill(-1));
  for (let sym = 0; sym < lens.length; sym++) {
    const l = lens[sym];
    if (l > 0 && l <= maxLen) tables[l][code[sym]] = sym;
  }
  return { code, lens, tables, maxLen };
}

const CHAR = buildTables(MODEL.charLens);
const BYTE = buildTables(MODEL.byteLens);
const ESC = MODEL.escIndex;
const CHARS = Array.from(MODEL.chars);
const IDX = new Map(CHARS.map((c, i) => [c, i]));

class BitWriter {
  constructor() {
    this.out = [];
    this.cur = 0;
    this.n = 0;
  }
  put(code, len) {
    for (let i = len - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((code >>> i) & 1);
      if (++this.n === 8) {
        this.out.push(this.cur);
        this.cur = 0;
        this.n = 0;
      }
    }
  }
  finish() {
    if (this.n > 0) this.out.push(this.cur << (8 - this.n));
    return Uint8Array.from(this.out);
  }
}

class BitReader {
  constructor(bytes) {
    this.b = bytes;
    this.p = 0;
    this.cur = 0;
    this.n = 0;
  }
  bit() {
    if (this.n === 0) {
      if (this.p >= this.b.length) throw new Error('huff: unexpected end of stream');
      this.cur = this.b[this.p++];
      this.n = 8;
    }
    const v = (this.cur >> 7) & 1;
    this.cur = (this.cur << 1) & 0xff;
    this.n--;
    return v;
  }
  symbol(T) {
    let bits = 0;
    for (let l = 1; l <= T.maxLen; l++) {
      bits = (bits << 1) | this.bit();
      const s = T.tables[l][bits];
      if (s >= 0) return s;
    }
    throw new Error('huff: invalid code');
  }
}

function putVarint(w, v) {
  while (v >= 128) {
    w.put((v & 0x7f) | 0x80, 8); // 継続ビットを立てる
    v >>>= 7;
  }
  w.put(v, 8);
}

/** 文字列 → 圧縮バイト列 */
export function hufCompress(text) {
  const cps = Array.from(text, (c) => c.codePointAt(0));
  const w = new BitWriter();
  putVarint(w, cps.length);
  for (const cp of cps) {
    const ch = String.fromCodePoint(cp);
    const i = IDX.get(ch);
    if (i !== undefined) {
      w.put(CHAR.code[i], CHAR.lens[i]);
    } else {
      w.put(CHAR.code[ESC], CHAR.lens[ESC]);
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, cp, true); // UTF-32LE
      for (const x of b) w.put(BYTE.code[x], BYTE.lens[x]);
    }
  }
  return w.finish();
}

/** 圧縮バイト列 → 文字列 */
export function hufDecompress(bytes) {
  const r = new BitReader(bytes);
  let n = 0;
  let shift = 0;
  for (;;) {
    // varint (記号ではなくビット直読み)
    let byte = 0;
    for (let i = 0; i < 8; i++) byte = (byte << 1) | r.bit();
    n |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  let out = '';
  for (let k = 0; k < n; k++) {
    const s = r.symbol(CHAR);
    if (s === ESC) {
      let cp = 0;
      for (let i = 0; i < 4; i++) cp |= r.symbol(BYTE) << (i * 8);
      out += String.fromCodePoint(cp >>> 0);
    } else {
      out += CHARS[s];
    }
  }
  return out;
}

export const MODEL_INFO = {
  n: MODEL.n,
  coverage: MODEL.coverage,
  maxCharLen: CHAR.maxLen,
  maxByteLen: BYTE.maxLen,
  avgCharBits: MODEL.charLens.reduce((a, l, i) => a + l, 0) / MODEL.charLens.length,
};

/** 圧縮後の理論ビット数（バイト境界丸め込み） */
export function hufBits(text) {
  let bits = 0;
  const cps = Array.from(text, (c) => c.codePointAt(0));
  for (const cp of cps) {
    const i = IDX.get(String.fromCodePoint(cp));
    if (i !== undefined) {
      bits += CHAR.lens[i];
    } else {
      let esc = CHAR.lens[ESC];
      for (let k = 0; k < 4; k++) esc += BYTE.lens[(cp >>> (k * 8)) & 0xff];
      bits += esc;
    }
  }
  return bits + 8;
}
