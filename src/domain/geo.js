/**
 * 現在地と施設の登録座標の比較（ブラウザ内の純粋ロジック）
 *
 * - 座標・判定距離は施設ドキュメント（location / geoRadiusM）に管理者が登録した値のみを使う。
 *   未登録の施設は判定対象外。コード内に既定の座標・距離は持たない。
 * - 位置情報は保存・送信しない。アクセス権限の判断には使わない（施設の選択補助のみ）。
 */
const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

export function isValidLatLng(p) {
  return Boolean(p)
    && typeof p.lat === "number" && typeof p.lng === "number"
    && Number.isFinite(p.lat) && Number.isFinite(p.lng)
    && p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;
}

/** 2点間の距離（メートル, haversine） */
export function distanceMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 施設の判定用データ（座標と判定距離の両方が有効な場合のみ） */
export function facilityGeo(facility) {
  if (!facility || !isValidLatLng(facility.location)) return null;
  const r = facility.geoRadiusM;
  if (typeof r !== "number" || !Number.isFinite(r) || r <= 0) return null;
  return { lat: facility.location.lat, lng: facility.location.lng, radiusM: r };
}

export const GEO_RESULT = Object.freeze({
  SELECTED: "selected",
  NO_GEO_DATA: "no-geo-data",     // 座標・判定距離が登録された施設がない
  INVALID_POSITION: "invalid-position",
  LOW_ACCURACY: "low-accuracy",   // 測位誤差が大きく、施設内と断定できない
  OUT_OF_RANGE: "out-of-range",   // どの施設の近くでもない
  AMBIGUOUS: "ambiguous"          // 複数の施設が該当し得る
});

/**
 * 現在地から施設を判定する。
 * 施設の判定距離 r、現在地の誤差 a、距離 d に対して
 *   「確実に施設内」: d + a <= r（誤差円が判定円に完全に収まる）
 *   「施設内の可能性」: d - a <= r
 * 確実に施設内の施設がちょうど1つで、他に可能性のある施設がない場合のみ自動選択する。
 * （測位誤差が判定距離を超える場合は自動的に「確実」にならず、手動選択になる）
 *
 * @param {{lat:number, lng:number, accuracyM:number}} position
 * @param {Array<{id:string, location?:object, geoRadiusM?:number}>} facilities
 */
export function decideFacilityByLocation(position, facilities) {
  if (!isValidLatLng(position) || !Number.isFinite(position.accuracyM) || position.accuracyM < 0) {
    return { status: GEO_RESULT.INVALID_POSITION };
  }

  const candidates = (facilities || [])
    .map(f => ({ id: f.id, geo: facilityGeo(f) }))
    .filter(c => c.geo);
  if (candidates.length === 0) return { status: GEO_RESULT.NO_GEO_DATA };

  const measured = candidates.map(c => ({
    id: c.id,
    d: distanceMeters(position, c.geo),
    r: c.geo.radiusM
  }));
  const a = position.accuracyM;
  const definite = measured.filter(m => m.d + a <= m.r);
  const possible = measured.filter(m => m.d - a <= m.r);

  if (possible.length === 0) return { status: GEO_RESULT.OUT_OF_RANGE };
  if (definite.length === 1 && possible.length === 1) {
    return { status: GEO_RESULT.SELECTED, facilityId: definite[0].id };
  }
  if (definite.length === 0) return { status: GEO_RESULT.LOW_ACCURACY };
  return { status: GEO_RESULT.AMBIGUOUS };
}
