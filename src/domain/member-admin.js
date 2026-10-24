/**
 * 利用者管理（施設管理者が一般注文者を無効化・再有効化する）の判定と、書き込み内容の組み立て（純粋関数）
 * 権限の最終判定は Firestore Security Rules が行う。ここでは画面の出し分けと入力の組み立てだけを担う。
 */
export const MEMBER_ACTION = Object.freeze({ DISABLE: "member.disable", ENABLE: "member.enable" });

const isActive = (m) => Boolean(m) && m.status === "active";

/** 氏名の表示（未登録は "（氏名未登録）"） */
export function memberLabel(m) {
  return (m && m.displayName && String(m.displayName).trim()) || "（氏名未登録）";
}

/** 一覧の並び: 管理者 → 注文者、有効 → 無効、氏名 */
export function sortMembers(members) {
  const rank = (m) => (m.role === "admin" ? 0 : 2) + (isActive(m) ? 0 : 1);
  return [...members].sort((a, b) =>
    rank(a) - rank(b) || memberLabel(a).localeCompare(memberLabel(b), "ja") || a.uid.localeCompare(b.uid));
}

/** 有効な管理者が target ただ1人か */
export function isLastActiveAdmin(members, target) {
  const admins = members.filter(m => m.role === "admin" && isActive(m));
  return admins.length === 1 && admins[0].uid === target.uid;
}

/**
 * 操作できるか。対象は他人の一般注文者(orderer)のみ。管理者（最後の有効な管理者を含む）と自分自身は操作できない。
 * @returns {{ok:true, action:string, to:"active"|"disabled"}|{ok:false, reason:string}}
 */
export function planMemberToggle(members, target, actorUid) {
  if (!target || !actorUid) return { ok: false, reason: "対象を特定できません" };
  if (target.uid === actorUid) return { ok: false, reason: "自分自身は変更できません" };
  if (target.role === "admin") {
    return { ok: false, reason: isLastActiveAdmin(members, target) ? "最後の有効な管理者は無効化できません" : "管理者の変更はできません" };
  }
  if (target.role !== "orderer") return { ok: false, reason: "変更できない権限です" };
  return isActive(target)
    ? { ok: true, action: MEMBER_ACTION.DISABLE, to: "disabled" }
    : { ok: true, action: MEMBER_ACTION.ENABLE, to: "active" };
}

export function confirmMessage(target, plan) {
  const who = `${memberLabel(target)}${target.email ? `（${target.email}）` : ""}`;
  return plan.to === "disabled"
    ? `${who} を無効化しますか？\nこの施設の注文画面・設定情報を利用できなくなります。`
    : `${who} を再度有効にしますか？\nこの施設の注文画面を利用できるようになります。`;
}

/** 操作記録のID（Rules が所属ドキュメントの lastAuditId と突き合わせる） */
export function newAuditId(uuid = () => globalThis.crypto.randomUUID()) {
  return String(uuid()).replace(/-/g, "");
}

/** 1回の操作で書き込む内容（所属の更新 + 操作記録を同じバッチで） */
export function buildMemberChange({ facilityId, target, plan, actor, auditId }) {
  const log = {
    action: plan.action, targetUid: target.uid, targetRole: target.role,
    fromStatus: target.status, toStatus: plan.to, actorUid: actor.uid
  };
  const cut = (s) => String(s).slice(0, 100);
  if (target.displayName) log.targetName = cut(target.displayName);
  if (actor.displayName) log.actorName = cut(actor.displayName);
  return { facilityId, auditId, memberUid: target.uid, memberUpdate: { status: plan.to, lastAuditId: auditId }, log };
}
