import { h } from "./markdown-view.js";
import { createSectionHeading } from "./info-tip.js";
import { confirmDialog } from "./confirm-dialog.js";
import { describeCallableError } from "../data/registration-api.js";
import { isPortalUnavailable } from "../data/dealer-portal-api.js";
import { DEALER_ACCESS_NOTICE, formatJstDateTime } from "../domain/dealer-portal.js";

const STATUS_LABEL = { proposed: "未許可", revoked: "取消済み(未許可)", active: "許可中" };

/**
 * 施設設定の「ディーラー画面での閲覧」(管理者・副管理者)。運営者が会社との関連付けを登録した発注先ごとに、
 * 閲覧の許可・取消を行う。権限・状態の確認はサーバー(facilityDealerPortal)。機能が止まっている・未配備のときは項目ごと表示しない。
 * @param {{api: ReturnType<import("../data/dealer-portal-api.js").createDealerPortalApi>}} deps
 */
export function createDealerPortalSection({ api }) {
  const list = h("div", { "data-list": "" });
  const msg = h("p", { class: "form-hint", "data-msg": "", role: "status" });
  const stopNote = h("p", { class: "form-hint", "data-stop-note": "", hidden: true }, "ディーラー画面は現在停止しています。許可中の発注先の取消だけができます(取り消すと、その発注先の名称・発注用メールを変更できます)。");
  const section = h("section", { class: "settings-section dealer-portal-section", "data-section": "dealerPortal", hidden: true },
    createSectionHeading("ディーラー画面での閲覧", `ディーラーが専用画面で、この施設の注文のうち自社宛ての明細を閲覧できるようにします。運営者がディーラーの会社を登録した発注先だけが対象です。許可は管理者・副管理者が行えます。\n\n${DEALER_ACCESS_NOTICE}`),
    h("p", { class: "form-hint dealer-portal-notice" }, DEALER_ACCESS_NOTICE),
    h("p", { class: "form-hint", "data-lock-note": "" }, "閲覧を許可している間は、その発注先の名称・宛名・発注用メールの変更と削除はできません。変更するときは、先に閲覧を取り消してください(改めて許可すると、その後の新しい注文から表示されます)。"),
    stopNote, list, msg);
  let facilityId = null;
  let busy = false;

  function row(d) {
    const l = d.link;
    const stale = l.status === "active" && l.grant && l.grant.stale === true;
    const state = stale ? "停止中(許可の後に発注先の名称・宛先が変更されたため、表示を止めています。取り消してから、改めて許可してください)"
      : l.status === "active" && l.grant ? `許可中(${formatJstDateTime(l.grant.effectiveFrom)} 以降の新規注文)` : (STATUS_LABEL[l.status] || "未許可");
    const btn = h("button", { type: "button", class: l.status === "active" ? "btn btn-outline-sm" : "btn btn-outline-sm btn-portal-grant", "data-act": l.status === "active" ? "revoke" : "grant", disabled: !l.companyActive && l.status !== "active" }, l.status === "active" ? "取り消す" : "許可する");
    btn.addEventListener("click", () => act(d, btn.dataset.act));
    return h("div", { class: "dealer-portal-item", "data-dealer": d.localDealerId },
      h("div", { class: "dealer-portal-main" },
        h("div", { class: "dealer-portal-name" }, d.dealerName),
        h("div", { class: "dealer-portal-meta" }, `会社: ${l.companyName || "—"} ・ `, h("span", { class: stale ? "dealer-portal-state is-stale" : l.status === "active" ? "dealer-portal-state is-active" : "dealer-portal-state", "data-state": stale ? "stale" : l.status }, state))),
      btn);
  }

  async function act(d, action) {
    if (busy) return;
    const message = action === "grant"
      ? `「${d.dealerName}」(会社: ${d.link.companyName})に、ディーラー画面での閲覧を許可しますか？\n\n${DEALER_ACCESS_NOTICE}\n\n許可より前の注文は表示されません。許可している間は、この発注先の名称・宛名・発注用メールの変更と削除はできません。`
      : `「${d.dealerName}」(会社: ${d.link.companyName})の閲覧の許可を取り消しますか？\n取消後は、新しい取得ができなくなります(すでに表示・保存された内容や、従来の注文メールは取り消せません)。`;
    if (!(await confirmDialog({ message, okLabel: action === "grant" ? "許可する" : "取り消す", cancelLabel: "キャンセル" }))) return;
    busy = true; msg.textContent = "";
    try {
      await (action === "grant" ? api.grant : api.revoke)({ facilityId, localDealerId: d.localDealerId, revision: d.link.revision });
      msg.textContent = action === "grant" ? "閲覧を許可しました。" : "閲覧の許可を取り消しました。";
      await render(facilityId, { keepMessage: true });
    } catch (e) {
      msg.textContent = describeCallableError(e);
      await render(facilityId, { keepMessage: true }).catch(() => {});
    } finally { busy = false; }
  }

  /** 施設を開いたときに読み込む(失敗しても施設設定の他の項目は使える) */
  async function render(fid, { keepMessage = false } = {}) {
    facilityId = fid;
    if (!keepMessage) msg.textContent = "";
    try {
      const r = await api.facilityStatus({ facilityId: fid });
      if (fid !== facilityId) return;
      // 機能の停止中: 許可中の発注先の取消だけができる(発注先の名称・メールを変更するために取り消せるように)。許可中がなければ項目を出さない
      const stopped = r.portalEnabled === false;
      const linked = (r.dealers || []).filter(d => d.link && (!stopped || d.link.status === "active"));
      if (stopped && !linked.length) { section.hidden = true; return; }
      section.hidden = false;
      stopNote.hidden = !stopped;
      list.replaceChildren(...(linked.length ? linked.map(row) : [h("p", { class: "form-hint" }, "ディーラー画面を利用する発注先は、まだ登録されていません(運営者がディーラーの会社を登録すると、ここに表示されます)。")]));
    } catch (e) {
      if (isPortalUnavailable(e)) { section.hidden = true; return; }
      section.hidden = false;
      list.replaceChildren();
      msg.textContent = describeCallableError(e);
    }
  }

  section._render = (fid) => render(fid).catch(() => {});
  return section;
}
