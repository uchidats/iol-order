/**
 * 施設ごとのサブテーマカラー(純粋関数)。主要ボタン・選択中のボタン・バッジ・リンク・一部の強調文字やアイコンなど、
 * 標準では青系の部分の色(styles.css の --primary 系の変数)を、選んだ1色から作る。ヘッダーの色(header-theme.js)とは別の設定。
 * 保存先は facilities/{fid}/displaySettings/subTheme({ color: "#rrggbb" })。保存するのは利用者が選んだ元の色で、
 * 文字の読みやすさのための濃さの調整は表示のときだけ行う(subThemeVars)。未設定は null で、従来の青のまま。
 * エラー・警告・成功・削除などの意味のある色(--danger など)とヘッダーは変えない。ボタンや文字にグラデーションは使わない。
 */
import { normalizeHex, contrastRatio, READABLE_CONTRAST } from "./header-theme.js";

/** 選んだ色から上書きする CSS 変数(styles.css の :root に、未設定のときの従来の値がある) */
export const SUB_THEME_VARS = Object.freeze([
  "--primary", "--primary-hover", "--primary-light", "--primary-focus", "--accent",
  "--primary-tint", "--primary-frame", "--primary-border", "--primary-soft", "--primary-select", "--primary-select-active", "--primary-check",
  "--info-bg", "--info-text", "--info-badge-text", "--info-border"
]);

/** 入力の検証(形式だけ)。色は "#rrggbb" にそろえる */
export function validateSubTheme({ color } = {}) {
  const hex = normalizeHex(color);
  if (!hex) return { ok: false, error: "色は #RRGGBB の形式で入力してください(例: #1d4ed8)" };
  return { ok: true, theme: { color: hex } };
}

/** 保存されている値を読む(壊れている値は未設定として扱い、従来の青にする) */
export function readSubTheme(data) {
  if (!data || typeof data !== "object") return null;
  const v = validateSubTheme(data);
  return v.ok ? v.theme : null;
}

const channels = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => "#" + rgb.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("");

/** 2色を混ぜる(t = 0 で a、1 で b) */
export function mix(a, b, t) {
  const x = channels(a), y = channels(b);
  return toHex(x.map((c, i) => c + (y[i] - c) * t));
}

/** 薄い背景(主色に白を混ぜる割合)。主色の文字を置く背景のうち、いちばん濃いものでも読めるかを確かめる */
const TINT = { light: 0.93, tint: 0.92, select: 0.9, selectActive: 0.82, frame: 0.75, border: 0.7, soft: 0.5 };

/** #rrggbb ⇔ HSL(h: 0〜360、s・l: 0〜1) */
function toHsl(hex) {
  const [r, g, b] = channels(hex).map(c => c / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
function fromHsl([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex([r, g, b].map(v => (v + m) * 255));
}

const readable = (p) => contrastRatio(p, "#ffffff") >= READABLE_CONTRAST && contrastRatio(p, mix(p, "#ffffff", TINT.select)) >= READABLE_CONTRAST;

/**
 * 表示に使う主色: 選んだ色を、白い文字(主要ボタン)とのコントラスト比と、白・薄い背景の上の主色の文字のコントラスト比が
 * どちらも 4.5 以上になるまで濃くする。色合い(色相・彩度)は保ち、明るさだけを少しずつ下げる(黒を混ぜるとくすむため)。
 * もともと十分に濃い色はそのまま
 */
export function readablePrimary(color) {
  const base = normalizeHex(color);
  if (!base) return null;
  if (readable(base)) return base;
  const [h, s, l0] = toHsl(base);
  for (let l = l0; l > 0; l -= 0.01) {
    const p = fromHsl([h, s, Math.max(0, l)]);
    if (readable(p)) return p;
  }
  return "#000000";
}

/**
 * CSS 変数の値(未設定は null = 上書きを外して従来の青)。主色の濃淡(押したとき・薄い背景・枠線・フォーカスの枠)は主色から作る
 * @returns {Record<string,string>|null}
 */
export function subThemeVars(theme) {
  const t = readSubTheme(theme);
  if (!t) return null;
  const p = readablePrimary(t.color);
  const [r, g, b] = channels(p);
  const w = (k) => mix(p, "#ffffff", TINT[k]);
  return {
    "--primary": p,
    "--primary-hover": mix(p, "#000000", 0.18),
    "--primary-light": w("light"),
    "--primary-focus": `rgba(${r}, ${g}, ${b}, 0.2)`,
    "--accent": p,
    "--primary-tint": w("tint"),
    "--primary-frame": w("frame"),
    "--primary-border": w("border"),
    "--primary-soft": w("soft"),
    "--primary-select": w("select"),
    "--primary-select-active": w("selectActive"),
    "--primary-check": p,
    "--info-bg": w("light"),
    "--info-text": p,
    "--info-badge-text": p,
    "--info-border": w("border")
  };
}
