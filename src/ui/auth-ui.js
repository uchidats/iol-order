import { ACCESS } from "../domain/access.js";
import { facilityGeo } from "../domain/geo.js";
import { normalizeFacilityName } from "../domain/registration-flow.js";
import { $, escapeHtml } from "./dom.js";
import { createInfoTip } from "./info-tip.js";

// Firebase有効時に、所属確認と施設確定が済むまで隠す画面要素
const GATED_ELEMENT_IDS = ["ocrFeatureCard", "iolOrderForm"];

/**
 * ログイン・施設選択パネルの生成と、アクセス状態に応じた画面の出し分け
 * 施設選択は「ログイン直後に必要な場合だけ」表示し、施設確定後は表示しない（切替はヘッダーメニュー）。
 *
 * @param {{onGoogle:()=>void, onEmailLink:(email:string)=>void,
 *          onSelectFacility:(facilityId:string)=>void, onLocate:()=>void, onSignOut:()=>void,
 *          onRegister:(a:{name:string, applicantName:string, confirmDuplicate:boolean})=>void,
 *          onRegisterCancel:()=>void, onOnboardingClose:()=>void}} handlers
 */
export function createAuthUi(handlers) {
  const main = document.querySelector("main.main-content");
  const panel = document.createElement("section");
  panel.id = "authPanel";
  panel.className = "feature-card";
  panel.hidden = true;
  main.insertBefore(panel, main.firstChild);

  function setGated(gated) {
    GATED_ELEMENT_IDS.forEach(id => {
      const el = $(id);
      if (el) el.classList.toggle("hidden", gated);
    });
  }

  // 所属なしユーザーの入力途中の値（再描画で消えないよう保持）
  const draft = { name: "", applicantName: null };   // applicantName: 未入力(null)の間は、ログイン情報の表示名を初期値にする
  let lastArgs = null;

  // 施設名の入力中の重複候補の確認(登録は止めない。別の施設の場合は、そのまま登録できる)。表示するのは候補の施設名のみ(最大5件)
  let nameTimer = null, nameSeq = 0;
  // 既存の施設への参加は、その施設の管理者・副管理者が利用者管理で登録する(事前登録)。本人がログインすると参加の確認が表示される
  const JOIN_GUIDE = "既存の施設に参加する場合は、その施設の管理者に、利用者管理への登録(このメールアドレス)を依頼してください。登録されると、ログインしたときに参加の確認が表示されます(表示されない場合は、ページを再読み込みしてください)。";
  const DUP_HINT = "既に登録されている可能性があります。既存の施設に参加する場合は、その施設の管理者に利用者管理への登録を依頼してください。別の施設の場合は、このまま登録できます。";
  function scheduleNameCheck(nameEl) {
    clearTimeout(nameTimer);
    const hint = $("regNameHint"), list = $("regNameCandidates"), guide = $("regCandidateGuide");
    if (hint) hint.hidden = true;
    if (list) { list.hidden = true; list.textContent = ""; }
    if (guide) guide.hidden = true;
    const name = normalizeFacilityName(nameEl.value);
    if (!handlers.onCheckName || name.length < 2) return;
    const mySeq = ++nameSeq;
    nameTimer = setTimeout(async () => {
      let r = null;
      try { r = await handlers.onCheckName(name); } catch { r = null; }   // 確認できなくても、登録の操作は妨げない(登録時にサーバーでも確認する)
      const h = $("regNameHint");
      if (mySeq !== nameSeq || !h || normalizeFacilityName(nameEl.value) !== name) return;   // 入力が変わっていたら、古い結果は使わない
      h.textContent = r && (r.exact || r.similarCount > 0) ? DUP_HINT : "";
      h.hidden = !h.textContent;
      showCandidates(h.hidden ? [] : (Array.isArray(r.candidates) ? r.candidates.slice(0, 5) : []));
    }, 700);
  }

  /** 候補の施設名(施設名のみ)を一覧表示。選ぶと、その施設の管理者に登録を依頼するよう案内する。選んでも施設名の入力は書き換えない */
  function showCandidates(names) {
    const list = $("regNameCandidates"), guide = $("regCandidateGuide");
    if (!list || !guide) return;
    list.textContent = "";
    for (const n of names) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button"; b.className = "candidate-item"; b.textContent = n;   // 施設名は textContent で(HTMLとして解釈しない)
      b.addEventListener("click", () => {
        guide.textContent = "「" + n + "」に参加する場合は、その施設の管理者に、利用者管理への登録を依頼してください。登録されると、ログインしたときに参加の確認が表示されます。";
        guide.hidden = false;
      });
      li.appendChild(b); list.appendChild(li);
    }
    list.hidden = names.length === 0;
  }

  /** 所属なし・メニューの「施設を登録」: 新しい施設の登録。既存の施設への参加は、その施設の管理者による事前登録で行う(案内のみ) */
  function renderOnboarding({ msg, user, registration, embedded = false }) {
    const reg = registration || {};
    const unverified = Boolean(user) && user.emailVerified === false;
    const dupName = reg.duplicate ? reg.duplicate.forName : null;
    const showDup = Boolean(reg.duplicate) && dupName === normalizeFacilityName(draft.name);
    const disabled = reg.busy || unverified ? "disabled" : "";

    const body = `
        <div class="form-group">
          <label class="form-label" for="regFacilityName">施設名</label>
          <input id="regFacilityName" class="form-control" type="text" maxlength="100" autocomplete="organization" value="${escapeHtml(draft.name)}">
          <p class="error-message" id="regNameHint" role="status" aria-live="polite" hidden></p>
          <ul class="candidate-list" id="regNameCandidates" aria-label="施設名の候補" hidden></ul>
          <p class="form-hint" id="regCandidateGuide" role="status" aria-live="polite" hidden></p>
          ${showDup ? `
            <p class="error-message" role="alert">既に登録されている可能性があります(${reg.duplicate.exact ? "同じ名前の施設があります" : "名前の似た施設があります"})。
            既存の施設に参加する場合は、その施設の管理者に利用者管理への登録を依頼してください。別の施設の場合のみ、このまま申請できます。</p>
            ` : ""}
        </div>
        <div class="form-group">
          <label class="form-label" for="regApplicantName">申請者のお名前</label>
          <input id="regApplicantName" class="form-control" type="text" maxlength="50" autocomplete="name" value="${escapeHtml(draft.applicantName ?? ((user && user.displayName) || ""))}">
        </div>`;
    // primary: 右側に並べる主なボタン(左側に「注文画面に戻る」/「ログアウト」を同じ行で置く)
    const primary = showDup
      ? `<button type="button" class="btn btn-secondary" id="btnRegConfirm" ${disabled}>別の施設として申請する</button>
            <button type="button" class="btn btn-outline-sm" id="btnRegCancel">やめる</button>`
      : `<button type="button" class="btn btn-primary" id="btnRegSubmit" ${disabled}>${reg.busy ? "申請しています…" : "申請する"}</button>`;

    panel.innerHTML = `
      <div class="feature-info">
        <div class="feature-title-row onboarding-title-row"><span class="feature-title">${embedded ? "新しい施設の登録" : "施設への所属が確認できません"}</span></div>
        ${unverified ? '<p class="error-message" role="alert">メールアドレスの確認が済んでいないため、施設の登録・参加はできません。</p>' : ""}
        ${body}
        <div class="onboarding-actions">
          ${embedded
            ? '<button type="button" class="btn btn-outline-sm" id="btnOnboardingClose">注文画面に戻る</button>'
            : '<button type="button" class="btn btn-outline-sm" id="btnAuthSignOut">ログアウト</button>'}
          <div class="onboarding-primary">${primary}</div>
        </div>
        ${msg}
      </div>`;

    // 説明は見出し右のⓘにまとめる(通常の表示は 見出し+ⓘ・施設名・ボタン だけ)。外側のタップ・Esc で閉じる(info-tip.js。説明は文字列として表示)
    const plainWho = user ? (user.displayName || user.email || "ログイン中") : "ログイン中";
    const intro = embedded
      ? `${plainWho} でログインしています。所属中の施設はそのまま利用できます。新しい施設の登録を申請できます。`
      : `${plainWho} でログインしています。利用を始めるには、新しい施設の登録を申請してください。`;
    const APPROVAL = "新しい施設の登録は、IOL Order 運営者の承認制です。運営者が申請の内容を確認して承認すると施設が有効になり、申請したあなたが最初の管理者になります(承認後にページを再読み込みすると利用できます)。承認されるまでは注文できません。施設IDは自動で割り当てられます。";
    const tip = createInfoTip([intro, APPROVAL, JOIN_GUIDE].join("\n\n"), { label: "施設の登録についての説明" });
    tip.button.id = "onboardingInfo";
    tip.popup.classList.add("onboarding-info-pop");
    panel.querySelector(".onboarding-title-row").append(tip.root);

    const rerender = () => lastArgs && render(lastArgs);
    const signOutBtn = $("btnAuthSignOut");
    if (signOutBtn) signOutBtn.addEventListener("click", () => handlers.onSignOut());
    const closeBtn = $("btnOnboardingClose");
    if (closeBtn) closeBtn.addEventListener("click", () => handlers.onOnboardingClose());

    const nameEl = $("regFacilityName");
    if (nameEl) nameEl.addEventListener("input", () => { draft.name = nameEl.value; scheduleNameCheck(nameEl); });
    const submit = $("btnRegSubmit");
    const applicantEl = $("regApplicantName");
    if (applicantEl) applicantEl.addEventListener("input", () => { draft.applicantName = applicantEl.value; });
    const applicantName = () => (applicantEl ? applicantEl.value.trim() : "");
    if (submit) submit.addEventListener("click", () => handlers.onRegister({ name: nameEl.value, applicantName: applicantName(), confirmDuplicate: false }));
    const confirmBtn = $("btnRegConfirm");
    if (confirmBtn) confirmBtn.addEventListener("click", () => handlers.onRegister({ name: nameEl.value, applicantName: applicantName(), confirmDuplicate: true }));
    const cancel = $("btnRegCancel");
    if (cancel) cancel.addEventListener("click", () => { handlers.onRegisterCancel(); rerender(); });
  }

  /** 参加確認: 施設名と役割を示し、施設ごとに「参加する」「参加しない」を選ぶ(承認・辞退の検証はサーバー) */
  function renderPendingConfirm({ user, pendingInvites, pendingBusy, error, notice }) {
    const who = escapeHtml(user.email || user.displayName || "ログイン中");
    const disabled = pendingBusy ? "disabled" : "";
    const items = pendingInvites.map(p => `
      <li class="pending-invite" data-pending="${escapeHtml(p.pendingId)}">
        <div class="pending-invite-facility">${escapeHtml(p.facilityName || "（名称未設定）")}</div>
        <div class="pending-invite-meta">役割 <span class="member-role-badge">${escapeHtml(p.roleLabel || "")}</span>${p.invitedByName ? ` ・ 登録者 ${escapeHtml(p.invitedByName)}` : ""}</div>
        ${p.initialAdmin ? '<p class="form-hint pending-invite-admin">参加すると、この施設の<strong>管理者</strong>になります(施設設定・利用者の管理ができます)。参加するまで、管理者の権限は付きません。</p>' : ""}
        <div class="onboarding-actions">
          <div class="onboarding-primary"><button type="button" class="btn btn-primary" data-act="accept" ${disabled}>参加する</button></div>
          <button type="button" class="btn btn-secondary" data-act="decline" ${disabled}>参加しない</button>
        </div>
      </li>`).join("");
    panel.innerHTML = `
      <div class="feature-info">
        <div class="feature-title-row"><span class="feature-title">施設への参加の確認</span></div>
        <p class="feature-desc">${who} 宛てに、次の施設から利用者の登録があります。参加する施設を選んでください。</p>
        <ul class="pending-invite-list">${items}</ul>
        ${error ? `<p class="error-message" role="alert">${escapeHtml(error)}</p>` : ""}
        ${notice ? `<p class="form-hint" role="status">${escapeHtml(notice)}</p>` : ""}
      </div>`;
    panel.querySelectorAll(".pending-invite").forEach((li) => {
      const pendingId = li.getAttribute("data-pending");
      const p = pendingInvites.find(x => x.pendingId === pendingId);
      li.querySelector('[data-act="accept"]').addEventListener("click", () => handlers.onRespondPending({ pendingId, accept: true }));
      li.querySelector('[data-act="decline"]').addEventListener("click", () => {
        if (!window.confirm(`「${(p && p.facilityName) || "この施設"}」に参加しませんか？\n参加しない場合、もう一度参加するには施設の管理者に再登録を依頼してください。`)) return;
        handlers.onRespondPending({ pendingId, accept: false });
      });
    });
  }

  /**
   * @param {{access:object, user:object|null, notice?:string, error?:string,
   *          facilities?:Array<{id:string,name:string,location?:object,geoRadiusM?:number}>, busy?:boolean,
   *          registration?:{busy?:boolean, duplicate?:object|null},
   *          pendingInvites?:Array<{pendingId:string, facilityName:string, roleLabel:string, invitedByName?:string|null, expiresAt:string}>,
   *          pendingBusy?:boolean}} s
   */
  function render(args) {
    lastArgs = args;
    const { access, user, notice, error, facilities = [], busy = false, registration = null, pendingInvites = [], pendingBusy = false } = args;
    const state = access.state;

    if (state === ACCESS.LEGACY) {
      panel.hidden = true;
      setGated(false);
      return;
    }

    // 事前登録された施設への参加確認(ログイン後、本人宛ての参加待ちがある間は、ほかの画面より先に表示する)
    if (user && pendingInvites.length && state !== ACCESS.LOADING && state !== ACCESS.SIGNED_OUT) {
      setGated(true);
      panel.hidden = false;
      renderPendingConfirm({ user, pendingInvites, pendingBusy, error, notice });
      return;
    }

    // 所属済みユーザーがメニューから開いた施設登録の画面（registration.open は "register"）
    const embeddedOpen = state === ACCESS.GRANTED && Boolean(registration && registration.open);
    setGated(state !== ACCESS.GRANTED || embeddedOpen);

    const who = user ? escapeHtml(user.displayName || user.email || "ログイン中") : "";
    const msg = [
      error ? `<p class="error-message" role="alert">${escapeHtml(error)}</p>` : "",
      notice ? `<p class="form-hint" role="status">${escapeHtml(notice)}</p>` : ""
    ].join("");

    if (embeddedOpen) {
      panel.hidden = false;
      renderOnboarding({ who, msg, user, registration, embedded: true });
      return;
    }

    if (state === ACCESS.GRANTED) {
      // 通常の注文画面。メッセージがある時だけパネルを出す
      panel.hidden = !(error || notice);
      panel.innerHTML = msg;
      return;
    }

    panel.hidden = false;

    if (state === ACCESS.LOADING) {
      panel.innerHTML = `<p class="form-hint" role="status">${escapeHtml(notice || "認証状態を確認しています…")}</p>${error ? msg : ""}`;
      return;
    }

    if (state === ACCESS.SIGNED_OUT) {
      panel.innerHTML = `
        <div class="feature-info auth-signin">
          <div class="feature-title-row"><span class="feature-title">ログインが必要です</span></div>
          <p class="feature-desc">施設に登録された方のみ利用できます。</p>
          <div class="form-group">
            <button type="button" class="btn btn-secondary" id="btnAuthGoogle">Googleでログイン</button>
          </div>
          <div class="form-group">
            <label class="form-label" for="authEmailInput">メールでログイン（パスワード不要）</label>
            <input type="email" id="authEmailInput" class="form-control" autocomplete="email" placeholder="メールアドレス">
            <button type="button" class="btn btn-secondary" id="btnAuthEmailLink">ログインリンクを送信</button>
          </div>
          ${msg}
        </div>`;
      $("btnAuthGoogle").addEventListener("click", () => handlers.onGoogle());
      $("btnAuthEmailLink").addEventListener("click", () => handlers.onEmailLink($("authEmailInput").value));
      return;
    }

    if (state === ACCESS.NO_MEMBERSHIP) {
      renderOnboarding({ who, msg, user, registration });
      return;
    }

    // SELECT_FACILITY: 複数所属。検証済みの所属の施設のみ並べる
    const selectable = access.memberships
      .map(m => facilities.find(f => f.id === m.facilityId))
      .filter(Boolean);
    const canLocate = selectable.some(f => facilityGeo(f));
    const buttons = selectable
      .map(f => `<button type="button" class="btn btn-secondary" data-facility-id="${escapeHtml(f.id)}">${escapeHtml(f.name)}</button>`)
      .join("");

    panel.innerHTML = `
      <div class="feature-info">
        <div class="feature-title-row"><span class="feature-title">施設を選択してください</span></div>
        <p class="feature-desc">複数の施設に所属しています。注文する施設を選んでください。</p>
        <div class="facility-select-list">${buttons}</div>
        ${canLocate ? `
          <button type="button" class="btn btn-outline-sm" id="btnLocateFacility" ${busy ? "disabled" : ""}>現在地から施設を選ぶ</button>
          <p class="form-hint">現在地は端末内で施設の登録位置と比較するだけです。保存・送信はせず、継続的な追跡もしません。</p>` : ""}
        ${msg}
      </div>`;
    panel.querySelectorAll("[data-facility-id]").forEach(b => {
      b.addEventListener("click", () => handlers.onSelectFacility(b.getAttribute("data-facility-id")));
    });
    const locate = $("btnLocateFacility");
    if (locate) locate.addEventListener("click", () => handlers.onLocate());
  }

  return { render };
}
