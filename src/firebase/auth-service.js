const EMAIL_STORAGE_KEY = "iol_order_emaillink_pending";

/**
 * 認証サービス（Googleログイン / メールリンク / ログアウト / 状態監視）
 * SDK関数は依存として注入し、テストでは偽物に差し替える。
 *
 * @param {object} deps
 * @param {object} deps.auth        Firebase Auth インスタンス
 * @param {object} deps.fns         firebase-auth のモジュラー関数群
 * @param {() => string} deps.currentUrl  メールリンクの戻り先（クエリ/ハッシュ除去済み）
 * @param {Storage} [deps.storage]
 */
export function createAuthService({ auth, fns, currentUrl, storage }) {
  const store = storage || { getItem() { return null; }, setItem() {}, removeItem() {} };

  const safe = (fn) => { try { return fn(); } catch (e) { return null; } };
  const microsoftProvider = (selectAccount) => {
    const p = new fns.OAuthProvider("microsoft.com");
    if (selectAccount && typeof p.setCustomParameters === "function") p.setCustomParameters({ prompt: "select_account" });
    return p;
  };

  return {
    /** 認証状態の購読。ログイン状態はSDKのlocal永続化で保持される */
    onChange(callback) {
      return fns.onAuthStateChanged(auth, callback);
    },

    /**
     * Googleでログイン(ポップアップ)。
     * @param {{selectAccount?:boolean}} [opts] selectAccount: 毎回アカウントの選択画面を出す(個人のアカウントなどで自動的にログインしないように。ディーラー画面で使う)
     */
    async signInWithGoogle({ selectAccount = false } = {}) {
      const provider = new fns.GoogleAuthProvider();
      if (selectAccount && typeof provider.setCustomParameters === "function") provider.setCustomParameters({ prompt: "select_account" });
      return fns.signInWithPopup(auth, provider);
    },

    /**
     * Microsoft アカウントでログイン(ポップアップ。Firebase 標準の OAuthProvider("microsoft.com")。企業(Entra ID)と個人の両方)。
     * @param {{selectAccount?:boolean}} [opts] selectAccount: 毎回アカウントの選択画面を出す
     */
    async signInWithMicrosoft({ selectAccount = false } = {}) {
      return fns.signInWithPopup(auth, microsoftProvider(selectAccount));
    },

    /** ログイン中のアカウントに Microsoft アカウントを連携し、連携を反映した ID トークンに更新する(本人の操作でだけ呼ぶ) */
    async linkMicrosoft() {
      const user = auth.currentUser;
      if (!user) throw Object.assign(new Error("ログインが必要です"), { code: "auth/no-current-user" });
      const r = await fns.linkWithPopup(user, microsoftProvider(true));
      await user.getIdToken(true);
      return r;
    },

    /** パスワード不要のメールリンクを送る */
    async sendEmailLink(email) {
      const trimmed = String(email || "").trim();
      if (!trimmed) throw new Error("メールアドレスを入力してください");
      await fns.sendSignInLinkToEmail(auth, trimmed, {
        url: currentUrl(),
        handleCodeInApp: true
      });
      safe(() => store.setItem(EMAIL_STORAGE_KEY, trimmed));
    },

    /** 現在のURLがメールリンクか */
    isEmailLink(href) {
      return fns.isSignInWithEmailLink(auth, href);
    },

    /**
     * メールリンクでのログインを完了する。
     * 送信時と別端末で開いた場合は askEmail() で本人にメールアドレスを再入力させる。
     */
    async completeEmailLink(href, askEmail) {
      if (!fns.isSignInWithEmailLink(auth, href)) return null;
      let email = safe(() => store.getItem(EMAIL_STORAGE_KEY));
      if (!email) email = askEmail ? askEmail() : null;
      if (!email) throw new Error("メールアドレスの確認が必要です");
      const cred = await fns.signInWithEmailLink(auth, email.trim(), href);
      safe(() => store.removeItem(EMAIL_STORAGE_KEY));
      return cred;
    },

    async signOut() {
      return fns.signOut(auth);
    }
  };
}
