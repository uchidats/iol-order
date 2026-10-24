/**
 * 選択中の施設の端末記憶（localStorage）と、一時フラグ
 *
 * 記憶するのは uid と facilityId のみ。GPS座標は一切保存しない。
 * 記憶値は「選択の候補」でしかなく、採用前に必ず Firestore で検証済みの所属と照合する
 * （domain/access.js の decideAccess）。ログアウト時に消去する。
 */
export const SELECTED_FACILITY_KEY = "iol_order_selected_facility";
export const GEO_OPTIN_KEY = "iol_order_geo_optin";
export const FORCE_SELECT_KEY = "iol_order_force_facility_select"; // sessionStorage

const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };

export function readRemembered(storage, uid) {
  const raw = safe(() => storage.getItem(SELECTED_FACILITY_KEY));
  if (!raw) return null;
  const v = safe(() => JSON.parse(raw));
  if (!v || typeof v.facilityId !== "string" || v.uid !== uid) return null; // 別ユーザーの記憶は使わない
  return v.facilityId;
}

export function remember(storage, uid, facilityId) {
  safe(() => storage.setItem(SELECTED_FACILITY_KEY, JSON.stringify({ uid, facilityId })));
}

export function clearRemembered(storage) {
  safe(() => storage.removeItem(SELECTED_FACILITY_KEY));
}

/** 位置情報の利用に同意した（現在地ボタンを押した）端末か */
export function hasGeoOptIn(storage) {
  return safe(() => storage.getItem(GEO_OPTIN_KEY)) === "1";
}
export function setGeoOptIn(storage) {
  safe(() => storage.setItem(GEO_OPTIN_KEY, "1"));
}
export function clearGeoOptIn(storage) {
  safe(() => storage.removeItem(GEO_OPTIN_KEY));
}

/** 「施設を切り替える」直後の1回だけ、自動復元・自動判定をスキップする */
export function setForceSelect(session) { safe(() => session.setItem(FORCE_SELECT_KEY, "1")); }
export function consumeForceSelect(session) {
  const v = safe(() => session.getItem(FORCE_SELECT_KEY)) === "1";
  safe(() => session.removeItem(FORCE_SELECT_KEY));
  return v;
}
