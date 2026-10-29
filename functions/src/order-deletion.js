/**
 * 注文の削除(論理削除)。施設の管理者・副管理者だけが、注文履歴の詳細から行う(テスト目的で作った通常の注文も対象)。
 * - 注文ドキュメントは消さず、deleted・deletedAt・deletedBy を付ける(通常の注文履歴の一覧から除く。重複の確認では「削除済み」として出す)。
 *   明細・メールの記録(mails・notifications)・操作の記録は残す。
 * - 未送信のメール(送信待ち・再送待ち・注文控えの待機・送信停止中の保留)は、同じトランザクションで cancelled にする。
 *   送信の処理(order-mail-outbox.js の processMail・syncOrder・processDue)は、状態をトランザクションで確かめてから送る
 *   (pending・retry・期限切れの sending だけを送り、waiting の注文控えだけを送信待ちにする)ため、cancelled は以後送られず、再送もされない。
 * - 送信の処理中(sending)のメールがあるときは、送信を止められるか保証できないため、削除を断る(数分後に再度。結果が決まれば削除できる)。
 * - 送信済み(accepted)・失敗(failed)などの決着したメールはそのまま(取り消さない)。新たな注文・メールは作らない。
 * - 手術日の索引(orderSurgeryIndex)にも削除の印を付ける(手術日順の一覧から除く)。
 * - クライアントは注文を直接書けない(Firestore Rules で orders・mails の write はすべて拒否)。所属・役割はここで確認する。
 * - 注文受付の機能スイッチ(ORDER_INTAKE_ENABLED)とは独立(受付の停止中も削除できる)。
 */
import { RegistrationError, assertVerifiedUser } from "./registration.js";
import { isManagerRole } from "./roles.js";
import { MAIL_STATUS } from "./order-mail-outbox.js";

export const CANCELLED = "cancelled";   // 注文の削除で送信を中止したメール(送信の処理の対象外)
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const NOT_MANAGER = "この施設の管理者・副管理者のみ注文を削除できます";
// 削除のときに送信を中止する状態(まだ送っていない)と、そのまま残す状態(決着済み)
const CANCELLABLE = new Set([MAIL_STATUS.PENDING, MAIL_STATUS.RETRY, MAIL_STATUS.WAITING, MAIL_STATUS.HELD]);
const SETTLED = new Set([MAIL_STATUS.ACCEPTED, MAIL_STATUS.FAILED, MAIL_STATUS.SKIPPED_TEST, MAIL_STATUS.NOT_SENT, CANCELLED]);

/**
 * @param {object} deps
 * @param {FirebaseFirestore.Firestore} deps.db
 * @param {object} deps.FieldValue
 */
export function createOrderDeletionService({ db, FieldValue }) {
  /** @returns {Promise<{orderId:string, deleted:true, alreadyDeleted:boolean, cancelledMails:number, keptMails:number}>} */
  async function deleteOrder({ auth, data }) {
    const user = assertVerifiedUser(auth);
    const d = data && typeof data === "object" && !Array.isArray(data) ? data : null;
    if (!d || Object.keys(d).some(k => k !== "facilityId" && k !== "orderId") || !ID_RE.test(String(d.facilityId || "")) || !ID_RE.test(String(d.orderId || ""))) {
      throw new RegistrationError("invalid-argument", "入力内容を確認してください");
    }
    const { facilityId, orderId } = d;
    const orderRef = db.doc(`facilities/${facilityId}/orders/${orderId}`);
    return db.runTransaction(async (tx) => {
      const [fac, mem, order, mailsSnap, idxSnap] = await Promise.all([
        tx.get(db.doc(`facilities/${facilityId}`)), tx.get(db.doc(`facilities/${facilityId}/members/${user.uid}`)), tx.get(orderRef),
        tx.get(orderRef.collection("mails")),
        tx.get(db.collection(`facilities/${facilityId}/orderSurgeryIndex`).where("orderId", "==", orderId))]);
      // 所属・役割はサーバーで確認する(他施設・所属なし・注文者・代行入力者は区別なく拒否)
      if (!fac.exists || fac.get("status") !== "active" || !mem.exists || !isManagerRole(mem.get("role"))) {
        throw new RegistrationError("permission-denied", NOT_MANAGER);
      }
      if (!order.exists) throw new RegistrationError("not-found", "注文が見つかりません");
      if (order.get("deleted") === true) return { orderId, deleted: true, alreadyDeleted: true, cancelledMails: 0, keptMails: 0 };   // 2回目は何もしない
      const mails = mailsSnap.docs.map(m => ({ ref: m.ref, id: m.id, status: m.get("status") }));
      // 送信の処理中、または知らない状態のメールがあれば、送信を止められると保証できないため削除しない(何も書かない)
      if (mails.some(m => m.status === MAIL_STATUS.SENDING)) {
        throw new RegistrationError("failed-precondition", "メールの送信処理中のため、今は削除できません。数分後にもう一度お試しください");
      }
      if (mails.some(m => !CANCELLABLE.has(m.status) && !SETTLED.has(m.status))) {
        throw new RegistrationError("failed-precondition", "メールの状態を確認できないため、削除できません");
      }
      const cancel = mails.filter(m => CANCELLABLE.has(m.status));
      for (const m of cancel) {
        tx.update(m.ref, { status: CANCELLED, previousStatus: m.status, cancelledAt: FieldValue.serverTimestamp(), cancelledBy: user.uid, statusAt: FieldValue.serverTimestamp() });
      }
      const cancelled = new Set(cancel.map(m => m.id));
      const notifications = (Array.isArray(order.get("notifications")) ? order.get("notifications") : [])
        .map(n => (n && cancelled.has(n.id) ? { ...n, status: CANCELLED } : n));
      const role = mem.get("role");
      const by = { uid: user.uid, role, ...(user.displayName ? { displayName: String(user.displayName).slice(0, 100) } : {}) };
      tx.update(orderRef, { deleted: true, deletedAt: FieldValue.serverTimestamp(), deletedBy: by, notifications });
      for (const i of idxSnap.docs) tx.update(i.ref, { deleted: true });
      const keptMails = mails.length - cancel.length;
      tx.create(db.collection(`facilities/${facilityId}/auditLogs`).doc(), {
        action: "order.delete", orderId, orderNumber: order.get("orderNumber") || "", testOrder: order.get("testOrder") === true,
        cancelledMails: cancel.length, keptMails,
        actorUid: user.uid, actorRole: role, ...(by.displayName ? { actorName: by.displayName } : {}), at: FieldValue.serverTimestamp()
      });
      return { orderId, deleted: true, alreadyDeleted: false, cancelledMails: cancel.length, keptMails };
    });
  }
  return { deleteOrder };
}
