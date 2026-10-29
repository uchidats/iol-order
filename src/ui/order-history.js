import { sortOrdersNewestFirst } from "../domain/order-history.js";
import { summarizeHistoryOrder, visibleOrders, groupHistoryLinesByDealer } from "../domain/order-history-view.js";
import { groupLinesByDateAndDoctor } from "../domain/order-lines.js";
import { lensBadgeElements } from "./lens-badges.js";
import { summaryDateHead, summaryLineMain } from "./confirm-lines.js";
import { confirmDialog } from "./confirm-dialog.js";

/** 要素生成の小さなヘルパー(表示する文字列は textContent で扱い、HTMLとして解釈しない) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

const totalLabel = (lines) => `${lines.length}件・合計${lines.reduce((s, l) => s + l.quantity, 0)}枚`;

/**
 * 注文履歴(閲覧。編集・再注文はない)。選択中の施設の注文を新しい順に表示する。論理削除した注文は出さない。
 * 読み取りは Firestore Rules で、その施設の所属メンバーと運営者に限られる(他施設の注文は読めない)。
 * 詳細は注文確認画面と同じ構成・部品: 「手術日 + 担当医」の見出しの下にレンズ(IOL名・度数・枚数)、合計・備考・発注先。
 * 発注先が2社以上なら、ディーラーごとのまとまり(確認画面と同じ)の後に、注文全体の合計と備考を1回。
 * 施設の管理者・副管理者には「この注文を削除」(論理削除。サーバーの deleteOrder が所属・役割を確認する)。
 *
 * @param {object} deps
 * @param {HTMLElement} deps.mount 表示先(施設設定と同じ main)
 * @param {{listOrders:(facilityId:string, limit:number)=>Promise<Array<object>>}} deps.repository
 * @param {(facilityId:string, orderId:string) => Promise<object>} [deps.deleteOrder] 注文の削除(論理削除)
 * @param {() => void} deps.onClose 「注文画面に戻る」
 */
export function createOrderHistory({ mount, repository, deleteOrder = null, onClose }) {
  const root = h("section", { id: "orderHistory", class: "settings-view order-history", hidden: true });
  mount.insertBefore(root, mount.firstChild);
  let open = false;
  let orders = [];
  let facility = null;
  let selectedId = null;
  let canDelete = false;   // 施設の管理者・副管理者(表示だけの判定。実行の可否はサーバーが確認する)
  let seq = 0; // 読み込みの世代。施設の切替・画面を閉じたあとに届いた古い結果は捨てる

  const closeBtn = h("button", { type: "button", class: "btn btn-secondary", id: "btnHistoryClose" }, "注文画面に戻る");
  const title = h("span", { class: "settings-facility" });
  const status = h("p", { class: "form-hint", role: "status" });
  const body = h("div", { class: "history-body" });
  root.append(h("div", { class: "settings-head" }, h("h2", {}, "注文履歴"), title, closeBtn), status, body);
  closeBtn.addEventListener("click", () => { close(); onClose(); });

  function close() { open = false; selectedId = null; seq++; root.hidden = true; }

  /** 1行「[レンズN] メーカー モデル名 (トーリックなど) 度数 枚数」(確認画面と同じ部品)。手術日・担当医・発注先は見出しにまとめる */
  function lineView(l) {
    const main = summaryLineMain({ manufacturer: l.maker, modelName: l.model, power: l.power, quantity: l.quantity }, h("span", { class: "lens-no-badge" }, `レンズ${l.lineNo}`));
    const model = main.querySelector(".summary-model");
    if (model) model.after(...lensBadgeElements({ isToric: l.isToric, isMultifocal: l.isMultifocal }));
    return h("li", { class: "summary-line history-line" }, main);
  }

  /** 「手術日 + 担当医」ごとのまとまり(確認画面と同じ。手術日の早い順・同じ日は担当医の初出順)。手術日・担当医が違えば別の見出し */
  function dateGroups(lines) {
    const groups = groupLinesByDateAndDoctor(lines.map(l => ({ ...l, doctor: l.doctorName, doctorId: l.doctorKey })));
    return h("ol", { class: "summary-lines history-groups" }, groups.map(g => {
      const head = summaryDateHead(g.surgeryDate || "—", g.doctor);
      if (!g.lines[0].doctorKey) head.querySelector(".summary-doctor").textContent = "担当医の記録なし";
      return h("li", { class: "summary-date-group" }, head, h("ul", { class: "summary-lines summary-date-lines" }, g.lines.map(lineView)));
    }));
  }

  /** 確認画面と同じ項目(dt は読み上げ用に残し、必要なものだけ画面に出す) */
  const item = (label, value, { srOnly = false, cls = "" } = {}) => h("div", { class: ["summary-item", cls].filter(Boolean).join(" ") },
    h("dt", { class: srOnly ? "summary-label sr-only" : "summary-label" }, label), value);
  const dealerItem = (name) => item("発注先", h("dd", { class: "summary-value summary-parties" },
    h("div", { class: "summary-party summary-party-dealers" },
      h("span", { class: "summary-party-label" }, "発注先"),
      h("div", { class: "summary-party-body" }, h("div", { class: "summary-dealer-name history-dealer" }, name || "未設定")))),
  { srOnly: true, cls: "summary-parties-row is-dealer-only" });
  const notesItem = (o) => item("備考", h("dd", { class: "summary-value text-break history-notes" }, o.notes || "（なし）"));

  /** 明細・合計・備考・発注先 */
  function contentView(o) {
    const byDealer = groupHistoryLinesByDealer(o.lines);
    if (byDealer.length <= 1) {
      return h("dl", { class: "summary-list history-summary" },
        item("発注するレンズ", h("dd", { class: "summary-value" }, dateGroups(o.lines)), { srOnly: true, cls: "summary-item-lines" }),
        item("合計", h("dd", { class: "summary-value highlight-value history-total" }, totalLabel(o.lines)), { srOnly: true }),
        notesItem(o),
        dealerItem(byDealer[0] ? byDealer[0].dealerName : null));
    }
    return h("div", { class: "summary-by-dealer history-by-dealer" },
      byDealer.map(g => h("dl", { class: "summary-list summary-dealer-block history-dealer-block", role: "group", "aria-label": `${g.dealerName || "発注先未設定"} 宛ての注文` },
        dealerItem(g.dealerName),
        item("発注するレンズ", h("dd", { class: "summary-value" }, dateGroups(g.lines)), { srOnly: true, cls: "summary-item-lines" }),
        item("小計", h("dd", { class: "summary-value highlight-value history-subtotal" }, totalLabel(g.lines)), { srOnly: true }))),
      h("div", { class: "summary-grand-total" }, h("span", { class: "summary-grand-label" }, "注文全体"), h("span", { class: "highlight-value history-total" }, totalLabel(o.lines))),
      h("dl", { class: "summary-list" }, notesItem(o)));
  }

  function renderList() {
    selectedId = null;
    if (!orders.length) { body.replaceChildren(h("p", { class: "form-hint" }, "この施設の注文はまだありません。")); return; }
    body.replaceChildren(h("ul", { class: "history-list" }, orders.map(o => {
      const btn = h("button", { type: "button", class: "history-row", "data-order": o.id },
        h("span", { class: "history-date" }, o.createdAtLabel),
        h("span", { class: "history-by" }, o.isProxyEntry ? `${o.orderedBy}（代行入力）` : o.orderedBy),
        h("span", { class: "history-count" }, `${o.lineCount}件・合計${o.totalQuantity}枚`),
        o.testOrder ? h("span", { class: "lens-badge" }, "テスト") : null);
      btn.addEventListener("click", () => renderDetail(o.id));
      return h("li", {}, btn);
    })));
  }

  function renderDetail(id) {
    const o = orders.find(x => x.id === id);
    if (!o) return renderList();
    selectedId = id;
    const back = h("button", { type: "button", class: "btn btn-secondary btn-sm-inline", "data-act": "back" }, "← 一覧へ戻る");
    back.addEventListener("click", renderList);
    body.replaceChildren(
      back,
      h("div", { class: "history-detail-head" },
        h("div", {}, h("strong", {}, o.orderNumber || "（注文番号なし）"), o.testOrder ? " " : null, o.testOrder ? h("span", { class: "lens-badge" }, "テスト") : null),
        // 代行入力者の注文は「入力者 氏名（代行入力者）」。担当医は「手術日 + 担当医」の見出しに出す
        h("div", { class: "form-hint" }, o.isProxyEntry
          ? `注文日時 ${o.createdAtLabel} ・ 入力者 ${o.orderedBy}（${o.enteredByRole}）`
          : `注文日時 ${o.createdAtLabel} ・ 発注者 ${o.orderedBy}`),
        h("div", { class: "form-hint history-status" }, `状態 ${o.statusLabel}`)),
      contentView(o),
      // メールの送信結果(発注先ごと・注文控え)。記録がある注文だけ表示する
      o.notifications.length ? h("div", { class: "history-notifications" }, h("strong", {}, "メール送信"),
        h("ul", {}, o.notifications.map(n => h("li", {}, [`${n.dealerName}: ${n.statusLabel}`, n.atLabel ? `（${n.atLabel}）` : "", n.error ? ` ${n.error}` : ""].join(""))))) : null,
      canDelete && deleteOrder ? deleteView(o) : null);
  }

  /** 「この注文を削除」(管理者・副管理者だけ。確認ダイアログの後にサーバーで論理削除。メールの再送信・発注は起きない) */
  function deleteView(o) {
    const btn = h("button", { type: "button", class: "btn btn-danger btn-sm-inline", "data-act": "deleteOrder" }, "この注文を削除");
    const msg = h("p", { class: "form-hint history-delete-msg", role: "alert" });
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog({
        message: `注文 ${o.orderNumber || "（注文番号なし）"} を削除しますか？\n削除した注文は注文履歴に表示されなくなります。発注のやり直しやメールの再送信は行われず、送信済みのメールも取り消されません。`,
        okLabel: "削除する"
      });
      if (!ok || selectedId !== o.id) return;
      const mySeq = seq;
      btn.disabled = true;
      msg.textContent = "削除しています…";
      try {
        await deleteOrder(facility.id, o.id);
        if (mySeq !== seq || !open) return;   // 削除中に施設を切り替えた・閉じた
        orders = orders.filter(x => x.id !== o.id);
        renderList();
        status.textContent = o.orderNumber ? `注文 ${o.orderNumber} を削除しました。` : "注文を削除しました。";
      } catch (e) {
        if (mySeq !== seq || !open) return;
        console.error("注文の削除に失敗しました:", e);
        btn.disabled = false;
        msg.textContent = e && e.code === "functions/permission-denied"
          ? "この施設の管理者・副管理者のみ注文を削除できます。"
          : "注文を削除できませんでした。時間をおいてもう一度お試しください。";
      }
    });
    return h("div", { class: "history-delete" }, btn, msg);
  }

  return {
    isOpen: () => open,
    async open(fac) {
      const mySeq = ++seq;
      const stale = () => mySeq !== seq || !open;
      facility = fac;
      canDelete = fac.canDelete === true;
      orders = [];
      title.textContent = fac.name;
      status.textContent = "読み込み中…";
      body.replaceChildren();
      root.hidden = false;
      open = true;
      try {
        const raw = await repository.listOrders(fac.id, 50);
        if (stale()) return; // 読み込み中に別の施設を開いた・閉じた場合は、この結果を表示しない
        orders = sortOrdersNewestFirst(visibleOrders(raw.map(summarizeHistoryOrder)));   // 論理削除した注文は出さない
        status.textContent = raw.length >= 50 ? "新しい順に最大50件を表示しています。" : "";
        renderList();
      } catch (e) {
        if (stale()) return;
        console.error("注文履歴の読み込みに失敗しました:", e);
        status.textContent = "注文履歴を読み込めませんでした。権限を確認してください。";
      }
    },
    close
  };
}
