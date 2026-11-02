import { sortOrdersNewestFirst } from "../domain/order-history.js";
import { summarizeHistoryOrder, visibleOrders, groupHistoryLinesByDealer, historyCardGroups, groupSurgeryRowsByDate, historyDoctorLabel, todayJst } from "../domain/order-history-view.js";
import { groupLinesByDateAndDoctor } from "../domain/order-lines.js";
import { summaryDateHead, summaryLineMain, formatShortSurgeryDate } from "./confirm-lines.js";
import { confirmDialog } from "./confirm-dialog.js";
import { lensDayHead, lensRow as lensRowEl } from "./history-lens.js";

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
const SCAN_MAX = 200;                  // 1回の「もっと見る」で読む上限(論理削除・取消済みを飛ばしながら、20件そろうまで。読み過ぎない)

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
 * @param {() => string} [deps.today] 日本時間の今日(YYYY-MM-DD)。テストで固定するときだけ渡す
 */
export function createOrderHistory({ mount, repository, deleteOrder = null, onClose, today = todayJst }) {
  const root = h("section", { id: "orderHistory", class: "settings-view order-history", hidden: true });
  mount.insertBefore(root, mount.firstChild);
  let open = false;
  let facility = null;
  let selectedId = null;
  let canDelete = false;   // 施設の管理者・副管理者(表示だけの判定。実行の可否はサーバーが確認する)
  let seq = 0; // 読み込みの世代。施設の切替・並び順の切替・画面を閉じたあとに届いた古い結果は捨てる
  let mode = "created";   // "created"(注文日順)/ "surgery"(手術日順)
  let includePast = false;        // 手術日順の「過去分」(初期OFF = 日本時間の今日以降の手術日だけ)
  let includeCancelled = false;   // 「取消済み」(初期OFF = 取消済みの注文を出さない。両方の並び順。「過去分」とは別に切り替える)
  let surgeryToday = null;        // 手術日順の今日(日本時間)。読み直しのときに決め、ページ送りでも同じ境目を使う(日付が変わってもずれない)
  let listScrollY = 0;            // 詳細を開く前の一覧のスクロール位置(「← 一覧へ戻る」で戻す)
  /**
   * 読み込みの流れ(行・カーソル・続きの有無・読み足して出していない行)。過去と未来は別のクエリ・別のカーソルで、境目(surgeryToday)で重ならない。
   * main = 注文日順(新しい順) / 手術日順の今日以降(早い順)。past = 手術日順の「過去分」(今日より前を手術日の新しい順に読み、画面では早い順で上に足す)
   */
  const stream = () => ({ rows: [], cursor: null, hasMore: false, buffered: [], loading: false });
  let main = stream(), past = stream();
  const cache = new Map();   // 注文ID → 表示用データ(手術日順で同じ注文が複数の行になる)
  const paged = () => typeof repository.listOrdersPage === "function";
  const canSurgery = () => typeof repository.listSurgeryIndexPage === "function" && typeof repository.getOrder === "function";
  const showPast = () => mode === "surgery" && includePast && canSurgery();
  const allRows = () => [...past.rows, ...main.rows];
  /** 一覧に出す注文か(論理削除は出さない。取消済みは「取消済み」がONのときだけ) */
  const visible = (o) => Boolean(o) && !o.deleted && (includeCancelled || !o.cancelled);

  const closeBtn = h("button", { type: "button", class: "btn btn-secondary", id: "btnHistoryClose" }, "注文画面に戻る");
  const status = h("p", { class: "form-hint", role: "status" });
  const body = h("div", { class: "history-body" });
  // 施設名はヘッダーに出ているため、見出しには出さない(空の .settings-facility は「注文画面に戻る」を右端に寄せる余白。使い方の見出しと同じ)
  root.append(h("div", { class: "settings-head" }, h("h2", {}, "注文履歴"), h("span", { class: "settings-facility" }), closeBtn), status, body);
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

  /**
   * 並び順の切替(注文日順・手術日順)と、右の小さな選択式ボタン(押すたびにON/OFF。ONは青)。
   * 「過去分」は手術日順のときだけ、「取消済み」は両方の並び順で表示する(状態は並び順を切り替えても保つ)。切り替えると先頭から読み直す
   */
  function sortBar() {
    const btn = (m, label) => {
      const b = h("button", { type: "button", class: "history-sort-btn", "data-sort": m, "aria-pressed": String(mode === m) }, label);
      b.addEventListener("click", () => { if (mode !== m) { mode = m; reload(); } });
      return b;
    };
    const toggle = (key, label, on, title, set) => {
      const b = h("button", { type: "button", class: "history-filter-btn", "data-filter": key, "aria-pressed": String(on), title }, label);
      b.addEventListener("click", () => { set(!on); reload(); });
      return b;
    };
    const sort = canSurgery() ? h("div", { class: "history-sort", role: "group", "aria-label": "並び順" }, btn("created", "注文日順"), btn("surgery", "手術日順")) : null;
    const filters = h("div", { class: "history-filters", role: "group", "aria-label": "表示する注文" },
      mode === "surgery" ? toggle("past", "過去分", includePast, "過去の手術日も表示する", v => { includePast = v; }) : null,
      toggle("cancelled", "取消済み", includeCancelled, "取り消した注文も表示する", v => { includeCancelled = v; }));
    return h("div", { class: "history-sort-bar" }, sort, filters);
  }

  /** 注文の状態のバッジ(取消済み・テスト) */
  const orderBadges = (o) => [o.cancelled ? h("span", { class: "history-cancelled-badge" }, "取消済み") : null, o.testOrder ? h("span", { class: "lens-badge" }, "テスト") : null].filter(Boolean);
  /** 一覧の手術日の見出しとレンズ行(ディーラーの受注一覧と共通の部品 history-lens.js)。担当医は「内田Dr」、記録なしは「担当医の記録なし」 */
  const dayHead = lensDayHead;
  const lensRow = (tag, attrs, l, badges = []) => lensRowEl(tag, { lineNo: l.lineNo, model: l.model, power: l.power, quantity: l.quantity }, { doctor: historyDoctorLabel(l), badges, className: attrs.class || "" });

  /**
   * 注文日順のカード(押すと詳細)。最上部に注文番号を控えめに(番号に日付が含まれるので注文日時は出さない)、その下に手術日ごとの見出し
   * (担当医が複数でも日付は1回)とレンズ行を最大5行、超えた分は「ほか N件」。取消済み・テストのバッジは1つ目の見出しの右端。
   * 注文日時・発注者・件数・合計枚数・発注先名は出さない(詳細で確認する)
   */
  function rowView(r) {
    const o = r.order;
    const { groups, hidden } = historyCardGroups(o.lines);
    const badges = orderBadges(o);
    const btn = h("button", { type: "button", class: ["history-row", "history-card", o.cancelled ? "is-cancelled" : ""].filter(Boolean).join(" "), "data-order": o.id },
      o.orderNumber ? h("div", { class: "history-card-no" }, o.orderNumber) : null,
      groups.map((g, i) => h("div", { class: "history-card-group" }, dayHead(g.surgeryDate, i === 0 ? badges : []),
        h("ul", { class: "history-card-lines" }, g.lines.map(l => lensRow("li", { class: "summary-line" }, l))))),
      groups.length ? null : h("div", { class: "history-card-head" }, h("span", {}, "明細の記録なし"), badges.length ? h("span", { class: "history-card-badges" }, badges) : null),
      hidden ? h("div", { class: "history-card-more" }, `ほか${hidden}件`) : null);
    btn.addEventListener("click", () => renderDetail(o.id));
    return h("li", {}, btn);
  }

  /**
   * 手術日順: 読み込み済みの行(索引)を手術日ごとの見出し1つにまとめ(注文・担当医が違っても同じ日付は1つ。ページの境目もまたぐ)、
   * その日のレンズを索引の順に1行ずつ。各行を押すと、そのレンズを含む注文の詳細。取消済み・テストのバッジは該当する行に
   */
  function surgeryDays(rows) {
    return groupSurgeryRowsByDate(rows).map(d => h("li", { class: "history-day", "data-day": d.surgeryDate }, dayHead(d.surgeryDate),
      h("ul", { class: "history-day-lines" }, d.items.map(({ order: o, line: l }) => {
        const b = h("button", { type: "button", class: "history-row history-lens-btn", "data-order": o.id, "data-surgery": d.surgeryDate, "data-line": String(l.lineNo) },
          lensRow("div", {}, l, orderBadges(o)));
        b.addEventListener("click", () => renderDetail(o.id));
        return h("li", {}, b);
      }))));
  }

  /** 手術日順の「過去分」の境目(この下が今日以降) */
  const todayDivider = () => h("li", { class: "history-today" }, `今日（${formatShortSurgeryDate(surgeryToday)}）以降`);

  function renderList() {
    selectedId = null;
    const rows = allRows();
    const loading = main.loading || past.loading;
    const mainMore = main.hasMore || main.buffered.length > 0;
    let list;
    if (showPast() && rows.length) {
      list = h("ul", { class: "history-list" }, surgeryDays(past.rows), todayDivider(),
        main.rows.length ? surgeryDays(main.rows) : (main.loading || mainMore ? null : h("li", { class: "form-hint history-empty" }, "今日以降に手術予定の注文はありません。")));
    } else if (rows.length) {
      list = h("ul", { class: "history-list" }, mode === "surgery" ? surgeryDays(rows) : rows.map(rowView));
    } else {
      const hint = includeCancelled ? "" : "（取消済みの注文は「取消済み」を選ぶと表示できます）";
      list = h("p", { class: "form-hint" }, loading ? "読み込み中…"
        : mainMore || past.hasMore ? "表示する注文が見つかりませんでした。「もっと見る」で続きを探せます。"
          : mode === "surgery" && !includePast ? `今日以降に手術予定の注文はありません（「過去分」を選ぶと過去の手術日も表示できます）。${includeCancelled ? "" : "取消済みの注文は「取消済み」を選ぶと表示できます。"}`
            : mode === "surgery" ? `手術日のある注文はありません${hint}。` : `この施設の注文はまだありません${hint}。`);
    }
    // 上: 過去の手術日の続き(手術日順の「過去分」だけ)。下: 注文日順の過去の注文 / 手術日順の今日以降の続き
    const morePast = showPast() && (past.hasMore || past.buffered.length) && (rows.length || !past.loading)
      ? h("button", { type: "button", class: "btn btn-secondary history-more history-more-past", "data-act": "more-past", disabled: past.loading }, past.loading ? "読み込み中…" : "過去の注文をもっと見る") : null;
    if (morePast) morePast.addEventListener("click", () => loadPast());
    const more = mainMore && (rows.length || !main.loading) ? h("button", { type: "button", class: "btn btn-secondary history-more", "data-act": "more", disabled: main.loading }, main.loading ? "読み込み中…" : "もっと見る") : null;
    if (more) more.addEventListener("click", () => loadMore());
    body.replaceChildren(...[sortBar(), morePast, list, more].filter(Boolean));
  }

  function updateStatus() {
    const n = allRows().length;
    const hint = mode === "surgery" ? "（「もっと見る」で続きを表示できます）" : "（「もっと見る」で過去の注文をさかのぼれます）";
    status.textContent = n ? `${n}件を表示しています${main.hasMore || main.buffered.length ? hint : ""}。` : "";
  }

  /** 固定表示のヘッダーの下端(スクロール位置の計算で、ヘッダーに隠れる分を除く) */
  function headerBottom() {
    const hd = document.querySelector(".app-header");
    return hd && getComputedStyle(hd).position === "sticky" ? Math.max(0, hd.getBoundingClientRect().bottom) : 0;
  }
  const anchorKey = (e) => e.classList.contains("history-today") ? "today" : `${e.dataset.order}@${e.dataset.surgery ?? ""}#${e.dataset.line ?? ""}`;   // 手術日順はレンズ行ごと
  const anchors = () => [...body.querySelectorAll(".history-list .history-row, .history-list .history-today")];
  /** 上に行を足す前に、画面に見えている先頭のカード(または境目)の位置を覚え、描き直した後に同じ位置へ戻す関数を返す */
  function keepScrollAnchor() {
    const top0 = headerBottom();
    const a = anchors().find(e => e.getBoundingClientRect().bottom > top0);
    if (!a) return () => {};
    const key = anchorKey(a), before = a.getBoundingClientRect().top;
    return () => {
      const b = anchors().find(e => anchorKey(e) === key);
      if (b) window.scrollBy(0, b.getBoundingClientRect().top - before);
    };
  }
  /** 「過去分」ONで開いたとき: 今日付近を最初に見せる。今日以降があれば境目を画面の上に、なければ直近の過去分が画面の下側に見えるように */
  function scrollToToday() {
    const d = body.querySelector(".history-today");
    if (!d) return;
    const r = d.getBoundingClientRect();
    window.scrollBy(0, main.rows.length ? r.top - headerBottom() - 8 : r.bottom - window.innerHeight + 16);
  }

  /**
   * 続きを読む(除外する注文 = 論理削除・OFFのときの取消済みを飛ばしながら、20件そろうまで読み足す。一度に読む上限 SCAN_MAX)。
   * そろった分を返す(読み足した残りは st.buffered に残し、次の「もっと見る」で先に出す)。古い世代になったら null
   */
  async function fill(st, fetchPage, stale) {
    let scanned = 0;
    while (st.buffered.length < HISTORY_PAGE && st.hasMore && scanned < SCAN_MAX) {
      const r = await fetchPage(st.cursor, stale);
      if (stale()) return null;
      st.cursor = r.cursor; st.hasMore = r.hasMore; scanned += r.count;
      st.buffered.push(...r.rows);
    }
    return st.buffered.splice(0, HISTORY_PAGE);
  }
  const NONE = { rows: [], cursor: null, hasMore: false, count: 0 };
  /** 注文日順の1ページ(注文の新しい順) */
  async function fetchCreated(cur, stale) {
    const r = await repository.listOrdersPage(facility.id, { limit: HISTORY_PAGE, cursor: cur });
    if (stale()) return NONE;
    const out = [];
    for (const raw of r.orders) {
      const o = summarizeHistoryOrder(raw);
      cache.set(o.id, o);
      if (visible(o)) out.push({ order: o });
    }
    return { rows: out, cursor: r.cursor, hasMore: r.hasMore, count: r.orders.length };
  }
  /** 手術日順の1ページ(索引から。opts: { fromDate } = 今日以降を早い順 / { before } = 今日より前を新しい順)。注文本体は読んでいないものだけ読む */
  const fetchSurgery = (opts) => async (cur, stale) => {
    const r = await repository.listSurgeryIndexPage(facility.id, { limit: HISTORY_PAGE, cursor: cur, ...opts });
    if (stale()) return NONE;
    const live = r.entries.filter(e => e.deleted !== true);   // 論理削除した注文の索引は読まない
    const missing = [...new Set(live.map(e => e.orderId).filter(id => !cache.has(id)))];
    const got = await Promise.all(missing.map(id => repository.getOrder(facility.id, id)));
    if (stale()) return NONE;
    got.forEach(raw => { if (raw) cache.set(raw.id, summarizeHistoryOrder(raw)); });
    const out = [];
    for (const e of live) {
      const o = cache.get(e.orderId);
      if (visible(o)) out.push({ order: o, surgeryDate: e.surgeryDate || "", lineNos: Array.isArray(e.lineNos) ? e.lineNos : null });   // 削除の直後で索引の印が遅れても出さない
    }
    return { rows: out, cursor: r.cursor, hasMore: r.hasMore, count: r.entries.length };
  };

  /** 下の「もっと見る」: 注文日順は過去へ、手術日順は今日以降の続きを20件 */
  async function loadMore() {
    if (main.loading || !facility) return;
    const mySeq = seq;
    const stale = () => mySeq !== seq || !open;
    main.loading = true;
    if (selectedId === null) renderList();
    try {
      if (!paged()) {   // 開発用の静的モードなど: 従来の1回だけ
        const raw = await repository.listOrders(facility.id, 50);
        if (stale()) return;
        main.rows = sortOrdersNewestFirst(visibleOrders(raw.map(summarizeHistoryOrder))).filter(visible).map(order => ({ order }));
        main.hasMore = false;
      } else {
        const got = await fill(main, mode === "created" ? fetchCreated : fetchSurgery({ fromDate: surgeryToday }), stale);
        if (!got) return;
        main.rows.push(...got);
      }
      updateStatus();
    } catch (e) {
      if (stale()) return;
      console.error("注文履歴の読み込みに失敗しました:", e);
      status.textContent = "注文履歴を読み込めませんでした。権限を確認してください。";
    } finally {
      if (!stale()) { main.loading = false; if (selectedId === null) renderList(); }
    }
  }

  /** 上の「過去の注文をもっと見る」: 今日より前の手術日を、今日に近い方から20件。上に足しても、見ているカードの位置は動かさない */
  async function loadPast({ keepPosition = true } = {}) {
    if (past.loading || !facility || !showPast()) return;
    const mySeq = seq;
    const stale = () => mySeq !== seq || !open;
    const draw = () => { if (selectedId !== null) return; const restore = keepPosition ? keepScrollAnchor() : () => {}; renderList(); restore(); };
    past.loading = true;
    draw();
    try {
      const got = await fill(past, fetchSurgery({ before: surgeryToday }), stale);
      if (!got) return;
      past.rows = [...got.reverse(), ...past.rows];   // 新しい順に読んだ分を早い順にして上へ
      updateStatus();
    } catch (e) {
      if (stale()) return;
      console.error("注文履歴(過去分)の読み込みに失敗しました:", e);
      status.textContent = "注文履歴を読み込めませんでした。権限を確認してください。";
    } finally {
      if (!stale()) { past.loading = false; draw(); }
    }
  }

  /** 並び順・フィルターの切替・施設を開いたとき: 先頭から読み直す(過去・未来とも最初から。今日の日付も決め直す) */
  function reload() {
    seq++;
    const mySeq = seq;
    main = stream(); past = stream(); cache.clear();
    main.hasMore = mode === "created" ? paged() : canSurgery();
    past.hasMore = showPast();
    surgeryToday = today();
    status.textContent = "読み込み中…";
    renderList();
    if (!showPast()) return loadMore();
    return Promise.all([loadMore(), loadPast({ keepPosition: false })]).then(() => { if (mySeq === seq && open && selectedId === null) scrollToToday(); });
  }

  function renderDetail(id) {
    const o = cache.get(id) || (allRows().find(r => r.order.id === id) || {}).order;
    if (!o) return renderList();
    listScrollY = window.scrollY;   // 戻ったときに、読み込み済みの一覧と同じ位置へ
    selectedId = id;
    const back = h("button", { type: "button", class: "btn btn-secondary btn-sm-inline", "data-act": "back" }, "← 一覧へ戻る");
    back.addEventListener("click", () => { renderList(); window.scrollTo(0, listScrollY); });
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
        for (const st of [main, past]) { st.rows = st.rows.filter(x => x.order.id !== o.id); st.buffered = st.buffered.filter(x => x.order.id !== o.id); }
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
      includePast = false;
      includeCancelled = false;
      root.hidden = false;
      open = true;
      await reload();
    },
    close
  };
}
