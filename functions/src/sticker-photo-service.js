/**
 * IOL シール写真(R09。docs/iol-sticker-photo-design.md §8)のサーバーの処理。純粋な判定は sticker-photo.js。
 * 注文の受付・メール・受注一覧の処理からは呼ばない。Firestore・バケット・認証は注入する(テストは Firestore エミュレータと偽のバケット)。
 *
 * 方針:
 * - 施設はチケット(署名済み)か、ログインした本人の所属で決める。クライアントが送る施設 ID だけで読み書きしない。
 * - 入口の確認は、確認の前に回数を確保する(同時に送っても制限を超えない)。失敗の応答はトークンの有無・状態で変えない。
 * - オブジェクト名は送信の試行ごとに固有。記録を作れなかった試行は自分のオブジェクトだけを消す(保存済みの写真を消さない)。
 * - ディーラーの閲覧は stickerPhotoGrants だけで判定する。受注閲覧の許可(dealerPortalGrants・関連付けの status・currentGrantId)は読まない。
 * - 画像は毎回権限を確かめて返し、キャッシュさせない。見えないものはすべて同じ 404。
 */
import { RegistrationError, assertVerifiedUser } from "./registration.js";
import { MEMBER_ROLES, isManagerRole } from "./roles.js";
import { dealerFingerprintOf } from "./dealer-portal.js";
import {
  STICKER_LIMITS, STICKER_RATE_LIMITS, STICKER_ENTRY_URL,
  isAccessCode, isEntryToken, isFacilityId, isSha256Hex, isUploadId, isLastSurgeryDate, parseBlurWarned,
  newEntryToken, newAttemptId, buildEntryUrl, sha256Hex, usageDayKey,
  hashAccessCode, verifyAccessCode, issueTicket, verifyTicket,
  photoIdOf, photoObjectPaths, parseObjectName, isPhotoOfFacility, decideExistingPhoto, checkUploadLimits, planPhotoRegistration,
  rateLimitDocId, isRateLimited, recordRateLimitFailure, refundRateLimitAttempt, sanitizeJpeg
} from "./sticker-photo.js";

export const STICKER_ORIGIN = "https://iol.medconf.jp";
export const LIMIT_MESSAGE = "送信の上限に達しました。時間をおいてお試しください";
const VERIFY_FAILED = "アクセスコードを確認してください";
const VERIFY_BLOCKED = "しばらくしてからお試しください";
const NOT_ALLOWED = "この施設の写真を操作する権限がありません";
const NO_FACILITY = "sticker-none";          // 入口が無効なときも同じ読み取りをするための、存在しない施設
const PLACEHOLDER_CODE = "000000";           // 形式の違うコードでも同じ計算をするための値(結果は使わない)
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;   // これより古い孤立ファイルを片付ける(送信中のものを消さない)
const TX_ATTEMPTS = 20;                      // 同じ文書への同時の送信で、トランザクションが競合しても諦めない回数
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const JST_OFFSET = "+09:00";
const DAY_MS = 24 * 60 * 60 * 1000;

const bad = (message = "入力内容を確認してください") => new RegistrationError("invalid-argument", message);
const denied = (message = NOT_ALLOWED) => new RegistrationError("permission-denied", message);
const unavailable = () => new RegistrationError("failed-precondition", "IOLシール写真は現在ご利用いただけません");

function strict(data, allowed) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw bad();
  for (const k of Object.keys(data)) if (!allowed.includes(k)) throw bad();
}

const millisOf = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : null);
const isoOf = (v) => { const ms = millisOf(v); return ms === null ? null : new Date(ms).toISOString(); };

/** YYYY-MM-DD(日本時間)の範囲をミリ秒に。to はその日の終わりの次の瞬間。形式違いは拒否する */
function dateRange(from, to) {
  const start = (d) => {
    if (typeof d !== "string" || !DATE.test(d)) throw bad();
    const ms = Date.parse(`${d}T00:00:00${JST_OFFSET}`);
    if (Number.isNaN(ms)) throw bad();
    return ms;
  };
  const fromMs = from === undefined || from === null ? null : start(from);
  const toMs = to === undefined || to === null ? null : start(to) + DAY_MS;
  return { fromMs, toMs };
}

/** 送信元の IP(Cloud Run が末尾に付けた値。先頭はクライアントが自由に書けるので使わない) */
export function clientIpOf(req) {
  const list = String(req?.headers?.["x-forwarded-for"] ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return list.length ? list[list.length - 1] : String(req?.ip ?? "unknown");
}

/** 一覧で返す項目(列挙。storagePath・uploadId・sha256 は返さない) */
const photoView = (id, d) => ({
  photoId: id, sessionId: d.sessionId, seq: d.seq, takenAt: isoOf(d.takenAt), lastSurgeryDate: d.lastSurgeryDate ?? null,
  width: d.width, height: d.height, blurWarned: d.blurWarned === true
});

/** サムネイル(長辺 400px)。sharp は使うときに読む(全関数の起動に影響させない)。メタデータは出力に含まれない */
export async function createThumbnail(bytes) {
  const { default: sharp } = await import("sharp");
  return sharp(bytes).resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
}

/** QR の SVG(「サイトを共有」と同じ設定)。qrcode は使うときに読む */
export async function createQrSvg(url) {
  const { default: QRCode } = await import("qrcode");
  return QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 4 });
}

/**
 * @param {object} deps
 * @param {FirebaseFirestore.Firestore} deps.db
 * @param {object} deps.FieldValue
 * @param {object} deps.Timestamp
 * @param {{save:Function, read:Function, delete:Function, list:Function}} deps.bucket sticker-bucket.js の部品
 * @param {() => boolean} deps.isEnabled 機能スイッチ(STICKER_PHOTO_ENABLED)
 * @param {() => string[]} deps.facilityIds 有効にする施設(STICKER_PHOTO_FACILITY_IDS)
 * @param {() => string} [deps.ticketSecret] チケットの鍵(確認と保存の関数だけが持つ)
 * @param {(auth:object, companyId:string|null, deviceToken:string|null) => Promise<{companyId:string}>} [deps.authorizeDealer] ディーラーの担当者の確認
 * @param {(token:string) => Promise<object>} [deps.verifyIdToken] 画像の取得の ID トークンの確認
 * @param {(origin:string) => boolean} [deps.isAllowedOrigin]
 * @param {() => number} [deps.now]
 */
export function createStickerPhotoService({
  db, FieldValue, Timestamp, bucket, isEnabled = () => false, facilityIds = () => [], ticketSecret = () => "",
  authorizeDealer = null, verifyIdToken = null, isAllowedOrigin = (o) => o === STICKER_ORIGIN, now = Date.now,
  limits = STICKER_LIMITS, rateLimits = STICKER_RATE_LIMITS, makeThumbnail = createThumbnail, makeQrSvg = createQrSvg,
  checkCode = verifyAccessCode, entryUrl = STICKER_ENTRY_URL
}) {
  const facilityOn = (fid) => isEnabled() && facilityIds().includes(fid);
  const facilityRef = (fid) => db.doc(`facilities/${fid}`);
  const accessRef = (fid) => db.doc(`facilities/${fid}/stickerSettings/access`);
  const entrySettingRef = (fid) => db.doc(`facilities/${fid}/stickerSettings/entry`);
  const entryRef = (token) => db.doc(`stickerEntries/${token}`);
  const photoRef = (fid, id) => db.doc(`facilities/${fid}/stickerPhotos/${id}`);
  const grantRef = (fid, lid) => db.doc(`stickerPhotoGrants/${fid}_${lid}`);
  const audit = (tx, entry) => tx.create(db.collection("stickerAuditLogs").doc(), { ...entry, at: FieldValue.serverTimestamp() });

  /* ======================= 入口の確認(ログインなし) ======================= */

  // トークンが無効なときも同じ計算をするための記録(コードは誰にも使われない乱数ではなく固定で、結果は捨てる)
  let placeholderRecord = null;
  const placeholder = async () => (placeholderRecord ??= await hashAccessCode(PLACEHOLDER_CODE));

  /** 入口トークンごとの回数制限の記録(短い窓と、24 時間の窓)。ID はトークンのハッシュ */
  const dayLimits = { windowMs: rateLimits.dayWindowMs, blockMs: rateLimits.dayBlockMs };
  const tokenLimitKeys = (token) => [
    { id: rateLimitDocId("token", token), max: rateLimits.tokenMax, scope: "token" },
    { id: rateLimitDocId("tokenDay", token), max: rateLimits.tokenDayMax, scope: "tokenDay", limits: dayLimits }
  ];
  const limitRef = (id) => db.doc(`stickerRateLimits/${id}`);

  /**
   * 確認の前に回数を確保する。同時に送っても上限を超えて確認できない。上限を超えた回は確認しない。
   * @returns {Promise<Array<{ref:object}>>} 成功のときに返す確保
   */
  async function reserveAttempts(keys, ipHash) {
    const refs = keys.map(k => ({ ...k, ref: db.doc(`stickerRateLimits/${k.id}`) }));
    const blocked = await db.runTransaction(async (tx) => {
      const snaps = await Promise.all(refs.map(r => tx.get(r.ref)));
      const t = now();
      if (snaps.some(s => s.exists && isRateLimited(s.data(), t))) return true;
      const next = snaps.map((s, i) => recordRateLimitFailure(s.exists ? s.data() : null, refs[i].max, t, refs[i].limits ?? rateLimits));
      next.forEach((state, i) => tx.set(refs[i].ref, { ...state, scope: refs[i].scope }));
      // 日の窓が終わっていたら、その窓の失敗の数を監査に残してから数え直す(コード・トークンの平文は残さない)
      snaps.forEach((s, i) => {
        if (refs[i].scope === "tokenDay" && s.exists && (s.get("count") ?? 0) > 0 && s.get("windowStart") !== next[i].windowStart) {
          audit(tx, { action: "verify.daySummary", tokenHash: refs[i].id, failures: s.get("count"), windowStart: s.get("windowStart") });
        }
      });
      const scopes = refs.filter((_, i) => isRateLimited(next[i], t)).map(r => r.scope);
      if (scopes.length) {
        const day = refs.findIndex(r => r.scope === "tokenDay");
        audit(tx, { action: "verify.blocked", ipHash, scopes, ...(day >= 0 ? { tokenHash: refs[day].id, dayFailures: next[day].count } : {}) });
      }
      return scopes.length > 0;
    }, { maxAttempts: TX_ATTEMPTS });
    if (blocked) throw new RegistrationError("resource-exhausted", VERIFY_BLOCKED);
    return refs;
  }

  /** 確認に成功した回を返す(通常の利用で回数が積み上がらないように) */
  const refundAttempts = (refs) => db.runTransaction(async (tx) => {
    const snaps = await Promise.all(refs.map(r => tx.get(r.ref)));
    snaps.forEach((s, i) => { if (s.exists) tx.set(refs[i].ref, refundRateLimitAttempt(s.data())); });
  }, { maxAttempts: TX_ATTEMPTS });

  /** 保存が完了した最新の写真の送信日時と、その写真のセッションの最終手術日 */
  async function lastSent(fid) {
    const q = await db.collection(`facilities/${fid}/stickerPhotos`).where("status", "==", "stored").orderBy("takenAt", "desc").limit(1).get();
    if (q.empty) return { lastSentAt: null, lastSurgeryDate: null };
    return { lastSentAt: isoOf(q.docs[0].get("takenAt")), lastSurgeryDate: q.docs[0].get("lastSurgeryDate") ?? null };
  }

  /** verify { token, code }。失敗の応答は、トークンの有無・無効化・コードの違い・機能の停止で変えない */
  async function verify({ data, ip }) {
    const d = data && typeof data === "object" && !Array.isArray(data) ? data : {};
    const tokenOk = isEntryToken(d.token);
    const codeOk = isAccessCode(d.code);
    const ipHash = rateLimitDocId("ip", ip || "unknown");
    const keys = [{ id: ipHash, max: rateLimits.ipMax, scope: "ip" }];
    if (tokenOk) keys.push(...tokenLimitKeys(d.token));
    const reserved = await reserveAttempts(keys, ipHash);

    const entry = tokenOk ? await entryRef(d.token).get() : null;
    const live = Boolean(entry && entry.exists && entry.get("status") === "active");
    const fid = live ? entry.get("facilityId") : NO_FACILITY;
    const [fac, access] = await Promise.all([facilityRef(fid).get(), accessRef(fid).get()]);
    const usable = live && facilityOn(fid) && fac.exists && fac.get("status") === "active" && access.exists;
    const matched = await checkCode(codeOk ? d.code : PLACEHOLDER_CODE, usable ? access.data() : await placeholder());
    if (!usable || !codeOk || !matched) throw new RegistrationError("permission-denied", VERIFY_FAILED);

    await refundAttempts(reserved);
    const issued = issueTicket({ facilityId: fid, codeGeneration: access.get("codeGeneration"), secret: ticketSecret(), now: now() });
    await db.runTransaction(async (tx) => { audit(tx, { action: "verify.success", facilityId: fid, sessionId: issued.sessionId, ipHash }); });
    return { ticket: issued.ticket, expiresAt: issued.expiresAt, facilityName: String(fac.get("name") || ""), ...(await lastSent(fid)) };
  }

  /* ======================= HTTP の共通処理 ======================= */

  /** CORS。許可しないオリジンは false(本文を処理しない)。OPTIONS は応答まで行う */
  function cors(req, res, methods, headers) {
    const origin = req.get("origin");
    res.set("Vary", "Origin");
    if (origin) {
      if (!isAllowedOrigin(origin)) { res.status(403).json({ error: "origin" }); return false; }
      res.set("Access-Control-Allow-Origin", origin);
    }
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", methods);
      res.set("Access-Control-Allow-Headers", headers);
      res.set("Access-Control-Max-Age", "3600");
      res.status(204).send("");
      return false;
    }
    return true;
  }

  const fail = (res, status, error, message) => res.status(status).json({ error, ...(message ? { message } : {}) });
  const uploadView = (id, d, created) => ({ photoId: id, created, seq: d.seq, takenAt: isoOf(d.takenAt), lastSurgeryDate: d.lastSurgeryDate ?? null });

  /** 残さないオブジェクトを消す。失敗しても応答は変えない(記録がないので stickerPhotoCleanup が片付ける) */
  async function discard(...paths) {
    await Promise.all(paths.filter(Boolean).map(p => bucket.delete(p).catch(e => console.error("sticker object delete failed:", e))));
  }

  /* ======================= 写真の保存(送信チケット) ======================= */

  /** サムネイルを作って記録に付ける。失敗しても写真の保存は成功のまま。作る間に削除された写真には付けない */
  async function attachThumbnail(fid, id, bytes, thumbPath) {
    try {
      await bucket.save(thumbPath, await makeThumbnail(bytes));
      const attached = await db.runTransaction(async (tx) => {
        const p = await tx.get(photoRef(fid, id));
        if (!p.exists || p.get("status") !== "stored") return false;
        tx.update(p.ref, { thumbPath });
        return true;
      }, { maxAttempts: TX_ATTEMPTS });
      if (!attached) await discard(thumbPath);
    } catch (e) {
      console.error("sticker thumbnail failed:", e);
      await discard(thumbPath);
    }
  }

  async function handleUpload(req, res) {
    if (!cors(req, res, "PUT, OPTIONS", "Content-Type, X-Sticker-Ticket, X-Upload-Id, X-Content-Sha256, X-Last-Surgery-Date, X-Blur-Warned")) return;
    if (req.method !== "PUT") return fail(res, 405, "method");
    if (!isEnabled()) return fail(res, 503, "disabled");
    try {
      // (a) チケット。施設とセッションはチケットから取り、クライアントの申告は使わない
      const t = now();
      const ticket = await verifyTicket(req.get("x-sticker-ticket"), ticketSecret(), {
        now: t, currentGeneration: async (fid) => { const a = await accessRef(fid).get(); return a.exists ? a.get("codeGeneration") : null; }
      });
      if (!ticket.ok) return fail(res, 401, "ticket");
      const { facilityId: fid, sessionId } = ticket;
      const fac = await facilityRef(fid).get();
      if (!facilityOn(fid) || !fac.exists || fac.get("status") !== "active") return fail(res, 403, "facility");

      const declared = Number(req.get("content-length"));
      if (!Number.isInteger(declared) || declared <= 0 || declared > limits.imageBytes) return fail(res, 413, "too_large");
      const uploadId = req.get("x-upload-id");
      const sha256 = req.get("x-content-sha256");
      if (!isUploadId(uploadId) || !isSha256Hex(sha256)) return fail(res, 400, "headers");
      const date = req.get("x-last-surgery-date");
      if (date !== undefined && date !== "" && !isLastSurgeryDate(date, t)) return fail(res, 400, "surgery_date");
      const body = req.rawBody;
      if (!Buffer.isBuffer(body) || body.length !== declared) return fail(res, 400, "length");
      if (sha256Hex(body) !== sha256) return fail(res, 400, "sha256");
      const image = sanitizeJpeg(body);
      if (!image.ok) return fail(res, 415, "image");

      const id = photoIdOf(fid, uploadId);
      const ref = photoRef(fid, id);
      // (b) 記録があれば保存しない(再送・削除済み。削除済みは復元しない)
      const before = await ref.get();
      const known = decideExistingPhoto(before.exists ? before.data() : null, { facilityId: fid, sha256 });
      if (known?.action === "conflict") return fail(res, 409, "conflict");
      if (known) return res.status(200).json(uploadView(id, before.data(), false));

      // (c) 無駄な保存を減らすための事前の確認(判定はトランザクションで行う)
      const sessionRef = db.doc(`facilities/${fid}/stickerSessions/${sessionId}`);
      const usageRef = db.doc(`facilities/${fid}/stickerUsage/${usageDayKey(t)}`);
      const [s0, u0] = await Promise.all([sessionRef.get(), usageRef.get()]);
      if (!checkUploadLimits({ session: s0.exists ? s0.data() : null, usage: u0.exists ? u0.data() : null, bytes: image.bytes.length }, limits).ok) {
        return fail(res, 429, "limit", LIMIT_MESSAGE);
      }

      // (d) この試行だけの名前で保存する
      const { storagePath, thumbPath } = photoObjectPaths(fid, id, newAttemptId());
      await bucket.save(storagePath, image.bytes);

      // (e) 記録の登録。同じ写真の同時の送信でも1件だけ。負けた試行は自分のオブジェクトだけを消す
      const result = await db.runTransaction(async (tx) => {
        const [p, s, u] = await Promise.all([tx.get(ref), tx.get(sessionRef), tx.get(usageRef)]);
        const plan = planPhotoRegistration({
          existing: p.exists ? p.data() : null, session: s.exists ? s.data() : null, usage: u.exists ? u.data() : null,
          facilityId: fid, sha256, bytes: image.bytes.length, lastSurgeryDate: date || null
        }, limits);
        if (plan.action !== "create") return { plan, record: p.exists ? p.data() : null };
        const record = {
          facilityId: fid, uploadId, sessionId, seq: plan.seq, status: "stored", takenAt: Timestamp.fromMillis(now()), lastSurgeryDate: plan.lastSurgeryDate,
          width: image.width, height: image.height, bytes: image.bytes.length, sha256, blurWarned: parseBlurWarned(req.get("x-blur-warned")),
          storagePath, thumbPath: null, createdAt: FieldValue.serverTimestamp()
        };
        tx.create(ref, record);
        tx.set(sessionRef, { ...plan.session, ...(s.exists ? {} : { createdAt: FieldValue.serverTimestamp() }) }, { merge: true });
        tx.set(usageRef, plan.usage, { merge: true });
        return { plan, record };
      }, { maxAttempts: TX_ATTEMPTS });

      if (result.plan.discardObject) await discard(storagePath);
      if (result.plan.action === "conflict") return fail(res, 409, "conflict");
      if (result.plan.action === "limit") return fail(res, 429, "limit", LIMIT_MESSAGE);
      if (result.plan.action === "existing") return res.status(200).json(uploadView(id, result.record, false));

      // (f) サムネイル
      await attachThumbnail(fid, id, image.bytes, thumbPath);
      return res.status(200).json(uploadView(id, result.record, true));
    } catch (e) {
      console.error("sticker upload failed:", e);
      return fail(res, 503, "unavailable");
    }
  }

  /* ======================= 権限 ======================= */

  /** 施設の所属を確かめる(tx を渡すとトランザクションで読む)。運営者も所属がなければ通さない */
  async function assertMember(tx, uid, fid, { manager = false } = {}) {
    if (!isFacilityId(fid) || !ID.test(fid) || !facilityOn(fid)) throw denied();
    const get = (ref) => (tx ? tx.get(ref) : ref.get());
    const [m, f] = await Promise.all([get(db.doc(`facilities/${fid}/members/${uid}`)), get(facilityRef(fid))]);
    const role = m.exists ? m.get("role") : null;
    if (!MEMBER_ROLES.includes(role) || !f.exists || f.get("status") !== "active") throw denied();
    if (manager && !isManagerRole(role)) throw denied("この施設の管理者・副管理者のみ操作できます");
    return { role, facility: f };
  }

  /** 許可の記録が、その施設・発注先のものか(記録の ID だけに頼らず、中の施設 ID・発注先 ID も確かめる) */
  const grantOf = (grant, fid, lid) => grant.exists && grant.id === `${fid}_${lid}` && grant.get("facilityId") === fid && grant.get("localDealerId") === lid;

  /** 許可が今も有効か。受注閲覧の許可・関連付けの status は見ない。関連付けの会社と発注先の同一性だけを確かめる */
  function grantValid(grant, link, dealer, fid, lid) {
    return grantOf(grant, fid, lid) && grant.get("status") === "active" && link.exists && link.get("companyId") === grant.get("companyId")
      && dealer.exists && typeof grant.get("dealerFingerprint") === "string" && grant.get("dealerFingerprint") === dealerFingerprintOf(dealer);
  }

  /**
   * 会社が写真を閲覧できる施設(stickerPhotoGrants だけで判定)。同じ施設に複数の発注先の許可があれば、最も早い許可の時点から見える
   * @returns {Promise<Map<string, {facilityId:string, facilityName:string, effectiveFromMs:number}>>}
   */
  async function dealerScope(companyId) {
    const grants = await db.collection("stickerPhotoGrants").where("companyId", "==", companyId).where("status", "==", "active").get();
    const out = new Map();
    await Promise.all(grants.docs.map(async (g) => {
      const fid = g.get("facilityId"), lid = g.get("localDealerId");
      if (!isFacilityId(fid) || !ID.test(String(lid)) || !facilityOn(fid)) return;
      const [link, dealer, fac] = await Promise.all([
        db.doc(`facilities/${fid}/dealerPortalLinks/${lid}`).get(), db.doc(`facilities/${fid}/facilityDealers/${lid}`).get(), facilityRef(fid).get()
      ]);
      const from = millisOf(g.get("effectiveFrom"));
      if (from === null || !grantValid(g, link, dealer, fid, lid) || !fac.exists || fac.get("status") !== "active") return;
      const prev = out.get(fid);
      out.set(fid, { facilityId: fid, facilityName: String(fac.get("name") || ""), effectiveFromMs: prev ? Math.min(prev.effectiveFromMs, from) : from });
    }));
    return out;
  }

  /* ======================= 一覧 ======================= */

  /** 写真の一覧(takenAt の降順)。施設のパスの下だけを読む。fromMs より前は返さない */
  async function queryPhotos(fid, { fromMs, toMs, cursor }) {
    const page = limits.listPageSize;
    let q = db.collection(`facilities/${fid}/stickerPhotos`).where("status", "==", "stored");
    if (fromMs !== null) q = q.where("takenAt", ">=", Timestamp.fromMillis(fromMs));
    if (toMs !== null) q = q.where("takenAt", "<", Timestamp.fromMillis(toMs));
    q = q.orderBy("takenAt", "desc");
    if (cursor !== undefined && cursor !== null) {
      if (!isSha256Hex(cursor)) throw bad();
      const c = await photoRef(fid, cursor).get();
      if (!c.exists) throw bad();
      q = q.startAfter(c);
    }
    const snap = await q.limit(page + 1).get();
    const docs = snap.docs.slice(0, page);
    return { photos: docs.map(d => photoView(d.id, d.data())), nextCursor: snap.docs.length > page ? docs[docs.length - 1].id : null };
  }

  async function list(auth, data) {
    strict(data, ["facilityId", "from", "to", "cursor"]);
    await assertMember(null, auth.uid, data.facilityId);
    return queryPhotos(data.facilityId, { ...dateRange(data.from, data.to), cursor: data.cursor });
  }

  /** ディーラーの一覧。facilityId がなければ、閲覧できる施設だけを返す */
  async function dealerList(auth, data) {
    strict(data, ["companyId", "deviceToken", "facilityId", "from", "to", "cursor"]);
    if (!authorizeDealer) throw unavailable();
    const a = await authorizeDealer(auth, data.companyId ?? null, typeof data.deviceToken === "string" ? data.deviceToken : null);
    const scope = await dealerScope(a.companyId);
    const facilities = [...scope.values()].map(s => ({ facilityId: s.facilityId, name: s.facilityName })).sort((x, y) => x.name.localeCompare(y.name, "ja"));
    if (data.facilityId === undefined) return { facilities, photos: [], nextCursor: null };
    const s = scope.get(data.facilityId);
    if (!s) throw denied();
    const { fromMs, toMs } = dateRange(data.from, data.to);
    return { facilities, ...(await queryPhotos(s.facilityId, { fromMs: Math.max(fromMs ?? 0, s.effectiveFromMs), toMs, cursor: data.cursor })) };
  }

  /* ======================= 削除 ======================= */

  /** 写真の削除(管理者・副管理者)。記録を先に deleted にするので、同時の再送で復活しない。画像の削除に失敗しても片付けが消す */
  async function deletePhoto(user, data) {
    strict(data, ["facilityId", "photoId"]);
    if (!isSha256Hex(data.photoId)) throw bad();
    const { facilityId: fid, photoId: id } = data;
    const record = await db.runTransaction(async (tx) => {
      const { role } = await assertMember(tx, user.uid, fid, { manager: true });
      const p = await tx.get(photoRef(fid, id));
      if (!p.exists || !isPhotoOfFacility(p.data(), fid)) throw new RegistrationError("not-found", "写真が見つかりません");
      if (p.get("status") !== "deleted") {
        tx.update(p.ref, { status: "deleted", deleted: { at: FieldValue.serverTimestamp(), by: user.uid } });
        audit(tx, { action: "photo.delete", facilityId: fid, photoId: id, actorUid: user.uid, actorRole: role });
      }
      return p.data();
    }, { maxAttempts: TX_ATTEMPTS });
    await discard(record.storagePath, record.thumbPath);
    return { ok: true };
  }

  /* ======================= 設定(表示と QR の取得は所属者全員。変更は管理者・副管理者) ======================= */

  /** 設定の表示。注文者・代理入力者には、コードの状態と確認の停止の有無だけを返す(共有の状態・失敗の数は返さない) */

  async function getSettings(user, data) {
    strict(data, ["facilityId"]);
    const fid = data.facilityId;
    const { role } = await assertMember(null, user.uid, fid);
    const canManage = isManagerRole(role);
    const [access, entry] = await Promise.all([accessRef(fid).get(), entrySettingRef(fid).get()]);
    // コードの確認の停止(今の QR のトークンの記録だけを読む。トークンは返さない)
    const token = entry.exists ? entry.get("token") : null;
    const limitSnaps = isEntryToken(token) ? await Promise.all(tokenLimitKeys(token).map(k => limitRef(k.id).get())) : [];
    const t = now();
    const blockedUntil = Math.max(0, ...limitSnaps.map(l => (l.exists && isRateLimited(l.data(), t) ? l.get("blockedUntil") : 0)));
    const day = limitSnaps[1];
    const dayFailures = day?.exists && t - day.get("windowStart") < rateLimits.dayWindowMs ? day.get("count") ?? 0 : 0;
    const base = { accessCodeSet: access.exists, accessCodeUpdatedAt: access.exists ? isoOf(access.get("updatedAt")) : null, entryIssued: entry.exists,
      verifyBlockedUntil: blockedUntil ? new Date(blockedUntil).toISOString() : null, canManage };
    if (!canManage) return base;
    const [dealers, links] = await Promise.all([
      db.collection(`facilities/${fid}/facilityDealers`).get(), db.collection(`facilities/${fid}/dealerPortalLinks`).get()
    ]);
    const linkBy = new Map(links.docs.map(l => [l.id, l]));
    const rows = await Promise.all(dealers.docs.map(async (d) => {
      const link = linkBy.get(d.id);
      const companyId = link?.get("companyId");
      if (!isIdLike(companyId)) return { localDealerId: d.id, dealerName: String(d.get("name") || ""), linked: false, shared: false, stale: false };
      const [g, c] = await Promise.all([grantRef(fid, d.id).get(), db.doc(`dealerCompanies/${companyId}`).get()]);
      const active = grantOf(g, fid, d.id) && g.get("status") === "active";
      return {
        localDealerId: d.id, dealerName: String(d.get("name") || ""), linked: true, companyName: c.exists ? String(c.get("name") || "") : "",
        shared: active, stale: active && !grantValid(g, link, d, fid, d.id), sharedFrom: active ? isoOf(g.get("effectiveFrom")) : null
      };
    }));
    rows.sort((a, b) => a.dealerName.localeCompare(b.dealerName, "ja"));
    return { ...base, verifyFailures24h: dayFailures, dealers: rows };
  }
  const isIdLike = (v) => typeof v === "string" && ID.test(v);

  /** アクセスコードの設定・変更。世代が進むので、旧コードの確認と発行済みのチケットは以後拒否される。平文は保存・記録しない */
  async function setAccessCode(user, data) {
    strict(data, ["facilityId", "code"]);
    if (!isAccessCode(data.code)) throw bad("アクセスコードは半角数字6〜12桁で入力してください");
    const fid = data.facilityId;
    await assertMember(null, user.uid, fid, { manager: true });
    const hashed = await hashAccessCode(data.code);
    return db.runTransaction(async (tx) => {
      const { role } = await assertMember(tx, user.uid, fid, { manager: true });
      const a = await tx.get(accessRef(fid));
      const codeGeneration = (a.exists ? a.get("codeGeneration") || 0 : 0) + 1;
      // コードが変わると、それまでの試行は新しいコードの手がかりにならない。今の QR のトークンの回数制限(短い窓・24 時間)を消して、すぐに使えるようにする。
      // 送信元 IP の制限は消さない。失敗の数は監査に残す
      const setting = await tx.get(entrySettingRef(fid));
      const token = setting.exists ? setting.get("token") : null;
      const limitSnaps = isEntryToken(token) ? await Promise.all(tokenLimitKeys(token).map(k => tx.get(limitRef(k.id)))) : [];
      const t = now();
      const cleared = limitSnaps.filter(l => l.exists);
      tx.set(a.ref, { ...hashed, codeGeneration, updatedAt: FieldValue.serverTimestamp(), updatedBy: user.uid });
      cleared.forEach(l => tx.delete(l.ref));
      audit(tx, {
        action: "code.change", facilityId: fid, actorUid: user.uid, actorRole: role,
        ...(cleared.length ? { limitsCleared: true, wasBlocked: cleared.some(l => isRateLimited(l.data(), t)), clearedDayFailures: limitSnaps[1]?.exists ? limitSnaps[1].get("count") ?? 0 : 0 } : {})
      });
      return { ok: true };
    }, { maxAttempts: TX_ATTEMPTS });
  }

  const qrOf = async (token) => ({ svg: await makeQrSvg(buildEntryUrl(token, entryUrl)) });

  /** 入口の QR(なければ発行)。所属者全員が取得できる(表示・印刷のため。作り直しは管理者・副管理者だけ)。トークンは SVG の中の URL にだけ含める */
  async function getEntryQr(user, data) {
    strict(data, ["facilityId"]);
    const fid = data.facilityId;
    const token = await db.runTransaction(async (tx) => {
      await assertMember(tx, user.uid, fid);
      const setting = await tx.get(entrySettingRef(fid));
      const current = setting.exists ? setting.get("token") : null;
      const entry = isEntryToken(current) ? await tx.get(entryRef(current)) : null;
      if (entry?.exists && entry.get("status") === "active" && entry.get("facilityId") === fid) return current;
      const fresh = newEntryToken();
      tx.create(entryRef(fresh), { facilityId: fid, status: "active", createdAt: FieldValue.serverTimestamp() });
      tx.set(setting.ref, { token: fresh, updatedAt: FieldValue.serverTimestamp() });
      return fresh;
    }, { maxAttempts: TX_ATTEMPTS });
    return qrOf(token);
  }

  /** QR の作り直し。旧トークンは同じ処理で無効になり、以後の確認はすべて失敗する */
  async function rotateEntryQr(user, data) {
    strict(data, ["facilityId"]);
    const fid = data.facilityId;
    const token = await db.runTransaction(async (tx) => {
      const { role } = await assertMember(tx, user.uid, fid, { manager: true });
      const setting = await tx.get(entrySettingRef(fid));
      const current = setting.exists ? setting.get("token") : null;
      const entry = isEntryToken(current) ? await tx.get(entryRef(current)) : null;
      if (entry?.exists) tx.update(entry.ref, { status: "revoked", revokedAt: FieldValue.serverTimestamp() });
      const fresh = newEntryToken();
      tx.create(entryRef(fresh), { facilityId: fid, status: "active", createdAt: FieldValue.serverTimestamp() });
      tx.set(setting.ref, { token: fresh, updatedAt: FieldValue.serverTimestamp() });
      audit(tx, { action: "qr.rotate", facilityId: fid, actorUid: user.uid, actorRole: role });
      return fresh;
    }, { maxAttempts: TX_ATTEMPTS });
    return qrOf(token);
  }

  /**
   * ディーラーへの写真の共有(stickerPhotoGrants)。受注閲覧の許可とは独立で、関連付けの status・dealerPortalGrants を読み書きしない。
   * ON にできるのは、運営者が会社に関連付けた発注先だけ。再び ON にすると effectiveFrom を新しくする(取消の間の写真は見えない)
   */
  async function setDealerShare(user, data) {
    strict(data, ["facilityId", "localDealerId", "shared"]);
    const { facilityId: fid, localDealerId: lid, shared } = data;
    if (!isIdLike(lid) || typeof shared !== "boolean") throw bad();
    return db.runTransaction(async (tx) => {
      const { role } = await assertMember(tx, user.uid, fid, { manager: true });
      const ref = grantRef(fid, lid);
      const [g, link, dealer] = await Promise.all([tx.get(ref), tx.get(db.doc(`facilities/${fid}/dealerPortalLinks/${lid}`)), tx.get(db.doc(`facilities/${fid}/facilityDealers/${lid}`))]);
      const companyId = link.exists ? link.get("companyId") : null;
      // 別の施設・発注先の記録が同じ ID にあるときは、読み書きしない(取消も上書きもしない)
      if (g.exists && !grantOf(g, fid, lid)) throw new RegistrationError("failed-precondition", "このディーラーは写真を共有できません");
      if (!shared) {
        if (g.exists && g.get("status") === "active") {
          tx.update(ref, { status: "revoked", revokedAt: FieldValue.serverTimestamp(), revokedBy: user.uid });
          audit(tx, { action: "share.revoke", facilityId: fid, localDealerId: lid, companyId: g.get("companyId"), actorUid: user.uid, actorRole: role });
        }
        return { ok: true, shared: false };
      }
      if (!isIdLike(companyId) || !dealer.exists) throw new RegistrationError("failed-precondition", "このディーラーは写真を共有できません");
      const company = await tx.get(db.doc(`dealerCompanies/${companyId}`));
      if (!company.exists || company.get("status") !== "active" || company.get("testOnly") === true) throw new RegistrationError("failed-precondition", "このディーラーは写真を共有できません");
      if (grantValid(g, link, dealer, fid, lid)) return { ok: true, shared: true };
      tx.set(ref, {
        facilityId: fid, localDealerId: lid, companyId, status: "active", effectiveFrom: Timestamp.fromMillis(now()),
        dealerFingerprint: dealerFingerprintOf(dealer), grantedBy: user.uid, grantedByRole: role
      });
      audit(tx, { action: "share.grant", facilityId: fid, localDealerId: lid, companyId, actorUid: user.uid, actorRole: role });
      return { ok: true, shared: true };
    }, { maxAttempts: TX_ATTEMPTS });
  }

  /**
   * この施設で IOL シール写真を使えるか(メニューを出すかの問い合わせ)。所属していて、機能と施設が有効なときだけ true。
   * 表示のための答えで、権限は各処理が毎回確かめる。使えない理由(停止中・対象外・未所属)は区別しない
   */
  async function status(auth, data) {
    strict(data, ["facilityId"]);
    try {
      const user = assertVerifiedUser(auth);
      await assertMember(null, user.uid, data.facilityId);
      return { enabled: true };
    } catch (e) {
      if (e instanceof RegistrationError) return { enabled: false };
      throw e;
    }
  }

  /** stickerPhotoApi(ログイン必須)。すべての処理の先頭で確認する */
  async function api({ auth, data }) {
    if (!auth || !auth.uid) throw new RegistrationError("unauthenticated", "ログインが必要です");
    const d = data && typeof data === "object" && !Array.isArray(data) ? data : null;
    if (d && d.action === "status") { const { action: _a, ...q } = d; return status(auth, q); }   // 停止中も「使えない」と答える(エラーにしない)
    if (!isEnabled()) throw unavailable();
    if (!d || typeof d.action !== "string") throw bad();
    const { action, ...rest } = d;
    if (action === "dealerList") return dealerList(auth, rest);   // 担当者の確認は authorizeDealer(ログイン方法ごとの確認を含む)
    const user = assertVerifiedUser(auth);
    switch (action) {
      case "list": return list(user, rest);
      case "delete": return deletePhoto(user, rest);
      case "getSettings": return getSettings(user, rest);
      case "setAccessCode": return setAccessCode(user, rest);
      case "getEntryQr": return getEntryQr(user, rest);
      case "rotateEntryQr": return rotateEntryQr(user, rest);
      case "setDealerShare": return setDealerShare(user, rest);
      default: throw bad();
    }
  }

  /* ======================= 画像の取得(Firebase Auth 必須) ======================= */

  /** この本人に見せてよい写真の記録。見えないときは null(理由で応答を変えない) */
  async function visibleRecord(auth, req, fid, id) {
    const companyId = req.get("x-dealer-company");
    if (companyId) {
      if (!authorizeDealer) return null;
      const a = await authorizeDealer(auth, companyId, req.get("x-dealer-device") || null);
      const s = (await dealerScope(a.companyId)).get(fid);
      if (!s) return null;
      const p = await photoRef(fid, id).get();
      return p.exists && (millisOf(p.get("takenAt")) ?? 0) >= s.effectiveFromMs ? p.data() : null;
    }
    const user = assertVerifiedUser(auth);
    await assertMember(null, user.uid, fid);
    const p = await photoRef(fid, id).get();
    return p.exists ? p.data() : null;
  }

  async function handleImage(req, res) {
    if (!cors(req, res, "GET, OPTIONS", "Authorization, X-Dealer-Company, X-Dealer-Device")) return;
    res.set("Cache-Control", "private, no-store");
    res.set("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET") return fail(res, 405, "method");
    const m = /^Bearer (.+)$/.exec(req.get("authorization") || "");
    if (!m) return fail(res, 401, "auth");
    let auth;
    try {
      const token = await verifyIdToken(m[1]);
      auth = { uid: token.uid, token };
    } catch { return fail(res, 401, "auth"); }
    const notFound = () => fail(res, 404, "not_found");
    const { facility: fid, photo: id, size = "full" } = req.query || {};
    if (!isEnabled() || !isFacilityId(fid) || !isSha256Hex(id) || !["thumb", "full"].includes(size)) return notFound();
    try {
      let record;
      try { record = await visibleRecord(auth, req, fid, id); }
      catch (e) { if (e instanceof RegistrationError) return notFound(); throw e; }
      if (!record || record.status !== "stored" || !isPhotoOfFacility(record, fid)) return notFound();
      const path = size === "thumb" && record.thumbPath ? record.thumbPath : record.storagePath;
      const bytes = await bucket.read(path);
      if (!bytes) return notFound();
      res.set("Content-Type", "image/jpeg");
      return res.status(200).send(bytes);
    } catch (e) {
      console.error("sticker image failed:", e);
      return fail(res, 503, "unavailable");
    }
  }

  /* ======================= 片付け ======================= */

  /** 記録が指していないオブジェクト(孤立・削除済み)と、期限切れの回数制限の記録を消す。送信中のものを消さないよう、古いものだけ */
  async function cleanup() {
    const t = now();
    let removedObjects = 0, removedLimits = 0, pageToken = null;
    do {
      const page = await bucket.list({ pageToken });
      for (const item of page.items) {
        if (t - item.updatedMs < ORPHAN_AGE_MS) continue;
        const name = parseObjectName(item.name);
        if (!name) continue;   // この機能の形でないものは触らない
        const p = await photoRef(name.facilityId, name.photoId).get();
        const kept = p.exists && p.get("status") === "stored" && (p.get("storagePath") === item.name || p.get("thumbPath") === item.name);
        if (!kept) { await bucket.delete(item.name); removedObjects += 1; }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    for (;;) {
      const expired = await db.collection("stickerRateLimits").where("expiresAt", "<", t).limit(200).get();   // 監査の書き込みを足しても 1 回の上限(500)を超えない数
      if (expired.empty) break;
      const batch = db.batch();
      expired.docs.forEach(d => {
        if (d.get("scope") === "tokenDay" && (d.get("count") ?? 0) > 0) {
          batch.create(db.collection("stickerAuditLogs").doc(), { action: "verify.daySummary", tokenHash: d.id, failures: d.get("count"), windowStart: d.get("windowStart"), at: FieldValue.serverTimestamp() });
        }
        batch.delete(d.ref);
      });
      await batch.commit();
      removedLimits += expired.size;
    }
    return { removedObjects, removedLimits };
  }

  return { verify, api, handleUpload, handleImage, cleanup, dealerScope };
}
