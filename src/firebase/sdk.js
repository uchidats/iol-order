/**
 * Firebase JavaScript SDK（モジュラー版）の読み込み
 * ビルド環境がないため、バージョンを固定してCDNから動的 import する。
 * 動的 import にしているのは、Firebase未設定時・CDN到達不可時でも既存画面を動かすため。
 */
export const FIREBASE_SDK_VERSION = "10.14.1";
const BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;

let cached = null;

export async function loadFirebaseSdk() {
  if (!cached) {
    cached = Promise.all([
      import(`${BASE}/firebase-app.js`),
      import(`${BASE}/firebase-auth.js`),
      import(`${BASE}/firebase-firestore.js`),
      import(`${BASE}/firebase-functions.js`)
    ]).then(([app, auth, firestore, functions]) => ({ app, auth, firestore, functions }));
  }
  return cached;
}
