/**
 * 施設内の役割(所属ドキュメントの role)と、その権限。firestore.rules の memberRoles() / managerRoles() と一致させる
 * (tests/rules-roles-sync.test.js が検証)。Functions 側の権限判定はこの定義を使う。
 *
 *  admin    = 管理者     : すべて(施設名・所在地の変更、施設削除、管理者・副管理者の権限管理を含む)
 *  subadmin = 副管理者   : 施設設定(担当医・採用IOL・ディーラー・表示順)、利用者管理(注文者・代行入力者のみ)、注文
 *  orderer  = 注文者     : 注文
 *  proxy    = 代行入力者 : 注文(注文者と同じ権限。注文の記録で役割を区別する)
 */
export const ROLES = Object.freeze({ ADMIN: "admin", SUBADMIN: "subadmin", ORDERER: "orderer", PROXY: "proxy" });

/** 所属として有効な役割(この施設のデータを読め、注文できる) */
export const MEMBER_ROLES = Object.freeze([ROLES.ADMIN, ROLES.SUBADMIN, ROLES.ORDERER, ROLES.PROXY]);

/** 施設設定・利用者管理ができる役割 */
export const MANAGER_ROLES = Object.freeze([ROLES.ADMIN, ROLES.SUBADMIN]);

/**
 * 新しい施設の登録申請を承認・却下できるか(施設登録の承認権限)。platformAdmin 権限とは別の判定として、ここだけで決める。
 * 現在は運営者(platformAdmin)だけ。将来、信頼できる担当者に委任する場合は、この判定に専用の権限を加える
 * (承認権限は申請の一覧・承認・却下だけに使い、施設の注文履歴・取引情報などを読む権限は与えない)。
 * @param {{isPlatformAdmin?:boolean}} user assertVerifiedUser の結果
 */
export const canApproveFacilities = (user) => Boolean(user && user.isPlatformAdmin === true);

export const isMemberRole = (role) => MEMBER_ROLES.includes(role);
export const isManagerRole = (role) => MANAGER_ROLES.includes(role);

/**
 * 操作する人(actorRole)が、対象の役割(targetRole)の利用者を追加・変更・削除できるか。
 * 管理者はすべて、副管理者は注文者・代行入力者だけ(管理者・副管理者の権限管理は管理者のみ)。
 */
export function canManageRole(actorRole, targetRole) {
  if (actorRole === ROLES.ADMIN) return isMemberRole(targetRole);
  if (actorRole === ROLES.SUBADMIN) return targetRole === ROLES.ORDERER || targetRole === ROLES.PROXY;
  return false;
}
