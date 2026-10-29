/**
 * 注文の削除(論理削除)。施設の管理者・副管理者だけが、注文履歴の詳細から行う(テスト目的で作った通常の注文も対象)。
 * - 注文ドキュメントは消さず、deleted・deletedAt・deletedBy を付けるだけ(通常の注文履歴の一覧・重複の確認から除く)。
 *   明細・送信済みのメールの記録(mails・notifications)・操作の記録はそのまま残す。
 * - メールの送信待ち(mails)・発注・ディーラーの索引には触れない(削除でメールの再送信・新たな発注は起きない)。
 * - クライアントは注文を直接書けない(Firestore Rules で orders の write はすべて拒否)。所属・役割はここで確認する。
 * - 注文受付の機能スイッチ(ORDER_INTAKE_ENABLED)とは独立(受付の停止中も削除できる)。
 */
import { RegistrationError, assertVerifiedUser } from "./registration.js";
import { isManagerRole } from "./roles.js";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const NOT_MANAGER = "この施設の管理者・副管理者のみ注文を削除できます";

/**
 * @param {object} deps
 * @param {FirebaseFirestore.Firestore} deps.db
 * @param {object} deps.FieldValue
 */
export function createOrderDeletionService({ db, FieldValue }) {
  /** @returns {Promise<{orderId:string, deleted:true, alreadyDeleted:boolean}>} */
  async function deleteOrder({ auth, data }) {
    const user = assertVerifiedUser(auth);
    const d = data && typeof data === "object" && !Array.isArray(data) ? data : null;
    if (!d || Object.keys(d).some(k => k !== "facilityId" && k !== "orderId") || !ID_RE.test(String(d.facilityId || "")) || !ID_RE.test(String(d.orderId || ""))) {
      throw new RegistrationError("invalid-argument", "入力内容を確認してください");
    }
    const { facilityId, orderId } = d;
    const orderRef = db.doc(`facilities/${facilityId}/orders/${orderId}`);
    return db.runTransaction(async (tx) => {
      const [fac, mem, order] = await Promise.all([
        tx.get(db.doc(`facilities/${facilityId}`)), tx.get(db.doc(`facilities/${facilityId}/members/${user.uid}`)), tx.get(orderRef)]);
      // 所属・役割はサーバーで確認する(他施設・所属なし・注文者・代行入力者は区別なく拒否)
      if (!fac.exists || fac.get("status") !== "active" || !mem.exists || !isManagerRole(mem.get("role"))) {
        throw new RegistrationError("permission-denied", NOT_MANAGER);
      }
      if (!order.exists) throw new RegistrationError("not-found", "注文が見つかりません");
      if (order.get("deleted") === true) return { orderId, deleted: true, alreadyDeleted: true };   // 2回目は何もしない(記録も増やさない)
      const role = mem.get("role");
      const by = { uid: user.uid, role, ...(user.displayName ? { displayName: String(user.displayName).slice(0, 100) } : {}) };
      tx.update(orderRef, { deleted: true, deletedAt: FieldValue.serverTimestamp(), deletedBy: by });
      tx.create(db.collection(`facilities/${facilityId}/auditLogs`).doc(), {
        action: "order.delete", orderId, orderNumber: order.get("orderNumber") || "", testOrder: order.get("testOrder") === true,
        actorUid: user.uid, actorRole: role, ...(by.displayName ? { actorName: by.displayName } : {}), at: FieldValue.serverTimestamp()
      });
      return { orderId, deleted: true, alreadyDeleted: false };
    });
  }
  return { deleteOrder };
}
