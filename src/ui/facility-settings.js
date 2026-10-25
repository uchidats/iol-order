import {
  validateOrderers, planOrdererWrites, validateAdoption, planAdoptedWrites,
  validateDealers, planDealerWrites, LIMITS
} from "../domain/facility-settings.js";
import {
  planMemberRemoval, confirmMessage, memberLabel, sortMembers, roleLabel, roleChoices, assignableRoles, canManageRole, isManagerRole,
  pendingState, sortPending, formatExpiry, PENDING_STATE_LABELS
} from "../domain/member-admin.js";
import { createSectionHeading, createInfoTip } from "./info-tip.js";
import { baseModelName } from "../domain/lens-labels.js";
import { orderedMakers, orderedModelsOf, buildIolOrderSetting } from "../domain/iol-order.js";
import { lensBadgeElements } from "./lens-badges.js";
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

/** 小さなアイコン(SVG。装飾なので aria-hidden。意味はボタンの aria-label / title で伝える) */
function icon(d) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "14", height: "14", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
}
const trashIcon = () => icon("M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6");
const pencilIcon = () => icon("M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z");

const SAVE_ERROR = "保存できませんでした。権限がない、またはネットワークの問題の可能性があります。";

/**
 * 施設設定画面（担当医 / 採用IOL / ディーラー）。担当医マスターの保存先は、互換性のため従来の orderers コレクション。
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
 * @param {"admin"|"subadmin"} [deps.actorRole] 操作者のこの施設での役割(画面の出し分け用。権限の最終判定はサーバー・Rules)
 * @param {(facilityId:string) => void} [deps.onDeleted] 施設の削除後(所属の取得し直し・施設選択へ)
 * @param {(facilityId:string, name:string) => void} [deps.onRenamed] 施設名の変更後(ヘッダー等の表示更新)
 * @param {{removeMember?:Function, addMember?:Function, renameFacility?:Function, deleteFacility?:Function}} [deps.inviteApi] 利用者管理・施設の操作（サーバー側関数）。未指定なら招待セクションは出さない
 */
export function createFacilitySettings({ mount, repository, settingsApi, masters, onSaved, onClose, inviteApi = null, currentUser = null, actorRole = "admin", onRenamed = () => {}, onDeleted = () => {} }) {
  const root = h("section", { id: "facilitySettings", class: "settings-view", hidden: true });
  mount.insertBefore(root, mount.firstChild);

  let facility = null;
  let data = { orderers: [], adopted: [], dealers: [], members: [] };
  let dirty = false;
  let open = false;
  const markDirty = () => { dirty = true; };

  /**
   * 自動保存(採用IOL・担当医)。変更のたびに request() を呼ぶと、画面の最新の状態を、1件ずつ順番に保存する。
   *  - 保存中に続けて操作しても、保存は直列(同時に2つ走らない)。保存の時点の画面の状態を保存するので、古い内容で上書きしない。続けて操作した分は1回にまとめる。
   *  - 成功の通知は出さない。失敗したときだけエラーと「再試行」を表示し、画面の変更は消さない(次の操作か再試行で、最新の状態をもう一度保存する)。
   *  - exclusive(): 保存と同時に走らせてはいけない処理(削除)を、保存の合間に実行する。
   * @param {HTMLElement} section 表示先(メッセージ・再試行ボタン)
   * @param {() => Promise<void>} run 保存の実体(既存のサーバー・データベースへの保存処理)
   */
  function createAutoSaver(section, run) {
    let again = false, running = false;
    const waiters = [];
    const api = { failed: false };
    const settle = () => waiters.splice(0).forEach(r => r());
    const showError = () => {
      message(section, "保存できませんでした。変更はまだ保存されていません。通信状態や権限を確認して、再試行してください。", true);
      if (!section.querySelector('[data-act="retry-autosave"]')) {
        const b = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "retry-autosave" }, "再試行");
        b.addEventListener("click", () => api.request());
        section.querySelector("[data-msg]").after(b);
      }
    };
    const clearError = () => {
      const b = section.querySelector('[data-act="retry-autosave"]');
      if (b) b.remove();
      const p = section.querySelector("[data-msg]");
      if (p && p.classList.contains("error-message")) message(section, "");
    };
    async function pump() {
      if (running) return;
      running = true;
      try {
        while (again) {
          again = false;
          try { await run(); if (api.failed) { api.failed = false; clearError(); } }
          catch (e) { console.error("自動保存に失敗しました:", e); api.failed = true; showError(); break; }
        }
      } finally { running = false; settle(); if (again && !api.failed) pump(); }
    }
    api.request = () => { again = true; pump(); };
    api.idle = () => (running || again ? new Promise(r => waiters.push(r)) : Promise.resolve());
    api.exclusive = async (task) => {
      while (running) await new Promise(r => waiters.push(r));
      running = true;
      try { return await task(); } finally { running = false; settle(); if (again) pump(); }
    };
    return api;
  }
  /** 各リストの先頭の「↑」: 見えなく・押せなくするが、場所は残す(ほかのボタンの位置を揃える) */
  const markFirst = (up, first) => { if (!up) return; up.classList.toggle("is-first", first); up.tabIndex = first ? -1 : 0; up.setAttribute("aria-hidden", String(first)); };
  let orderSaver = null, iolSaver = null, dealerSaver = null, memberSaver = null;   // 担当医・採用IOL・ディーラー・利用者管理の自動保存(各セクションの作成時に用意する)
  const savers = () => [orderSaver, iolSaver, dealerSaver, memberSaver].filter(Boolean);

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
    const iolOrder = repository.getIolOrder ? await repository.getIolOrder(facility.id) : null;
    data = { orderers, adopted, dealers, iolOrder, members: [], pending: [] };
    if (canManageMembers) await reloadMembers();
  }

  // ---------- 担当医(旧「注文者」。コレクション名・関数名は互換性のため orderers のまま) ----------
  function ordererRow(o = { id: null, name: "", email: "" }) {
    // 通常は一覧表示(入力ボックスなし)。鉛筆を押した行だけ、名前とメールを編集できる。注文者に有効/無効はない。
    const row = h("div", { class: "orderer-item", "data-id": o.id || "" });
    row._state = { id: o.id || null, name: o.name || "", email: o.email || "" };
    let editing = false;

    const btn = (act, label, child) => h("button", { type: "button", class: "btn btn-outline-sm orderer-icon", "data-act": act, "aria-label": label, title: label }, child);
    const nameView = h("span", { class: "orderer-name", "data-v": "name" });
    const emailView = h("span", { class: "orderer-email", "data-v": "email" });
    const actions = h("span", { class: "orderer-actions" },
      btn("up", "上へ", "↑"),
      btn("edit", "名前・メールを編集", pencilIcon()),
      btn("delete", "この担当医を削除", trashIcon()));
    const nameInput = h("input", { class: "form-control", "data-f": "name", type: "text", maxlength: LIMITS.ordererNameMax, placeholder: "氏名（必須）", "aria-label": "氏名（必須）" });
    const emailInput = h("input", { class: "form-control", "data-f": "email", type: "email", placeholder: "メールアドレス（任意）", "aria-label": "メールアドレス（任意）" });
    // 利用者管理への事前登録(注文者)。初期はオフ。既に所属済み・参加待ちのメールでは表示しない。チェック時はメール必須
    const memberCheck = h("input", { type: "checkbox", "data-f": "addMember" });
    const memberOpt = h("label", { class: "orderer-member-opt", hidden: true }, memberCheck, h("span", {}, "利用者管理にも追加する（注文者）"));
    const syncMemberOpt = () => {
      const show = canPreregister && !isKnownMemberEmail(emailInput.value);
      memberOpt.hidden = !show;
      if (!show) memberCheck.checked = false;
      const required = show && memberCheck.checked;
      emailInput.placeholder = required ? "メールアドレス（必須）" : "メールアドレス（任意）";
      emailInput.setAttribute("aria-label", emailInput.placeholder);
    };
    emailInput.addEventListener("input", syncMemberOpt);
    memberCheck.addEventListener("change", syncMemberOpt);
    row._memberCheck = memberCheck;
    const editBox = h("div", { class: "orderer-edit", hidden: true },
      nameInput, emailInput, memberOpt,
      h("div", { class: "orderer-edit-actions" },
        h("button", { type: "button", class: "btn btn-primary btn-sm-inline", "data-act": "save-row" }, "保存"),
        h("button", { type: "button", class: "btn btn-secondary btn-sm-inline", "data-act": "cancel-row" }, "キャンセル")));
    const err = h("p", { class: "error-message", "data-err": "" });
    row.append(h("div", { class: "orderer-view" }, h("span", { class: "orderer-namebox" }, nameView), emailView, actions), editBox, err);

    function paint() {
      nameView.textContent = row._state.name || "（名称未入力）";
      emailView.textContent = row._state.email || "メール未登録";
      emailView.classList.toggle("is-empty", !row._state.email);
      row.querySelector(".orderer-view").hidden = editing;
      editBox.hidden = !editing;
      row.classList.toggle("is-editing", editing);
    }
    row._isEditing = () => editing;
    row._startEdit = () => {
      editing = true;
      nameInput.value = row._state.name; emailInput.value = row._state.email;
      memberCheck.checked = false; syncMemberOpt();
      paint(); nameInput.focus();
    };
    row._syncMemberOpt = syncMemberOpt;
    row._commit = () => { row._state.name = nameInput.value; row._state.email = emailInput.value; editing = false; paint(); };
    row._cancel = () => {
      if (!row._state.id && !row._state.name && !row._state.email) { row.remove(); return; } // 追加したばかりの行は取り消すと消える
      editing = false; err.textContent = ""; paint();
    };
    row._paint = paint;

    row.querySelector('[data-act="edit"]').addEventListener("click", () => row._startEdit());
    row.querySelector('[data-act="cancel-row"]').addEventListener("click", () => row._cancel());
    row.querySelector('[data-act="save-row"]').addEventListener("click", () => saveOrdererRow(row));
    row.querySelector('[data-act="up"]').addEventListener("click", () => { if (row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling); orderSaver.request(); });
    row.querySelector('[data-act="delete"]').addEventListener("click", () => deleteOrdererRow(row));
    paint();
    return row;
  }

  /** 行の「保存」: この行の編集内容を、一覧全体の既存の検証にかけ、問題なければ(並び替えなどの未保存の変更も含めて)保存する */
  async function saveOrdererRow(row) {
    const section = sections.orderers;
    const before = { name: row._state.name, email: row._state.email };
    const typed = { name: row.querySelector('[data-f="name"]').value, email: row.querySelector('[data-f="email"]').value };
    const wantMember = canPreregister && !row._memberCheck.closest("label").hidden && row._memberCheck.checked;
    row._commit();
    const v = validateOrderers(readOrdererRows(section));
    showRowErrors(section, v.errors);
    if (!v.ok) { // 検証に通らなければ、編集中のまま入力を残す
      row._state.name = before.name; row._state.email = before.email; row._startEdit();
      const own = row.querySelector("[data-err]");
      if (!own.textContent) own.textContent = v.errors.map(e => e.message).join(" / "); // 重複など、他の行側に出た指摘も、編集中の行に表示する
      row.querySelector('[data-f="name"]').value = typed.name; row.querySelector('[data-f="email"]').value = typed.email; // 入力した内容は残す
      row._memberCheck.checked = wantMember; row._syncMemberOpt();
      return message(section, "入力内容を確認してください。", true);
    }
    if (wantMember) return preregisterThenSave(row, before, typed);
    message(section, "");
    orderSaver.request();   // 行の「保存」(追加・設定変更の確定)で、自動保存する
  }

  /**
   * 「利用者管理にも追加する（注文者）」: 先に事前登録(addMember)し、成功してから担当医を保存する。
   * 事前登録に失敗したら担当医は保存せず、入力を残して理由を表示する。既に所属済み・参加待ちなら重複登録せず、担当医は保存する。
   * 担当医の保存だけ失敗した場合は、自動保存の「再試行」で保存し直す(事前登録は同じメールで二度送らない: row._memberDone)。
   */
  async function preregisterThenSave(row, before, typed) {
    const section = sections.orderers;
    const own = row.querySelector("[data-err]");
    const keepEditing = () => {   // 確定を取り消し、入力した内容のまま編集中に戻す
      row._state.name = before.name; row._state.email = before.email; row._startEdit();
      row.querySelector('[data-f="name"]').value = typed.name; row.querySelector('[data-f="email"]').value = typed.email;
      row._memberCheck.checked = true; row._syncMemberOpt();
    };
    keepEditing();
    const email = typed.email.trim();
    const name = typed.name.replace(/\s+/g, " ").trim();
    if (!isValidEmail(email)) {
      own.textContent = "利用者管理にも追加する場合は、メールアドレスを入力してください。";
      return message(section, "入力内容を確認してください。", true);
    }
    const saveBtn = row.querySelector('[data-act="save-row"]');
    saveBtn.disabled = true; own.textContent = "";
    message(section, "利用者管理に登録しています…");
    let note = "";
    try {
      if (row._memberDone !== email.toLowerCase()) {
        await inviteApi.addMember({ facilityId: facility.id, name, email, role: "orderer" });
        note = `「${name}」を利用者管理に注文者として登録しました。本人がこのメールアドレスでログインすると、参加を確認できます。`;
      }
      row._memberDone = email.toLowerCase();
    } catch (e) {
      if (String((e && e.code) || "").endsWith("already-exists")) {
        row._memberDone = email.toLowerCase();
        note = "このメールアドレスは既に利用者管理に登録済み(所属済み・参加待ち)のため、重複して登録しませんでした。";
      } else {
        console.error("利用者管理への登録に失敗しました:", e);
        saveBtn.disabled = false;
        own.textContent = describeCallableError(e);
        return message(section, "利用者管理に登録できなかったため、担当医は保存していません。", true);
      }
    }
    saveBtn.disabled = false;
    try { await reloadMembers(); if (sections.members) renderMembers(sections.members); } catch (e) { console.warn("利用者管理の一覧を更新できませんでした:", e); }
    row._commit();   // 入力した内容で確定し、担当医を保存する
    message(section, note);
    orderSaver.request();
  }

  /** 利用者管理に既にいる(所属済み・期限内の参加待ち)メールアドレスか */
  function isKnownMemberEmail(email) {
    const e = String(email || "").trim().toLowerCase();
    if (!e) return false;
    return (data.members || []).some(m => String(m.email || "").toLowerCase() === e)
      || (data.pending || []).some(p => String(p.email || "").toLowerCase() === e && pendingState(p) === "pending");
  }

  /**
   * 担当医の自動保存の実体: 確定済みの行だけを、画面に並んでいる順に保存する。
   * 入力途中の行(追加して未確定の行・編集中の入力)は含めない(確定した時点で保存される)。
   */
  async function runOrdererSave() {
    const section = sections.orderers;
    const entries = [...section.querySelectorAll(".orderer-item")].filter(r => !(r._isEditing() && !r._state.id));   // 未確定の追加行は除く
    const v = validateOrderers(entries.map(r => ({ id: r._state.id, name: r._state.name, email: r._state.email })));
    section.querySelectorAll("[data-err]").forEach(p => { p.textContent = ""; });
    v.errors.forEach(e => { const p = entries[e.index] && entries[e.index].querySelector("[data-err]"); if (p) p.textContent = (p.textContent ? p.textContent + " / " : "") + e.message; });
    if (!v.ok) throw new Error("担当医の入力内容を確認してください");
    const writes = planOrdererWrites(data.orderers, v.cleaned, facility.id);
    if (!writes.length) return;
    await settingsApi.saveOrderers(facility.id, writes);
    await load();   // 最新の保存内容を読み直す(新しい担当医の ID もここで分かる。画面の入力途中の行は壊さない)
    entries.forEach((r, i) => {
      if (r._state.id) return;
      const saved = data.orderers.find(o => o.name === v.cleaned[i].name);
      if (saved) { r._state.id = saved.id; r.setAttribute("data-id", saved.id); }
    });
    await onSaved();
  }

  /**
   * 担当医の削除。保存済みの担当医はマスターのみ即時に削除する(所属・認証ユーザー・過去の注文は変更しない)。
   * 他の行の未保存の編集は保持する。未保存の追加行は画面から外すだけ。
   */
  async function deleteOrdererRow(row) {
    const section = sections.orderers;
    const id = row.getAttribute("data-id");
    const name = (row._state.name || "").trim() || "この担当医";
    if (!id) { row.remove(); return; }
    if (!window.confirm(`担当医「${name}」を削除しますか？
注文フォームの選択肢から無くなります。過去の注文には影響しません。`)) return;
    const btn = row.querySelector('[data-act="delete"]');
    btn.disabled = true;
    message(section, "削除しています…");
    try {
      await orderSaver.exclusive(async () => {   // 自動保存と同時に走らせない(削除した担当医を、保存が書き戻さないように)
        await settingsApi.deleteOrderer(facility.id, id);
        data.orderers = data.orderers.filter(o => o.id !== id);
        row.remove();
      });
      await onSaved();
      message(section, `「${name}」を削除しました。`);
    } catch (e) {
      console.error("担当医の削除に失敗しました:", e);
      message(section, "削除できませんでした。権限がない、またはネットワークの問題の可能性があります。", true);
      btn.disabled = false;
    }
  }

  function renderOrderers(section) {
    const list = section.querySelector("[data-list]");
    list.replaceChildren(...data.orderers.map(ordererRow));
  }

  const readOrdererRows = (section) => [...section.querySelectorAll(".orderer-item")].map(r => ({
    id: r._state.id,
    name: r._state.name,
    email: r._state.email
  }));

  function showRowErrors(section, errors) {
    section.querySelectorAll("[data-err]").forEach(p => { p.textContent = ""; });
    const rows = section.querySelectorAll(".settings-row, .orderer-item");
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
      createSectionHeading("担当医", "注文フォームの「担当医」に表示されます。鉛筆で編集、↑↓で並び替え、ゴミ箱で削除できます。変更は自動で保存されます(入力中の内容は、行の「保存」を押した時点で保存されます)。"),
      h("div", { "data-list": "" }),
      h("div", { class: "settings-actions" },
        h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "add" }, "追加")),
      h("p", { class: "form-hint", "data-msg": "" }));
    section.querySelector('[data-act="add"]').addEventListener("click", () => {
      const row = ordererRow(); section.querySelector("[data-list]").appendChild(row);
      row._startEdit(); // 追加した行は編集状態で表示する。行の「保存」で確定した時点で自動保存される(入力途中は保存しない)
    });
    orderSaver = createAutoSaver(section, runOrdererSave);   // 「担当医を保存」ボタンは廃止(追加・設定変更の確定・並び替え・削除で自動保存)
    // 並び替え: 先頭の担当医の「↑」は非表示。スマホ幅では「↑」のみ(「↓」を隠すのは CSS)、PCは「↑↓」
    const doctorList = section.querySelector("[data-list]");
    const updateDoctorMoves = () => [...doctorList.querySelectorAll(".orderer-item")].forEach((r, i) => { const up = r.querySelector('[data-act="up"]'); markFirst(up, i === 0); });
    new MutationObserver(updateDoctorMoves).observe(doctorList, { childList: true });
    return section;
  }

  // ---------- 採用IOL ----------
  function iolSection() {
    const section = h("section", { class: "settings-section", "data-section": "iols" },
      createSectionHeading("採用IOL", "施設で使用するIOLを選択します。チェックしたモデルだけが注文フォームに表示されます。↑↓でメーカーとモデルの表示順を変更できます。変更は自動で保存されます。"),
      h("div", { "data-list": "" }),
      h("p", { class: "form-hint", "data-msg": "" }));
    iolSaver = createAutoSaver(section, runIolSave);   // 「採用IOLを保存」ボタンは廃止(チェック・並び替えで自動保存)
    return section;
  }

  /** 採用IOLの自動保存の実体: 画面の最新の状態(チェックと並び順)を保存する。採用が変わっていれば採用を、並べ替えていれば表示順を保存する */
  async function runIolSave() {
    const section = sections.iols;
    const selected = [...section.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);
    const v = validateAdoption(selected, masters);
    if (!v.ok) throw new Error("マスターに存在しないIOLは登録できません");
    const writes = planAdoptedWrites(masters, data.adopted, selected, facility.id);
    // 表示順(メーカーの順番・モデルの順番)は、画面に並んでいる順番をそのまま保存する。並べ替えていなければ書かない
    const order = buildIolOrderSetting(masters,
      [...section.querySelectorAll("details.iol-maker")].map(d => d.getAttribute("data-maker")),
      [...section.querySelectorAll('.iol-model-row input[type="checkbox"]')].map(c => c.value));
    const orderVersion = section._orderVersion || 0;
    const orderChanged = Boolean(section._orderDirty) && Boolean(settingsApi.saveIolOrder);
    if (!writes.length && !orderChanged) return;
    if (writes.length) await settingsApi.saveAdoptedIols(facility.id, writes);
    if (orderChanged) await settingsApi.saveIolOrder(facility.id, order);
    if ((section._orderVersion || 0) === orderVersion) section._orderDirty = false;   // 保存中にさらに並べ替えていれば、次の保存で保存する
    await load();   // 最新の保存内容を読み直す(画面は作り直さない。操作中の表示を壊さない)
    await onSaved();
  }

  /** 採用IOLの並び替え: メーカーの先頭・各メーカー内の先頭のIOLでは、「↑」を非表示にする(スマホ幅では「↓」も CSS で隠す) */
  function updateIolMoves(list) {
    [...list.querySelectorAll("details.iol-maker")].forEach((d, i) => { markFirst(d.querySelector('summary [data-act="maker-up"]'), i === 0); });
    list.querySelectorAll(".iol-maker-list").forEach(box => [...box.querySelectorAll(".iol-model-row")].forEach((r, i) => { markFirst(r.querySelector('[data-act="model-up"]'), i === 0); }));
  }

  function renderIols(section) {
    const enabled = new Set(data.adopted.filter(a => a.enabled).map(a => a.catalogIolId));
    // メーカーごとに折りたたみ(初期はすべて閉じる)。見出しの右側に「採用数/登録数」と、並べ替えの↑↓。チェックと保存は従来どおり。
    // 並び順は施設ごとの設定(未設定は標準の順番)。新しいメーカー・モデルは既存の順番の末尾
    const mover = (act, label, text, move) => {
      const b = h("button", { type: "button", class: "btn btn-outline-sm orderer-icon iol-move", "data-act": act, "aria-label": label, title: label }, text);
      b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); move(); updateIolMoves(section.querySelector("[data-list]")); section._orderDirty = true; section._orderVersion = (section._orderVersion || 0) + 1; iolSaver.request(); }); // summary の開閉は起こさない。並べ替えで自動保存
      return b;
    };
    const swap = (el, delta) => {
      const sib = delta < 0 ? el.previousElementSibling : el.nextElementSibling;
      if (!sib) return;
      if (delta < 0) el.parentNode.insertBefore(el, sib); else el.parentNode.insertBefore(sib, el);
    };
    const nodes = orderedMakers(masters, data.iolOrder).map((mfg) => {
      const items = orderedModelsOf(masters, mfg, data.iolOrder);
      const count = h("span", { class: "iol-maker-count" });
      let group;
      const makerMoves = h("span", { class: "iol-moves" },
        mover("maker-up", `${mfg}を上へ`, "↑", () => swap(group, -1)));
      group = h("details", { class: "iol-maker", "data-maker": mfg },
        h("summary", { class: "iol-maker-summary" }, h("span", { class: "iol-maker-name" }, mfg), count, makerMoves),
        h("div", { class: "iol-maker-list" },
          items.map(m => {
            let row;
            const moves = h("span", { class: "iol-moves" },
              mover("model-up", `${baseModelName(m)}を上へ`, "↑", () => swap(row, -1)));
            row = h("div", { class: "iol-model-row", "data-model": m.id },
              h("label", { class: "settings-check" },
                h("input", { type: "checkbox", value: m.id, checked: enabled.has(m.id) }),
                h("span", { class: "iol-name" }, baseModelName(m)),   // モデル名(「（トーリック）」などの括弧書きは取り除く)
                lensBadgeElements(m)),                                 // 特徴は isToric / isMultifocal のバッジで1回だけ
              moves);
            return row;
          })));
      group._updateCount = () => {
        const adopted = group.querySelectorAll('input[type="checkbox"]:checked').length;
        count.textContent = `${adopted}/${items.length}`;
        count.setAttribute("aria-label", `採用 ${adopted}、登録 ${items.length}`);
      };
      group._updateCount();
      return group;
    });
    const list = section.querySelector("[data-list]");
    list.replaceChildren(...nodes);
    updateIolMoves(list);
    list.onchange = (e) => { const g = e.target.closest("details"); if (g && g._updateCount) g._updateCount(); iolSaver.request(); };   // チェックの変更で自動保存
  }

  // ---------- ディーラー(担当医と同じ操作: 通常は一覧表示、鉛筆を押した行だけ編集、↑↓で並び替え、ゴミ箱で削除) ----------
  // ディーラーに有効/無効はない。不要になったディーラーは削除する(過去の注文に保存されたディーラー情報は残る)。
  // 並び順は sortOrder に保存する(選択肢の表示順だけ。発注先の判定には使わない)。
  function dealerRow(d = { id: null, name: "", orderEmails: [], usageReportEmails: [] }) {
    const row = h("div", { class: "orderer-item dealer-item", "data-id": d.id || "" });
    row._state = { id: d.id || null, name: d.name || "", orderEmailsText: (d.orderEmails || []).join("\n"), usageEmailsText: (d.usageReportEmails || []).join("\n") };
    let editing = false;
    const countOf = (text) => String(text || "").split(/\r?\n|,/).map(s => s.trim()).filter(Boolean).length;

    const btn = (act, label, child) => h("button", { type: "button", class: "btn btn-outline-sm orderer-icon", "data-act": act, "aria-label": label, title: label }, child);
    const nameView = h("span", { class: "orderer-name", "data-v": "name" });
    const infoView = h("span", { class: "orderer-email", "data-v": "info" });   // 登録状況(発注用・使用報告用のメールの件数)
    const actions = h("span", { class: "orderer-actions" },
      btn("up", "上へ", "↑"),
      btn("edit", "名前・メールアドレスを編集", pencilIcon()),
      btn("delete", "このディーラーを削除", trashIcon()));
    const nameInput = h("input", { class: "form-control", "data-f": "name", type: "text", maxlength: LIMITS.dealerNameMax, placeholder: "ディーラー名（必須）", "aria-label": "ディーラー名（必須）" });
    const orderInput = h("textarea", { class: "form-control", "data-f": "orderEmails", rows: "2", placeholder: "order@example.jp", "aria-label": "発注用メールアドレス" });
    const usageInput = h("textarea", { class: "form-control", "data-f": "usageEmails", rows: "2", placeholder: "report@example.jp", "aria-label": "使用報告用メールアドレス" });
    const editBox = h("div", { class: "orderer-edit dealer-edit", hidden: true },
      nameInput,
      h("label", { class: "form-label" }, "発注用メールアドレス", h("span", { class: "field-note" }, `（1行に1件・最大${LIMITS.emailsPerList}件）`), orderInput),
      h("label", { class: "form-label" }, "使用報告用メールアドレス", h("span", { class: "field-note" }, `（1行に1件・最大${LIMITS.emailsPerList}件）`), usageInput),
      h("div", { class: "orderer-edit-actions" },
        h("button", { type: "button", class: "btn btn-primary btn-sm-inline", "data-act": "save-row" }, "保存"),
        h("button", { type: "button", class: "btn btn-secondary btn-sm-inline", "data-act": "cancel-row" }, "キャンセル")));
    const err = h("p", { class: "error-message", "data-err": "" });
    row.append(h("div", { class: "orderer-view" }, h("span", { class: "orderer-namebox" }, nameView), infoView, actions), editBox, err);

    function paint() {
      const s = row._state, o = countOf(s.orderEmailsText), u = countOf(s.usageEmailsText);
      nameView.textContent = s.name || "（名称未入力）";
      infoView.textContent = `${o ? `発注用メール ${o}件` : "発注用メール未登録(自動送信不可)"} ・ 使用報告用 ${u}件`;
      infoView.classList.toggle("is-empty", !o);
      row.querySelector(".orderer-view").hidden = editing;
      editBox.hidden = !editing;
      row.classList.toggle("is-editing", editing);
    }
    row._isEditing = () => editing;
    row._startEdit = () => {
      editing = true;
      nameInput.value = row._state.name; orderInput.value = row._state.orderEmailsText; usageInput.value = row._state.usageEmailsText;
      paint(); nameInput.focus();
    };
    row._commit = () => {
      row._state.name = nameInput.value; row._state.orderEmailsText = orderInput.value; row._state.usageEmailsText = usageInput.value;
      editing = false; paint();
    };
    row._cancel = () => {
      const s = row._state;
      if (!s.id && !s.name && !s.orderEmailsText && !s.usageEmailsText) { row.remove(); return; } // 追加したばかりの行は取り消すと消える
      editing = false; err.textContent = ""; paint();
    };

    row.querySelector('[data-act="edit"]').addEventListener("click", () => row._startEdit());
    row.querySelector('[data-act="cancel-row"]').addEventListener("click", () => row._cancel());
    row.querySelector('[data-act="save-row"]').addEventListener("click", () => saveDealerRow(row));
    row.querySelector('[data-act="up"]').addEventListener("click", () => { if (row.previousElementSibling) { row.parentNode.insertBefore(row, row.previousElementSibling); dealerSaver.request(); } });
    row.querySelector('[data-act="delete"]').addEventListener("click", () => deleteDealerRow(row));
    paint();
    return row;
  }

  const readDealerRows = (section) => [...section.querySelectorAll(".dealer-item")].map(r => ({
    id: r._state.id, name: r._state.name, orderEmailsText: r._state.orderEmailsText, usageEmailsText: r._state.usageEmailsText
  }));

  /** 行の「保存」: この行の編集内容を、一覧全体の既存の検証にかけ、問題なければ(並び替えなどの未保存の変更も含めて)保存する */
  async function saveDealerRow(row) {
    const section = sections.dealers;
    const before = { ...row._state };
    const typed = { name: row.querySelector('[data-f="name"]').value, order: row.querySelector('[data-f="orderEmails"]').value, usage: row.querySelector('[data-f="usageEmails"]').value };
    row._commit();
    const v = validateDealers(readDealerRows(section));
    showRowErrors(section, v.errors);
    if (!v.ok) { // 検証に通らなければ、編集中のまま入力を残す
      Object.assign(row._state, before); row._startEdit();
      const own = row.querySelector("[data-err]");
      if (!own.textContent) own.textContent = v.errors.map(e => e.message).join(" / ");
      row.querySelector('[data-f="name"]').value = typed.name;
      row.querySelector('[data-f="orderEmails"]').value = typed.order;
      row.querySelector('[data-f="usageEmails"]').value = typed.usage;
      return message(section, "入力内容を確認してください。", true);
    }
    message(section, "");
    dealerSaver.request();   // 行の「保存」(追加・設定変更の確定)で、自動保存する
  }

  /**
   * ディーラーの自動保存の実体: 確定済みの行だけを、画面に並んでいる順(sortOrder)に保存する。
   * 入力途中の行(追加して未確定の行・編集中の入力)は含めない(確定した時点で保存される)。
   */
  async function runDealerSave() {
    const section = sections.dealers;
    const entries = [...section.querySelectorAll(".dealer-item")].filter(r => !(r._isEditing() && !r._state.id));   // 未確定の追加行は除く
    const v = validateDealers(entries.map(r => ({ id: r._state.id, name: r._state.name, orderEmailsText: r._state.orderEmailsText, usageEmailsText: r._state.usageEmailsText })));
    section.querySelectorAll("[data-err]").forEach(p => { p.textContent = ""; });
    v.errors.forEach(e => { const p = entries[e.index] && entries[e.index].querySelector("[data-err]"); if (p) p.textContent = (p.textContent ? p.textContent + " / " : "") + e.message; });
    if (!v.ok) throw new Error("ディーラーの入力内容を確認してください");
    const writes = planDealerWrites(data.dealers, v.cleaned, facility.id);   // 並び順は sortOrder として保存される
    if (!writes.length) return;
    await settingsApi.saveDealers(facility.id, writes);
    await load();   // 最新の保存内容を読み直す(新しいディーラーの ID もここで分かる。入力途中の行は壊さない)
    entries.forEach((r, i) => {
      if (r._state.id) return;
      const saved = data.dealers.find(d => d.name === v.cleaned[i].name);
      if (saved) { r._state.id = saved.id; r.setAttribute("data-id", saved.id); }
    });
    await onSaved();
  }

  /**
   * ディーラーの削除。保存済みのディーラーは即時に削除する(以後の注文の発注先として使えなくなる。過去の注文に保存された情報は変わらない)。
   * 他の行の未保存の編集は保持する。未保存の追加行は画面から外すだけ。
   */
  async function deleteDealerRow(row) {
    const section = sections.dealers;
    const id = row.getAttribute("data-id");
    const name = (row._state.name || "").trim() || "このディーラー";
    if (!id) { row.remove(); return; }
    if (!window.confirm(`ディーラー「${name}」を削除しますか？\n以後の注文の発注先として使えなくなります。過去の注文に保存されたディーラー情報には影響しません。`)) return;
    const btn = row.querySelector('[data-act="delete"]');
    btn.disabled = true;
    message(section, "削除しています…");
    try {
      await dealerSaver.exclusive(async () => {   // 自動保存と同時に走らせない(削除したディーラーを、保存が書き戻さないように)
        await settingsApi.deleteDealer(facility.id, id);
        data.dealers = data.dealers.filter(x => x.id !== id);
        row.remove();
      });
      await onSaved();
      message(section, `「${name}」を削除しました。`);
    } catch (e) {
      console.error("ディーラーの削除に失敗しました:", e);
      message(section, "削除できませんでした。権限がない、またはネットワークの問題の可能性があります。", true);
      btn.disabled = false;
    }
  }

  function dealerSection() {
    const section = h("section", { class: "settings-section", "data-section": "dealers" },
      createSectionHeading("ディーラー", "発注先ディーラーの連絡先を登録します。注文用と使用報告用のメールアドレスを別々に設定できます。鉛筆で編集、↑で並び替え(選択肢の表示順だけに使います)、ゴミ箱で削除できます。変更は自動で保存されます(入力中の内容は、行の「保存」を押した時点で保存されます)。現在は登録のみで、メール送信は行われません。"),
      h("div", { "data-list": "" }),
      h("div", { class: "settings-actions" },
        h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "add" }, "追加")),
      h("p", { class: "form-hint", "data-msg": "" }));
    section.querySelector('[data-act="add"]').addEventListener("click", () => {
      const row = dealerRow(); section.querySelector("[data-list]").appendChild(row);
      row._startEdit(); // 追加した行は編集状態で表示する。行の「保存」で確定した時点で自動保存される(入力途中は保存しない)
    });
    dealerSaver = createAutoSaver(section, runDealerSave);   // 「ディーラーを保存」ボタンは廃止(追加・設定変更の確定・並び替え・削除で自動保存)
    // 並び替えの↑: 先頭の行では非表示(スマホでは↑のみ・PCは↑↓。スマホで↓を隠すのは CSS)。行の追加・削除・移動のたびに更新する
    const list = section.querySelector("[data-list]");
    const updateMoves = () => [...list.querySelectorAll(".dealer-item")].forEach((r, i) => { const up = r.querySelector('[data-act="up"]'); markFirst(up, i === 0); });
    new MutationObserver(updateMoves).observe(list, { childList: true });
    return section;
  }

  function renderDealers(section) {
    section.querySelector("[data-list]").replaceChildren(...data.dealers.map(dealerRow));
  }

  // ---------- 利用者管理 ----------
  // 所属に有効/無効はない。参加済みの利用者(所属)と、事前登録した参加待ちを1つの一覧で管理する。
  // 管理者はすべての役割、副管理者は注文者・代行入力者だけを操作できる(最終判定はサーバー)。
  const canManageMembers = Boolean(currentUser && isManagerRole(actorRole) && repository.listMembers && inviteApi && inviteApi.removeMember);
  const canPreregister = Boolean(canManageMembers && inviteApi.addMember && repository.listPendingMembers);

  function memberSection() {
    const nameIn = h("input", { class: "form-control", type: "text", maxlength: "50", "data-f": "addName", placeholder: "名前", "aria-label": "名前", autocomplete: "off" });
    const emailIn = h("input", { class: "form-control", type: "email", maxlength: "254", "data-f": "addEmail", placeholder: "メールアドレス", "aria-label": "メールアドレス", autocomplete: "off" });
    const roleIn = h("select", { class: "form-control", "data-f": "addRole", "aria-label": "役割" },
      assignableRoles(actorRole).map(r => h("option", { value: r }, roleLabel(r))));
    if (assignableRoles(actorRole).includes("orderer")) roleIn.value = "orderer";
    const submit = h("button", { type: "button", class: "btn btn-primary", "data-act": "add-submit" }, "登録");
    const cancel = h("button", { type: "button", class: "btn btn-secondary", "data-act": "add-cancel" }, "キャンセル");
    const form = h("div", { class: "member-add-form", hidden: true },
      nameIn, emailIn, roleIn, h("div", { class: "form-row" }, submit, cancel));
    const addBtn = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "add" }, "追加");
    const section = h("section", { class: "settings-section", "data-section": "members" },
      createSectionHeading("利用者管理", "この施設の利用者を管理します。「追加」で名前・メールアドレス・役割を登録すると、本人がそのメールアドレスでログインしたときに、参加の確認画面が表示されます(登録から30日間有効)。期限切れ・辞退の場合は再登録できます。"),
      h("div", { "data-list": "" }),
      canPreregister ? form : null,
      canPreregister ? h("div", { class: "settings-actions" }, addBtn) : null,
      h("p", { class: "form-hint", "data-msg": "" }));
    memberSaver = createAutoSaver(section, runMemberOrderSave);   // 並び替え(↑)の自動保存。編集・削除などは同じ保存の列で順に行う(exclusive)
    const memberList = section.querySelector("[data-list]");
    new MutationObserver(() => [...memberList.querySelectorAll(".member-item")].forEach((r, i) => markFirst(r.querySelector('[data-act="up"]'), i === 0)))
      .observe(memberList, { childList: true });
    if (!canPreregister) return section;

    const reset = () => { nameIn.value = ""; emailIn.value = ""; if (roleIn.querySelector('option[value="orderer"]')) roleIn.value = "orderer"; };
    addBtn.addEventListener("click", () => { form.hidden = false; addBtn.hidden = true; message(section, ""); nameIn.focus(); });
    cancel.addEventListener("click", () => { form.hidden = true; addBtn.hidden = false; reset(); message(section, ""); });
    let adding = false;
    submit.addEventListener("click", async () => {
      if (adding) return;
      const name = nameIn.value.replace(/\s+/g, " ").trim();
      const email = emailIn.value.trim();
      if (!name) return message(section, "名前を入力してください。", true);
      if (!isValidEmail(email)) return message(section, "メールアドレスの形式が正しくありません。", true);
      adding = true; submit.disabled = true;
      message(section, "登録しています…");
      try {
        const r = await inviteApi.addMember({ facilityId: facility.id, name, email, role: roleIn.value });
        await reloadMembers();
        renderMembers(section);
        form.hidden = true; addBtn.hidden = false; reset();
        message(section, `${r.name}（${r.email}）を${roleLabel(r.role)}として登録しました。本人がこのメールアドレスでログインすると、参加を確認できます（${formatExpiry(r.expiresAt)} まで）。`);
      } catch (e) {
        message(section, describeCallableError(e), true);
      } finally {
        adding = false; submit.disabled = false;
      }
    });
    return section;
  }

  async function reloadMembers() {
    const [members, pending, order] = await Promise.all([
      repository.listMembers(facility.id),
      canPreregister ? repository.listPendingMembers(facility.id) : Promise.resolve([]),
      repository.getMemberOrder ? repository.getMemberOrder(facility.id).catch(() => null) : Promise.resolve(null)
    ]);
    data.members = members; data.pending = pending; data.memberOrder = Array.isArray(order) ? order : [];
  }

  /** 表示順の自動保存の実体: 画面に並んでいる順(参加済み "m:{uid}"・参加待ち "p:{ID}")を保存する(施設ごと) */
  async function runMemberOrderSave() {
    const keys = [...sections.members.querySelectorAll(".member-item")].map(r => r.getAttribute("data-key"));
    if (!settingsApi.saveMemberOrder || keys.join("\n") === (data.memberOrder || []).join("\n")) return;
    await settingsApi.saveMemberOrder(facility.id, keys);
    data.memberOrder = keys;
  }

  /**
   * 行の操作(編集・役割変更・削除・取り消し・再登録)を、並び替えの自動保存と同じ列で順に実行し、一覧を読み込み直す。
   * 失敗時は理由を表示し、操作を残す(もう一度押せば再試行)。成功すれば true
   */
  async function runRowAction(section, btns, busyText, fn, doneText) {
    btns.forEach(b => { b.disabled = true; });
    message(section, busyText);
    try {
      await memberSaver.exclusive(async () => { await fn(); await reloadMembers(); });
      renderMembers(section);
      message(section, doneText);
      return true;
    } catch (e) {
      console.error("利用者管理の操作に失敗しました:", e);
      message(section, describeCallableError(e), true);
      btns.forEach(b => { b.disabled = false; });
      return false;
    }
  }

  /** 操作ボタン(左から ↑・編集・削除)。使えない操作は、場所だけ残して見えなくする(行ごとのボタンの位置をそろえる) */
  function memberActions(label, { edit, del, delLabel }) {
    const btn = (act, title, child, enabled) => {
      const b = h("button", { type: "button", class: `btn btn-outline-sm orderer-icon${enabled ? "" : " is-placeholder"}`, "data-act": act, "aria-label": enabled ? `${label}: ${title}` : null, title: enabled ? title : null }, child);
      if (!enabled) { b.disabled = true; b.tabIndex = -1; b.setAttribute("aria-hidden", "true"); }
      return b;
    };
    return h("span", { class: "orderer-actions" },
      btn("up", "上へ", "↑", true),
      btn("edit", "編集", pencilIcon(), edit),
      btn("delete", delLabel, trashIcon(), del));
  }

  function moveUp(row) {
    if (!row.previousElementSibling) return;
    row.parentNode.insertBefore(row, row.previousElementSibling);
    memberSaver.request();
  }

  function memberRow(section, m) {
    const isSelf = m.uid === currentUser.uid;
    const label = memberLabel(m);
    const plan = planMemberRemoval(data.members, m, currentUser.uid, actorRole);
    const canRename = isSelf || canManageRole(actorRole, m.role);   // 自分の氏名は変更できる(管理者自身も)
    // 役割の変更は氏名の編集とは別: 役割バッジを押す。自分自身の役割は(誤操作を防ぐため)変更しない。最後の管理者は降格しない
    const choices = isSelf ? [] : roleChoices(data.members, m, actorRole);
    const badge = choices.length
      ? h("button", { type: "button", class: "member-role-badge is-action", "data-f": "role", "data-role": m.role, "data-act": "role", "aria-label": `${label} の役割（${roleLabel(m.role)}）を変更`, title: "役割を変更" }, roleLabel(m.role), h("span", { class: "member-role-caret", "aria-hidden": "true" }, "▾"))
      : h("span", { class: "member-role-badge", "data-f": "role", "data-role": m.role }, roleLabel(m.role));
    const actions = memberActions(label, { edit: canRename, del: plan.ok, delLabel: "所属を削除" });
    const nameIn = h("input", { class: "form-control", type: "text", maxlength: "50", "data-f": "editName", "aria-label": "氏名" });
    const save = h("button", { type: "button", class: "btn btn-primary btn-sm-inline", "data-act": "save-row" }, "保存");
    const cancel = h("button", { type: "button", class: "btn btn-secondary btn-sm-inline", "data-act": "cancel-row" }, "キャンセル");
    const editBox = h("div", { class: "orderer-edit member-edit", hidden: true },
      nameIn, h("span", { class: "member-edit-fixed" }, m.email ? `${m.email}（変更できません）` : ""),
      h("div", { class: "orderer-edit-actions" }, save, cancel));
    const err = h("p", { class: "error-message", "data-err": "" });
    const view = h("div", { class: "orderer-view" },
      h("span", { class: "orderer-namebox" }, h("span", { "data-f": "name" }, label), badge),
      h("span", { class: `orderer-email${m.email ? "" : " is-empty"}`, "data-f": "email" }, m.email || "メール未登録"),
      actions);
    const row = h("div", { class: "orderer-item member-item", "data-key": `m:${m.uid}`, "data-uid": m.uid }, view, editBox, err);
    const setEditing = (on) => { view.hidden = on; editBox.hidden = !on; row.classList.toggle("is-editing", on); if (on) { err.textContent = ""; nameIn.focus(); } };

    actions.querySelector('[data-act="up"]').addEventListener("click", () => moveUp(row));
    if (canRename) actions.querySelector('[data-act="edit"]').addEventListener("click", () => { nameIn.value = m.displayName || ""; setEditing(true); });
    cancel.addEventListener("click", () => setEditing(false));
    save.addEventListener("click", async () => {
      const name = nameIn.value.replace(/\s+/g, " ").trim();
      if (!name) { err.textContent = "氏名を入力してください。"; return; }
      if (name === (m.displayName || "")) { setEditing(false); return; }
      const ok = await runRowAction(section, [save, cancel], "保存しています…",
        () => inviteApi.updateMemberName({ facilityId: facility.id, uid: m.uid, name }), `${name} の氏名を保存しました。`);
      if (!ok) err.textContent = "保存できませんでした。もう一度「保存」を押すと再試行します。";
    });
    if (plan.ok) {
      actions.querySelector('[data-act="delete"]').addEventListener("click", (ev) => {
        if (!window.confirm(confirmMessage(m))) return;
        runRowAction(section, [ev.currentTarget], "削除しています…",
          () => inviteApi.removeMember({ facilityId: facility.id, uid: m.uid }), `${label} の所属を削除しました。`);
      });
    }
    if (choices.length) {
      badge.addEventListener("click", () => {
        if (row.querySelector(".member-role-edit")) return;
        const sel = h("select", { class: "form-control", "aria-label": `${label} の役割` }, choices.map(r => h("option", { value: r }, roleLabel(r))));
        sel.value = m.role;
        const ok = h("button", { type: "button", class: "btn btn-primary btn-sm-inline", "data-act": "role-save" }, "変更");
        const back = h("button", { type: "button", class: "btn btn-secondary btn-sm-inline", "data-act": "role-cancel" }, "キャンセル");
        const box = h("div", { class: "member-role-edit" }, sel, ok, back);
        row.insertBefore(box, err);
        sel.focus();
        back.addEventListener("click", () => box.remove());
        ok.addEventListener("click", () => {
          if (sel.value === m.role) { box.remove(); return; }
          if (sel.value === "admin" && !window.confirm(`${label} を管理者にしますか？\n管理者は、施設名の変更・施設削除・管理者や副管理者の権限管理ができます。`)) return;
          runRowAction(section, [ok, back, sel], "変更しています…",
            () => inviteApi.changeMemberRole({ facilityId: facility.id, uid: m.uid, role: sel.value }),
            `${label} の役割を${roleLabel(sel.value)}に変更しました。`);
        });
      });
    }
    return row;
  }

  function pendingRow(section, p) {
    const st = pendingState(p);
    const label = memberLabel(p);
    const manageable = canManageRole(actorRole, p.role);
    const canEdit = manageable && Boolean(inviteApi.updatePendingMember);
    const canCancel = manageable && Boolean(inviteApi.cancelPendingMember);
    const renew = manageable && st !== "pending" && inviteApi.renewPendingMember
      ? h("button", { type: "button", class: "btn btn-outline-sm member-renew", "data-act": "renew" }, "再登録")
      : null;
    const actions = memberActions(label, { edit: canEdit, del: canCancel, delLabel: "登録を取り消す" });
    const meta = [p.email, st === "pending" ? `${formatExpiry(p.expiresAt)} まで有効` : null].filter(Boolean).join(" ・ ");
    // 編集: 氏名・メールアドレス・役割(副管理者は注文者・代行入力者のみ)。状態・期限はそのまま
    const nameIn = h("input", { class: "form-control", type: "text", maxlength: "50", "data-f": "editName", "aria-label": "氏名" });
    const emailIn = h("input", { class: "form-control", type: "email", maxlength: "254", "data-f": "editEmail", "aria-label": "メールアドレス" });
    const roleIn = h("select", { class: "form-control", "data-f": "editRole", "aria-label": "役割" }, assignableRoles(actorRole).map(r => h("option", { value: r }, roleLabel(r))));
    const save = h("button", { type: "button", class: "btn btn-primary btn-sm-inline", "data-act": "save-row" }, "保存");
    const cancel = h("button", { type: "button", class: "btn btn-secondary btn-sm-inline", "data-act": "cancel-row" }, "キャンセル");
    const editBox = h("div", { class: "orderer-edit member-edit is-pending-edit", hidden: true }, nameIn, emailIn, roleIn,
      h("p", { class: "form-hint member-edit-note" }, "メールアドレスを変更すると、以前のメールアドレスでは参加できなくなります。"),
      h("div", { class: "orderer-edit-actions" }, save, cancel));
    const err = h("p", { class: "error-message", "data-err": "" });
    const view = h("div", { class: "orderer-view" },
      h("span", { class: "orderer-namebox" },
        h("span", { "data-f": "name" }, label),
        h("span", { class: "member-role-badge", "data-f": "role", "data-role": p.role }, roleLabel(p.role)),
        h("span", { class: `member-state-badge is-${st}`, "data-f": "state" }, PENDING_STATE_LABELS[st]),
        renew),
      h("span", { class: "orderer-email", "data-f": "email" }, meta),
      actions);
    const row = h("div", { class: "orderer-item member-item is-pending", "data-key": `p:${p.id}`, "data-pending": p.id, "data-state": st }, view, editBox, err);
    const setEditing = (on) => { view.hidden = on; editBox.hidden = !on; row.classList.toggle("is-editing", on); if (on) { err.textContent = ""; nameIn.focus(); } };

    actions.querySelector('[data-act="up"]').addEventListener("click", () => moveUp(row));
    if (canEdit) actions.querySelector('[data-act="edit"]').addEventListener("click", () => { nameIn.value = p.name || ""; emailIn.value = p.email || ""; roleIn.value = p.role; setEditing(true); });
    cancel.addEventListener("click", () => setEditing(false));
    save.addEventListener("click", async () => {
      const name = nameIn.value.replace(/\s+/g, " ").trim();
      const email = emailIn.value.trim();
      if (!name) { err.textContent = "氏名を入力してください。"; return; }
      if (!isValidEmail(email)) { err.textContent = "メールアドレスの形式が正しくありません。"; return; }
      if (name === p.name && email.toLowerCase() === String(p.email).toLowerCase() && roleIn.value === p.role) { setEditing(false); return; }
      const ok = await runRowAction(section, [save, cancel], "保存しています…",
        () => inviteApi.updatePendingMember({ facilityId: facility.id, pendingId: p.id, name, email, role: roleIn.value }), `${name} の登録内容を保存しました。`);
      if (!ok) err.textContent = "保存できませんでした。内容を確認して、もう一度「保存」を押してください。";
    });
    if (renew) {
      renew.addEventListener("click", () => runRowAction(section, [renew], "再登録しています…",
        () => inviteApi.renewPendingMember({ facilityId: facility.id, pendingId: p.id }), `${label} を再登録しました（30日間有効）。`));
    }
    if (canCancel) {
      actions.querySelector('[data-act="delete"]').addEventListener("click", (ev) => {
        if (!window.confirm(`${label}（${p.email}）の登録を取り消しますか？\nこの人は、このメールアドレスでログインしても参加できなくなります。`)) return;
        runRowAction(section, [ev.currentTarget], "取り消しています…",
          () => inviteApi.cancelPendingMember({ facilityId: facility.id, pendingId: p.id }), `${label} の登録を取り消しました。`);
      });
    }
    return row;
  }

  function renderMembers(section) {
    const list = section.querySelector("[data-list]");
    // 保存された表示順(施設ごと)。まだ並べていない人は、既定の順(役割 → 氏名、参加待ちは状態 → 氏名)で後ろに並ぶ
    const items = [
      ...sortMembers(data.members).map(m => ({ key: `m:${m.uid}`, el: () => memberRow(section, m) })),
      ...sortPending(data.pending || []).map(p => ({ key: `p:${p.id}`, el: () => pendingRow(section, p) }))
    ];
    const pos = new Map((data.memberOrder || []).map((k, i) => [k, i]));
    const ordered = items.map((it, i) => ({ ...it, i })).sort((a, b) => (pos.has(a.key) ? pos.get(a.key) : 1e6 + a.i) - (pos.has(b.key) ? pos.get(b.key) : 1e6 + b.i));
    const rows = ordered.map(it => it.el());
    list.replaceChildren(...(rows.length ? rows : [h("p", { class: "form-hint" }, "所属ユーザーはいません。")]));
  }

  // ---------- 施設の削除(施設管理者のみ。条件の判定・削除はサーバー。見出しのゴミ箱ボタン→ダイアログで確定) ----------
  // 削除対象は、選択中の施設ID(facility.id)で特定する。ダイアログの施設名は表示のみ(名前では特定しない)
  function deleteMenu() {
    const target = h("p", { class: "delete-target" });
    const doDelete = h("button", { type: "button", class: "btn delete-confirm-btn" }, "この施設を削除する");
    const cancel = h("button", { type: "button", class: "btn btn-secondary" }, "キャンセル");
    const msg = h("p", { class: "error-message", role: "alert", hidden: true });
    const dialog = h("dialog", { class: "delete-dialog", id: "deleteFacilityDialog", "aria-labelledby": "deleteFacilityTitle" },
      h("h3", { id: "deleteFacilityTitle" }, "施設の削除"),
      target,
      h("p", { class: "form-hint" }, "注文履歴がある施設、自分以外の利用者が所属している施設は削除できません。削除すると、この施設の設定（担当医・採用IOL・ディーラーなど）と招待が消え、元に戻せません。"),
      msg,
      h("div", { class: "form-row" }, doDelete, cancel));
    // 編集(鉛筆)と同じ大きさ・背景のゴミ箱ボタン(アイコンは濃いグレー)。押しただけでは削除しない
    const trigger = h("button", { type: "button", class: "btn btn-outline-sm delete-trigger", id: "btnDeleteFacility", "aria-label": "施設を削除", title: "施設を削除" }, trashIcon());

    let deleting = false;
    const closeDialog = () => { if (dialog.open && !deleting) dialog.close(); };
    trigger.addEventListener("click", () => {
      msg.hidden = true; doDelete.disabled = false; cancel.disabled = false; doDelete.textContent = "この施設を削除する";
      target.textContent = `削除する施設: ${facility.name || "（名称未設定）"}`;   // textContent(HTMLとして解釈しない)
      dialog.showModal();
    });
    cancel.addEventListener("click", closeDialog);
    dialog.addEventListener("cancel", (ev) => { if (deleting) ev.preventDefault(); });   // 削除中は Esc でも閉じない
    doDelete.addEventListener("click", async () => {
      if (deleting) return;   // 二重送信の防止
      deleting = true; doDelete.disabled = true; cancel.disabled = true; msg.hidden = true; doDelete.textContent = "削除しています…";
      const facilityId = facility.id;
      try {
        await inviteApi.deleteFacility({ facilityId });
        deleting = false;
        dirty = false;
        closeDialog();
        onDeleted(facilityId);
      } catch (e) {
        const notFound = String((e && e.code) || "").endsWith("not-found") && !/[぀-ヿ一-鿿]/.test(String(e.message || ""));
        msg.textContent = notFound ? "施設の削除は、現在ご利用いただけません。" : describeCallableError(e);
        msg.hidden = false;
        deleting = false; doDelete.disabled = false; cancel.disabled = false; doDelete.textContent = "この施設を削除する";
      }
    });
    return { wrap: trigger, dialog, reset: () => { deleting = false; closeDialog(); } };
  }

  // ---------- 画面全体 ----------
  const built = { orderers: ordererSection(), iols: iolSection(), dealers: dealerSection() };
  if (canManageMembers) built.members = memberSection();
  // 表示順: 担当医 → 利用者管理(管理者・副管理者のみ) → 採用IOL → ディーラー(作成の順番・機能は変えない)
  const sections = { orderers: built.orderers, ...(built.members ? { members: built.members } : {}), iols: built.iols, dealers: built.dealers };
  const isAdmin = actorRole === "admin";   // 施設名の編集・施設削除は管理者のみ表示(サーバーでも管理者のみ)
  const del = isAdmin && inviteApi && inviteApi.deleteFacility ? deleteMenu() : null;
  const title = h("span", { class: "settings-facility" });

  // ---------- 施設名の変更(施設管理者のみ。重複確認はサーバー。施設ID・所属・注文は変わらない) ----------
  const nameInput = h("input", { type: "text", class: "form-control", maxlength: "100", "aria-label": "施設名", autocomplete: "off" });
  const nameSave = h("button", { type: "button", class: "btn btn-primary" }, "変更する");
  const nameCancel = h("button", { type: "button", class: "btn btn-secondary" }, "キャンセル");
  const nameConfirm = h("button", { type: "button", class: "btn btn-secondary", hidden: true }, "別の施設として変更する");
  const nameMsg = h("p", { class: "form-hint", role: "status" });
  const nameBox = h("div", { class: "facility-rename", hidden: true },
    h("label", { class: "form-label" }, "施設名", nameInput),
    h("div", { class: "form-row" }, nameSave, nameConfirm, nameCancel), nameMsg);
  const nameEditBtn = isAdmin && inviteApi && inviteApi.renameFacility
    ? h("button", { type: "button", class: "btn btn-outline-sm", id: "btnRenameFacility", "aria-label": "施設名を編集", title: "施設名を編集" }, pencilIcon())
    : null;
  let renaming = false;
  function setRenameOpen(on) {
    nameBox.hidden = !on;
    if (on) { nameInput.value = facility.name; nameMsg.textContent = ""; nameConfirm.hidden = true; nameInput.focus(); }
  }
  async function submitRename(confirmDuplicate) {
    if (renaming) return;
    const name = nameInput.value.replace(/\s+/g, " ").trim();
    if (!name) { nameMsg.textContent = "施設名を入力してください。"; return; }
    renaming = true; nameSave.disabled = nameConfirm.disabled = true;
    try {
      const r = await inviteApi.renameFacility({ facilityId: facility.id, name, confirmDuplicate });
      if (r.status === "duplicate-candidate") {
        const names = Array.isArray(r.candidates) ? r.candidates.slice(0, 5) : [];
        nameMsg.textContent = "既に登録されている施設と名前が似ています" + (names.length ? "（" + names.join("、") + "）" : "") + "。別の施設の場合のみ、このまま変更できます。";
        nameConfirm.hidden = false;
        return;
      }
      if (r.status === "renamed" || r.status === "unchanged") {
        facility.name = r.name; title.textContent = r.name;
        setRenameOpen(false);
        onRenamed(facility.id, r.name);
      }
    } catch (e) {
      // 関数が未配備の場合(英語の not-found)は、一般的な案内にする
      nameMsg.textContent = String((e && e.code) || "").endsWith("not-found") && !/[぀-ヿ一-鿿]/.test(String(e.message || "")) ? "施設名の変更は、現在ご利用いただけません。" : describeCallableError(e);
    } finally {
      renaming = false; nameSave.disabled = nameConfirm.disabled = false;
    }
  }
  if (nameEditBtn) nameEditBtn.addEventListener("click", () => setRenameOpen(nameBox.hidden));
  nameSave.addEventListener("click", () => submitRename(false));
  nameConfirm.addEventListener("click", () => submitRename(true));
  nameCancel.addEventListener("click", () => setRenameOpen(false));
  nameInput.addEventListener("input", () => { nameConfirm.hidden = true; });
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitRename(false); } });
  const closeBtn = h("button", { type: "button", class: "btn btn-secondary", id: "btnSettingsClose" }, "注文画面に戻る");
  const status = h("p", { class: "form-hint", role: "status" });
  root.append(
    // 「施設設定」の右横に、各設定項目と同じⓘ(説明つき)。説明は常時表示しない
    h("div", { class: "settings-head" }, h("div", { class: "settings-heading" }, h("h2", {}, "施設設定"), createInfoTip("この画面は施設管理者のみ変更できます。", { label: "施設設定の説明" }).root), title, nameEditBtn, del && del.wrap, closeBtn),
    del && del.dialog,
    nameBox,
    status,
    ...Object.values(sections));

  closeBtn.addEventListener("click", async () => {
    await Promise.all(savers().map(s => s.idle()));   // 保存中なら、終わるのを待つ
    const unsaved = dirty || savers().some(s => s.failed);   // 自動保存に失敗した変更も「保存されていない」
    if (unsaved && !window.confirm("保存されていない変更があります。破棄して注文画面に戻りますか？")) return;
    close();
    onClose();
  });

  function close() {
    open = false; dirty = false;
    savers().forEach(s => { s.failed = false; });
    root.hidden = true;
  }

  return {
    isOpen: () => open,
    async open(fac) {
      facility = fac;
      title.textContent = fac.name;
      nameBox.hidden = true;
      if (del) del.reset();
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
