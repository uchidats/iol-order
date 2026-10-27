/**
 * 施設登録の申請の一覧・承認・却下(施設登録の承認権限を持つ人だけ。現在は運営者のみ)。
 * 権限の判定・二重承認の防止・自分の申請の承認の禁止は、すべてサーバー(functions/src/facility-applications.js)で行う。
 * 画面は申請の内容(施設名・申請者名・メールアドレス・申請日時・既存施設との重複候補)を表示し、承認・却下を送るだけ。
 */
import { confirmDialog } from "./confirm-dialog.js";
import { describeCallableError } from "../data/registration-api.js";

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

const formatJst = (ms) => {
  if (!ms) return "—";
  const d = new Date(ms + 9 * 3600 * 1000), p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};
const NOTIFY_LABELS = { pending: "通知待ち", sending: "通知中", accepted: "運営者に通知済み", failed: "通知に失敗", held: "通知停止中(メール送信は停止中)", not_configured: "通知先が未設定" };
const STATUS_LABELS = { approved: "承認", rejected: "却下" };

/** ゴミ箱アイコン(装飾。ボタンの aria-label で意味を伝える) */
function trashIcon() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(k, v);
  for (const d of ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6", "M10 11v6", "M14 11v6"]) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); svg.appendChild(p); }
  return svg;
}

/**
 * @param {{mount:HTMLElement, api:{listFacilityApplications:Function, decideFacilityApplication:Function}, onClose:()=>void}} deps
 */
export function createFacilityApplications({ mount, api, onClose }) {
  const root = h("section", { id: "facilityApplications", class: "settings-view facility-applications", hidden: true });
  mount.insertBefore(root, mount.firstChild);
  const closeBtn = h("button", { type: "button", class: "btn btn-secondary", id: "btnApplicationsClose" }, "注文画面に戻る");
  const status = h("p", { class: "form-hint", role: "status" });
  const body = h("div", {});
  root.append(h("div", { class: "settings-head" }, h("h2", {}, "施設登録の申請"), closeBtn), status, body);
  let open = false, busy = false;
  closeBtn.addEventListener("click", () => { close(); onClose(); });
  function close() { open = false; root.hidden = true; }

  /** 申請の削除(運営者のみ。審査中・却下済みだけ。承認済みには出さない。権限・状態はサーバーでも確認する) */
  function deleteButton(a, errEl) {
    const btn = h("button", { type: "button", class: "application-delete", "data-act": "delete", title: "申請を削除", "aria-label": `「${a.name}」の申請を削除` }, trashIcon());
    btn.addEventListener("click", async () => {
      if (busy) return;
      const ok = await confirmDialog({ message: `「${a.name}」の申請を削除しますか？
削除すると元に戻せません(削除の記録は残ります)。`, okLabel: "削除する", cancelLabel: "キャンセル" });
      if (!ok) return;
      busy = true; btn.disabled = true; if (errEl) errEl.textContent = "";
      try {
        await api.deleteFacilityApplication({ applicationId: a.id });
        status.textContent = `「${a.name}」の申請を削除しました。`;
        await load();
      } catch (e) {
        if (errEl) errEl.textContent = describeCallableError(e); else status.textContent = describeCallableError(e);
      } finally { busy = false; btn.disabled = false; }
    });
    return btn;
  }

  function pendingCard(a) {
    const dup = a.duplicates || {};
    const self = h("input", { type: "radio", name: `admin-${a.id}`, value: "applicant", checked: true });
    const other = h("input", { type: "radio", name: `admin-${a.id}`, value: "other" });
    const nameIn = h("input", { class: "form-control", type: "text", maxlength: "50", "data-f": "adminName", placeholder: "お名前", "aria-label": "最初の管理者のお名前" });
    const emailIn = h("input", { class: "form-control", type: "email", maxlength: "254", "data-f": "adminEmail", placeholder: "メールアドレス", "aria-label": "最初の管理者のメールアドレス" });
    const otherBox = h("div", { class: "application-other-admin", hidden: true }, nameIn, emailIn,
      h("p", { class: "form-hint" }, "指定した人が、このメールアドレス(確認済み)でログインして参加を承諾したときに、管理者になります。"));
    const reason = h("input", { class: "form-control", type: "text", maxlength: "200", "data-f": "reason", placeholder: "却下の理由(任意)", "aria-label": "却下の理由" });
    const approve = h("button", { type: "button", class: "btn btn-primary", "data-act": "approve" }, "承認");
    const reject = h("button", { type: "button", class: "btn btn-secondary", "data-act": "reject" }, "却下");
    const err = h("p", { class: "error-message", "data-err": "" });
    for (const r of [self, other]) r.addEventListener("change", () => { otherBox.hidden = !other.checked; });

    const decide = async (decision) => {
      if (busy) return;
      const req = { applicationId: a.id, decision };
      if (decision === "approve" && other.checked) req.firstAdmin = { name: nameIn.value.trim(), email: emailIn.value.trim() };
      if (decision === "reject" && reason.value.trim()) req.reason = reason.value.trim();
      const ok = await confirmDialog({
        message: decision === "approve"
          ? `「${a.name}」を承認しますか？\n施設が有効になり、${other.checked ? "指定した人が参加を承諾すると" : "申請者が"}最初の管理者になります。`
          : `「${a.name}」の申請を却下しますか？`,
        okLabel: decision === "approve" ? "承認する" : "却下する", cancelLabel: "キャンセル"
      });
      if (!ok) return;
      busy = true; err.textContent = ""; approve.disabled = reject.disabled = true;
      try {
        let r = await api.decideFacilityApplication(req);
        if (r.status === "duplicate-candidate") {
          const again = await confirmDialog({ message: `同じ名前の施設が既にあります(${(r.candidates || []).join("、") || "同名の施設"})。\n別の施設として承認しますか？`, okLabel: "承認する", cancelLabel: "キャンセル" });
          if (!again) return;
          r = await api.decideFacilityApplication({ ...req, confirmDuplicate: true });
        }
        status.textContent = r.status === "approved" ? `「${a.name}」を承認しました。` : `「${a.name}」を却下しました。`;
        await load();
      } catch (e) {
        err.textContent = describeCallableError(e);
      } finally {
        busy = false; approve.disabled = reject.disabled = false;
      }
    };
    approve.addEventListener("click", () => decide("approve"));
    reject.addEventListener("click", () => decide("reject"));

    return h("li", { class: "application-item", "data-application": a.id },
      h("div", { class: "application-name-row" }, h("div", { class: "application-name" }, a.name), deleteButton(a, err)),
      h("div", { class: "form-hint" }, `申請者: ${a.applicant.name || "（未入力）"} ・ ${a.applicant.email} ・ 申請日時 ${formatJst(a.createdAt)}`),
      h("div", { class: "form-hint" }, `通知: ${NOTIFY_LABELS[a.notification && a.notification.status] || "—"}`),
      dup.exact || dup.similarCount
        ? h("p", { class: "application-dup" }, `既存の施設と重複の可能性があります(${dup.exact ? "同じ名前の施設あり" : `似た名前の施設 ${dup.similarCount}件`}${dup.candidates && dup.candidates.length ? `: ${dup.candidates.join("、")}` : ""})`)
        : null,
      h("div", { class: "application-admin" }, h("span", { class: "form-label" }, "最初の管理者"),
        h("label", { class: "settings-check" }, self, h("span", {}, "申請者")),
        h("label", { class: "settings-check" }, other, h("span", {}, "別の責任者を指定"))),
      otherBox, reason,
      h("div", { class: "form-row application-actions" }, reject, approve), err);
  }

  function recentRow(a) {
    const admin = a.firstAdmin ? ` ・ 最初の管理者: ${a.firstAdmin.type === "designated" ? `${a.firstAdmin.name || ""}(${a.firstAdmin.email}・参加の承諾待ち/済み)` : "申請者"}` : "";
    return h("li", { class: "application-recent", "data-application": a.id },
      h("div", { class: "application-name-row" }, h("span", {}, h("span", { class: `application-status is-${a.status}` }, STATUS_LABELS[a.status] || a.status), " ",
        h("strong", {}, a.name)), a.status === "rejected" ? deleteButton(a, null) : null),
      h("div", { class: "form-hint" }, `${formatJst(a.decidedAt)} ・ ${a.decidedBy ? (a.decidedBy.name || a.decidedBy.email) : "—"}${admin}${a.reason ? ` ・ 理由: ${a.reason}` : ""}`),
      h("div", { class: "form-hint" }, `申請者: ${a.applicant.name || "（未入力）"} ・ ${a.applicant.email}`));
  }

  async function load() {
    const r = await api.listFacilityApplications();
    body.replaceChildren(
      h("h3", {}, `審査中(${r.pending.length}件)`),
      r.pending.length ? h("ul", { class: "application-list" }, r.pending.map(pendingCard)) : h("p", { class: "form-hint" }, "審査中の申請はありません。"),
      h("h3", {}, "最近の承認・却下"),
      r.recent.length ? h("ul", { class: "application-list" }, r.recent.map(recentRow)) : h("p", { class: "form-hint" }, "まだありません。"));
  }

  return {
    isOpen: () => open,
    async open() {
      open = true; root.hidden = false; status.textContent = "読み込み中…"; body.replaceChildren();
      try { await load(); status.textContent = ""; }
      catch (e) { status.textContent = describeCallableError(e); }
    },
    close
  };
}
