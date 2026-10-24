/**
 * 注文の受付(第1段階): 検証して Firestore に保存するところまで。ディーラーへの通知は行わない(次段階)。
 *
 * 1回の注文は複数の明細(lines)を持てる。明細ごとにモデル・度数・型番・枚数・手術日をサーバーで検証し、
 * 明細にはディーラー振り分け用の dealerId(採用IOLの設定から取得。未設定は null)を保持する。
 * 従来の単一IOLの形式(modelId/power/... をトップレベルに置く)も受け付け、1明細の注文として扱う。
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
  maxLines: 20,          // 1回の注文の明細数の上限
  maxTotalQuantity: 40,  // 1回の注文の合計枚数の上限
  maxDaysAhead: 366,
  rateWindowMs: 60 * 60 * 1000,
  rateMax: 60,
  quantities: Object.freeze([1, 2])
});

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;
const LINE_KEYS = ["modelId", "power", "toricModel", "quantity", "surgeryDate"];
const ALLOWED_KEYS = ["facilityId", "requestId", "ordererId", "notes", "lines", ...LINE_KEYS]; // LINE_KEYS をトップレベルに置くのは従来の単一IOL形式

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

/** 1明細の形式検証と正規化。n は画面に出す明細番号(1始まり) */
function parseLine(raw, n, nowMs) {
  const at = (m) => bad(`明細${n}: ${m}`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw at("入力内容を確認してください");
  for (const k of Object.keys(raw)) if (!LINE_KEYS.includes(k)) throw at("入力内容を確認してください");
  const { modelId, power, quantity, surgeryDate } = raw;
  const toricModel = raw.toricModel === undefined || raw.toricModel === null ? "" : raw.toricModel;

  if (typeof modelId !== "string" || !ID.test(modelId)) throw at("IOLモデルを選択してください");
  if (typeof power !== "string" || power.length < 1 || power.length > 10) throw at("IOLパワーを選択してください");
  if (typeof toricModel !== "string" || toricModel.length > 60) throw at("トーリック型番が正しくありません");
  if (!ORDER_LIMITS.quantities.includes(quantity)) throw at("枚数が正しくありません");
  if (!validDate(surgeryDate)) throw at("手術日が正しくありません");
  const today = jstDate(nowMs);
  const limit = jstDate(nowMs + ORDER_LIMITS.maxDaysAhead * 24 * 60 * 60 * 1000);
  if (surgeryDate < today) throw at("手術日は本日以降を指定してください");
  if (surgeryDate > limit) throw at("手術日が先すぎます");
  return { modelId, power, toricModel: toricModel.trim(), quantity, surgeryDate };
}

/** 入力の形式検証と正規化(マスターとの突き合わせは別)。従来の単一IOL形式は1明細に正規化する */
export function parseOrderInput(data, nowMs) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw bad();
  for (const k of Object.keys(data)) if (!ALLOWED_KEYS.includes(k)) throw bad();

  const { facilityId, requestId, ordererId } = data;
  const notes = data.notes === undefined || data.notes === null ? "" : data.notes;

  if (typeof facilityId !== "string" || !ID.test(facilityId)) throw bad();
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw bad("注文の識別子が正しくありません");
  if (typeof ordererId !== "string" || !ID.test(ordererId)) throw bad("注文者を選択してください");
  if (typeof notes !== "string" || notes.trim().length > ORDER_LIMITS.notesMax) throw bad(`備考は${ORDER_LIMITS.notesMax}文字以内で入力してください`);

  let rawLines;
  if (data.lines !== undefined) {
    if (LINE_KEYS.some(k => data[k] !== undefined)) throw bad(); // 明細とトップレベルの混在は不可
    if (!Array.isArray(data.lines) || data.lines.length < 1) throw bad("レンズを1つ以上追加してください");
    if (data.lines.length > ORDER_LIMITS.maxLines) throw bad(`明細は${ORDER_LIMITS.maxLines}件までです`);
    rawLines = data.lines;
  } else {
    rawLines = [Object.fromEntries(LINE_KEYS.filter(k => data[k] !== undefined).map(k => [k, data[k]]))];
  }
  const lines = rawLines.map((l, i) => parseLine(l, i + 1, nowMs));

  const seen = new Set();
  lines.forEach((l, i) => {
    const k = JSON.stringify([l.modelId, l.toricModel, l.power, l.surgeryDate]);
    if (seen.has(k)) throw bad(`明細${i + 1}: 同じレンズ・度数・手術日の明細が重複しています。枚数で指定してください`);
    seen.add(k);
  });
  const totalQuantity = lines.reduce((s, l) => s + l.quantity, 0);
  if (totalQuantity > ORDER_LIMITS.maxTotalQuantity) throw bad(`合計枚数は${ORDER_LIMITS.maxTotalQuantity}枚までです`);

  return { facilityId, requestId, ordererId, notes: notes.trim(), lines, totalQuantity };
}

/** 注文内容(識別子・選択値)の正規化ハッシュ。同じ requestId での内容変更の検出に使う(単一IOL形式でも明細1件の形式でも同じ値になる) */
export function contentHash(i) {
  return createHash("sha256")
    .update(JSON.stringify([i.facilityId, i.ordererId, i.notes, i.lines.map(l => [l.modelId, l.power, l.toricModel, l.quantity, l.surgeryDate])]))
    .digest("hex");
}

/** 保存済みの注文を明細の配列として読む(従来の単一IOL形式の注文=schemaVersion 1 も含む) */
export function orderLinesOf(order) {
  if (Array.isArray(order.lines)) return order.lines;
  if (order.item) return [{ lineNo: 1, status: order.status, item: order.item, surgeryDate: order.surgeryDate, dealerId: null }];
  return [];
}

const summaryOf = (o) => ({ lineCount: o.lineCount ?? 1, totalQuantity: o.totalQuantity ?? (o.item ? o.item.quantity : 0) });

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
 * @param {() => {unrestricted?:boolean, facilityIds?:string[], uids?:string[]}} [deps.getPolicy]
 *   受付の対象の制限。既定は制限なし。`unrestricted` でない場合は「開発用受付」で、許可リストに載った施設とユーザー
 *   (ログイン済み・メール確認済み)だけが注文でき(リストが空なら全員拒否)、保存される注文には testOrder: true が付く。
 *   この制限はサーバー側で強制する(画面の設定には依存しない)。
 * @param {Array<object>} [deps.catalog]
 */
export function createOrderService({ db, FieldValue, now = Date.now, isEnabled = () => true, getPolicy = () => ({ unrestricted: true }), catalog = IOL_MODELS }) {
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

    // 開発用受付の制限(許可した施設・ユーザーのみ)。許可外は理由を明かさず拒否し、何も書き込まない
    const policy = getPolicy() || {};
    const restricted = policy.unrestricted !== true;
    if (restricted && !((policy.facilityIds || []).includes(input.facilityId) && (policy.uids || []).includes(user.uid))) {
      throw new RegistrationError("permission-denied", "この施設・ユーザーからの注文は、現在の開発用受付の対象外です");
    }
    await consumeRate(user.uid);

    const fRef = db.doc(`facilities/${input.facilityId}`);
    const mRef = db.doc(`facilities/${input.facilityId}/members/${user.uid}`);
    const oRef = db.doc(`facilities/${input.facilityId}/orderers/${input.ordererId}`);
    const orderId = deriveOrderId(user.uid, input.requestId);
    const orderRef = db.doc(`facilities/${input.facilityId}/orders/${orderId}`);
    const hash = contentHash(input);
    const day = jstDate(now()).replace(/-/g, "");
    const counterRef = db.doc(`facilities/${input.facilityId}/orderCounters/${day}`);

    return db.runTransaction(async (tx) => {
      const [fac, mem, orderer, existing, counter] = await Promise.all(
        [fRef, mRef, oRef, orderRef, counterRef].map(r => tx.get(r)));
      const modelIds = [...new Set(input.lines.map(l => l.modelId))];
      const adoptedSnaps = await Promise.all(modelIds.map(id => tx.get(db.doc(`facilities/${input.facilityId}/adoptedIols/${id}`))));
      const adoptedBy = new Map(modelIds.map((id, i) => [id, adoptedSnaps[i]]));

      // 所属・権限はサーバーで再確認する(無効化された人・他施設・所属なしは区別なく拒否)
      const allowed = fac.exists && fac.get("status") === "active"
        && mem.exists && mem.get("status") === "active" && ["admin", "orderer"].includes(mem.get("role"));
      if (!allowed) throw new RegistrationError("permission-denied", "この施設から注文することはできません");

      if (existing.exists) {
        if (existing.get("contentHash") !== hash) {
          throw new RegistrationError("already-exists", "同じ注文の識別子で、異なる内容は受け付けられません。画面を開き直して、もう一度操作してください");
        }
        return { orderId, orderNumber: existing.get("orderNumber"), status: existing.get("status"), replayed: true, ...summaryOf(existing.data()) };
      }

      // 明細ごとに、採用済みモデル・度数・型番をサーバーのマスターで検証し、その時点のマスターをスナップショットする
      const lines = input.lines.map((l, i) => {
        const n = i + 1;
        const model = catalog.find(m => m.id === l.modelId);
        const adopted = adoptedBy.get(l.modelId);
        if (!model || !adopted.exists || adopted.get("enabled") !== true || adopted.get("catalogIolId") !== model.id) {
          throw bad(`明細${n}: この施設で採用されていないIOLモデルです`);
        }
        try { validateLens(model, l); } catch (e) { throw bad(`明細${n}: ${e.message}`); }
        const dealerId = adopted.get("dealerId");
        return {
          lineNo: n,
          status: ORDER_STATUS.ACCEPTED,
          item: {
            modelId: model.id, manufacturer: model.manufacturer, model: model.model, displayName: model.displayName,
            isToric: model.isToric, isMultifocal: model.isMultifocal, toricModel: model.isToric ? l.toricModel : "",
            power: l.power, quantity: l.quantity
          },
          surgeryDate: l.surgeryDate,
          dealerId: typeof dealerId === "string" && dealerId ? dealerId : null // 将来、ディーラーごとに明細を振り分けるための情報
        };
      });
      if (!orderer.exists || orderer.get("active") !== true) throw bad("注文者が見つかりません");

      const seq = (counter.exists ? counter.get("count") || 0 : 0) + 1;
      const orderNumber = `IOL-${day}-${String(seq).padStart(4, "0")}`;
      const email = orderer.get("email");

      tx.set(counterRef, { count: seq, updatedAt: FieldValue.serverTimestamp() });
      tx.create(orderRef, {
        schemaVersion: 2,
        orderId, orderNumber, requestId: input.requestId, contentHash: hash,
        facilityId: input.facilityId, facilityName: fac.get("name") || "",
        status: ORDER_STATUS.ACCEPTED,
        testOrder: restricted, // 開発用受付で保存された注文(本番の注文と区別・後から削除を判断するための印)
        // マスターのスナップショット(後でマスターが変わっても、この注文の内容を再現できる)
        lines,
        lineCount: lines.length,
        totalQuantity: input.totalQuantity,
        firstSurgeryDate: lines.map(l => l.surgeryDate).sort()[0],
        lastSurgeryDate: lines.map(l => l.surgeryDate).sort().slice(-1)[0],
        orderer: { id: input.ordererId, name: orderer.get("name"), email: typeof email === "string" && email ? email : null },
        notes: input.notes,
        // 操作したログインユーザー(注文者とは別の情報)
        createdBy: { uid: user.uid, email: user.email, displayName: user.displayName },
        createdAt: FieldValue.serverTimestamp(), acceptedAt: FieldValue.serverTimestamp(), statusUpdatedAt: FieldValue.serverTimestamp()
      });
      return { orderId, orderNumber, status: ORDER_STATUS.ACCEPTED, replayed: false, lineCount: lines.length, totalQuantity: input.totalQuantity };
    });
  }

  return { createOrder };
}
