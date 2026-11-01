import { h } from "../ui/markdown-view.js";

/**
 * ディーラー画面のヘッダーの「☰」メニュー。医療機関の画面(src/ui/header-menu.js)と同じ見た目・開閉の動作
 * (同じクラス名・ボタン・パネル。外側のクリック・Esc で閉じる)。項目はディーラー用だけ(施設・注文の項目は出さない)。
 * 「使い方・ヘルプ」はログインの前から使える(医療機関の画面と同じ)。氏名・会社名は、サーバーが本人確認・所属を確かめた後の
 * context の値だけ(確認前は会社名を出さない)。「ディーラー設定」は会社管理者・支店管理者だけに出す(表示だけ。操作の可否はサーバーが確認する)。
 * 表示は textContent。
 * @param {{ onSignOut: () => void, onSwitchCompany: () => void, onOpenSettings: () => void, onOpenHelp: () => void }} handlers
 */
export function createDealerHeaderMenu({ onSignOut, onSwitchCompany, onOpenSettings, onOpenHelp }) {
  const inner = document.querySelector(".header-inner");
  const btn = h("button", { type: "button", class: "header-menu-btn", id: "btnHeaderMenu", "aria-haspopup": "true", "aria-expanded": "false", "aria-label": "メニュー" });
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">'
    + '<line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="18" x2="20" y2="18"></line></svg>';
  const panel = h("div", { class: "header-menu-panel", id: "headerMenuPanel", role: "menu", hidden: true });
  const wrap = h("div", { class: "header-menu" }, btn, panel);
  inner.appendChild(wrap);

  const setOpen = (open) => { panel.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
  btn.addEventListener("click", (e) => { e.stopPropagation(); setOpen(panel.hidden); });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) setOpen(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
  const item = (id, label, fn) => {
    const b = h("button", { type: "button", role: "menuitem", class: "header-menu-item", id }, label);
    b.addEventListener("click", () => { setOpen(false); fn(); });
    return b;
  };

  const api = {
    /**
     * @param {null|{ name?: string, companyName?: string, branchName?: string, canSwitch?: boolean, canSettings?: boolean }} info
     *   null: 受注一覧より前(未ログイン・本人確認・会社の選択など)。「使い方・ヘルプ」だけ(ログアウトは画面のボタン)。
     *   会社名のある値: 受注一覧・試験モード(氏名・所属会社・ディーラー設定・会社の切り替え・使い方・ヘルプ・ログアウト)
     */
    update(info) {
      setOpen(false);
      const inPortal = Boolean(info && info.companyName);
      const who = inPortal
        ? h("div", { class: "header-menu-info" },
          h("div", { class: "header-menu-label" }, "ログイン中"), h("div", { "data-f": "menuName" }, info.name || "担当者"),
          h("div", { class: "header-menu-label" }, "所属会社"), h("div", { "data-f": "menuCompany" }, `${info.companyName}${info.branchName ? ` ${info.branchName}` : ""}`))
        : null;
      panel.replaceChildren(...[who,
        inPortal && info.canSettings ? item("menuDealerSettings", "ディーラー設定", onOpenSettings) : null,
        inPortal && info.canSwitch ? item("menuSwitchCompany", "会社を切り替える", onSwitchCompany) : null,
        item("menuHelp", "使い方・ヘルプ", onOpenHelp),
        inPortal ? item("menuSignOut", "ログアウト", onSignOut) : null].filter(Boolean));
    }
  };
  api.update(null);   // ログインの状態が分かる前から「使い方・ヘルプ」を使える
  return api;
}
