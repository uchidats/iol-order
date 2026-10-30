import { h } from "./markdown-view.js";
import { confirmDialog } from "./confirm-dialog.js";
import { describeCallableError } from "../data/registration-api.js";
import { formatJstDateTime } from "../domain/dealer-portal.js";
import { createInfoTip, createSectionHeading } from "./info-tip.js";

const ROLE_LABELS = { reader: "閲覧者", branchAdmin: "支店管理者", companyAdmin: "会社管理者" };
const STAFF_STATUS = { active: "有効", disabled: "無効(退職など)" };
const LOGIN_LABELS = { google: "Google", microsoft: "Microsoft", device: "確認済みの端末" };
// 「発注先と会社の関連付け」の説明(ⓘ)。用語の説明の後に、従来の注意をそのまま
export const LINK_HELP = [
  "発注先: 各施設が施設設定の「ディーラー」に登録した、注文メールの送信先です。",
  "会社: ディーラーの担当者のログインと、注文を閲覧できる範囲を管理する単位です。",
  "発注先を会社に関連付けると、施設の管理者・副管理者が許可した後の新規注文のうち、その発注先宛ての明細を、その会社の担当者が閲覧できます。",
  "関連付けだけでは閲覧は始まりません。施設の管理者・副管理者の許可が必要です。閲覧を許可中の関連付けは変更できません(施設で取消してから変更します)。"
].join("\n");
const LINK_LABELS = { proposed: "関連付け済み(施設の許可待ち)", active: "施設が閲覧を許可中", revoked: "施設が取消済み" };
const newRequestId = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);
const field = (label, input) => h("label", { class: "form-label" }, h("span", {}, label), input);
const select = (attrs, options) => h("select", { class: "form-control", ...attrs }, options.map(([v, t]) => h("option", { value: v }, t)));

/**
 * ディーラー管理(運営者 = platformAdmin のみ。権限はサーバーが確認する)。
 * 会社の登録・停止、任意の支店、担当者の招待・無効化・役割・支店・担当施設(代行)、施設別発注先と会社の関連付け案。
 * 関連付けだけでは閲覧は始まらない(施設の管理者・副管理者の許可が必要)。
 * @param {{mount:HTMLElement, api:object, onClose:()=>void}} deps
 */
export function createDealerPortalOperator({ mount, api, onClose }) {
  const root = h("section", { id: "dealerPortalOperator", class: "settings-view dealer-operator", hidden: true });
  mount.insertBefore(root, mount.firstChild);
  const closeBtn = h("button", { type: "button", class: "btn btn-secondary" }, "注文画面に戻る");
  const status = h("p", { class: "form-hint", role: "status" });
  const body = h("div", { class: "dealer-operator-body" });
  root.append(h("div", { class: "settings-head" },
    h("div", { class: "settings-heading" }, h("h2", {}, "ディーラー管理"), createInfoTip("ディーラーの会社と担当者を登録し、施設の発注先と会社を関連付けます。注文を閲覧できるのは、施設の管理者・副管理者が許可した後の新規注文のうち、自社宛ての明細だけです。", { label: "ディーラー管理の説明" }).root),
    h("span", { class: "settings-facility" }), closeBtn),
    status, body);
  let open = false, busy = false, data = null;
  closeBtn.addEventListener("click", () => { close(); onClose(); });
  function close() { open = false; root.hidden = true; body.replaceChildren(); data = null; }

  /** 操作の共通処理(二重送信の防止・結果の表示・読み直し) */
  async function run(task, done, errEl) {
    if (busy) return;
    busy = true; if (errEl) errEl.textContent = "";
    try { await task(); status.textContent = done; await load(); }
    catch (e) { (errEl || status).textContent = describeCallableError(e); }
    finally { busy = false; }
  }

  function companyForm() {
    const name = h("input", { class: "form-control", type: "text", maxlength: "100", "data-f": "companyName", autocomplete: "off" });
    const err = h("p", { class: "error-message" });
    let requestId = newRequestId();
    name.addEventListener("input", () => { requestId = newRequestId(); });
    const btn = h("button", { type: "button", class: "btn btn-primary", "data-act": "createCompany" }, "会社を登録");
    btn.addEventListener("click", () => {
      if (!name.value.trim()) { err.textContent = "会社名を入力してください"; return; }
      run(() => api.createCompany({ name: name.value, requestId }), `「${name.value.trim()}」を登録しました。`, err);
    });
    return h("div", { class: "settings-section" }, createSectionHeading("会社を登録", "責任者・取引先との確認で、会社の同一性を確かめてから登録してください(メールのドメインや名称の一致だけで判断しない)。"),   // 説明は見出しの右のⓘ
      field("会社名", name), h("div", { class: "form-row" }, btn), err);
  }

  function staffRow(c, s) {
    const err = h("p", { class: "error-message" });
    const branchSel = select({ "data-f": "branch", "aria-label": "支店" }, [["", "支店なし"], ...c.branches.filter(b => b.status === "active").map(b => [b.branchId, b.name])]);
    branchSel.value = s.branchId || "";
    const roleSel = select({ "data-f": "staffRoleEdit", "aria-label": "役割" }, Object.entries(ROLE_LABELS));
    roleSel.value = s.role;
    const facs = (data.grantsByCompany.get(c.companyId) || []);
    const checks = facs.map(f => { const cb = h("input", { type: "checkbox", value: f.facilityId }); cb.checked = s.facilityIds.includes(f.facilityId); return h("label", { class: "settings-check" }, cb, h("span", {}, f.name)); });
    const save = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "saveStaff" }, "役割・支店・担当施設を保存");
    save.addEventListener("click", () => run(() => api.updateStaff({ companyId: c.companyId, staffId: s.staffId, ...(roleSel.value !== s.role ? { role: roleSel.value } : {}), branchId: branchSel.value || null, facilityIds: checks.map(l => l.querySelector("input")).filter(i => i.checked).map(i => i.value) }), "担当者の設定を保存しました。", err));
    const toggle = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "toggleStaff" }, s.status === "active" ? "無効にする" : "有効に戻す");
    toggle.addEventListener("click", async () => {
      if (s.status === "active" && !(await confirmDialog({ message: `${s.name || s.email} を無効にしますか？\n次の操作から、ディーラー画面を利用できなくなります。`, okLabel: "無効にする" }))) return;
      run(() => api.updateStaff({ companyId: c.companyId, staffId: s.staffId, status: s.status === "active" ? "disabled" : "active" }), "担当者の状態を変更しました。", err);
    });
    // 確認コードで紐付け済みのログイン方法(無効化すると、すべての方式が一度に使えなくなる)
    const logins = (s.logins || []).map(p => LOGIN_LABELS[p] || p).join("・") || "未確認";
    return h("li", { class: "dealer-operator-staff", "data-staff": s.staffId },
      h("div", {}, h("strong", {}, s.name || "(氏名未登録)"), ` ${s.email} ・ ${ROLE_LABELS[s.role] || s.role} ・ ${STAFF_STATUS[s.status] || s.status} ・ ログイン方法 ${logins}`),
      h("div", { class: "form-row" }, field("役割", roleSel), field("支店", branchSel)),
      facs.length ? h("div", { class: "dealer-operator-assign" }, h("span", { class: "form-hint" }, "担当施設(表示用。閲覧の権限は変わりません)"), ...checks) : h("p", { class: "form-hint" }, "閲覧を許可した施設はまだありません(担当施設は許可済みの施設から選びます)。"),
      h("div", { class: "form-row" }, save, toggle), err);
  }

  function companyBlock(c) {
    const err = h("p", { class: "error-message" });
    const email = h("input", { class: "form-control", type: "email", maxlength: "254", "data-f": "staffEmail", autocomplete: "off" });
    const name = h("input", { class: "form-control", type: "text", maxlength: "50", "data-f": "staffName", autocomplete: "off" });
    const role = select({ "data-f": "staffRole" }, Object.entries(ROLE_LABELS));
    const branch = select({ "data-f": "staffBranch" }, [["", "支店なし"], ...c.branches.filter(b => b.status === "active").map(b => [b.branchId, b.name])]);
    const invite = h("button", { type: "button", class: "btn btn-primary", "data-act": "invite" }, "担当者を招待");
    invite.addEventListener("click", () => run(() => api.inviteStaff({ companyId: c.companyId, email: email.value, name: name.value, role: role.value, ...(branch.value ? { branchId: branch.value } : {}) }),
      "担当者を招待しました。本人がそのメールアドレスでディーラー画面にログインし、メールに届く確認コードで本人確認すると利用できます。", err));
    const branchName = h("input", { class: "form-control", type: "text", maxlength: "100", "data-f": "branchName", autocomplete: "off" });
    const addBranch = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "addBranch" }, "支店を追加");
    addBranch.addEventListener("click", () => run(() => api.upsertBranch({ companyId: c.companyId, name: branchName.value }), "支店を追加しました。", err));
    const suspend = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "toggleCompany" }, c.status === "active" ? "会社を停止" : "会社を再開");
    suspend.addEventListener("click", async () => {
      if (c.status === "active" && !(await confirmDialog({ message: `「${c.name}」を停止しますか？\n会社の全担当者が、次の操作からディーラー画面を利用できなくなります。`, okLabel: "停止する" }))) return;
      run(() => api.updateCompany({ companyId: c.companyId, status: c.status === "active" ? "suspended" : "active" }), "会社の状態を変更しました。", err);
    });
    const invitations = c.invitations.map(i => {
      const cancel = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "cancelInvite" }, "取り消す");
      cancel.addEventListener("click", () => run(() => api.cancelInvitation({ companyId: c.companyId, staffId: i.staffId }), "参加待ちを取り消しました。", err));
      return h("li", {}, `${i.name || "(氏名なし)"} ${i.email} ・ ${ROLE_LABELS[i.role] || i.role} ・ 期限 ${formatJstDateTime(i.expiresAt)} `, cancel);
    });
    const grants = (data.grantsByCompany.get(c.companyId) || []).map(g => h("li", {}, `${g.name}(${formatJstDateTime(g.effectiveFrom)} 以降)`));
    return h("div", { class: "settings-section dealer-operator-company", "data-company": c.companyId },
      h("div", { class: "dealer-operator-title" }, h("h3", {}, c.name), h("span", { class: c.status === "active" ? "member-role-badge" : "member-role-badge is-muted" }, c.status === "active" ? "有効" : "停止中"), suspend),
      h("h4", {}, `担当者(${c.staff.length}人)`),
      c.staff.length ? h("ul", { class: "dealer-operator-list" }, c.staff.map(s => staffRow(c, s))) : h("p", { class: "form-hint" }, "担当者はまだいません。"),
      invitations.length ? h("div", {}, h("h4", {}, "参加待ち"), h("ul", { class: "dealer-operator-list" }, invitations)) : null,
      h("h4", {}, "担当者を招待"),
      h("div", { class: "dealer-operator-grid" }, field("勤務先メールアドレス", email), field("氏名", name), field("役割", role), field("支店(任意)", branch)),
      h("div", { class: "form-row" }, invite),
      h("h4", {}, "支店(任意)"),
      h("p", { class: "form-hint" }, c.branches.length ? c.branches.map(b => `${b.name}${b.status === "active" ? "" : "(無効)"}`).join("、") : "支店なし(支店がなくても利用できます)"),
      h("div", { class: "dealer-operator-grid" }, field("支店名", branchName)), h("div", { class: "form-row" }, addBranch),
      h("h4", {}, "閲覧を許可している施設"),
      grants.length ? h("ul", { class: "dealer-operator-list" }, grants) : h("p", { class: "form-hint" }, "まだありません。"),
      err);
  }

  function linkForm() {
    const err = h("p", { class: "error-message" });
    const facSel = select({ "data-f": "linkFacility" }, [["", "施設を選択"], ...data.facilities.map(f => [f.facilityId, f.name])]);
    const dealerSel = select({ "data-f": "linkDealer" }, [["", "発注先を選択"]]);
    const companySel = select({ "data-f": "linkCompany" }, [["", "会社を選択"], ...data.companies.filter(c => c.status === "active").map(c => [c.companyId, c.name])]);
    const companyName = (id) => (data.companies.find(c => c.companyId === id) || {}).name || "—";
    facSel.addEventListener("change", () => {
      const f = data.facilities.find(x => x.facilityId === facSel.value);
      dealerSel.replaceChildren(h("option", { value: "" }, "発注先を選択"), ...(f ? f.dealers.map(d => h("option", { value: d.localDealerId }, `${d.name}${d.link ? ` (${companyName(d.link.companyId)}・${LINK_LABELS[d.link.status] || d.link.status})` : ""}`)) : []));
    });
    const btn = h("button", { type: "button", class: "btn btn-primary", "data-act": "proposeLink" }, "関連付ける");
    btn.addEventListener("click", () => {
      if (!facSel.value || !dealerSel.value || !companySel.value) { err.textContent = "施設・発注先・会社を選択してください"; return; }
      run(() => api.proposeLink({ facilityId: facSel.value, localDealerId: dealerSel.value, companyId: companySel.value }),
        "関連付けました。施設の管理者・副管理者が「施設設定」で閲覧を許可すると、許可後の新規注文から表示されます。", err);
    });
    const rows = data.facilities.flatMap(f => f.dealers.filter(d => d.link).map(d => h("li", {}, `${f.name} / ${d.name} → ${companyName(d.link.companyId)}(${LINK_LABELS[d.link.status] || d.link.status})`)));
    const heading = createSectionHeading("発注先と会社の関連付け", LINK_HELP);   // 説明は見出しの右のⓘ
    heading.classList.add("dealer-link-heading");
    return h("div", { class: "settings-section" }, heading,
      h("div", { class: "dealer-operator-grid" }, field("施設", facSel), field("発注先", dealerSel), field("会社", companySel)),
      h("div", { class: "form-row" }, btn), err,
      rows.length ? h("ul", { class: "dealer-operator-list" }, rows) : h("p", { class: "form-hint" }, "関連付けはまだありません。"));
  }

  async function load() {
    const r = await api.overview();
    const facName = new Map((r.facilities || []).map(f => [f.facilityId, f.name]));
    data = {
      companies: r.companies || [], facilities: r.facilities || [],
      grantsByCompany: new Map((r.companies || []).map(c => [c.companyId, (c.grants || []).map(g => ({ ...g, name: facName.get(g.facilityId) || g.facilityId }))]))
    };
    body.replaceChildren(companyForm(), ...data.companies.map(companyBlock), linkForm());
  }

  return {
    isOpen: () => open,
    async open() {
      open = true; root.hidden = false; status.textContent = "読み込み中…"; body.replaceChildren();
      try { await load(); status.textContent = ""; } catch (e) { status.textContent = describeCallableError(e); }
    },
    close
  };
}
