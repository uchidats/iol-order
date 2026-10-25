/**
 * スマホ幅で、ネイティブの select メニュー(Androidでは画面幅いっぱいに広がる)の代わりに使う、カスタムドロップダウン。
 *
 * - 元の <select> は残し、値・選択肢・change イベントの「正」として使い続ける(既存の選択処理・注文データは変わらない)。
 *   カスタム側は、表示(トリガーボタン + メニュー)と、選んだときに select の値を変えて change を発火する操作だけ。
 * - PC幅では、ボタンを隠して従来のネイティブ select を表示する(切り替えは CSS: @media (max-width: 640px))。
 * - メニューは白背景・濃いグレーの文字に固定(ダークモードでも変えない)。幅 240〜280px、選択肢の高さ 42px。
 *   選択中は青いチェックマーク。optgroup(メーカー別)の見出しを維持。多いときはメニュー内でスクロール。
 *   画面外にはみ出さないよう、位置(上下・左右)を自動調整する。
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const MENU_MIN_WIDTH = 240;
const MENU_MAX_WIDTH = 280;
const MENU_MAX_HEIGHT = 336;   // 約8項目。これを超えるときはメニュー内でスクロール
const EDGE = 8;                // 画面端との余白

let openMenu = null;           // 同時に開けるメニューは1つ
let uid = 0;

function checkIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "2.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(k, v);
  svg.setAttribute("class", "cs-check");
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", "M5 12.5l4.5 4.5L19 7.5");
  svg.appendChild(p);
  return svg;
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

/**
 * select をカスタムドロップダウンに対応させる(トリガーボタンを追加するだけ。表示の切り替えは CSS)。
 * @param {HTMLSelectElement} select 親は .select-wrapper
 * @param {{ariaLabel:string, matchWidth?:boolean, wrapText?:boolean}} opts matchWidth: メニューの幅をボタンの幅に揃える(幅の狭い選択ボックス用。既定は 240〜280px) / wrapText: 長い名前をボタンの中で折り返す(切らない)
 */
export function enhanceSelect(select, { ariaLabel = "", matchWidth = false, wrapText = false } = {}) {
  const wrapper = select.parentElement;
  if (!wrapper || select._customSelect) return;
  wrapper.classList.add("cs-enhanced");

  const trigger = el("button", "form-control cs-trigger");
  trigger.type = "button";
  if (wrapText) trigger.classList.add("cs-wrap");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  if (ariaLabel) trigger.setAttribute("aria-label", ariaLabel);
  const text = el("span", "cs-trigger-text");
  trigger.append(text);
  wrapper.insertBefore(trigger, select);

  /** select の現在の状態を、ボタンの表示に反映する */
  const sync = () => {
    const opt = select.selectedOptions[0];
    text.textContent = opt ? opt.textContent : "";
    trigger.classList.toggle("is-placeholder", !select.value);
    trigger.disabled = select.disabled;
  };
  sync();
  select.addEventListener("change", sync);
  select.addEventListener("input", sync);
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled"] });
  // コードから select.value = ... と設定された場合(イベントは出ない)も、表示に反映する
  const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  Object.defineProperty(select, "value", { configurable: true, get() { return proto.get.call(this); }, set(v) { proto.set.call(this, v); sync(); } });

  let panel = null, items = [], active = -1;
  const id = `cs-${++uid}`;

  function close(focusTrigger = false) {
    if (!panel) return;
    panel.remove(); panel = null; items = []; active = -1;
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-controls");
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("resize", position);
    window.removeEventListener("scroll", onScroll, true);
    if (openMenu === api) openMenu = null;
    if (focusTrigger) trigger.focus({ preventScroll: true });
  }

  const onOutside = (e) => { if (panel && !panel.contains(e.target) && !trigger.contains(e.target)) close(); };
  const onScroll = (e) => { if (panel && !panel.contains(e.target)) position(); };

  function choose(value) {
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));   // 既存の change の処理(度数の作り直しなど)がそのまま動く
    }
    close(true);
  }

  function setActive(i, scroll = true) {
    if (!items.length) return;
    active = Math.max(0, Math.min(items.length - 1, i));
    items.forEach((it, k) => it.classList.toggle("is-active", k === active));
    panel.setAttribute("aria-activedescendant", items[active].id);
    if (scroll) items[active].scrollIntoView({ block: "nearest" });
  }

  /** トリガーの位置に合わせて、幅 240〜280px のメニューを、画面外にはみ出さないように置く */
  function position() {
    if (!panel) return;
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const r = trigger.getBoundingClientRect();
    const width = matchWidth ? Math.min(r.width, vw - EDGE * 2) : Math.min(MENU_MAX_WIDTH, Math.max(MENU_MIN_WIDTH, r.width), vw - EDGE * 2);
    panel.style.width = `${width}px`;
    panel.style.maxHeight = "none";
    const content = panel.scrollHeight;
    const below = vh - r.bottom - EDGE, above = r.top - EDGE;
    const want = Math.min(content, MENU_MAX_HEIGHT);
    const placeBelow = below >= want || below >= above;       // 下に収まる、または下のほうが広いとき下。そうでなければ上
    const height = Math.max(80, Math.min(want, placeBelow ? below : above));
    panel.style.maxHeight = `${height}px`;
    panel.style.top = `${placeBelow ? r.bottom + 4 : Math.max(EDGE, r.top - height - 4)}px`;
    panel.style.left = `${Math.min(Math.max(EDGE, r.left), vw - width - EDGE)}px`;
    panel.dataset.placement = placeBelow ? "below" : "above";
  }

  function open() {
    if (panel || select.disabled) return;
    if (openMenu) openMenu.close();
    panel = el("div", "cs-panel");
    panel.id = id; panel.setAttribute("role", "listbox"); panel.tabIndex = -1;
    if (ariaLabel) panel.setAttribute("aria-label", ariaLabel);
    const addOption = (o, parent) => {
      const row = el("div", "cs-option");
      row.id = `${id}-o${items.length}`;
      row.setAttribute("role", "option");
      row.dataset.value = o.value;
      const selected = o.selected;
      row.setAttribute("aria-selected", String(selected));
      if (selected) row.classList.add("is-selected");
      if (!o.value) row.classList.add("is-placeholder");
      row.append(el("span", "cs-option-text", o.textContent));
      if (selected && o.value) row.append(checkIcon());   // 選択中は青いチェックマーク
      row.addEventListener("click", () => choose(o.value));
      row.addEventListener("pointermove", () => { const k = items.indexOf(row); if (k !== active) setActive(k, false); });
      parent.append(row);
      items.push(row);
    };
    for (const child of select.children) {
      if (child.tagName === "OPTGROUP") {
        const g = el("div", "cs-group");
        g.setAttribute("role", "group");
        g.append(el("div", "cs-group-label", child.label));   // メーカー別のグループ分け
        for (const o of child.children) addOption(o, g);
        panel.append(g);
      } else if (child.tagName === "OPTION") addOption(child, panel);
    }
    document.body.append(panel);
    trigger.setAttribute("aria-expanded", "true");
    trigger.setAttribute("aria-controls", id);
    position();
    const sel = items.findIndex(it => it.classList.contains("is-selected") && it.dataset.value);
    setActive(sel >= 0 ? sel : 0, false);
    if (sel >= 0) panel.scrollTop = Math.max(0, items[sel].offsetTop - panel.clientHeight / 2 + items[sel].offsetHeight / 2);   // 選択中の項目が見える位置から開く
    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", onScroll, true);
    trigger.focus({ preventScroll: true });   // Safari などは、ボタンをタップしてもフォーカスが当たらないため、キー操作(↑↓・Enter・Esc)が使えるように明示する
    openMenu = api;
  }

  trigger.addEventListener("click", () => (panel ? close() : open()));
  trigger.addEventListener("keydown", (e) => {
    if (!panel) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); open(); }
      return;
    }
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setActive(active + 1); break;
      case "ArrowUp": e.preventDefault(); setActive(active - 1); break;
      case "Home": e.preventDefault(); setActive(0); break;
      case "End": e.preventDefault(); setActive(items.length - 1); break;
      case "Enter": case " ": e.preventDefault(); if (items[active]) choose(items[active].dataset.value); break;
      case "Escape": e.preventDefault(); close(true); break;
      case "Tab": close(); break;
      default:
    }
  });

  const api = { close: () => close(), sync };
  select._customSelect = api;
}
