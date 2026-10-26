/**
 * 施設ごとのヘッダーのテーマカラー(純粋関数)。保存先は facilities/{fid}/displaySettings/headerTheme({ color: "#rrggbb", gradient: bool, darkText?: bool })。
 * 未設定は null で、ヘッダーは標準の青いグラデーション + 白い文字(styles.css の .app-header)のまま。
 * 背景色は明るさに関係なく選べる。文字は白(既定)か黒(darkText)。読みにくい組み合わせは案内するだけで、反映・保存は止めない。
 * darkText がない保存値(この項目の追加前の設定)は白い文字として読む。
 */

/**
 * 色見本(Word・Excel のような格子。10色×2行。列=色相: 青・紺・紫・ピンク・赤・オレンジ・緑・ティール・水色・グレー、上下で色相をそろえる)。
 * 1行目は白い文字向けの濃い色、2行目は黒い文字向けの明るい色。色見本を選ぶと文字の色も自動で設定する(darkText)。
 */
export const HEADER_THEME_PALETTE = Object.freeze([
  { label: "白文字向け", darkText: false, colors: ["#1d4ed8", "#1e3a8a", "#7e22ce", "#be185d", "#b91c1c", "#c2410c", "#15803d", "#0f766e", "#0e7490", "#475569"] },
  { label: "黒文字向け", darkText: true, colors: ["#93c5fd", "#a5b4fc", "#d8b4fe", "#f9a8d4", "#fca5a5", "#fdba74", "#86efac", "#5eead4", "#67e8f9", "#cbd5e1"] }
].map(row => Object.freeze({ ...row, colors: Object.freeze(row.colors) })));

/** 読みやすさの目安のコントラスト比(WCAG AA・通常の文字)。下回るときは案内を出す(保存は止めない) */
export const READABLE_CONTRAST = 4.5;

/** 黒い文字の色 */
export const DARK_TEXT_COLOR = "#000000";

/** "#RGB"・"#RRGGBB"(大文字小文字・前後の空白は問わない)を "#rrggbb" にする。形式が違えば null */
export function normalizeHex(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return "#" + [...v.slice(1)].map(c => c + c).join("");
  return null;
}

const channels = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

/** WCAG の相対輝度 */
function luminance(hex) {
  const [r, g, b] = channels(hex).map(c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 2色のコントラスト比 */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 白とのコントラスト比 */
export const contrastWithWhite = (hex) => contrastRatio(hex, "#ffffff");

/** グラデーションの濃い側(元の色に黒を混ぜる) */
export function darken(hex, amount = 0.35) {
  return "#" + channels(hex).map(c => Math.round(c * (1 - amount)).toString(16).padStart(2, "0")).join("");
}

/**
 * 入力の検証(形式だけ。明るさによる制限はしない)。色は "#rrggbb" にそろえる。グラデーションの初期値は ON、文字の初期値は白。
 * @returns {{ok:true, theme:{color:string, gradient:boolean, darkText:boolean}}|{ok:false, error:string}}
 */
export function validateHeaderTheme({ color, gradient, darkText } = {}) {
  const hex = normalizeHex(color);
  if (!hex) return { ok: false, error: "色は #RRGGBB の形式で入力してください(例: #1d4ed8)" };
  return { ok: true, theme: { color: hex, gradient: gradient !== false, darkText: darkText === true } };
}

/** 保存されている値を読む(壊れている値は未設定として扱い、標準の配色にする) */
export function readHeaderTheme(data) {
  if (!data || typeof data !== "object") return null;
  const v = validateHeaderTheme(data);
  return v.ok ? v.theme : null;
}

/** ヘッダーの背景(CSS)。未設定は null(標準の青いグラデーションのまま) */
export function headerBackground(theme) {
  if (!theme) return null;
  return theme.gradient ? `linear-gradient(135deg, ${darken(theme.color)} 0%, ${theme.color} 100%)` : theme.color;
}

/** 文字が読みやすい組み合わせか(グラデーションは、文字に近い側も含めて両端で確認する)。未設定(標準)は読みやすい */
export function isReadable(theme) {
  if (!theme) return true;
  const text = theme.darkText ? DARK_TEXT_COLOR : "#ffffff";
  const backs = theme.gradient ? [theme.color, darken(theme.color)] : [theme.color];
  return backs.every(bg => contrastRatio(text, bg) >= READABLE_CONTRAST);
}
