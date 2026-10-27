/**
 * 施設の事前登録(運営者 = platformAdmin のみ。権限・重複・状態の確認はすべてサーバー: functions/src/facility-preregistrations.js)。
 * 施設名と初期管理者のメールアドレスを登録し、初期管理者がそのメールアドレスでログインして参加を承諾すると施設が有効になる。
 * 一覧では、承諾前の登録の編集(施設名・初期管理者)と取り消しができる。
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
const formatDate = (ms) => {
  if (!ms) return "—";
  const d = new Date(ms + 9 * 3600 * 1000), p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
};
const STATE_LABELS = { pending: "承諾待ち", expired: "期限切れ", declined: "辞退", missing: "参加待ちなし" };
const newRequestId = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

/** 重複候補の確認(既存施設・事前登録の施設・審査中の申請)。続けるなら true */
async function confirmDuplicate(r) {
  const what = r.exact ? "同じ名前" : `似た名前(${r.similarCount}件)`;
  return confirmDialog({ message: `${what}の施設・事前登録・審査中の申請があります${r.candidates && r.candidates.length ? `(${r.candidates.join("、")})` : ""}。\n別の施設として登録しますか？`, okLabel: "登録する", cancelLabel: "キャンセル" });
}

/**
 * @param {{mount:HTMLElement, api:{preregisterFacility:Function, listFacilityPreregistrations:Function, updateFacilityPreregistration:Function, cancelFacilityPreregistration:Function}, onClose:()=>void}} deps
 */
export function createFacilityPreregistrations({ mount, api, onClose }) {
  const root = h("section", { id: "facilityPreregistrations", class: "settings-view facility-preregistrations", hidden: true });
  mount.insertBefore(root, mount.firstChild);
  const closeBtn = h("button", { type: "button", class: "btn btn-secondary", id: "btnPreregClose" }, "注文画面に戻る");
  const status = h("p", { class: "form-hint", role: "status" });
  const nameIn = h("input", { class: "form-control", type: "text", maxlength: "100", "data-f": "name", "aria-label": "施設名", autocomplete: "off" });
  const emailIn = h("input", { class: "form-control", type: "email", maxlength: "254", "data-f": "adminEmail", "aria-label": "初期管理者のメールアドレス", autocomplete: "off" });
  const adminNameIn = h("input", { class: "form-control", type: "text", maxlength: "50", "data-f": "adminName", "aria-label": "初期管理者のお名前", autocomplete: "off" });
  const submit = h("button", { type: "button", class: "btn btn-primary", "data-act": "preregister" }, "事前登録する");
  const formErr = h("p", { class: "error-message", "data-err": "form" });
  const form = h("div", { class: "settings-section prereg-form" },
    h("h3", {}, "新しい施設を事前登録"),
    h("p", { class: "form-hint" }, "初期管理者がこのメールアドレス(確認済み)でログインし、参加を承諾すると、施設が有効になり管理者になります。承諾までは誰にも権限は付きません。"),
    h("label", { class: "form-label" }, h("span", {}, "施設名", h("span", { class: "required-mark", "aria-hidden": "true" }, "*")), nameIn),
    h("label", { class: "form-label" }, h("span", {}, "初期管理者のメールアドレス", h("span", { class: "required-mark", "aria-hidden": "true" }, "*")), emailIn),
    h("label", { class: "form-label" }, "初期管理者のお名前(任意)", adminNameIn),
    h("div", { class: "form-row prereg-actions" }, submit), formErr);
  const body = h("div", {});
  root.append(h("div", { class: "settings-head" }, h("h2", {}, "施設を事前登録"), closeBtn), status, form, body);
  let open = false, busy = false, requestId = newRequestId();
  closeBtn.addEventListener("click", () => { close(); onClose(); });
  function close() { open = false; root.hidden = true; }
  for (const el of [nameIn, emailIn]) el.addEventListener("input", () => { requestId = newRequestId(); });   // 内容を変えたら別の登録

  submit.addEventListener("click", async () => {
    if (busy) return;
    formErr.textContent = "";
    const req = { name: nameIn.value.trim(), adminEmail: emailIn.value.trim(), adminName: adminNameIn.value.trim(), requestId };
    if (!req.name) { formErr.textContent = "施設名を入力してください。"; return; }
    if (!req.adminEmail) { formErr.textContent = "初期管理者のメールアドレスを入力してください。"; return; }
    busy = true; submit.disabled = true;
    try {
      let r = await api.preregisterFacility(req);
      if (r.status === "duplicate-candidate") {
        if (!(await confirmDuplicate(r))) return;
        r = await api.preregisterFacility({ ...req, confirmDuplicate: true });
      }
      status.textContent = `「${req.name}」を事前登録しました。初期管理者が参加を承諾すると利用できます。`;
      nameIn.value = ""; emailIn.value = ""; adminNameIn.value = ""; requestId = newRequestId();
      await load();
    } catch (e) {
      formErr.textContent = describeCallableError(e);
    } finally { busy = false; submit.disabled = false; }
  });

  function row(x) {
    const view = h("div", { class: "prereg-view" },
      h("div", { class: "application-name-row" }, h("div", { class: "application-name" }, x.name),
        h("span", { class: `application-status prereg-state is-${x.state}` }, STATE_LABELS[x.state] || x.state)),
      h("div", { class: "form-hint" }, `初期管理者: ${x.adminName ? `${x.adminName} ・ ` : ""}${x.adminEmail} ・ 期限 ${formatDate(x.expiresAt)}`));
    const edit = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "edit" }, "編集");
    const cancel = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "cancel" }, "取り消し");
    const eName = h("input", { class: "form-control", type: "text", maxlength: "100", "data-f": "editName", "aria-label": "施設名" });
    const eEmail = h("input", { class: "form-control", type: "email", maxlength: "254", "data-f": "editEmail", "aria-label": "初期管理者のメールアドレス" });
    const eAdminName = h("input", { class: "form-control", type: "text", maxlength: "50", "data-f": "editAdminName", "aria-label": "初期管理者のお名前" });
    const save = h("button", { type: "button", class: "btn btn-primary btn-sm-inline", "data-act": "save" }, "保存");
    const back = h("button", { type: "button", class: "btn btn-secondary btn-sm-inline", "data-act": "back" }, "キャンセル");
    const editBox = h("div", { class: "prereg-edit", hidden: true }, eName, eEmail, eAdminName,
      h("p", { class: "form-hint" }, "メールアドレスを変更すると、以前のメールアドレスでは参加できなくなります。保存すると、参加の期限は今日から30日になります。"),
      h("div", { class: "form-row" }, save, back));
    const err = h("p", { class: "error-message", "data-err": "" });
    const actions = h("div", { class: "form-row prereg-actions" }, edit, cancel);
    const li = h("li", { class: "application-item prereg-item", "data-facility": x.facilityId }, view, actions, editBox, err);
    const setEditing = (on) => { view.hidden = on; actions.hidden = on; editBox.hidden = !on; err.textContent = ""; if (on) eName.focus(); };
    edit.addEventListener("click", () => { eName.value = x.name; eEmail.value = x.adminEmail; eAdminName.value = x.adminName || ""; setEditing(true); });
    back.addEventListener("click", () => setEditing(false));
    save.addEventListener("click", async () => {
      if (busy) return;
      const req = { facilityId: x.facilityId, name: eName.value.trim(), adminEmail: eEmail.value.trim(), adminName: eAdminName.value.trim() };
      if (!req.name || !req.adminEmail) { err.textContent = "施設名と初期管理者のメールアドレスを入力してください。"; return; }
      busy = true; save.disabled = true; err.textContent = "";
      try {
        let r = await api.updateFacilityPreregistration(req);
        if (r.status === "duplicate-candidate") {
          if (!(await confirmDuplicate(r))) return;
          r = await api.updateFacilityPreregistration({ ...req, confirmDuplicate: true });
        }
        status.textContent = `「${req.name}」の事前登録を保存しました。`;
        await load();
      } catch (e) { err.textContent = describeCallableError(e); }
      finally { busy = false; save.disabled = false; }
    });
    cancel.addEventListener("click", async () => {
      if (busy) return;
      const ok = await confirmDialog({ message: `「${x.name}」の事前登録を取り消しますか？\n初期管理者は参加できなくなります。`, okLabel: "取り消す", cancelLabel: "キャンセル" });
      if (!ok) return;
      busy = true; cancel.disabled = true; err.textContent = "";
      try {
        await api.cancelFacilityPreregistration({ facilityId: x.facilityId });
        status.textContent = `「${x.name}」の事前登録を取り消しました。`;
        await load();
      } catch (e) { err.textContent = describeCallableError(e); }
      finally { busy = false; cancel.disabled = false; }
    });
    return li;
  }

  async function load() {
    const r = await api.listFacilityPreregistrations();
    const list = r.preregistrations || [];
    body.replaceChildren(
      h("h3", {}, `事前登録(承諾前 ${list.length}件)`),
      list.length ? h("ul", { class: "application-list" }, list.map(row)) : h("p", { class: "form-hint" }, "承諾前の事前登録はありません。"));
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
