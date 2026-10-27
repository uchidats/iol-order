/**
 * 施設のセルフ登録・利用者管理の呼び出し口（Cloud Functions の callable）
 * 実際の処理はすべてサーバー側（functions/src/registration.js）で行われ、権限の判断もサーバーが行う。
 * ここでは入力を渡して結果を受け取るだけで、役割（role）や施設IDなどをクライアントが指定することはない。
 *
 * @param {object} deps
 * @param {object} deps.functions   firebase-functions の Functions インスタンス
 * @param {Function} deps.httpsCallable
 */
export function createRegistrationApi({ functions, httpsCallable }) {
  const call = async (name, payload) => (await httpsCallable(functions, name)(payload)).data;
  return {
    /** 施設名の入力中の重複候補の確認(読み取りのみ。完全一致の有無と似た施設の件数だけ。他施設の情報は返らない) @returns {Promise<{exact:boolean, similarCount:number, candidates:string[]}>} candidates は施設名のみ・最大5件 */
    checkFacilityName: ({ name }) => call("checkFacilityName", { name }),
    /**
     * 新しい施設の登録申請(運営者の承認制。申請の時点では施設は有効にならず、管理者の権限も付かない)。
     * @returns {Promise<{status:"submitted", applicationId:string, applicationStatus:string}|{status:"duplicate-candidate", exact:boolean, similarCount:number}>}
     */
    registerFacility: ({ name, requestId, confirmDuplicate, applicantName }) =>
      call("registerFacility", { name, requestId, ...(confirmDuplicate ? { confirmDuplicate: true } : {}), ...(applicantName ? { applicantName } : {}) }),
    /** 施設登録の申請の一覧(承認権限のある運営者のみ。サーバーが確認する) */
    listFacilityApplications: () => call("listFacilityApplications", {}),
    /** 申請の承認・却下(承認権限のある運営者のみ)。firstAdmin を指定すると、その人が参加を承諾したときに最初の管理者になる */
    decideFacilityApplication: ({ applicationId, decision, firstAdmin, reason, confirmDuplicate }) =>
      call("decideFacilityApplication", { applicationId, decision, ...(firstAdmin ? { firstAdmin } : {}), ...(reason ? { reason } : {}), ...(confirmDuplicate ? { confirmDuplicate: true } : {}) }),
    /** 施設名の変更(施設管理者のみ。重複候補があれば status:"duplicate-candidate" を返し、confirmDuplicate なしでは変更しない) */
    renameFacility: ({ facilityId, name, confirmDuplicate }) =>
      call("renameFacility", confirmDuplicate ? { facilityId, name, confirmDuplicate: true } : { facilityId, name }),
    /** 施設の削除(施設IDで特定。施設管理者のみ。注文履歴がある・自分以外の所属がある場合はサーバーが拒否する) */
    deleteFacility: ({ facilityId }) => call("deleteFacility", { facilityId }),
    /** 管理者・副管理者が、利用者の所属を削除する(所属の削除と操作履歴の記録は、サーバーで1トランザクション) */
    removeMember: ({ facilityId, uid }) => call("removeMember", { facilityId, uid }),
    // ---- 利用者管理(事前登録・参加確認・役割変更)。権限の判定はすべてサーバー ----
    /** 事前登録(名前・メール・役割)。@returns {Promise<{pendingId:string, email:string, name:string, role:string, status:string, expiresAt:string}>} */
    addMember: ({ facilityId, name, email, role }) => call("addMember", { facilityId, name, email, role }),
    cancelPendingMember: ({ facilityId, pendingId }) => call("cancelPendingMember", { facilityId, pendingId }),
    /** 期限切れ・辞退の再登録(今日から30日) */
    renewPendingMember: ({ facilityId, pendingId }) => call("renewPendingMember", { facilityId, pendingId }),
    changeMemberRole: ({ facilityId, uid, role }) => call("changeMemberRole", { facilityId, uid, role }),
    /** 参加済みの利用者の氏名(この施設の表示名のみ。認証情報・他施設は変わらない) */
    updateMemberName: ({ facilityId, uid, name }) => call("updateMemberName", { facilityId, uid, name }),
    /** 参加待ちの氏名・メールアドレス・役割。メールアドレスを変えると参加待ちのIDも変わる(戻り値の pendingId) */
    updatePendingMember: ({ facilityId, pendingId, name, email, role }) => call("updatePendingMember", { facilityId, pendingId, name, email, role }),
    /** ログイン中の本人宛ての参加待ち。@returns {Promise<{memberships:Array<{pendingId:string, facilityId:string, facilityName:string, role:string, roleLabel:string, invitedByName:string|null, expiresAt:string}>}>} */
    listMyPendingMemberships: () => call("listMyPendingMemberships", {}),
    /** 参加の承認(accept=true)・辞退(false)。@returns {Promise<{status:"joined"|"already-member"|"declined", facilityId:string, role?:string}>} */
    respondMembership: ({ pendingId, accept }) => call("respondMembership", { pendingId, accept: accept === true })
  };
}

const SERVER_MESSAGE_CODES = new Set([
  "invalid-argument", "permission-denied", "failed-precondition",
  "resource-exhausted", "already-exists", "not-found", "unauthenticated"
]);

/** サーバーが返した日本語メッセージを表示し、それ以外（内部エラー・通信エラー）は一般的な文言にする */
export function describeCallableError(e) {
  const code = String((e && e.code) || "").replace(/^functions\//, "");
  if (SERVER_MESSAGE_CODES.has(code) && e.message) return e.message;
  if (code === "unavailable" || code === "deadline-exceeded") return "サーバーに接続できません。通信状況を確認して、もう一度お試しください。";
  return "処理に失敗しました。時間をおいて再度お試しください。";
}
