/**
 * 注文の受付(第1段階): 検証して Firestore に保存するところまで。ディーラーへの通知は行わない(次段階)。
 *
 * 1回の注文は複数の明細(lines)を持てる。明細ごとにモデル・度数・型番・枚数・手術日をサーバーで検証し、
 * 明細にはディーラー振り分け用の dealerId(採用IOLの設定から取得。未設定は null)を保持する。
 * 従来の単一IOLの形式(modelId/power/... をトップレベルに置く)も受け付け、1明細の注文として扱う。
 *
 * 方針:
 * - 認証必須。所属・権限・施設の状態・採用IOL・注文者は、すべてサーバー側で Firestore から再確認する。
 * - クライアントが送るのは「何を選んだか」の識別子(modelId / doctorId / 度数 など)だけ。
 * - 担当医(各明細の doctorId)は施設のマスター(orderers コレクション。画面では「担当医」)から引き、IDと氏名を明細にスナップショットする。
 *   実際の発注者(ログインしたGoogleアカウント)は createdBy に、サーバーが認証情報から記録する(クライアントの申告は受け取らない)。
 *   レンズ名・メーカー・注文者名・メールなどは、サーバーがマスターから引いてスナップショットとして保存する。
 * - 冪等性: 注文ドキュメントIDを (操作ユーザー, requestId) から決め、トランザクション内で存在確認する。
 *   同じ内容の再送は既存の注文番号を返し、同じ requestId で内容が違う場合は拒否する。
 * - 注文番号はサーバーが日付ごとの連番で発行する(クライアントは指定できない)。
 * - 依存(db, FieldValue など)は注入する。テストはエミュレータ上の本物の Firestore で実行する。
 * - ディーラーへの注文メール・注文控えは、注文と同じトランザクションで「送信待ち」として保存するだけ(送信は order-mail-outbox.js)。
 *   宛先・件名・本文は注文時点の施設設定のスナップショット。送信に失敗しても注文は残る。
 */
import { createHash } from "node:crypto";
import { RegistrationError, assertVerifiedUser } from "./registration.js";
import { MEMBER_ROLES } from "./roles.js";
import { IOL_MODELS } from "./iol-catalog.js";
import { filterPowersByModel } from "./power-filter.js";
import { buildOrderOutbox } from "./order-mail-outbox.js";

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
const LINE_KEYS = ["modelId", "power", "toricModel", "quantity", "surgeryDate", "doctorId", "dealerId"];
// ordererId(トップレベル)は旧形式の互換: 明細に doctorId が無いとき、その担当医を全明細に使う。LINE_KEYS をトップレベルに置くのは従来の単一IOL形式
const ALLOWED_KEYS = ["facilityId", "requestId", "ordererId", "notes", "lines", "duplicateAcknowledged", ...LINE_KEYS];

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
function parseLine(raw, n, nowMs, defaultDoctorId) {
  const at = (m) => bad(`明細${n}: ${m}`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw at("入力内容を確認してください");
  for (const k of Object.keys(raw)) if (!LINE_KEYS.includes(k)) throw at("入力内容を確認してください");
  const { modelId, power, quantity, surgeryDate } = raw;
  const toricModel = raw.toricModel === undefined || raw.toricModel === null ? "" : raw.toricModel;
  const doctorId = raw.doctorId === undefined || raw.doctorId === null ? defaultDoctorId : raw.doctorId;
  // 発注先ディーラー(明細ごと): 施設の登録ディーラーが複数のときは必須(マスターとの突き合わせは resolveLineDealer)。
  // null は「発注先なしで確認した」の明示(画面は確認した発注先を必ず送る)。省略(undefined)は旧形式で、1社なら自動選択
  const dealerNone = raw.dealerId === null;
  const dealerId = raw.dealerId === undefined || raw.dealerId === null || raw.dealerId === "" ? "" : raw.dealerId;
  if (dealerId !== "" && (typeof dealerId !== "string" || !ID.test(dealerId))) throw at("発注先が正しくありません");

  if (typeof doctorId !== "string" || !ID.test(doctorId)) throw at("担当医を選択してください");
  if (typeof modelId !== "string" || !ID.test(modelId)) throw at("IOLモデルを選択してください");
  if (typeof power !== "string" || power.length < 1 || power.length > 10) throw at("IOLパワーを選択してください");
  if (typeof toricModel !== "string" || toricModel.length > 60) throw at("トーリック型番が正しくありません");
  if (!ORDER_LIMITS.quantities.includes(quantity)) throw at("枚数が正しくありません");
  if (!validDate(surgeryDate)) throw at("手術日が正しくありません");
  const today = jstDate(nowMs);
  const limit = jstDate(nowMs + ORDER_LIMITS.maxDaysAhead * 24 * 60 * 60 * 1000);
  if (surgeryDate < today) throw at("手術日は本日以降を指定してください");
  if (surgeryDate > limit) throw at("手術日が先すぎます");
  return { modelId, power, toricModel: toricModel.trim(), quantity, surgeryDate, doctorId, dealerId, dealerNone };
}

/** 入力の形式検証と正規化(マスターとの突き合わせは別)。従来の単一IOL形式は1明細に正規化する */
export function parseOrderInput(data, nowMs) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw bad();
  for (const k of Object.keys(data)) if (!ALLOWED_KEYS.includes(k)) throw bad();

  const { facilityId, requestId } = data;
  const legacyDoctorId = data.ordererId === undefined || data.ordererId === null ? undefined : data.ordererId;
  if (legacyDoctorId !== undefined && (typeof legacyDoctorId !== "string" || !ID.test(legacyDoctorId))) throw bad("担当医を選択してください");
  const notes = data.notes === undefined || data.notes === null ? "" : data.notes;

  if (typeof facilityId !== "string" || !ID.test(facilityId)) throw bad();
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw bad("注文の識別子が正しくありません");
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
  const lines = rawLines.map((l, i) => parseLine(l, i + 1, nowMs, legacyDoctorId));

  // 同じ注文の中の重複(同じ手術日・担当医・IOLモデル(トーリックの型番を含む)・度数。枚数・発注先は含めない)は、
  // 確認画面で「重複を確認しました」と了承した注文(duplicateAcknowledged: true)だけ受け付ける(画面 src/domain/order-lines.js と同じ条件)
  const ack = data.duplicateAcknowledged;
  if (ack !== undefined && typeof ack !== "boolean") throw bad();
  const seen = new Set();
  const hasDuplicates = lines.some(l => {
    const k = JSON.stringify([l.modelId, l.toricModel, l.power, l.surgeryDate, l.doctorId]);
    if (seen.has(k)) return true;
    seen.add(k);
    return false;
  });
  if (hasDuplicates && ack !== true) throw bad("同じ手術日・担当医・IOLモデル・度数のレンズが複数あります。確認画面で「重複を確認しました」にチェックしてから送信してください");
  const totalQuantity = lines.reduce((s, l) => s + l.quantity, 0);
  if (totalQuantity > ORDER_LIMITS.maxTotalQuantity) throw bad(`合計枚数は${ORDER_LIMITS.maxTotalQuantity}枚までです`);

  return { facilityId, requestId, notes: notes.trim(), lines, totalQuantity, duplicateAcknowledged: hasDuplicates };
}

/** 注文内容(識別子・選択値)の正規化ハッシュ。同じ requestId での内容変更の検出に使う(単一IOL形式でも明細1件の形式でも同じ値になる) */
export function contentHash(i) {
  return createHash("sha256")
    .update(JSON.stringify([i.facilityId, i.notes, i.lines.map(l => [l.modelId, l.power, l.toricModel, l.quantity, l.surgeryDate, l.doctorId, ...(l.dealerId ? [l.dealerId] : [])])]))
    .digest("hex");
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // 画面(src/domain/order-validation.js)・Rules と同じ判定(tests/dealer-selection.test.js で一致を確認)

/**
 * 明細の発注先ディーラーを決める(施設の登録ディーラーだけが対象。採用IOLの dealerId には依存しない)。
 *  - 0社: 発注先なし(null)。指定があればエラー
 *  - 1社: そのディーラーを自動選択(指定がある場合は、その1社と一致すること)
 *  - 2社以上: 明細ごとに指定が必須。勝手に決めない。登録にないIDはエラー
 * 画面(src/domain/dealer-selection.js)と同じ規則(tests/dealer-selection.test.js で一致を確認)。
 * @param {Array<{id:string, name?:string, orderEmails?:string[]}>} dealers 施設の登録ディーラー
 * @returns {{ok:true, dealer:object|null}|{ok:false, error:"not-found"|"select"}}
 */
export function resolveLineDealer(dealers, requestedId) {
  const want = requestedId || "";
  if (dealers.length === 0) return want ? { ok: false, error: "not-found" } : { ok: true, dealer: null };
  if (dealers.length === 1) return want && want !== dealers[0].id ? { ok: false, error: "not-found" } : { ok: true, dealer: dealers[0] };
  if (!want) return { ok: false, error: "select" };
  const d = dealers.find(x => x.id === want);
  return d ? { ok: true, dealer: d } : { ok: false, error: "not-found" };
}

/** 実メール送信の可否。発注用メールが有効な形式で1件以上ある場合だけ送れる。ディーラーなしは送信不可 */
export function dealerDispatch(dealer) {
  if (!dealer) return { allowed: false, reason: "dealer-unset" };
  const emails = Array.isArray(dealer.orderEmails) ? dealer.orderEmails : [];
  return emails.some(e => typeof e === "string" && EMAIL.test(e.trim()))
    ? { allowed: true, reason: null } : { allowed: false, reason: "no-order-email" };
}

/**
 * 保存済みの注文を明細の配列として読む。新旧の形式をそろえて返す:
 *  - 現行(schemaVersion 3): 各明細に doctor(担当医のスナップショット)がある
 *  - 旧(schemaVersion 2): 明細に doctor が無く、注文全体の orderer(注文者) → その担当医として扱う
 *  - 旧(schemaVersion 1): トップレベルの item / surgeryDate / orderer
 * 実際の発注者は、どの形式でも order.createdBy(uid / email / displayName)。
 */
export function orderLinesOf(order) {
  const fallback = order.orderer || null;
  if (Array.isArray(order.lines)) return order.lines.map(l => ({ ...l, doctor: l.doctor ?? fallback }));
  if (order.item) return [{ lineNo: 1, status: order.status, item: order.item, surgeryDate: order.surgeryDate, dealerId: null, doctor: fallback }];
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
 * @param {() => {unrestricted?:boolean, facilityIds?:string[], uids?:string[], testMode?:boolean}} [deps.getPolicy]
 *   受付の対象の制限。既定は制限なし。`unrestricted` でない場合は、許可リストに載った施設とユーザー
 *   (ログイン済み・メール確認済み)だけが注文できる(リストが空なら全員拒否)。`testMode` が false でない限り「開発用受付」で、
 *   保存される注文には testOrder: true が付く(メールはテスト用の宛先だけ)。testMode: false は、許可リストのまま本番の注文として保存する。
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
    const orderId = deriveOrderId(user.uid, input.requestId);
    const orderRef = db.doc(`facilities/${input.facilityId}/orders/${orderId}`);
    const hash = contentHash(input);
    const day = jstDate(now()).replace(/-/g, "");
    const counterRef = db.doc(`facilities/${input.facilityId}/orderCounters/${day}`);

    return db.runTransaction(async (tx) => {
      const mailSettingsRef = db.doc(`facilities/${input.facilityId}/settings/mail`);   // 注文控え・署名(施設設定)
      const [fac, mem, existing, counter, mailSettingsSnap] = await Promise.all(
        [fRef, mRef, orderRef, counterRef, mailSettingsRef].map(r => tx.get(r)));
      // 担当医: この施設のマスター(orderers)にいる人だけ。明細ごとに異なってよい
      const doctorIds = [...new Set(input.lines.map(l => l.doctorId))];
      const doctorSnaps = await Promise.all(doctorIds.map(id => tx.get(db.doc(`facilities/${input.facilityId}/orderers/${id}`))));
      const doctorBy = new Map(doctorIds.map((id, i) => [id, doctorSnaps[i]]));
      const modelIds = [...new Set(input.lines.map(l => l.modelId))];
      const adoptedSnaps = await Promise.all(modelIds.map(id => tx.get(db.doc(`facilities/${input.facilityId}/adoptedIols/${id}`))));
      const adoptedBy = new Map(modelIds.map((id, i) => [id, adoptedSnaps[i]]));
      // 発注先ディーラー: この施設の登録ディーラー(facilityDealers)から決める。採用IOLの dealerId には依存しない
      const dealerDocs = (await tx.get(db.collection(`facilities/${input.facilityId}/facilityDealers`))).docs
        .map(d => ({ id: d.id, name: d.get("name") || "", orderEmails: d.get("orderEmails"), mailName: d.get("mailName") || "" }));

      // 所属・権限はサーバーで再確認する(無効化された人・他施設・所属なしは区別なく拒否)
      const allowed = fac.exists && fac.get("status") === "active"
        && mem.exists && MEMBER_ROLES.includes(mem.get("role")); // 所属があれば有効(削除された所属は存在しない)。4つの役割はすべて注文できる
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
        const doc = doctorBy.get(l.doctorId);
        if (!doc.exists) throw bad(`明細${n}: 担当医が見つかりません`); // 担当医に有効/無効はない(旧形式の active フィールドは無視する)
        const docEmail = doc.get("email");
        // 確認後にディーラー設定が変わった場合(確認した発注先の削除・発注先なしで確認後の追加)は、別のディーラーに切り替えず拒否する
        const CHANGED = "発注先の設定が変更された可能性があります。画面を開き直して、発注先を確認してください";
        if (l.dealerNone && dealerDocs.length > 0) throw bad(`明細${n}: ${CHANGED}`);
        const picked = resolveLineDealer(dealerDocs, l.dealerId);
        if (!picked.ok) throw bad(picked.error === "select" ? `明細${n}: 発注先を選択してください` : `明細${n}: 発注先が見つかりません(${CHANGED})`);
        const dealer = picked.dealer ? { id: picked.dealer.id, name: picked.dealer.name } : null; // その時点のディーラー名を保存(後で削除・改名されても過去の注文は変わらない)
        // 将来の実メール送信の可否(現在は送信機能なし)。発注先なし・発注用メール未登録は送信不可。使用報告用メールは使わない。メールアドレス自体は保存しない
        const dispatch = dealerDispatch(picked.dealer);
        return {
          lineNo: n,
          status: ORDER_STATUS.ACCEPTED,
          item: {
            modelId: model.id, manufacturer: model.manufacturer, model: model.model, displayName: model.displayName,
            isToric: model.isToric, isMultifocal: model.isMultifocal, toricModel: model.isToric ? l.toricModel : "",
            power: l.power, quantity: l.quantity
          },
          surgeryDate: l.surgeryDate,
          doctor: { id: doc.id, name: doc.get("name"), email: typeof docEmail === "string" && docEmail ? docEmail : null }, // 担当医のスナップショット
          dealerId: dealer ? dealer.id : null, // 将来、ディーラーごとに明細を振り分けるための情報
          dealer,                             // ディーラーのスナップショット(未設定・削除済みは null)
          dispatch                            // 実メール送信の可否。allowed=false の明細は、将来も送信してはいけない
        };
      });
      const seq = (counter.exists ? counter.get("count") || 0 : 0) + 1;
      const orderNumber = `IOL-${day}-${String(seq).padStart(2, "0")}`;   // 連番は最低2桁(100件目以降は3桁以上)。保存済みの注文番号(旧4桁)は変えない

      tx.set(counterRef, { count: seq, updatedAt: FieldValue.serverTimestamp() });
      const orderDoc = {
        schemaVersion: 3,
        orderId, orderNumber, requestId: input.requestId, contentHash: hash,
        facilityId: input.facilityId, facilityName: fac.get("name") || "",
        status: ORDER_STATUS.ACCEPTED,
        testOrder: restricted && policy.testMode !== false, // 開発用受付で保存された注文(本番の注文と区別・後から削除を判断するための印)
        ...(input.duplicateAcknowledged ? { duplicateAcknowledged: true } : {}), // 同じ注文の中の重複を、確認画面で了承して注文した
        // マスターのスナップショット(後でマスターが変わっても、この注文の内容を再現できる)
        lines,
        lineCount: lines.length,
        dispatchAllowed: lines.every(l => l.dispatch.allowed), // 1つでも送れない明細(発注先未設定など)があれば false
        totalQuantity: input.totalQuantity,
        firstSurgeryDate: lines.map(l => l.surgeryDate).sort()[0],
        lastSurgeryDate: lines.map(l => l.surgeryDate).sort().slice(-1)[0],
        doctorIds,   // この注文に含まれる担当医(明細ごとの詳細は lines[].doctor)
        notes: input.notes,
        // 実際に発注したログインユーザー(担当医とは別の情報。サーバーが認証情報から記録し、クライアントの申告は受け取らない)
        // role: 注文時点の入力者の役割(admin/subadmin/orderer/proxy)。代行入力者の注文を区別する(担当医は lines[].doctor)
        createdBy: { uid: user.uid, email: user.email, displayName: user.displayName, role: mem.get("role") },
        createdAt: FieldValue.serverTimestamp(), acceptedAt: FieldValue.serverTimestamp(), statusUpdatedAt: FieldValue.serverTimestamp()
      };
      // 送るメール(送信待ち)と、発注先ごとの状態の要約(notifications。アドレス・本文は含めない)
      const outbox = buildOrderOutbox({ facilityId: input.facilityId, orderId, order: orderDoc, dealers: dealerDocs, mailSettings: mailSettingsSnap.exists ? mailSettingsSnap.data() : null });
      tx.create(orderRef, { ...orderDoc, notifications: outbox.notifications });
      for (const m of outbox.mails) tx.create(orderRef.collection("mails").doc(m.id), { ...m.data, createdAt: FieldValue.serverTimestamp(), statusAt: FieldValue.serverTimestamp() });
      return { orderId, orderNumber, status: ORDER_STATUS.ACCEPTED, replayed: false, lineCount: lines.length, totalQuantity: input.totalQuantity };
    });
  }

  return { createOrder };
}
