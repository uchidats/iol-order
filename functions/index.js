/**
 * Cloud Functions（第2世代・callable）: 施設のセルフ登録と招待参加
 *
 * 施設の作成や所属の作成は、Firestore Security Rules ではクライアントに許可していない。
 * 信頼できるこのサーバー側処理（Admin SDK）だけが行う。ロジックは src/registration.js。
 *
 * デプロイには Blaze（従量課金）プランと Cloud Functions / Cloud Build 等の API 有効化が必要。
 * （docs/self-registration.md 参照）
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineString, defineBoolean } from "firebase-functions/params";
import { createRegistrationService, RegistrationError } from "./src/registration.js";
import { createOrderService } from "./src/orders.js";
import { createMemberService } from "./src/members.js";
import { getAuth } from "firebase-admin/auth";

initializeApp();

const REGION = "asia-northeast1";
const service = createRegistrationService({ db: getFirestore(), FieldValue, Timestamp });

// 注文受付(第1段階: 検証して保存するまで。ディーラーへの通知はしない)。
// 明示的に有効化するまで受け付けない(キルスイッチ)。functions/.env.<project> で ORDER_INTAKE_ENABLED=true にする。
const ORDER_INTAKE_ENABLED = defineBoolean("ORDER_INTAKE_ENABLED", { default: false });
// 開発用受付の制限(サーバー側で強制)。許可した施設ID・ユーザーUID(カンマ区切り)だけが注文でき、保存される注文には testOrder: true が付く。
// ORDER_INTAKE_UNRESTRICTED=true にしない限り、リストが空なら誰も注文できない(安全側)。
const ORDER_TEST_FACILITY_IDS = defineString("ORDER_TEST_FACILITY_IDS", { default: "" });
const ORDER_TEST_UIDS = defineString("ORDER_TEST_UIDS", { default: "" });
const ORDER_INTAKE_UNRESTRICTED = defineBoolean("ORDER_INTAKE_UNRESTRICTED", { default: false });
const csv = (v) => String(v || "").split(",").map(x => x.trim()).filter(Boolean);
const orderService = createOrderService({
  db: getFirestore(), FieldValue,
  isEnabled: () => ORDER_INTAKE_ENABLED.value(),
  getPolicy: () => ({
    unrestricted: ORDER_INTAKE_UNRESTRICTED.value(),
    facilityIds: csv(ORDER_TEST_FACILITY_IDS.value()),
    uids: csv(ORDER_TEST_UIDS.value())
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

export const registerFacility = onCall(options, wrap(service.registerFacility));
export const createInvite = onCall(options, wrap(service.createInvite));
export const acceptInvite = onCall(options, wrap(service.acceptInvite));
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
