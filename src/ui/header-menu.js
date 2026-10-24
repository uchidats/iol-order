import { escapeHtml } from "./dom.js";

/**
 * ヘッダーのメニュー（ログイン中のユーザー・施設名・施設の切り替え・ログアウト）
 * 施設選択UIを常時表示しないため、切り替えはここからのみ行う。
 * @param {{onSwitchFacility:()=>void, onSignOut:()=>void}} handlers
 */
export function createHeaderMenu(handlers) {
  const inner = document.querySelector(".header-inner");
  const wrap = document.createElement("div");
  wrap.className = "header-menu";
  wrap.hidden = true;
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

  return {
    /** @param {{user:object, facilityName:string, canSwitch:boolean}|null} info nullで非表示 */
    update(info) {
      if (!info) { wrap.hidden = true; setOpen(false); return; }
      wrap.hidden = false;
      const who = escapeHtml(info.user.displayName || info.user.email || "ログイン中");
      panel.innerHTML = `
        <div class="header-menu-info">
          <div class="header-menu-label">ログイン中</div><div>${who}</div>
          <div class="header-menu-label">施設</div><div>${escapeHtml(info.facilityName)}</div>
        </div>
        ${info.canSwitch ? '<button type="button" role="menuitem" class="header-menu-item" id="menuSwitchFacility">施設を切り替える</button>' : ""}
        <button type="button" role="menuitem" class="header-menu-item" id="menuSignOut">ログアウト</button>`;
      const sw = panel.querySelector("#menuSwitchFacility");
      if (sw) sw.addEventListener("click", () => { setOpen(false); handlers.onSwitchFacility(); });
      panel.querySelector("#menuSignOut").addEventListener("click", () => { setOpen(false); handlers.onSignOut(); });
    }
  };
}
