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

  return {
    /** 認証状態の購読。ログイン状態はSDKのlocal永続化で保持される */
    onChange(callback) {
      return fns.onAuthStateChanged(auth, callback);
    },

    async signInWithGoogle() {
      const provider = new fns.GoogleAuthProvider();
      return fns.signInWithPopup(auth, provider);
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
