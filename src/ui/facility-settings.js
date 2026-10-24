import {
  validateOrderers, planOrdererWrites, validateAdoption, planAdoptedWrites,
  validateDealers, planDealerWrites, LIMITS
} from "../domain/facility-settings.js";
import { planMemberToggle, confirmMessage, memberLabel, sortMembers, newAuditId, buildMemberChange } from "../domain/member-admin.js";
import { isValidEmail } from "../domain/order-validation.js";
import { describeCallableError } from "../data/registration-api.js";

/** 要素生成の小さなヘルパー（ユーザー入力は textContent / value で扱い、HTMLとして解釈しない） */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

/** ゴミ箱アイコン(SVG。装飾なので aria-hidden) */
function trashIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "14", height: "14", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6");
  svg.appendChild(path);
  return svg;
}

const SAVE_ERROR = "保存できませんでした。権限がない、またはネットワークの問題の可能性があります。";

/**
 * 施設設定画面（注文者 / 採用IOL / ディーラー）
 * 表示は施設管理者のみ（呼び出し側で制御）。書き込み権限は Firestore Security Rules が最終判定する。
 *
 * @param {object} deps
 * @param {HTMLElement} deps.mount 挿入先
 * @param {import("../data/schema.js").FacilityRepository} deps.repository
 * @param {{saveOrderers:Function, saveAdoptedIols:Function, saveDealers:Function}} deps.settingsApi
 * @param {Array<object>} deps.masters 共通IOLマスター（IOL_MODELS）
 * @param {() => Promise<void>} deps.onSaved 保存後（注文フォームへの反映など）
 * @param {() => void} deps.onClose
 * @param {{uid:string, displayName?:string}} [deps.currentUser] 操作者（利用者管理の操作記録に使う）
 * @param {{createInvite:Function}} [deps.inviteApi] 招待の発行（サーバー側関数）。未指定なら招待セクションは出さない
 */
export function createFacilitySettings({ mount, repository, settingsApi, masters, onSaved, onClose, inviteApi = null, currentUser = null }) {
  const root = h("section", { id: "facilitySettings", class: "settings-view", hidden: true });
  mount.insertBefore(root, mount.firstChild);

  let facility = null;
  let data = { orderers: [], adopted: [], dealers: [], members: [] };
  let dirty = false;
  let open = false;
  const markDirty = () => { dirty = true; };

  const message = (container, text, isError = false) => {
    const p = container.querySelector("[data-msg]");
    p.textContent = text || "";
    p.className = isError ? "error-message" : "form-hint";
  };

  async function load() {
    const [orderers, adopted, dealers] = await Promise.all([
      repository.listOrderers(facility.id),
      repository.listAdoptedIols(facility.id),
      repository.listDealers(facility.id)
    ]);
    data = { orderers, adopted, dealers, members: canManageMembers ? await repository.listMembers(facility.id) : [] };
  }

  // ---------- 注文者 ----------
  function ordererRow(o = { id: null, name: "", email: "", active: true }) {
    // 有効/無効は画面では操作しない。新規は有効(active=true)、既存の値はそのまま保持する(互換性)
    const row = h("div", { class: "settings-row settings-row-orderer", "data-id": o.id || "", "data-active": o.active ? "1" : "0" },
      h("input", { class: "form-control", "data-f": "name", type: "text", value: o.name, maxlength: LIMITS.ordererNameMax, placeholder: "注文者名", "aria-label": "注文者名" }),
      h("input", { class: "form-control", "data-f": "email", type: "email", value: o.email || "", placeholder: "メールアドレス（任意）", "aria-label": "メールアドレス" }),
      h("span", { class: "settings-move" },
        o.active ? null : h("span", { class: "form-hint", title: "注文フォームの選択肢には表示されません" }, "無効"),
        h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "up", "aria-label": "上へ" }, "↑"),
        h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "down", "aria-label": "下へ" }, "↓"),
        h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "delete", "aria-label": "この注文者を削除", title: "削除" }, trashIcon())),
      h("p", { class: "error-message", "data-err": "" }));
    row.addEventListener("input", markDirty);
    row.addEventListener("change", markDirty);
    row.querySelector('[data-act="up"]').addEventListener("click", () => { if (row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling); markDirty(); });
    row.querySelector('[data-act="down"]').addEventListener("click", () => { if (row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row); markDirty(); });
    row.querySelector('[data-act="delete"]').addEventListener("click", () => deleteOrdererRow(row));
    return row;
  }

  /**
   * 注文者の削除。保存済みの注文者はマスターのみ即時に削除する(所属・認証ユーザー・過去の注文は変更しない)。
   * 他の行の未保存の編集は保持する。未保存の追加行は画面から外すだけ。
   */
  async function deleteOrdererRow(row) {
    const section = sections.orderers;
    const id = row.getAttribute("data-id");
    const name = row.querySelector('[data-f="name"]').value.trim() || "この注文者";
    if (!id) { row.remove(); return; }
    if (!window.confirm(`注文者「${name}」を削除しますか？
注文フォームの選択肢から無くなります。過去の注文には影響しません。
（一時的に外すだけなら、削除せず「有効」を外してください）`)) return;
    const btn = row.querySelector('[data-act="delete"]');
    btn.disabled = true;
    message(section, "削除しています…");
    try {
      await settingsApi.deleteOrderer(facility.id, id);
      data.orderers = data.orderers.filter(o => o.id !== id);
      row.remove();
      await onSaved();
      message(section, `「${name}」を削除しました。`);
    } catch (e) {
      console.error("注文者の削除に失敗しました:", e);
      message(section, "削除できませんでした。権限がない、またはネットワークの問題の可能性があります。", true);
      btn.disabled = false;
    }
  }

  function renderOrderers(section) {
    const list = section.querySelector("[data-list]");
    list.replaceChildren(...data.orderers.map(ordererRow));
  }

  const readOrdererRows = (section) => [...section.querySelectorAll(".settings-row")].map(r => ({
    id: r.getAttribute("data-id") || null,
    name: r.querySelector('[data-f="name"]').value,
    email: r.querySelector('[data-f="email"]').value,
    active: r.getAttribute("data-active") !== "0"
  }));

  function showRowErrors(section, errors) {
    section.querySelectorAll("[data-err]").forEach(p => { p.textContent = ""; });
    const rows = section.querySelectorAll(".settings-row");
    errors.forEach(e => {
      const p = rows[e.index] && rows[e.index].querySelector("[data-err]");
      if (p) p.textContent = (p.textContent ? p.textContent + " / " : "") + e.message;
    });
  }

  async function saveWith(section, btn, task) {
    btn.disabled = true;
    message(section, "保存しています…");
    try {
      await task();
      await load();
      dirty = false;
      await onSaved();
      return true;
    } catch (e) {
      console.error("施設設定の保存に失敗しました:", e);
      message(section, SAVE_ERROR, true);
      return false;
    } finally {
      btn.disabled = false;
    }
  }

  function ordererSection() {
    const section = h("section", { class: "settings-section", "data-section": "orderers" },
      h("h3", {}, "注文者"),
      h("p", { class: "form-hint" }, "注文フォームの「注文者」に表示されます。ゴミ箱で削除すると一覧から無くなります（過去の注文には影響しません）。並び順は上から順です。"),
      h("div", { "data-list": "" }),
      h("div", { class: "settings-actions" },
        h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "add" }, "注文者を追加"),
        h("button", { type: "button", class: "btn btn-primary", "data-act": "save" }, "注文者を保存")),
      h("p", { class: "form-hint", "data-msg": "" }));
    section.querySelector('[data-act="add"]').addEventListener("click", () => {
      const row = ordererRow(); section.querySelector("[data-list]").appendChild(row); markDirty();
      row.querySelector('[data-f="name"]').focus();
    });
    const saveBtn = section.querySelector('[data-act="save"]');
    saveBtn.addEventListener("click", async () => {
      const v = validateOrderers(readOrdererRows(section));
      showRowErrors(section, v.errors);
      if (!v.ok) return message(section, "入力内容を確認してください。", true);
      const writes = planOrdererWrites(data.orderers, v.cleaned, facility.id);
      if (!writes.length) return message(section, "変更はありません。");
      const ok = await saveWith(section, saveBtn, () => settingsApi.saveOrderers(facility.id, writes));
      if (ok) { renderOrderers(section); message(section, "注文者を保存しました。"); }
    });
    return section;
  }

  // ---------- 採用IOL ----------
  function iolSection() {
    const section = h("section", { class: "settings-section", "data-section": "iols" },
      h("h3", {}, "採用IOL"),
      h("p", { class: "form-hint" }, "共通のIOLマスターから、この施設で使うモデルを選びます。チェックしたモデルだけが注文フォームに表示されます。"),
      h("div", { "data-list": "" }),
      h("div", { class: "settings-actions" }, h("button", { type: "button", class: "btn btn-primary", "data-act": "save" }, "採用IOLを保存")),
      h("p", { class: "form-hint", "data-msg": "" }));
    const saveBtn = section.querySelector('[data-act="save"]');
    saveBtn.addEventListener("click", async () => {
      const selected = [...section.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);
      const v = validateAdoption(selected, masters);
      if (!v.ok) return message(section, "マスターに存在しないIOLは登録できません。", true);
      const writes = planAdoptedWrites(masters, data.adopted, selected, facility.id);
      if (!writes.length) return message(section, "変更はありません。");
      const ok = await saveWith(section, saveBtn, () => settingsApi.saveAdoptedIols(facility.id, writes));
      if (ok) { renderIols(section); message(section, "採用IOLを保存しました。"); }
    });
    return section;
  }

  function renderIols(section) {
    const enabled = new Set(data.adopted.filter(a => a.enabled).map(a => a.catalogIolId));
    const groups = new Map();
    masters.forEach(m => { if (!groups.has(m.manufacturer)) groups.set(m.manufacturer, []); groups.get(m.manufacturer).push(m); });
    const nodes = [...groups.entries()].map(([mfg, items]) =>
      h("fieldset", { class: "settings-iol-group" },
        h("legend", {}, mfg),
        items.map(m => h("label", { class: "settings-check" },
          h("input", { type: "checkbox", value: m.id, checked: enabled.has(m.id) }),
          m.displayName.replace(/^[^/]+\/\s*/, ""),
          m.isToric ? " （トーリック）" : ""))));
    const list = section.querySelector("[data-list]");
    list.replaceChildren(...nodes);
    list.addEventListener("change", markDirty);
  }

  // ---------- ディーラー ----------
  function dealerRow(d = { id: null, name: "", active: true, orderEmails: [], usageReportEmails: [] }) {
    const row = h("div", { class: "settings-card", "data-id": d.id || "" },
      h("input", { class: "form-control", "data-f": "name", type: "text", value: d.name, maxlength: LIMITS.dealerNameMax, placeholder: "ディーラー名", "aria-label": "ディーラー名" }),
      h("label", { class: "settings-check" }, h("input", { "data-f": "active", type: "checkbox", checked: d.active }), "有効"),
      h("label", { class: "form-label" }, "発注用メールアドレス（1行に1件・最大" + LIMITS.emailsPerList + "件）",
        h("textarea", { class: "form-control", "data-f": "orderEmails", rows: "2", placeholder: "order@example.jp" }, (d.orderEmails || []).join("\n"))),
      h("label", { class: "form-label" }, "使用報告用メールアドレス（発注用とは別に管理）",
        h("textarea", { class: "form-control", "data-f": "usageEmails", rows: "2", placeholder: "report@example.jp" }, (d.usageReportEmails || []).join("\n"))),
      h("p", { class: "error-message", "data-err": "" }));
    row.addEventListener("input", markDirty);
    row.addEventListener("change", markDirty);
    return row;
  }

  function dealerSection() {
    const section = h("section", { class: "settings-section", "data-section": "dealers" },
      h("h3", {}, "ディーラー"),
      h("p", { class: "form-hint" }, "発注先ディーラーの連絡先を登録します。発注用と使用報告用のメールアドレスは別々に管理します。現在は登録のみで、メール送信やディーラーとの連携は行いません。"),
      h("div", { "data-list": "" }),
      h("div", { class: "settings-actions" },
        h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "add" }, "ディーラーを追加"),
        h("button", { type: "button", class: "btn btn-primary", "data-act": "save" }, "ディーラーを保存")),
      h("p", { class: "form-hint", "data-msg": "" }));
    section.querySelector('[data-act="add"]').addEventListener("click", () => {
      const row = dealerRow(); section.querySelector("[data-list]").appendChild(row); markDirty();
      row.querySelector('[data-f="name"]').focus();
    });
    const saveBtn = section.querySelector('[data-act="save"]');
    saveBtn.addEventListener("click", async () => {
      const rows = [...section.querySelectorAll(".settings-card")].map(r => ({
        id: r.getAttribute("data-id") || null,
        name: r.querySelector('[data-f="name"]').value,
        active: r.querySelector('[data-f="active"]').checked,
        orderEmailsText: r.querySelector('[data-f="orderEmails"]').value,
        usageEmailsText: r.querySelector('[data-f="usageEmails"]').value
      }));
      const v = validateDealers(rows);
      section.querySelectorAll("[data-err]").forEach(p => { p.textContent = ""; });
      v.errors.forEach(e => {
        const p = section.querySelectorAll(".settings-card")[e.index].querySelector("[data-err]");
        p.textContent = (p.textContent ? p.textContent + " / " : "") + e.message;
      });
      if (!v.ok) return message(section, "入力内容を確認してください。", true);
      const writes = planDealerWrites(data.dealers, v.cleaned, facility.id);
      if (!writes.length) return message(section, "変更はありません。");
      const ok = await saveWith(section, saveBtn, () => settingsApi.saveDealers(facility.id, writes));
      if (ok) { renderDealers(section); message(section, "ディーラーを保存しました。"); }
    });
    return section;
  }

  function renderDealers(section) {
    section.querySelector("[data-list]").replaceChildren(...data.dealers.map(dealerRow));
  }

  // ---------- 利用者管理 ----------
  const canManageMembers = Boolean(currentUser && repository.listMembers && settingsApi.applyMemberChange);

  function memberSection() {
    return h("section", { class: "settings-section", "data-section": "members" },
      h("h3", {}, "利用者管理"),
      h("p", { class: "form-hint" }, "この施設に所属するユーザーです。一般注文者は無効化・再有効化できます（無効化すると、この施設の注文画面・設定を利用できなくなります）。管理者の変更はできません。"),
      h("div", { "data-list": "" }),
      h("p", { class: "form-hint", "data-msg": "" }));
  }

  function renderMembers(section) {
    const list = section.querySelector("[data-list]");
    const rows = sortMembers(data.members).map((m) => {
      const plan = planMemberToggle(data.members, m, currentUser.uid);
      const active = m.status === "active";
      const btn = plan.ok
        ? h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "toggle-member" }, plan.to === "disabled" ? "無効化" : "再有効化")
        : h("span", { class: "form-hint", title: plan.reason }, m.uid === currentUser.uid ? "（自分）" : "—");
      // 1段目: 氏名 + 右端に操作(一般注文者はボタン、管理者は状態の表示) / 2段目: メール・権限
      const right = m.role === "admin" ? h("span", { "data-f": "status", class: active ? "" : "error-message" }, active ? "有効" : "無効") : btn;
      const row = h("div", { class: "settings-row settings-row-member" + (active ? "" : " is-disabled"), "data-uid": m.uid },
        h("span", { "data-f": "name" }, memberLabel(m)),
        h("span", { class: "settings-member-action" }, right),
        h("span", { class: "settings-member-meta" },
          h("span", { "data-f": "email" }, m.email || "—"), " ・ ", h("span", { "data-f": "role" }, m.role === "admin" ? "管理者" : "注文者")));
      if (plan.ok) {
        btn.addEventListener("click", async () => {
          if (!window.confirm(confirmMessage(m, plan))) return;
          btn.disabled = true;
          message(section, "更新しています…");
          try {
            const change = buildMemberChange({ facilityId: facility.id, target: m, plan, actor: currentUser, auditId: newAuditId() });
            await settingsApi.applyMemberChange(change);
            data.members = await repository.listMembers(facility.id);
            renderMembers(section);
            message(section, plan.to === "disabled" ? "無効化しました。" : "再度有効にしました。");
          } catch (e) {
            console.error("利用者の更新に失敗しました:", e);
            message(section, "更新できませんでした。権限がない、またはネットワークの問題の可能性があります。", true);
            btn.disabled = false;
          }
        });
      }
      return row;
    });
    list.replaceChildren(...(rows.length ? rows : [h("p", { class: "form-hint" }, "所属ユーザーはいません。")]));
  }

  // ---------- メンバー招待 ----------
  function inviteSection() {
    const result = h("div", { "data-result": "" });
    const emailInput = h("input", { class: "form-control", type: "email", "data-f": "inviteEmail", placeholder: "招待するメールアドレス", "aria-label": "招待するメールアドレス" });
    const btn = h("button", { type: "button", class: "btn btn-primary", "data-act": "invite" }, "招待コードを発行");
    const section = h("section", { class: "settings-section", "data-section": "invites" },
      h("h3", {}, "メンバーの招待"),
      h("p", { class: "form-hint" }, "招待したメールアドレスでログインした本人だけが、注文者として参加できます。招待コードは発行時に1度だけ表示されます（有効期限7日）。メールは自動送信されません。安全な方法でご本人にお伝えください。"),
      h("div", { class: "settings-actions" }, emailInput, btn),
      result,
      h("p", { class: "form-hint", "data-msg": "" }));
    btn.addEventListener("click", async () => {
      const email = emailInput.value.trim();
      result.replaceChildren();
      if (!isValidEmail(email)) return message(section, "メールアドレスの形式が正しくありません。", true);
      btn.disabled = true;
      message(section, "発行しています…");
      try {
        const r = await inviteApi.createInvite({ facilityId: facility.id, email });
        const expires = new Date(r.expiresAt).toLocaleDateString("ja-JP");
        const code = h("output", { class: "settings-code", "data-invite-code": "" }, r.token);
        result.replaceChildren(
          h("p", {}, `${r.email} 宛ての招待コード（${expires} まで有効）:`), code,
          h("button", { type: "button", class: "btn btn-outline-sm" }, "コピー"));
        result.querySelector("button").addEventListener("click", () => {
          try { navigator.clipboard.writeText(r.token); message(section, "コピーしました。"); } catch (e) { /* 手動でコピー */ }
        });
        emailInput.value = "";
        message(section, "招待コードを発行しました。この画面を閉じると再表示できません。");
      } catch (e) {
        message(section, describeCallableError(e), true);
      } finally {
        btn.disabled = false;
      }
    });
    return section;
  }

  // ---------- 画面全体 ----------
  const sections = { orderers: ordererSection(), iols: iolSection(), dealers: dealerSection() };
  if (canManageMembers) sections.members = memberSection();
  if (inviteApi) sections.invites = inviteSection();
  const title = h("span", { class: "settings-facility" });
  const closeBtn = h("button", { type: "button", class: "btn btn-secondary", id: "btnSettingsClose" }, "注文画面に戻る");
  const status = h("p", { class: "form-hint", role: "status" });
  root.append(
    h("div", { class: "settings-head" }, h("h2", {}, "施設設定"), title, closeBtn),
    h("p", { class: "form-hint" }, "この画面は施設管理者のみ変更できます。"),
    status,
    ...Object.values(sections));

  closeBtn.addEventListener("click", () => {
    if (dirty && !window.confirm("保存していない変更があります。破棄して注文画面に戻りますか？")) return;
    close();
    onClose();
  });

  function close() {
    open = false; dirty = false;
    root.hidden = true;
  }

  return {
    isOpen: () => open,
    async open(fac) {
      facility = fac;
      title.textContent = fac.name;
      status.textContent = "読み込み中…";
      root.hidden = false;
      open = true;
      try {
        await load();
        renderOrderers(sections.orderers);
        renderIols(sections.iols);
        renderDealers(sections.dealers);
        if (sections.members) renderMembers(sections.members);
        status.textContent = "";
        dirty = false;
      } catch (e) {
        console.error("施設設定の読み込みに失敗しました:", e);
        status.textContent = "施設設定を読み込めませんでした。権限を確認してください。";
      }
    },
    close
  };
}
