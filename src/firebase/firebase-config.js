/**
 * Firebase Webアプリ設定（開発環境: medconf-iol-dev）
 *
 * - これは公開前提のクライアント設定であり、秘密情報ではない（アクセス制御はSecurity Rulesで行う）。
 * - サービスアカウント秘密鍵・Admin SDK認証情報は絶対にここ（Git）に置かない。
 * - 必須項目が欠けている場合は、注文画面を表示せずにエラーを表示する(静的モードは廃止)。値を推測して埋めないこと。
 */
export const FIREBASE_CONFIG = Object.freeze({
  apiKey: "AIzaSyCC3xOe6BtUNkFN8xR8hyuwvDa10r83lR0", // Webアプリ用の公開キー（Firebase CLI apps:sdkconfig の値と照合済み）
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
