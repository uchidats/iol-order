/**
 * 注文の取り消し(受付の直後だけ)。注文した本人が、取消の期限(createOrder がサーバーの時計で決めた cancelUntilMs。ORDER_CANCEL.windowMs)
 * より前に限り、注文を「取消済み」にし、まだ送っていないメール(ディーラー宛て・注文控え)を cancelled にする。
 * - 期限の判定はサーバーの時計だけで行う(画面の表示時間・通信の遅れに関係なく、期限を過ぎた要求は「取り消せませんでした」)。
 * - 送信との競合: メールの送信は、トランザクションで pending を sending に確保してから送る(order-mail-outbox.js の processMail。
 *   送信の開始は期限の後)。取り消しは、同じトランザクションで「すべてのメールがまだ pending(注文控えは waiting)」を確かめて cancelled にする。
 *   Firestore のトランザクションは直列化されるため、両方が成功することはない。送信が先に確保していれば、取り消しは必ず失敗する
 *   (送信を始めた注文を、取消成功と扱わない)。
 * - 注文ドキュメントは消さない(注文番号も戻さない)。注文履歴には「取消済み」として残す。手術日の索引もそのまま(履歴で取消済みと表示)。
 * - ディーラーの受信の索引は、取消の期限の後に作る(dealer-portal.js の indexOrderEvent)。万一すでにあれば、同じトランザクションで取消の印を付ける。
 * - クライアントは注文を直接書けない(Firestore Rules で orders・mails の write はすべて拒否)。本人・所属はここで確認する。
 */
import { RegistrationError, assertVerifiedUser } from "./registration.js";
import { MAIL_STATUS } from "./order-mail-outbox.js";
import { CANCELLED } from "./order-deletion.js";
import { ORDER_STATUS } from "./orders.js";
import { receiptIdOf } from "./dealer-portal.js";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// 取り消せるメールの状態(送信の処理がまだ確保していない)。これ以外が1つでもあれば、送信を始めているため取り消さない
const NOT_STARTED = new Set([MAIL_STATUS.PENDING, MAIL_STATUS.WAITING]);
export const CANCEL_TOO_LATE = "取り消せる時間を過ぎたため、取り消せませんでした。注文は受け付けられ、ディーラーへ送信されます(送信の状況は注文履歴で確認してください)";

/**
 * @param {object} deps
 * @param {FirebaseFirestore.Firestore} deps.db
 * @param {object} deps.FieldValue
 * @param {() => number} [deps.now]
 */
export function createOrderCancelService({ db, FieldValue, now = Date.now }) {
  const tooLate = () => new RegistrationError("failed-precondition", CANCEL_TOO_LATE, { reason: "too-late" });

  /** @returns {Promise<{orderId:string, cancelled:true, alreadyCancelled:boolean, cancelledMails:number}>} */
  async function cancelOrder({ auth, data }) {
    const user = assertVerifiedUser(auth);
    const d = data && typeof data === "object" && !Array.isArray(data) ? data : null;
    if (!d || Object.keys(d).some(k => k !== "facilityId" && k !== "orderId") || !ID_RE.test(String(d.facilityId || "")) || !ID_RE.test(String(d.orderId || ""))) {
      throw new RegistrationError("invalid-argument", "入力内容を確認してください");
    }
    const { facilityId, orderId } = d;
    const orderRef = db.doc(`facilities/${facilityId}/orders/${orderId}`);
    return db.runTransaction(async (tx) => {
      const [mem, order, mailsSnap, grants] = await Promise.all([
        tx.get(db.doc(`facilities/${facilityId}/members/${user.uid}`)), tx.get(orderRef), tx.get(orderRef.collection("mails")),
        tx.get(db.collection("dealerPortalGrants").where("facilityId", "==", facilityId).where("status", "==", "active"))]);
      // 本人の注文だけ(他人・所属なし・存在しない注文は区別せず同じ応答)
      const by = order.exists ? order.get("createdBy") : null;
      if (!mem.exists || !order.exists || !by || by.uid !== user.uid) throw new RegistrationError("not-found", "取り消せる注文が見つかりません");
      if (order.get("cancelled") === true) return { orderId, cancelled: true, alreadyCancelled: true, cancelledMails: 0 };   // 2回目は何もしない
      const until = order.get("cancelUntilMs");
      if (order.get("deleted") === true || typeof until !== "number" || !(now() < until)) throw tooLate();
      const mails = mailsSnap.docs.map(m => ({ ref: m.ref, id: m.id, status: m.get("status") }));
      if (mails.some(m => !NOT_STARTED.has(m.status))) throw tooLate();   // 送信を始めている(または状態を確認できない)
      // 念のため: すでに作られた受信の索引(取消の期限の後に作るので通常はない)
      const receipts = await Promise.all(grants.docs.map(g => tx.get(db.doc(`dealerCompanies/${g.get("companyId")}/receipts/${receiptIdOf(g.id, facilityId, orderId)}`))));
      for (const m of mails) {
        tx.update(m.ref, { status: CANCELLED, previousStatus: m.status, cancelledAt: FieldValue.serverTimestamp(), cancelledBy: user.uid, statusAt: FieldValue.serverTimestamp() });
      }
      const ids = new Set(mails.map(m => m.id));
      const notifications = (Array.isArray(order.get("notifications")) ? order.get("notifications") : [])
        .map(n => (n && ids.has(n.id) ? { ...n, status: CANCELLED } : n));
      const role = mem.get("role");
      const actor = { uid: user.uid, role, ...(user.displayName ? { displayName: String(user.displayName).slice(0, 100) } : {}) };
      tx.update(orderRef, { cancelled: true, cancelledAt: FieldValue.serverTimestamp(), cancelledBy: actor, status: ORDER_STATUS.CANCELLED, notifications, statusUpdatedAt: FieldValue.serverTimestamp() });
      for (const r of receipts) if (r.exists) tx.update(r.ref, { cancelled: true });
      tx.create(db.collection(`facilities/${facilityId}/auditLogs`).doc(), {
        action: "order.cancel", orderId, orderNumber: order.get("orderNumber") || "", testOrder: order.get("testOrder") === true, cancelledMails: mails.length,
        actorUid: user.uid, actorRole: role, ...(actor.displayName ? { actorName: actor.displayName } : {}), at: FieldValue.serverTimestamp()
      });
      return { orderId, cancelled: true, alreadyCancelled: false, cancelledMails: mails.length };
    });
  }

  return { cancelOrder };
}
