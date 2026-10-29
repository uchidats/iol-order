/**
 * 注文履歴の画面だけで使う表示用データ(純粋関数)。注文の読み方(order-history.js)は変えずに、詳細のまとめ方と論理削除の扱いを加える。
 * order-history.js は Cloud Functions の注文メールにも複製して使うため(scripts/sync-catalog.mjs)、画面だけの追加はここに置く。
 */
import { orderLinesOf, summarizeOrder } from "./order-history.js";

/**
 * 一覧・詳細の1件分(summarizeOrder に、論理削除の印と、明細ごとのまとめ用のキーを加える)。
 * doctorKey: 担当医の ID(なければ氏名。記録なしは "")。dealerKey: 発注先の ID(なければ "")。表示のまとめだけに使う
 */
export function summarizeHistoryOrder(order) {
  const s = summarizeOrder(order);
  const raw = orderLinesOf(order);
  return {
    ...s,
    deleted: order.deleted === true,   // 論理削除(施設の管理者・副管理者が削除した注文。通常の一覧には出さない)
    lines: s.lines.map((l, i) => {
      const r = raw[i] || {};
      return { ...l, doctorKey: (r.doctor && (r.doctor.id || r.doctor.name)) || "", dealerKey: (r.dealer && r.dealer.id) || r.dealerId || "" };
    })
  };
}

/** 通常の注文履歴に出す注文(論理削除したものを除く) */
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
