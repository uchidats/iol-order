import { h } from "../ui/markdown-view.js";
import { describeCallableError } from "../data/registration-api.js";
import { facilityFilterOf, selectionFor, scopeLabel, formatJstDateTime, formatDate } from "../domain/dealer-portal.js";

/**
 * ディーラー専用画面(dealer.html)。表示する文字はすべて textContent(HTML として解釈しない)。
 * 注文のデータは画面のメモリだけに置き、端末(localStorage など)には保存しない。権限エラー・ログアウトでは表示を破棄する。
 * 閲覧の範囲(会社・施設の許可・自社宛ての明細)はサーバーが毎回確認する。画面の施設の選択は検索の絞り込みだけ。
 *
 * @param {object} deps
 * @param {HTMLElement} deps.mount
 * @param {object} deps.api data/dealer-portal-api.js
 * @param {() => void} deps.onSignOut
 * @param {(text:string) => void} [deps.setSubtitle] ヘッダーの会社名
 */
export function createDealerApp({ mount, api, onSignOut, setSubtitle = () => {}, setRememberDevice = () => {} }) {
  let ctx = null;          // getContext の結果(会社・施設の候補・初期選択)
  let selected = new Set();
  let lastQuery = null, cursor = null, items = [], busy = false;
  let gen = 0;             // 検索の世代。条件を変えたら進め、古い条件の応答・続きを新しい条件に混ぜない
  let searchedAt = null;   // 検索時点(サーバーが最初のページを読んだ時点)
  let choices = [];        // 本人の有効な所属会社(2社以上なら会社を選ぶ)

  const panel = h("section", { class: "feature-card dealer-panel", id: "dealerPanel" });
  mount.replaceChildren(panel);

  const signOutBtn = () => {
    const b = h("button", { type: "button", class: "btn btn-secondary", "data-act": "signout" }, "ログアウト");
    b.addEventListener("click", () => onSignOut());
    return b;
  };
  const switchBtn = () => {
    const b = h("button", { type: "button", class: "btn btn-secondary", "data-act": "switchCompany" }, "会社を切り替える");
    b.addEventListener("click", () => showCompanyChoice());
    return b;
  };
  /** 表示中のデータを破棄して案内だけを出す */
  function showMessage(title, text, { error = false, withSignOut = true } = {}) {
    ctx = null; items = []; cursor = null; lastQuery = null; setSubtitle("");
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
   * どれでも、招待された企業メールアドレスのアカウントでログインする(所属・閲覧の範囲はサーバーが確認する)。
   * 初めて使うログイン方法(参加を含む)・新しい端末(ブラウザ)は、どの方式でも、メールに届く確認コードで本人確認してから使える。
   */
  function showLogin({ notice = "", error = "", onGoogle = null, onMicrosoft = null, onSend }) {
    const google = onGoogle ? h("button", { type: "button", class: "btn btn-primary dealer-login-google", id: "btnDealerGoogle" }, "Googleでログイン") : null;
    const microsoft = onMicrosoft ? h("button", { type: "button", class: "btn btn-primary dealer-login-microsoft", id: "btnDealerMicrosoft" }, "Microsoftでログイン") : null;
    const providers = google || microsoft;
    const email = h("input", { class: "form-control", type: "email", id: "dealerEmail", autocomplete: "email", "aria-label": "企業メールアドレス", maxlength: "254" });
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
    panel.replaceChildren(...[
      h("div", { class: "feature-title-row" }, h("span", { class: "feature-title" }, "ディーラー用 受注一覧")),
      h("p", { class: "feature-desc" }, "医療機関から閲覧を許可された、自社宛ての注文を確認する画面です。招待された企業メールアドレスのアカウントでログインしてください。"),
      providers ? h("div", { class: "dealer-login-block", "data-login": "accounts" },
        h("div", { class: "form-label" }, "会社のアカウントでログイン(推奨)"),
        h("p", { class: "form-hint" }, "招待されたメールアドレスの Google アカウント(Google Workspace など)または Microsoft アカウント(Microsoft 365 など)でログインできます。ほかのメールアドレスのアカウントは使えません。初めて使うときと、新しい端末(ブラウザ)では、招待されたメールアドレスに届く確認コードで本人確認をします。"),
        h("div", { class: "dealer-login-providers" }, google, microsoft)) : null,
      h("div", { class: "dealer-login-block", "data-login": "email" },
        h("label", { class: "form-label", for: "dealerEmail" }, providers ? "メールアドレスでログイン(パスワード不要)" : "企業メールアドレス"),
        h("p", { class: "form-hint" }, "招待された企業メールアドレスを入力すると、ログイン用のリンクが届きます。"),
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
    ctx = null; items = []; cursor = null; lastQuery = null; setSubtitle("");
    const send = h("button", { type: "button", class: "btn btn-secondary", "data-act": "sendCode" }, "確認コードを送る");
    const code = h("input", { class: "form-control dealer-join-code", type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "12", "aria-label": "確認コード(8桁)", placeholder: "8桁の確認コード", "data-f": "code" });
    const verify = h("button", { type: "button", class: "btn btn-primary", "data-act": "verifyCode" }, "確認する");
    const note = h("p", { class: "form-hint", role: "status" });
    const rememberBox = h("input", { type: "checkbox", "data-f": "remember" });
    rememberBox.checked = true;
    const remember = h("label", { class: "settings-check" }, rememberBox, h("span", {}, "この端末(ブラウザ)を記憶する(共用のパソコンでは外してください。外すと、次のログインでも確認コードが必要です)"));
    const codeRow = h("div", { class: "form-row dealer-join-row", hidden: true }, code, verify, remember);
    const lock = (v) => { send.disabled = verify.disabled = v; };
    send.addEventListener("click", async () => {
      lock(true); note.className = "form-hint"; note.textContent = "";
      try {
        const r = await api.sendCode();
        codeRow.hidden = false;
        // 登録の有無で応答を変えない(未招待には送らない)ので、届かない場合の案内も添える
        note.textContent = `ログインしたメールアドレスが登録されていれば、確認コードを送ります(届くまで少し時間がかかることがあります。${(r && r.expiresInMinutes) || 10}分間有効)。メールに書かれた会社名を確かめてから、コードを入力してください。届かない場合は、招待されたメールアドレスのアカウントでログインしているか確かめてください。`;
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
    panel.replaceChildren(...[h("div", { class: "feature-title-row" }, h("span", { class: "feature-title" }, onLater ? "参加の確認" : "本人確認")),
      h("p", { class: "feature-desc" }, onLater
        ? "新しい会社から、ディーラー画面への参加の案内が届いています。本人の確認のため、ログインしたメールアドレスに確認コードを送ります。コードを入力すると参加できます。"
        : "本人の確認のため、ログインしたメールアドレスに確認コードを送ります。コードを入力すると、受注一覧を表示できます(初めて使うログイン方法・新しい端末(ブラウザ)で必要です)。招待されたメールアドレス以外のアカウントでは使えません。"),
      h("div", { class: "form-row" }, send), codeRow, note,
      h("div", { class: "onboarding-actions" }, ...[later, signOutBtn()].filter(Boolean))].filter(Boolean));
  }

  // ---------- 受注一覧 ----------
  async function showPortal(context) {
    ctx = context;
    selected = new Set(ctx.selectedFacilityIds);
    setSubtitle(ctx.company.name);
    const from = h("input", { class: "form-control", type: "date", id: "dealerFrom", value: ctx.defaultRange.from, "aria-label": "注文日(から)" });
    const to = h("input", { class: "form-control", type: "date", id: "dealerTo", value: ctx.defaultRange.to, "aria-label": "注文日(まで)" });
    const number = h("input", { class: "form-control", type: "text", id: "dealerOrderNumber", maxlength: "40", placeholder: "例: IOL-20261027-01", "aria-label": "注文番号(完全一致)", autocomplete: "off" });
    const scope = h("p", { class: "form-hint dealer-scope", role: "status" });
    const checks = h("div", { class: "dealer-facility-list", role: "group", "aria-label": "医療機関" });
    const renderChecks = () => {
      checks.replaceChildren(...(ctx.facilities.length ? ctx.facilities.map(f => {
        const cb = h("input", { type: "checkbox", value: f.id, "data-facility": f.id });
        cb.checked = selected.has(f.id);
        cb.addEventListener("change", () => { if (cb.checked) selected.add(f.id); else selected.delete(f.id); scope.textContent = `検索範囲: ${scopeLabel([...selected], ctx.facilities)}`; invalidate(); });
        return h("label", { class: "settings-check dealer-facility" }, cb, h("span", {}, f.name), f.assigned ? h("span", { class: "member-role-badge" }, "担当") : null);
      }) : [h("p", { class: "form-hint" }, "閲覧を許可している医療機関はまだありません。")]));
      scope.textContent = `検索範囲: ${scopeLabel([...selected], ctx.facilities)}`;
    };
    const selBtn = (kind, label) => {
      const b = h("button", { type: "button", class: "btn btn-outline-sm", "data-select": kind }, label);
      b.addEventListener("click", () => { selected = new Set(selectionFor(kind, ctx.facilities)); renderChecks(); invalidate(); });
      return b;
    };
    const saveAssigned = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "saveAssigned" }, "選択中の施設を担当施設として保存");
    const assignMsg = h("p", { class: "form-hint", role: "status" });
    saveAssigned.addEventListener("click", async () => {
      saveAssigned.disabled = true; assignMsg.textContent = "";
      try {
        const r = await api.setMyAssignments({ companyId: ctx.company.id, facilityIds: [...selected] });
        const assigned = new Set(r.assignedFacilityIds);
        ctx.facilities = ctx.facilities.map(f => ({ ...f, assigned: assigned.has(f.id) }));
        renderChecks();
        assignMsg.textContent = "担当施設を保存しました(表示の初期選択だけに使います。閲覧できる範囲は変わりません)。";
      } catch (e) { assignMsg.textContent = describeCallableError(e); }
      finally { saveAssigned.disabled = false; }
    });
    const search = h("button", { type: "button", class: "btn btn-primary", id: "btnDealerSearch" }, "検索");
    const listBox = h("div", { class: "dealer-results", id: "dealerResults" });
    const more = h("button", { type: "button", class: "btn btn-secondary", id: "btnDealerMore", hidden: true }, "さらに表示");
    const listMsg = h("p", { class: "form-hint", role: "status", id: "dealerListMsg" });
    const fetched = h("p", { class: "form-hint dealer-fetched" });
    const detail = h("div", { class: "dealer-detail", id: "dealerDetail", hidden: true });
    const searchArea = h("div", { class: "dealer-search-area" });

    /** 検索条件(施設・期間・注文番号)を変えたら、表示中の結果と続きを破棄する。「さらに表示」で古い条件の続きを読まない */
    const CHANGED = "条件を変更しました。「検索」を押すと、新しい条件で検索します。";
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
          lastQuery = { companyId: ctx.company.id, from: from.value, to: to.value, facilityFilter: facilityFilterOf([...selected]), ...(number.value.trim() ? { orderNumber: number.value.trim() } : {}) };
          cursor = null; items = [];
        }
        const r = await api.listOrders({ ...lastQuery, ...(append && cursor ? { cursor } : {}) });
        if (my !== gen) { listMsg.textContent = CHANGED; return; }   // 通信中に条件が変わった: 古い条件の結果は表示しない
        if (r.restart) {
          // 検索の途中で、読み終えた範囲に新しい注文の索引が反映された。続きからでは欠けるため、先頭からの再検索を求める
          cursor = null; renderList();
          listMsg.textContent = "検索の途中で新しい注文が反映されました。「検索」を押して、先頭から検索し直してください。";
          return;
        }
        items = append ? [...items, ...r.items] : r.items;
        cursor = r.nextCursor || null;
        renderList();
        listMsg.textContent = items.length ? `${items.length}件${cursor ? "(続きがあります)" : ""}`
          : cursor ? "ここまでに該当する注文は見つかりませんでした。「さらに表示」で続きを検索できます。" : "該当する注文はありません。";
        // 続きのページも、最初のページを読んだ時点(検索時点)の内容で表示する。その後に反映された注文は再検索で表示
        if (!append) searchedAt = r.asOf || new Date().toISOString();
        fetched.textContent = `検索時点: ${formatJstDateTime(searchedAt)}(注文メールとは別に反映されるため、表示まで少し時間がかかることがあります)`;
        if (r.newSinceSearch) listMsg.textContent += " 検索の後に反映された注文があります。「検索」を押すと最新の内容を表示します。";
      } catch (e) {
        if (my !== gen) { listMsg.textContent = CHANGED; return; }
        items = []; cursor = null; renderList();
        listMsg.textContent = describeCallableError(e);
        if (String((e && e.code) || "").endsWith("permission-denied")) showMessage("ディーラー画面", describeCallableError(e), { error: true });
      } finally { busy = false; search.disabled = more.disabled = false; }
    };
    search.addEventListener("click", () => run(false));
    more.addEventListener("click", () => run(true));

    function renderList() {
      more.hidden = !cursor;
      listBox.replaceChildren(...(items.length ? [h("ul", { class: "history-list dealer-list" }, items.map(it => {
        const b = h("button", { type: "button", class: "history-row dealer-row", "data-receipt": it.receiptId },
          h("span", { class: "history-date" }, formatJstDateTime(it.orderedAt)),
          h("span", { class: "dealer-row-facility" }, it.facilityName),
          h("span", { class: "dealer-row-number" }, it.orderNumber),
          h("span", { class: "history-count" }, `${it.lineCount}件・合計${it.totalQuantity}枚`));
        b.addEventListener("click", () => openDetail(it.receiptId));
        return h("li", {}, b);
      }))] : []));
    }

    async function openDetail(receiptId) {
      searchArea.hidden = true; detail.hidden = false;
      const back = h("button", { type: "button", class: "btn btn-secondary", "data-act": "back" }, "← 一覧へ戻る");
      back.addEventListener("click", () => { detail.hidden = true; detail.replaceChildren(); searchArea.hidden = false; });
      detail.replaceChildren(back, h("p", { class: "form-hint", role: "status" }, "読み込み中…"));
      try {
        const v = await api.getOrder({ companyId: ctx.company.id, receiptId });
        const rows = v.lines.map(l => h("tr", {},
          h("td", {}, String(l.no)), h("td", {}, `${l.manufacturer} ${l.model}`), h("td", {}, l.toricModel || "—"),
          h("td", {}, l.power), h("td", {}, `${l.quantity}枚`), h("td", {}, formatDate(l.surgeryDate)), h("td", {}, l.doctorName || "—")));
        const mail = v.mail ? `${v.mail.label}${v.mail.at ? `(${formatJstDateTime(v.mail.at)})` : ""}${v.mail.delivery ? ` ・ ${v.mail.delivery.label}` : ""}` : "—";
        detail.replaceChildren(back,
          h("dl", { class: "dealer-detail-meta" },
            h("dt", {}, "医療機関"), h("dd", {}, v.facilityName),
            h("dt", {}, "注文番号"), h("dd", {}, v.orderNumber),
            h("dt", {}, "注文日時"), h("dd", {}, formatJstDateTime(v.orderedAt)),
            h("dt", {}, "自社宛て"), h("dd", {}, `${v.lineCount}件・合計${v.totalQuantity}枚`),
            h("dt", {}, "注文メール"), h("dd", {}, mail)),
          h("div", { class: "manual-table-wrap is-wide" }, h("table", { class: "dealer-lines" },
            h("thead", {}, h("tr", {}, ["No", "メーカー・モデル", "トーリック型番", "度数", "枚数", "手術日", "担当医"].map(t => h("th", {}, t)))),
            h("tbody", {}, rows))),
          h("p", { class: "form-hint" }, "この画面には自社宛ての明細だけを表示しています。注文メールの状態は送信・配信の状況で、受注の確定を示すものではありません。"));
      } catch (e) {
        detail.replaceChildren(back, h("p", { class: "error-message", role: "alert" }, describeCallableError(e)));
        if (String((e && e.code) || "").endsWith("permission-denied")) showMessage("ディーラー画面", describeCallableError(e), { error: true });
      }
    }

    searchArea.append(
      h("div", { class: "dealer-filters" },
        h("div", { class: "dealer-filter-row" }, h("label", { class: "form-label", for: "dealerFrom" }, "注文日"), from, h("span", {}, "〜"), to),
        h("div", { class: "dealer-filter-row" }, h("label", { class: "form-label", for: "dealerOrderNumber" }, "注文番号"), number),
        h("div", { class: "form-label" }, "医療機関"),
        h("div", { class: "dealer-select-actions" }, selBtn("assigned", "担当施設を選択"), selBtn("all", "閲覧可能施設をすべて選択"), selBtn("none", "選択を解除")),
        checks, scope,
        h("div", { class: "dealer-select-actions" }, saveAssigned), assignMsg,
        h("div", { class: "onboarding-actions" }, search)),
      fetched, listMsg, listBox, more);
    const noAssigned = ctx.selection === "all-unassigned" ? h("p", { class: "form-hint" }, "担当施設が未設定のため、閲覧可能な全施設を選択しています。") : null;
    panel.replaceChildren(...[
      h("div", { class: "feature-title-row dealer-title-row" }, h("span", { class: "feature-title" }, "受注一覧"), ...(choices.length > 1 ? [switchBtn()] : []), signOutBtn()),
      h("p", { class: "feature-desc" }, `${ctx.company.name}${ctx.me.branch ? ` ${ctx.me.branch.name}` : ""} ・ ${ctx.me.name || "担当者"}`),
      h("p", { class: "form-hint" }, "医療機関が閲覧を許可した後の新規注文のうち、自社宛ての明細だけを表示します。"),
      deviceNotSaved ? h("p", { class: "form-hint", "data-notice": "device-not-saved" }, "このブラウザには確認の記録を保存できませんでした。この画面を閉じると、次のログインでも確認コードが必要です。") : null,
      noAssigned, searchArea, detail].filter(Boolean));
    renderChecks();
    if (ctx.facilities.length) await run(false);
  }

  /** 有効な所属が2社以上: 会社を選ぶ(本人の有効な所属だけ) */
  function showCompanyChoice() {
    ctx = null; items = []; cursor = null; lastQuery = null; setSubtitle("");
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

  return { showLogin, showMessage, enter };
}
