import { h } from "../ui/markdown-view.js";
import { describeCallableError } from "../data/registration-api.js";
import { createSectionHeading } from "../ui/info-tip.js";
import { confirmDialog } from "../ui/confirm-dialog.js";
import { DEALER_ROLE_LABELS, assignableRoles, staffActions, filterStaffByBranch, formatJstDateTime } from "../domain/dealer-portal.js";

const STATUS_LABELS = { active: "", disabled: "無効", invited: "参加待ち", expired: "招待の期限切れ" };
const STAFF_HELP = "自社の担当者を招待・編集できます。招待された人は、招待したメールアドレスに届く確認コードで本人確認をしてから参加します。"
  + "注文を閲覧できる範囲は会社単位です(支店による制限はありません)。会社管理者の任命・変更は会社管理者のみ行えます。自分自身の役割の変更・無効化はできません。";
const BRANCH_HELP = "支店は担当者を整理するための表示用です。注文を閲覧できる範囲は変わりません。担当者が所属している支店は無効にできません(先に担当者の所属支店を変更してください)。";
const select = (attrs, options, value = "") => {
  const s = h("select", { class: "form-control", ...attrs }, options.map(([v, t]) => h("option", { value: v }, t)));
  s.value = value;
  return s;
};

/**
 * ディーラー画面の「担当者・支店」(会社管理者・支店管理者)。自社の担当者の招待・編集・無効化・再有効化・招待の取消と、支店の追加・名称変更・無効化。
 * 表示する操作は役割に合わせて絞るが、実行の可否・会社の範囲はすべてサーバーが確かめる(dealerPortalApi の manage*)。表示する文字は textContent。
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
  const branchName = (id) => (data.branches.find(b => b.branchId === id) || {}).name || "支店未設定";
  const activeBranchOptions = (current = "") => [["", "支店未設定"], ...data.branches.filter(b => b.status === "active" || b.branchId === current).map(b => [b.branchId, b.name])];

  function inviteForm() {
    const email = h("input", { class: "form-control", type: "email", maxlength: "254", "data-f": "inviteEmail", placeholder: "勤務先メールアドレス", "aria-label": "勤務先メールアドレス", autocomplete: "off" });
    const name = h("input", { class: "form-control", type: "text", maxlength: "50", "data-f": "inviteName", placeholder: "氏名(任意)", "aria-label": "氏名", autocomplete: "off" });
    const role = select({ "data-f": "inviteRole", "aria-label": "役割" }, assignableRoles(data.me.role).map(r => [r, DEALER_ROLE_LABELS[r]]), "reader");
    const branch = select({ "data-f": "inviteBranch", "aria-label": "所属支店" }, activeBranchOptions());
    const btn = h("button", { type: "button", class: "btn btn-primary btn-sm-inline", "data-act": "invite" }, "招待");
    btn.addEventListener("click", () => {
      if (!email.value.trim()) { msg.textContent = "勤務先メールアドレスを入力してください"; return; }
      run(() => api.manageInvite({ companyId, email: email.value.trim(), name: name.value.trim(), role: role.value, ...(branch.value ? { branchId: branch.value } : {}) }),
        "招待しました。招待した人がこのメールアドレスでログインし、確認コードで本人確認をすると参加します。");
    });
    return h("details", { class: "dealer-manage-invite" }, h("summary", {}, "担当者を招待"),
      h("div", { class: "dealer-manage-grid" }, email, name, role, branch), h("div", { class: "form-row" }, btn));
  }

  function staffRow(s) {
    const can = staffActions(data.me.role, data.me.staffId, s);
    const status = s.status in STATUS_LABELS ? STATUS_LABELS[s.status] : s.status;   // 有効は表示しない
    const row = h("li", { class: "dealer-manage-staff", "data-staff": s.staffId, "data-branch": s.branchId || "" },
      h("div", { class: "dealer-manage-head" },
        h("span", { class: "dealer-manage-name" }, s.name || s.email),
        h("span", { class: "member-role-badge" }, DEALER_ROLE_LABELS[s.role] || s.role),
        status ? h("span", { class: "dealer-manage-status" }, status) : null,
        s.staffId === data.me.staffId ? h("span", { class: "dealer-manage-me" }, "(自分)") : null),
      h("div", { class: "dealer-manage-sub" }, [s.name ? s.email : "", branchName(s.branchId),
        s.status === "active" && !s.verified ? "本人確認前" : "", s.inviteExpiresAt ? `期限 ${formatJstDateTime(s.inviteExpiresAt)}` : ""].filter(Boolean).join(" ・ ")));
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

  /** 担当者の編集(氏名・所属支店、役割は権限の範囲だけ) */
  function editForm(s, can) {
    const name = h("input", { class: "form-control", type: "text", maxlength: "50", "data-f": "editName", value: s.name, "aria-label": "氏名" });
    const role = can.roleOptions.length ? select({ "data-f": "editRole", "aria-label": "役割" }, can.roleOptions.map(r => [r, DEALER_ROLE_LABELS[r]]), s.role) : null;
    const branch = select({ "data-f": "editBranch", "aria-label": "所属支店" }, activeBranchOptions(s.branchId || ""), s.branchId || "");
    const save = h("button", { type: "button", class: "btn btn-primary btn-sm-inline", "data-act": "saveStaff" }, "保存");
    const cancel = h("button", { type: "button", class: "btn btn-secondary btn-sm-inline", "data-act": "cancelEdit" }, "キャンセル");
    save.addEventListener("click", () => {
      const patch = {};
      if (name.value.trim() !== s.name) patch.name = name.value.trim();
      if (role && role.value !== s.role) patch.role = role.value;
      if ((branch.value || null) !== (s.branchId || null)) patch.branchId = branch.value || null;
      if (!Object.keys(patch).length) { render(); return; }
      run(() => api.manageUpdateStaff({ companyId, staffId: s.staffId, ...patch }), "担当者を変更しました。");
    });
    cancel.addEventListener("click", () => render());
    return h("div", { class: "dealer-manage-edit" }, h("div", { class: "dealer-manage-head" }, h("span", { class: "dealer-manage-name" }, s.email)),
      h("div", { class: "dealer-manage-grid" }, name, ...(role ? [role] : []), branch), h("div", { class: "form-row" }, save, cancel));
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

  function render() {
    const filterSel = select({ "data-f": "branchFilter", "aria-label": "支店で絞り込み", class: "form-control dealer-manage-filter" },
      [["all", "すべての支店"], ["none", "支店未設定"], ...data.branches.map(b => [b.branchId, b.status === "active" ? b.name : `${b.name}(無効)`])],
      [...["all", "none"], ...data.branches.map(b => b.branchId)].includes(filter) ? filter : "all");
    filterSel.addEventListener("change", () => { filter = filterSel.value; render(); });
    const staff = filterStaffByBranch(data.staff, filterSel.value);
    const newBranch = h("input", { class: "form-control", type: "text", maxlength: "100", "data-f": "newBranch", placeholder: "支店名", "aria-label": "追加する支店名" });
    const addBranch = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "addBranch" }, "追加");
    addBranch.addEventListener("click", () => {
      if (!newBranch.value.trim()) { msg.textContent = "支店名を入力してください"; return; }
      run(() => api.manageBranch({ companyId, name: newBranch.value.trim() }), "支店を追加しました。");
    });
    root.replaceChildren(
      h("div", { class: "settings-section dealer-manage-section", "data-section": "staff" },
        createSectionHeading("担当者", STAFF_HELP),
        h("div", { class: "dealer-manage-toolbar" }, filterSel, h("span", { class: "form-hint dealer-manage-count" }, `${staff.length}人`)),
        staff.length ? h("ul", { class: "dealer-manage-list" }, staff.map(staffRow)) : h("p", { class: "form-hint" }, "該当する担当者はいません。"),
        inviteForm()),
      h("div", { class: "settings-section dealer-manage-section", "data-section": "branches" },
        createSectionHeading("支店", BRANCH_HELP),
        data.branches.length ? h("ul", { class: "dealer-manage-list" }, data.branches.map(branchRow)) : h("p", { class: "form-hint" }, "支店はまだありません。"),
        h("div", { class: "dealer-manage-add" }, newBranch, addBranch)),
      msg);
  }

  root.append(h("p", { class: "form-hint" }, "読み込み中…"));
  return { root, load };
}
