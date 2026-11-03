/**
 * ディーラー受注一覧の出力(印刷・PDF・Excel)の純粋な処理(docs/dealer-export-design.md)。
 * 取得した注文(既存の list / week の応答。自社宛ての明細だけ)を 1レンズ1行 にそろえ、帳票の構成・Excel の行・出力条件・件数・上限を作る。
 * DOM・通信は扱わない(画面は src/dealer/dealer-export.js)。
 */
import { jstDate, weekStartLabel, formatJstDateTime } from "./dealer-portal.js";

/** 1回の出力の上限(設計 §0-4。超えたら出力しない) */
export const EXPORT_LIMITS = Object.freeze({ orders: 1000, lines: 3000 });

/** Excel「明細」シートの見出し(1レンズ1行・セル結合なし。設計 §4。メーカー・注文区分は第1段階では出さない) */
export const EXCEL_HEADERS = Object.freeze(["注文番号", "医療機関", "注文日", "注文時刻", "手術日", "曜日", "明細No", "モデル", "トーリック型番", "度数", "枚数", "担当医"]);
export const EXCEL_WIDTHS = Object.freeze([18, 26, 11, 9, 11, 5, 8, 14, 14, 9, 6, 12]);

const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];
const JST_MS = 9 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");

/** ISO 日時 → 日本時間の { date: YYYY-MM-DD, time: HH:MM }(読めなければ空) */
export function jstParts(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return { date: "", time: "" };
  const d = new Date(ms + JST_MS);
  return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}

/** YYYY-MM-DD → 曜日(「火」)。読めなければ空 */
export function weekdayOf(ymd) {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isFinite(ms) ? WEEKDAY[new Date(ms).getUTCDay()] : "";
}

/** YYYY-MM-DD → 「11/10(火)」(帳票の手術日。記録がなければ「手術日の記録なし」) */
export function shortDay(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  return m ? `${Number(m[2])}/${Number(m[3])}(${weekdayOf(ymd)})` : "手術日の記録なし";
}

/**
 * 度数「+13.5D」→ { int: "+13", frac: ".5", unit: "D" }(帳票で整数部を右寄せの固定幅にして小数点の位置をそろえる)。
 * 数値で始まらない表記はそのまま出す(null)
 */
export function powerParts(power) {
  const m = /^([+-]?\d+)(\.\d+)?(.*)$/.exec(String(power || "").trim());
  return m ? { int: m[1], frac: m[2] || "", unit: m[3] || "" } : null;
}

/** YYYY-MM-DD → 「2026/11/10」 */
export const slashDate = (ymd) => (/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || "")) ? String(ymd).replace(/-/g, "/") : "");

/**
 * 出力の1行(1レンズ)。
 * @typedef {{ receiptId:string, orderNumber:string, facilityId:string, facilityName:string, orderedAt:string, surgeryDate:string,
 *   no:number, model:string, toricModel:string, power:string, quantity:number, doctorName:string }} ExportLine
 */
const lineOf = (o, l, surgeryDate) => ({
  receiptId: String(o.receiptId || ""), orderNumber: String(o.orderNumber || ""), facilityId: String(o.facilityId || ""), facilityName: String(o.facilityName || ""),
  orderedAt: String(o.orderedAt || ""), surgeryDate: String(surgeryDate || ""),
  no: Number(l.no) || 0, model: String(l.model || ""), toricModel: String(l.toricModel || ""), power: String(l.power || ""),
  quantity: Number(l.quantity) || 0, doctorName: String(l.doctorName || "")
});

/** 注文日順(list の items。注文の順のまま、明細は番号順)→ 1レンズ1行 */
export function linesFromOrdered(items) {
  const out = [];
  for (const it of items || []) {
    const lines = [...(it.lines || [])].sort((a, b) => (Number(a.no) || 0) - (Number(b.no) || 0));
    for (const l of lines) out.push(lineOf(it, l, l.surgeryDate));
  }
  return out;
}

/** 手術日順(読み込んだ週の配列。週 → 手術日 → 注文 → 明細の順)→ 1レンズ1行(手術日はその日の値) */
export function linesFromWeeks(weeks) {
  const out = [];
  for (const w of weeks || []) for (const d of w.days || []) for (const o of d.orders || []) for (const l of o.lines || []) out.push(lineOf(o, l, d.date));
  return out;
}

/** 件数(注文 = 注文の数〔受信ID で数える〕・明細 = 行数・合計枚数) */
export function exportCounts(lines) {
  return { orders: new Set(lines.map(l => l.receiptId)).size, lines: lines.length, quantity: lines.reduce((s, l) => s + l.quantity, 0) };
}

/** 上限を超えているか(注文 1,000 件 または 明細 3,000 行) */
export const overLimit = (counts, limits = EXPORT_LIMITS) => counts.orders > limits.orders || counts.lines > limits.lines;

export const LIMIT_MESSAGE = `出力の上限(注文${EXPORT_LIMITS.orders.toLocaleString("ja-JP")}件または明細${EXPORT_LIMITS.lines.toLocaleString("ja-JP")}行)を超えています。期間や医療機関を絞ってください。`;

/** 注文日の条件の表示(開始日だけ・終了日だけ・両方・なし) */
export function orderedRangeLabel(from, to) {
  if (from && to) return `${slashDate(from)} 〜 ${slashDate(to)}`;
  if (from) return `${slashDate(from)} 以降`;
  if (to) return `${slashDate(to)} まで`;
  return "全期間";
}

/** 読み込んだ週の範囲の表示(「11月2日の週 〜 11月16日の週」。1週なら1つ) */
export function weekRangeLabel(weeks, today) {
  if (!weeks || !weeks.length) return "";
  const a = weekStartLabel(weeks[0].weekStart, today), b = weekStartLabel(weeks[weeks.length - 1].weekStart, today);
  return a === b ? a : `${a} 〜 ${b}`;
}

/** 医療機関の表示(全施設を選んでいれば「全施設(3)」、それ以外は名前を並べる) */
export function facilityLabel(selectedNames, totalCount) {
  const names = (selectedNames || []).filter(Boolean);
  if (!names.length) return "—";
  return totalCount > 1 && names.length === totalCount ? `全施設(${totalCount})` : names.join("、");
}

/** 一部のみの週(1週の取得上限に達した週)の注記。なければ空 */
export function partialNotice(weeks, today) {
  const t = (weeks || []).filter(w => w && w.truncated).map(w => weekStartLabel(w.weekStart, today));
  return t.length ? `${t.join("・")}は一部のみ(件数が多いため)` : "";
}

/** ファイル名の本体「受注一覧_YYYYMMDD-HHMM」(日本時間。PDF はブラウザが拡張子を付けるので、帳票の表示中は document.title にも使う) */
export function exportBaseName(nowMs) {
  const d = new Date(nowMs + JST_MS);
  return `受注一覧_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}
/** ファイル名「受注一覧_YYYYMMDD-HHMM.拡張子」 */
export const exportFileName = (nowMs, ext) => `${exportBaseName(nowMs)}.${ext}`;

/**
 * 出力の条件(帳票のヘッダー・Excel の「出力条件」で共通)。
 * @param {{ kind:"ordered"|"surgery", companyName:string, facilityNames:string[], facilityTotal:number, from?:string, to?:string, weeks?:object[],
 *   asOf?:string|null, exportedAt:number, lines:ExportLine[] }} a
 */
export function exportMeta(a) {
  const today = jstDate(a.exportedAt);
  const counts = exportCounts(a.lines);
  return {
    kind: a.kind,
    title: `受注一覧(${a.kind === "ordered" ? "注文日順" : "手術日順"})`,
    companyName: a.companyName || "",
    facilities: facilityLabel(a.facilityNames, a.facilityTotal),
    rangeLabel: a.kind === "ordered" ? "注文日" : "手術日",
    range: a.kind === "ordered" ? orderedRangeLabel(a.from, a.to) : weekRangeLabel(a.weeks, today),
    asOf: a.asOf ? formatJstDateTime(a.asOf) : "",
    exportedAt: formatJstDateTime(new Date(a.exportedAt).toISOString()),
    counts,
    partial: a.kind === "surgery" ? partialNotice(a.weeks, today) : ""
  };
}

/** Excel「明細」シートの行(1行目は見出し)。日付は日付セル({date})、枚数・明細No は数値、ほかは文字列 */
export function excelRows(lines) {
  return [[...EXCEL_HEADERS], ...lines.map(l => {
    const t = jstParts(l.orderedAt);
    return [l.orderNumber, l.facilityName, t.date ? { date: t.date } : "", t.time, l.surgeryDate ? { date: l.surgeryDate } : "", weekdayOf(l.surgeryDate),
      l.no, l.model, l.toricModel, l.power, l.quantity, l.doctorName];
  })];
}

/** Excel「出力条件」シートの行 */
export function conditionRows(meta) {
  return [["項目", "内容"],
    ["帳票", meta.title], ["会社", meta.companyName], ["医療機関", meta.facilities], [meta.rangeLabel, meta.range],
    ...(meta.asOf ? [["検索時点", meta.asOf]] : []), ["出力日時", meta.exportedAt],
    ["注文", meta.counts.orders], ["明細", meta.counts.lines], ["合計枚数", meta.counts.quantity],
    ["内容", "自社宛ての明細のみ"],
    ...(meta.partial ? [["注意", `${meta.partial}。この出力は不完全です。`]] : [])];
}

/** buildXlsx に渡すシート(「明細」+「出力条件」。不完全な出力のときだけ「明細」の1行目に注記) */
export function workbookSheets(lines, meta) {
  const rows = excelRows(lines);
  const detail = meta.partial ? [[`※ ${meta.partial}。この出力は不完全です。`], ...rows] : rows;
  return [
    { name: "明細", rows: detail, widths: [...EXCEL_WIDTHS], freezeHeader: !meta.partial, autoFilter: !meta.partial },
    { name: "出力条件", rows: conditionRows(meta), widths: [12, 60], freezeHeader: false, autoFilter: false }
  ];
}

/** 帳票(注文日順): 注文ごとのまとまり(先頭行だけに注文番号・医療機関・注文日時) */
export function orderedGroups(lines) {
  const groups = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    if (last && last.receiptId === l.receiptId) last.lines.push(l);
    else groups.push({ receiptId: l.receiptId, orderNumber: l.orderNumber, facilityName: l.facilityName, orderedAt: l.orderedAt, lines: [l] });
  }
  return groups;
}

/**
 * 帳票(手術日順): 週 → 手術日ごとのまとまり。受注のない週が続く所は1行にまとめる(画面と同じ)
 * @returns {Array<{ type:"empty", label:string } | { type:"day", date:string, lines:ExportLine[], quantity:number }>}
 */
export function surgerySections(weeks, today) {
  const out = [];
  const hasData = (w) => (w.days || []).some(d => d.orders && d.orders.length);
  for (let i = 0; i < (weeks || []).length; i++) {
    const w = weeks[i];
    if (!hasData(w)) {
      let j = i;
      while (j + 1 < weeks.length && !hasData(weeks[j + 1])) j++;
      out.push({ type: "empty", label: `${j === i ? weekStartLabel(w.weekStart, today) : `${weekStartLabel(w.weekStart, today)}〜${weekStartLabel(weeks[j].weekStart, today)}`}: 受注はありません` });
      i = j;
      continue;
    }
    for (const d of w.days) {
      if (!d.orders || !d.orders.length) continue;
      const lines = linesFromWeeks([{ days: [d] }]);
      out.push({ type: "day", date: d.date, weekStart: w.weekStart, truncated: w.truncated === true, lines, quantity: lines.reduce((s, l) => s + l.quantity, 0) });
    }
  }
  return out;
}
