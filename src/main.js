import { loadConfig } from "./config.js";
import { createStaticRepository, DEFAULT_FACILITY_ID } from "./data/static-repository.js";
import { initOrderForm } from "./ui/order-form.js";
import { initBiometry } from "./biometry/biometry-ui.js";
import { FIREBASE_CONFIG, isFirebaseConfigured } from "./firebase/firebase-config.js";
import { decideAccess, ACCESS } from "./domain/access.js";

/**
 * Firebase未設定（apiKey 未提供）の間は従来の静的モードで動作する。
 * 設定済みの場合は、ログイン + 施設への有効な所属が確認できるまで注文画面を表示しない。
 */
async function bootstrap() {
  const config = await loadConfig();
  initBiometry();

  if (!isFirebaseConfigured(FIREBASE_CONFIG)) {
    await initOrderForm({ config, repository: createStaticRepository(), facilityId: DEFAULT_FACILITY_ID });
    return;
  }

  await bootstrapWithFirebase(config);
}

async function bootstrapWithFirebase(config) {
  const { createAuthUi } = await import("./ui/auth-ui.js");

  const state = {
    configured: true, authReady: false, user: null,
    membershipsLoaded: false, memberships: []
  };
  let notice = "";
  let error = "";
  let formUid = null; // 注文画面を初期化済みのユーザー
  let ctx = null;     // { service, db, fs }

  const ui = createAuthUi({
    onGoogle: () => run(() => ctx.service.signInWithGoogle()),
    onEmailLink: (email) => run(async () => {
      await ctx.service.sendEmailLink(email);
      notice = "ログインリンクを送信しました。メール内のリンクをこの端末で開いてください。";
    }),
    onSignOut: async () => {
      try { await ctx.service.signOut(); } finally { location.reload(); } // メモリ上の計測値等も破棄
    }
  });

  const render = () => {
    const access = decideAccess(state);
    ui.render({ access, user: state.user, notice, error });
    return access;
  };

  async function run(task) {
    error = ""; notice = "";
    if (!ctx) { error = "認証サービスに接続できません。"; render(); return; }
    try { await task(); } catch (e) { error = describeAuthError(e); }
    render();
  }

  render(); // LOADING

  try {
    const [{ loadFirebaseSdk }, { createAuthService }, { createFirestoreRepository, fetchMemberships }] =
      await Promise.all([
        import("./firebase/sdk.js"),
        import("./firebase/auth-service.js"),
        import("./data/firestore-repository.js")
      ]);
    const sdk = await loadFirebaseSdk();
    const app = sdk.app.initializeApp(FIREBASE_CONFIG);
    const auth = sdk.auth.getAuth(app);
    const db = sdk.firestore.getFirestore(app);
    const service = createAuthService({
      auth, fns: sdk.auth,
      currentUrl: () => location.origin + location.pathname,
      storage: window.localStorage
    });
    ctx = { service, db, fs: sdk.firestore };

    // メールリンクからの復帰
    if (service.isEmailLink(location.href)) {
      try {
        await service.completeEmailLink(
          location.href,
          () => window.prompt("確認のため、ログインに使うメールアドレスを入力してください")
        );
      } catch (e) {
        error = describeAuthError(e);
      }
      history.replaceState(null, "", location.origin + location.pathname);
    }

    service.onChange(async (user) => {
      // 別ユーザーへ切り替わった場合は画面状態を持ち越さない
      if (formUid && (!user || user.uid !== formUid)) { location.reload(); return; }

      state.authReady = true;
      state.user = user;
      state.membershipsLoaded = false;
      state.memberships = [];
      render();

      if (user) {
        try {
          state.memberships = await fetchMemberships(db, sdk.firestore, user.uid);
        } catch (e) {
          console.error("所属情報の取得に失敗しました:", e);
          error = "所属情報を取得できませんでした。";
          state.memberships = []; // 取得できない場合は許可しない（fail closed）
        }
        state.membershipsLoaded = true;
      }

      const access = render();
      if (access.state === ACCESS.GRANTED && !formUid) {
        formUid = user.uid;
        await initOrderForm({
          config,
          repository: createFirestoreRepository(db, sdk.firestore),
          facilityId: access.facilityId
        });
      }
    });
  } catch (e) {
    console.error("Firebaseの初期化に失敗しました:", e);
    error = "認証サービスに接続できません。時間をおいて再度お試しください。";
    state.authReady = true; state.user = null; // 画面は閉じたまま
    render();
  }
}

function describeAuthError(e) {
  const code = e && e.code;
  const map = {
    "auth/popup-closed-by-user": "ログインがキャンセルされました。",
    "auth/popup-blocked": "ポップアップがブロックされました。許可して再度お試しください。",
    "auth/invalid-email": "メールアドレスの形式が正しくありません。",
    "auth/invalid-action-code": "ログインリンクが無効か、期限切れです。もう一度リンクを送信してください。",
    "auth/expired-action-code": "ログインリンクの期限が切れています。もう一度リンクを送信してください。",
    "auth/unauthorized-domain": "このドメインはFirebaseで許可されていません。",
    "auth/operation-not-allowed": "このログイン方法はFirebaseで有効化されていません。",
    "auth/network-request-failed": "ネットワークに接続できません。"
  };
  return map[code] || (e && e.message) || "ログインに失敗しました。";
}

bootstrap().catch(err => {
  console.error("初期化に失敗しました:", err);
});
