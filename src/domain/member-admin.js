/**
 * 利用者管理の判定(純粋関数)。画面の出し分けと表示だけを担う。
 * 権限の最終判定は Cloud Functions(functions/src/roles.js)と Firestore Security Rules が行う。
 * 役割の定義はサーバーと同じ(tests/member-admin.test.js が functions/src/roles.js と一致することを確認する)。
 */

export const ROLE_LABELS = Object.freeze({ admin: "管理者", subadmin: "副管理者", orderer: "注文者", proxy: "代行入力者" });
export const MEMBER_ROLES = Object.freeze(["admin", "subadmin", "orderer", "proxy"]);
export const MANAGER_ROLES = Object.freeze(["admin", "subadmin"]);

export const roleLabel = (role) => ROLE_LABELS[role] || "（不明な役割）";
export const isManagerRole = (role) => MANAGER_ROLES.includes(role);

/** 操作する人(actorRole)が、対象の役割(targetRole)の利用者を追加・変更・削除できるか(サーバーと同じ規則) */
export function canManageRole(actorRole, targetRole) {
  if (actorRole === "admin") return MEMBER_ROLES.includes(targetRole);
  if (actorRole === "subadmin") return targetRole === "orderer" || targetRole === "proxy";
  return false;
}

/** 事前登録で選べる役割(管理者は事前登録できない。参加後に役割を変更する) */
export function assignableRoles(actorRole) {
  return ["subadmin", "orderer", "proxy"].filter(r => canManageRole(actorRole, r));
}

/** 氏名の表示（未登録は "（氏名未登録）"） */
export function memberLabel(m) {
  return (m && (m.displayName || m.name) && String(m.displayName || m.name).trim()) || "（氏名未登録）";
}

/** 一覧の並び: 管理者 → 副管理者 → 注文者 → 代行入力者、氏名 */
export function sortMembers(members) {
  const rank = (m) => { const i = MEMBER_ROLES.indexOf(m.role); return i < 0 ? 9 : i; };
  return [...members].sort((a, b) =>
    rank(a) - rank(b) || memberLabel(a).localeCompare(memberLabel(b), "ja") || String(a.uid).localeCompare(String(b.uid)));
}

/**
 * 役割を変更できる先(現在の役割を含む)。空なら変更不可(鉛筆を出さない)。
 * 管理者が最後の1人なら、管理者のまま(降格できない)。
 */
export function roleChoices(members, target, actorRole) {
  if (!target || !canManageRole(actorRole, target.role)) return [];
  if (target.role === "admin" && members.filter(m => m.role === "admin").length <= 1) return [];
  const choices = MEMBER_ROLES.filter(r => canManageRole(actorRole, r));
  return choices.length > 1 ? choices : [];
}

/**
 * 所属を削除できるか。管理者の所属は削除できない(先に役割を変更する)。自分自身は削除できない。
 * 副管理者が削除できるのは注文者・代行入力者のみ。
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function planMemberRemoval(members, target, actorUid, actorRole = "admin") {
  if (!target || !actorUid) return { ok: false, reason: "対象を特定できません" };
  if (target.uid === actorUid) return { ok: false, reason: "自分自身の所属は削除できません" };
  if (target.role === "admin") {
    const admins = members.filter(m => m.role === "admin");
    return { ok: false, reason: admins.length === 1 ? "最後の管理者の所属は削除できません" : "管理者の所属は削除できません" };
  }
  if (!MEMBER_ROLES.includes(target.role)) return { ok: false, reason: "削除できない権限です" };
  if (!canManageRole(actorRole, target.role)) return { ok: false, reason: "この役割の利用者は削除できません" };
  return { ok: true };
}

export function confirmMessage(target) {
  const who = `${memberLabel(target)}${target.email ? `（${target.email}）` : ""}`;
  return `${who} の所属をこの施設から削除しますか？\nこの利用者は、この施設の注文画面・設定を利用できなくなります。\n再び利用するには、もう一度「追加」から登録してください。`;
}

/** 参加待ちの状態: "pending"(参加待ち) | "expired"(期限切れ) | "declined"(辞退) */
export function pendingState(p, nowMs = Date.now()) {
  if (p.status === "declined") return "declined";
  const exp = toMillis(p.expiresAt);
  if (exp === null || exp <= nowMs) return "expired";
  return "pending";
}
export const PENDING_STATE_LABELS = Object.freeze({ pending: "参加待ち", expired: "期限切れ", declined: "辞退" });

function toMillis(v) {
  if (!v) return null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.seconds === "number") return v.seconds * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** 参加待ちの期限の表示(日本時間の「2026/11/24」) */
export function formatExpiry(v) {
  const ms = toMillis(v);
  if (ms === null) return "";
  const d = new Date(ms + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 参加待ちの一覧の並び: 参加待ち → 期限切れ → 辞退、名前 */
export function sortPending(list, nowMs = Date.now()) {
  const rank = { pending: 0, expired: 1, declined: 2 };
  return [...list].sort((a, b) => rank[pendingState(a, nowMs)] - rank[pendingState(b, nowMs)] || memberLabel(a).localeCompare(memberLabel(b), "ja"));
}
