import { h } from "./markdown-view.js";
import { createInfoTip } from "./info-tip.js";
import { createStickerSettingsSection } from "./sticker-settings-section.js";

const HELP = "IOLシール写真の台紙とQRコードを表示・印刷できます。ほかの設定は、施設の管理者・副管理者が行います。";

/**
 * 注文者・代理入力者の「施設設定」。「IOLシール写真」の欄だけを出す(表示・印刷だけ。変更の操作は出さない)。
 * 管理者・副管理者の施設設定(facility-settings.js)は使わず、ほかの設定項目は読み込みも表示もしない。
 * 権限はサーバーが毎回確かめる(この画面は表示の出し分けだけ)。
 * @param {object} deps
 * @param {Element} deps.mount
 * @param {ReturnType<import("../data/sticker-settings-api.js").createStickerSettingsApi>} deps.api
 * @param {(facilityId:string) => Promise<Array<object>>} [deps.listDealers] 施設の発注先(台紙の上部の表示の初期値。読むだけ)
 * @param {() => void} deps.onClose
 */
export function createStickerSettingsView({ mount, api, listDealers = async () => [], onClose }) {
  const root = h("section", { id: "stickerSettingsView", class: "settings-view", hidden: true });
  mount.insertBefore(root, mount.firstChild);
  let open = false, dealers = [], facilityId = null;
  const title = h("span", { class: "settings-facility" });
  const closeBtn = h("button", { type: "button", class: "btn btn-outline-sm", id: "btnSettingsClose" }, "注文画面に戻る");
  const status = h("p", { class: "form-hint", role: "status" });
  const section = createStickerSettingsSection({ api, getDealers: () => dealers, canManage: false });
  root.append(
    h("div", { class: "settings-head" }, h("div", { class: "settings-heading" }, h("h2", {}, "施設設定"), createInfoTip(HELP, { label: "施設設定の説明" }).root), title, closeBtn),
    status, section);

  function close() {
    section._clear();
    open = false; facilityId = null;
    root.hidden = true;
  }
  closeBtn.addEventListener("click", () => { close(); onClose(); });

  return {
    isOpen: () => open,
    /** 保存していない入力はない(変更の操作がない)ので、確認なしで閉じる */
    requestClose: async () => { close(); return true; },
    async open(fac) {
      facilityId = fac.id; dealers = [];
      title.textContent = fac.name;
      status.textContent = "読み込み中…";
      root.hidden = false;
      open = true;
      try { const list = await listDealers(fac.id); if (open && facilityId === fac.id) dealers = list; } catch { /* 発注先を読めなくても、台紙は印刷できる(上部の表示は手で入力) */ }
      if (!open || facilityId !== fac.id) return;
      await section._render(fac.id, fac.name);
      if (!open || facilityId !== fac.id) return;
      status.textContent = section.hidden ? "IOLシール写真は、現在ご利用いただけません。" : "";
    },
    close
  };
}
