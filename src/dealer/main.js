import { FIREBASE_CONFIG, isFirebaseConfigured } from "../firebase/firebase-config.js";
import { setupAppCheck } from "../firebase/app-check.js";
import { createDealerPortalApi } from "../data/dealer-portal-api.js";
import { dealerEntryUrl, facilityViewKey } from "../domain/dealer-portal.js";
import { createDealerApp } from "./dealer-app.js";
import { createDealerHeaderMenu } from "./dealer-header-menu.js";

/**
 * ディーラー専用画面(dealer.html)の起動。医療機関の画面(index.html)とは別の入口。
 * Firebase のプロジェクトは医療機関の画面と共用するが、ログイン状態は別の名前のアプリで分ける。施設の所属・施設登録の画面には進まない。
 * ログイン(Google・Microsoft・メールリンク)の後は、確認コードで担当者に紐付けた認証主体だけをサーバーが通す(UID・メールの一致だけでは通さない)。
 * メールリンクの戻り先は同じドメインの dealer.html に固定する(任意の URL へは戻さない)。
 */
/**
 * 注文フォームのメニュー(運営者だけに表示)から開いたときだけ、「IOL注文フォームに戻る」を出す(このタブの間は、メールリンクのログインで戻ってきても出す)。
 * 表示だけの判定で、ログイン・閲覧の許可・権限には関係しない(受注はこれまでどおり、ディーラーのログインと施設の許可がある場合だけ)
 */
function showBackToOrder() {
  const KEY = "iolDealerFromOrder";
  let from = false;
  try {
    const url = new URL(location.href);
    if (url.searchParams.get("from") === "order") {
      sessionStorage.setItem(KEY, "1");
      url.searchParams.delete("from");
      history.replaceState(null, "", url.pathname + url.search + url.hash);   // 印だけを外す(メールリンクの値などはそのまま)
    }
    from = sessionStorage.getItem(KEY) === "1";
  } catch { /* 保存できない環境では出さない */ }
  const row = document.getElementById("dealerBackRow");
  if (row) row.hidden = !from;
}

async function bootstrap() {
  showBackToOrder();
  const mount = document.getElementById("dealerMain");
  const subtitle = document.getElementById("dealerCompany");
  // ヘッダー: 受注一覧を開いた後(サーバーが所属を確かめた後)は「受注一覧」と会社名(医療機関の画面の「IOL 注文フォーム」と施設名と同じ形)。
  // ログイン前・本人確認・会社の選択の間は、従来どおり「受注一覧(ディーラー用)」だけ(会社名は出さない)
  const titleEl = document.querySelector(".header-title");
  const defaultTitle = titleEl ? titleEl.textContent : "";
  const setSubtitle = (t) => {
    subtitle.textContent = t || ""; subtitle.hidden = !t;
    if (titleEl) titleEl.textContent = t ? "受注一覧" : defaultTitle;
  };
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
  const signOut = async () => { try { await service.signOut(); } finally { location.reload(); } };   // 表示中のデータもメモリごと破棄する
  // ---------- 使い方・ヘルプ(ディーラー用マニュアル。医療機関の画面と同じ表示の部品。URL のハッシュ #help/… で開く) ----------
  // 表示中は main の他の画面を CSS で隠すだけ(受注一覧・ディーラー設定の状態はそのまま)。担当者は全員、全ページを読める
  let manual = null;
  let signedIn = false;
  const helpBackLabel = () => {
    const view = ui ? ui.currentView() : "other";
    if (view === "settings") return "ディーラー設定に戻る";
    if (view === "portal") return "受注一覧に戻る";
    return signedIn ? "元の画面に戻る" : "ログイン画面に戻る";
  };
  async function syncHelp() {
    const [{ pageIdFromHash, createManualView }, { DEALER_MANUAL_PAGES }] = await Promise.all([import("../ui/manual-view.js"), import("../manual/dealer-manual-pages.js")]);
    const pageId = pageIdFromHash(location.hash, DEALER_MANUAL_PAGES);
    if (pageId === null) { if (manual && manual.isOpen()) manual.close(); return; }
    if (!manual) {
      manual = manual || createManualView({ mount, backLabel: helpBackLabel, onBack: () => closeHelp(), pages: DEALER_MANUAL_PAGES,
        canView: () => true, markTitle: "会社管理者のみ" });
    }
    manual.show(pageId);
  }
  /** ハッシュを外して閉じる(元の画面に戻る) */
  function closeHelp() {
    if (/^#help(?:\/|$)/.test(location.hash)) history.pushState(null, "", location.pathname + location.search);
    if (manual && manual.isOpen()) manual.close();
  }
  const openHelp = () => { if (location.hash === "#help") syncHelp(); else location.hash = "#help"; };   // hashchange で開く
  window.addEventListener("hashchange", () => { syncHelp(); });

  // ヘッダーの「☰」メニュー(医療機関の画面と同じ見た目・動作)。使い方・ヘルプはログイン前から。ほかの項目は受注一覧を開いた後
  let ui = null;
  const menu = createDealerHeaderMenu({
    onSignOut: signOut,
    onSwitchCompany: () => { closeHelp(); if (ui) ui.switchCompany(); },
    onOpenSettings: () => { closeHelp(); if (ui) ui.openSettings(); },
    onOpenHelp: openHelp
  });
  ui = createDealerApp({
    mount, api, setSubtitle, setMenu: (info) => menu.update(info),
    onSignOut: signOut,
    setRememberDevice: (v) => { remember = v !== false; },   // 本人確認の画面の「この端末を記憶する」
    // 医療機関のチェックの記憶(ログインユーザー × 会社ごと。施設 ID だけ。保存できない環境では記憶しない)
    facilityView: {
      load: (companyId) => { try { return uid && storage ? storage.getItem(facilityViewKey(uid, companyId)) : null; } catch (e) { return null; } },
      save: (companyId, ids) => { try { if (uid && storage) storage.setItem(facilityViewKey(uid, companyId), JSON.stringify(ids)); } catch (e) { /* 保存できなくても表示は続ける */ } }
    }
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
    signedIn = true;
    deviceScope = await scopeOf(user);
    await ui.enter();
    if (manual && manual.isOpen()) manual.updateBackLabel();   // ヘルプを開いたままログインした場合の戻り先の文言
  });
  if (/^#help(?:\/|$)/.test(location.hash)) syncHelp();   // #help/… の URL で開いたとき(共有されたリンクなど)
}

bootstrap().catch((e) => {
  console.error("初期化に失敗しました:", e);
  const mount = document.getElementById("dealerMain");
  if (mount) mount.replaceChildren(Object.assign(document.createElement("p"), { className: "error-message", textContent: "画面の読み込みに失敗しました。通信状況を確認して、ページを再読み込みしてください。" }));
});
