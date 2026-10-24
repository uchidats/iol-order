import { ACCESS } from "../domain/access.js";
import { facilityGeo } from "../domain/geo.js";
import { $, escapeHtml } from "./dom.js";

// Firebase有効時に、所属確認と施設確定が済むまで隠す画面要素
const GATED_ELEMENT_IDS = ["ocrFeatureCard", "iolOrderForm"];

/**
 * ログイン・施設選択パネルの生成と、アクセス状態に応じた画面の出し分け
 * 施設選択は「ログイン直後に必要な場合だけ」表示し、施設確定後は表示しない（切替はヘッダーメニュー）。
 *
 * @param {{onGoogle:()=>void, onEmailLink:(email:string)=>void,
 *          onSelectFacility:(facilityId:string)=>void, onLocate:()=>void, onSignOut:()=>void}} handlers
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

  /**
   * @param {{access:object, user:object|null, notice?:string, error?:string,
   *          facilities?:Array<{id:string,name:string,location?:object,geoRadiusM?:number}>, busy?:boolean}} s
   */
  function render({ access, user, notice, error, facilities = [], busy = false }) {
    const state = access.state;

    if (state === ACCESS.LEGACY) {
      panel.hidden = true;
      setGated(false);
      return;
    }

    setGated(state !== ACCESS.GRANTED);

    const who = user ? escapeHtml(user.displayName || user.email || "ログイン中") : "";
    const msg = [
      error ? `<p class="error-message" role="alert">${escapeHtml(error)}</p>` : "",
      notice ? `<p class="form-hint" role="status">${escapeHtml(notice)}</p>` : ""
    ].join("");

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
      panel.innerHTML = `
        <div class="feature-info">
          <div class="feature-title-row"><span class="feature-title">施設への所属が確認できません</span></div>
          <p class="feature-desc">${who} はログインできていますが、利用できる施設が登録されていません。
          注文・施設情報は表示されません。施設の管理者にご連絡ください。</p>
          <button type="button" class="btn btn-secondary" id="btnAuthSignOut">ログアウト</button>
          ${msg}
        </div>`;
      $("btnAuthSignOut").addEventListener("click", () => handlers.onSignOut());
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
