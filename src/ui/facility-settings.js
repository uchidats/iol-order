import {
  validateOrderers, planOrdererWrites, validateAdoption, planAdoptedWrites,
  validateDealers, planDealerWrites, LIMITS
} from "../domain/facility-settings.js";
import { planMemberRemoval, confirmMessage, memberLabel, sortMembers } from "../domain/member-admin.js";
import { createSectionHeading } from "./info-tip.js";
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
    const iolOrder = repository.getIolOrder ? await repository.getIolOrder(facility.id) : null;
    data = { orderers, adopted, dealers, iolOrder, members: canManageMembers ? await repository.listMembers(facility.id) : [] };
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
      btn("edit", "名前・メールを編集", pencilIcon()),
      btn("up", "上へ", "↑"),
      btn("down", "下へ", "↓"),
      btn("delete", "この担当医を削除", trashIcon()));
    const nameInput = h("input", { class: "form-control", "data-f": "name", type: "text", maxlength: LIMITS.ordererNameMax, placeholder: "氏名（必須）", "aria-label": "氏名（必須）" });
    const emailInput = h("input", { class: "form-control", "data-f": "email", type: "email", placeholder: "メールアドレス（任意）", "aria-label": "メールアドレス（任意）" });
    const editBox = h("div", { class: "orderer-edit", hidden: true },
      nameInput, emailInput,
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
      paint(); nameInput.focus();
    };
    row._commit = () => { row._state.name = nameInput.value; row._state.email = emailInput.value; editing = false; paint(); };
    row._cancel = () => {
      if (!row._state.id && !row._state.name && !row._state.email) { row.remove(); return; } // 追加したばかりの行は取り消すと消える
      editing = false; err.textContent = ""; paint();
    };
    row._paint = paint;

    row.querySelector('[data-act="edit"]').addEventListener("click", () => row._startEdit());
    row.querySelector('[data-act="cancel-row"]').addEventListener("click", () => row._cancel());
    row.querySelector('[data-act="save-row"]').addEventListener("click", () => saveOrdererRow(row));
    row.querySelector('[data-act="up"]').addEventListener("click", () => { if (row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling); markDirty(); });
    row.querySelector('[data-act="down"]').addEventListener("click", () => { if (row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row); markDirty(); });
    row.querySelector('[data-act="delete"]').addEventListener("click", () => deleteOrdererRow(row));
    paint();
    return row;
  }

  /** 行の「保存」: この行の編集内容を、一覧全体の既存の検証にかけ、問題なければ(並び替えなどの未保存の変更も含めて)保存する */
  async function saveOrdererRow(row) {
    const section = sections.orderers;
    const before = { name: row._state.name, email: row._state.email };
    const typed = { name: row.querySelector('[data-f="name"]').value, email: row.querySelector('[data-f="email"]').value };
    row._commit();
    const v = validateOrderers(readOrdererRows(section));
    showRowErrors(section, v.errors);
    if (!v.ok) { // 検証に通らなければ、編集中のまま入力を残す
      row._state.name = before.name; row._state.email = before.email; row._startEdit();
      const own = row.querySelector("[data-err]");
      if (!own.textContent) own.textContent = v.errors.map(e => e.message).join(" / "); // 重複など、他の行側に出た指摘も、編集中の行に表示する
      row.querySelector('[data-f="name"]').value = typed.name; row.querySelector('[data-f="email"]').value = typed.email; // 入力した内容は残す
      return message(section, "入力内容を確認してください。", true);
    }
    await saveOrderersNow(section);
  }

  async function saveOrderersNow(section) {
    const v = validateOrderers(readOrdererRows(section));
    showRowErrors(section, v.errors);
    if (!v.ok) return message(section, "入力内容を確認してください。", true);
    const writes = planOrdererWrites(data.orderers, v.cleaned, facility.id);
    if (!writes.length) return message(section, "変更はありません。");
    const ok = await saveWith(section, section.querySelector('[data-act="save"]'), () => settingsApi.saveOrderers(facility.id, writes));
    if (ok) { renderOrderers(section); message(section, "担当医を保存しました。"); }
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
      await settingsApi.deleteOrderer(facility.id, id);
      data.orderers = data.orderers.filter(o => o.id !== id);
      row.remove();
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
      createSectionHeading("担当医", "注文フォームの「担当医」に表示されます。鉛筆で編集、↑↓で並び替え、ゴミ箱で削除できます。"),
      h("div", { "data-list": "" }),
      h("div", { class: "settings-actions" },
        h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "add" }, "担当医を追加"),
        h("button", { type: "button", class: "btn btn-primary", "data-act": "save" }, "担当医を保存")),
      h("p", { class: "form-hint", "data-msg": "" }));
    section.querySelector('[data-act="add"]').addEventListener("click", () => {
      const row = ordererRow(); section.querySelector("[data-list]").appendChild(row); markDirty();
      row._startEdit(); // 追加した行は編集状態で表示する
    });
    const saveBtn = section.querySelector('[data-act="save"]');
    saveBtn.addEventListener("click", async () => {
      if ([...section.querySelectorAll(".orderer-item")].some(r => r._isEditing())) {
        return message(section, "編集中の行を、保存またはキャンセルしてください。", true);
      }
      await saveOrderersNow(section);
    });
    return section;
  }

  // ---------- 採用IOL ----------
  function iolSection() {
    const section = h("section", { class: "settings-section", "data-section": "iols" },
      createSectionHeading("採用IOL", "施設で使用するIOLを選択します。チェックしたモデルだけが注文フォームに表示されます。↑↓でメーカーとモデルの表示順を変更できます。"),
      h("div", { "data-list": "" }),
      h("div", { class: "settings-actions" }, h("button", { type: "button", class: "btn btn-primary", "data-act": "save" }, "採用IOLを保存")),
      h("p", { class: "form-hint", "data-msg": "" }));
    const saveBtn = section.querySelector('[data-act="save"]');
    saveBtn.addEventListener("click", async () => {
      const selected = [...section.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);
      const v = validateAdoption(selected, masters);
      if (!v.ok) return message(section, "マスターに存在しないIOLは登録できません。", true);
      const writes = planAdoptedWrites(masters, data.adopted, selected, facility.id);
      // 表示順(メーカーの順番・モデルの順番)は、画面に並んでいる順番をそのまま保存する。並べ替えていなければ書かない
      const order = buildIolOrderSetting(masters,
        [...section.querySelectorAll("details.iol-maker")].map(d => d.getAttribute("data-maker")),
        [...section.querySelectorAll('.iol-model-row input[type="checkbox"]')].map(c => c.value));
      const orderChanged = Boolean(section._orderDirty) && Boolean(settingsApi.saveIolOrder);
      if (!writes.length && !orderChanged) return message(section, "変更はありません。");
      const ok = await saveWith(section, saveBtn, async () => {
        if (writes.length) await settingsApi.saveAdoptedIols(facility.id, writes);
        if (orderChanged) await settingsApi.saveIolOrder(facility.id, order);
      });
      if (ok) { section._orderDirty = false; renderIols(section); message(section, "採用IOLを保存しました。"); }
    });
    return section;
  }

  function renderIols(section) {
    const enabled = new Set(data.adopted.filter(a => a.enabled).map(a => a.catalogIolId));
    // メーカーごとに折りたたみ(初期はすべて閉じる)。見出しの右側に「採用数/登録数」と、並べ替えの↑↓。チェックと保存は従来どおり。
    // 並び順は施設ごとの設定(未設定は標準の順番)。新しいメーカー・モデルは既存の順番の末尾
    const mover = (act, label, text, move) => {
      const b = h("button", { type: "button", class: "btn btn-outline-sm orderer-icon iol-move", "data-act": act, "aria-label": label, title: label }, text);
      b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); move(); section._orderDirty = true; markDirty(); }); // summary の開閉は起こさない
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
        mover("maker-up", `${mfg}を上へ`, "↑", () => swap(group, -1)),
        mover("maker-down", `${mfg}を下へ`, "↓", () => swap(group, 1)));
      group = h("details", { class: "iol-maker", "data-maker": mfg },
        h("summary", { class: "iol-maker-summary" }, h("span", { class: "iol-maker-name" }, mfg), count, makerMoves),
        h("div", { class: "iol-maker-list" },
          items.map(m => {
            let row;
            const moves = h("span", { class: "iol-moves" },
              mover("model-up", `${baseModelName(m)}を上へ`, "↑", () => swap(row, -1)),
              mover("model-down", `${baseModelName(m)}を下へ`, "↓", () => swap(row, 1)));
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
    list.onchange = (e) => { const g = e.target.closest("details"); if (g && g._updateCount) g._updateCount(); markDirty(); };
  }

  // ---------- ディーラー ----------
  function dealerRow(d = { id: null, name: "", orderEmails: [], usageReportEmails: [] }) {
    // ディーラーに有効/無効はない。不要になったディーラーは削除する(過去の注文に保存されたディーラー情報は残る)
    const del = h("button", { type: "button", class: "btn btn-outline-sm orderer-icon", "data-act": "delete-dealer", "aria-label": "このディーラーを削除", title: "削除" }, trashIcon());
    const row = h("div", { class: "settings-card", "data-id": d.id || "" },
      h("div", { class: "dealer-head" },
        h("input", { class: "form-control", "data-f": "name", type: "text", value: d.name, maxlength: LIMITS.dealerNameMax, placeholder: "ディーラー名", "aria-label": "ディーラー名" }),
        del),
      h("label", { class: "form-label" }, "発注用メールアドレス（1行に1件・最大" + LIMITS.emailsPerList + "件）",
        h("textarea", { class: "form-control", "data-f": "orderEmails", rows: "2", placeholder: "order@example.jp" }, (d.orderEmails || []).join("\n"))),
      h("label", { class: "form-label" }, "使用報告用メールアドレス（発注用とは別に管理）",
        h("textarea", { class: "form-control", "data-f": "usageEmails", rows: "2", placeholder: "report@example.jp" }, (d.usageReportEmails || []).join("\n"))),
      h("p", { class: "error-message", "data-err": "" }));
    row.addEventListener("input", markDirty);
    row.addEventListener("change", markDirty);
    del.addEventListener("click", () => deleteDealerRow(row, del));
    return row;
  }

  /**
   * ディーラーの削除。保存済みのディーラーは即時に削除する(以後の注文の発注先として使えなくなる。過去の注文に保存された情報は変わらない)。
   * 他の行の未保存の編集は保持する。未保存の追加行は画面から外すだけ。
   */
  async function deleteDealerRow(row, btn) {
    const section = sections.dealers;
    const id = row.getAttribute("data-id");
    const name = row.querySelector('[data-f="name"]').value.trim() || "このディーラー";
    if (!id) { row.remove(); return; }
    if (!window.confirm(`ディーラー「${name}」を削除しますか？\n以後の注文の発注先として使えなくなります。過去の注文に保存されたディーラー情報には影響しません。`)) return;
    btn.disabled = true;
    message(section, "削除しています…");
    try {
      await settingsApi.deleteDealer(facility.id, id);
      data.dealers = data.dealers.filter(x => x.id !== id);
      row.remove();
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
      createSectionHeading("ディーラー", "発注先ディーラーの連絡先を登録します。注文用と使用報告用のメールアドレスを別々に設定できます。現在は登録のみで、メール送信は行われません。"),
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
  // 所属に有効/無効はない。不要になった一般注文者は、所属を削除する(管理者の所属・自分自身は削除できない)
  const canManageMembers = Boolean(currentUser && repository.listMembers && inviteApi && inviteApi.removeMember);

  function memberSection() {
    return h("section", { class: "settings-section", "data-section": "members" },
      createSectionHeading("利用者管理", "この施設の利用者を管理します。新しい利用者の招待と、不要になった利用者の所属削除ができます。"),
      h("div", { "data-list": "" }),
      h("p", { class: "form-hint", "data-msg": "" }));
  }

  function renderMembers(section) {
    const list = section.querySelector("[data-list]");
    const rows = sortMembers(data.members).map((m) => {
      const plan = planMemberRemoval(data.members, m, currentUser.uid);
      // 1段目: 氏名 + 権限バッジ + 右端に操作(一般注文者のみ「所属を削除」) / 2段目: メール(登録がある場合のみ)
      const btn = plan.ok
        ? h("button", { type: "button", class: "btn btn-outline-sm orderer-icon", "data-act": "remove-member", "aria-label": `${memberLabel(m)} の所属を削除`, title: "所属を削除" }, trashIcon())
        : null;
      const row = h("div", { class: "settings-row settings-row-member", "data-uid": m.uid },
        h("span", { class: "settings-member-title" },
          h("span", { "data-f": "name" }, memberLabel(m)),
          h("span", { class: "member-role-badge", "data-f": "role" }, m.role === "admin" ? "管理者" : "注文者")),
        h("span", { class: "settings-member-action" }, btn),
        m.email ? h("span", { class: "settings-member-meta" }, h("span", { "data-f": "email" }, m.email)) : null);
      if (btn) {
        btn.addEventListener("click", async () => {
          if (!window.confirm(confirmMessage(m))) return;
          btn.disabled = true;
          message(section, "削除しています…");
          try {
            await inviteApi.removeMember({ facilityId: facility.id, uid: m.uid });
            data.members = await repository.listMembers(facility.id);
            renderMembers(section);
            message(section, `${memberLabel(m)} の所属を削除しました。`);
          } catch (e) {
            console.error("所属の削除に失敗しました:", e);
            message(section, describeCallableError(e), true);
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
      createSectionHeading("メンバーの招待", "招待したメールアドレスでログインした本人だけが参加できます。招待コードの有効期限は7日間で、1回のみ使用可能です。メールは自動送信されないため、本人に直接お伝えください。"),
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
