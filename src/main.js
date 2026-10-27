import { loadConfig } from "./config.js";
import { initOrderForm, isOrderFormDirty, reloadFacilityOptions } from "./ui/order-form.js";
import { initBiometry, BIOMETRY_OCR_ENABLED } from "./biometry/biometry-ui.js";
import { biometryState } from "./biometry/state.js";
import { IOL_MODELS } from "./data/iol-models.js";
import { FIREBASE_CONFIG, isFirebaseConfigured } from "./firebase/firebase-config.js";
import { setupAppCheck } from "./firebase/app-check.js";
import { decideAccess, validMemberships, ACCESS } from "./domain/access.js";
import { isManagerRole } from "./domain/member-admin.js";
import * as registrationFlow from "./domain/registration-flow.js";
import { createRegistrationApi, describeCallableError } from "./data/registration-api.js";
import { createOrderApi } from "./data/order-api.js";
import { loadHeaderTheme } from "./ui/header-theme.js";
import { confirmDialog } from "./ui/confirm-dialog.js";
import { decideFacilityByLocation, GEO_RESULT } from "./domain/geo.js";
import * as selection from "./domain/facility-selection.js";
import { getGeoPermissionState, getCurrentPositionOnce, GEO_ERROR } from "./ui/geolocation.js";

/**
 * ログイン + 施設への有効な所属が確認でき、施設が確定するまで注文画面を表示しない。
 * Firebase の設定がない・初期化に失敗した場合は、注文画面を出さずにエラーを表示する(固定データの静的モードは廃止)。
 */
async function bootstrap() {
  const config = await loadConfig();
  if (BIOMETRY_OCR_ENABLED) initBiometry();

  if (!isFirebaseConfigured(FIREBASE_CONFIG)) {
    showFatal("システムの設定が不足しているため、注文画面を表示できません。管理者にお問い合わせください。");
    return;
  }

  await bootstrapWithFirebase(config);
}

/** 起動できないときの表示。注文画面は隠したままにする */
function showFatal(message) {
  for (const id of ["iolOrderForm", "ocrFeatureCard"]) {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  }
  const main = document.querySelector("main.main-content");
  if (!main) return;
  const panel = document.getElementById("fatalPanel") || main.insertBefore(Object.assign(document.createElement("section"), { id: "fatalPanel", className: "feature-card" }), main.firstChild);
  const p = document.createElement("p");
  p.className = "error-message";
  p.setAttribute("role", "alert");
  p.textContent = message;
  panel.replaceChildren(p);
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
    facilities: [], // 読み取れた（=有効な）所属施設のドキュメント
    pendingInvites: [] // 本人宛ての参加待ち(事前登録)。ある間は参加確認画面を表示する
  };
  let pendingBusy = false;
  let notice = "";
  let error = "";
  let busy = false;
  const registration = { busy: false, duplicate: null, open: null }; // 施設登録の状態（open: 所属済みユーザーがメニューから開いた画面 "register"）
  let formUid = null; // 注文画面を初期化済みのユーザー
  let ctx = null;     // { service, db, repository, settingsApi }
  let settings = null; // 施設設定画面（施設管理者のみ・初回表示時に生成）
  let orderHistory = null;  // 注文履歴（所属メンバー全員。閲覧のみ・初回表示時に生成）
  let applications = null;  // 施設登録の申請の一覧・承認・却下(承認権限のある運営者のみ。権限はサーバーが確認する)
  let preregistrations = null;  // 施設の事前登録(運営者 = platformAdmin のみ。権限はサーバーが確認する)
  let isPlatformAdmin = false;   // メニューの表示だけに使う(ID トークンの platformAdmin)
  let canApproveFacilities = false;   // メニューの表示だけに使う(ID トークンの platformAdmin。サーバーでも必ず確認する)

  const ui = createAuthUi({
    onGoogle: () => run(() => ctx.service.signInWithGoogle()),
    onEmailLink: (email) => run(async () => {
      await ctx.service.sendEmailLink(email);
      notice = "ログインリンクを送信しました。メール内のリンクをこの端末で開いてください。";
    }),
    onSelectFacility: (facilityId) => chooseFacility(facilityId),
    onRegister: (args) => handleRegister(args),
    onOnboardingClose: () => closeOnboarding(),
    onRegisterCancel: () => { registration.duplicate = null; error = ""; notice = ""; },
    onCheckName: (name) => (ctx && ctx.registrationApi ? ctx.registrationApi.checkFacilityName({ name }) : null),
    onRespondPending: (args) => respondPending(args),
    onLocate: () => locateAndChoose({ userInitiated: true }),
    onSignOut: () => signOut()
  });

  const menu = createHeaderMenu({
    onSwitchFacility: async () => {
      const dirty = isOrderFormDirty() || biometryState.userConfirmedValues.isConfirmed;
      // 入力中なら確認(既存のモーダルと同じ見た目。キャンセルなら入力内容・現在の施設はそのまま)
      if (dirty && !(await confirmDialog({ message: "入力中の内容は破棄されます。施設を切り替えますか？", okLabel: "切り替える", cancelLabel: "キャンセル" }))) return;
      selection.clearRemembered(window.localStorage);
      selection.setForceSelect(window.sessionStorage); // 切替直後は自動復元・自動判定をしない
      location.reload(); // 入力内容・計測値をメモリごと破棄
    },
    onOpenHistory: () => openHistory(),
    onOpenSettings: () => openSettings(),
    onOpenApplications: () => openApplications(),
    onOpenPreregistrations: () => openPreregistrations(),
    onRegisterFacility: () => openOnboarding("register"),
    onSignOut: () => signOut()
  });

  const ORDER_VIEW_IDS = ["iolOrderForm", "ocrFeatureCard"];
  const setOrderViewHidden = (hidden) => ORDER_VIEW_IDS.forEach(id => document.getElementById(id).classList.toggle("hidden", hidden));

  /** 施設登録の申請の一覧を開く(承認権限のある運営者のみ。一覧・承認・却下の権限はサーバーが確認する) */
  async function openApplications() {
    if (!canApproveFacilities || !ctx || !ctx.registrationApi) return;
    if (settings && settings.isOpen()) settings.close();
    if (orderHistory && orderHistory.isOpen()) orderHistory.close();
    if (preregistrations && preregistrations.isOpen()) preregistrations.close();
    if (!applications) {
      const { createFacilityApplications } = await import("./ui/facility-applications.js");
      applications = createFacilityApplications({ mount: document.querySelector("main.main-content"), api: ctx.registrationApi, onClose: () => setOrderViewHidden(false) });
    }
    setOrderViewHidden(true);
    await applications.open();
  }

  /** 施設の事前登録を開く(運営者のみ。事前登録・編集・取り消しの権限はサーバーが確認する) */
  async function openPreregistrations() {
    if (!isPlatformAdmin || !ctx || !ctx.registrationApi) return;
    if (settings && settings.isOpen()) settings.close();
    if (orderHistory && orderHistory.isOpen()) orderHistory.close();
    if (applications && applications.isOpen()) applications.close();
    if (!preregistrations) {
      const { createFacilityPreregistrations } = await import("./ui/facility-preregistrations.js");
      preregistrations = createFacilityPreregistrations({ mount: document.querySelector("main.main-content"), api: ctx.registrationApi, onClose: () => setOrderViewHidden(false) });
    }
    setOrderViewHidden(true);
    await preregistrations.open();
  }

  /** 注文履歴を開く(閲覧のみ)。表示するのは選択中の施設の注文だけ。権限は Firestore Rules でも検証される */
  async function openHistory() {
    const access = decideAccess(state);
    if (access.state !== ACCESS.GRANTED) return;
    if (settings && settings.isOpen()) settings.close();
    if (applications && applications.isOpen()) applications.close();
    if (preregistrations && preregistrations.isOpen()) preregistrations.close();
    if (!orderHistory) {
      const { createOrderHistory } = await import("./ui/order-history.js");
      orderHistory = createOrderHistory({
        mount: document.querySelector("main.main-content"),
        repository: ctx.repository,
        onClose: () => setOrderViewHidden(false)
      });
    }
    setOrderViewHidden(true);
    await orderHistory.open({ id: access.facilityId, name: facilityName(access.facilityId) });
  }

  /** 施設設定を開く。表示は管理者・副管理者のみ（書き込みはFirestoreルール・Functionsでも検証される） */
  async function openSettings() {
    const access = decideAccess(state);
    if (access.state !== ACCESS.GRANTED || !isManagerRole(access.role)) return;
    if (!settings) {
      const { createFacilitySettings } = await import("./ui/facility-settings.js");
      settings = createFacilitySettings({
        mount: document.querySelector("main.main-content"),
        repository: ctx.repository,
        settingsApi: ctx.settingsApi,
        masters: IOL_MODELS,
        inviteApi: ctx.registrationApi,
        currentUser: { uid: state.user.uid, displayName: state.user.displayName },
        actorRole: access.role,   // 施設の切り替えはページの再読み込みで行うため、画面の生成時の役割で出し分ける
        onSaved: () => reloadFacilityOptions(),
        onDeleted: () => { selection.clearRemembered(window.localStorage); selection.setForceSelect(window.sessionStorage); location.reload(); },   // 削除後は所属を取得し直し、残りの施設の選択(なければ登録・参加)へ
        onRenamed: (id, name) => { const f = state.facilities.find(x => x.id === id); if (f) f.name = name; render(); },   // ヘッダー・メニューの施設名を更新
        onClose: () => setOrderViewHidden(false)
      });
    }
    if (orderHistory && orderHistory.isOpen()) orderHistory.close();
    if (applications && applications.isOpen()) applications.close();
    if (preregistrations && preregistrations.isOpen()) preregistrations.close();
    setOrderViewHidden(true);
    await settings.open({ id: access.facilityId, name: facilityName(access.facilityId) });
  }

  /** 本人宛ての参加待ち(メール確認済みのアカウントのみ。取得できない場合は表示しないだけで、ログイン・注文は妨げない) */
  async function loadPendingInvites() {
    if (!ctx || !ctx.registrationApi || !state.user || state.user.emailVerified === false) return [];
    try {
      const r = await ctx.registrationApi.listMyPendingMemberships();
      return Array.isArray(r && r.memberships) ? r.memberships : [];
    } catch (e) {
      console.warn("参加待ちを確認できませんでした:", e);
      return [];
    }
  }

  /** 参加確認の「参加する」「参加しない」。承認すると所属を取得し直す。すべて答えたら、通常の施設選択・注文画面へ進む */
  async function respondPending({ pendingId, accept }) {
    if (pendingBusy) return;
    const item = state.pendingInvites.find(p => p.pendingId === pendingId);
    if (!item) return;
    pendingBusy = true; error = ""; notice = "";
    render();
    try {
      await ctx.registrationApi.respondMembership({ pendingId, accept });
      state.pendingInvites = state.pendingInvites.filter(p => p.pendingId !== pendingId);
      if (accept) {
        state.memberships = await ctx.fetchMemberships(state.user.uid);
        await loadFacilities();
        notice = `「${item.facilityName}」に${item.roleLabel || ""}として参加しました。` + (formUid ? "メニューの「施設を切り替える」から移動できます。" : "");
      } else {
        notice = `「${item.facilityName}」への参加を見送りました。`;
      }
    } catch (e) {
      error = describeCallableError(e);
      // 期限切れ・取り消し済みなど、もう参加できないものは一覧から外す
      if (String((e && e.code) || "").endsWith("failed-precondition")) state.pendingInvites = state.pendingInvites.filter(p => p.pendingId !== pendingId);
    }
    pendingBusy = false;
    if (state.pendingInvites.length || formUid) { render(); return; }
    if (await autoSelectFacility()) return;
    await enterFacilityIfGranted();
  }

  /** 所属済みユーザーが、現在の施設・注文画面を保ったまま登録・参加の画面を開く */
  function openOnboarding(mode) {
    if (decideAccess(state).state !== ACCESS.GRANTED) return;
    if (settings && settings.isOpen()) settings.close();
    if (orderHistory && orderHistory.isOpen()) orderHistory.close();
    if (applications && applications.isOpen()) { applications.close(); setOrderViewHidden(false); }
    if (preregistrations && preregistrations.isOpen()) { preregistrations.close(); setOrderViewHidden(false); }
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

  // ヘッダーの施設名: 施設が確定している間だけ、Firestoreの施設データの名称を表示する(固定名・代替名は使わない)
  const headerFacility = document.getElementById("headerFacility");
  const setHeaderFacility = (name) => {
    if (!headerFacility) return;
    const text = typeof name === "string" ? name.trim() : "";
    headerFacility.textContent = text; // textContent: HTMLとして解釈しない
    headerFacility.hidden = !text;
  };

  const render = () => {
    const access = decideAccess(state);
    const current = access.state === ACCESS.GRANTED ? state.facilities.find(f => f.id === access.facilityId) : null;
    setHeaderFacility(current && current.name);
    ui.render({ access, user: state.user, notice, error, facilities: state.facilities, busy, registration, pendingInvites: state.pendingInvites, pendingBusy });
    if (access.state === ACCESS.GRANTED) {
      menu.update({
        user: state.user, facilityName: facilityName(access.facilityId),
        canSwitch: access.memberships.length > 1, canSettings: isManagerRole(access.role), canApprove: canApproveFacilities, canPreregister: isPlatformAdmin
      });
      if ((settings && settings.isOpen()) || (orderHistory && orderHistory.isOpen()) || (applications && applications.isOpen()) || (preregistrations && preregistrations.isOpen())) setOrderViewHidden(true); // 設定・履歴画面の表示中は注文画面を隠したまま
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
    if (!validMemberships(state.memberships).some(m => m.facilityId === facilityId)) return;
    state.selectedFacilityId = facilityId;
    if (remember) selection.remember(window.localStorage, state.user.uid, facilityId);
    notice = ""; error = "";
    await enterFacilityIfGranted();
  }

  async function enterFacilityIfGranted() {
    const access = render();
    if (access.state === ACCESS.GRANTED && !formUid) {
      formUid = state.user.uid;
      loadHeaderTheme(access.facilityId, ctx.repository);   // ヘッダーのテーマカラー(施設ごと。待たずに注文画面を表示する)
      await initOrderForm({
        config,
        orderApi: ctx.orderApi,
        repository: ctx.repository,
        facilityId: access.facilityId,
        facility: { id: access.facilityId, name: facilityName(access.facilityId) },
        user: { uid: state.user.uid, email: state.user.email || "", emailVerified: state.user.emailVerified }
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
    if (validMemberships(state.memberships).some(m => m.facilityId === facilityId)) {
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
      if (validMemberships(state.memberships).some(m => m.facilityId === newFacilityId)) {
        notice = `「${facilityName(newFacilityId)}」を追加しました。メニューの「施設を切り替える」から移動できます。`;
      } else {
        error = "所属の反映を確認できませんでした。ページを再読み込みしてください。";
      }
    }
    render();
  }

  /** 新しい施設の登録を申請する(運営者の承認制。承認されるまで施設は有効にならず、管理者の権限も付かない) */
  async function handleRegister({ name, applicantName, confirmDuplicate }) {
    if (registration.busy) return;
    error = ""; notice = "";
    const invalid = registrationFlow.validateFacilityName(name);
    if (invalid) { error = invalid; render(); return; }
    if (state.user.emailVerified === false) { error = "メールアドレスの確認が済んでいないため、登録できません。"; render(); return; }

    registration.busy = true; render();
    try {
      // 再試行しても同じ要求として扱われるよう、施設名ごとに要求IDを保持する
      const requestId = registrationFlow.getRequestId(window.sessionStorage, name);
      const r = await ctx.registrationApi.registerFacility({ name, requestId, confirmDuplicate, applicantName });
      if (r.status === "duplicate-candidate") {
        registration.duplicate = { ...r, forName: registrationFlow.normalizeFacilityName(name) };
      } else {
        registrationFlow.clearRequestId(window.sessionStorage);
        registration.duplicate = null;
        notice = r.applicationStatus === "pending" || r.applicationStatus === undefined
          ? `「${registrationFlow.normalizeFacilityName(name)}」の登録を申請しました。IOL Order 運営者が確認し、承認されると利用できるようになります(承認後にページを再読み込みしてください)。`
          : `「${registrationFlow.normalizeFacilityName(name)}」の申請は処理済みです。ページを再読み込みしてください。`;
      }
    } catch (e) {
      console.error("施設の登録に失敗しました:", e);
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
    const active = validMemberships(state.memberships);
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
    const active = validMemberships(state.memberships);
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
    await setupAppCheck({ app });   // 監視モード(サイトキー未設定の間は何もしない。src/firebase/app-check.js)
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
      settingsApi: createFirestoreSettingsApi(db, sdk.firestore, { getUid: () => (auth.currentUser ? auth.currentUser.uid : null) }),
      orderApi: createOrderApi({
        functions: sdk.functions.getFunctions(app, "asia-northeast1"),
        httpsCallable: sdk.functions.httpsCallable
      }),
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
      state.pendingInvites = [];
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
        state.pendingInvites = await loadPendingInvites();
        // 施設登録の申請を承認できるか(メニューの表示だけ。権限はサーバーが確認する)
        try { isPlatformAdmin = (await user.getIdTokenResult()).claims.platformAdmin === true; } catch { isPlatformAdmin = false; }
        canApproveFacilities = isPlatformAdmin;   // 施設登録の承認権限(現在は運営者のみ。将来の委任では別に判定する)
        state.membershipsLoaded = true;
        if (state.pendingInvites.length) { render(); return; } // 参加確認を先に表示する(答え終わったら respondPending から先へ進む)
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
  showFatal("画面の読み込みに失敗しました。通信状況を確認して、ページを再読み込みしてください。");
});
