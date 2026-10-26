/**
 * 注文履歴の表示用データ(純粋関数)。注文ドキュメントの新旧の形式を、同じ形にそろえて読む。
 *  - 現行(schemaVersion 3): 各明細に doctor(担当医のスナップショット)・dealer(発注先のスナップショット)がある
 *  - 旧(schemaVersion 2): 明細に doctor が無く、注文全体の orderer(注文者) → その担当医として扱う
 *  - 旧(schemaVersion 1): トップレベルの item / surgeryDate / orderer
 * 実際に操作した発注者は、どの形式でも order.createdBy(サーバーが認証情報から記録)。
 * orderLinesOf は functions/src/orders.js の同名の関数と同じ動作(tests/order-history.test.js で一致を確認する)。
 */
import { baseModelName } from "./lens-labels.js";

export function orderLinesOf(order) {
  const fallback = order.orderer || null;
  if (Array.isArray(order.lines)) return order.lines.map(l => ({ ...l, doctor: l.doctor ?? fallback }));
  if (order.item) return [{ lineNo: 1, status: order.status, item: order.item, surgeryDate: order.surgeryDate, dealerId: null, doctor: fallback }];
  return [];
}

/** Firestore の Timestamp / Date / 数値 / ISO文字列 → ミリ秒(読めなければ null) */
export function toMillis(v) {
  if (v === null || v === undefined) return null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.seconds === "number") return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

const pad = (n) => String(n).padStart(2, "0");

/** 日本時間の「2026/10/25 14:30」。読めなければ「—」 */
export function formatDateTimeJst(v) {
  const ms = toMillis(v);
  if (ms === null) return "—";
  const d = new Date(ms + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const ENTRY_ROLE_LABELS = Object.freeze({ admin: "管理者", subadmin: "副管理者", orderer: "注文者", proxy: "代行入力者" });

/** 実際の発注者(ログインしていた人)の表示名。氏名 → メール → 不明 */
export function orderedByLabel(order) {
  const c = order.createdBy;
  return (c && (String(c.displayName || "").trim() || String(c.email || "").trim())) || "（不明）";
}

/** 1明細の表示用データ */
export function describeLine(line, index = 0) {
  const item = line.item || {};
  const doctor = line.doctor && line.doctor.name ? String(line.doctor.name) : "";
  const dealer = line.dealer && line.dealer.name ? String(line.dealer.name) : "";
  return {
    lineNo: line.lineNo || index + 1,
    maker: item.manufacturer || "",
    displayName: item.displayName || [item.manufacturer, item.model].filter(Boolean).join(" / "), toricModel: item.toricModel || "",
    model: item.toricModel || baseModelName({ displayName: item.displayName, model: item.model }),
    isToric: item.isToric === true, isMultifocal: item.isMultifocal === true,
    power: item.power || "", quantity: Number(item.quantity) || 0,
    surgeryDate: line.surgeryDate || "",
    doctorName: doctor || "（記録なし）",
    dealerName: dealer || null          // null = 発注先未設定(または発注時にすでに削除されていた)
  };
}

// 注文の状態(functions/src/orders.js の ORDER_STATUS)。今は accepted だけが作られる(ディーラー通知は将来)
const STATUS_LABELS = Object.freeze({
  accepted: "受付済み（ディーラー未通知）",
  notification_pending: "ディーラーへ送信中",
  notified: "ディーラーへの送信受付済み",
  notification_failed: "ディーラーへの送信に失敗あり"
});
export const orderStatusLabel = (status) => STATUS_LABELS[status] || (status ? String(status) : "（記録なし）");

// メールの送信結果(order.notifications: 発注先ごと + 注文控え。functions/src/order-mail-outbox.js が更新する。docs/order-mail.md)。
// 「受付済み」は配信サービスが受け付けただけ(配信の完了ではない)。配信の結果(delivery)は別に表示する
const NOTIFICATION_LABELS = Object.freeze({
  waiting: "送信待ち（ディーラーへの送信の後）", pending: "送信待ち", sending: "送信中", retry: "再送信待ち（一時的なエラー）",
  accepted: "送信受付済み（配信の確認待ち）", failed: "送信失敗（届いていません）", held: "未送信（メール送信は停止中）",
  skipped_test: "未送信（テスト注文）", not_sent: "送信対象外",
  sent: "送信済み", skipped: "送信対象外"   // 旧い記録の値
});
const DELIVERY_LABELS = Object.freeze({ delivered: "配信済み", delayed: "配信遅延中", bounced: "配信失敗（宛先エラー）", complained: "受信者が迷惑メールとして報告", failed: "配信失敗" });
const REASON_LABELS = Object.freeze({ "dealer-unset": "発注先未設定", "no-order-email": "発注用メール未登録", "dealer-deleted": "発注先が削除済み" });
export function describeNotifications(order) {
  return (Array.isArray(order.notifications) ? order.notifications : []).map(n => {
    const delivery = n && n.delivery ? DELIVERY_LABELS[n.delivery] || String(n.delivery) : "";
    const reason = n && n.reason ? REASON_LABELS[n.reason] || String(n.reason) : "";
    const base = NOTIFICATION_LABELS[n && n.status] || (n && n.status ? String(n.status) : "（記録なし）");
    const toTest = n && n.sentTo === "test";   // テスト用の宛先に送った(ディーラーには届いていない)
    return {
      kind: (n && n.kind) || "dealer",
      dealerName: (n && n.dealerName) || "（発注先未設定）",
      statusLabel: toTest ? `テスト用の宛先に送信${delivery ? `・${delivery}` : ""}（ディーラーには未送信）` : delivery ? delivery : reason ? `${base}（${reason}）` : base,
      atLabel: n && (n.deliveryAt || n.statusAt || n.at) ? formatDateTimeJst(n.deliveryAt || n.statusAt || n.at) : "",
      error: n && n.error ? String(n.error) : ""
    };
  });
}

/** 一覧の1行分 */
export function summarizeOrder(order) {
  const lines = orderLinesOf(order).map(describeLine);
  return {
    id: order.id,
    orderNumber: order.orderNumber || "",
    createdAtMs: toMillis(order.createdAt),
    createdAtLabel: formatDateTimeJst(order.createdAt),
    orderedBy: orderedByLabel(order),
    // 入力者の役割(注文時点。createdBy.role)。旧注文には無い(null)。代行入力者の注文は入力者名と役割を表示する
    enteredByRole: ENTRY_ROLE_LABELS[order.createdBy && order.createdBy.role] || null,
    isProxyEntry: Boolean(order.createdBy && order.createdBy.role === "proxy"),
    lineCount: lines.length,
    totalQuantity: lines.reduce((s, l) => s + l.quantity, 0),
    testOrder: order.testOrder === true,
    status: order.status || "",
    statusLabel: order.testOrder === true ? "テスト注文（ディーラー未通知）" : orderStatusLabel(order.status),
    notes: typeof order.notes === "string" ? order.notes : "",
    notifications: describeNotifications(order),
    lines
  };
}

/** 新しい順(作成日時が読めないものは末尾) */
export function sortOrdersNewestFirst(orders) {
  return [...orders].sort((a, b) => (b.createdAtMs ?? -Infinity) - (a.createdAtMs ?? -Infinity));
}
