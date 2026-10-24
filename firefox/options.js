const $ = (id) => document.getElementById(id);
const CFG = XSEAL.PROFILES.plain;

const api = globalThis.browser ?? globalThis.chrome;
api?.storage?.sync?.get({ auto: true, pill: true }, (v) => {
  $('auto').checked = !!v.auto;
  $('pill').checked = v.pill !== false;
});
$('auto').onchange = () => api?.storage?.sync?.set({ auto: $('auto').checked });
$('pill').onchange = () => api?.storage?.sync?.set({ pill: $('pill').checked });

$('diag').onclick = async () => {
  const out = $('diagout');
  $('diagstat').textContent = '…';
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/(x|twitter)\.com\//.test(tab.url || '')) throw new Error('x.com のタブを開いてから実行して');
    const [{ result }] = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (globalThis.__xseal_diag ? globalThis.__xseal_diag() : { ok: false, reason: 'content script が動いていない（そのタブを再読み込みして）' }),
    });
    out.value = JSON.stringify(result, null, 2);
    $('diagstat').innerHTML = result?.ok ? '<span class="ok">OK</span>' : '<span class="bad">NG</span>';
  } catch (e) {
    out.value = String(e.message || e);
    $('diagstat').innerHTML = '<span class="bad">失敗</span>';
  }
};

function setMeter(w) {
  $('meter').classList.toggle('over', w > 280);
  $('meter').querySelector('i').style.width = Math.min(100, (w / 280) * 100) + '%';
  $('cw').textContent = w + ' 重み';
}

$('enc').onclick = async () => {
  const t = $('plain').value;
  if (!t.trim()) return;
  const env = await XSEAL.seal(CFG, null, t);
  $('cipher').value = env;
  setMeter(XSEAL.weightedLength(env));
};
$('copy').onclick = async () => {
  if (!$('cipher').value) return;
  await navigator.clipboard.writeText($('cipher').value);
  $('copy').textContent = 'コピーした';
  setTimeout(() => ($('copy').textContent = 'コピー'), 1200);
};
$('toX').onclick = () => {
  if (!$('cipher').value) return;
  window.open('https://x.com/intent/post?text=' + encodeURIComponent($('cipher').value), '_blank');
};
$('dec').onclick = async () => {
  const msg = $('in').value.trim();
  try {
    const p = await XSEAL.open(CFG, [], msg);
    $('out').value = p;
    $('decstat').innerHTML = '<span class="ok">復号しました</span>';
  } catch (e) {
    $('out').value = '';
    $('decstat').innerHTML = '<span class="bad">' + e.message + '</span>';
  }
};
/* ---------- 封印ポスト検索 ---------- */

$('plain').dispatchEvent(new Event('input'));
$('enc').dispatchEvent(new Event('click'));
