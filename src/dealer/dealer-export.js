import { h } from "../ui/markdown-view.js";
import { createInfoTip } from "../ui/info-tip.js";
import { describeCallableError } from "../data/registration-api.js";
import { formatJstDateTime } from "../domain/dealer-portal.js";
import { linesFromOrdered, linesFromWeeks, exportCounts, overLimit, LIMIT_MESSAGE, EXPORT_LIMITS, exportMeta, workbookSheets, exportFileName, exportBaseName, orderedGroups, surgerySections, shortDay } from "../domain/dealer-export.js";
import { buildXlsx } from "../domain/xlsx-writer.js";

/** 注文日順の全件取得で1回に読む件数(サーバーの上限 pageMax) */
const FETCH_PAGE = 100;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * 受注一覧の「出力」(印刷・PDF / Excel。docs/dealer-export-design.md)。画面に足すのは「出力」ボタン1つと、押したときの2項目+ⓘ のメニューだけ。
 * 取得は既存の list / week(自社宛ての明細だけをサーバーが返す)。注文日順はいまの検索条件で続きがなくなるまで読み(画面の一覧・続きには触れない)、
 * 手術日順は画面に読み込んでいる週をそのまま使う。進捗は処理中だけ、警告・エラーは必要なときだけ(#dealerExportMsg)。
 *
 * @param {object} deps
 * @param {object} deps.api data/dealer-portal-api.js(listOrders)
 * @param {() => {view:"ordered"|"surgery", companyName:string, facilities:Array<{id:string,name:string}>, selectedIds:string[], lastQuery:object|null, weeks:object[]}} deps.getState
 * @param {(el:HTMLElement) => void} deps.showReport 帳票を一覧の代わりに表示する(ホストが一覧を隠す)
 * @param {() => void} deps.closeReport 帳票を閉じて一覧に戻す
 */
export function createDealerExport({ api, getState, showReport, closeReport }) {
  const button = h("button", { type: "button", class: "btn btn-secondary btn-aux", id: "btnDealerExport", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": "dealerExportMenu" }, "出力");
  const menu = h("div", { class: "dealer-export-menu", id: "dealerExportMenu", role: "menu", "aria-label": "出力", hidden: true });
  const root = h("div", { class: "dealer-export" }, button, menu);
  const msg = h("p", { class: "form-hint dealer-export-msg", id: "dealerExportMsg", role: "status", hidden: true });
  const help = [
    "いま表示している条件(医療機関・注文日の期間、または読み込んでいる週)の受注を、自社宛ての明細だけで出力します。",
    "注文日順は条件に該当する全件、手術日順は画面に読み込んでいる週の範囲です。",
    "PDF は印刷の画面で「PDF に保存」を選びます(iPhone は共有から)。",
    `1回の出力は注文${EXPORT_LIMITS.orders.toLocaleString("ja-JP")}件・明細${EXPORT_LIMITS.lines.toLocaleString("ja-JP")}行までです。`
  ].join("\n");

  let busy = false, cancelled = false;
  const item = (kind, label) => {
    const b = h("button", { type: "button", class: "dealer-export-item", role: "menuitem", "data-export": kind }, label);
    b.addEventListener("click", () => { closeMenu(); start(kind); });
    return b;
  };
  function renderMenu() {
    menu.replaceChildren(item("print", "印刷・PDF"), item("xlsx", "Excelで保存"),
      h("div", { class: "dealer-export-foot" }, createInfoTip(help, { label: "出力の説明" }).root));
  }
  renderMenu();

  const onDocDown = (e) => { if (!root.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === "Escape") { closeMenu(); button.focus(); } };
  function openMenu() {
    if (busy) return;
    renderMenu();
    menu.hidden = false; button.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onDocDown, true);
    document.addEventListener("keydown", onKey);
  }
  function closeMenu() {
    menu.hidden = true; button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onDocDown, true);
    document.removeEventListener("keydown", onKey);
  }
  button.addEventListener("click", () => (menu.hidden ? openMenu() : closeMenu()));

  // ---- 状態の表示(処理中だけ。警告・エラーは必要なときだけ) ----
  function showMsg(text, { error = false, cancel = false } = {}) {
    msg.className = `dealer-export-msg ${error ? "error-message" : "form-hint"}`;
    msg.setAttribute("role", error ? "alert" : "status");
    const stop = cancel ? h("button", { type: "button", class: "btn btn-outline-sm dealer-export-cancel", "data-act": "cancel-export" }, "中止") : null;
    if (stop) stop.addEventListener("click", () => { cancelled = true; });
    msg.replaceChildren(...[text, stop].filter(Boolean));
    msg.hidden = !text;
  }
  const clearMsg = () => { msg.replaceChildren(); msg.hidden = true; };

  /** 一部のみの週があるときの確認(メニューの中。出力の前に警告する) */
  function confirmPartial(partial) {
    return new Promise((resolve) => {
      const ok = h("button", { type: "button", class: "btn btn-primary btn-aux", "data-act": "export-go" }, "出力する");
      const no = h("button", { type: "button", class: "btn btn-secondary btn-aux", "data-act": "export-stop" }, "やめる");
      const done = (v) => { closeMenu(); renderMenu(); resolve(v); };
      ok.addEventListener("click", () => done(true));
      no.addEventListener("click", () => done(false));
      menu.replaceChildren(h("p", { class: "dealer-export-warn", role: "alert" }, `${partial}。一部だけの出力になります。`), h("div", { class: "dealer-export-confirm" }, ok, no));
      menu.hidden = false; button.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", onDocDown, true);
      document.addEventListener("keydown", onKey);
      // 外側を押して閉じた場合は「やめる」
      const watch = new MutationObserver(() => { if (menu.hidden) { watch.disconnect(); renderMenu(); resolve(false); } });
      watch.observe(menu, { attributes: true, attributeFilter: ["hidden"] });
    });
  }

  /** 注文日順: いまの検索条件で、続きがなくなるまで読む(画面の一覧・続きには触れない)。上限を超えたら止める */
  async function collectOrdered(lastQuery) {
    let cursor = null, asOf = null;
    const items = [];
    for (;;) {
      showMsg(`出力の準備中… ${items.length}件`, { cancel: true });
      const r = await api.listOrders({ ...lastQuery, limit: FETCH_PAGE, ...(cursor ? { cursor } : {}) });
      if (cancelled) return null;
      if (r.restart) { showMsg("検索の途中で新しい注文が反映されました。「検索」を押してから、もう一度出力してください。", { error: true }); return null; }
      items.push(...(r.items || []));
      if (!asOf && r.asOf) asOf = r.asOf;
      if (overLimit(exportCounts(linesFromOrdered(items)))) { showMsg(LIMIT_MESSAGE, { error: true }); return null; }
      cursor = r.nextCursor || null;
      if (!cursor) return { items, asOf };
    }
  }

  async function start(kind) {
    if (busy) return;
    const s = getState();
    const names = s.facilities.filter(f => s.selectedIds.includes(f.id)).map(f => f.name);
    busy = true; cancelled = false; button.disabled = true;
    try {
      let lines, meta;
      if (s.view === "ordered") {
        if (!s.lastQuery) { showMsg("「検索」を押してから出力してください。", { error: true }); return; }
        const got = await collectOrdered(s.lastQuery);
        if (!got) return;
        lines = linesFromOrdered(got.items);
        meta = exportMeta({ kind: "ordered", companyName: s.companyName, facilityNames: names, facilityTotal: s.facilities.length, from: s.lastQuery.from, to: s.lastQuery.to, asOf: got.asOf, exportedAt: Date.now(), lines });
      } else {
        if (!s.weeks.length) { showMsg("読み込みが終わってから出力してください。", { error: true }); return; }
        lines = linesFromWeeks(s.weeks);
        meta = exportMeta({ kind: "surgery", companyName: s.companyName, facilityNames: names, facilityTotal: s.facilities.length, weeks: s.weeks, asOf: null, exportedAt: Date.now(), lines });
        if (overLimit(meta.counts)) { showMsg(LIMIT_MESSAGE, { error: true }); return; }
        if (meta.partial) {
          busy = false; button.disabled = false;   // 確認の間は「出力」を押せる(押すとメニューに戻る)
          const go = await confirmPartial(meta.partial);
          busy = true; button.disabled = true;
          if (!go) { clearMsg(); return; }
          meta = exportMeta({ kind: "surgery", companyName: s.companyName, facilityNames: names, facilityTotal: s.facilities.length, weeks: s.weeks, asOf: null, exportedAt: Date.now(), lines });
        }
      }
      clearMsg();
      if (kind === "xlsx") download(buildXlsx({ sheets: workbookSheets(lines, meta) }), exportFileName(Date.now(), "xlsx"));
      else showReport(buildReport(meta, lines, s.weeks));
    } catch (e) {
      showMsg(describeCallableError(e), { error: true });
    } finally {
      busy = false; button.disabled = false;
    }
  }

  function download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
    const a = h("a", { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  }

  // ---- 帳票(画面に表示し、そのまま印刷・PDF に保存。文字はすべて textContent) ----
  function buildReport(meta, lines, weeks) {
    const back = h("button", { type: "button", class: "btn btn-secondary btn-aux", "data-act": "report-back" }, "← 一覧へ戻る");
    const print = h("button", { type: "button", class: "btn btn-primary btn-aux", "data-act": "report-print" }, "印刷する");
    back.addEventListener("click", () => closeReport());
    print.addEventListener("click", () => window.print());
    const c = meta.counts;
    const head = h("header", { class: "dealer-report-head" },
      h("div", { class: "dealer-report-title-row" }, h("h2", { class: "dealer-report-title" }, meta.title), h("span", { class: "dealer-report-company" }, meta.companyName)),
      h("p", { class: "dealer-report-cond" }, `医療機関: ${meta.facilities}`),
      h("p", { class: "dealer-report-cond" }, `${meta.rangeLabel}: ${meta.range}(自社宛ての明細)`),
      h("p", { class: "dealer-report-cond" }, `${meta.asOf ? `検索時点 ${meta.asOf}  ` : ""}出力 ${meta.exportedAt}`),
      h("p", { class: "dealer-report-cond" }, `注文 ${c.orders}件 / 明細 ${c.lines}行 / 合計 ${c.quantity}枚`),
      meta.partial ? h("p", { class: "dealer-report-partial", role: "alert" }, `※ ${meta.partial}。この出力は不完全です。`) : null);
    const td = (text, cls) => h("td", { class: cls || null }, text);
    const modelOf = (l) => l.toricModel || l.model;
    let table;
    if (meta.kind === "ordered") {
      const groups = orderedGroups(lines);
      table = h("table", { class: "dealer-report-table", "data-kind": "ordered" },
        h("thead", {}, h("tr", {}, ["注文番号", "医療機関", "注文日時", "手術日", "モデル", "度数", "枚数", "担当医"].map(t => h("th", {}, t)))),
        ...groups.map(g => h("tbody", { class: "dealer-report-order", "data-receipt": g.receiptId }, g.lines.map((l, i) => h("tr", {},
          ...(i === 0 ? [h("td", { rowspan: String(g.lines.length), class: "dealer-report-no" }, g.orderNumber), h("td", { rowspan: String(g.lines.length) }, g.facilityName), h("td", { rowspan: String(g.lines.length), class: "dealer-report-at" }, formatJstDateTime(g.orderedAt))] : []),
          td(shortDay(l.surgeryDate), "dealer-report-day"), td(modelOf(l), "dealer-report-model"), td(l.power, "num"), td(String(l.quantity), "num"), td(l.doctorName || "—"))))));
    } else {
      const sections = surgerySections(weeks);
      table = h("table", { class: "dealer-report-table", "data-kind": "surgery" },
        h("thead", {}, h("tr", {}, ["手術日", "医療機関", "注文番号", "モデル", "度数", "枚数", "担当医"].map(t => h("th", {}, t)))),
        ...sections.map(sec => sec.type === "empty"
          ? h("tbody", { class: "dealer-report-empty" }, h("tr", {}, h("td", { colspan: "7" }, sec.label)))
          : h("tbody", { class: "dealer-report-date", "data-day": sec.date }, sec.lines.map((l, i) => h("tr", {},
            ...(i === 0 ? [h("td", { rowspan: String(sec.lines.length), class: "dealer-report-day" }, `${shortDay(sec.date)}${sec.truncated ? "(一部のみ)" : ""}`)] : []),
            td(l.facilityName), td(l.orderNumber, "dealer-report-no"), td(modelOf(l), "dealer-report-model"), td(l.power, "num"), td(String(l.quantity), "num"), td(l.doctorName || "—"))))));
    }
    return h("section", { class: "dealer-report", "aria-label": meta.title, "data-title": exportBaseName(Date.now()) },
      h("div", { class: "dealer-report-actions" }, back, print), head, h("div", { class: "dealer-report-wrap" }, table));
  }

  return { root, msg, closeMenu };
}
