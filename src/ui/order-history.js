import { summarizeOrder, sortOrdersNewestFirst } from "../domain/order-history.js";
import { lensBadgeElements } from "./lens-badges.js";

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

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
function formatSurgeryDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? (iso || "—") : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]})`;
}

/**
 * 注文履歴(閲覧のみ。編集・削除・再注文はない)。選択中の施設の注文を新しい順に表示する。
 * 読み取りは Firestore Rules で、その施設の所属メンバーと運営者に限られる(他施設の注文は読めない)。
 *
 * @param {object} deps
 * @param {HTMLElement} deps.mount 表示先(施設設定と同じ main)
 * @param {{listOrders:(facilityId:string, limit:number)=>Promise<Array<object>>}} deps.repository
 * @param {() => void} deps.onClose 「注文画面に戻る」
 */
export function createOrderHistory({ mount, repository, onClose }) {
  const root = h("section", { id: "orderHistory", class: "settings-view order-history", hidden: true });
  mount.insertBefore(root, mount.firstChild);
  let open = false;
  let orders = [];
  let facility = null;
  let selectedId = null;
  let seq = 0; // 読み込みの世代。施設の切替・画面を閉じたあとに届いた古い結果は捨てる

  const closeBtn = h("button", { type: "button", class: "btn btn-secondary", id: "btnHistoryClose" }, "注文画面に戻る");
  const title = h("span", { class: "settings-facility" });
  const status = h("p", { class: "form-hint", role: "status" });
  const body = h("div", { class: "history-body" });
  root.append(h("div", { class: "settings-head" }, h("h2", {}, "注文履歴"), title, closeBtn), status, body);
  closeBtn.addEventListener("click", () => { close(); onClose(); });

  function close() { open = false; selectedId = null; seq++; root.hidden = true; }

  function lineView(l) {
    const main = h("div", { class: "summary-line-main" },
      h("span", { class: "lens-no-badge" }, `レンズ${l.lineNo}`),
      h("span", { class: "summary-maker" }, l.maker),
      h("span", { class: "summary-model" }, l.model),
      lensBadgeElements({ isToric: l.isToric, isMultifocal: l.isMultifocal }),
      h("span", { class: "summary-power" }, l.power),
      h("span", { class: "summary-qty" }, `${l.quantity}枚`));
    return h("li", { class: "summary-line history-line" },
      main,
      h("div", { class: "summary-line-date" }, `手術日 ${formatSurgeryDate(l.surgeryDate)}`),
      h("div", { class: "summary-line-detail" }, `担当医 ${l.doctorName} ・ `, l.dealerName ? `発注先 ${l.dealerName}` : "発注先未設定"));
  }

  function renderList() {
    selectedId = null;
    if (!orders.length) { body.replaceChildren(h("p", { class: "form-hint" }, "この施設の注文はまだありません。")); return; }
    body.replaceChildren(h("ul", { class: "history-list" }, orders.map(o => {
      const btn = h("button", { type: "button", class: "history-row", "data-order": o.id },
        h("span", { class: "history-date" }, o.createdAtLabel),
        h("span", { class: "history-by" }, o.orderedBy),
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
        h("div", { class: "form-hint" }, `注文日時 ${o.createdAtLabel} ・ 発注者 ${o.orderedBy}`)),
      h("ul", { class: "summary-lines history-lines" }, o.lines.map(lineView)),
      h("p", { class: "history-total" }, `${o.lineCount}件・合計${o.totalQuantity}枚`));
  }

  return {
    isOpen: () => open,
    async open(fac) {
      const mySeq = ++seq;
      const stale = () => mySeq !== seq || !open;
      facility = fac;
      orders = [];
      title.textContent = fac.name;
      status.textContent = "読み込み中…";
      body.replaceChildren();
      root.hidden = false;
      open = true;
      try {
        const raw = await repository.listOrders(fac.id, 50);
        if (stale()) return; // 読み込み中に別の施設を開いた・閉じた場合は、この結果を表示しない
        orders = sortOrdersNewestFirst(raw.map(summarizeOrder));
        status.textContent = orders.length >= 50 ? "新しい順に最大50件を表示しています。" : "";
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
