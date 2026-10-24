/**
 * 拡張 + サイトのビルド。
 *  1) ~/x_cipher_research/*.mjs のコアを 1 本の classic script に連結 (dist/core.js)
 *  2) chrome/ と firefox/ に manifest + 一式を吐く
 *  3) site/index.html にコアを注入
 *
 * モデルファイルは複数が同じ export 名を持つので IIFE で名前空間化する（build_poc.mjs と同じ）。
 * コアは classic script なので、トップレベル await を入れてはいけない。
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const coreDir = join(here, 'core');   // コアの .mjs はこのリポジトリ内に置く
const R = (rel, base = root) => readFileSync(join(base, rel), 'utf8');

const MODEL_NS = {
  'ac_model_1024.mjs': 'ACDEFAULT',
  'ac_model_s2.mjs': 'ACSELF',
};
const FILES = [
  'alpha1024.mjs', 'alpha2048.mjs', 'ja_model.mjs', 'huff.mjs',
  'ac_model_1024.mjs', 'ac_model_s2.mjs', 'ac.mjs', 'xseal.mjs',
];

const strip = (body) => body
  .replace(/^import .*$/gm, '')
  .replace(/^export default .*$/gm, '')
  .replace(/^export /gm, '')
  .replace(/^\/\*\*[\s\S]*?\*\/\n/, '');

function load(name) {
  const src = R(name, coreDir);
  const ns = MODEL_NS[name];
  if (!ns) return `// ==== ${name} ====\n${strip(src)}`;
  const names = [...src.matchAll(/^export const (\w+)/gm)].map((m) => m[1]);
  if (!names.length) throw new Error(`${name}: export const が見つからない`);
  return `// ==== ${name} ====\nconst ${ns} = (() => {\n${strip(src)}\nreturn { ${names.join(', ')} };\n})();\n`;
}

const body = FILES.map(load).join('\n');

const core = `/* xseal core (generated) — do not edit. source: x_cipher_research/*.mjs */
(function () {
'use strict';
${body}
globalThis.XSEAL = {
  PROFILES, seal, open, isSealed, weightedLength, splitThread, deriveKey, estimateCapacity,
  A1024: ALPHA, A2048: ALPHA2048,
};
})();
`;

mkdirSync(join(here, 'dist'), { recursive: true });
writeFileSync(join(here, 'dist', 'core.js'), core);
const h = createHash('sha256').update(core).digest('hex').slice(0, 12);
console.log(`core.js: ${core.length} bytes, sha256:${h}`);

// ---- 拡張パッケージ ----
const content = R('src/content.js', here);
const css = R('src/content.css', here);
const options = R('src/options.html', here);
const icons = join(here, 'src', 'icons');

for (const [dir, manifestFile] of [['chrome', 'manifest.chrome.json'], ['firefox', 'manifest.firefox.json']]) {
  const out = join(here, dir);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'manifest.json'), R(join('src', manifestFile), here));
  writeFileSync(join(out, 'core.js'), core);
  writeFileSync(join(out, 'content.js'), content);
  writeFileSync(join(out, 'content.css'), css);
  writeFileSync(join(out, 'bg.js'), R('src/bg.js', here));
  // 拡張ページの CSP は script-src 'self'。inline script は実行されないので外部ファイルに置く
  writeFileSync(join(out, 'options.html'), options);
  writeFileSync(join(out, 'options.js'), R('src/options.js', here));
  try { cpSync(icons, join(out, 'icons'), { recursive: true }); } catch { /* アイコン無しでも動く */ }
  console.log(`${dir}/ を書き出し`);
}

// ---- サイト ----
const siteTpl = R('site/index.template.html', here);
const site = siteTpl.replace('/*__CORE__*/', () => core);
mkdirSync(join(here, 'site'), { recursive: true });
writeFileSync(join(here, 'site', 'index.html'), site);
const hs = createHash('sha256').update(site).digest('hex').slice(0, 12);
console.log(`site/index.html: ${site.length} bytes, sha256:${hs}`);

// GitHub Pages 用（docs/ を公開ディレクトリにする）
mkdirSync(join(here, 'docs'), { recursive: true });
writeFileSync(join(here, 'docs', 'index.html'), site);
console.log('docs/index.html を書き出し');
