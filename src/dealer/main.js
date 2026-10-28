import { FIREBASE_CONFIG, isFirebaseConfigured } from "../firebase/firebase-config.js";
import { setupAppCheck } from "../firebase/app-check.js";
import { createDealerPortalApi } from "../data/dealer-portal-api.js";
import { dealerEntryUrl } from "../domain/dealer-portal.js";
import { createDealerApp } from "./dealer-app.js";

/**
 * ディーラー専用画面(dealer.html)の起動。医療機関の画面(index.html)とは別の入口。
 * Firebase のプロジェクトと認証(Googleログイン・メールリンク)は医療機関の画面と共用するが、施設の所属・施設登録の画面には進まない。
 * ログインの方法にかかわらず、招待先のメールとの一致・会社の所属・施設の許可はサーバーが毎回確認する(確認済みのメールと UID で判定)。
 * メールリンクの戻り先は同じドメインの dealer.html に固定する(任意の URL へは戻さない)。
 */
async function bootstrap() {
  const mount = document.getElementById("dealerMain");
  const subtitle = document.getElementById("dealerCompany");
  const setSubtitle = (t) => { subtitle.textContent = t || ""; subtitle.hidden = !t; };
  const fatal = (text) => { mount.replaceChildren(Object.assign(document.createElement("p"), { className: "error-message", textContent: text })); };
  if (!isFirebaseConfigured(FIREBASE_CONFIG)) { fatal("システムの設定が不足しているため、表示できません。"); return; }

  const [{ loadFirebaseSdk }, { createAuthService }] = await Promise.all([import("../firebase/sdk.js"), import("../firebase/auth-service.js")]);
  const sdk = await loadFirebaseSdk();
  const app = sdk.app.initializeApp(FIREBASE_CONFIG);
  await setupAppCheck({ app });
  const auth = sdk.auth.getAuth(app);
  const service = createAuthService({ auth, fns: sdk.auth, currentUrl: () => dealerEntryUrl(location.origin), storage: window.localStorage });
  const api = createDealerPortalApi({ functions: sdk.functions.getFunctions(app, "asia-northeast1"), httpsCallable: sdk.functions.httpsCallable });
  const ui = createDealerApp({
    mount, api, setSubtitle,
    onSignOut: async () => { try { await service.signOut(); } finally { location.reload(); } }   // 表示中のデータもメモリごと破棄する
  });

  let error = "";
  if (service.isEmailLink(location.href)) {
    try { await service.completeEmailLink(location.href, () => window.prompt("確認のため、ログインに使うメールアドレスを入力してください")); }
    catch (e) { error = "ログインリンクが無効か、期限切れです。もう一度リンクを送信してください。"; console.warn(e); }
    history.replaceState(null, "", location.origin + location.pathname);
  }

  let uid = null;
  service.onChange(async (user) => {
    if (uid && (!user || user.uid !== uid)) { location.reload(); return; }   // 別のユーザーへの切り替え: 画面の状態を持ち越さない
    if (!user) {
      ui.showLogin({
        error,
        onGoogle: () => service.signInWithGoogle({ selectAccount: true }),   // 会社のアカウントを選べるよう、毎回アカウントの選択画面を出す
        onSend: (email) => service.sendEmailLink(email)
      });
      return;
    }
    uid = user.uid;
    if (user.emailVerified === false) { ui.showMessage("ディーラー画面", "メールアドレスの確認が済んだアカウントのみ利用できます。", { error: true }); return; }
    await ui.enter();
  });
}

bootstrap().catch((e) => {
  console.error("初期化に失敗しました:", e);
  const mount = document.getElementById("dealerMain");
  if (mount) mount.replaceChildren(Object.assign(document.createElement("p"), { className: "error-message", textContent: "画面の読み込みに失敗しました。通信状況を確認して、ページを再読み込みしてください。" }));
});
