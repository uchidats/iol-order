import { escapeHtml } from "./dom.js";
import { openShareDialog } from "./share-site.js";

/**
 * ヘッダーのメニュー（ログイン中のユーザー・施設名・施設の切り替え・ログアウト）
 * 施設選択UIを常時表示しないため、切り替えはここからのみ行う。「サイトを共有」は、ログインしていなくても(施設に入る前でも)使える。
 * @param {{onOpenHistory:()=>void, onSwitchFacility:()=>void, onOpenSettings:()=>void, onRegisterFacility:()=>void, onSignOut:()=>void}} handlers
 */
export function createHeaderMenu(handlers) {
  const inner = document.querySelector(".header-inner");
  const wrap = document.createElement("div");
  wrap.className = "header-menu";
  wrap.hidden = false;   // 「サイトを共有」はログインの前から使えるので、常に表示する
  wrap.innerHTML = `
    <button type="button" class="header-menu-btn" id="btnHeaderMenu" aria-haspopup="true" aria-expanded="false" aria-label="メニュー">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="18" x2="20" y2="18"></line>
      </svg>
    </button>
    <div class="header-menu-panel" id="headerMenuPanel" role="menu" hidden></div>`;
  inner.appendChild(wrap);

  const btn = wrap.querySelector("#btnHeaderMenu");
  const panel = wrap.querySelector("#headerMenuPanel");

  const setOpen = (open) => {
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.addEventListener("click", (e) => { e.stopPropagation(); setOpen(panel.hidden); });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) setOpen(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });

  const api = {
    /** @param {{user:object, facilityName:string, canSwitch:boolean, canSettings:boolean}|null} info null(施設に入る前・未ログイン)は「サイトを共有」だけ（canSettings は施設管理者のみ true） */
    update(info) {
      const share = '<button type="button" role="menuitem" class="header-menu-item" id="menuShareSite">サイトを共有</button>';
      const bindShare = () => panel.querySelector("#menuShareSite").addEventListener("click", () => { setOpen(false); openShareDialog(); });
      if (!info) { setOpen(false); panel.innerHTML = share; bindShare(); return; }
      const who = escapeHtml(info.user.displayName || info.user.email || "ログイン中");
      panel.innerHTML = `
        <div class="header-menu-info">
          <div class="header-menu-label">ログイン中</div><div>${who}</div>
          <div class="header-menu-label">施設</div><div>${escapeHtml(info.facilityName)}</div>
        </div>
        <button type="button" role="menuitem" class="header-menu-item" id="menuOrderHistory">注文履歴</button>
        ${info.canSettings ? '<button type="button" role="menuitem" class="header-menu-item" id="menuFacilitySettings">施設設定</button>' : ""}
        ${info.canSwitch ? '<button type="button" role="menuitem" class="header-menu-item" id="menuSwitchFacility">施設を切り替える</button>' : ""}
        ${info.canApprove ? '<button type="button" role="menuitem" class="header-menu-item" id="menuApplications">施設登録の申請</button>' : ""}
        ${info.canPreregister ? '<button type="button" role="menuitem" class="header-menu-item" id="menuPreregistrations">施設を事前登録</button>' : ""}
        <button type="button" role="menuitem" class="header-menu-item" id="menuRegisterFacility">新しい施設を登録</button>
        ${share}
        <button type="button" role="menuitem" class="header-menu-item" id="menuSignOut">ログアウト</button>`;
      bindShare();
      panel.querySelector("#menuOrderHistory").addEventListener("click", () => { setOpen(false); handlers.onOpenHistory(); });
      const st = panel.querySelector("#menuFacilitySettings");
      if (st) st.addEventListener("click", () => { setOpen(false); handlers.onOpenSettings(); });
      const sw = panel.querySelector("#menuSwitchFacility");
      if (sw) sw.addEventListener("click", () => { setOpen(false); handlers.onSwitchFacility(); });
      const ap = panel.querySelector("#menuApplications");   // 施設登録の承認権限のある運営者だけ(表示のみ。権限はサーバーが確認する)
      if (ap) ap.addEventListener("click", () => { setOpen(false); handlers.onOpenApplications(); });
      const pr = panel.querySelector("#menuPreregistrations");   // 運営者(platformAdmin)だけ(表示のみ。権限はサーバーが確認する)
      if (pr) pr.addEventListener("click", () => { setOpen(false); handlers.onOpenPreregistrations(); });
      panel.querySelector("#menuRegisterFacility").addEventListener("click", () => { setOpen(false); handlers.onRegisterFacility(); });
      panel.querySelector("#menuSignOut").addEventListener("click", () => { setOpen(false); handlers.onSignOut(); });
    }
  };
  api.update(null);   // ログイン状態が分かる前から「サイトを共有」を使える
  return api;
}
