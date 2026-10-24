import { loadConfig } from "./config.js";
import { createStaticRepository, DEFAULT_FACILITY_ID } from "./data/static-repository.js";
import { initOrderForm, isOrderFormDirty, reloadFacilityOptions } from "./ui/order-form.js";
import { initBiometry } from "./biometry/biometry-ui.js";
import { biometryState } from "./biometry/state.js";
import { IOL_MODELS } from "./data/iol-models.js";
import { FIREBASE_CONFIG, isFirebaseConfigured } from "./firebase/firebase-config.js";
import { decideAccess, activeMemberships, ACCESS } from "./domain/access.js";
import * as registrationFlow from "./domain/registration-flow.js";
import { createRegistrationApi, describeCallableError } from "./data/registration-api.js";
import { decideFacilityByLocation, GEO_RESULT } from "./domain/geo.js";
import * as selection from "./domain/facility-selection.js";
import { getGeoPermissionState, getCurrentPositionOnce, GEO_ERROR } from "./ui/geolocation.js";

/**
 * Firebase未設定の間は従来の静的モードで動作する。
 * 設定済みの場合は、ログイン + 施設への有効な所属が確認でき、施設が確定するまで注文画面を表示しない。
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

const GEO_MESSAGES = Object.freeze({
  [GEO_RESULT.NO_GEO_DATA]: "施設の位置情報が登録されていないため、現在地から判定できません。",
  [GEO_RESULT.INVALID_POSITION]: "現在地を正しく取得できませんでした。",
  [GEO_RESULT.LOW_ACCURACY]: "測位精度が十分でないため、施設を判定できません。",
  [GEO_RESULT.OUT_OF_RANGE]: "登録されている施設の近くではないようです。",
  [GEO_RESULT.AMBIGUOUS]: "複数の施設が該当するため、判定できません。",
  [GEO_ERROR.UNSUPPORTED]: "この端末では位置情報を利用できません。",
  [GEO_ERROR.DENIED]: "位置情報の利用が許可されていません。",
  [GEO_ERROR.UNAVAILABLE]: "現在地を取得できませんでした。",
  [GEO_ERROR.TIMEOUT]: "現在地の取得がタイムアウトしました。"
});

async function bootstrapWithFirebase(config) {
  const [{ createAuthUi }, { createHeaderMenu }] = await Promise.all([
    import("./ui/auth-ui.js"), import("./ui/header-menu.js")
  ]);

  const state = {
    configured: true, authReady: false, user: null,
    membershipsLoaded: false, memberships: [],
    selectedFacilityId: null,
    facilities: [] // 読み取れた（=有効な）所属施設のドキュメント
  };
  let notice = "";
  let error = "";
  let busy = false;
  const registration = { busy: false, duplicate: null, open: null }; // 施設登録・参加の状態（open: 所属済みユーザーがメニューから開いた画面 "register"|"join"）
  let formUid = null; // 注文画面を初期化済みのユーザー
  let ctx = null;     // { service, db, repository, settingsApi }
  let settings = null; // 施設設定画面（施設管理者のみ・初回表示時に生成）

  const ui = createAuthUi({
    onGoogle: () => run(() => ctx.service.signInWithGoogle()),
    onEmailLink: (email) => run(async () => {
      await ctx.service.sendEmailLink(email);
      notice = "ログインリンクを送信しました。メール内のリンクをこの端末で開いてください。";
    }),
    onSelectFacility: (facilityId) => chooseFacility(facilityId),
    onRegister: (args) => handleRegister(args),
    onJoin: (args) => handleJoin(args),
    onOnboardingClose: () => closeOnboarding(),
    onRegisterCancel: () => { registration.duplicate = null; error = ""; notice = ""; },
    onLocate: () => locateAndChoose({ userInitiated: true }),
    onSignOut: () => signOut()
  });

  const menu = createHeaderMenu({
    onSwitchFacility: () => {
      const dirty = isOrderFormDirty() || biometryState.userConfirmedValues.isConfirmed;
      if (dirty && !window.confirm("入力中の内容は破棄されます。施設を切り替えますか？")) return;
      selection.clearRemembered(window.localStorage);
      selection.setForceSelect(window.sessionStorage); // 切替直後は自動復元・自動判定をしない
      location.reload(); // 入力内容・計測値をメモリごと破棄
    },
    onOpenSettings: () => openSettings(),
    onRegisterFacility: () => openOnboarding("register"),
    onJoinFacility: () => openOnboarding("join"),
    onSignOut: () => signOut()
  });

  const ORDER_VIEW_IDS = ["iolOrderForm", "ocrFeatureCard"];
  const setOrderViewHidden = (hidden) => ORDER_VIEW_IDS.forEach(id => document.getElementById(id).classList.toggle("hidden", hidden));

  /** 施設設定を開く。表示は施設管理者のみ（書き込みはFirestoreルールでも検証される） */
  async function openSettings() {
    const access = decideAccess(state);
    if (access.state !== ACCESS.GRANTED || access.role !== "admin") return;
    if (!settings) {
      const { createFacilitySettings } = await import("./ui/facility-settings.js");
      settings = createFacilitySettings({
        mount: document.querySelector("main.main-content"),
        repository: ctx.repository,
        settingsApi: ctx.settingsApi,
        masters: IOL_MODELS,
        inviteApi: ctx.registrationApi,
        currentUser: { uid: state.user.uid, displayName: state.user.displayName },
        onSaved: () => reloadFacilityOptions(),
        onClose: () => setOrderViewHidden(false)
      });
    }
    setOrderViewHidden(true);
    await settings.open({ id: access.facilityId, name: facilityName(access.facilityId) });
  }

  /** 所属済みユーザーが、現在の施設・注文画面を保ったまま登録・参加の画面を開く */
  function openOnboarding(mode) {
    if (decideAccess(state).state !== ACCESS.GRANTED) return;
    if (settings && settings.isOpen()) settings.close();
    registration.duplicate = null; error = ""; notice = "";
    registration.open = mode;
    render();
  }

  function closeOnboarding() {
    registration.open = null; registration.duplicate = null; error = ""; notice = "";
    render();
  }

  async function signOut() {
    selection.clearRemembered(window.localStorage); // 再ログイン時は施設を選び直す
    try { await ctx.service.signOut(); } finally { location.reload(); }
  }

  const facilityName = (id) => {
    const f = state.facilities.find(x => x.id === id);
    return (f && f.name) || "（名称未設定）";
  };

  const render = () => {
    const access = decideAccess(state);
    ui.render({ access, user: state.user, notice, error, facilities: state.facilities, busy, registration });
    if (access.state === ACCESS.GRANTED) {
      menu.update({
        user: state.user, facilityName: facilityName(access.facilityId),
        canSwitch: access.memberships.length > 1, canSettings: access.role === "admin"
      });
      if (settings && settings.isOpen()) setOrderViewHidden(true); // 設定画面の表示中は注文画面を隠したまま
    } else {
      menu.update(null);
    }
    return access;
  };

  async function run(task) {
    error = ""; notice = "";
    if (!ctx) { error = "認証サービスに接続できません。"; render(); return; }
    try { await task(); } catch (e) { error = describeAuthError(e); }
    render();
  }

  /** 施設を確定して注文画面を表示する */
  async function chooseFacility(facilityId, { remember = true } = {}) {
    // 検証済みの所属に含まれない施設IDは採用しない（decideAccess も同様に判定する）
    if (!activeMemberships(state.memberships).some(m => m.facilityId === facilityId)) return;
    state.selectedFacilityId = facilityId;
    if (remember) selection.remember(window.localStorage, state.user.uid, facilityId);
    notice = ""; error = "";
    await enterFacilityIfGranted();
  }

  async function enterFacilityIfGranted() {
    const access = render();
    if (access.state === ACCESS.GRANTED && !formUid) {
      formUid = state.user.uid;
      await initOrderForm({
        config,
        repository: ctx.repository,
        facilityId: access.facilityId,
        facility: { id: access.facilityId, name: facilityName(access.facilityId) }
      });
    }
    return access;
  }

  /** 登録・参加の後に所属を取得し直し、新しい施設の画面へ進む（所属の確認は常にFirestoreで行う） */
  async function refreshAfterMembershipChange(facilityId, { openSettingsAfter }) {
    state.membershipsLoaded = false;
    render();
    try {
      state.memberships = await ctx.fetchMemberships(state.user.uid);
      await loadFacilities();
    } catch (e) {
      console.error("所属情報の取得に失敗しました:", e);
      state.memberships = []; state.facilities = [];
    }
    state.membershipsLoaded = true;
    if (activeMemberships(state.memberships).some(m => m.facilityId === facilityId)) {
      state.selectedFacilityId = facilityId;
      selection.remember(window.localStorage, state.user.uid, facilityId);
    } else {
      error = "所属の反映を確認できませんでした。ページを再読み込みしてください。";
    }
    const access = await enterFacilityIfGranted();
    if (openSettingsAfter && access.state === ACCESS.GRANTED && access.role === "admin") await openSettings();
  }

  /**
   * 所属済みのまま新しい所属が増えた場合: 現在の施設・入力中の注文はそのまま保ち、
   * 所属一覧だけ更新する（新しい施設へはメニューの「施設を切り替える」で移動する）
   */
  async function refreshWhileGranted(newFacilityId) {
    state.selectedFacilityId = decideAccess(state).facilityId; // 所属が増えても現在の施設から離れない
    try {
      state.memberships = await ctx.fetchMemberships(state.user.uid);
      await loadFacilities();
    } catch (e) {
      console.error("所属情報の取得に失敗しました:", e);
      error = "所属の反映を確認できませんでした。ページを再読み込みしてください。";
    }
    registration.open = null;
    if (!error) {
      if (activeMemberships(state.memberships).some(m => m.facilityId === newFacilityId)) {
        notice = `「${facilityName(newFacilityId)}」を追加しました。メニューの「施設を切り替える」から移動できます。`;
      } else {
        error = "所属の反映を確認できませんでした。ページを再読み込みしてください。";
      }
    }
    render();
  }

  /** 新しい施設を登録する（施設・最初の管理者所属の作成はサーバー側で一括して行われる） */
  async function handleRegister({ name, confirmDuplicate }) {
    if (registration.busy) return;
    error = ""; notice = "";
    const invalid = registrationFlow.validateFacilityName(name);
    if (invalid) { error = invalid; render(); return; }
    if (state.user.emailVerified === false) { error = "メールアドレスの確認が済んでいないため、登録できません。"; render(); return; }

    registration.busy = true; render();
    try {
      // 再試行しても同じ要求として扱われるよう、施設名ごとに要求IDを保持する
      const requestId = registrationFlow.getRequestId(window.sessionStorage, name);
      const r = await ctx.registrationApi.registerFacility({ name, requestId, confirmDuplicate });
      if (r.status === "duplicate-candidate") {
        registration.duplicate = { ...r, forName: registrationFlow.normalizeFacilityName(name) };
      } else {
        registrationFlow.clearRequestId(window.sessionStorage);
        registration.duplicate = null;
        registration.busy = false;
        if (registration.open) { await refreshWhileGranted(r.facilityId); return; }
        await refreshAfterMembershipChange(r.facilityId, { openSettingsAfter: true });
        return;
      }
    } catch (e) {
      console.error("施設の登録に失敗しました:", e);
      error = describeCallableError(e);
    }
    registration.busy = false;
    render();
  }

  /** 招待コードで既存施設に参加する（招待のない参加はサーバーが拒否する） */
  async function handleJoin({ token }) {
    if (registration.busy) return;
    error = ""; notice = "";
    if (!token) { error = "招待コードを入力してください"; render(); return; }
    if (state.user.emailVerified === false) { error = "メールアドレスの確認が済んでいないため、参加できません。"; render(); return; }

    registration.busy = true; render();
    try {
      const r = await ctx.registrationApi.acceptInvite({ token });
      registration.busy = false;
      if (registration.open) { await refreshWhileGranted(r.facilityId); return; }
      await refreshAfterMembershipChange(r.facilityId, { openSettingsAfter: false });
      return;
    } catch (e) {
      error = describeCallableError(e);
    }
    registration.busy = false;
    render();
  }

  /**
   * 現在地から施設を選ぶ（ログイン時の自動判定、または手動ボタン）。
   * 取得は1回のみ。座標は比較のためにここで使うだけで、保存・送信・ログ出力しない。
   */
  async function locateAndChoose({ userInitiated }) {
    if (busy) return;
    busy = true; error = "";
    notice = "現在地を確認しています…";
    if (userInitiated) selection.setGeoOptIn(window.localStorage); // 次回以降のログイン時に自動判定する
    render();

    let message = "";
    try {
      const position = await getCurrentPositionOnce();
      const result = decideFacilityByLocation(position, state.facilities);
      if (result.status === GEO_RESULT.SELECTED) {
        busy = false;
        await chooseFacility(result.facilityId);
        return;
      }
      message = GEO_MESSAGES[result.status];
    } catch (e) {
      message = GEO_MESSAGES[e && e.code] || GEO_MESSAGES[GEO_ERROR.UNAVAILABLE];
    }
    busy = false;
    notice = `${message}施設を手動で選択してください。`;
    render();
  }

  /** 所属ごとの施設ドキュメントを読む。読めない（停止中など）施設は所属から除外する */
  async function loadFacilities() {
    const active = activeMemberships(state.memberships);
    const docs = await Promise.all(active.map(async (m) => {
      try {
        const f = await ctx.repository.getFacility(m.facilityId);
        return f && f.status === "active" ? f : null;
      } catch (e) {
        return null;
      }
    }));
    state.facilities = docs.filter(Boolean);
    state.memberships = state.memberships.filter(m => state.facilities.some(f => f.id === m.facilityId));
  }

  /** 複数所属時の自動選択: 記憶 → （同意済みなら）現在地。決まらなければ手動選択 */
  async function autoSelectFacility() {
    const forced = selection.consumeForceSelect(window.sessionStorage);
    const active = activeMemberships(state.memberships);
    if (active.length <= 1 || forced) return false; // 1施設はGPS不使用で自動確定

    const remembered = selection.readRemembered(window.localStorage, state.user.uid);
    if (remembered && active.some(m => m.facilityId === remembered)) {
      state.selectedFacilityId = remembered; // 所属はFirestoreで検証済みの場合のみ採用
      return false;
    }

    if (selection.hasGeoOptIn(window.localStorage)) {
      const permission = await getGeoPermissionState();
      if (permission === "granted" || permission === "unsupported") {
        await locateAndChoose({ userInitiated: false });
        return true; // locateAndChoose 内で描画済み
      }
    }
    return false;
  }

  render(); // LOADING

  try {
    const [{ loadFirebaseSdk }, { createAuthService }, { createFirestoreRepository, createFirestoreSettingsApi, fetchMemberships }] =
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
    ctx = {
      service, db,
      repository: createFirestoreRepository(db, sdk.firestore),
      settingsApi: createFirestoreSettingsApi(db, sdk.firestore),
      registrationApi: createRegistrationApi({
        functions: sdk.functions.getFunctions(app, "asia-northeast1"),
        httpsCallable: sdk.functions.httpsCallable
      }),
      fetchMemberships: (uid) => fetchMemberships(db, sdk.firestore, uid)
    };

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
      state.facilities = [];
      state.selectedFacilityId = null;
      render();

      if (user) {
        try {
          state.memberships = await fetchMemberships(db, sdk.firestore, user.uid);
          await loadFacilities();
        } catch (e) {
          console.error("所属情報の取得に失敗しました:", e);
          error = "所属情報を取得できませんでした。";
          state.memberships = []; // 取得できない場合は許可しない（fail closed）
          state.facilities = [];
        }
        state.membershipsLoaded = true;
        if (await autoSelectFacility()) return; // 現在地判定の中で描画・遷移済み
      }

      await enterFacilityIfGranted();
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
