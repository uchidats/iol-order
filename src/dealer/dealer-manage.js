import { h } from "../ui/markdown-view.js";
import { describeCallableError } from "../data/registration-api.js";
import { createSectionHeading } from "../ui/info-tip.js";
import { confirmDialog } from "../ui/confirm-dialog.js";
import { DEALER_ROLE_LABELS, assignableRoles, staffActions, filterStaffByBranch, formatJstDateTime } from "../domain/dealer-portal.js";

const STATUS_LABELS = { active: "", disabled: "無効", invited: "参加待ち", expired: "招待の期限切れ" };
const STAFF_HELP_COMPANY = "自社の担当者を招待・編集できます。招待された人は、招待したメールアドレスに届く確認コードで本人確認をしてから参加します。"
  + "注文を閲覧できる範囲は会社単位です(支店による制限はありません)。自分自身の役割の変更・無効化はできません。";
const STAFF_HELP_BRANCH = "自分の支店の閲覧者を招待・編集できます。招待された人は、招待したメールアドレスに届く確認コードで本人確認をしてから参加します。"
  + "注文を閲覧できる範囲は会社単位です(支店による制限はありません)。支店の追加・変更、支店管理者・会社管理者の任命・解除、他の支店への異動は会社管理者が行います。";
const BRANCH_HELP = "支店は担当者を整理するための表示用です。注文を閲覧できる範囲は変わりません。担当者が所属している支店は無効にできません(先に担当者の所属支店を変更してください)。";
const FACILITY_HINT = "担当施設(表示用。受注一覧の初期選択に使い、閲覧できる範囲は変わりません)";
const select = (attrs, options, value = "") => {
  const s = h("select", { class: "form-control", ...attrs }, options.map(([v, t]) => h("option", { value: v }, t)));
  s.value = value;
  return s;
};

/**
 * ディーラー画面の「担当者・支店」(会社管理者・支店管理者)。
 * 会社管理者: 自社の担当者の招待・編集・無効化・再有効化・招待の取消・担当施設、支店の追加・名称変更・無効化。
 * 支店管理者: 自分の支店の閲覧者の招待・編集・無効化・再有効化・招待の取消・担当施設(サーバーは自分の支店の担当者だけを返す)。
 * 表示する操作は役割に合わせて絞るが、実行の可否・会社と支店の範囲はすべてサーバーが確かめる(dealerPortalApi の manage*)。表示する文字は textContent。
 * @param {{api:object, companyId:string, onAuthError:(e:any)=>void}} deps
 */
export function createDealerManage({ api, companyId, onAuthError = () => {} }) {
  const root = h("section", { class: "dealer-manage", id: "dealerManage" });
  const msg = h("p", { class: "form-hint", role: "status", id: "dealerManageMsg" });
  let data = null, busy = false, filter = "all";

  async function load() {
    try { data = await api.manage({ companyId }); render(); }
    catch (e) { msg.textContent = describeCallableError(e); onAuthError(e); }
  }
  /** 操作の共通処理(二重送信の防止・結果の表示・読み直し) */
  async function run(task, done) {
    if (busy) return;
    busy = true; msg.textContent = "保存しています…";
    try { await task(); await load(); msg.textContent = done; }
    catch (e) { msg.textContent = describeCallableError(e); onAuthError(e); }
    finally { busy = false; }
  }
  const isCompanyAdmin = () => data.me.role === "companyAdmin";
  const branchName = (id) => (data.branches.find(b => b.branchId === id) || {}).name || "支店未設定";
  const activeBranchOptions = (current = "") => [["", "支店未設定"], ...data.branches.filter(b => b.status === "active" || b.branchId === current).map(b => [b.branchId, b.name])];
  const facilityName = (id) => (data.facilities.find(f => f.facilityId === id) || {}).name || "";

  function inviteForm() {
    // 支店管理者: 役割は閲覧者、所属支店は自分の支店に固定(所属支店のない支店管理者は招待できない)
    if (!isCompanyAdmin() && !data.me.branchId) return h("p", { class: "form-hint", "data-notice": "no-branch" }, "所属支店が設定されていないため、担当者を招待できません。会社管理者に所属支店の設定を依頼してください。");
    const email = h("input", { class: "form-control", type: "email", maxlength: "254", "data-f": "inviteEmail", placeholder: "勤務先メールアドレス", "aria-label": "勤務先メールアドレス", autocomplete: "off" });
    const name = h("input", { class: "form-control", type: "text", maxlength: "50", "data-f": "inviteName", placeholder: "氏名(任意)", "aria-label": "氏名", autocomplete: "off" });
    const roles = assignableRoles(data.me.role);
    const role = roles.length > 1 ? select({ "data-f": "inviteRole", "aria-label": "役割" }, roles.map(r => [r, DEALER_ROLE_LABELS[r]]), "reader") : null;
    const branch = isCompanyAdmin() ? select({ "data-f": "inviteBranch", "aria-label": "所属支店" }, activeBranchOptions()) : null;
    const fixed = isCompanyAdmin() ? null : h("p", { class: "form-hint" }, `${branchName(data.me.branchId)} の閲覧者として招待します。`);
    const btn = h("button", { type: "button", class: "btn btn-primary btn-sm-inline", "data-act": "invite" }, "招待");
    btn.addEventListener("click", () => {
      if (!email.value.trim()) { msg.textContent = "勤務先メールアドレスを入力してください"; return; }
      const branchId = branch ? branch.value : data.me.branchId;
      run(() => api.manageInvite({ companyId, email: email.value.trim(), name: name.value.trim(), role: role ? role.value : "reader", ...(branchId ? { branchId } : {}) }),
        "招待しました。招待した人がこのメールアドレスでログインし、確認コードで本人確認をすると参加します。");
    });
    return h("details", { class: "dealer-manage-invite" }, h("summary", {}, "担当者を招待"),
      h("div", { class: "dealer-manage-grid" }, email, name, ...(role ? [role] : []), ...(branch ? [branch] : [])), fixed, h("div", { class: "form-row" }, btn));
  }

  function staffRow(s) {
    const can = staffActions(data.me, s);
    const status = s.status in STATUS_LABELS ? STATUS_LABELS[s.status] : s.status;   // 有効は表示しない
    const facilities = (s.facilityIds || []).map(facilityName).filter(Boolean);
    const row = h("li", { class: "dealer-manage-staff", "data-staff": s.staffId, "data-branch": s.branchId || "" },
      h("div", { class: "dealer-manage-head" },
        h("span", { class: "dealer-manage-name" }, s.name || s.email),
        h("span", { class: "member-role-badge" }, DEALER_ROLE_LABELS[s.role] || s.role),
        status ? h("span", { class: "dealer-manage-status" }, status) : null,
        s.staffId === data.me.staffId ? h("span", { class: "dealer-manage-me" }, "(自分)") : null),
      h("div", { class: "dealer-manage-sub" }, [s.name ? s.email : "", branchName(s.branchId),
        s.status === "active" && !s.verified ? "本人確認前" : "", s.inviteExpiresAt ? `期限 ${formatJstDateTime(s.inviteExpiresAt)}` : ""].filter(Boolean).join(" ・ ")),
      facilities.length ? h("div", { class: "dealer-manage-sub", "data-f": "assigned" }, `担当施設: ${facilities.join("、")}`) : null);
    const actions = h("div", { class: "dealer-manage-actions" });
    if (can.edit) {
      const b = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "edit" }, "編集");
      b.addEventListener("click", () => row.replaceChildren(editForm(s, can)));
      actions.append(b);
    }
    if (can.toggle) {
      const disabling = s.status === "active";
      const b = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "toggleStaff" }, disabling ? "無効にする" : "有効に戻す");
      b.addEventListener("click", async () => {
        if (disabling && !(await confirmDialog({ message: `${s.name || s.email} を無効にしますか？\n次の操作から、ディーラー画面を利用できなくなります(有効に戻すと、本人確認をし直して利用できます)。`, okLabel: "無効にする" }))) return;
        run(() => api.manageUpdateStaff({ companyId, staffId: s.staffId, status: disabling ? "disabled" : "active" }), disabling ? "無効にしました。" : "有効に戻しました。");
      });
      actions.append(b);
    }
    if (can.cancel) {
      const b = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "cancelInvite" }, "招待を取り消す");
      b.addEventListener("click", () => run(() => api.manageCancelInvite({ companyId, staffId: s.staffId }), "招待を取り消しました。"));
      actions.append(b);
    }
    if (actions.childNodes.length) row.append(actions);
    return row;
  }

  /** 担当者の編集(氏名・担当施設。役割・所属支店は権限の範囲だけ) */
  function editForm(s, can) {
    const name = h("input", { class: "form-control", type: "text", maxlength: "50", "data-f": "editName", value: s.name, "aria-label": "氏名" });
    const role = can.roleOptions.length > 1 ? select({ "data-f": "editRole", "aria-label": "役割" }, can.roleOptions.map(r => [r, DEALER_ROLE_LABELS[r]]), s.role) : null;
    const branch = can.branch ? select({ "data-f": "editBranch", "aria-label": "所属支店" }, activeBranchOptions(s.branchId || ""), s.branchId || "") : null;
    const assigned = new Set(s.facilityIds || []);
    const checks = data.facilities.map(f => {
      const cb = h("input", { type: "checkbox", value: f.facilityId, "data-f": "editFacility" });
      cb.checked = assigned.has(f.facilityId);
      return h("label", { class: "settings-check" }, cb, h("span", {}, f.name));
    });
    const save = h("button", { type: "button", class: "btn btn-primary btn-sm-inline", "data-act": "saveStaff" }, "保存");
    const cancel = h("button", { type: "button", class: "btn btn-secondary btn-sm-inline", "data-act": "cancelEdit" }, "キャンセル");
    save.addEventListener("click", () => {
      const patch = {};
      if (name.value.trim() !== s.name) patch.name = name.value.trim();
      if (role && role.value !== s.role) patch.role = role.value;
      if (branch && (branch.value || null) !== (s.branchId || null)) patch.branchId = branch.value || null;
      const ids = checks.map(l => l.querySelector("input")).filter(i => i.checked).map(i => i.value);
      if (ids.length !== assigned.size || ids.some(id => !assigned.has(id))) patch.facilityIds = ids;
      if (!Object.keys(patch).length) { render(); return; }
      run(() => api.manageUpdateStaff({ companyId, staffId: s.staffId, ...patch }), "担当者を変更しました。");
    });
    cancel.addEventListener("click", () => render());
    return h("div", { class: "dealer-manage-edit" }, h("div", { class: "dealer-manage-head" }, h("span", { class: "dealer-manage-name" }, s.email)),
      h("div", { class: "dealer-manage-grid" }, name, ...(role ? [role] : []), ...(branch ? [branch] : [])),
      checks.length ? h("div", { class: "dealer-manage-assign" }, h("span", { class: "form-hint" }, FACILITY_HINT), ...checks)
        : h("p", { class: "form-hint" }, "閲覧を許可された施設がまだないため、担当施設は選べません。"),
      h("div", { class: "form-row" }, save, cancel));
  }

  function branchRow(b) {
    const row = h("li", { class: "dealer-manage-branch", "data-branch": b.branchId },
      h("span", { class: "dealer-manage-name" }, b.name), b.status === "inactive" ? h("span", { class: "dealer-manage-status" }, "無効") : null);
    const rename = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "renameBranch" }, "名称変更");
    rename.addEventListener("click", () => {
      const input = h("input", { class: "form-control", type: "text", maxlength: "100", "data-f": "branchName", value: b.name, "aria-label": "支店名" });
      const save = h("button", { type: "button", class: "btn btn-primary btn-sm-inline", "data-act": "saveBranch" }, "保存");
      const cancel = h("button", { type: "button", class: "btn btn-secondary btn-sm-inline" }, "キャンセル");
      save.addEventListener("click", () => run(() => api.manageBranch({ companyId, branchId: b.branchId, name: input.value.trim() }), "支店名を変更しました。"));
      cancel.addEventListener("click", () => render());
      row.replaceChildren(input, h("div", { class: "form-row" }, save, cancel));
    });
    const toggle = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "toggleBranch" }, b.status === "active" ? "無効にする" : "有効に戻す");
    toggle.addEventListener("click", () => run(() => api.manageBranch({ companyId, branchId: b.branchId, name: b.name, status: b.status === "active" ? "inactive" : "active" }),
      b.status === "active" ? "支店を無効にしました。" : "支店を有効に戻しました。"));
    row.append(h("div", { class: "dealer-manage-actions" }, rename, toggle));
    return row;
  }

  /** 支店(会社管理者だけ) */
  function branchSection() {
    const newBranch = h("input", { class: "form-control", type: "text", maxlength: "100", "data-f": "newBranch", placeholder: "支店名", "aria-label": "追加する支店名" });
    const addBranch = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "addBranch" }, "追加");
    addBranch.addEventListener("click", () => {
      if (!newBranch.value.trim()) { msg.textContent = "支店名を入力してください"; return; }
      run(() => api.manageBranch({ companyId, name: newBranch.value.trim() }), "支店を追加しました。");
    });
    return h("div", { class: "settings-section dealer-manage-section", "data-section": "branches" },
      createSectionHeading("支店", BRANCH_HELP),
      data.branches.length ? h("ul", { class: "dealer-manage-list" }, data.branches.map(branchRow)) : h("p", { class: "form-hint" }, "支店はまだありません。"),
      h("div", { class: "dealer-manage-add" }, newBranch, addBranch));
  }

  function render() {
    const ca = isCompanyAdmin();
    // 支店の絞り込みは会社管理者だけ(支店管理者には自分の支店の担当者だけが届く)
    const filterSel = ca ? select({ "data-f": "branchFilter", "aria-label": "支店で絞り込み", class: "form-control dealer-manage-filter" },
      [["all", "すべての支店"], ["none", "支店未設定"], ...data.branches.map(b => [b.branchId, b.status === "active" ? b.name : `${b.name}(無効)`])],
      [...["all", "none"], ...data.branches.map(b => b.branchId)].includes(filter) ? filter : "all") : null;
    if (filterSel) filterSel.addEventListener("change", () => { filter = filterSel.value; render(); });
    const staff = filterStaffByBranch(data.staff, filterSel ? filterSel.value : "all");
    root.replaceChildren(
      h("div", { class: "settings-section dealer-manage-section", "data-section": "staff" },
        createSectionHeading(ca ? "担当者" : `担当者(${branchName(data.me.branchId)})`, ca ? STAFF_HELP_COMPANY : STAFF_HELP_BRANCH),
        h("div", { class: "dealer-manage-toolbar" }, filterSel, h("span", { class: "form-hint dealer-manage-count" }, `${staff.length}人`)),
        staff.length ? h("ul", { class: "dealer-manage-list" }, staff.map(staffRow)) : h("p", { class: "form-hint" }, "該当する担当者はいません。"),
        inviteForm()),
      ca ? branchSection() : null,
      msg);
  }

  root.append(h("p", { class: "form-hint" }, "読み込み中…"));
  return { root, load };
}
