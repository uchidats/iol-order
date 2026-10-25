/**
 * App Check(reCAPTCHA Enterprise)。**監視モード**: トークンを付けて送るだけで、Functions(enforceAppCheck: false)・
 * Firestore(Firebase Console で未適用)のどちらも、トークンがない・不正な要求を拒否しない。
 * サイトキー(APP_CHECK_SITE_KEY)が空の間は何もしない(App Check のSDKも読み込まない)。
 * 初期化に失敗しても(reCAPTCHA を読み込めない等)、ログイン・注文・施設管理は止めない。
 * 導入・強制への切り替えの手順は docs/app-check.md。
 */
import { FIREBASE_SDK_VERSION } from "./sdk.js";

/** reCAPTCHA Enterprise のサイトキー(公開前提の値。秘密情報ではない)。Firebase Console の App Check に登録した後に設定する */
export const APP_CHECK_SITE_KEY = "";

/**
 * @param {object} deps
 * @param {object} deps.app 初期化済みの Firebase App
 * @param {string} [deps.siteKey]
 * @param {() => Promise<object>} [deps.load] firebase-app-check モジュールの読み込み(テスト用に差し替え可能)
 * @param {string} [deps.hostname] 開発用(localhost)ではデバッグトークンを使う
 * @param {object} [deps.globalObj]
 * @returns {Promise<"disabled"|"enabled"|"failed">}
 */
export async function setupAppCheck({ app, siteKey = APP_CHECK_SITE_KEY, load = () => import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app-check.js`), hostname = globalThis.location ? globalThis.location.hostname : "", globalObj = globalThis }) {
  if (!siteKey) return "disabled";
  try {
    // ローカル開発ではデバッグトークン(コンソールに表示される値を Firebase Console に登録して使う)
    if (hostname === "localhost" || hostname === "127.0.0.1") globalObj.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    const m = await load();
    m.initializeAppCheck(app, { provider: new m.ReCaptchaEnterpriseProvider(siteKey), isTokenAutoRefreshEnabled: true });
    return "enabled";
  } catch (e) {
    console.warn("App Check を初期化できませんでした(監視モードのため、このまま続行します):", e);
    return "failed";
  }
}
