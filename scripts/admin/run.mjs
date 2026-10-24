// 開発環境(medconf-iol-dev)の初期登録ツール。使い方は docs/firebase-dev-runbook.md
//   node scripts/admin/run.mjs lookup --email <メール>
//   node scripts/admin/run.mjs grant-platform-admin --uid <UID> [--apply --confirm-uid <UID>]
//   node scripts/admin/run.mjs create-facility --facility-id <id> --facility-name <名称> [--apply --confirm-facility-id <id>]
//   node scripts/admin/run.mjs set-facility-geo --facility-id <id> --lat <緯度> --lng <経度> --radius-m <判定距離m> [--apply --confirm-facility-id <id>]
//   node scripts/admin/run.mjs add-facility-admin --facility-id <id> --uid <UID> [--apply --confirm-uid <UID>]
// 既定は dry-run（何も書き込まない）。認証は Application Default Credentials のみ。
import { parseArgs, buildPlan, ACTIONS, ALLOWED_PROJECT } from "./plan.mjs";

const args = parseArgs(process.argv.slice(2));
const result = buildPlan(args);

if (!result.ok) {
  console.error("引数エラー:\n- " + result.errors.join("\n- "));
  process.exit(2);
}
const { plan } = result;

console.log(`対象プロジェクト: ${plan.project} / action: ${plan.action} / モード: ${plan.apply ? "APPLY(書き込み)" : "DRY-RUN"}`);

const [{ initializeApp, applicationDefault }, { getAuth }, { getFirestore, FieldValue }] = await Promise.all([
  import("firebase-admin/app"), import("firebase-admin/auth"), import("firebase-admin/firestore")
]);

// 秘密鍵ファイルは使わない: GOOGLE_APPLICATION_CREDENTIALS が設定されていたら中止
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("GOOGLE_APPLICATION_CREDENTIALS が設定されています。サービスアカウント鍵は使用しない方針のため中止します。");
  process.exit(3);
}

const app = initializeApp({ credential: applicationDefault(), projectId: ALLOWED_PROJECT });
const auth = getAuth(app);
const db = getFirestore(app);

const describeUser = (u) => ({
  uid: u.uid, email: u.email, displayName: u.displayName,
  providers: u.providerData.map(p => p.providerId),
  emailVerified: u.emailVerified, disabled: u.disabled,
  createdAt: u.metadata.creationTime, lastSignInAt: u.metadata.lastSignInTime,
  customClaims: u.customClaims || {}
});

async function main() {
  const op = plan.operations[0];

  if (plan.action === ACTIONS.LOOKUP) {
    console.log(describeUser(await auth.getUserByEmail(op.email)));
    return;
  }

  if (plan.action === ACTIONS.GRANT_PLATFORM_ADMIN) {
    const user = await auth.getUser(op.uid); // 存在しなければ例外
    console.log("対象ユーザー:", describeUser(user));
    console.log("実行内容: customClaims に platformAdmin=true を追加（既存クレームは保持）");
    // 取り違え・なりすまし防止: メール確認済みで有効なアカウントにのみ付与する
    if (!user.emailVerified || user.disabled) throw new Error("メール未確認または無効なアカウントには付与できません");
    if (!plan.apply) return console.log("DRY-RUN: 変更していません。");
    await auth.setCustomUserClaims(op.uid, { ...(user.customClaims || {}), platformAdmin: true });
    console.log("完了。対象ユーザーは再ログイン（またはトークン更新）後に反映されます。");
    return;
  }

  if (plan.action === ACTIONS.CREATE_FACILITY) {
    const ref = db.doc(op.path);
    console.log("実行内容:", op.type, op.path, op.data);
    if ((await ref.get()).exists) throw new Error("施設が既に存在します（上書きしません）");
    if (!plan.apply) return console.log("DRY-RUN: 変更していません。");
    await ref.create({ ...op.data, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    console.log("施設を作成しました。");
    return;
  }

  if (plan.action === ACTIONS.SET_FACILITY_GEO) {
    const ref = db.doc(op.path);
    console.log("実行内容:", op.type, op.path, op.data);
    if (!(await ref.get()).exists) throw new Error("施設が存在しません");
    if (!plan.apply) return console.log("DRY-RUN: 変更していません。");
    await ref.update({ ...op.data, updatedAt: FieldValue.serverTimestamp() });
    console.log("施設の位置情報を更新しました。");
    return;
  }

  if (plan.action === ACTIONS.ADD_FACILITY_ADMIN) {
    const facilityId = op.path.split("/")[1];
    const user = await auth.getUser(args.uid);
    console.log("対象ユーザー:", describeUser(user));
    console.log("実行内容:", op.type, op.path, op.data);
    if (!(await db.doc(`facilities/${facilityId}`).get()).exists) throw new Error("施設が存在しません");
    const ref = db.doc(op.path);
    if ((await ref.get()).exists) throw new Error("所属が既に存在します（上書きしません）");
    if (!plan.apply) return console.log("DRY-RUN: 変更していません。");
    await ref.create({ ...op.data, displayName: user.displayName || null, updatedAt: FieldValue.serverTimestamp() });
    console.log("施設管理者の所属を作成しました。");
  }
}

main().catch(err => {
  console.error("失敗:", err.message);
  if (/credential|access token|Could not load the default credentials/i.test(err.message)) {
    console.error("認証情報(ADC)が見つかりません。`gcloud auth application-default login` を実行してください（docs/firebase-dev-runbook.md 4-1）。");
  }
  process.exit(1);
});
