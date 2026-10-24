// 次数1文脈つき算術符号（Witten-Neal-Cleary 方式, 30bit状態）
// モデルは ac_model_*.mjs から gzip+base64 で読み込む。
// 2段目（AC_RGZ がある場合）: 1段目で外れた文字を文脈なしの希少文字表で送り直す。

const HALF = 0x20000000, Q1 = 0x10000000, Q3 = 0x30000000;

export class BitOut {
  constructor(){ this.buf = []; this.cur = 0; this.n = 0; }
  bit(b){ this.cur = (this.cur << 1) | b; if (++this.n === 8) { this.buf.push(this.cur); this.cur = 0; this.n = 0; } }
  finish(){ if (this.n > 0) { this.buf.push(this.cur << (8 - this.n)); this.cur = 0; this.n = 0; } return Uint8Array.from(this.buf); }
}
export class BitIn {
  constructor(bytes){ this.b = bytes; this.pos = 0; this.cnt = 8; }
  bit(){ if (this.pos >= this.b.length) return 0; const b = (this.b[this.pos] >> (7 - (8 - this.cnt))) & 1; if (--this.cnt === 0) { this.cnt = 8; this.pos++; } return b; }
}

function b64ToBytes(b64){
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gunzipU16(b64){ return gunzipAs(b64, Uint16Array); }
async function gunzipAs(b64, Ctor){
  const gz = b64ToBytes(b64);
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter(); w.write(gz); w.close();
  const buf = new Uint8Array(await new Response(ds.readable).arrayBuffer());
  return new Ctor(buf.buffer, buf.byteOffset, buf.byteLength / Ctor.BYTES_PER_ELEMENT);
}

let _modelCache = null;
export async function loadModel(m){
  // モデルは複数本を同時に使う（一般用/パーソナル用）。キャッシュはモジュール同一性で引く。
  if (!_modelCache) _modelCache = new WeakMap();
  const hit = _modelCache.get(m);
  if (hit) return hit;
  const freq = await gunzipU16(m.AC_GZ);
  const syms = [...m.AC_SYMS];
  const sIdx = new Map(); syms.forEach((c, i) => sIdx.set(c, i));
  const rank = new Map(); syms.forEach((c, i) => { if (i < m.AC_C) rank.set(c, i); });
  let rfreq = null, rsyms = [], rIdx = null, rN = 0;
  if (m.AC_RGZ) {
    rfreq = await gunzipU16(m.AC_RGZ);
    rsyms = [...m.AC_RSYMS];
    rIdx = new Map(); rsyms.forEach((c, i) => rIdx.set(c, i));
    rN = rsyms.length + 1;                      // 末尾が ESC2
  }
  const M = { C: m.AC_C, V: m.AC_V, TOT: m.AC_TOT, N: m.AC_V + 1, freq, syms, sIdx, rank,
              rfreq, rsyms, rIdx, rN, cumCache: new Map(), rcum: null };
  if (m.AC_S2K) {
    M.s2k = await gunzipAs(m.AC_S2K, Int32Array);
    M.s2o = await gunzipAs(m.AC_S2O, Int32Array);
    M.s2s = await gunzipAs(m.AC_S2S, Uint16Array);
    M.s2f = await gunzipAs(m.AC_S2F, Uint16Array);
    M.s2map = new Map();
    for (let i = 0; i < M.s2k.length; i++) M.s2map.set(M.s2k[i], i);
    M.s2cum = new Map();
    M.s2flat = m.AC_S2MULT | 0;      // 文脈キーの基数（既定 C+2）
  }
  _modelCache.set(m, M);
  return M;
}

function buildCum(freq, base, n, tot, what){
  const c = new Uint32Array(n + 1);
  let s = 0;
  for (let i = 0; i < n; i++) { c[i] = s; s += freq[base + i]; }
  c[n] = s;
  if (s !== tot) throw new Error(`${what} sums to ${s}, expected ${tot}`);
  return c;
}
function getCum(M, ctx){
  let c = M.cumCache.get(ctx);
  if (c) return c;
  c = buildCum(M.freq, ctx * M.N, M.N, M.TOT, `model row ${ctx}`);
  M.cumCache.set(ctx, c);
  return c;
}
function getCumS2(M, row){
  const hit = M.s2cum.get(row);
  if (hit) return hit;
  const o0 = M.s2o[row], o1 = M.s2o[row + 1];
  const f = new Uint16Array(M.N + 1);
  for (let k = o0; k < o1; k++) f[M.s2s[k]] = M.s2f[k];
  const cum = new Uint32Array(M.N + 2);
  let s = 0;
  for (let i = 0; i <= M.V; i++) { cum[i] = s; s += f[i]; }
  cum[M.N] = s;
  if (s !== M.TOT) throw new Error(`sparse row ${row} sums to ${s}, expected ${M.TOT}`);
  M.s2cum.set(row, cum);
  return cum;
}
function getCumR(M){
  if (M.rcum) return M.rcum;
  if (!M.rN) throw new Error('rare table not loaded');
  M.rcum = buildCum(M.rfreq, 0, M.rN, M.TOT, 'rare row');
  return M.rcum;
}

// ---- エンコーダ ----
export function acEncode(M, text){
  const out = new BitOut();
  let low = 0, high = (1 << 30) - 1, pending = 0;
  const emit = (b) => { out.bit(b); while (pending > 0) { out.bit(1 - b); pending--; } };
  const enc = (cl, ch) => {
    const range = high - low + 1;
    high = low + Math.floor(range * ch / M.TOT) - 1;
    low = low + Math.floor(range * cl / M.TOT);
    for (;;) {
      if (high < HALF) { emit(0); }
      else if (low >= HALF) { emit(1); low -= HALF; high -= HALF; }
      else if (low >= Q1 && high < Q3) { pending++; low -= Q1; high -= Q1; }
      else break;
      low *= 2; high = high * 2 + 1;
    }
  };
  const chars = [...text];
  let prev = M.C, prev2 = M.C;
  const base = M.C + 2;
  const raw32 = (cp) => { for (let i = 31; i >= 0; i--) { const b = (cp >>> i) & 1; enc(b ? M.TOT >> 1 : 0, b ? M.TOT : M.TOT >> 1); } };
  for (const ch of chars) {
    const s = M.sIdx.get(ch);
    const r = (s === undefined) ? M.C : (M.rank.get(ch) ?? M.C);
    let done = false;
    if (M.s2map) {
      const row = M.s2map.get(prev2 * base + prev);
      if (row !== undefined) {
        const c2 = getCumS2(M, row);
        let inRow = false;
        if (s !== undefined) {
          const o0 = M.s2o[row], o1 = M.s2o[row + 1];
          for (let k = o0; k < o1; k++) { if (M.s2s[k] === s) { inRow = true; break; } }
        }
        if (inRow) { enc(c2[s], c2[s + 1]); done = true; }
        else enc(c2[M.V], c2[M.V + 1]);
      }
    }
    if (!done) {
      const cum = getCum(M, prev);
      if (s === undefined) {
        enc(cum[M.V], cum[M.N]);
        const s2 = M.rIdx ? M.rIdx.get(ch) : undefined;
        if (M.rN) {
          const rc = getCumR(M);
          if (s2 === undefined) { enc(rc[M.rN - 1], rc[M.rN]); raw32(ch.codePointAt(0)); }
          else enc(rc[s2], rc[s2 + 1]);
        } else raw32(ch.codePointAt(0));
      } else enc(cum[s], cum[s + 1]);
    }
    prev2 = prev; prev = r;
  }
  pending++;
  emit(low < Q1 ? 0 : 1);
  return concat(varint(chars.length), out.finish());
}
function varint(n){
  const o = [];
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n > 0) b |= 0x80; o.push(b); } while (n > 0);
  return Uint8Array.from(o);
}
function concat(a, b){ const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }

// ---- デコーダ ----
export function acDecode(M, bytes){
  let p = 0;
  let n = 0, shift = 0;
  for (;;) { const b = bytes[p++]; n += (b & 0x7f) * Math.pow(2, shift); shift += 7; if (!(b & 0x80)) break; }
  const inp = new BitIn(bytes.subarray(p));
  let low = 0, high = (1 << 30) - 1, value = 0;
  for (let i = 0; i < 30; i++) value = value * 2 + inp.bit();
  const norm = () => {
    for (;;) {
      if (high < HALF) { /* nothing */ }
      else if (low >= HALF) { low -= HALF; high -= HALF; value -= HALF; }
      else if (low >= Q1 && high < Q3) { low -= Q1; high -= Q1; value -= Q1; }
      else break;
      low *= 2; high = high * 2 + 1; value = value * 2 + inp.bit();
    }
  };
  const dec = (cum, nSym) => {
    const range = high - low + 1;
    const target = Math.floor(((value - low + 1) * M.TOT - 1) / range);
    let lo = 0, hi = nSym - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cum[mid] <= target) lo = mid; else hi = mid - 1; }
    const s = lo;
    high = low + Math.floor(range * cum[s + 1] / M.TOT) - 1;
    low = low + Math.floor(range * cum[s] / M.TOT);
    norm();
    return s;
  };
  const decUniformBit = () => {
    const range = high - low + 1;
    const target = Math.floor(((value - low + 1) * M.TOT - 1) / range);
    const b = target >= (M.TOT >> 1) ? 1 : 0;
    const cl = b ? M.TOT >> 1 : 0, ch = b ? M.TOT : M.TOT >> 1;
    high = low + Math.floor(range * ch / M.TOT) - 1;
    low = low + Math.floor(range * cl / M.TOT);
    norm();
    return b;
  };
  let out = '', prev = M.C, prev2 = M.C;
  const base = M.C + 2;
  for (let k = 0; k < n; k++) {
    let ch = null;
    if (M.s2map) {
      const row = M.s2map.get(prev2 * base + prev);
      if (row !== undefined) {
        const s1 = dec(getCumS2(M, row), M.N);
        if (s1 !== M.V) ch = M.syms[s1];
      }
    }
    let r;
    if (ch !== null) { r = M.rank.get(ch) ?? M.C; }
    else {
      const s = dec(getCum(M, prev), M.N);
      if (s === M.V) {
        ch = null;
        if (M.rN) { const s2 = dec(getCumR(M), M.rN); if (s2 !== M.rN - 1) ch = M.rsyms[s2]; }
        if (ch === null) {
          let cp = 0;
          for (let i = 0; i < 32; i++) cp = cp * 2 + decUniformBit();
          ch = String.fromCodePoint(cp);
        }
        r = M.C;
      } else { ch = M.syms[s]; r = M.rank.get(ch) ?? M.C; }
    }
    out += ch; prev2 = prev; prev = r;
  }
  return out;
}
