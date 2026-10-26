/**
 * ヘッダーのテーマカラー(背景・文字の白/黒)の反映(施設ごと)。ヘッダー以外のボタン・配色には影響しない。
 * 再読み込みのときに標準の青から切り替わって見えないよう、最後に表示した施設の設定を端末に覚えておき、先に反映する。
 */
import { headerBackground, readHeaderTheme } from "../domain/header-theme.js";

const cacheKey = (facilityId) => `iol_header_theme:${facilityId}`;

/** ヘッダーに反映する(theme が null なら標準の青いグラデーション + 白い文字に戻す)。黒い文字はクラスで切り替える(styles.css) */
export function applyHeaderTheme(theme, header = document.querySelector(".app-header")) {
  if (!header) return;
  const bg = headerBackground(theme);
  if (bg) header.style.background = bg;
  else header.style.removeProperty("background");
  header.classList.toggle("is-dark-text", Boolean(theme && theme.darkText));
}

/** 端末に覚えた設定(読めない場合は null)。ローカルストレージが使えない環境でも動く */
export function cachedHeaderTheme(facilityId, storage = globalThis.localStorage) {
  try { return readHeaderTheme(JSON.parse(storage.getItem(cacheKey(facilityId)) || "null")); } catch { return null; }
}

export function cacheHeaderTheme(facilityId, theme, storage = globalThis.localStorage) {
  try {
    if (theme) storage.setItem(cacheKey(facilityId), JSON.stringify(theme));
    else storage.removeItem(cacheKey(facilityId));
  } catch { /* 保存できなくても表示は続ける */ }
}

/** 施設に入ったとき: 覚えた設定を先に反映し、保存されている設定を読んで反映し直す(読めなければ覚えた設定のまま) */
export async function loadHeaderTheme(facilityId, repository) {
  applyHeaderTheme(cachedHeaderTheme(facilityId));
  if (!repository || !repository.getHeaderTheme) return;
  try {
    const theme = readHeaderTheme(await repository.getHeaderTheme(facilityId));
    applyHeaderTheme(theme);
    cacheHeaderTheme(facilityId, theme);
  } catch (e) {
    console.warn("ヘッダーのテーマカラーを読み込めませんでした:", e);
  }
}
