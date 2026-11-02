import { h } from "../ui/markdown-view.js";
import { describeCallableError } from "../data/registration-api.js";
import { facilityFilterOf, selectionFor, formatJstDateTime, formatDate, mailStatusText, mailNeedsAttention, jstDate, mondayOf, addDays, weekSpanLabel, spanLabel, isDealerManager, restoreFacilitySelection } from "../domain/dealer-portal.js";
import { historyCardGroups } from "../domain/order-history-view.js";
import { lensDayHead, lensRow } from "../ui/history-lens.js";
import { createDealerManage } from "./dealer-manage.js";
import { createInfoTip } from "../ui/info-tip.js";
import { readHeaderTheme } from "../domain/header-theme.js";
import { applyHeaderTheme } from "../ui/header-theme.js";
import { createThemeColorSection } from "../ui/theme-color-section.js";

/**
 * ディーラー専用画面(dealer.html)。表示する文字はすべて textContent(HTML として解釈しない)。
 * 注文のデータは画面のメモリだけに置き、端末(localStorage など)には保存しない。権限エラー・ログアウトでは表示を破棄する。
 * 端末に記憶するのは医療機関のチェック(表示の絞り込み。施設 ID だけ)。担当施設の登録・閲覧の権限は変えない(担当施設の変更は「ディーラー設定」)。
 * 閲覧の範囲(会社・施設の許可・自社宛ての明細)はサーバーが毎回確認する。画面の施設の選択は検索の絞り込みだけ。
 *
 * @param {object} deps
 * @param {HTMLElement} deps.mount
 * @param {object} deps.api data/dealer-portal-api.js
 * @param {() => void} deps.onSignOut
 * @param {(text:string) => void} [deps.setSubtitle] ヘッダーの会社名
 * @param {(info:null|{name:string, companyName:string, branchName:string, canSwitch:boolean, canSettings:boolean}) => void} [deps.setMenu] ヘッダーの「☰」メニューの項目
 *   (受注一覧・試験モードの間は氏名・所属会社など。ほかの画面は null = 使い方・ヘルプだけで、ログアウトはカードのボタン)
 * @param {{ load:(companyId:string)=>string|null, save:(companyId:string, ids:string[])=>void }} [deps.facilityView] 医療機関のチェックの記憶
 */
/** 注文日順の1回の取得件数(医療機関側の注文履歴と同じ20件。「もっと見る」で続き) */
const LIST_PAGE = 20;
/** 手術日順の「もっと見る」1回で探す週の数(手術予定のない週を飛ばしながら。見つからなくても、もう一度押せばさらに先を探せる) */
const SCAN_WEEKS = 4;
/** 手術日順の初期表示で読む週の数(今週・翌週・翌々週。並行して読むので、1週分とほぼ同じ待ち時間) */
const INITIAL_WEEKS = 3;
/** 一覧の明細(サーバーの自社宛ての明細)→ 共通のレンズ行の形。トーリックはトーリック型番をモデルとして出す */
const lensOf = (l) => ({ lineNo: l.no, surgeryDate: l.surgeryDate || "", model: l.toricModel || l.model, power: l.power, quantity: l.quantity, doctorName: l.doctorName || "" });
const doctorOf = (l) => (l.doctorName ? `${l.doctorName}Dr` : "担当医の記録なし");

export function createDealerApp({ mount, api, onSignOut, setSubtitle = () => {}, setRememberDevice = () => {}, setMenu = () => {}, facilityView = { load: () => null, save: () => {} } }) {
  let ctx = null;          // getContext の結果(会社・施設の候補・初期選択)
  let selected = new Set();
  let lastQuery = null, cursor = null, items = [], busy = false;
  let gen = 0;             // 検索の世代。条件を変えたら進め、古い条件の応答・続きを新しい条件に混ぜない
  let choices = [];        // 本人の有効な所属会社(2社以上なら会社を選ぶ)

  const panel = h("section", { class: "feature-card dealer-panel", id: "dealerPanel" });
  mount.replaceChildren(panel);

  // ---------- ディーラー設定(会社管理者・支店管理者。☰メニューから開く) ----------
  // 施設設定と同じ見出しの行(.settings-head: 見出し・ⓘ・戻るボタン)。開いている間は受注一覧のカードを隠すだけで、
  // 戻ると選択・表示中の週や一覧はそのまま。中身は既存の担当者・支店の管理(dealer-manage.js)。受注一覧を開き直すたびに作り直す
  let settingsView = null;
  function dropSettings() {
    if (settingsView) settingsView.remove();
    settingsView = null;
    panel.hidden = false;
  }
  function closeSettings() {
    if (settingsView) settingsView.hidden = true;
    panel.hidden = false;
    window.scrollTo(0, 0);
  }
  function openSettings() {
    if (!ctx || ctx.testMode || !isDealerManager(ctx.me.role)) return;   // 閲覧者は開けない(表示だけの判定。操作の可否はサーバーが確認する)
    if (!settingsView) {
      const manage = createDealerManage({ api, companyId: ctx.company.id, onAuthError: manageAuthError });
      const back = h("button", { type: "button", class: "btn btn-secondary", id: "btnDealerSettingsClose" }, "受注一覧に戻る");
      back.addEventListener("click", closeSettings);
      const help = ctx.me.role === "companyAdmin"
        ? "自社の担当者・支店を管理します。この画面は会社管理者・支店管理者だけが利用できます。注文を閲覧できる範囲は会社単位で、ここでの設定では変わりません。"
        : "自分の支店の担当者を管理します。この画面は会社管理者・支店管理者だけが利用できます。注文を閲覧できる範囲は会社単位で、ここでの設定では変わりません。";
      // テーマカラー(会社で共通。会社管理者だけに出す。保存はサーバーが会社管理者か確かめる)。施設設定と同じ部品・操作
      const c = ctx, companyId = ctx.company.id;
      const theme = ctx.me.role === "companyAdmin" ? createThemeColorSection({
        description: "画面上部(ヘッダー)の色を会社で共通に設定できます。すべての担当者の画面に反映されます。選ぶとすぐにヘッダーに反映され、自動で保存されます。明るい色には「フォントを黒にする」がおすすめです。この項目は会社管理者のみ変更できます。",
        get: () => c.headerTheme || null,
        use: (t) => { c.headerTheme = t; if (ctx === c) applyHeaderTheme(t); },
        save: async (t) => { if (t) await api.setTheme({ companyId, ...t }); else await api.resetTheme({ companyId }); }
      }) : null;
      settingsView = h("section", { class: "feature-card dealer-panel dealer-settings", id: "dealerSettings", hidden: true },
        h("div", { class: "settings-head" },
          h("div", { class: "settings-heading" }, h("h2", {}, "ディーラー設定"), createInfoTip(help, { label: "ディーラー設定の説明" }).root),
          h("span", { class: "settings-facility" }), back),
        manage.root,
        theme ? theme.section : null);
      mount.append(settingsView);
      if (theme) theme.section._render();
      manage.load();
    }
    panel.hidden = true;
    settingsView.hidden = false;
    window.scrollTo(0, 0);
  }

  const signOutBtn = () => {
    const b = h("button", { type: "button", class: "btn btn-secondary", "data-act": "signout" }, "ログアウト");
    b.addEventListener("click", () => onSignOut());
    return b;
  };
  /** 表示中のデータを破棄して案内だけを出す */
  function showMessage(title, text, { error = false, withSignOut = true } = {}) {
    ctx = null; items = []; cursor = null; lastQuery = null; setSubtitle(""); setMenu(null); dropSettings(); applyHeaderTheme(null);
    panel.replaceChildren(...[h("div", { class: "feature-title-row" }, h("span", { class: "feature-title" }, title)),
      h("p", { class: error ? "error-message" : "feature-desc", role: error ? "alert" : "status" }, text),
      withSignOut ? h("div", { class: "onboarding-actions" }, signOutBtn()) : null].filter(Boolean));
  }

  // ---------- ログイン(Google・Microsoft / メールリンク) ----------
  /** ログインの失敗を利用者向けの文言に(Firebase Auth のエラーコード) */
  function describeLoginError(e, mode) {
    const code = String((e && e.code) || "");
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request" || code === "auth/user-cancelled") return "ログインがキャンセルされました。";
    if (code === "auth/popup-blocked") return "ポップアップがブロックされました。ブラウザでポップアップを許可するか、下のメールアドレスでのログインをお使いください。";
    if (code === "auth/account-exists-with-different-credential") return "このメールアドレスは別のログイン方法で登録されています。メールアドレスでのログインをお試しください。";
    if (code === "auth/network-request-failed") return "通信に失敗しました。通信状況を確認して、もう一度お試しください。";
    if (code === "auth/operation-not-allowed") return "このログイン方法は現在利用できません。メールアドレスでログインしてください。";
    const PROVIDER = { google: "Google", microsoft: "Microsoft" };
    if (code.startsWith("auth/")) return PROVIDER[mode] ? `${PROVIDER[mode]}でのログインに失敗しました。もう一度お試しいただくか、メールアドレスでログインしてください。` : "ログインリンクを送信できませんでした。メールアドレスを確認してください。";
    if (e && /メールアドレスを入力/.test(String(e.message))) return e.message;
    return describeCallableError(e);
  }

  /**
   * ログイン画面。上段に「Googleでログイン」「Microsoftでログイン」(横に並べる。スマホ幅では縦)、下段にメールリンク(パスワード不要)。
   * どれでも、招待された勤務先メールアドレスのアカウントでログインする(所属・閲覧の範囲はサーバーが確認する)。
   * 初めて使うログイン方法(参加を含む)・新しい端末(ブラウザ)は、どの方式でも、メールに届く確認コードで本人確認してから使える。
   */
  function showLogin({ notice = "", error = "", onGoogle = null, onMicrosoft = null, onSend }) {
    setMenu(null); dropSettings(); applyHeaderTheme(null);   // ログイン前・本人確認・会社の選択の間は標準の青(会社のテーマは出さない)
    const google = onGoogle ? h("button", { type: "button", class: "btn btn-primary dealer-login-google", id: "btnDealerGoogle" }, "Googleでログイン") : null;
    const microsoft = onMicrosoft ? h("button", { type: "button", class: "btn btn-primary dealer-login-microsoft", id: "btnDealerMicrosoft" }, "Microsoftでログイン") : null;
    const providers = google || microsoft;
    const email = h("input", { class: "form-control", type: "email", id: "dealerEmail", autocomplete: "email", "aria-label": "勤務先メールアドレス", maxlength: "254" });
    const send = h("button", { type: "button", class: providers ? "btn btn-secondary" : "btn btn-primary", id: "btnDealerSendLink" }, "ログインリンクを送信");
    const msg = h("p", { class: notice ? "form-hint" : "error-message", role: "status" }, notice || error);
    const busy = (v) => { send.disabled = v; if (google) google.disabled = v; if (microsoft) microsoft.disabled = v; };
    const signIn = (btn, fn, mode) => btn && btn.addEventListener("click", async () => {
      busy(true); msg.className = "form-hint"; msg.textContent = "";
      try { await fn(); }   // 成功すると認証状態の変化で画面が切り替わる
      catch (e) { msg.className = "error-message"; msg.textContent = describeLoginError(e, mode); }
      finally { busy(false); }
    });
    signIn(google, onGoogle, "google");
    signIn(microsoft, onMicrosoft, "microsoft");
    send.addEventListener("click", async () => {
      busy(true); msg.className = "form-hint"; msg.textContent = "";
      try { await onSend(email.value); msg.className = "form-hint"; msg.textContent = "ログインリンクを送信しました。メール内のリンクをこの端末で開いてください。"; }
      catch (e) { msg.className = "error-message"; msg.textContent = describeLoginError(e, "email"); }
      finally { busy(false); }
    });
    // 説明は見出し・各ログイン方法の見出しの右のⓘ(共通の info-tip。常時は 見出し・ボタン・入力欄 だけを表示し、スマホで縦に長くしない)。
    // メールの見出しは入力欄の <label> のまま、ⓘ はその外に並べる(ⓘ を押しても入力欄に移らない)
    const tip = (text, label) => createInfoTip(text, { label }).root;
    panel.replaceChildren(...[
      h("div", { class: "feature-title-row" }, h("span", { class: "feature-title" }, "ディーラー用 受注一覧"),
        tip("医療機関から閲覧を許可された、自社宛ての注文を確認する画面です。招待された勤務先メールアドレスのアカウントでログインしてください。", "この画面の説明")),
      providers ? h("div", { class: "dealer-login-block", "data-login": "accounts" },
        h("div", { class: "form-label dealer-login-head" }, h("span", {}, "会社のアカウントでログイン(推奨)"),
          tip("招待されたメールアドレスの Google アカウント(Google Workspace など)または Microsoft アカウント(Microsoft 365 など)でログインできます。ほかのメールアドレスのアカウントは使えません。初めて使うときと、新しい端末(ブラウザ)では、招待されたメールアドレスに届く確認コードで本人確認をします。", "会社のアカウントでのログインの説明")),
        h("div", { class: "dealer-login-providers" }, google, microsoft)) : null,
      h("div", { class: "dealer-login-block", "data-login": "email" },
        h("div", { class: "form-label dealer-login-head" }, h("label", { for: "dealerEmail" }, providers ? "メールアドレスでログイン(パスワード不要)" : "勤務先メールアドレス"),
          tip("招待された勤務先メールアドレスを入力すると、ログイン用のリンクが届きます。", "メールアドレスでのログインの説明")),
        email,
        h("div", { class: "onboarding-actions" }, send)),
      msg].filter(Boolean));
  }

  // ---------- 本人確認 ----------
  /**
   * 本人確認(参加・初めてのログイン方法・新しい端末で共通): ログインのメールアドレス(=承認済みのメール。サーバーが確定する)に
   * 確認コードを送り、届いた8桁のコードで確認する。確認できると、参加の案内を承諾し、今回のログイン方法を担当者に紐付ける。
   * 会社名は確認コードのメールに書く(画面には出さない。メールを受け取れることを確かめるまで、会社の情報を出さない)。
   * @param {{onLater?: () => void}} [opts] onLater: すでに使える会社があるとき、新しい参加の案内を後回しにする
   */
  function showVerify({ onLater = null } = {}) {
    ctx = null; items = []; cursor = null; lastQuery = null; setSubtitle(""); setMenu(null); dropSettings(); applyHeaderTheme(null);
    const send = h("button", { type: "button", class: "btn btn-secondary", "data-act": "sendCode" }, "確認コードを送る");
    const code = h("input", { class: "form-control dealer-join-code", type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "12", "aria-label": "確認コード(8桁)", placeholder: "8桁の確認コード", "data-f": "code" });
    const verify = h("button", { type: "button", class: "btn btn-primary", "data-act": "verifyCode" }, "確認する");
    const note = h("p", { class: "form-hint", role: "status" });
    const rememberBox = h("input", { type: "checkbox", "data-f": "remember" });
    rememberBox.checked = true;
    // この行専用の並び(共通の .settings-check は1行固定のため使わない): チェックボックスは左に固定、文は右で折り返す。文全体のタップで切り替わる(label で包む)
    const remember = h("label", { class: "dealer-remember" }, rememberBox, h("span", { class: "dealer-remember-text" }, "この端末(ブラウザ)を記憶する(共用のパソコンでは外してください。外すと、次のログインでも確認コードが必要です)"));
    // 送った後に出す入力の段(縦積み: 入力欄 → 確認する → 端末の記憶)。説明は見出しのⓘに置き、常時表示は操作に必要なものだけ
    const codeRow = h("div", { class: "dealer-verify-step dealer-join-row", hidden: true }, code, verify, remember);
    const lock = (v) => { send.disabled = verify.disabled = v; };
    send.addEventListener("click", async () => {
      lock(true); note.className = "form-hint"; note.textContent = "";
      try {
        const r = await api.sendCode();
        codeRow.hidden = false;
        // 登録の有無で応答を変えない(未招待には送らない)。届かない場合の案内はⓘ
        note.textContent = `確認コードを送りました(${(r && r.expiresInMinutes) || 10}分間有効)。メールに書かれた会社名を確かめてから入力してください。`;
        code.focus();
      } catch (e) { note.className = "error-message"; note.textContent = describeCallableError(e); }
      finally { lock(false); }
    });
    verify.addEventListener("click", async () => {
      const value = code.value.replace(/\s/g, "");
      if (!/^\d{8}$/.test(value)) { note.className = "error-message"; note.textContent = "メールに届いた8桁の確認コードを入力してください。"; return; }
      lock(true); note.className = "form-hint"; note.textContent = "";
      try { setRememberDevice(rememberBox.checked); const r = await api.verifyCode({ code: value }); deviceNotSaved = rememberBox.checked && r && r.deviceSaved === false; await enter(); }
      catch (e) { note.className = "error-message"; note.textContent = describeCallableError(e); lock(false); }
    });
    const later = onLater ? h("button", { type: "button", class: "btn btn-secondary", "data-act": "later" }, "あとで(受注一覧へ)") : null;
    if (later) later.addEventListener("click", onLater);
    // 説明は共通のⓘ(タップで開く)。常時表示は見出し・送るボタン・入力欄・確認ボタン・端末の記憶・ログアウトだけ
    const help = [onLater
      ? "新しい会社から、ディーラー画面への参加の案内が届いています。本人の確認のため、ログインしたメールアドレスに確認コードを送ります。コードを入力すると参加できます。"
      : "本人の確認のため、ログインしたメールアドレスに確認コードを送ります。コードを入力すると、受注一覧を表示できます(初めて使うログイン方法・新しい端末(ブラウザ)で必要です)。招待されたメールアドレス以外のアカウントでは使えません。",
      "確認コードは、ログインしたメールアドレスが登録されている場合に送ります(届くまで少し時間がかかることがあります)。メールに書かれた会社名を確かめてから、コードを入力してください。届かない場合は、招待されたメールアドレスのアカウントでログインしているか確かめてください。"
    ].join("\n");
    panel.replaceChildren(...[h("div", { class: "feature-title-row dealer-login-head dealer-verify-title" },
        h("span", { class: "feature-title" }, onLater ? "参加の確認" : "本人確認"), createInfoTip(help, { label: `${onLater ? "参加の確認" : "本人確認"}の説明` }).root),
      h("div", { class: "dealer-verify-step" }, send), codeRow, note,
      h("div", { class: "onboarding-actions dealer-verify-actions" }, ...[later, signOutBtn()].filter(Boolean))].filter(Boolean));
  }

  // ---------- 受注一覧 ----------
  /**
   * 運営者の試験モード(機能の停止中。サーバーが試験の UID・期限・有効な運営者を確かめたときだけ context が testMode を返す)。
   * 受注一覧・医療機関の選択は出さず、会社管理者・支店管理者には担当者の管理だけを出す(注文の閲覧はサーバーでも停止)
   */
  async function showTestMode() {
    const manage = isDealerManager(ctx.me.role) ? createDealerManage({ api, companyId: ctx.company.id, onAuthError: manageAuthError }) : null;
    panel.replaceChildren(...[
      h("div", { class: "feature-title-row dealer-title-row" }, h("span", { class: "feature-title" }, "試験モード")),
      h("p", { class: "form-hint", "data-notice": "test-mode" }, "運営者の試験モードです(ディーラー画面は停止中)。ログイン・参加・担当者の管理だけを確認できます。受注一覧と医療機関の閲覧の許可は停止しています。"),
      deviceNotSaved ? h("p", { class: "form-hint", "data-notice": "device-not-saved" }, "このブラウザには確認の記録を保存できませんでした。この画面を閉じると、次のログインでも確認コードが必要です。") : null,
      manage ? manage.root : null].filter(Boolean));
    if (manage) await manage.load();
  }
  const manageAuthError = (e) => { if (String((e && e.code) || "").endsWith("permission-denied") && e.details && e.details.reason === "verification-required") showMessage("ディーラー画面", describeCallableError(e), { error: true }); };

  async function showPortal(context) {
    ctx = context;
    selected = new Set();
    dropSettings();
    setSubtitle(ctx.company.name);
    // 会社のテーマカラー(サーバーが所属を確かめた context の値。未設定は標準の青)。端末には覚えない(確認前に会社の色を出さない)
    ctx.headerTheme = readHeaderTheme(ctx.headerTheme);
    applyHeaderTheme(ctx.headerTheme);
    // 氏名・所属会社・ディーラー設定(会社管理者・支店管理者)・会社の切り替え・ログアウトはヘッダーの「☰」メニュー(サーバーが確かめた context の値)
    setMenu({ name: ctx.me.name || "", companyName: ctx.company.name, branchName: ctx.me.branch ? ctx.me.branch.name : "",
      canSwitch: choices.length > 1, canSettings: !ctx.testMode && isDealerManager(ctx.me.role) });
    if (ctx.testMode) return showTestMode();
    // 医療機関のチェック: 端末に記憶した選択(今の閲覧可能な施設だけ)。未保存ならサーバーの初期選択(担当施設 → 全施設)
    const restored = restoreFacilitySelection(facilityView.load(ctx.company.id), ctx.facilities || [], ctx.selectedFacilityIds || []);
    selected = new Set(restored.ids);
    const remember = () => facilityView.save(ctx.company.id, [...selected]);   // 担当施設の登録(setAssignments)は呼ばない
    // 一覧表示の絞り込み(任意。既定は期間なし = 全期間を新しい順)
    const from = h("input", { class: "form-control", type: "date", id: "dealerFrom", "aria-label": "注文日(から)" });
    const to = h("input", { class: "form-control", type: "date", id: "dealerTo", "aria-label": "注文日(まで)" });
    const number = h("input", { class: "form-control", type: "text", id: "dealerOrderNumber", maxlength: "40", placeholder: "例: IOL-20261027-01", "aria-label": "注文番号(完全一致)", autocomplete: "off" });
    const checks = h("div", { class: "dealer-facility-list", role: "group", "aria-label": "医療機関" });
    const selectBar = h("div", { class: "dealer-select-actions", role: "group", "aria-label": "医療機関の選択" });
    const renderChecks = () => {
      const many = ctx.facilities.length > 1;
      const anyAssigned = ctx.facilities.some(f => f.assigned);
      selectBar.hidden = !many;
      selectBar.replaceChildren(...(many ? [anyAssigned ? selBtn("assigned", "担当施設のみ") : null, selBtn("all", "すべて選択"), selBtn("none", "すべて解除")].filter(Boolean) : []));
      checks.replaceChildren(...(ctx.facilities.length ? ctx.facilities.map(f => {
        const cb = h("input", { type: "checkbox", value: f.id, "data-facility": f.id });
        cb.checked = selected.has(f.id);
        cb.addEventListener("change", () => { if (cb.checked) selected.add(f.id); else selected.delete(f.id); remember(); facilitiesChanged(); });
        return h("label", { class: "settings-check dealer-facility" }, cb, h("span", {}, f.name), f.assigned ? h("span", { class: "member-role-badge" }, "担当") : null);
      }) : [h("p", { class: "form-hint" }, "閲覧を許可している医療機関はまだありません。")]));
    };
    const selBtn = (kind, label) => {
      const b = h("button", { type: "button", class: "btn btn-outline-sm", "data-select": kind }, label);
      b.addEventListener("click", () => { selected = new Set(selectionFor(kind, ctx.facilities)); renderChecks(); remember(); facilitiesChanged(); });
      return b;
    };
    const search = h("button", { type: "button", class: "btn btn-primary", id: "btnDealerSearch" }, "この条件で表示");
    const clear = h("button", { type: "button", class: "btn btn-secondary", id: "btnDealerClear" }, "条件をクリア");
    const listBox = h("div", { class: "dealer-results", id: "dealerResults" });
    const more = h("button", { type: "button", class: "btn btn-secondary history-more", id: "btnDealerMore", hidden: true }, "もっと見る");
    // 件数・状態(一覧の直前に控えめに表示)
    const listMsg = h("p", { class: "form-hint dealer-list-count", role: "status", id: "dealerListMsg" });
    // 「絞り込み」の右のⓘ: 絞り込みの使い方と、検索時点・反映の時間差の説明(検索時点の日時は常時表示しない)
    const filterTip = createInfoTip([
      "期間(開始日と終了日)と注文番号で絞り込めます。指定しない場合は、全期間を注文日時の新しい順に表示します。",
      "一覧は「この条件で表示」を押した時点(検索時点)の内容です。「もっと見る」の続きも同じ時点の内容で表示します。",
      "注文メールとは別に反映されるため、新しい注文が一覧に出るまで少し時間がかかることがあります。"
    ].join("\n"), { label: "絞り込みと検索時点の説明" }).root;
    filterTip.addEventListener("click", (e) => e.preventDefault(), true);   // ⓘの操作で絞り込みを開閉しない(summary の中のため)
    const detail = h("div", { class: "dealer-detail", id: "dealerDetail", hidden: true });
    const searchArea = h("div", { class: "dealer-search-area" });

    // ---- 並び順の切り替え: 注文日順(1注文1カード・新しい順)/ 手術日順(手術日の早い順に連続。週の区切り → 手術日 → 医療機関 → レンズ) ----
    // 医療機関側の注文履歴と同じ見た目(history-lens.js・.history-card など)。初期表示は手術日順(今週の月曜から)
    let view = "surgery";
    const surgeryArea = h("div", { class: "dealer-surgery-area", id: "dealerSurgeryArea" });
    const orderedArea = h("div", { class: "dealer-ordered-area", id: "dealerOrderedArea", hidden: true });
    const viewBtn = (v, label) => {
      const b = h("button", { type: "button", class: "history-sort-btn", "data-view": v, "aria-pressed": String(view === v) }, label);
      b.addEventListener("click", () => setView(v));
      return b;
    };
    const viewBar = h("div", { class: "history-sort dealer-view", role: "group", "aria-label": "並び順" }, viewBtn("ordered", "注文日順"), viewBtn("surgery", "手術日順"));
    function setView(v) {
      if (view === v) return;
      view = v;
      viewBar.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === v)));
      surgeryArea.hidden = v !== "surgery"; orderedArea.hidden = v !== "ordered";
      if (v === "surgery") resetSurgery();
      else if (!lastQuery && !items.length && ctx.facilities.length) run(false);   // 注文日順を初めて開いたら、最新の20件を読む
    }
    function facilitiesChanged() { if (view === "surgery") resetSurgery(); else invalidate(); }

    // ---- 手術日順: 週ごとに listWeek を読む(今週から。下は先の週、上は前の週。週は重ならないので境目で重複・欠落しない) ----
    let weeks = [];                    // 読み込んだ週(早い順) { weekStart, weekEnd, days, truncated }
    let nextWeek = null, prevWeek = null;   // 次に読む週の月曜(下・上)
    let surgeryGen = 0, loadingDown = false, loadingUp = false;
    let downNote = "", upNote = "";    // 探した週に予定がなかったときの案内
    const surgeryMsg = h("p", { class: "form-hint", role: "status", id: "dealerSurgeryMsg" });
    const surgeryBox = h("div", { class: "dealer-surgery", id: "dealerSurgery" });
    surgeryArea.append(surgeryMsg, surgeryBox);
    const hasData = (w) => w.days.some(d => d.orders.length);

    function resetSurgery() {
      surgeryGen++;
      weeks = []; downNote = ""; upNote = ""; loadingDown = loadingUp = false;
      nextWeek = mondayOf(jstDate(Date.now()));   // 今週(日本時間の月曜〜日曜)から
      prevWeek = addDays(nextWeek, -7);
      renderSurgery();
      if (ctx.facilities.length) loadWeeks("down", { keepPosition: false, initial: true });
    }

    /**
     * 週を読む(下 = 先の週 / 上 = 前の週)。1回で最大 SCAN_WEEKS 週。手術予定のある週が見つかったら止める。
     * 初期表示(initial)は今週から INITIAL_WEEKS 週を並行して読み、予定のない週があってもそのまま並べる(続きは「もっと見る」)。
     * 上に足したときは、見ているカードの位置を保つ(足す前の位置を覚えて戻す)。認可・自社宛て・取消/削除の除外はサーバー
     */
    async function loadWeeks(dir, { keepPosition = dir === "up", initial = false } = {}) {
      if (dir === "down" ? loadingDown : loadingUp) return;
      const my = surgeryGen;
      if (dir === "down") loadingDown = true; else loadingUp = true;
      renderSurgery();
      const got = [];
      try {
        if (initial) {
          const starts = Array.from({ length: INITIAL_WEEKS }, (_, i) => addDays(nextWeek, i * 7));
          const rs = await Promise.all(starts.map(weekStart => api.listWeek({ companyId: ctx.company.id, weekStart, facilityFilter: facilityFilterOf([...selected]) })));
          if (my !== surgeryGen) return;   // 施設・並び順を変えた後に届いた古い結果は表示しない
          got.push(...rs);   // 週の早い順(読んだ順に関係なく starts の順)
          nextWeek = addDays(starts[starts.length - 1], 7);
        }
        for (let i = 0; !initial && i < SCAN_WEEKS; i++) {
          const weekStart = dir === "down" ? nextWeek : prevWeek;
          const r = await api.listWeek({ companyId: ctx.company.id, weekStart, facilityFilter: facilityFilterOf([...selected]) });
          if (my !== surgeryGen) return;   // 施設・並び順を変えた後に届いた古い結果は表示しない
          got.push(r);
          if (dir === "down") nextWeek = addDays(weekStart, 7); else prevWeek = addDays(weekStart, -7);
          if (hasData(r)) break;
        }
        const span = got.length ? spanLabel(dir === "down" ? got[0].weekStart : got[got.length - 1].weekStart, dir === "down" ? got[got.length - 1].weekEnd : got[0].weekEnd) : "";
        const note = got.length && !got.some(hasData) ? `${span}に手術予定の受注はありません。${dir === "down" ? "「もっと見る」" : "「過去の注文をもっと見る」"}で、さらに${dir === "down" ? "先" : "前"}を探せます。` : "";
        if (dir === "down") { weeks = [...weeks, ...got]; downNote = note; } else { weeks = [...got.reverse(), ...weeks]; upNote = note; }
        surgeryMsg.textContent = "";
      } catch (e) {
        if (my !== surgeryGen) return;
        surgeryMsg.textContent = describeCallableError(e);
        if (String((e && e.code) || "").endsWith("permission-denied")) showMessage("ディーラー画面", describeCallableError(e), { error: true });
      } finally {
        if (my === surgeryGen) {
          if (dir === "down") loadingDown = false; else loadingUp = false;
          const restore = keepPosition ? keepScrollAnchor(surgeryBox) : () => {};
          renderSurgery();
          restore();
        }
      }
    }

    /** 手術日順の表示: 週の区切り(件数が多い週は一部だけと明示) → 手術日 → 医療機関 → レンズ行(押すと受注詳細)。予定のない週が続く所は1行にまとめる */
    function renderSurgery() {
      if (!ctx.facilities.length) { surgeryBox.replaceChildren(); return; }
      const rows = [];
      for (let i = 0; i < weeks.length; i++) {
        const w = weeks[i];
        if (!hasData(w)) {
          let j = i;
          while (j + 1 < weeks.length && !hasData(weeks[j + 1])) j++;
          rows.push(h("li", { class: "dealer-week-empty", "data-week": w.weekStart }, `${j === i ? weekSpanLabel(w.weekStart) : `${spanLabel(w.weekStart, weeks[j].weekEnd)}`}: 手術予定の受注はありません`));
          i = j;
          continue;
        }
        rows.push(h("li", { class: "dealer-week-head", "data-week": w.weekStart }, h("span", {}, weekSpanLabel(w.weekStart)),
          w.truncated ? h("span", { class: "dealer-week-truncated", role: "alert" }, "この週は件数が多いため、一部だけを表示しています。医療機関を絞り込んでください。") : null));
        for (const d of w.days.filter(x => x.orders.length)) {
          // 同じ手術日の中は医療機関ごと(サーバーが医療機関名・注文日時の順に並べている)
          const byFacility = [];
          for (const o of d.orders) {
            const last = byFacility[byFacility.length - 1];
            if (last && last.facilityId === o.facilityId) last.orders.push(o); else byFacility.push({ facilityId: o.facilityId, facilityName: o.facilityName, orders: [o] });
          }
          rows.push(h("li", { class: "history-day", "data-day": d.date }, lensDayHead(d.date),
            ...byFacility.map(g => h("div", { class: "dealer-day-facility", "data-facility-group": g.facilityId },
              h("div", { class: "dealer-day-facility-name" }, g.facilityName),
              h("ul", { class: "history-day-lines" }, g.orders.flatMap(o => o.lines.map(l => {
                const b = h("button", { type: "button", class: "history-row history-lens-btn", "data-receipt": o.receiptId, "data-date": d.date, "data-line": String(l.no) },
                  lensRow("div", lensOf(l), { doctor: doctorOf(l) }));
                b.addEventListener("click", () => openDetail(o.receiptId));
                return h("li", {}, b);
              })))))));
        }
      }
      const up = weeks.length || loadingUp ? h("button", { type: "button", class: "btn btn-secondary history-more history-more-past", "data-act": "more-past", disabled: loadingUp }, loadingUp ? "読み込み中…" : "過去の注文をもっと見る") : null;
      if (up) up.addEventListener("click", () => loadWeeks("up"));
      const down = weeks.length || !loadingDown ? h("button", { type: "button", class: "btn btn-secondary history-more", "data-act": "more", disabled: loadingDown }, loadingDown ? "読み込み中…" : "もっと見る") : null;
      if (down) down.addEventListener("click", () => loadWeeks("down"));
      surgeryBox.replaceChildren(...[up, upNote ? h("p", { class: "form-hint dealer-surgery-note", "data-note": "up" }, upNote) : null,
        rows.length ? h("ul", { class: "history-list dealer-surgery-list" }, rows) : (loadingDown ? h("p", { class: "form-hint" }, "読み込み中…") : null),
        downNote ? h("p", { class: "form-hint dealer-surgery-note", "data-note": "down" }, downNote) : null, down].filter(Boolean));
    }

    /** 上に行を足す前に、画面に見えている先頭の行(レンズ行・週の区切り)の位置を覚え、描き直した後に同じ位置へ戻す関数を返す */
    function keepScrollAnchor(box) {
      const hd = document.querySelector(".app-header");
      const top0 = hd && getComputedStyle(hd).position === "sticky" ? Math.max(0, hd.getBoundingClientRect().bottom) : 0;
      const key = (e) => e.dataset.week ? `w:${e.dataset.week}` : `${e.dataset.receipt}@${e.dataset.date}#${e.dataset.line}`;
      const all = () => [...box.querySelectorAll(".history-lens-btn, .dealer-week-head, .dealer-week-empty")];
      const a = all().find(e => e.getBoundingClientRect().bottom > top0);
      if (!a) return () => {};
      const k = key(a), before = a.getBoundingClientRect().top;
      return () => { const b = all().find(e => key(e) === k); if (b) window.scrollBy(0, b.getBoundingClientRect().top - before); };
    }

    /** 検索条件(施設・期間・注文番号)を変えたら、表示中の結果と続きを破棄する。「さらに表示」で古い条件の続きを読まない */
    const CHANGED = "条件を変更しました。「この条件で表示」を押すと、新しい条件で表示します。";
    function invalidate() {
      gen++;
      if (!lastQuery && !items.length && !cursor) return;
      lastQuery = null; cursor = null; items = [];
      renderList();
      listMsg.textContent = CHANGED;
    }
    for (const el of [from, to, number]) { el.addEventListener("input", invalidate); el.addEventListener("change", invalidate); }

    const run = async (append) => {
      if (busy) return;
      if (append && (!lastQuery || !cursor)) return;
      const my = append ? gen : ++gen;
      busy = true; listMsg.textContent = "読み込み中…"; search.disabled = more.disabled = true;
      try {
        if (!append) {
          // 期間は両方を指定したときだけ送る(なければ全期間)。片方だけは送らずに案内する
          if (Boolean(from.value) !== Boolean(to.value)) { listMsg.textContent = "期間は開始日と終了日の両方を指定してください(期間を指定しない場合は両方を空にします)。"; return; }
          lastQuery = { companyId: ctx.company.id, ...(from.value && to.value ? { from: from.value, to: to.value } : {}), facilityFilter: facilityFilterOf([...selected]),
            ...(number.value.trim() ? { orderNumber: number.value.trim() } : {}), limit: LIST_PAGE };
          cursor = null; items = [];
        }
        const r = await api.listOrders({ ...lastQuery, ...(append && cursor ? { cursor } : {}) });
        if (my !== gen) { listMsg.textContent = CHANGED; return; }   // 通信中に条件が変わった: 古い条件の結果は表示しない
        if (r.restart) {
          // 検索の途中で、読み終えた範囲に新しい注文の索引が反映された。続きからでは欠けるため、先頭からの再検索を求める
          cursor = null; renderList();
          listMsg.textContent = "検索の途中で新しい注文が反映されました。「この条件で表示」を押して、先頭から表示し直してください。";
          return;
        }
        items = append ? [...items, ...r.items] : r.items;
        cursor = r.nextCursor || null;
        renderList();
        listMsg.textContent = items.length ? `${items.length}件${cursor ? "(続きがあります)" : ""}`
          : cursor ? "ここまでに該当する注文は見つかりませんでした。「もっと見る」で続きを検索できます。" : "該当する注文はありません。";
        // 続きのページも、最初のページを読んだ時点(検索時点)の内容で表示する(サーバーがカーソルで固定)。その後に反映された注文は再検索で表示
        if (r.newSinceSearch) listMsg.textContent += " 表示の後に反映された注文があります。「この条件で表示」を押すと最新の内容を表示します。";
      } catch (e) {
        if (my !== gen) { listMsg.textContent = CHANGED; return; }
        items = []; cursor = null; renderList();
        listMsg.textContent = describeCallableError(e);
        if (String((e && e.code) || "").endsWith("permission-denied")) showMessage("ディーラー画面", describeCallableError(e), { error: true });
      } finally { busy = false; search.disabled = more.disabled = false; }
    };
    search.addEventListener("click", () => run(false));
    clear.addEventListener("click", () => { from.value = ""; to.value = ""; number.value = ""; run(false); });
    more.addEventListener("click", () => run(true));

    /** 注文日順: 1注文1カード(押すと受注詳細)。先頭に注文番号・医療機関名、その下に手術日ごとのレンズ行を最大5行と「ほかN件」(医療機関側の注文履歴と同じ) */
    function renderList() {
      more.hidden = !cursor;
      listBox.replaceChildren(...(items.length ? [h("ul", { class: "history-list dealer-list" }, items.map(it => {
        const { groups, hidden } = historyCardGroups((it.lines || []).map(lensOf));
        const b = h("button", { type: "button", class: "history-row history-card dealer-card", "data-receipt": it.receiptId },
          h("div", { class: "history-card-no dealer-card-head" }, h("span", { class: "dealer-card-no" }, it.orderNumber), h("span", { class: "dealer-card-facility" }, it.facilityName)),
          ...groups.map(g => h("div", { class: "history-card-group" }, lensDayHead(g.surgeryDate),
            h("ul", { class: "history-card-lines" }, g.lines.map(l => lensRow("li", l, { doctor: doctorOf(l), className: "summary-line" }))))),
          hidden ? h("div", { class: "history-card-more" }, `ほか${hidden}件`) : null);
        b.addEventListener("click", () => openDetail(it.receiptId));
        return h("li", {}, b);
      }))] : []));
    }

    async function openDetail(receiptId) {
      const listY = window.scrollY;   // 戻ったときに、読み込み済みの一覧と同じ位置へ
      searchArea.hidden = true; detail.hidden = false;
      const back = h("button", { type: "button", class: "btn btn-secondary", "data-act": "back" }, "← 一覧へ戻る");
      back.addEventListener("click", () => { detail.hidden = true; detail.replaceChildren(); searchArea.hidden = false; window.scrollTo(0, listY); });
      detail.replaceChildren(back, h("p", { class: "form-hint", role: "status" }, "読み込み中…"));
      try {
        const v = await api.getOrder({ companyId: ctx.company.id, receiptId });
        const rows = v.lines.map(l => h("tr", {},
          h("td", {}, String(l.no)), h("td", {}, `${l.manufacturer} ${l.model}`), h("td", {}, l.toricModel || "—"),
          h("td", {}, l.power), h("td", {}, `${l.quantity}枚`), h("td", {}, formatDate(l.surgeryDate)), h("td", {}, l.doctorName || "—")));
        // 注文メール: 通常(送信済み)は出さない。注意が必要な状態だけ常時表示し、詳しい状況は見出しのⓘで確認する
        const mail = mailStatusText(v.mail, formatJstDateTime);
        const attention = mailNeedsAttention(v.mail);
        const help = ["この画面には自社宛ての明細だけを表示しています。", `注文メール: ${mail}`, "注文メールの状態は送信・配信の状況で、受注の確定を示すものではありません。"].join("\n");
        detail.replaceChildren(back,
          h("div", { class: "form-label dealer-login-head dealer-detail-title" }, h("span", {}, "受注詳細"), createInfoTip(help, { label: "受注詳細の説明(注文メールの状況)" }).root),
          h("dl", { class: "dealer-detail-meta" },
            h("dt", {}, "医療機関"), h("dd", {}, v.facilityName),
            h("dt", {}, "注文番号"), h("dd", {}, v.orderNumber),
            h("dt", {}, "注文日時"), h("dd", {}, formatJstDateTime(v.orderedAt)),
            h("dt", {}, "自社宛て"), h("dd", {}, `${v.lineCount}件・合計${v.totalQuantity}枚`),
            ...(attention ? [h("dt", {}, "注文メール"), h("dd", { class: "dealer-mail-attention", "data-mail": v.mail.status }, mail)] : [])),
          h("div", { class: "manual-table-wrap is-wide" }, h("table", { class: "dealer-lines" },
            h("thead", {}, h("tr", {}, ["No", "メーカー・モデル", "トーリック型番", "度数", "枚数", "手術日", "担当医"].map(t => h("th", {}, t)))),
            h("tbody", {}, rows))));
      } catch (e) {
        detail.replaceChildren(back, h("p", { class: "error-message", role: "alert" }, describeCallableError(e)));
        if (String((e && e.code) || "").endsWith("permission-denied")) showMessage("ディーラー画面", describeCallableError(e), { error: true });
      }
    }

    orderedArea.append(
      // 絞り込み(折りたたみ。既定は閉じて、期間なし)
      h("details", { class: "dealer-list-filter", id: "dealerListFilter" }, h("summary", {}, "絞り込み", filterTip),
        h("div", { class: "dealer-filters" },
          h("div", { class: "dealer-filter-row" }, h("label", { class: "form-label", for: "dealerFrom" }, "注文日"), from, h("span", {}, "〜"), to),
          h("div", { class: "dealer-filter-row" }, h("label", { class: "form-label", for: "dealerOrderNumber" }, "注文番号"), number),
          h("div", { class: "onboarding-actions" }, search, clear))),
      listMsg, listBox, more);
    // 補足の説明はⓘ(共通の info-tip。タップ・クリックで開く)。医療機関名・検索範囲・メッセージは常に表示する
    const tip = (text, label) => createInfoTip(text, { label }).root;
    const facilityHelp = "チェックした医療機関の受注を表示します。チェックはこの端末に自動で記憶し、次回も同じ選択で開きます(閲覧できる範囲・担当施設は変わりません)。「担当」は会社の管理者が登録した担当施設です。"
      + (!restored.restored && ctx.selection === "all-unassigned" ? "担当施設が未設定のため、閲覧可能な全施設を選択しています。" : "");
    searchArea.append(
      h("div", { class: "dealer-filters dealer-facility-box" },
        h("div", { class: "form-label dealer-login-head" }, h("span", {}, "医療機関"), tip(facilityHelp, "医療機関の選択の説明")),
        selectBar, checks),   // 「検索範囲: …」の行は出さない(選択はチェックボックスと「担当」の印で分かる)
      viewBar,
      surgeryArea, orderedArea);
    // 担当者・支店の管理は、☰メニューの「ディーラー設定」(会社管理者・支店管理者)から開く(openSettings)
    panel.replaceChildren(...[
      h("div", { class: "feature-title-row dealer-title-row" },
        h("span", { class: "dealer-title-main" }, h("span", { class: "feature-title" }, "受注一覧"),
          tip("医療機関が閲覧を許可した後の新規注文のうち、自社宛ての明細だけを表示します。", "受注一覧の説明"))),
      deviceNotSaved ? h("p", { class: "form-hint", "data-notice": "device-not-saved" }, "このブラウザには確認の記録を保存できませんでした。この画面を閉じると、次のログインでも確認コードが必要です。") : null,
      searchArea, detail].filter(Boolean));
    renderChecks();
    resetSurgery();   // 初期表示は手術日順(今週の月曜から。注文日順は切り替えて表示)
  }

  /** 有効な所属が2社以上: 会社を選ぶ(本人の有効な所属だけ) */
  function showCompanyChoice() {
    ctx = null; items = []; cursor = null; lastQuery = null; setSubtitle(""); setMenu(null); dropSettings(); applyHeaderTheme(null);
    const msg = h("p", { class: "error-message", role: "alert" });
    const list = h("ul", { class: "pending-invite-list" }, choices.map(c => {
      const b = h("button", { type: "button", class: "btn btn-primary", "data-company": c.companyId }, "この会社で開く");
      b.addEventListener("click", async () => {
        b.disabled = true; msg.textContent = "";
        try { await showPortal(await api.context({ companyId: c.companyId })); }
        catch (e) { msg.textContent = describeCallableError(e); b.disabled = false; }
      });
      return h("li", { class: "pending-invite" }, h("div", { class: "pending-invite-facility" }, c.name), h("div", { class: "onboarding-actions" }, b));
    }));
    panel.replaceChildren(h("div", { class: "feature-title-row" }, h("span", { class: "feature-title" }, "会社の選択")),
      h("p", { class: "feature-desc" }, "複数の会社の担当者として登録されています。表示する会社を選んでください。"),
      list, msg, h("div", { class: "onboarding-actions" }, signOutBtn()));
  }

  /** ログイン後: 本人確認(必要なとき)→ 担当者の画面。確認できるまで会社名・施設名を出さない */
  let laterInvitation = false;
  let deviceNotSaved = false;   // 確認の記録(端末の値)を端末に保存できなかった(この画面の間はメモリの値で使える)   // 新しい参加の案内を後回しにした(この画面を開いている間だけ)
  async function enter() {
    panel.replaceChildren(h("p", { class: "form-hint", role: "status" }, "確認しています…"));
    try {
      // 有効な所属だけを候補にする(無効化された旧会社が残っていても、有効な1社ならそのまま開く。2社以上なら選ぶ)
      const r = await api.companies();
      choices = r.companies || [];
      if (r.pendingInvitation && !laterInvitation) { showVerify({ onLater: () => { laterInvitation = true; enter(); } }); return; }
      if (choices.length > 1) { showCompanyChoice(); return; }
      await showPortal(await api.context(choices.length === 1 ? { companyId: choices[0].companyId } : {}));
    } catch (e) {
      if (e && e.details && e.details.reason === "verification-required") { showVerify(); return; }
      showMessage("ディーラー画面", describeCallableError(e), { error: true });   // 所属がない・会社の停止など(会社名・施設名は出さない)
    }
  }

  /** 今の画面(使い方・ヘルプの戻るボタンの文言に使う) */
  const currentView = () => (settingsView && !settingsView.hidden ? "settings" : ctx && !ctx.testMode ? "portal" : "other");

  return { showLogin, showMessage, enter, switchCompany: () => showCompanyChoice(), openSettings, currentView };
}
