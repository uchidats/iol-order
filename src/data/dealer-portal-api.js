/**
 * ディーラー専用画面の呼び出し(Cloud Functions の callable)。権限・範囲はすべてサーバーが確認する。
 * 画面から送るのは、各操作に必要な項目だけ(会社ID・施設ID・期間などの選択値。役割・UID・メールは送らない)。
 *  - dealerPortalApi: ディーラーの担当者(一覧・詳細・担当施設・参加)
 *  - facilityDealerPortal: 施設の管理者・副管理者(閲覧の許可・取消)
 *  - dealerPortalOperator: 運営者(会社・支店・担当者・関連付け)
 */
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined).map(k => [k, o[k]]));

/**
 * @param {object} [deps.device] 確認済みの端末の値の保存先 { get(): string|null, set(token) }(ディーラー画面だけ)。
 *   担当者の呼び出しに付け、サーバーが返した新しい値(参加・Microsoft の登録・端末の確認の後)を保存する
 */
export function createDealerPortalApi({ functions, httpsCallable, device = null }) {
  const call = (name) => {
    const fn = httpsCallable(functions, name);
    return async (payload) => (await fn(payload)).data;
  };
  const rawPortal = call("dealerPortalApi");
  const portal = async (payload) => {
    const token = device ? device.get() : null;
    const r = await rawPortal(token ? { ...payload, deviceToken: token } : payload);
    if (!r || typeof r.deviceToken !== "string") return r;
    const saved = device ? device.set(r.deviceToken) !== false : false;
    const { deviceToken, ...rest } = r;   // 値は画面の処理に渡さない(端末に保存できたかだけを返す)
    return { ...rest, deviceSaved: saved };
  };
  const facility = call("facilityDealerPortal");
  const operator = call("dealerPortalOperator");
  return {
    // ディーラーの担当者
    companies: () => portal({ action: "companies" }),
    // 本人確認(参加・ログイン方法の紐付け・メールリンクの端末の確認)。送り先はサーバーが確定する(画面からは送らない)
    sendCode: () => portal({ action: "sendCode" }),
    verifyCode: (a) => portal({ action: "verifyCode", code: String((a && a.code) || "") }),
    context: (a = {}) => portal({ action: "context", ...pick(a, ["companyId"]) }),
    setMyAssignments: (a) => portal({ action: "setAssignments", ...pick(a, ["companyId", "facilityIds"]) }),
    listOrders: (a) => portal({ action: "list", ...pick(a, ["companyId", "from", "to", "facilityFilter", "orderNumber", "limit", "cursor"]) }),
    getOrder: (a) => portal({ action: "get", ...pick(a, ["companyId", "receiptId"]) }),
    // 施設の管理者・副管理者
    facilityStatus: (a) => facility({ action: "status", ...pick(a, ["facilityId"]) }),
    grant: (a) => facility({ action: "grant", ...pick(a, ["facilityId", "localDealerId", "revision"]) }),
    revoke: (a) => facility({ action: "revoke", ...pick(a, ["facilityId", "localDealerId", "revision"]) }),
    // 運営者
    overview: () => operator({ action: "overview" }),
    createCompany: (a) => operator({ action: "createCompany", ...pick(a, ["name", "requestId"]) }),
    updateCompany: (a) => operator({ action: "updateCompany", ...pick(a, ["companyId", "name", "status"]) }),
    upsertBranch: (a) => operator({ action: "upsertBranch", ...pick(a, ["companyId", "branchId", "name", "status"]) }),
    inviteStaff: (a) => operator({ action: "inviteStaff", ...pick(a, ["companyId", "email", "name", "role", "branchId"]) }),
    cancelInvitation: (a) => operator({ action: "cancelInvitation", ...pick(a, ["companyId", "staffId"]) }),
    updateStaff: (a) => operator({ action: "updateStaff", ...pick(a, ["companyId", "staffId", "status", "role", "branchId", "name", "facilityIds"]) }),
    proposeLink: (a) => operator({ action: "proposeLink", ...pick(a, ["facilityId", "localDealerId", "companyId"]) })
  };
}

/** 機能が止まっている(サーバーの機能スイッチ)・未配備で使えないエラーか(施設設定ではその項目を表示しない) */
export function isPortalUnavailable(e) {
  const code = String((e && e.code) || "");
  const message = String((e && e.message) || "");
  const english = !/[぀-ヿ一-鿿]/.test(message);
  return (code.endsWith("failed-precondition") && /現在ご利用いただけません/.test(message)) || (code.endsWith("not-found") && english);
}
