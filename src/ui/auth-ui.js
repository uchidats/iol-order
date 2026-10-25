import { ACCESS } from "../domain/access.js";
import { facilityGeo } from "../domain/geo.js";
import { normalizeFacilityName } from "../domain/registration-flow.js";
import { $, escapeHtml } from "./dom.js";

// Firebase有効時に、所属確認と施設確定が済むまで隠す画面要素
const GATED_ELEMENT_IDS = ["ocrFeatureCard", "iolOrderForm"];

/**
 * ログイン・施設選択パネルの生成と、アクセス状態に応じた画面の出し分け
 * 施設選択は「ログイン直後に必要な場合だけ」表示し、施設確定後は表示しない（切替はヘッダーメニュー）。
 *
 * @param {{onGoogle:()=>void, onEmailLink:(email:string)=>void,
 *          onSelectFacility:(facilityId:string)=>void, onLocate:()=>void, onSignOut:()=>void,
 *          onRegister:(a:{name:string, confirmDuplicate:boolean})=>void, onJoin:(a:{token:string})=>void,
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
  const draft = { mode: null, name: "", token: "" };
  let lastArgs = null;
  let lastOpen = null; // メニューから開いた登録・参加画面の直前の種別（開き直しでモードを初期化する）

  // 施設名の入力中の重複候補の確認(登録は止めない。別の施設の場合は、そのまま登録できる)。表示するのは候補の施設名のみ(最大5件)
  let nameTimer = null, nameSeq = 0;
  const DUP_HINT = "既に登録されている可能性があります。既存の施設に参加する場合は、その施設の管理者から招待コードを受け取り、「既存施設に参加する」から参加してください。別の施設の場合は、このまま登録できます。";
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

  /** 候補の施設名(施設名のみ)を一覧表示。選ぶと、招待コードによる参加を案内する。選んでも施設名の入力は書き換えない */
  function showCandidates(names) {
    const list = $("regNameCandidates"), guide = $("regCandidateGuide");
    if (!list || !guide) return;
    list.textContent = "";
    for (const n of names) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button"; b.className = "candidate-item"; b.textContent = n;   // 施設名は textContent で(HTMLとして解釈しない)
      b.addEventListener("click", () => {
        guide.textContent = "";
        const p = document.createElement("span");
        p.textContent = "「" + n + "」に参加する場合は、その施設の管理者から招待コードを受け取り、";
        const go = document.createElement("button");
        go.type = "button"; go.id = "btnGoJoin"; go.className = "btn btn-secondary"; go.textContent = "招待コードで参加する";
        go.addEventListener("click", () => { draft.mode = "join"; handlers.onRegisterCancel(); if (lastArgs) render(lastArgs); });
        guide.append(p, document.createTextNode("「既存施設に参加する」から入力してください。"), document.createElement("br"), go);
        guide.hidden = false;
      });
      li.appendChild(b); list.appendChild(li);
    }
    list.hidden = names.length === 0;
  }

  /** 所属なし: 「新しい施設を登録」または「招待コードで既存施設に参加」。招待なしでの参加はできない */
  function renderOnboarding({ who, msg, user, registration, embedded = false }) {
    const reg = registration || {};
    const unverified = Boolean(user) && user.emailVerified === false;
    const dupName = reg.duplicate ? reg.duplicate.forName : null;
    const showDup = Boolean(reg.duplicate) && dupName === normalizeFacilityName(draft.name);
    const disabled = reg.busy || unverified ? "disabled" : "";

    let body = "";
    if (draft.mode === "register") {
      body = `
        <div class="form-group">
          <label class="form-label" for="regFacilityName">施設名</label>
          <input id="regFacilityName" class="form-control" type="text" maxlength="100" autocomplete="organization" value="${escapeHtml(draft.name)}">
          <p class="form-hint">施設IDは自動で割り当てられます。登録したあなたが、この施設の最初の管理者になります。</p>
          <p class="error-message" id="regNameHint" role="status" aria-live="polite" hidden></p>
          <ul class="candidate-list" id="regNameCandidates" aria-label="施設名の候補" hidden></ul>
          <p class="form-hint" id="regCandidateGuide" role="status" aria-live="polite" hidden></p>
          ${showDup ? `
            <p class="error-message" role="alert">既に登録されている可能性があります(${reg.duplicate.exact ? "同じ名前の施設があります" : "名前の似た施設があります"})。
            既存の施設に参加する場合は、その施設の管理者から招待コードを受け取ってください。別の施設の場合のみ、このまま登録できます。</p>
            <button type="button" class="btn btn-secondary" id="btnRegConfirm" ${disabled}>別の施設として登録する</button>
            <button type="button" class="btn btn-outline-sm" id="btnRegCancel">やめる</button>`
          : `<button type="button" class="btn btn-primary" id="btnRegSubmit" ${disabled}>${reg.busy ? "登録しています…" : "登録する"}</button>`}
        </div>`;
    } else if (draft.mode === "join") {
      body = `
        <div class="form-group">
          <label class="form-label" for="joinToken">招待コード</label>
          <input id="joinToken" class="form-control" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(draft.token)}">
          <p class="form-hint">施設の管理者から受け取った招待コードを入力します。招待されたメールアドレスでログインしている必要があります。招待がない場合は参加できません。</p>
          <button type="button" class="btn btn-primary" id="btnJoinSubmit" ${disabled}>${reg.busy ? "確認しています…" : "参加する"}</button>
        </div>`;
    }

    panel.innerHTML = `
      <div class="feature-info">
        <div class="feature-title-row"><span class="feature-title">${embedded ? "施設の登録・参加" : "施設への所属が確認できません"}</span></div>
        <p class="feature-desc">${embedded
          ? `${who} でログインしています。所属中の施設はそのまま利用できます。新しい施設を登録するか、招待を受けた別の施設に参加できます。`
          : `${who} でログインしています。利用を始めるには、新しい施設を登録するか、招待を受けた施設に参加してください。`}</p>
        ${unverified ? '<p class="error-message" role="alert">メールアドレスの確認が済んでいないため、施設の登録・参加はできません。</p>' : ""}
        <div class="facility-select-list">
          <button type="button" class="btn btn-secondary" id="btnModeRegister" ${draft.mode === "register" ? 'aria-pressed="true"' : ""}>新しい施設を登録</button>
          <button type="button" class="btn btn-secondary" id="btnModeJoin" ${draft.mode === "join" ? 'aria-pressed="true"' : ""}>既存施設に参加する</button>
        </div>
        ${body}
        ${embedded
          ? '<button type="button" class="btn btn-outline-sm" id="btnOnboardingClose">注文画面に戻る</button>'
          : '<button type="button" class="btn btn-outline-sm" id="btnAuthSignOut">ログアウト</button>'}
        ${msg}
      </div>`;

    const rerender = () => lastArgs && render(lastArgs);
    $("btnModeRegister").addEventListener("click", () => { draft.mode = "register"; handlers.onRegisterCancel(); rerender(); });
    $("btnModeJoin").addEventListener("click", () => { draft.mode = "join"; handlers.onRegisterCancel(); rerender(); });
    const signOutBtn = $("btnAuthSignOut");
    if (signOutBtn) signOutBtn.addEventListener("click", () => handlers.onSignOut());
    const closeBtn = $("btnOnboardingClose");
    if (closeBtn) closeBtn.addEventListener("click", () => handlers.onOnboardingClose());

    const nameEl = $("regFacilityName");
    if (nameEl) nameEl.addEventListener("input", () => { draft.name = nameEl.value; scheduleNameCheck(nameEl); });
    const submit = $("btnRegSubmit");
    if (submit) submit.addEventListener("click", () => handlers.onRegister({ name: nameEl.value, confirmDuplicate: false }));
    const confirmBtn = $("btnRegConfirm");
    if (confirmBtn) confirmBtn.addEventListener("click", () => handlers.onRegister({ name: nameEl.value, confirmDuplicate: true }));
    const cancel = $("btnRegCancel");
    if (cancel) cancel.addEventListener("click", () => { handlers.onRegisterCancel(); rerender(); });

    const tokenEl = $("joinToken");
    if (tokenEl) tokenEl.addEventListener("input", () => { draft.token = tokenEl.value; });
    const join = $("btnJoinSubmit");
    if (join) join.addEventListener("click", () => handlers.onJoin({ token: tokenEl.value.trim() }));
  }

  /**
   * @param {{access:object, user:object|null, notice?:string, error?:string,
   *          facilities?:Array<{id:string,name:string,location?:object,geoRadiusM?:number}>, busy?:boolean,
   *          registration?:{busy?:boolean, duplicate?:object|null}}} s
   */
  function render(args) {
    lastArgs = args;
    const { access, user, notice, error, facilities = [], busy = false, registration = null } = args;
    const state = access.state;

    if (state === ACCESS.LEGACY) {
      panel.hidden = true;
      setGated(false);
      return;
    }

    // 所属済みユーザーがメニューから開いた登録・参加画面（registration.open は "register" | "join"）
    const embeddedOpen = state === ACCESS.GRANTED && Boolean(registration && registration.open);
    setGated(state !== ACCESS.GRANTED || embeddedOpen);

    const who = user ? escapeHtml(user.displayName || user.email || "ログイン中") : "";
    const msg = [
      error ? `<p class="error-message" role="alert">${escapeHtml(error)}</p>` : "",
      notice ? `<p class="form-hint" role="status">${escapeHtml(notice)}</p>` : ""
    ].join("");

    if (embeddedOpen) {
      if (lastOpen !== registration.open) draft.mode = registration.open;
      lastOpen = registration.open;
      panel.hidden = false;
      renderOnboarding({ who, msg, user, registration, embedded: true });
      return;
    }
    lastOpen = null;

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
        <div class="feature-info">
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
