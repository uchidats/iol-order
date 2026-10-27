/**
 * Cloud Functions（第2世代・callable）: 施設のセルフ登録・利用者管理・注文受付
 *
 * 施設の作成や所属の作成は、Firestore Security Rules ではクライアントに許可していない。
 * 信頼できるこのサーバー側処理（Admin SDK）だけが行う。ロジックは src/registration.js。
 *
 * デプロイには Blaze（従量課金）プランと Cloud Functions / Cloud Build 等の API 有効化が必要。
 * （docs/self-registration.md 参照）
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { defineString, defineBoolean, defineSecret } from "firebase-functions/params";
import { createRegistrationService, RegistrationError } from "./src/registration.js";
import { createFacilityApplicationService, createApplicationNotifier } from "./src/facility-applications.js";
import { createOrderService } from "./src/orders.js";
import { createMemberService } from "./src/members.js";
import { getAuth } from "firebase-admin/auth";
import { onDocumentWrittenWithAuthContext, onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { createMailDispatchService, createResendSender, verifyWebhookSignature } from "./src/order-mail-outbox.js";
import { createSettingsAuditService } from "./src/settings-audit.js";

initializeApp();

const REGION = "asia-northeast1";
const service = createRegistrationService({ db: getFirestore(), FieldValue, Timestamp });
// 新しい施設の登録は運営者の承認制(申請 → 承認・却下。docs/facility-applications.md)
const applications = createFacilityApplicationService({ db: getFirestore(), FieldValue, Timestamp, registration: service });

// 注文受付(第1段階: 検証して保存するまで。ディーラーへの通知はしない)。
// 明示的に有効化するまで受け付けない(キルスイッチ)。functions/.env.<project> で ORDER_INTAKE_ENABLED=true にする。
const ORDER_INTAKE_ENABLED = defineBoolean("ORDER_INTAKE_ENABLED", { default: false });
// 開発用受付の制限(サーバー側で強制)。許可した施設ID・ユーザーUID(カンマ区切り)だけが注文でき、保存される注文には testOrder: true が付く。
// ORDER_INTAKE_UNRESTRICTED=true にしない限り、リストが空なら誰も注文できない(安全側)。
const ORDER_TEST_FACILITY_IDS = defineString("ORDER_TEST_FACILITY_IDS", { default: "" });
const ORDER_TEST_UIDS = defineString("ORDER_TEST_UIDS", { default: "" });
const ORDER_INTAKE_UNRESTRICTED = defineBoolean("ORDER_INTAKE_UNRESTRICTED", { default: false });
// 許可リストでの受付をテスト注文(testOrder: true。メールはテスト用の宛先だけ)として保存するか。false で、許可リストのまま本番の注文として保存する
const ORDER_TEST_MODE = defineBoolean("ORDER_TEST_MODE", { default: true });
const csv = (v) => String(v || "").split(",").map(x => x.trim()).filter(Boolean);
const orderService = createOrderService({
  db: getFirestore(), FieldValue,
  isEnabled: () => ORDER_INTAKE_ENABLED.value(),
  getPolicy: () => ({
    unrestricted: ORDER_INTAKE_UNRESTRICTED.value(),
    facilityIds: csv(ORDER_TEST_FACILITY_IDS.value()),
    uids: csv(ORDER_TEST_UIDS.value()),
    testMode: ORDER_TEST_MODE.value()
  })
});

// 想定外のエラーの詳細はクライアントへ返さない（ログにのみ残す）
function wrap(handler) {
  return async (request) => {
    try {
      return await handler({ auth: request.auth, data: request.data });
    } catch (e) {
      if (e instanceof RegistrationError) throw new HttpsError(e.code, e.message);
      console.error("callable failed:", e);
      throw new HttpsError("internal", "処理に失敗しました。時間をおいて再度お試しください");
    }
  };
}

// 実行サービスアカウント: 既定(Compute Engine 既定SA、通常は Editor で過大)ではなく専用SAで動かす。
// 付与する権限は roles/datastore.user と roles/logging.logWriter のみ(docs/self-registration.md)。
// SA が未作成の間はデプロイがエラーになる(既定SAへはフォールバックしない)。
const RUNTIME_SERVICE_ACCOUNT = defineString("RUNTIME_SERVICE_ACCOUNT", {
  default: "iol-functions-dev@medconf-iol-dev.iam.gserviceaccount.com"
});

// enforceAppCheck は App Check 導入後に true にする
const options = {
  region: REGION, maxInstances: 5, enforceAppCheck: false,
  serviceAccount: RUNTIME_SERVICE_ACCOUNT
};

// 施設の登録申請(呼び出し名は従来どおり registerFacility。申請の時点では施設を作らず、管理者の権限も付けない)
export const registerFacility = onCall(options, wrap(applications.applyFacility));
// 申請の一覧・承認・却下(施設登録の承認権限をサーバーで確認する。現在は運営者のみ)
export const listFacilityApplications = onCall(options, wrap(applications.listApplications));
export const decideFacilityApplication = onCall(options, wrap(applications.decideApplication));
// 申請の削除(運営者 = platformAdmin のみ。審査中・却下済みだけ。運営者の操作履歴 platformAuditLogs に記録)
export const deleteFacilityApplication = onCall(options, wrap(applications.deleteApplication));
export const deleteFacility = onCall(options, wrap(service.deleteFacility));   // 施設の削除(施設管理者のみ・注文履歴なし・自分以外の所属なし)
export const renameFacility = onCall(options, wrap(service.renameFacility));   // 施設名の変更(施設管理者のみ・重複確認つき)
export const checkFacilityName = onCall(options, wrap(service.checkFacilityName));   // 施設名の重複候補の確認(読み取りのみ・件数だけを返す)
export const createOrder = onCall(options, wrap(orderService.createOrder));

// 利用者の所属削除(施設管理者のみ)。所属の削除と操作履歴の記録を1つのトランザクションで行う
const memberService = createMemberService({
  db: getFirestore(), FieldValue, Timestamp,
  lookupEmail: async (uid) => { try { return (await getAuth().getUser(uid)).email || null; } catch (e) { return null; } }
});
export const removeMember = onCall(options, wrap(memberService.removeMember));
// 利用者管理(事前登録・参加確認・役割変更)。権限は functions/src/roles.js(firestore.rules と一致)
export const addMember = onCall(options, wrap(memberService.addMember));
export const cancelPendingMember = onCall(options, wrap(memberService.cancelPendingMember));
export const renewPendingMember = onCall(options, wrap(memberService.renewPendingMember));
export const listMyPendingMemberships = onCall(options, wrap(memberService.listMyPendingMemberships));
export const respondMembership = onCall(options, wrap(memberService.respondMembership));
export const changeMemberRole = onCall(options, wrap(memberService.changeMemberRole));
export const updateMemberName = onCall(options, wrap(memberService.updateMemberName));         // 参加済みの利用者の氏名(この施設の表示名のみ)
export const updatePendingMember = onCall(options, wrap(memberService.updatePendingMember));   // 参加待ちの氏名・メール・役割

// 施設設定(担当医・採用IOL・ディーラー)の変更履歴。画面からの直接の書き込みを Firestore トリガーで受けて auditLogs に記録する(src/settings-audit.js)。
// 同じイベントの再配信・再試行でも二重に記録しない(履歴のIDをイベントIDから決める)ため、失敗時は再試行させる。
const settingsAudit = createSettingsAuditService({ db: getFirestore(), FieldValue });
const auditTrigger = (collection) => onDocumentWrittenWithAuthContext(
  { document: `facilities/{facilityId}/${collection}/{docId}`, region: REGION, retry: true, maxInstances: 5, serviceAccount: RUNTIME_SERVICE_ACCOUNT },
  (event) => settingsAudit.recordSettingChange({
    eventId: event.id, collection, facilityId: event.params.facilityId, docId: event.params.docId,
    before: event.data && event.data.before.exists ? event.data.before.data() : null,
    after: event.data && event.data.after.exists ? event.data.after.data() : null,
    authType: event.authType, authId: event.authId, time: event.time
  }));
export const auditOrderers = auditTrigger("orderers");
export const auditAdoptedIols = auditTrigger("adoptedIols");
export const auditFacilityDealers = auditTrigger("facilityDealers");
export const auditFacilitySettings = auditTrigger("settings");   // 施設のメール設定(注文控えの宛先・署名)

// ---------------- 注文メールの送信(docs/order-mail.md) ----------------
// 送信のキルスイッチ。true にするまで送信せず、送信待ちのメールは held(未送信)になる。true にしても ORDER_INTAKE_ENABLED は別。
const MAIL_SENDING_ENABLED = defineBoolean("MAIL_SENDING_ENABLED", { default: false });
// true(既定)の間は、すべてのメールを MAIL_TEST_RECIPIENT だけに送る(テスト注文でなくても)。実際のディーラーに送るには明示的に false にする
const MAIL_TEST_ONLY = defineBoolean("MAIL_TEST_ONLY", { default: true });
const MAIL_FROM = defineString("MAIL_FROM", { default: "" });                     // 例: "IOL Order <order@mail.example.jp>"(配信サービスで認証済みのドメイン)
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");                              // Secret Manager(コード・.env に書かない)
const RESEND_WEBHOOK_SECRET = defineSecret("RESEND_WEBHOOK_SECRET");
const MAIL_TEST_RECIPIENT = defineSecret("MAIL_TEST_RECIPIENT");                   // テスト注文(開発用受付)の送信先。個人のアドレスなので Secret Manager(リポジトリに書かない)
const mailDispatch = createMailDispatchService({
  db: getFirestore(), FieldValue, Timestamp,
  isEnabled: () => MAIL_SENDING_ENABLED.value() && Boolean(MAIL_FROM.value()),
  testRecipient: () => String(MAIL_TEST_RECIPIENT.value() || "").trim(),
  testOnly: () => MAIL_TEST_ONLY.value(),
  getSender: () => createResendSender({ apiKey: RESEND_API_KEY.value(), from: MAIL_FROM.value() })
});
const mailOptions = { region: REGION, maxInstances: 5, serviceAccount: RUNTIME_SERVICE_ACCOUNT, secrets: [RESEND_API_KEY, MAIL_TEST_RECIPIENT] };
// 送信待ちのメールが作られたら送る(再試行はこの関数ではなく、定期実行が状態を見て行う)
export const sendOrderMail = onDocumentCreated({ ...mailOptions, document: "facilities/{facilityId}/orders/{orderId}/mails/{mailId}" },
  (event) => (event.data ? mailDispatch.processMail(event.data.ref) : null));
// 施設の登録申請を運営者に通知する(申請の作成時に1回。失敗しても申請は残り、結果を申請に記録する)。送信の可否・テスト用の宛先は注文メールと同じ設定
const OPERATOR_NOTIFY_RECIPIENT = defineSecret("OPERATOR_NOTIFY_RECIPIENT");      // 運営者の通知先(カンマ区切り)。個人のアドレスなので Secret Manager
const applicationNotifier = createApplicationNotifier({
  db: getFirestore(), FieldValue,
  isEnabled: () => MAIL_SENDING_ENABLED.value() && Boolean(MAIL_FROM.value()),
  recipients: () => String(OPERATOR_NOTIFY_RECIPIENT.value() || "").split(","),
  testOnly: () => MAIL_TEST_ONLY.value(),
  testRecipient: () => String(MAIL_TEST_RECIPIENT.value() || "").trim(),
  getSender: () => createResendSender({ apiKey: RESEND_API_KEY.value(), from: MAIL_FROM.value() })
});
export const notifyFacilityApplication = onDocumentCreated({ ...mailOptions, secrets: [...mailOptions.secrets, OPERATOR_NOTIFY_RECIPIENT], document: "facilityApplications/{applicationId}" },
  (event) => (event.data ? applicationNotifier.notify(event.data.ref) : null));
// 再送待ち・送信中のまま止まったメール・送信できる注文控えの処理(10分ごと)
export const retryOrderMails = onSchedule({ ...mailOptions, schedule: "every 10 minutes", timeZone: "Asia/Tokyo" }, () => mailDispatch.processDue());
// 配信結果(Resend の Webhook。署名を検証する)。受付と配信の結果を区別して記録する
export const resendWebhook = onRequest({ region: REGION, maxInstances: 5, serviceAccount: RUNTIME_SERVICE_ACCOUNT, secrets: [RESEND_WEBHOOK_SECRET] }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).send(""); return; }
  const ok = verifyWebhookSignature({
    secret: RESEND_WEBHOOK_SECRET.value(), id: req.get("svix-id"), timestamp: req.get("svix-timestamp"),
    signature: req.get("svix-signature"), rawBody: req.rawBody
  });
  if (!ok) { res.status(401).send(""); return; }
  try {
    await mailDispatch.handleDeliveryEvent(req.body);
    res.status(200).send("");
  } catch (e) {
    console.error("webhook failed:", e);
    res.status(500).send("");   // 配信サービスが再送する
  }
});
