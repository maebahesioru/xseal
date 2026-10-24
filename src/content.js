/* xseal — X の UI に「封印」と「復号」を差し込む（popup は使わない）
 *
 * 設計方針:
 *  - X の DOM は頻繁に変わるので data-testid 1 本に頼らない。
 *  - ツールバーが取れたらそこに入れる（見た目が native）。
 *  - 取れなくても、本文欄の右上に必ずフローティングの 🔒 を出す（= 絶対に見える）。
 *  - それすら嫌なら Alt+S で封印できる。
 */
(() => {
  'use strict';
  const X = globalThis.XSEAL;
  if (!X) { console.warn('[xseal] core.js が読まれていない'); return; }

  const CFG = X.PROFILES.plain;
  const A2048 = new Set([...X.A2048]);
  const A1024 = new Set([...X.A1024]);
  const B64U = /[A-Za-z0-9_-]/;
  const MARKS = { xo: ['plain'], x3: ['deep'], x4: ['ultra'], x5: ['self'], x2: ['max'], x1: ['std', 'tight'] };
  // 封筒の最短長。xo/x2..x5 の本文は base1024/2048（ASCIIゼロ）なので短くても誤検出しない。
  // x1（base64url）だけは英数字と衝突するので長めに要求する。
  const MIN_ENV = { xo: 8, x2: 8, x3: 8, x4: 8, x5: 8, x1: 24 };

  const EDITOR_SELS = [
    '[data-testid="tweetTextarea_0"]',
    '[data-testid="dmComposerTextInput"]',
    '[data-testid^="tweetTextarea_"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"].public-DraftEditor-content',
  ];
  const SUBMIT_SELS = [
    '[data-testid="tweetButtonInline"]',
    '[data-testid="tweetButton"]',
    '[data-testid="dmComposerSendButton"]',
  ];
  const TOOLBAR_SEL = '[data-testid="toolBar"]';

  /* ---------- 設定 ---------- */
  const store = globalThis.chrome?.storage?.sync || globalThis.browser?.storage?.sync || null;
  const settings = { auto: true, pill: true, sel: true };
  if (store) {
    store.get({ auto: true, pill: true, sel: true }, (v) => {
      settings.auto = !!v.auto;
      settings.pill = v.pill !== false;
      settings.sel = v.sel !== false;
    });
    store.onChanged?.addListener((c) => {
      if (c.auto) settings.auto = !!c.auto.newValue;
      if (c.pill) { settings.pill = c.pill.newValue !== false; paint(); }
      if (c.sel) settings.sel = c.sel.newValue !== false;
    });
  }

  /* ---------- 検出 ---------- */
  const isMark = (a, b) => a === 'x' && (b === 'o' || (b >= '1' && b <= '5'));

  function alphabetTest(mark) {
    if (mark === 'x2' || mark === 'x3') return (c) => A1024.has(c);
    if (mark === 'xo' || mark === 'x4' || mark === 'x5') return (c) => A2048.has(c);
    if (mark === 'x1') return (c) => B64U.test(c);
    return null;
  }

  function extractEnv(text) {
    const ch = [...text];
    for (let i = 0; i + 1 < ch.length; i++) {
      if (!isMark(ch[i], ch[i + 1])) continue;
      const mark = ch[i] + ch[i + 1];
      const ok = alphabetTest(mark);
      if (!ok) continue;
      let j = i + 2;
      while (j < ch.length && ok(ch[j])) j++;
      const env = ch.slice(i, j).join('');
      if ([...env].length >= (MIN_ENV[mark] || 20)) return { mark, text: env };
    }
    return null;
  }

  function findBase64(text) {
    const re = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{8,}={0,2}(?![A-Za-z0-9+/=])/g;
    let m, best = null;
    while ((m = re.exec(text))) {
      const s = m[0];
      try {
        const bin = atob(s.replace(/=+$/, ''));
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        const dec = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const chars = [...dec];
        if (chars.length < 2) continue;
        const jp = chars.filter((c) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(c)).length;
        if (jp / chars.length >= 0.25) best = { text: s, plain: dec };
      } catch { /* 不正な base64 */ }
    }
    return best;
  }

  async function decodeEnv(env) {
    for (const name of MARKS[env.mark] || []) {
      const cfg = X.PROFILES[name];
      if (!cfg || !X.isSealed(cfg, env.text)) continue;
      if (!cfg.plain) throw new Error('鍵つきの封筒（' + name + '）です。この拡張は xo 形式のみ対応');
      return await X.open(cfg, [], env.text);
    }
    throw new Error('形式が一致しません');
  }

  /* ---------- トースト ---------- */
  let toastEl = null, toastTimer = 0;
  function toast(msg, bad) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'xseal-toast'; document.body.append(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.toggle('bad', !!bad);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
  }

  /* ---------- エディタ探索 ---------- */
  function findEditors() {
    const raw = [];
    for (const sel of EDITOR_SELS) {
      for (const el of document.querySelectorAll(sel)) {
        if (!raw.includes(el) && el.isConnected) raw.push(el);
      }
    }
    // X は同じ本文欄が wrapper と内側の contenteditable で二重に当たる。
    // 両方をエディタ扱いするとボタンが2つ重なるので、内側だけ残す。
    return raw.filter((el) => !raw.some((o) => o !== el && el.contains(o)));
  }

  /** 祖先をたどって「1つの本文欄だけを含む」範囲＝コンポーザのスコープを探す */
  function composerScope(el, maxUp = 16) {
    const all = EDITOR_SELS.join(',');
    let p = el.parentElement;
    for (let i = 0; i < maxUp && p; i++, p = p.parentElement) {
      if (p.querySelectorAll(all).length === 1) return p;
    }
    return null;
  }

  function findToolbar(el) {
    const scope = composerScope(el);
    if (!scope) return null;
    const tb = scope.querySelector(TOOLBAR_SEL);
    return tb && !tb.contains(el) ? tb : null;
  }

  function findSubmit(el) {
    const scope = composerScope(el);
    if (!scope) return null;
    for (const sel of SUBMIT_SELS) {
      const b = scope.querySelector(sel);
      if (b && !b.contains(el)) return b;
    }
    return null;
  }

  const isField = (el) => el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');

  function readText(el) {
    const raw = isField(el) ? (el.value || '') : (el.innerText || el.textContent || '');
    return raw.replace(/\u200b/g, '').trim();
  }

  function selectAllIn(target) {
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(target);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /** 欄を空にして X 側の state も空にする（次の手が「追記」にならないようにする） */
  function clearEditor(target) {
    target.textContent = '';
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
  }

  /** 期待値になるまで最大 ~100ms 待つ（DraftJS の反映は同期でない） */
  function settlesTo(read, el, want) {
    return new Promise((res) => {
      let n = 0;
      const tick = () => {
        if (read(el) === want) return res(true);
        if (++n >= 6) return res(false);
        setTimeout(tick, 16);
      };
      tick();
    });
  }

  /**
   * 本文欄の文字列を丸ごと差し替える。
   * 重要: 各手の前に必ず空にする。空にしないと insertText / paste の「追記」で
   * 封筒が二重になる（実機で xo…xo… が出た）。
   */
  async function writeText(el, text) {
    const target = el.isContentEditable ? el : (el.querySelector('[contenteditable="true"]') || el);
    if (isField(target)) {
      target.focus({ preventScroll: true });
      target.value = text;
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return (target.value || '') === text;
    }
    try { target.focus({ preventScroll: true }); } catch { /* 握る */ }
    const focused = document.activeElement === target;

    // フォーカスが取れている時だけ、X（DraftJS）の state も更新される手を試す。
    // ウィンドウが非アクティブだと execCommand は true を返すのに何も入らないので、
    // その場合は最初から直接代入に落とす。
    if (focused) {
      clearEditor(target);
      selectAllIn(target);
      try { document.execCommand('insertText', false, text); } catch { /* 次へ */ }
      if (await settlesTo(readText, target, text)) return true;

      clearEditor(target);
      selectAllIn(target);
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        if (await settlesTo(readText, target, text)) return true;
      } catch { /* 次へ */ }
    }

    // 最終手段。X 側の state は壊れるが、見た目とコピーは通る
    target.textContent = text;
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return await settlesTo(readText, target, text);
  }

  /* ---------- 封印ボタン ---------- */
  const sealing = new WeakSet();

  /* Range を「本文全体のオフセット」に変換する */
  function rangeInfo(ed, r) {
    const pre = r.cloneRange();
    pre.selectNodeContents(ed);
    pre.setEnd(r.startContainer, r.startOffset);
    const full = readText(ed);
    const start = pre.toString().length;
    const picked = r.toString();
    if (!picked.trim()) return null;
    return { picked, start, end: start + picked.length, full };
  }

  /* ツールバーのボタンを押すとフォーカスが外れて選択が消えるので、
     選択が変わるたびに覚えておく（クリック後に使う） */
  let selMemo = null;
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (r.collapsed) return;
    const node = r.commonAncestorContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    const ed = el?.closest?.(EDITOR_SELS.join(','));
    if (!ed) return;
    const info = rangeInfo(ed, r);
    if (info) selMemo = { ed, picked: info.picked, start: info.start, end: info.end };
  }, true);

  /* 本文欄の中の選択範囲を返す（無ければ null）。選択が無い＝全体を封印。 */
  function selectionIn(ed) {
    const sel = window.getSelection?.();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (!r.collapsed && ed.contains(r.commonAncestorContainer)) {
        const info = rangeInfo(ed, r);
        if (info) return info;
      }
    }
    if (selMemo && selMemo.ed === ed) {
      const full = readText(ed);
      if (full.slice(selMemo.start, selMemo.end) === selMemo.picked) {
        return { picked: selMemo.picked, start: selMemo.start, end: selMemo.end, full };
      }
    }
    return null;
  }

  async function sealInto(ed, btn) {
    if (sealing.has(ed)) return;                      // 連打・二重発火の防止
    const full0 = readText(ed);
    if (!full0) { toast('本文が空だよ', true); return; }
    const range = settings.sel ? selectionIn(ed) : null;
    if (!range && findEnvSpan(full0)) { toast('範囲を選んでね（すでに封筒が入ってる）', true); return; }
    const subject = range ? range.picked : full0;
    if (subject.length < 2) { toast('短すぎて封印できないよ（2文字以上）', true); return; }
    if (extractEnv(subject)) { toast('すでに封印済み', true); return; }
    sealing.add(ed);
    if (btn) btn.disabled = true;
    try {
      const env = await X.seal(CFG, null, subject);
      const w = X.weightedLength(env);
      // 選択があるときは「選択部分だけ」を置き換える
      const out = range ? range.full.slice(0, range.start) + env + range.full.slice(range.end) : env;
      const ok = await writeText(ed, out);
      selMemo = null;
      // 書き込みが二重になった場合だけ畳む（部分封印で封筒が複数あるのは正常）
      const after = readText(ed);
      const dup = after.split(env).length - 1;
      if (dup > 1) {
        ed.textContent = out;
        ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: out }));
      }
      if (!ok || dup > 1) toast(`貼り付けに難あり — 手で全選択してから貼ってね（${[...env].length}文字）`, true);
      else toast(`${range ? '選択範囲を' : ''}封印したよ — ${[...env].length}文字 / 重み ${w}${w > 280 ? '（1ツイート超え）' : ''}`, w > 280);
    } catch (err) {
      toast('封印に失敗: ' + err.message, true);
    } finally {
      sealing.delete(ed);
      if (btn) btn.disabled = false;
    }
  }

  /** 本文欄の中の封筒を平文へ戻す（封印ボタンのトグル先） */
  /* 本文中の封筒1個の位置を返す。封筒の文字は mark(ASCII) + 非ASCII の連続なので、
     「x[o2345] の直後から、ASCII が来るまで」を切り出す。x1 は base64url なので対象外。 */
  function envSpans(text) {
    const out = [];
    for (let i = 0; i + 2 < text.length; i++) {
      if (text[i] !== 'x') continue;
      const m = text[i + 1];
      if (!'o2345'.includes(m)) continue;
      if (i > 0 && /[0-9A-Za-z]/.test(text[i - 1])) continue;   // 語中の xo を除外
      const ok = alphabetTest('x' + m);
      if (!ok) continue;
      let j = i + 2;
      while (j < text.length && ok(text[j])) j++;
      if (j - i - 2 >= 6) { out.push({ start: i, end: j, mark: 'x' + m, text: text.slice(i, j) }); i = j - 1; }
    }
    return out;
  }

  function findEnvSpan(text) {
    return envSpans(text)[0] || null;
  }

  async function unsealInto(ed, btn, wanted) {
    if (sealing.has(ed)) return;
    const full = readText(ed);
    const found = extractEnv(full);
    const span = (wanted && wanted.text && full.includes(wanted.text))
      ? wanted
      : (findEnvSpan(full) || (found ? { start: 0, end: full.length, mark: found.mark, text: found.text } : null));
    if (!span) { toast('封印された本文じゃないよ', true); return; }
    sealing.add(ed);
    if (btn) btn.disabled = true;
    try {
      const plain = await decodeEnv({ mark: span.mark, text: span.text });
      const out = full.slice(0, span.start) + plain + full.slice(span.end);
      const ok = await writeText(ed, out);
      toast(ok ? '復号したよ' : '復号した（反映されていないかも）', !ok);
    } catch (err) {
      toast('復号できない: ' + err.message, true);
    } finally {
      sealing.delete(ed);
      if (btn) btn.disabled = false;
    }
  }

  function makeButton(cls, label, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.textContent = label;
    b.addEventListener('mousedown', (e) => e.preventDefault());   // フォーカスを奪わない
    return b;
  }

  /** editor -> { inToolbar, pill } */
  const slots = new WeakMap();
  /** 画面に固定されたピルの集合。スクロール中はこれだけを見て位置を合わせ直す */
  const livePills = new Set();

  /* セレクタに当たらない本文欄でも拾えるように、フォーカスされた contenteditable を覚えておく */
  let lastEd = null;
  let focusTimer = 0;
  document.addEventListener('focusin', (e) => {
    // contenteditable だけでなく textarea / input も対象（DM は textarea のことがある）
    const el = e.target;
    const t = el?.closest?.('[contenteditable="true"]')
      || (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text')) ? el : null);
    if (!t) return;
    lastEd = t;
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => { try { paint(); } catch { /* noop */ } }, 60);
  }, true);

  function ensureInToolbar(ed, st) {
    const tb = findToolbar(ed);
    if (!tb) {
      if (st.inToolbar) { st.inToolbar.remove(); st.inToolbar = null; }
      return false;
    }
    if (st.inToolbar && st.inToolbar.isConnected) { syncPill(st.inToolbar, ed); return true; }
    const b = makeButton('xseal-btn', '🔒', 'xo で封印（Alt+S）');
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleSeal(ed, b); });
    b.__xsealEd = ed;
    tb.prepend(b);
    st.inToolbar = b;
    return true;
  }

  function ensurePill(ed, st) {
    if (!st.pill) {
      const b = makeButton('xseal-pill', '🔒', 'xo で封印（Alt+S）');
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleSeal(ed, b); });
      b.__xsealEd = ed;
      document.body.append(b);
      st.pill = b;
      livePills.add(b);
    }
    return st.pill;
  }

  /* ---------- DM 用の常設ボタン ----------
     DM の入力欄は DOM の形が変わりやすく、欄に貼り付けるピルが出ないことがある。
     そういう時でも押せるように、メッセージ画面では画面右下に常設ボタンを出す。 */
  // ルートが変わらない DM ドロワーもあるので、DOM に DM 特有の目印があるかも見る
  const isDMPage = () => /^\/(messages|i\/chat)/.test(location.pathname)
    || document.documentElement.dataset.xsealDmForce === '1'    // テスト用フック
    || !!document.querySelector('[data-testid="dmComposerTextInput"], [data-testid="messageEntry"]');
  let dmFab = null;

  function ensureDmFab() {
    if (!settings.pill || !isDMPage()) { if (dmFab) { dmFab.remove(); dmFab = null; } return; }
    if (dmFab && dmFab.isConnected) return;
    const b = makeButton('xseal-pill xseal-fab', '🔒', 'DM の入力欄に xo を入れる（Alt+S）');
    b.__xsealKeep = true;
    b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const live = document.activeElement;
      const ed = (live && (live.isContentEditable || isField(live))) ? live : lastEd;
      if (!ed || !ed.isConnected) { toast('先にメッセージ入力欄をクリックしてね', true); return; }
      toggleSeal(ed, null);
    });
    document.body.append(b);
    dmFab = b;
  }

  /** 中身が封筒ならアイコンを 🔓 に切り替える（同じボタンが封印と復号を兼ねる） */
  function syncPill(btn, ed) {
    if (!btn) return;
    const full = readText(ed);
    const sel = selectionIn(ed);
    const onEnv = !!sel && envSpans(full).some((x) => sel.start < x.end && sel.end > x.start);
    const sealed = onEnv || (!sel && !!extractEnv(full));
    const label = sealed ? '🔓' : '🔒';
    const title = sealed
      ? (sel && !onEnv ? '復号する（Alt+S）' : (sel ? '選択した封筒を戻す（Alt+S）' : '復号する（Alt+S）'))
      : (sel ? '選択範囲を封印（Alt+S）' : 'xo で封印（Alt+S）');
    if (btn.textContent !== label) btn.textContent = label;
    if (btn.title !== title) { btn.title = title; btn.setAttribute('aria-label', title); }
    btn.classList.toggle('sealed', sealed);
  }

  /** 選択が封筒に重なる → その封筒を戻す / 素の文を選んだ → その部分を封印 / 選択なし → 全文トグル */
  function toggleSeal(ed, btn) {
    const full = readText(ed);
    const sel = settings.sel ? selectionIn(ed) : null;
    if (sel) {
      const hit = envSpans(full).find((s) => sel.start < s.end && sel.end > s.start);
      if (hit) return unsealInto(ed, btn, hit);
      return sealInto(ed, btn);
    }
    return extractEnv(full) ? unsealInto(ed, btn) : sealInto(ed, btn);
  }

  /**
   * ピルは「本文欄の内側」に置く。外側（上）に出すと X のツールバーや別コンポーザの
   * ボタンに重なって壊れて見えるため。28px の丸アイコンなので多少文字に被っても邪魔になりにくい。
   */
  const PILL = 28;
  function placePill(ed, pill) {
    const r = ed.getBoundingClientRect();
    const visible = r.width > 60 && r.height > 20 && r.bottom > 0 && r.top < window.innerHeight;
    if (!visible) { pill.style.display = 'none'; return; }
    pill.style.display = 'inline-flex';
    const top = Math.min(r.bottom - PILL - 2, Math.max(2, r.top + 2));
    const left = Math.min(window.innerWidth - PILL - 4, Math.max(4, r.right - PILL - 2));
    pill.style.top = top + 'px';
    pill.style.left = left + 'px';
  }

  /** ツールバーに入れたらピルは DOM ごと消す（二重表示・残留を防ぐ） */
  function dropPill(st) {
    if (st.pill) { livePills.delete(st.pill); st.pill.remove(); st.pill = null; }
  }

  /**
   * 最前面のモーダル（X の投稿ポップアップなど）を返す。
   * ピルは body 直下の fixed + 巨大 z-index なので、モーダルが開いているのに
   * その外側の本文欄のピルを出したままだと、モーダルより手前に浮いてしまう。
   * 「モーダルが開いているなら、その中に入っている本文欄のピルだけ出す」が正しい。
   */
  function topLayerEl() {
    let best = null;
    for (const n of document.querySelectorAll('[aria-modal="true"]')) {
      if (!n.isConnected) continue;
      const r = n.getBoundingClientRect();
      if (r.width > 200 && r.height > 150) best = n;   // ツリー順で最後＝最前面
    }
    if (best) return best;
    // aria-modal が無い X のモーダルもある。ただしホバーカード等の「モーダルでない dialog」を
    // 巻き込むと、アバターに乗せるたびピルが点滅するので、背景マスクの存在を条件にする。
    const mask = document.querySelector('[data-testid="mask"]');
    if (!mask || !mask.isConnected) return null;
    for (const n of document.querySelectorAll('#layers [role="dialog"]')) {
      if (!n.isConnected) continue;
      const r = n.getBoundingClientRect();
      if (r.width > 200 && r.height > 150) best = n;
    }
    return best;
  }
  /** paint() のたびに更新する（reposition() は毎フレーム走るので DOM 探索はしない） */
  let activeLayer = null;

  /**
   * スクロール中の追従。位置合わせだけを rAF で毎フレームやる。
   * fixed 要素は自分では動かないので、これをやらないと指に遅れて付いてくる。
   * DOM 走査（findEditors / gcOrphans）はここでは絶対にしない（重いので）。
   */
  let rafId = 0;
  function reposition() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      for (const b of livePills) {
        const ed = b.__xsealEd;
        if (!ed || !ed.isConnected) { livePills.delete(b); b.remove(); continue; }
        // モーダルが開いていて、このピルの持ち主がモーダルの外にあるなら出さない
        if (activeLayer && activeLayer.isConnected && !activeLayer.contains(ed) && !ed.closest('#layers') && ed !== document.activeElement) {
          b.style.display = 'none';
          continue;
        }
        placePill(ed, b);
      }
    });
  }

  /** 本文欄が見えているか（コンポーザを閉じた後も X は DOM を残すことがある） */
  function isVisible(el) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 60 && r.height > 20)) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true, opacityProperty: true });
    }
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  /** 持ち主の本文欄が消えた/隠れたボタンを DOM から回収する（ポップアップを閉じた後に残る幽霊の掃除） */
  function gcOrphans() {
    for (const b of document.querySelectorAll('.xseal-pill, .xseal-btn')) {
      if (b.__xsealKeep) continue;                 // DM 用の常設ボタンは消さない
      const ed = b.__xsealEd;
      if (!ed || !ed.isConnected || !isVisible(ed)) {
        const st = ed ? slots.get(ed) : null;
        if (st) { if (st.pill === b) st.pill = null; if (st.inToolbar === b) st.inToolbar = null; }
        livePills.delete(b);
        b.remove();
      }
    }
  }

  function paint() {
    activeLayer = topLayerEl();          // モーダルの開閉をここで拾う
    const eds = findEditors();
    const seen = new Set(eds);
    for (const ed of eds) paintOne(ed);
    // 既知のセレクタに当たらなくても、直近フォーカスされた本文欄には出す。
    // 当たるエディタが別に1つあっても（引用・返信の入れ子など）対応する。
    const fb = lastEd;
    if (fb && fb.isConnected && !seen.has(fb) && (fb.isContentEditable || isField(fb))) {
      paintOne(fb);
    }
    try { ensureDmFab(); } catch { /* noop */ }
    gcOrphans();
  }

  function paintOne(ed) {
    const st = slots.get(ed) || {};
    slots.set(ed, st);
    if (!isVisible(ed)) { dropPill(st); return; }   // 閉じたコンポーザの残骸には出さない
    // モーダル（投稿ポップアップ等）が開いている間は、その外側の欄には出さない。
    // 出したままだと fixed + 巨大 z-index でモーダルの手前に浮く。
    // DM ドロワー等 #layers 内の欄はモーダル扱いで消さない
    // モーダル表示中に隠すのは「背景のタイムライン側」の欄だけ。DM ドロワー等は残す。
    // さらに、いまフォーカスされている欄（＝打っている欄）は絶対に隠さない。
    const focusedNow = ed === document.activeElement;
    if (!focusedNow && activeLayer && !activeLayer.contains(ed) && !ed.closest('#layers')) { dropPill(st); return; }
    if (ensureInToolbar(ed, st)) { dropPill(st); return; }
    if (!settings.pill) { dropPill(st); return; }
    const pill = ensurePill(ed, st);
    syncPill(pill, ed);
    placePill(ed, pill);
  }

  /* ---------- タイムライン / DM / 検索結果 ---------- */
  const chipState = new WeakMap();
  /* タイムライン本体 + DM バブル（data-testid が版によって違うので複数見る） */
  const CHIP_SELS = '[data-testid="tweetText"], [data-testid="messageText"], [data-testid="dmMessageText"]';
  function chipTargets() {
    const out = new Set(document.querySelectorAll(CHIP_SELS));
    for (const m of document.querySelectorAll('[data-testid="messageEntry"]')) {
      const d = m.querySelector('div[dir="auto"]');
      if (d) out.add(d);
    }
    return out;
  }

  async function buildChip(el) {
    const text = el.innerText || '';
    const spans = envSpans(text);
    const b64 = spans.length ? null : findBase64(text);
    if (!spans.length && !b64) { chipState.set(el, { text, row: null }); return; }
    const env = spans.length ? spans[0] : null;

    const row = document.createElement('div');
    row.className = 'xseal-chiprow';
    const label = spans.length > 1 ? `🔓 復号×${spans.length}` : (env ? '🔓 復号' : '🔓 base64');
    const btn = makeButton('xseal-chip', label, '封印を解く');
    const out = document.createElement('div');
    out.className = 'xseal-plain';
    out.hidden = true;

    const open = async () => {
      let plain = null;
      let err = null;
      try {
        if (b64) plain = b64.plain;
        else {
          // 本文に封筒が複数あるときは、全部復号して元の文に差し戻す
          const parts = [];
          let cursor = 0;
          for (const sp of spans) {
            parts.push(text.slice(cursor, sp.start));
            try {
              parts.push(await decodeEnv({ mark: sp.mark, text: sp.text }));
            } catch (e) {
              if (!err) err = e;
              parts.push(sp.text);
            }
            cursor = sp.end;
          }
          parts.push(text.slice(cursor));
          plain = parts.join('');
        }
      } catch (e) {
        err = e;
      }
      if (err) { out.classList.add('err'); if (!plain) plain = err.message; }
      else out.classList.remove('err');
      out.textContent = plain;
      out.hidden = false;
      btn.textContent = '↩ 閉じる';
    };
    const close = () => { out.hidden = true; btn.textContent = label; };

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (out.hidden) await open(); else close();
    });

    row.append(btn, out);
    el.insertAdjacentElement('afterend', row);
    chipState.set(el, { text, row });

    if (settings.auto) { try { await open(); } catch { /* 握る */ } }
  }

  function ensureChips() {
    for (const el of chipTargets()) {
      const st = chipState.get(el);
      const text = el.innerText || '';
      if (st && st.text === text && (!st.row || st.row.isConnected)) continue;
      if (st?.row?.isConnected) st.row.remove();
      buildChip(el);
    }
  }

  /* ---------- 監視 ---------- */
  let timer = 0;
  function scan() {
    try { paint(); ensureChips(); } catch (e) { console.warn('[xseal] scan', e); }
  }

  const obs = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(scan, 120);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  // スクロールは「位置合わせ」を最優先で毎フレーム。再スキャンは止まってから。
  addEventListener('scroll', () => {
    reposition();
    clearTimeout(timer);
    timer = setTimeout(() => { try { paint(); } catch {} }, 250);
  }, { capture: true, passive: true });
  addEventListener('resize', () => { reposition(); paint(); });
  setInterval(paint, 1000);   // レイアウトだけ変わったケースの保険
  if (window.visualViewport) {
    visualViewport.addEventListener('scroll', reposition, { passive: true });
    visualViewport.addEventListener('resize', reposition, { passive: true });
  }

  /* ショートカット: Alt+S で今フォーカスしてる本文欄を封印 */
  addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.repeat || e.isComposing) return;
    if (e.code !== 'KeyS' || e.key?.toLowerCase() !== 's') return;
    const ed = document.activeElement?.closest?.(EDITOR_SELS.join(','))
      || (document.activeElement?.isContentEditable ? document.activeElement : null)
      || findEditors().find((x) => x.getBoundingClientRect().height > 0);
    if (!ed) return;
    e.preventDefault();
    e.stopPropagation();
    toggleSeal(ed, slots.get(ed)?.pill || slots.get(ed)?.inToolbar);
  }, true);

  scan();
  console.info('[xseal] active — profile: plain (xo), editors:', findEditors().length);

  globalThis.__xseal_sel = () => (selMemo ? { start: selMemo.start, end: selMemo.end, picked: selMemo.picked } : null);
  globalThis.__xseal_dbg = { findEnvSpan: (t) => findEnvSpan(t), readText: (el) => readText(el), selectionIn: (el) => selectionIn(el), extractEnv: (t) => extractEnv(t) };

  /* 診断（設定ページの「診断」から実行される） */
  globalThis.__xseal_diag = () => {
    const eds = findEditors();
    return {
      ok: true,
      href: location.href,
      editors: eds.length,
      editorInfo: eds.slice(0, 4).map((e) => ({
        matchedSelector: EDITOR_SELS.find((s) => e.matches(s)),
        testid: e.getAttribute('data-testid'),
        contentEditable: e.isContentEditable,
        rect: (() => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; })(),
      })),
      toolbarFound: eds.some((e) => !!findToolbar(e)) || !!document.querySelector(TOOLBAR_SEL),
      submitFound: !!document.querySelector(SUBMIT_SELS.join(',')),
      pillShown: document.querySelectorAll('.xseal-pill').length,
      buttonsInDom: document.querySelectorAll('.xseal-btn, .xseal-pill').length,
      tweetTexts: document.querySelectorAll('[data-testid="tweetText"]').length,
      dm: {
        layers: !!document.querySelector('#layers'),
        ariaModals: document.querySelectorAll('[aria-modal="true"]').length,
        masks: document.querySelectorAll('[data-testid="mask"]').length,
        dms: [...document.querySelectorAll('[data-testid*="dm" i], [data-testid*="message" i]')]
          .slice(0, 12)
          .map((e) => ({
            t: e.getAttribute('data-testid'),
            ce: e.isContentEditable,
            inPrimary: !!e.closest('[data-testid="primaryColumn"]'),
            r: (() => { const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; })(),
          })),
      },
      testids: [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')))].slice(0, 60),
    };
  };
})();
