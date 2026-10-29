/**
 * 過去の注文との重複確認(純粋関数)。「確認画面へ進む」ときに、施設の発注済みの注文と照合する。
 *
 * 重複とみなす条件: **IOLモデル・度数・手術日・担当医** がすべて一致(枚数は含めない)。
 *  - IOLモデルは、系列ID + トーリックの正式型番(トーリックのモデル違いは別のモデル)。
 *  - レンズ(明細)ごとに判定する。同じレンズに一致する過去の注文が複数あれば、すべての注文日を返す。
 *  - 下書き・送信失敗(キャンセル・却下を含む)の注文と明細、テスト注文(開発用受付。testOrder)は対象外。新旧の注文形式(旧 orderer)を読める。
 *  - 論理削除した注文(deleted)も照合し、「削除済み」と分かるように返す(注文日に「（削除済み）」。送信済みのメールは取り消されないため)。
 * 確認後は発注を許可する(警告だけ。サーバー側の処理・入力チェックは変更しない)。
 */
import { orderLinesOf, toMillis } from "./order-history.js";

/** 判定の対象にしない状態(下書き・失敗・取り消し) */
export const EXCLUDED_STATUSES = new Set(["draft", "failed", "notification_failed", "cancelled", "canceled", "rejected"]);

const isCounted = (status) => !status || !EXCLUDED_STATUSES.has(String(status).toLowerCase());

const key = (modelId, toricModel, power, surgeryDate, doctorId) => JSON.stringify([modelId || "", toricModel || "", power || "", surgeryDate || "", doctorId || ""]);

/** 日本時間の「YYYY/MM/DD」(読めなければ「—」) */
export function formatOrderDate(createdAt) {
  const ms = toMillis(createdAt);
  if (ms === null) return "—";
  const d = new Date(ms + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
}

/**
 * @param {Array<{lineNo:number, modelId:string, toricModel?:string, modelName?:string, power:string, surgeryDate:string, doctorId:string}>} currentLines 今回の明細(toOrderLines の結果)
 * @param {Array<object>} orders 施設の過去の注文(Firestore の注文ドキュメント。id・orderNumber・createdAt・status・lines を持つ)
 * @returns {Array<{lineNo:number, modelName:string, power:string, dates:string[], matches:Array<{orderId:string, orderNumber:string, date:string, deleted:boolean}>}>} 一致したレンズだけ(レンズ番号順)
 */
export function findPastOrderDuplicates(currentLines, orders) {
  const index = new Map();   // 過去の明細のキー → 注文(重複なし)
  for (const o of orders || []) {
    if (o.testOrder === true || !isCounted(o.status)) continue;
    for (const l of orderLinesOf(o)) {
      if (!isCounted(l.status)) continue;
      const item = l.item || {};
      const k = key(item.modelId, item.toricModel, item.power, l.surgeryDate, l.doctor && l.doctor.id);
      if (!index.has(k)) index.set(k, new Map());
      index.get(k).set(o.id, { orderId: o.id, orderNumber: o.orderNumber || "", date: formatOrderDate(o.createdAt) + (o.deleted === true ? "（削除済み）" : ""), deleted: o.deleted === true, ms: toMillis(o.createdAt) ?? 0 });
    }
  }
  const out = [];
  for (const c of currentLines) {
    if (!c.doctorId) continue;
    const hit = index.get(key(c.modelId, c.toricModel, c.power, c.surgeryDate, c.doctorId));
    if (!hit) continue;
    const matches = [...hit.values()].sort((a, b) => b.ms - a.ms).map(({ orderId, orderNumber, date, deleted }) => ({ orderId, orderNumber, date, deleted }));   // 新しい順
    out.push({ lineNo: c.lineNo, modelName: c.modelName || c.model || "", power: c.power, dates: [...new Set(matches.map(m => m.date))], matches });
  }
  return out.sort((a, b) => a.lineNo - b.lineNo);
}
