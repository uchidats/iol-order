/**
 * 注文の受付(第1段階): 検証して Firestore に保存するところまで。ディーラーへの通知は行わない(次段階)。
 *
 * 方針:
 * - 認証必須。所属・権限・施設の状態・採用IOL・注文者は、すべてサーバー側で Firestore から再確認する。
 * - クライアントが送るのは「何を選んだか」の識別子(modelId / ordererId / 度数 など)だけ。
 *   レンズ名・メーカー・注文者名・メールなどは、サーバーがマスターから引いてスナップショットとして保存する。
 * - 冪等性: 注文ドキュメントIDを (操作ユーザー, requestId) から決め、トランザクション内で存在確認する。
 *   同じ内容の再送は既存の注文番号を返し、同じ requestId で内容が違う場合は拒否する。
 * - 注文番号はサーバーが日付ごとの連番で発行する(クライアントは指定できない)。
 * - 依存(db, FieldValue など)は注入する。テストはエミュレータ上の本物の Firestore で実行する。
 */
import { createHash } from "node:crypto";
import { RegistrationError, assertVerifiedUser } from "./registration.js";
import { IOL_MODELS } from "./iol-catalog.js";
import { filterPowersByModel } from "./power-filter.js";

/** 注文の状態。今回の段階で作成されるのは ACCEPTED まで(ディーラー通知は次段階) */
export const ORDER_STATUS = Object.freeze({
  DRAFT: "draft",                                  // 画面上の未送信状態(サーバーには保存しない)
  ACCEPTED: "accepted",                            // サーバーで検証・保存済み(ディーラー未通知)
  NOTIFICATION_PENDING: "notification_pending",    // 通知待ち(将来)
  NOTIFIED: "notified",                            // ディーラー通知成功(将来)
  NOTIFICATION_FAILED: "notification_failed"       // 通知失敗(将来)
});

export const ORDER_LIMITS = Object.freeze({
  notesMax: 1000,
  maxDaysAhead: 366,
  rateWindowMs: 60 * 60 * 1000,
  rateMax: 60,
  quantities: Object.freeze([1, 2])
});

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;
const ALLOWED_KEYS = ["facilityId", "requestId", "modelId", "power", "toricModel", "quantity", "surgeryDate", "ordererId", "notes"];

const bad = (message = "入力内容を確認してください") => new RegistrationError("invalid-argument", message);

/** 日本時間の今日(YYYY-MM-DD) */
export function jstDate(ms) {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function validDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 入力の形式検証と正規化(マスターとの突き合わせは別) */
export function parseOrderInput(data, nowMs) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw bad();
  for (const k of Object.keys(data)) if (!ALLOWED_KEYS.includes(k)) throw bad();

  const { facilityId, requestId, modelId, power, quantity, surgeryDate, ordererId } = data;
  const toricModel = data.toricModel === undefined || data.toricModel === null ? "" : data.toricModel;
  const notes = data.notes === undefined || data.notes === null ? "" : data.notes;

  if (typeof facilityId !== "string" || !ID.test(facilityId)) throw bad();
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw bad("注文の識別子が正しくありません");
  if (typeof modelId !== "string" || !ID.test(modelId)) throw bad("IOLモデルを選択してください");
  if (typeof power !== "string" || power.length < 1 || power.length > 10) throw bad("IOLパワーを選択してください");
  if (typeof toricModel !== "string" || toricModel.length > 60) throw bad();
  if (!ORDER_LIMITS.quantities.includes(quantity)) throw bad("枚数が正しくありません");
  if (typeof ordererId !== "string" || !ID.test(ordererId)) throw bad("注文者を選択してください");
  if (typeof notes !== "string" || notes.trim().length > ORDER_LIMITS.notesMax) throw bad(`備考は${ORDER_LIMITS.notesMax}文字以内で入力してください`);

  if (!validDate(surgeryDate)) throw bad("手術日が正しくありません");
  const today = jstDate(nowMs);
  const limit = jstDate(nowMs + ORDER_LIMITS.maxDaysAhead * 24 * 60 * 60 * 1000);
  if (surgeryDate < today) throw bad("手術日は本日以降を指定してください");
  if (surgeryDate > limit) throw bad("手術日が先すぎます");

  return { facilityId, requestId, modelId, power, toricModel: toricModel.trim(), quantity, surgeryDate, ordererId, notes: notes.trim() };
}

/** 注文内容(識別子・選択値)の正規化ハッシュ。同じ requestId での内容変更の検出に使う */
export function contentHash(i) {
  return createHash("sha256")
    .update(JSON.stringify([i.facilityId, i.modelId, i.power, i.toricModel, i.quantity, i.surgeryDate, i.ordererId, i.notes]))
    .digest("hex");
}

/** 注文ドキュメントID: 操作ユーザーと requestId から決める(他のユーザーの requestId とは衝突しない) */
export function deriveOrderId(uid, requestId) {
  return "o" + createHash("sha256").update(`${uid}:${requestId}`).digest("hex").slice(0, 32);
}

/** 採用済みモデルの度数・トーリック条件を、サーバー側のマスターで検証する */
export function validateLens(model, input) {
  if (!filterPowersByModel(model).includes(input.power)) throw bad("このIOLモデルでは選択できない度数です");
  if (model.isToric) {
    if (!model.toricModels.includes(input.toricModel)) throw bad("トーリック型番を選択してください");
  } else if (input.toricModel) {
    throw bad("このIOLモデルにトーリック型番は指定できません");
  }
}

/**
 * @param {object} deps
 * @param {import("firebase-admin/firestore").Firestore} deps.db
 * @param {typeof import("firebase-admin/firestore").FieldValue} deps.FieldValue
 * @param {() => number} [deps.now]
 * @param {() => boolean} [deps.isEnabled] 注文受付の有効/無効(キルスイッチ)。未指定は有効
 * @param {Array<object>} [deps.catalog]
 */
export function createOrderService({ db, FieldValue, now = Date.now, isEnabled = () => true, catalog = IOL_MODELS }) {
  async function consumeRate(uid) {
    const ref = db.doc(`rateLimits/${uid}_createOrder`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const t = now();
      let start = snap.exists ? snap.get("windowStart") : 0;
      let n = snap.exists ? snap.get("count") || 0 : 0;
      if (!snap.exists || t - start >= ORDER_LIMITS.rateWindowMs) { start = t; n = 0; }
      if (n >= ORDER_LIMITS.rateMax) throw new RegistrationError("resource-exhausted", "操作の回数が上限に達しました。しばらくしてからお試しください");
      tx.set(ref, { windowStart: start, count: n + 1, updatedAt: FieldValue.serverTimestamp() });
    });
  }

  async function createOrder({ auth, data }) {
    const user = assertVerifiedUser(auth);
    if (!isEnabled()) throw new RegistrationError("failed-precondition", "注文の受付は現在ご利用いただけません");
    const input = parseOrderInput(data, now());
    await consumeRate(user.uid);

    const fRef = db.doc(`facilities/${input.facilityId}`);
    const mRef = db.doc(`facilities/${input.facilityId}/members/${user.uid}`);
    const aRef = db.doc(`facilities/${input.facilityId}/adoptedIols/${input.modelId}`);
    const oRef = db.doc(`facilities/${input.facilityId}/orderers/${input.ordererId}`);
    const orderId = deriveOrderId(user.uid, input.requestId);
    const orderRef = db.doc(`facilities/${input.facilityId}/orders/${orderId}`);
    const hash = contentHash(input);
    const day = jstDate(now()).replace(/-/g, "");
    const counterRef = db.doc(`facilities/${input.facilityId}/orderCounters/${day}`);

    return db.runTransaction(async (tx) => {
      const [fac, mem, adopted, orderer, existing, counter] = await Promise.all(
        [fRef, mRef, aRef, oRef, orderRef, counterRef].map(r => tx.get(r)));

      // 所属・権限はサーバーで再確認する(無効化された人・他施設・所属なしは区別なく拒否)
      const allowed = fac.exists && fac.get("status") === "active"
        && mem.exists && mem.get("status") === "active" && ["admin", "orderer"].includes(mem.get("role"));
      if (!allowed) throw new RegistrationError("permission-denied", "この施設から注文することはできません");

      if (existing.exists) {
        if (existing.get("contentHash") !== hash) {
          throw new RegistrationError("already-exists", "同じ注文の識別子で、異なる内容は受け付けられません。画面を開き直して、もう一度操作してください");
        }
        return { orderId, orderNumber: existing.get("orderNumber"), status: existing.get("status"), replayed: true };
      }

      const model = catalog.find(m => m.id === input.modelId);
      if (!model || !adopted.exists || adopted.get("enabled") !== true || adopted.get("catalogIolId") !== model.id) {
        throw bad("この施設で採用されていないIOLモデルです");
      }
      validateLens(model, input);
      if (!orderer.exists || orderer.get("active") !== true) throw bad("注文者が見つかりません");

      const seq = (counter.exists ? counter.get("count") || 0 : 0) + 1;
      const orderNumber = `IOL-${day}-${String(seq).padStart(4, "0")}`;
      const email = orderer.get("email");

      tx.set(counterRef, { count: seq, updatedAt: FieldValue.serverTimestamp() });
      tx.create(orderRef, {
        schemaVersion: 1,
        orderId, orderNumber, requestId: input.requestId, contentHash: hash,
        facilityId: input.facilityId, facilityName: fac.get("name") || "",
        status: ORDER_STATUS.ACCEPTED,
        // マスターのスナップショット(後でマスターが変わっても、この注文の内容を再現できる)
        item: {
          modelId: model.id, manufacturer: model.manufacturer, model: model.model, displayName: model.displayName,
          isToric: model.isToric, toricModel: model.isToric ? input.toricModel : "",
          power: input.power, quantity: input.quantity
        },
        surgeryDate: input.surgeryDate,
        orderer: { id: input.ordererId, name: orderer.get("name"), email: typeof email === "string" && email ? email : null },
        notes: input.notes,
        // 操作したログインユーザー(注文者とは別の情報)
        createdBy: { uid: user.uid, email: user.email, displayName: user.displayName },
        createdAt: FieldValue.serverTimestamp(), acceptedAt: FieldValue.serverTimestamp(), statusUpdatedAt: FieldValue.serverTimestamp()
      });
      return { orderId, orderNumber, status: ORDER_STATUS.ACCEPTED, replayed: false };
    });
  }

  return { createOrder };
}
