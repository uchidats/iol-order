/**
 * 初期登録スクリプトの引数検証と実行計画（Firebaseへは接続しない純粋ロジック）
 * 安全策:
 *  - 対象プロジェクトは開発用 medconf-iol-dev に固定
 *  - 既定は dry-run。--apply には --confirm-uid <対象UID> の一致が必須
 *  - 認証は Application Default Credentials のみ（サービスアカウント秘密鍵ファイルは使わない）
 */
export const ALLOWED_PROJECT = "medconf-iol-dev";

export const ACTIONS = Object.freeze({
  LOOKUP: "lookup",
  GRANT_PLATFORM_ADMIN: "grant-platform-admin",
  CREATE_FACILITY: "create-facility",
  ADD_FACILITY_ADMIN: "add-facility-admin"
});

const UID_RE = /^[A-Za-z0-9]{20,128}$/;
const FACILITY_ID_RE = /^[a-z0-9][a-z0-9-]{2,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseArgs(argv) {
  const out = { _: [], apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") { out.apply = true; continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = argv[++i];
    } else {
      out._.push(a);
    }
  }
  return out;
}

/**
 * @returns {{ok:true, plan:object}|{ok:false, errors:string[]}}
 */
export function buildPlan(args) {
  const errors = [];
  const action = args._[0];
  const project = args.project || ALLOWED_PROJECT;

  if (project !== ALLOWED_PROJECT) errors.push(`対象プロジェクトは ${ALLOWED_PROJECT} のみです`);
  if (!Object.values(ACTIONS).includes(action)) {
    errors.push(`action は ${Object.values(ACTIONS).join(" | ")} のいずれかを指定してください`);
  }

  if (action === ACTIONS.LOOKUP && !EMAIL_RE.test(args.email || "")) {
    errors.push("--email に有効なメールアドレスを指定してください");
  }
  if ([ACTIONS.GRANT_PLATFORM_ADMIN, ACTIONS.ADD_FACILITY_ADMIN].includes(action) && !UID_RE.test(args.uid || "")) {
    errors.push("--uid に有効なUIDを指定してください（lookup で確認）");
  }
  if ([ACTIONS.CREATE_FACILITY, ACTIONS.ADD_FACILITY_ADMIN].includes(action) && !FACILITY_ID_RE.test(args.facilityId || "")) {
    errors.push("--facility-id は小文字英数字とハイフンの3〜41文字にしてください");
  }
  if (action === ACTIONS.CREATE_FACILITY) {
    const n = args.facilityName || "";
    if (n.length < 1 || n.length > 100) errors.push("--facility-name は1〜100文字で指定してください");
  }

  const mutating = action && action !== ACTIONS.LOOKUP;
  if (mutating && args.apply && (!args.confirmUid || args.confirmUid !== args.uid)) {
    // create-facility は uid を取らないため、確認用に facility-id を要求する
    if (action === ACTIONS.CREATE_FACILITY) {
      if (args.confirmFacilityId !== args.facilityId) errors.push("--apply には --confirm-facility-id <facility-id> の一致が必要です");
    } else {
      errors.push("--apply には --confirm-uid <対象UID> の一致が必要です");
    }
  }

  if (errors.length) return { ok: false, errors };

  const plan = { project, action, apply: Boolean(mutating && args.apply), operations: [] };
  switch (action) {
    case ACTIONS.LOOKUP:
      plan.operations.push({ type: "auth.getUserByEmail", email: args.email, readOnly: true });
      break;
    case ACTIONS.GRANT_PLATFORM_ADMIN:
      plan.operations.push({ type: "auth.setCustomUserClaims", uid: args.uid, merge: { platformAdmin: true } });
      break;
    case ACTIONS.CREATE_FACILITY:
      plan.operations.push({
        type: "firestore.create", path: `facilities/${args.facilityId}`,
        data: { name: args.facilityName, status: "active" }, failIfExists: true
      });
      break;
    case ACTIONS.ADD_FACILITY_ADMIN:
      plan.operations.push({
        type: "firestore.create", path: `facilities/${args.facilityId}/members/${args.uid}`,
        data: { uid: args.uid, role: "admin", status: "active" }, failIfExists: true,
        requires: [`facilities/${args.facilityId} が存在する`, `Authユーザー ${args.uid} が存在する`]
      });
      break;
  }
  return { ok: true, plan };
}
