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
import { defineString } from "firebase-functions/params";
import { createRegistrationService, RegistrationError } from "./src/registration.js";

initializeApp();

const REGION = "asia-northeast1";
const service = createRegistrationService({ db: getFirestore(), FieldValue, Timestamp });

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
