/**
 * 施設ごとのヘッダーのテーマカラー(純粋関数)。保存先は facilities/{fid}/displaySettings/headerTheme({ color: "#rrggbb", gradient: bool })。
 * 未設定は null で、ヘッダーは標準の青いグラデーション(styles.css の .app-header)のまま。
 * ヘッダーの文字は白なので、白とのコントラスト比が 4.5 以上の色だけを使う(色見本はすべて満たす。自由な色も同じ基準で確認する)。
 */

/** 色見本(Word・Excel のような格子。列=色相、行=濃さ)。すべて白い文字が読める濃さ */
export const HEADER_THEME_PALETTE = Object.freeze([
  ["#1d4ed8", "#4338ca", "#7e22ce", "#be185d", "#b91c1c", "#c2410c", "#15803d", "#0f766e", "#0e7490", "#334155"],
  ["#1e40af", "#3730a3", "#6b21a8", "#9d174d", "#991b1b", "#9a3412", "#166534", "#115e59", "#155e75", "#1e293b"],
  ["#1e3a8a", "#312e81", "#581c87", "#831843", "#7f1d1d", "#7c2d12", "#14532d", "#134e4a", "#164e63", "#0f172a"]
].map(row => Object.freeze(row)));

/** 白い文字に必要なコントラスト比(WCAG AA・通常の文字) */
export const MIN_CONTRAST_WITH_WHITE = 4.5;

/** "#RGB"・"#RRGGBB"(大文字小文字・前後の空白は問わない)を "#rrggbb" にする。形式が違えば null */
export function normalizeHex(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return "#" + [...v.slice(1)].map(c => c + c).join("");
  return null;
}

const channels = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

/** 白とのコントラスト比(WCAG の相対輝度) */
export function contrastWithWhite(hex) {
  const [r, g, b] = channels(hex).map(c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (l + 0.05);
}

/** グラデーションの濃い側(元の色に黒を混ぜる)。濃くするだけなので、白い文字の読みやすさは元の色以上 */
export function darken(hex, amount = 0.35) {
  return "#" + channels(hex).map(c => Math.round(c * (1 - amount)).toString(16).padStart(2, "0")).join("");
}

/**
 * 入力の検証。色は "#rrggbb" にそろえ、白い文字が読めない明るい色は保存しない。
 * @returns {{ok:true, theme:{color:string, gradient:boolean}}|{ok:false, error:string}}
 */
export function validateHeaderTheme({ color, gradient } = {}) {
  const hex = normalizeHex(color);
  if (!hex) return { ok: false, error: "色は #RRGGBB の形式で入力してください(例: #1d4ed8)" };
  if (contrastWithWhite(hex) < MIN_CONTRAST_WITH_WHITE) return { ok: false, error: "明るすぎて白い文字が読みにくい色です。もう少し濃い色を選んでください" };
  return { ok: true, theme: { color: hex, gradient: gradient !== false } };
}

/** 保存されている値を読む(壊れている・明るすぎる値は未設定として扱い、標準の配色にする) */
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
