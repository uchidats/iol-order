import { h } from "./markdown-view.js";
import { createSectionHeading } from "./info-tip.js";
import { HEADER_THEME_PALETTE, validateHeaderTheme, isReadable } from "../domain/header-theme.js";
import { validateSubTheme } from "../domain/sub-theme.js";
import { createAutoSaver, setSectionMessage } from "./settings-autosave.js";

/** 初期設定(標準の青。styles.css の .app-header と同じ色) */
export const DEFAULT_THEME_COLOR = "#1d4ed8";

/**
 * テーマカラー(ヘッダーの色)の設定欄。施設設定(施設ごと)・ディーラー設定(会社で共通)で共通の UI・操作。
 * 色見本(格子)または自由な色(HEX)を選ぶと、すぐにヘッダーに反映して自動保存する。「初期設定に戻す」で標準の青いグラデーション + 白い文字に戻す(設定を削除)。
 * 背景色は明るさに関係なく選べる。文字は白(既定)か黒。読みにくい組み合わせは控えめに案内するだけで、反映・保存は止めない。
 * 保存先・反映先は呼び出し側が決める(この部品は値の検証・表示・自動保存の順番だけを持つ)。
 *
 * @param {object} deps
 * @param {string} deps.description 見出しのⓘの説明
 * @param {() => (object|null)} deps.get 今の設定(未設定は null)
 * @param {(theme:(object|null)) => void} deps.use 設定を変えたとき(画面の状態の更新・ヘッダーへの反映)。保存はこの部品が自動で行う
 * @param {(theme:(object|null)) => Promise<void>} deps.save 保存(null は初期設定に戻す = 削除)
 * @param {"header"|"sub"} [deps.variant] "sub" = サブテーマカラー(色だけ。グラデーション・黒い文字・読みやすさの案内・色見本の行の見出しは出さない)
 * @param {boolean} [deps.bare] true なら見出しのない部品(div)を返す(施設設定の「ヘッダー」「サブテーマカラー」の切り替えの中身)
 * @returns {{ section: HTMLElement, saver: object }} section._render() で今の設定を表示し直す
 */
export function createThemeColorSection({ description, get, use: apply, save, variant = "header", bare = false }) {
  const sub = variant === "sub";
  // 色見本: 行ごとに「白文字向け」「黒文字向け」の小さな見出し。選ぶと文字の色もその行に合わせる(後から「フォントを黒にする」で変更できる)
  const swatches = h("div", { class: "theme-palette", role: "group", "aria-label": "色見本" },
    HEADER_THEME_PALETTE.flatMap(row => [
      sub ? null : h("span", { class: "theme-row-label" }, row.label),
      h("div", { class: "theme-swatches" }, row.colors.map(c => h("button", { type: "button", class: "theme-swatch", "data-color": c, "data-dark-text": String(row.darkText),
        title: sub ? c : `${c}(${row.label})`, "aria-label": sub ? c : `${c}(${row.label})`, "aria-pressed": "false", style: `background:${c}` })))].filter(Boolean)));
  const f = (name) => (sub ? name.replace(/^theme/, "subTheme") : name);   // サブテーマの欄は data-f を分ける(同じ画面に2つ並ぶため)
  const picker = h("input", { type: "color", class: "theme-picker", "data-f": f("themePicker"), "aria-label": "その他の色" });
  const hexIn = h("input", { class: "form-control theme-hex", type: "text", maxlength: "7", "data-f": f("themeHex"), placeholder: DEFAULT_THEME_COLOR, "aria-label": "色(HEX)", autocomplete: "off", spellcheck: "false" });
  const chk = h("input", { type: "checkbox", "data-f": "themeGradient" });
  const dark = h("input", { type: "checkbox", "data-f": "themeDarkText" });
  const advice = h("p", { class: "theme-advice", "data-f": "themeAdvice", hidden: true }, "文字が読みやすい配色を推奨します");
  const reset = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": sub ? "sub-theme-reset" : "theme-reset" }, "初期設定に戻す");
  const body = [
    swatches,
    h("div", { class: "theme-custom" }, h("span", { class: "form-label" }, "その他の色"), picker, hexIn),
    sub ? null : h("label", { class: "settings-check" }, chk, h("span", {}, "グラデーションを使用する")),
    sub ? null : h("label", { class: "settings-check" }, dark, h("span", {}, "フォントを黒にする")),
    sub ? null : advice,
    h("div", {}, reset),
    h("p", { class: "form-hint", "data-msg": "" })].filter(Boolean);
  const section = bare
    ? h("div", { class: "theme-pane", "data-theme-pane": variant }, ...body)
    : h("section", { class: "settings-section", "data-section": "theme" }, createSectionHeading("テーマカラー", description), ...body);
  const show = () => {
    const t = get();
    for (const b of swatches.querySelectorAll(".theme-swatch")) b.setAttribute("aria-pressed", String(Boolean(t) && b.dataset.color === t.color));
    picker.value = t ? t.color : DEFAULT_THEME_COLOR;
    hexIn.value = t ? t.color : "";
    chk.checked = t ? t.gradient !== false : true;
    dark.checked = Boolean(t && t.darkText);
    advice.hidden = sub || isReadable(t);
    reset.disabled = !t;
  };
  let saver = null;
  const use = (theme) => {   // ヘッダーにすぐ反映し、自動保存する
    apply(theme);
    show();
    saver.request();
  };
  const choose = (color, darkText = dark.checked) => {
    const v = sub ? validateSubTheme({ color }) : validateHeaderTheme({ color, gradient: chk.checked, darkText });   // サブテーマは選んだ元の色だけ
    if (!v.ok) { setSectionMessage(section, v.error, true); return; }   // 形式違い(#RRGGBB でない)だけは反映も保存もしない
    setSectionMessage(section, "");
    use(v.theme);
  };
  swatches.addEventListener("click", (e) => { const b = e.target.closest(".theme-swatch"); if (b) choose(b.dataset.color, b.dataset.darkText === "true"); });
  picker.addEventListener("change", () => choose(picker.value));
  hexIn.addEventListener("change", () => choose(hexIn.value));
  chk.addEventListener("change", () => { const t = get(); if (t) use({ ...t, gradient: chk.checked }); });
  // 未設定(標準の青)のまま黒い文字にしたときは、標準の青を基準にした設定として保存する
  dark.addEventListener("change", () => use({ ...(get() || { color: DEFAULT_THEME_COLOR, gradient: chk.checked }), darkText: dark.checked }));
  reset.addEventListener("click", () => { setSectionMessage(section, ""); use(null); });
  let saved = null;   // 最後に保存した内容(同じ内容は保存しない)
  saver = createAutoSaver(section, async () => {
    const t = get();
    if (JSON.stringify(t) === JSON.stringify(saved)) return;
    await save(t);
    saved = t;
  });
  section._render = () => { saved = get(); setSectionMessage(section, ""); show(); };
  return { section, saver };
}

/**
 * テーマカラー欄(「テーマカラー」の見出しの直下に「ヘッダー」「サブテーマカラー」の切り替え。初期表示は「ヘッダー」)。施設設定・ディーラー設定で共通。
 * 中身は createThemeColorSection(ヘッダーは従来どおり、サブテーマは色見本・その他の色・初期設定に戻すだけ)。保存先・反映先は呼び出し側が決める。
 * sub を省略(null)すると、切り替えのない従来のヘッダーの欄だけになる。
 * @param {{ description:string, header:{get,use,save}, sub?:({get,use,save}|null) }} deps
 * @returns {{ section: HTMLElement, savers: object[] }} section._render() で今の設定を表示し直す(切り替えは「ヘッダー」に戻す)
 */
export function createThemeColorTabs({ description, header: headerDeps, sub: subDeps = null }) {
  const header = createThemeColorSection({ ...headerDeps, bare: true });
  // サブテーマカラー: 保存するのは選んだ元の色で、文字の読みやすさのための濃さの調整は表示のときだけ(domain/sub-theme.js)
  const sub = subDeps ? createThemeColorSection({ ...subDeps, bare: true, variant: "sub" }) : null;
  let target = "header";
  const tabBtn = (v, label) => {
    const b = h("button", { type: "button", class: "history-sort-btn", "data-theme-target": v, "aria-pressed": String(v === target) }, label);
    b.addEventListener("click", () => setTarget(v));
    return b;
  };
  const tabs = sub ? h("div", { class: "history-sort theme-target", role: "group", "aria-label": "テーマカラーを設定する場所" }, tabBtn("header", "ヘッダー"), tabBtn("sub", "サブテーマカラー")) : null;
  function setTarget(v) {
    target = v;
    if (tabs) tabs.querySelectorAll("[data-theme-target]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.themeTarget === v)));
    header.section.hidden = v !== "header";
    if (sub) sub.section.hidden = v !== "sub";
  }
  const section = h("section", { class: "settings-section", "data-section": "theme" }, createSectionHeading("テーマカラー", description), tabs, header.section, sub ? sub.section : null);
  setTarget("header");
  section._render = () => { header.section._render(); if (sub) sub.section._render(); setTarget("header"); };
  return { section, savers: [header.saver, sub ? sub.saver : null].filter(Boolean) };
}
