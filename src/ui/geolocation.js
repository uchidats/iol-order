/**
 * ブラウザの位置情報APIの薄いラッパー
 *  - 取得は1回のみ（getCurrentPosition）。watchPosition による継続追跡は行わない。
 *  - 取得結果は呼び出し元でその場で比較するだけで、保存・送信・ログ出力しない。
 */
export const GEO_ERROR = Object.freeze({
  UNSUPPORTED: "unsupported",
  DENIED: "denied",
  UNAVAILABLE: "unavailable",
  TIMEOUT: "timeout"
});

export class GeoError extends Error {
  constructor(code) { super(code); this.name = "GeoError"; this.code = code; }
}

const POSITION_OPTIONS = Object.freeze({
  enableHighAccuracy: true,
  timeout: 10000,
  maximumAge: 0 // キャッシュされた古い位置は使わない
});

/** "granted" | "denied" | "prompt" | "unsupported"（Permissions API 非対応を含む） */
export async function getGeoPermissionState(nav = globalThis.navigator) {
  try {
    if (!nav || !nav.permissions || !nav.permissions.query) return "unsupported";
    const status = await nav.permissions.query({ name: "geolocation" });
    return status.state;
  } catch (e) {
    return "unsupported";
  }
}

/** 現在地を1回だけ取得する */
export function getCurrentPositionOnce(nav = globalThis.navigator, options = POSITION_OPTIONS) {
  return new Promise((resolve, reject) => {
    if (!nav || !nav.geolocation) return reject(new GeoError(GEO_ERROR.UNSUPPORTED));
    nav.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyM: pos.coords.accuracy
      }),
      (err) => reject(new GeoError(
        err && err.code === 1 ? GEO_ERROR.DENIED : err && err.code === 3 ? GEO_ERROR.TIMEOUT : GEO_ERROR.UNAVAILABLE
      )),
      options
    );
  });
}
