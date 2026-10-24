/**
 * 利用者(所属)の削除。施設管理者が、自施設の一般注文者(orderer)の所属を削除する。
 *
 * - 所属は「ある／ない」だけで、有効・無効の状態はない。不要になった利用者は所属を削除する。
 * - 所属の削除と操作履歴(auditLogs)の記録は、1つのトランザクションで行う(どちらか片方だけは起きない)。
 *   操作履歴は Firestore Security Rules で、クライアントから作成・変更・削除できない(追記のみ・Cloud Functionsだけが書く)。
 * - 削除できるのは、呼び出した管理者自身の施設の、管理者以外(orderer)の所属だけ。
 *   管理者(自分自身・最後の管理者を含む)の所属は削除できない。他施設の所属は操作できない。
 * - 削除後は、その人のログイン中のセッションからも、その施設のデータにアクセスできなくなる(Rules が毎回所属を確認する)。
 * - 削除した人宛ての、未使用の招待は取り消す(古い招待コードで再び参加できないように)。再び参加させるには新しい招待を発行する。
 */
import { RegistrationError, assertVerifiedUser } from "./registration.js";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const RATE = { windowMs: 60 * 60 * 1000, max: 60 };

/**
 * @param {object} deps
 * @param {import("firebase-admin/firestore").Firestore} deps.db
 * @param {typeof import("firebase-admin/firestore").FieldValue} deps.FieldValue
 * @param {() => number} [deps.now]
 * @param {(uid:string) => Promise<string|null>} [deps.lookupEmail] 所属に記録されたメールが無い場合に、認証情報から調べる
 */
export function createMemberService({ db, FieldValue, now = Date.now, lookupEmail = async () => null }) {
  async function consumeRate(uid) {
    const ref = db.doc(`rateLimits/${uid}_removeMember`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const t = now();
      let start = snap.exists ? snap.get("windowStart") : 0;
      let n = snap.exists ? snap.get("count") || 0 : 0;
      if (!snap.exists || t - start >= RATE.windowMs) { start = t; n = 0; }
      if (n >= RATE.max) throw new RegistrationError("resource-exhausted", "操作の回数が上限に達しました。しばらくしてからお試しください");
      tx.set(ref, { windowStart: start, count: n + 1, updatedAt: FieldValue.serverTimestamp() });
    });
  }

  async function removeMember({ auth, data }) {
    const user = assertVerifiedUser(auth);
    if (!data || typeof data !== "object" || Array.isArray(data)
        || Object.keys(data).some(k => !["facilityId", "uid"].includes(k))
        || typeof data.facilityId !== "string" || !ID.test(data.facilityId)
        || typeof data.uid !== "string" || !ID.test(data.uid)) {
      throw new RegistrationError("invalid-argument", "入力内容を確認してください");
    }
    const { facilityId, uid: targetUid } = data;
    await consumeRate(user.uid);

    const facRef = db.doc(`facilities/${facilityId}`);
    const actorRef = db.doc(`facilities/${facilityId}/members/${user.uid}`);
    const targetRef = db.doc(`facilities/${facilityId}/members/${targetUid}`);

    // 所属に記録されたメールが無い古い所属は、認証情報から調べる(未使用の招待の取り消しに使う)
    const preTarget = await targetRef.get();
    let targetEmail = preTarget.exists ? preTarget.get("email") || null : null;
    if (preTarget.exists && !targetEmail) targetEmail = await lookupEmail(targetUid);

    return db.runTransaction(async (tx) => {
      const [fac, actor, target] = await Promise.all([tx.get(facRef), tx.get(actorRef), tx.get(targetRef)]);
      // 管理者でない・他施設・存在しない施設は、区別せず同じ拒否にする
      if (!fac.exists || fac.get("status") !== "active" || !actor.exists || actor.get("role") !== "admin") {
        throw new RegistrationError("permission-denied", "この施設の管理者のみ、利用者の所属を削除できます");
      }
      if (targetUid === user.uid) throw new RegistrationError("failed-precondition", "自分自身の所属は削除できません");
      if (!target.exists) throw new RegistrationError("not-found", "所属が見つかりません(既に削除されています)");
      if (target.get("role") !== "orderer") throw new RegistrationError("failed-precondition", "管理者の所属は削除できません");

      // 未使用の招待(削除する人のメール宛て)を取り消す
      let pending = [];
      if (targetEmail) {
        pending = (await tx.get(db.collection("invites")
          .where("facilityId", "==", facilityId).where("email", "==", String(targetEmail).toLowerCase()).where("status", "==", "pending"))).docs;
      }

      const logRef = db.collection(`facilities/${facilityId}/auditLogs`).doc();
      tx.create(logRef, {
        action: "member.remove",
        targetUid, targetRole: "orderer",
        ...(target.get("displayName") ? { targetName: String(target.get("displayName")).slice(0, 100) } : {}),
        ...(targetEmail ? { targetEmail } : {}),
        actorUid: user.uid,
        ...(user.displayName ? { actorName: String(user.displayName).slice(0, 100) } : {}),
        revokedInvites: pending.length,
        at: FieldValue.serverTimestamp()
      });
      tx.delete(targetRef);
      for (const inv of pending) tx.update(inv.ref, { status: "revoked", revokedAt: FieldValue.serverTimestamp(), revokedBy: user.uid });
      return { removed: true, revokedInvites: pending.length };
    });
  }

  return { removeMember };
}
