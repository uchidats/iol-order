/**
 * 注文履歴の「手術日順」のための索引(facilities/{施設ID}/orderSurgeryIndex/{注文ID}_{手術日})。
 * 1つの注文に手術日が複数あれば、手術日ごとに1件(どの手術日の範囲で見ても、その注文を取りこぼさない)。
 * - 注文の作成をきっかけに別の処理(トリガー)で作る。注文の受付・メール送信には関与しない(ここが失敗しても注文・メールは止まらない)。
 * - 注文の論理削除(order-deletion.js)は、同じ注文の索引に deleted を付ける。作成が削除より後になっても、注文を読み直して deleted を写す。
 * - 中身は並べ替え・表示に必要な最小限(注文ID・手術日・注文日時・その手術日のレンズ番号)。明細は注文ドキュメントから読む。
 * - クライアントは読み取りだけ(所属メンバーと運営者。Firestore Rules)。書き込みはサーバーだけ。
 */
import { orderLinesOf } from "./orders.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const NO_DATE = "";   // 手術日が読めない古い明細(手術日順では最後)

/** 注文ドキュメントから索引の中身を作る(純粋関数。バックフィルのスクリプトでも使う) */
export function surgeryIndexEntries(facilityId, orderId, order) {
  const byDate = new Map();
  orderLinesOf(order || {}).forEach((l, i) => {
    const date = typeof l.surgeryDate === "string" && DATE.test(l.surgeryDate) ? l.surgeryDate : NO_DATE;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(Number(l.lineNo) || i + 1);
  });
  if (!byDate.size) byDate.set(NO_DATE, []);   // 明細が読めない注文も、手術日順の最後に出す(取りこぼさない)
  return [...byDate.entries()].map(([surgeryDate, lineNos]) => ({
    id: `${orderId}_${surgeryDate || "nodate"}`,
    data: { facilityId, orderId, surgeryDate, lineNos, createdAt: order.createdAt || null, deleted: order.deleted === true }
  }));
}

/**
 * @param {object} deps
 * @param {FirebaseFirestore.Firestore} deps.db
 */
export function createOrderSurgeryIndexService({ db }) {
  /** 1つの注文の索引を作る(冪等。同じ注文を何度処理しても同じ ID)。注文がなければ何もしない */
  async function indexOrder(facilityId, orderId) {
    const orderRef = db.doc(`facilities/${facilityId}/orders/${orderId}`);
    return db.runTransaction(async (tx) => {
      const o = await tx.get(orderRef);
      if (!o.exists) return { created: 0 };
      const entries = surgeryIndexEntries(facilityId, orderId, o.data());
      for (const e of entries) tx.set(db.doc(`facilities/${facilityId}/orderSurgeryIndex/${e.id}`), e.data);
      return { created: entries.length };
    });
  }
  return { indexOrder };
}
