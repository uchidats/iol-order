/**
 * Firebase Webアプリ設定（開発環境: medconf-iol-dev）
 *
 * - これは公開前提のクライアント設定であり、秘密情報ではない（アクセス制御はSecurity Rulesで行う）。
 * - サービスアカウント秘密鍵・Admin SDK認証情報は絶対にここ（Git）に置かない。
 * - apiKey は Firebase Console の値が提供されるまで未設定。未設定の間は Firebase 機能を無効化し、
 *   従来どおりの静的モード（dryrun）で動作する。値を推測して埋めないこと。
 */
export const FIREBASE_CONFIG = Object.freeze({
  apiKey: "", // TODO: Firebase Console「プロジェクトの設定 > マイアプリ」の値を設定
  authDomain: "medconf-iol-dev.firebaseapp.com",
  projectId: "medconf-iol-dev",
  appId: "1:591596535765:web:d7a336aa6c6bb3d229875c"
});

const REQUIRED_KEYS = ["apiKey", "authDomain", "projectId", "appId"];

/** 必須項目がすべて埋まっているか */
export function isFirebaseConfigured(cfg = FIREBASE_CONFIG) {
  return REQUIRED_KEYS.every(k => typeof cfg[k] === "string" && cfg[k].trim() !== "");
}

/** 不足している項目名 */
export function missingFirebaseKeys(cfg = FIREBASE_CONFIG) {
  return REQUIRED_KEYS.filter(k => typeof cfg[k] !== "string" || cfg[k].trim() === "");
}
