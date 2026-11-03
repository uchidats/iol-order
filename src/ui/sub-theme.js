/**
 * サブテーマカラー(主要ボタン・選択中の表示・バッジ・リンクなどの青系の色)の反映(施設ごと。注文画面 index.html だけ)。
 * 選んだ色から作った CSS 変数を <html> に上書きする(domain/sub-theme.js)。未設定は上書きを外し、styles.css の従来の青に戻す。
 * ヘッダーの色(header-theme.js)・ディーラー画面(dealer.html はこれを呼ばない)には影響しない。
 * 再読み込みのときに従来の青から切り替わって見えないよう、最後に表示した施設の設定を端末に覚えておき、先に反映する。
 */
import { SUB_THEME_VARS, readSubTheme, subThemeVars } from "../domain/sub-theme.js";

const cacheKey = (facilityId) => `iol_sub_theme:${facilityId}`;

/** 反映する(theme が null なら従来の青に戻す) */
export function applySubTheme(theme, root = document.documentElement) {
  if (!root) return;
  const vars = subThemeVars(theme);
  for (const k of SUB_THEME_VARS) {
    if (vars) root.style.setProperty(k, vars[k]);
    else root.style.removeProperty(k);
  }
}

/** 端末に覚えた設定(読めない場合は null)。ローカルストレージが使えない環境でも動く */
export function cachedSubTheme(facilityId, storage = globalThis.localStorage) {
  try { return readSubTheme(JSON.parse(storage.getItem(cacheKey(facilityId)) || "null")); } catch { return null; }
}

export function cacheSubTheme(facilityId, theme, storage = globalThis.localStorage) {
  try {
    if (theme) storage.setItem(cacheKey(facilityId), JSON.stringify(theme));
    else storage.removeItem(cacheKey(facilityId));
  } catch { /* 保存できなくても表示は続ける */ }
}

/** 施設に入ったとき: 覚えた設定を先に反映し、保存されている設定を読んで反映し直す(読めなければ覚えた設定のまま) */
export async function loadSubTheme(facilityId, repository) {
  applySubTheme(cachedSubTheme(facilityId));
  if (!repository || !repository.getSubTheme) return;
  try {
    const theme = readSubTheme(await repository.getSubTheme(facilityId));
    applySubTheme(theme);
    cacheSubTheme(facilityId, theme);
  } catch (e) {
    console.warn("サブテーマカラーを読み込めませんでした:", e);
  }
}
