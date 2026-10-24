/**
 * 利用者管理(施設管理者が、不要になった一般注文者の所属を削除する)の判定(純粋関数)
 * 所属に有効/無効の状態はない。権限の最終判定は Cloud Functions(removeMember)と Firestore Security Rules が行う。
 * ここでは画面の出し分けと表示だけを担う。
 */

/** 氏名の表示（未登録は "（氏名未登録）"） */
export function memberLabel(m) {
  return (m && m.displayName && String(m.displayName).trim()) || "（氏名未登録）";
}

/** 一覧の並び: 管理者 → 注文者、氏名 */
export function sortMembers(members) {
  const rank = (m) => (m.role === "admin" ? 0 : 1);
  return [...members].sort((a, b) =>
    rank(a) - rank(b) || memberLabel(a).localeCompare(memberLabel(b), "ja") || a.uid.localeCompare(b.uid));
}

/**
 * 所属を削除できるか。対象は他人の一般注文者(orderer)のみ。
 * 管理者(最後の管理者を含む)と自分自身は削除できない。
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function planMemberRemoval(members, target, actorUid) {
  if (!target || !actorUid) return { ok: false, reason: "対象を特定できません" };
  if (target.uid === actorUid) return { ok: false, reason: "自分自身の所属は削除できません" };
  if (target.role === "admin") {
    const admins = members.filter(m => m.role === "admin");
    return { ok: false, reason: admins.length === 1 ? "最後の管理者の所属は削除できません" : "管理者の所属は削除できません" };
  }
  if (target.role !== "orderer") return { ok: false, reason: "削除できない権限です" };
  return { ok: true };
}

export function confirmMessage(target) {
  const who = `${memberLabel(target)}${target.email ? `（${target.email}）` : ""}`;
  return `${who} の所属をこの施設から削除しますか？\nこの利用者は、この施設の注文画面・設定を利用できなくなります。\n再び利用するには、新しい招待が必要です。`;
}
