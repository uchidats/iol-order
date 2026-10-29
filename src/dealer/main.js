import { FIREBASE_CONFIG, isFirebaseConfigured } from "../firebase/firebase-config.js";
import { setupAppCheck } from "../firebase/app-check.js";
import { createDealerPortalApi } from "../data/dealer-portal-api.js";
import { dealerEntryUrl } from "../domain/dealer-portal.js";
import { createDealerApp } from "./dealer-app.js";

/**
 * ディーラー専用画面(dealer.html)の起動。医療機関の画面(index.html)とは別の入口。
 * Firebase のプロジェクトは医療機関の画面と共用するが、ログイン状態は別の名前のアプリで分ける。施設の所属・施設登録の画面には進まない。
 * ログイン(Google・Microsoft・メールリンク)の後は、確認コードで担当者に紐付けた認証主体だけをサーバーが通す(UID・メールの一致だけでは通さない)。
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
  // 医療機関の画面と別の名前の Firebase アプリにする: ログイン状態の保存先が分かれ、ディーラー画面のログイン・ログアウトが
  // 同じブラウザの医療機関の画面のログインを切り替えない(同じオリジン・同じプロジェクトでも別のセッション)
  const app = sdk.app.initializeApp(FIREBASE_CONFIG, "dealer-portal");
  await setupAppCheck({ app });
  const auth = sdk.auth.getAuth(app);
  // ブラウザの保存領域。取得そのものが拒否される環境(サイトデータの保存を拒否した場合など)でも起動できるよう、取得の例外も扱う(AB-04)。
  // 使えなければ null(ログインの保存はメモリだけ・端末の値はこの画面の間だけ)
  const storage = (() => { try { const st = window.localStorage; st.getItem("iolDealerProbe"); return st; } catch (e) { return null; } })();
  const service = createAuthService({ auth, fns: sdk.auth, currentUrl: () => dealerEntryUrl(location.origin), storage,
    emailStorageKey: "iol_dealer_emaillink_pending" });   // メールリンクの保存も医療機関の画面と分ける
  let uid = null;
  // 確認済みの端末の値(サーバーが確認コードを確かめた後に返す)。保存の単位は UID と今回のログイン方法・認証主体(固有IDのハッシュ)。
  // 別の方式・別の主体に自動で持ち越さない(サーバーも、発行した主体と今回の主体の一致を確かめる。AB-02)。
  // まずメモリに持ち、「この端末を記憶する」のときだけ端末にも保存する。保存できない環境では、この画面を開いている間だけ使える(AB-04)
  let deviceScope = null, remember = true, memoryDevice = null;
  const deviceKey = () => `iolDealerDevice.${deviceScope}`;
  const device = {
    get: () => {
      if (!deviceScope) return null;
      if (memoryDevice && memoryDevice.scope === deviceScope) return memoryDevice.token;
      try { return storage ? storage.getItem(deviceKey()) : null; } catch (e) { return null; }
    },
    /** @returns {boolean} 端末に保存できたか(記憶しない選択のときは保存せず、前の値も消す) */
    set: (t) => {
      if (!deviceScope) return false;
      memoryDevice = { scope: deviceScope, token: t };
      if (!storage) return false;
      try {
        if (!remember) { storage.removeItem(deviceKey()); return false; }
        storage.setItem(deviceKey(), t); return storage.getItem(deviceKey()) === t;
      } catch (e) { return false; }
    }
  };
  /** 今回のログインの方式と主体(固有IDのハッシュ)。端末の値の保存の単位にする(値そのものは画面に出さない) */
  async function scopeOf(user) {
    let provider = "unknown", id = "";
    try {
      const r = await user.getIdTokenResult();
      provider = String(r.signInProvider || (r.claims && r.claims.firebase && r.claims.firebase.sign_in_provider) || "unknown");
      const ids = (r.claims && r.claims.firebase && r.claims.firebase.identities) || {};
      id = Array.isArray(ids[provider]) ? String(ids[provider][0] || "") : "";
    } catch (e) { /* 取れなければ方式不明として扱う(サーバーが判定する) */ }
    let digest = id;
    try { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)); digest = [...new Uint8Array(b)].slice(0, 8).map(x => x.toString(16).padStart(2, "0")).join(""); }
    catch (e) { digest = String(id.length); }
    return `${user.uid}.${provider}.${digest}`;
  }
  const api = createDealerPortalApi({ functions: sdk.functions.getFunctions(app, "asia-northeast1"), httpsCallable: sdk.functions.httpsCallable, device });
  const ui = createDealerApp({
    mount, api, setSubtitle,
    onSignOut: async () => { try { await service.signOut(); } finally { location.reload(); } },   // 表示中のデータもメモリごと破棄する
    setRememberDevice: (v) => { remember = v !== false; }   // 本人確認の画面の「この端末を記憶する」
  });

  let error = "";
  if (service.isEmailLink(location.href)) {
    try { await service.completeEmailLink(location.href, () => window.prompt("確認のため、ログインに使うメールアドレスを入力してください")); }
    catch (e) { error = "ログインリンクが無効か、期限切れです。もう一度リンクを送信してください。"; console.warn(e); }
    history.replaceState(null, "", location.origin + location.pathname);
  }

  service.onChange(async (user) => {
    if (uid && (!user || user.uid !== uid)) { location.reload(); return; }   // 別のユーザーへの切り替え: 画面の状態を持ち越さない
    if (!user) {
      ui.showLogin({
        error,
        onGoogle: () => service.signInWithGoogle({ selectAccount: true }),   // 会社のアカウントを選べるよう、毎回アカウントの選択画面を出す
        onMicrosoft: () => service.signInWithMicrosoft({ selectAccount: true }),   // ポップアップ(スマホも。リダイレクトは別ドメインの認証で保存が分断されるため使わない)
        onSend: (email) => service.sendEmailLink(email)
      });
      return;
    }
    uid = user.uid;
    deviceScope = await scopeOf(user);
    await ui.enter();
  });
}

bootstrap().catch((e) => {
  console.error("初期化に失敗しました:", e);
  const mount = document.getElementById("dealerMain");
  if (mount) mount.replaceChildren(Object.assign(document.createElement("p"), { className: "error-message", textContent: "画面の読み込みに失敗しました。通信状況を確認して、ページを再読み込みしてください。" }));
});
