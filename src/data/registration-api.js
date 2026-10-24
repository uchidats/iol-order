/**
 * 施設のセルフ登録・招待の呼び出し口（Cloud Functions の callable）
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
    /** @returns {Promise<{status:"created"|"exists", facilityId:string}|{status:"duplicate-candidate", exact:boolean, similarCount:number}>} */
    registerFacility: ({ name, requestId, confirmDuplicate }) =>
      call("registerFacility", confirmDuplicate ? { name, requestId, confirmDuplicate: true } : { name, requestId }),
    /** @returns {Promise<{token:string, email:string, expiresAt:string}>} */
    createInvite: ({ facilityId, email }) => call("createInvite", { facilityId, email }),
    /** @returns {Promise<{facilityId:string}>} */
    acceptInvite: ({ token }) => call("acceptInvite", { token })
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
