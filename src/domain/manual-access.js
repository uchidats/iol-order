/**
 * オンラインマニュアル(使い方・ヘルプ)のページの表示範囲。画面の整理のためで、施設の権限・Rules とは別(原稿は誰でも読める)。
 *   未ログイン・施設に入る前: 目次・1(初めて利用する方)
 *   注文者・代行入力者: 目次・1・2 / 副管理者・管理者・運営者(platformAdmin): 目次・1〜3(3 = 副管理者・施設管理者向け)
 * ログイン・所属の確認中(audience が null)は、未ログインと同じ範囲だけを表示する(上位のページを一時的にも出さない)。
 */
const LEVEL = Object.freeze({ guest: 0, orderer: 1, proxy: 1, subadmin: 2, admin: 3, platformAdmin: 3 });

/** ページごとの、閲覧に必要な最低の段階 */
export const MANUAL_PAGE_LEVEL = Object.freeze({ index: 0, "01-first-time": 0, "02-orderer": 1, "03-managers": 2 });

/** @param {string|null} audience guest / orderer / proxy / subadmin / admin / platformAdmin。null(確認中)・不明は guest と同じ */
export const audienceLevel = (audience) => LEVEL[audience] ?? 0;

/** 表に載っていないページは管理者だけ(新しいページの追加時に、表への追加漏れで広く見せないため) */
export const canViewManualPage = (pageId, audience) => audienceLevel(audience) >= (MANUAL_PAGE_LEVEL[pageId] ?? 3);

/** @param {Array<{id:string}>} pages */
export const visibleManualPages = (pages, audience) => pages.filter(p => canViewManualPage(p.id, audience));

/**
 * 画面の状態から、マニュアルの閲覧範囲を決める。確認中は null。
 * @param {{checked:boolean, user:object|null, isPlatformAdmin:boolean, membershipsLoaded:boolean, grantedRole:string|null}} s
 */
export function manualAudience({ checked, user, isPlatformAdmin, membershipsLoaded, grantedRole }) {
  if (!checked) return null;
  if (!user) return "guest";
  if (isPlatformAdmin === true) return "platformAdmin";
  if (!membershipsLoaded) return null;
  return grantedRole && grantedRole in LEVEL ? grantedRole : "guest";
}
