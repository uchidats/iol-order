/**
 * IOL シール写真(R09。docs/iol-sticker-photo-design.md §8)のサーバー側の純粋な処理。
 * Firestore・バケット・Secret には触らない(値は呼び出し側が渡す)。注文・メールの処理からは使わない。
 *
 * 方針:
 * - 送信チケットは Secret の鍵で署名する。施設 ID はチケットから取り、クライアントの申告を使わない。
 * - photoId は施設とアップロードIDだけから決める。チケットとセッションを含めないので、再認証の後の再送も同じ写真になる。
 * - オブジェクト名に画像の SHA-256 を含める。同じIDで内容の違う送信が同時に届いても、互いのオブジェクトを上書きしない。
 * - 上限の判定と記録の決定は planPhotoRegistration にまとめ、呼び出し側は1つのトランザクションの中で使う。
 * - JPEG のメタデータの除去はバイト列の操作だけで、画像データは再圧縮しない。
 * - 上限の定数は src/domain/sticker-photo.js と同じ値(tests/sticker-photo.test.js で確かめる)。
 */
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

/** 上限(§8-2)。枚数と容量は不正利用を止めるための安全上限 */
export const STICKER_LIMITS = Object.freeze({
  imageBytes: 15 * 1024 * 1024,
  sessionPhotos: 100,
  dailyPhotos: 300,
  dailyBytes: 3 * 1024 * 1024 * 1024,
  ticketMinutes: 30,
  listPageSize: 60
});

/** アクセスコードの桁数(半角数字) */
export const ACCESS_CODE_DIGITS = Object.freeze({ min: 6, max: 12 });

/** 撮影ページの URL。QR にはこの URL と入口トークンだけを含める */
export const STICKER_ENTRY_URL = "https://iol.medconf.jp/sticker.html";

/** コードの確認の失敗の回数制限(§8-1) */
export const STICKER_RATE_LIMITS = Object.freeze({
  tokenMax: 10,
  ipMax: 30,
  windowMs: 10 * 60 * 1000,
  blockMs: 15 * 60 * 1000
});

/** 受け付ける画像の画素数の上限(§8-2) */
export const MAX_IMAGE_PIXELS = 100_000_000;

/** チケットの鍵の最小の長さ(バイト) */
const MIN_SECRET_BYTES = 32;
const MAX_TICKET_LENGTH = 1024;
const TICKET_VERSION = 1;
const TICKET_CONTEXT = "sticker-ticket-v1";

const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 });
const SCRYPT_ALGO = `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}`;

const JST_MS = 9 * 60 * 60 * 1000;
const ENTRY_TOKEN = /^[A-Za-z0-9_-]{22}$/;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** 半角数字6〜12桁か */
export function isAccessCode(value) {
  return typeof value === "string" && /^[0-9]{6,12}$/.test(value);
}

/** 入口トークンの形式か */
export const isEntryToken = (value) => typeof value === "string" && ENTRY_TOKEN.test(value);

/** アップロードIDの形式か(UUID v4。大文字を認めないので、同じ値の別の書き方ができない) */
export const isUploadId = (value) => typeof value === "string" && UPLOAD_ID.test(value);

/** SHA-256(16進の小文字)の形式か。photoId もこの形 */
export const isSha256Hex = (value) => typeof value === "string" && SHA256_HEX.test(value);

/** パスの1区切りとして安全な施設 ID か(別の施設のパスを指せないこと) */
export function isFacilityId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && !value.includes("/") && value !== "." && value !== "..";
}

/** 入口トークンを発行する(128 ビットの乱数) */
export const newEntryToken = () => randomBytes(16).toString("base64url");

/** 撮影ページの URL(QR の中身) */
export function buildEntryUrl(token, base = STICKER_ENTRY_URL) {
  if (!isEntryToken(token)) throw new Error("入口トークンの形式が違います");
  return `${base}#f=${token}`;
}

/** 日本時間の日付(YYYY-MM-DD) */
export const jstDateOf = (ms) => new Date(ms + JST_MS).toISOString().slice(0, 10);

/** 使用量の文書の ID(日本時間の YYYYMMDD) */
export const usageDayKey = (ms) => jstDateOf(ms).replace(/-/g, "");

/** 今回の最終手術日として受け付けられるか。実在する日付で、日本時間の今日より後でないこと */
export function isLastSurgeryDate(value, nowMs) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return false;
  return value <= jstDateOf(nowMs);
}

/** X-Blur-Warned の解釈。クライアントの申告なので参考情報(認可・上限・削除の判定に使わない) */
export const parseBlurWarned = (value) => value === "1";

/** SHA-256(16進) */
export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

/* ---------- アクセスコードのハッシュ ---------- */

/**
 * コードのハッシュを作る。保存するのは戻り値だけで、平文は残さない。
 * @returns {Promise<{algo:string, salt:string, hash:string}>}
 */
export async function hashAccessCode(code) {
  if (!isAccessCode(code)) throw new Error("アクセスコードの形式が違います");
  const salt = randomBytes(16);
  const key = await scryptAsync(code, salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return { algo: SCRYPT_ALGO, salt: salt.toString("base64"), hash: key.toString("base64") };
}

/** コードが保存済みのハッシュと一致するか。形式違い・未知の方式は false */
export async function verifyAccessCode(code, stored) {
  if (!isAccessCode(code) || stored?.algo !== SCRYPT_ALGO) return false;
  const expected = Buffer.from(String(stored.hash ?? ""), "base64");
  if (expected.length !== SCRYPT.keyLength) return false;
  const key = await scryptAsync(code, Buffer.from(String(stored.salt ?? ""), "base64"), SCRYPT.keyLength,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return timingSafeEqual(key, expected);
}

/* ---------- 送信チケット ---------- */

function assertSecret(secret) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < MIN_SECRET_BYTES) {
    throw new Error("チケットの鍵が短すぎます");
  }
}

const signPayload = (payload, secret) => createHmac("sha256", secret).update(`${TICKET_CONTEXT}.${payload}`).digest("base64url");

/**
 * 送信チケットを発行する。セッション ID はチケットごとに新しく作る。
 * @returns {{ticket:string, sessionId:string, expiresAt:number}}
 */
export function issueTicket({ facilityId, codeGeneration, secret, now, sessionId = randomUUID() }) {
  assertSecret(secret);
  if (!isFacilityId(facilityId)) throw new Error("施設 ID の形式が違います");
  if (!Number.isInteger(codeGeneration)) throw new Error("コードの世代が必要です");
  const expiresAt = now + STICKER_LIMITS.ticketMinutes * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({
    v: TICKET_VERSION, f: facilityId, s: sessionId, g: codeGeneration, iat: now, exp: expiresAt, n: randomBytes(8).toString("base64url")
  })).toString("base64url");
  return { ticket: `${payload}.${signPayload(payload, secret)}`, sessionId, expiresAt };
}

/**
 * チケットを検証する。署名を最初に確かめ、中身はその後でだけ読む。
 * reason: invalid(改ざん・形式違い) / expired(期限切れ。コードの再入力へ) / stale_code(コードが変更された)
 * @param {string} ticket
 * @param {string} secret
 * @param {{now:number, currentGeneration:(facilityId:string)=>number|Promise<number>}} options 施設の現在のコードの世代を返す関数(署名が正しいときだけ呼ぶ)
 */
export async function verifyTicket(ticket, secret, { now, currentGeneration }) {
  assertSecret(secret);
  const invalid = { ok: false, reason: "invalid" };
  if (typeof ticket !== "string" || ticket.length > MAX_TICKET_LENGTH) return invalid;
  const parts = ticket.split(".");
  if (parts.length !== 2) return invalid;
  const [payload, signature] = parts;
  const expected = Buffer.from(signPayload(payload, secret));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return invalid;

  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return invalid; }
  if (data?.v !== TICKET_VERSION || !isFacilityId(data.f) || typeof data.s !== "string" || !Number.isInteger(data.g)) return invalid;
  if (!Number.isFinite(data.exp) || now >= data.exp) return { ok: false, reason: "expired" };
  if (data.g !== await currentGeneration(data.f)) return { ok: false, reason: "stale_code" };
  return { ok: true, facilityId: data.f, sessionId: data.s, codeGeneration: data.g, expiresAt: data.exp };
}

/* ---------- 写真の ID・オブジェクト名 ---------- */

/**
 * photoId を決める。チケットとセッションを含めない(再認証の後の再送も同じ写真)。
 * アップロードIDに ":" は含まれないので、施設 ID との区切りは曖昧にならない。
 */
export function photoIdOf(facilityId, uploadId) {
  if (!isFacilityId(facilityId)) throw new Error("施設 ID の形式が違います");
  if (!isUploadId(uploadId)) throw new Error("アップロードIDの形式が違います");
  return sha256Hex(`${facilityId}:${uploadId}`);
}

/**
 * 原本とサムネイルのオブジェクト名。同じ内容の再送は同じ名前(上書き)、内容が違えば別の名前になる。
 * @param {string} sha256 受信した画像の SHA-256
 */
export function photoObjectPaths(facilityId, photoId, sha256) {
  if (!isFacilityId(facilityId)) throw new Error("施設 ID の形式が違います");
  if (!isSha256Hex(photoId) || !isSha256Hex(sha256)) throw new Error("写真の ID の形式が違います");
  const name = `${facilityId}/${photoId}_${sha256.slice(0, 32)}`;
  return { storagePath: `${name}.jpg`, thumbPath: `${name}_thumb.jpg` };
}

/** 写真の記録がその施設のものか(閲覧・削除の前に確かめる) */
export function isPhotoOfFacility(record, facilityId) {
  return isFacilityId(facilityId) && record?.facilityId === facilityId
    && typeof record.storagePath === "string" && record.storagePath.startsWith(`${facilityId}/`);
}

/* ---------- 重複・上限の判定 ---------- */

/**
 * 同じ photoId の記録があるときの扱い。記録がなければ null。
 * - existing: 同じ内容の再送。保存せず既存の記録を返す(削除済みでも復元しない)
 * - conflict: 同じIDで内容が違う。既存の写真を変えず 409
 */
export function decideExistingPhoto(existing, { facilityId, sha256 }) {
  if (!existing) return null;
  if (existing.facilityId !== facilityId || existing.sha256 !== sha256) return { action: "conflict" };
  return { action: "existing", created: false, deleted: existing.status === "deleted" };
}

/**
 * 上限の判定。超えるときは reason を返す(画面には出さない)。
 * @param {{session?:{count?:number}|null, usage?:{photos?:number, bytes?:number}|null, bytes:number}} input
 */
export function checkUploadLimits({ session, usage, bytes }, limits = STICKER_LIMITS) {
  if ((session?.count ?? 0) >= limits.sessionPhotos) return { ok: false, reason: "session_photos" };
  if ((usage?.photos ?? 0) >= limits.dailyPhotos) return { ok: false, reason: "daily_photos" };
  if ((usage?.bytes ?? 0) + bytes > limits.dailyBytes) return { ok: false, reason: "daily_bytes" };
  return { ok: true };
}

/**
 * 写真の登録の内容を決める。呼び出し側は1つのトランザクションの中で3つの文書を読んで渡し、結果どおりに書く。
 * トランザクションの再試行で最新の値で判定し直されるので、同時に送っても上限を超えず seq も重複しない。
 * 同じ写真の再送は枚数・容量に数えない。
 * - create: photo・session・usage を書く
 * - existing: 何も書かない(保存したオブジェクトは同じ名前なので残す。ただし削除済みの写真は復元せず、discardObject でオブジェクトを消す)
 * - conflict / limit: 何も書かない。discardObject が true なので、保存したオブジェクトを消す
 * @param {{existing?:object|null, session?:object|null, usage?:object|null, facilityId:string, sha256:string, bytes:number, lastSurgeryDate?:string|null}} input
 */
export function planPhotoRegistration({ existing, session, usage, facilityId, sha256, bytes, lastSurgeryDate = null }, limits = STICKER_LIMITS) {
  const known = decideExistingPhoto(existing, { facilityId, sha256 });
  if (known) return { ...known, discardObject: known.action === "conflict" || known.deleted === true };
  const limit = checkUploadLimits({ session, usage, bytes }, limits);
  if (!limit.ok) return { action: "limit", reason: limit.reason, discardObject: true };
  const count = (session?.count ?? 0) + 1;
  const sessionDate = session ? session.lastSurgeryDate ?? null : lastSurgeryDate;
  return {
    action: "create",
    created: true,
    discardObject: false,
    seq: count,
    lastSurgeryDate: sessionDate,
    session: { count, lastSurgeryDate: sessionDate },
    usage: { photos: (usage?.photos ?? 0) + 1, bytes: (usage?.bytes ?? 0) + bytes }
  };
}

/* ---------- コードの確認の回数制限 ---------- */

/** 回数制限の文書の ID(トークン・IP を平文で残さない) */
export const rateLimitDocId = (kind, value) => sha256Hex(`${kind}:${value}`);

/** 停止中か */
export const isRateLimited = (state, nowMs) => (state?.blockedUntil ?? 0) > nowMs;

/**
 * 確認の失敗を1回数えた次の状態。窓を過ぎていれば数え直す。max を超えると停止する。
 * expiresAt を過ぎた文書は片付けてよい。
 */
export function recordRateLimitFailure(state, max, nowMs, limits = STICKER_RATE_LIMITS) {
  const fresh = !state || nowMs - state.windowStart >= limits.windowMs;
  const count = fresh ? 1 : state.count + 1;
  const windowStart = fresh ? nowMs : state.windowStart;
  const blockedUntil = count > max ? nowMs + limits.blockMs : (state?.blockedUntil ?? 0);
  return { count, windowStart, blockedUntil, expiresAt: Math.max(windowStart + limits.windowMs, blockedUntil) };
}

/* ---------- JPEG の検証とメタデータの除去 ---------- */

const MARKER = Object.freeze({ SOI: 0xd8, EOI: 0xd9, SOS: 0xda, APP0: 0xe0, APP2: 0xe2, APP14: 0xee });
const ICC_SIGNATURE = Buffer.from("ICC_PROFILE\0", "latin1");
const JFIF_SIGNATURE = Buffer.from("JFIF\0", "latin1");
const ADOBE_SIGNATURE = Buffer.from("Adobe", "latin1");
const JFIF_LENGTH = 14;    // サムネイルのない JFIF の本体の長さ
const ADOBE_LENGTH = 12;   // Adobe の色変換の本体の長さ
const DECODE_TABLES = new Set([0xc4, 0xcc, 0xdb, 0xdc, 0xdd]);   // DHT・DAC・DQT・DNL・DRI

const startsWith = (data, signature) => data.subarray(0, signature.length).equals(signature);
/** 幅と高さを持つセグメント(SOF0〜15。DHT・JPG・DAC を除く) */
const isFrameHeader = (marker) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/**
 * 残すセグメントか。表示に必要なものだけを指定して残す(復号の表・サムネイルのない JFIF・色の ICC・Adobe の色変換)。
 * Exif・XMP・IPTC・コメント・MPF・JFIF のサムネイル・未知のセグメントなどは除く
 */
function keepsSegment(marker, data) {
  if (isFrameHeader(marker) || DECODE_TABLES.has(marker)) return true;
  if (marker === MARKER.APP0) return data.length === JFIF_LENGTH && startsWith(data, JFIF_SIGNATURE) && data[12] === 0 && data[13] === 0;
  if (marker === MARKER.APP2) return startsWith(data, ICC_SIGNATURE);
  if (marker === MARKER.APP14) return data.length === ADOBE_LENGTH && startsWith(data, ADOBE_SIGNATURE);
  return false;
}

/** 画像データの次のマーカーの位置(バイトの埋め込み FF00・再同期 RST は読み飛ばす)。なければ -1 */
function nextMarkerOffset(buffer, from) {
  let i = from;
  while (i < buffer.length - 1) {
    i = buffer.indexOf(0xff, i);
    if (i < 0 || i >= buffer.length - 1) return -1;
    const next = buffer[i + 1];
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { i += 2; continue; }
    if (next === 0xff) { i += 1; continue; }
    return i;
  }
  return -1;
}

/**
 * JPEG を検証し、不要なメタデータと EOI より後のデータを除いた本体を返す。画像データは変えない。
 * reason: not_jpeg / truncated / no_dimensions / too_many_pixels
 * @param {Buffer} input
 * @returns {{ok:true, bytes:Buffer, width:number, height:number}|{ok:false, reason:string}}
 */
export function sanitizeJpeg(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  if (buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== MARKER.SOI || buffer[2] !== 0xff) return { ok: false, reason: "not_jpeg" };

  const kept = [buffer.subarray(0, 2)];
  let offset = 2;
  let width = 0;
  let height = 0;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return { ok: false, reason: "truncated" };
    while (buffer[offset + 1] === 0xff) offset += 1;   // マーカーの前の埋め草
    if (offset + 1 >= buffer.length) return { ok: false, reason: "truncated" };
    const marker = buffer[offset + 1];

    if (marker === MARKER.EOI) {
      if (!width || !height) return { ok: false, reason: "no_dimensions" };
      kept.push(buffer.subarray(offset, offset + 2));
      return { ok: true, bytes: Buffer.concat(kept), width, height };
    }
    if (offset + 4 > buffer.length) return { ok: false, reason: "truncated" };
    const length = buffer.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > buffer.length) return { ok: false, reason: "truncated" };

    if (isFrameHeader(marker)) {
      if (length < 7) return { ok: false, reason: "truncated" };
      height = buffer.readUInt16BE(offset + 5);
      width = buffer.readUInt16BE(offset + 7);
      if (!width || !height) return { ok: false, reason: "no_dimensions" };
      if (width * height > MAX_IMAGE_PIXELS) return { ok: false, reason: "too_many_pixels" };
    }

    if (marker === MARKER.SOS) {
      if (!width || !height) return { ok: false, reason: "no_dimensions" };
      const next = nextMarkerOffset(buffer, end);
      if (next < 0) return { ok: false, reason: "truncated" };
      kept.push(buffer.subarray(offset, next));   // SOS のヘッダーと画像データはそのまま
      offset = next;
      continue;
    }
    if (keepsSegment(marker, buffer.subarray(offset + 4, end))) kept.push(buffer.subarray(offset, end));
    offset = end;
  }
  return { ok: false, reason: "truncated" };
}
