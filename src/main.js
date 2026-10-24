import { loadConfig } from "./config.js";
import { createStaticRepository, DEFAULT_FACILITY_ID } from "./data/static-repository.js";
import { initOrderForm, isOrderFormDirty, reloadFacilityOptions } from "./ui/order-form.js";
import { initBiometry } from "./biometry/biometry-ui.js";
import { biometryState } from "./biometry/state.js";
import { IOL_MODELS } from "./data/iol-models.js";
import { FIREBASE_CONFIG, isFirebaseConfigured } from "./firebase/firebase-config.js";
import { decideAccess, activeMemberships, ACCESS } from "./domain/access.js";
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
        onSaved: () => reloadFacilityOptions(),
        onClose: () => setOrderViewHidden(false)
      });
    }
    setOrderViewHidden(true);
    await settings.open({ id: access.facilityId, name: facilityName(access.facilityId) });
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
    ui.render({ access, user: state.user, notice, error, facilities: state.facilities, busy });
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
      settingsApi: createFirestoreSettingsApi(db, sdk.firestore)
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
