import { sortOrdersNewestFirst } from "../domain/order-history.js";
import { summarizeHistoryOrder, visibleOrders, groupHistoryLinesByDealer } from "../domain/order-history-view.js";
import { groupLinesByDateAndDoctor } from "../domain/order-lines.js";
import { summaryDateHead, summaryLineMain, formatSurgeryDate } from "./confirm-lines.js";
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
export const HISTORY_PAGE = 20;        // 初期表示と「もっと見る」の件数
const SCAN_MAX = 100;                  // 注文日順で1回に読む上限(論理削除した注文を飛ばしながら、20件そろうまで。読み過ぎない)

/**
 * 注文履歴(閲覧。編集・再注文はない)。選択中の施設の注文を表示する。論理削除した注文は出さない。
 * 並び順は「注文日順」(注文日の新しい順)と「手術日順」(手術日の新しい順。手術日が複数の注文は、手術日ごとに出る)。
 * 初めは20件、「もっと見る」で20件ずつさかのぼる(一度に全件は読まない)。重複注文の確認は、この一覧とは別に読む(order-form.js)。
 * 読み取りは Firestore Rules で、その施設の所属メンバーと運営者に限られる(他施設の注文は読めない)。
 * 詳細は注文確認画面と同じ構成・部品: 「手術日 + 担当医」の見出しの下にレンズ(IOL名・度数・枚数)、合計・備考・発注先。
 * 発注先が2社以上なら、ディーラーごとのまとまり(確認画面と同じ)の後に、注文全体の合計と備考を1回。
 * 施設の管理者・副管理者には「この注文を削除」(論理削除。サーバーの deleteOrder が所属・役割・メールの状態を確認する)。
 *
 * @param {object} deps
 * @param {HTMLElement} deps.mount 表示先(施設設定と同じ main)
 * @param {object} deps.repository listOrdersPage・listSurgeryIndexPage・getOrder(ない環境では listOrders の1回だけ)
 * @param {(facilityId:string, orderId:string) => Promise<object>} [deps.deleteOrder] 注文の削除(論理削除)
 * @param {() => void} deps.onClose 「注文画面に戻る」
 */
export function createOrderHistory({ mount, repository, deleteOrder = null, onClose }) {
  const root = h("section", { id: "orderHistory", class: "settings-view order-history", hidden: true });
  mount.insertBefore(root, mount.firstChild);
  let open = false;
  let facility = null;
  let selectedId = null;
  let canDelete = false;   // 施設の管理者・副管理者(表示だけの判定。実行の可否はサーバーが確認する)
  let seq = 0; // 読み込みの世代。施設の切替・並び順の切替・画面を閉じたあとに届いた古い結果は捨てる
  let mode = "created";   // "created"(注文日順)/ "surgery"(手術日順)
  let rows = [];          // 表示中の行 { order, surgeryDate?, lineNos? }
  let cursor = null, hasMore = false, loading = false;
  const buffered = [];       // 注文日順で読んだが、まだ出していない注文(20件ずつ出すため)
  const cache = new Map();   // 注文ID → 表示用データ(手術日順で同じ注文が複数の行になる)
  const paged = () => typeof repository.listOrdersPage === "function";
  const canSurgery = () => typeof repository.listSurgeryIndexPage === "function" && typeof repository.getOrder === "function";

  const closeBtn = h("button", { type: "button", class: "btn btn-secondary", id: "btnHistoryClose" }, "注文画面に戻る");
  const title = h("span", { class: "settings-facility" });
  const status = h("p", { class: "form-hint", role: "status" });
  const body = h("div", { class: "history-body" });
  root.append(h("div", { class: "settings-head" }, h("h2", {}, "注文履歴"), title, closeBtn), status, body);
  closeBtn.addEventListener("click", () => { close(); onClose(); });

  function close() { open = false; selectedId = null; seq++; root.hidden = true; }

  /**
   * 1行「メーカー 型番 度数 枚数」(確認画面と同じ部品。履歴ではレンズ番号・トーリック/多焦点のバッジは出さず、できるだけ1行に収める)。
   * 手術日・担当医・発注先は見出しにまとめる。レンズ番号は表示しない属性(data-line)にだけ残す
   */
  function lineView(l) {
    const main = summaryLineMain({ manufacturer: l.maker, modelName: l.model, power: l.power, quantity: l.quantity });
    return h("li", { class: "summary-line history-line", "data-line": String(l.lineNo) }, main);
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

  /** 並び順の切替(注文日順・手術日順) */
  function sortBar() {
    if (!canSurgery()) return null;
    const btn = (m, label) => {
      const b = h("button", { type: "button", class: "history-sort-btn", "data-sort": m, "aria-pressed": String(mode === m) }, label);
      b.addEventListener("click", () => { if (mode !== m) { mode = m; reload(); } });
      return b;
    };
    return h("div", { class: "history-sort", role: "group", "aria-label": "並び順" }, btn("created", "注文日順"), btn("surgery", "手術日順"));
  }

  function rowView(r) {
    const o = r.order;
    const onDate = r.lineNos ? o.lines.filter(l => r.lineNos.includes(l.lineNo)) : o.lines;   // 手術日順: その手術日のレンズ
    const btn = h("button", { type: "button", class: "history-row", "data-order": o.id, ...(r.surgeryDate !== undefined ? { "data-surgery": r.surgeryDate } : {}) },
      r.surgeryDate !== undefined
        ? h("span", { class: "history-date" }, r.surgeryDate ? `手術日 ${formatSurgeryDate(r.surgeryDate)}` : "手術日の記録なし")
        : h("span", { class: "history-date" }, o.createdAtLabel),
      h("span", { class: "history-by" }, o.isProxyEntry ? `${o.orderedBy}（代行入力）` : o.orderedBy,
        r.surgeryDate !== undefined ? h("span", { class: "history-sub" }, ` ・ 注文 ${o.createdAtLabel}`) : null),
      h("span", { class: "history-count" }, r.lineNos && onDate.length !== o.lines.length ? `${totalLabel(onDate)}（注文全体 ${o.lineCount}件）` : `${o.lineCount}件・合計${o.totalQuantity}枚`),
      o.testOrder ? h("span", { class: "lens-badge" }, "テスト") : null);
    btn.addEventListener("click", () => renderDetail(o.id));
    return h("li", {}, btn);
  }

  function renderList() {
    selectedId = null;
    const list = rows.length
      ? h("ul", { class: "history-list" }, rows.map(rowView))
      : h("p", { class: "form-hint" }, loading ? "読み込み中…" : "この施設の注文はまだありません。");
    const more = (hasMore || buffered.length) && rows.length ? h("button", { type: "button", class: "btn btn-secondary history-more", "data-act": "more", disabled: loading }, loading ? "読み込み中…" : "もっと見る") : null;
    if (more) more.addEventListener("click", () => loadMore());
    body.replaceChildren(...[sortBar(), list, more].filter(Boolean));
  }

  /** 次の20件を読む(注文日順は論理削除した注文を飛ばしながら。手術日順は索引から) */
  async function loadMore() {
    if (loading || !facility) return;
    const mySeq = seq;
    const stale = () => mySeq !== seq || !open;
    loading = true;
    if (selectedId === null) renderList();
    try {
      if (!paged()) {   // 開発用の静的モードなど: 従来の1回だけ
        const raw = await repository.listOrders(facility.id, 50);
        if (stale()) return;
        rows = sortOrdersNewestFirst(visibleOrders(raw.map(summarizeHistoryOrder))).map(order => ({ order }));
        hasMore = false;
      } else if (mode === "created") {
        let scanned = 0;
        while (buffered.length < HISTORY_PAGE && hasMore && scanned < SCAN_MAX) {
          const r = await repository.listOrdersPage(facility.id, { limit: HISTORY_PAGE, cursor });
          if (stale()) return;
          cursor = r.cursor; hasMore = r.hasMore; scanned += r.orders.length;
          for (const raw of r.orders) {
            const o = summarizeHistoryOrder(raw);
            cache.set(o.id, o);
            if (!o.deleted) buffered.push(o);
          }
        }
        rows.push(...buffered.splice(0, HISTORY_PAGE).map(order => ({ order })));
      } else {
        const r = await repository.listSurgeryIndexPage(facility.id, { limit: HISTORY_PAGE, cursor });
        if (stale()) return;
        const missing = [...new Set(r.entries.map(e => e.orderId).filter(id => !cache.has(id)))];
        const got = await Promise.all(missing.map(id => repository.getOrder(facility.id, id)));
        if (stale()) return;
        got.forEach(raw => { if (raw) cache.set(raw.id, summarizeHistoryOrder(raw)); });
        cursor = r.cursor; hasMore = r.hasMore;
        for (const e of r.entries) {
          const o = cache.get(e.orderId);
          if (o && !o.deleted) rows.push({ order: o, surgeryDate: e.surgeryDate || "", lineNos: Array.isArray(e.lineNos) ? e.lineNos : null });   // 削除の直後で索引の印が遅れても出さない
        }
      }
      status.textContent = rows.length ? `${rows.length}件を表示しています${hasMore || buffered.length ? "（「もっと見る」で過去の注文をさかのぼれます）" : ""}。` : "";
    } catch (e) {
      if (stale()) return;
      console.error("注文履歴の読み込みに失敗しました:", e);
      status.textContent = "注文履歴を読み込めませんでした。権限を確認してください。";
    } finally {
      if (!stale()) { loading = false; if (selectedId === null) renderList(); }
    }
  }

  /** 並び順の切替・施設を開いたとき: 先頭から読み直す */
  function reload() {
    seq++;
    rows = []; cursor = null; hasMore = mode === "created" && paged(); loading = false; cache.clear(); buffered.length = 0;
    status.textContent = "読み込み中…";
    renderList();
    return loadMore();
  }

  function renderDetail(id) {
    const o = cache.get(id) || (rows.find(r => r.order.id === id) || {}).order;
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

  /** 確認ダイアログの文: 送信済みは取り消せない・未送信は送信を中止する(件数は表示の記録から。実際の判定はサーバー) */
  function deleteMessage(o) {
    const c = o.mailCounts || { sent: 0, unsent: 0, sending: 0 };
    return [
      `注文 ${o.orderNumber || "（注文番号なし）"} を削除しますか？`,
      c.sent ? `・送信済みのメール（${c.sent}件）は取り消せません。ディーラーへの発注を取り消す場合は、電話などで直接ご連絡ください。` : "・送信済みのメールがあっても、削除では取り消されません。",
      c.unsent ? `・未送信のメール（${c.unsent}件）は送信を中止します（以後、自動で送信・再送信されません）。` : null,
      c.sending ? "・送信処理中のメールがある間は削除できません。" : null,
      "削除した注文は注文履歴に表示されなくなります（記録は保存されます）。発注のやり直しは行われません。"
    ].filter(Boolean).join("\n");
  }

  /** 「この注文を削除」(管理者・副管理者だけ。確認ダイアログの後にサーバーで論理削除) */
  function deleteView(o) {
    const btn = h("button", { type: "button", class: "btn btn-danger btn-sm-inline", "data-act": "deleteOrder" }, "この注文を削除");
    const msg = h("p", { class: "form-hint history-delete-msg", role: "alert" });
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog({ message: deleteMessage(o), okLabel: "削除する" });
      if (!ok || selectedId !== o.id) return;
      const mySeq = seq;
      btn.disabled = true;
      msg.textContent = "削除しています…";
      try {
        const r = await deleteOrder(facility.id, o.id);
        if (mySeq !== seq || !open) return;   // 削除中に施設を切り替えた・閉じた
        rows = rows.filter(x => x.order.id !== o.id);
        cache.delete(o.id);
        renderList();
        const n = r && r.cancelledMails ? `未送信のメール${r.cancelledMails}件の送信を中止しました。` : "";
        status.textContent = `${o.orderNumber ? `注文 ${o.orderNumber}` : "注文"} を削除しました。${n}`;
      } catch (e) {
        if (mySeq !== seq || !open) return;
        console.error("注文の削除に失敗しました:", e);
        btn.disabled = false;
        const code = e && e.code;
        msg.textContent = code === "functions/permission-denied" ? "この施設の管理者・副管理者のみ注文を削除できます。"
          : code === "functions/failed-precondition" && e.message ? e.message   // 送信処理中など(サーバーの理由)
            : "注文を削除できませんでした。時間をおいてもう一度お試しください。";
      }
    });
    return h("div", { class: "history-delete" }, btn, msg);
  }

  return {
    isOpen: () => open,
    async open(fac) {
      facility = fac;
      canDelete = fac.canDelete === true;
      mode = "created";
      title.textContent = fac.name;
      root.hidden = false;
      open = true;
      await reload();
    },
    close
  };
}
