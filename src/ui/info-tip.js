/**
 * 見出し右側の小さなⓘアイコンと、クリック・タップで開く説明(共通部品)。
 * デザイン・動作は web-onsen-stamp-rally(温泉の旅)の `.progress-help-*` に合わせている:
 *  - 「ⓘ」の文字を、背景・枠線・影のない透明なボタンで表示する
 *  - 説明は、枠線つきの小さなボックス(影なし・12px・行間1.7)で、アイコンの下に出す
 *  - マウス: ホバーで開き、離れると閉じる。クリックで開いたまま固定(もう一度クリックで閉じる)
 *  - タッチ: タップで開閉
 *  - 外側のクリック・タップ / Esc / フォーカスが外れたとき に閉じる。同時に開くのは1つだけ
 * 説明は textContent で表示する(HTMLとして解釈しない)。ボタンは aria-expanded / aria-controls / aria-describedby 付き。
 *
 *   const heading = createSectionHeading("注文者", "説明文…");
 */

let seq = 0;
const openTips = new Set();

function closeAll(except = null) {
  for (const t of [...openTips]) if (t !== except) t.close();
}

let listening = false;
function listenOnce() {
  if (listening) return;
  listening = true;
  // 外側のクリック・タップで閉じる(ⓘ自身・説明の中は除く)
  document.addEventListener("click", (e) => {
    for (const t of [...openTips]) if (!t.root.contains(e.target)) t.close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !openTips.size) return;
    const last = [...openTips].pop();
    closeAll();
    last.button.focus(); // 閉じたあとも、操作位置を見失わない
  });
}

/** @returns {{root:HTMLElement, button:HTMLButtonElement, popup:HTMLElement, open:()=>void, close:()=>void}} */
export function createInfoTip(text, { label = "説明を表示" } = {}) {
  listenOnce();
  const id = `infoTip-${++seq}`;
  const root = document.createElement("span");
  root.className = "info-tip";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "info-tip-btn";
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", id);
  button.setAttribute("aria-describedby", id);
  const glyph = document.createElement("span");
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "ⓘ";
  button.append(glyph);

  const popup = document.createElement("div");
  popup.className = "info-tip-pop";
  popup.id = id;
  popup.setAttribute("role", "tooltip");
  popup.hidden = true;
  popup.textContent = text;

  let pinned = false; // クリック・タップで開いた(ホバーを外れても閉じない)
  const tip = {
    root, button, popup,
    open() { closeAll(tip); popup.hidden = false; button.setAttribute("aria-expanded", "true"); openTips.add(tip); },
    close() { pinned = false; popup.hidden = true; button.setAttribute("aria-expanded", "false"); openTips.delete(tip); }
  };
  button.addEventListener("click", (e) => {
    e.stopPropagation(); // 同じクリックを「外側のクリック」と数えない
    if (!popup.hidden && pinned) { tip.close(); return; } // 固定されていれば閉じる
    pinned = true; tip.open();                              // ホバーで開いていた場合も、固定する
  });
  root.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse" && popup.hidden) tip.open(); });
  root.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !pinned) tip.close(); });
  root.addEventListener("focusout", (e) => { if (!root.contains(e.relatedTarget)) tip.close(); });
  root.append(button, popup);
  return tip;
}

/** 見出し + 右側のⓘ(説明つき)。説明は常時表示しない。 */
export function createSectionHeading(title, text) {
  const wrap = document.createElement("div");
  wrap.className = "settings-heading";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  wrap.append(h3, createInfoTip(text, { label: `${title}の説明` }).root);
  return wrap;
}
