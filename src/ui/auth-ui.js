import { ACCESS } from "../domain/access.js";
import { $, escapeHtml } from "./dom.js";

// Firebase有効時に、所属確認が済むまで隠す画面要素
const GATED_ELEMENT_IDS = ["ocrFeatureCard", "iolOrderForm"];

/**
 * ログイン関連パネルの生成と、アクセス状態に応じた画面の出し分け
 * @param {{onGoogle:()=>void, onEmailLink:(email:string)=>void, onSignOut:()=>void}} handlers
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

  function render({ access, user, notice, error }) {
    const state = access.state;

    if (state === ACCESS.LEGACY) {
      panel.hidden = true;
      setGated(false);
      return;
    }

    setGated(state !== ACCESS.GRANTED);
    panel.hidden = false;

    const who = user ? escapeHtml(user.displayName || user.email || "ログイン中") : "";
    const msg = [
      error ? `<p class="error-message" role="alert">${escapeHtml(error)}</p>` : "",
      notice ? `<p class="form-hint" role="status">${escapeHtml(notice)}</p>` : ""
    ].join("");

    if (state === ACCESS.LOADING) {
      panel.innerHTML = `<p class="form-hint" role="status">認証状態を確認しています…</p>${msg}`;
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

    // GRANTED
    panel.innerHTML = `
      <div class="feature-info">
        <p class="form-hint">ログイン中: ${who}
          <button type="button" class="btn btn-outline-sm" id="btnAuthSignOut">ログアウト</button></p>
        ${msg}
      </div>`;
    $("btnAuthSignOut").addEventListener("click", () => handlers.onSignOut());
  }

  return { render };
}
