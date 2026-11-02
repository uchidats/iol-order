/**
 * 注文履歴の画面だけで使う表示用データ(純粋関数)。注文の読み方(order-history.js)は変えずに、詳細のまとめ方と論理削除の扱いを加える。
 * order-history.js は Cloud Functions の注文メールにも複製して使うため(scripts/sync-catalog.mjs)、画面だけの追加はここに置く。
 */
import { orderLinesOf, summarizeOrder } from "./order-history.js";
import { groupLinesBySurgeryDate } from "./order-lines.js";

/**
 * 一覧・詳細の1件分(summarizeOrder に、論理削除の印と、明細ごとのまとめ用のキーを加える)。
 * doctorKey: 担当医の ID(なければ氏名。記録なしは "")。dealerKey: 発注先の ID(なければ "")。表示のまとめだけに使う
 */
export function summarizeHistoryOrder(order) {
  const s = summarizeOrder(order);
  const raw = orderLinesOf(order);
  const notes = Array.isArray(order.notifications) ? order.notifications : [];
  const count = (sts) => notes.filter(n => n && sts.includes(n.status)).length;
  return {
    ...s,
    deleted: order.deleted === true,   // 論理削除(施設の管理者・副管理者が削除した注文。通常の一覧には出さない)
    cancelled: order.cancelled === true,   // 注文した本人が受付の直後に取り消した注文(一覧に「取消済み」として残す)
    // 削除の確認に使う件数(送信済みは取り消せない・未送信は送信を中止する。実際の判定はサーバーがメールの状態で行う)
    mailCounts: { sent: count(["accepted"]), unsent: count(UNSENT), sending: count(["sending"]) },
    notifications: s.notifications.map((n, i) => (notes[i] && notes[i].status === "cancelled"
      ? { ...n, statusLabel: order.cancelled === true ? "未送信（注文の取消により送信を中止）" : "未送信（注文の削除により送信を中止）" } : n)),
    lines: s.lines.map((l, i) => {
      const r = raw[i] || {};
      return { ...l, doctorKey: (r.doctor && (r.doctor.id || r.doctor.name)) || "", dealerKey: (r.dealer && r.dealer.id) || r.dealerId || "" };
    })
  };
}

/** 通常の注文履歴に出す注文(論理削除したものを除く) */
const UNSENT = ["pending", "retry", "waiting", "held"];
export const visibleOrders = (orders) => (orders || []).filter(o => o && o.deleted !== true);

/**
 * 詳細の表示用: 発注先ごと(注文の中で最初に登場した順)にまとめる。発注先が1社(または未設定のみ)なら1つ
 * @returns {Array<{dealerKey:string, dealerName:string|null, lines:Array<object>}>}
 */
export function groupHistoryLinesByDealer(lines) {
  const by = new Map();
  for (const l of lines) {
    const k = l.dealerKey || (l.dealerName ? `name:${l.dealerName}` : "");
    if (!by.has(k)) by.set(k, { dealerKey: k, dealerName: l.dealerName || null, lines: [] });
    by.get(k).lines.push(l);
  }
  return [...by.values()];
}

/** 一覧のカードに出す明細の上限(超えた分は「ほか N件」。全件は詳細で確認する) */
export const HISTORY_CARD_LINES = 5;

/** 一覧のレンズ行の右側の担当医名(「内田Dr」。担当医の記録がない古い明細は「担当医の記録なし」) */
export const historyDoctorLabel = (l) => (l && l.doctorKey ? `${l.doctorName}Dr` : "担当医の記録なし");

/**
 * 一覧のカード用(注文日順): 明細を手術日ごと(手術日の早い順。担当医が複数でも日付は1回)にまとめ、まとまりの順に合わせて max 行まで残す。
 * 同じ日の中は明細の順。同じモデル・度数でも別の明細は合算しない。hidden は出さなかった明細の件数
 * @returns {{groups: Array<{surgeryDate:string, lines:Array<object>}>, hidden:number}}
 */
export function historyCardGroups(lines, max = HISTORY_CARD_LINES) {
  const all = Array.isArray(lines) ? lines : [];
  const groups = [];
  let left = max;
  for (const g of groupLinesBySurgeryDate(all.map(l => ({ ...l, surgeryDate: l.surgeryDate || "" })))) {
    if (left <= 0) break;
    const shown = g.lines.slice(0, left);
    left -= shown.length;
    groups.push({ surgeryDate: g.surgeryDate, lines: shown });
  }
  return { groups, hidden: Math.max(0, all.length - max) };
}

/**
 * 手術日順の表示用: 読み込み済みの行(手術日の索引1件 = 注文 × 手術日。手術日 → 索引の順に並んでいる)を、
 * 手術日ごとに見出し1つへまとめ、その日のレンズを1行ずつにする。注文や担当医が違っても同じ日付は1つ。
 * 隣り合う同じ日付をまとめるので、ページの境目(続きを読んだ・上に過去を足した)をまたいでも1つになる。
 * 同じ日の中は索引の順(同じ注文の中はレンズ番号の順)のまま。別々の明細は合算しない。
 * @param {Array<{order:object, surgeryDate:string, lineNos:number[]|null}>} rows
 * @returns {Array<{surgeryDate:string, items:Array<{order:object, line:object}>}>}
 */
export function groupSurgeryRowsByDate(rows) {
  const days = [];
  for (const r of rows || []) {
    const lines = (r.order.lines || []).filter(l => !Array.isArray(r.lineNos) || r.lineNos.includes(l.lineNo)).sort((a, b) => a.lineNo - b.lineNo);
    const last = days[days.length - 1];
    const day = last && last.surgeryDate === r.surgeryDate ? last : (days.push({ surgeryDate: r.surgeryDate, items: [] }), days[days.length - 1]);
    for (const l of lines) day.items.push({ order: r.order, line: l });
  }
  return days.filter(d => d.items.length);
}

/** 日本時間の今日(YYYY-MM-DD)。手術日順の「過去分を表示」がOFFのとき、この日以降の手術日だけを出す(端末のタイムゾーンによらない) */
export function todayJst(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
