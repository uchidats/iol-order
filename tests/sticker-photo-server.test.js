// IOL シール写真(R09)のサーバー側の純粋な処理(チケット・photoId・コードのハッシュ・上限・JPEG)
import test from "node:test";
import assert from "node:assert/strict";
import {
  STICKER_LIMITS, STICKER_RATE_LIMITS, MAX_IMAGE_PIXELS,
  isFacilityId, isSha256Hex, newEntryToken, isEntryToken, parseBlurWarned, usageDayKey, sha256Hex,
  hashAccessCode, verifyAccessCode, issueTicket, verifyTicket,
  photoIdOf, photoObjectPaths, parseObjectName, newAttemptId, isPhotoOfFacility, decideExistingPhoto, checkUploadLimits, planPhotoRegistration,
  rateLimitDocId, isRateLimited, recordRateLimitFailure, refundRateLimitAttempt, sanitizeJpeg
} from "../functions/src/sticker-photo.js";

const SECRET = "x".repeat(32);
const NOW = Date.UTC(2026, 10, 4, 3, 0, 0);
const MIN = 60 * 1000;
const UPLOAD_ID = "3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";
const SHA_A = sha256Hex("image-a");
const SHA_B = sha256Hex("image-b");
const generation = (value) => () => value;

/* ---------- 形式 ---------- */

test("施設 ID: パスの区切りや上の階層を含むものは受け付けない", () => {
  assert.equal(isFacilityId("f1"), true);
  for (const value of ["", "a/b", "/", ".", "..", "x".repeat(129), null, 1]) assert.equal(isFacilityId(value), false);
});

test("入口トークンは 128 ビットの乱数で、毎回違う", () => {
  const a = newEntryToken();
  assert.equal(isEntryToken(a), true);
  assert.notEqual(a, newEntryToken());
});

test("blurWarned は 1 のときだけ true", () => {
  assert.equal(parseBlurWarned("1"), true);
  for (const value of ["0", "true", "", undefined, null]) assert.equal(parseBlurWarned(value), false);
});

test("使用量の文書の ID は日本時間の日付", () => {
  assert.equal(usageDayKey(Date.UTC(2026, 10, 4, 14, 59, 59)), "20261104");
  assert.equal(usageDayKey(Date.UTC(2026, 10, 4, 15, 0, 0)), "20261105");
});

/* ---------- アクセスコードのハッシュ ---------- */

test("コードのハッシュ: 一致だけ通り、平文を含まず、同じコードでも毎回違う", async () => {
  const stored = await hashAccessCode("123456");
  assert.equal(await verifyAccessCode("123456", stored), true);
  assert.equal(await verifyAccessCode("123457", stored), false);
  assert.ok(!JSON.stringify(stored).includes("123456"));
  assert.notEqual((await hashAccessCode("123456")).hash, stored.hash);
});

test("コードのハッシュ: 形式違い・未知の方式・壊れた記録は false、形式違いのコードは作れない", async () => {
  const stored = await hashAccessCode("123456");
  assert.equal(await verifyAccessCode("12345", stored), false);
  assert.equal(await verifyAccessCode("123456", { ...stored, algo: "md5" }), false);
  assert.equal(await verifyAccessCode("123456", { ...stored, hash: "" }), false);
  assert.equal(await verifyAccessCode("123456", null), false);
  await assert.rejects(hashAccessCode("abc"));
});

/* ---------- 送信チケット ---------- */

test("チケット: 発行した内容で検証でき、施設はチケットから取る", async () => {
  const { ticket, sessionId, expiresAt } = issueTicket({ facilityId: "f1", codeGeneration: 2, secret: SECRET, now: NOW });
  assert.equal(expiresAt, NOW + 30 * MIN);
  assert.deepEqual(await verifyTicket(ticket, SECRET, { now: NOW + MIN, currentGeneration: async () => 2 }),
    { ok: true, facilityId: "f1", sessionId, codeGeneration: 2, expiresAt });
});

test("チケット: 発行のたびにセッションが新しくなる", () => {
  const a = issueTicket({ facilityId: "f1", codeGeneration: 1, secret: SECRET, now: NOW });
  const b = issueTicket({ facilityId: "f1", codeGeneration: 1, secret: SECRET, now: NOW });
  assert.notEqual(a.sessionId, b.sessionId);
});

test("チケット: 30分で期限切れ(延長しない)", async () => {
  const { ticket } = issueTicket({ facilityId: "f1", codeGeneration: 1, secret: SECRET, now: NOW });
  const check = (now) => verifyTicket(ticket, SECRET, { now, currentGeneration: generation(1) });
  assert.equal((await check(NOW + 30 * MIN - 1)).ok, true);
  assert.deepEqual(await check(NOW + 30 * MIN), { ok: false, reason: "expired" });
});

test("チケット: コードを変更すると世代の不一致で拒否する", async () => {
  const { ticket } = issueTicket({ facilityId: "f1", codeGeneration: 1, secret: SECRET, now: NOW });
  assert.deepEqual(await verifyTicket(ticket, SECRET, { now: NOW, currentGeneration: generation(2) }), { ok: false, reason: "stale_code" });
});

test("チケット: 改ざん・別の鍵・形式違いは拒否し、中身を読まない", async () => {
  const { ticket } = issueTicket({ facilityId: "f1", codeGeneration: 1, secret: SECRET, now: NOW });
  const options = { now: NOW, currentGeneration: () => { throw new Error("署名の前に読まない"); } };
  const [payload, signature] = ticket.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), f: "f2" })).toString("base64url");
  for (const value of [`${forged}.${signature}`, `${payload}.${signature}x`, `${payload}.`, payload, "", null, 1, "a.b.c", "x".repeat(2000)]) {
    assert.deepEqual(await verifyTicket(value, SECRET, options), { ok: false, reason: "invalid" });
  }
  assert.deepEqual(await verifyTicket(ticket, "y".repeat(32), options), { ok: false, reason: "invalid" });
});

test("チケット: 鍵が短いときは発行も検証もしない", async () => {
  assert.throws(() => issueTicket({ facilityId: "f1", codeGeneration: 1, secret: "short", now: NOW }));
  await assert.rejects(verifyTicket("a.b", "", { now: NOW, currentGeneration: generation(1) }));
  assert.throws(() => issueTicket({ facilityId: "a/b", codeGeneration: 1, secret: SECRET, now: NOW }));
});

/* ---------- photoId・オブジェクト名 ---------- */

test("再認証の後の再送: 別のチケット・セッションでも同じアップロードIDなら同じ photoId", async () => {
  const first = issueTicket({ facilityId: "f1", codeGeneration: 1, secret: SECRET, now: NOW });
  const second = issueTicket({ facilityId: "f1", codeGeneration: 1, secret: SECRET, now: NOW + 31 * MIN });
  assert.notEqual(first.sessionId, second.sessionId);
  const facility = async (t, now) => (await verifyTicket(t.ticket, SECRET, { now, currentGeneration: generation(1) })).facilityId;
  assert.equal(photoIdOf(await facility(first, NOW), UPLOAD_ID), photoIdOf(await facility(second, NOW + 31 * MIN), UPLOAD_ID));
});

test("施設の分離: 同じアップロードIDでも施設が違えば別の photoId・別のパス", () => {
  const a = photoIdOf("f1", UPLOAD_ID);
  const b = photoIdOf("f2", UPLOAD_ID);
  assert.notEqual(a, b);
  assert.equal(isSha256Hex(a), true);
  assert.ok(photoObjectPaths("f1", a, newAttemptId()).storagePath.startsWith("f1/"));
  assert.ok(photoObjectPaths("f2", b, newAttemptId()).storagePath.startsWith("f2/"));
});

test("施設の分離: 施設 ID に区切りの文字があっても別の入力と重ならない", () => {
  assert.notEqual(photoIdOf("a:b", UPLOAD_ID), photoIdOf("a", UPLOAD_ID));
  assert.notEqual(photoIdOf("f1", UPLOAD_ID), photoIdOf("f1", "3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5c"));
});

test("形式違いの施設・IDからは photoId とパスを作らない", () => {
  assert.throws(() => photoIdOf("f1", "not-a-uuid"));
  assert.throws(() => photoIdOf("f1", UPLOAD_ID.toUpperCase()));
  assert.throws(() => photoIdOf("a/b", UPLOAD_ID));
  assert.throws(() => photoObjectPaths("../f2", SHA_A, newAttemptId()));
  assert.throws(() => photoObjectPaths("f1", "x", newAttemptId()));
  assert.throws(() => photoObjectPaths("f1", SHA_A, "x"));
});

test("オブジェクト名: 試行ごとに別の名前で、互いを上書きしない。名前から施設と写真を読める", () => {
  const id = photoIdOf("f1", UPLOAD_ID);
  const first = photoObjectPaths("f1", id, newAttemptId());
  const second = photoObjectPaths("f1", id, newAttemptId());
  assert.notEqual(first.storagePath, second.storagePath);
  assert.ok(first.storagePath.startsWith(`f1/${id}_`) && first.storagePath.endsWith(".jpg"));
  assert.deepEqual(parseObjectName(first.storagePath), { facilityId: "f1", photoId: id, thumb: false });
  assert.deepEqual(parseObjectName(first.thumbPath), { facilityId: "f1", photoId: id, thumb: true });
  for (const name of ["", "f1/x.jpg", `${id}_0000000000000000.jpg`, null]) assert.equal(parseObjectName(name), null);
  assert.throws(() => photoObjectPaths("f1", id, "not-an-attempt"));
});

test("記録がその施設のものかを確かめる", () => {
  const record = { facilityId: "f1", storagePath: "f1/x.jpg" };
  assert.equal(isPhotoOfFacility(record, "f1"), true);
  assert.equal(isPhotoOfFacility(record, "f2"), false);
  assert.equal(isPhotoOfFacility({ facilityId: "f1", storagePath: "f2/x.jpg" }, "f1"), false);
  assert.equal(isPhotoOfFacility({ facilityId: "f1", storagePath: "f10/x.jpg" }, "f1"), false);
  assert.equal(isPhotoOfFacility(null, "f1"), false);
});

/* ---------- 重複の判定 ---------- */

const stored = (overrides = {}) => ({ facilityId: "f1", sha256: SHA_A, status: "stored", ...overrides });

test("同じIDの判定: 記録なし / 同じ内容 / 内容が違う / 削除済み", () => {
  const input = { facilityId: "f1", sha256: SHA_A };
  assert.equal(decideExistingPhoto(null, input), null);
  assert.deepEqual(decideExistingPhoto(stored(), input), { action: "existing", created: false, deleted: false });
  assert.deepEqual(decideExistingPhoto(stored({ sha256: SHA_B }), input), { action: "conflict" });
  assert.deepEqual(decideExistingPhoto(stored({ status: "deleted" }), input), { action: "existing", created: false, deleted: true });
  assert.deepEqual(decideExistingPhoto(stored({ status: "deleted", sha256: SHA_B }), input), { action: "conflict" });
  assert.deepEqual(decideExistingPhoto(stored({ facilityId: "f2" }), input), { action: "conflict" });
});

/* ---------- 上限・登録の決定 ---------- */

const small = { ...STICKER_LIMITS, sessionPhotos: 3, dailyPhotos: 5, dailyBytes: 1000 };

test("上限: ちょうどまでは通り、超えると理由を返す", () => {
  assert.deepEqual(checkUploadLimits({ session: null, usage: null, bytes: 1000 }, small), { ok: true });
  assert.deepEqual(checkUploadLimits({ session: { count: 2 }, usage: { photos: 4, bytes: 900 }, bytes: 100 }, small), { ok: true });
  assert.equal(checkUploadLimits({ session: { count: 3 }, usage: null, bytes: 1 }, small).reason, "session_photos");
  assert.equal(checkUploadLimits({ session: null, usage: { photos: 5, bytes: 0 }, bytes: 1 }, small).reason, "daily_photos");
  assert.equal(checkUploadLimits({ session: null, usage: { photos: 0, bytes: 1000 }, bytes: 1 }, small).reason, "daily_bytes");
});

test("登録: 最初の写真がセッションの最終手術日を決め、以後は違う値でも固定", () => {
  const base = { facilityId: "f1", sha256: SHA_A, bytes: 10 };
  const first = planPhotoRegistration({ ...base, lastSurgeryDate: "2026-11-04" });
  assert.equal(first.action, "create");
  assert.equal(first.seq, 1);
  assert.equal(first.lastSurgeryDate, "2026-11-04");
  assert.deepEqual(first.usage, { photos: 1, bytes: 10 });
  const second = planPhotoRegistration({ ...base, session: first.session, usage: first.usage, lastSurgeryDate: "2026-11-01" });
  assert.equal(second.seq, 2);
  assert.equal(second.lastSurgeryDate, "2026-11-04");
  const unset = planPhotoRegistration({ ...base, session: { count: 1, lastSurgeryDate: null }, lastSurgeryDate: "2026-11-01" });
  assert.equal(unset.lastSurgeryDate, null, "未入力で始めたセッションは未入力のまま");
});

test("登録: 再認証の後の再送は記録・枚数・容量を増やさず、保存したオブジェクトも消さない", () => {
  const plan = planPhotoRegistration({ existing: stored(), session: null, usage: { photos: 300, bytes: 0 }, facilityId: "f1", sha256: SHA_A, bytes: 10 });
  assert.equal(plan.action, "existing");
  assert.equal(plan.created, false);
  assert.equal(plan.discardObject, true, "記録が指すのは別の試行のオブジェクト。この試行の分だけを消す");
  assert.equal(plan.usage, undefined);
  assert.equal(plan.session, undefined);
});

test("登録: 同じIDで内容が違えば何も書かず、自分のオブジェクトだけを消す", () => {
  const plan = planPhotoRegistration({ existing: stored(), facilityId: "f1", sha256: SHA_B, bytes: 10 });
  assert.equal(plan.action, "conflict");
  assert.equal(plan.discardObject, true);
  assert.equal(plan.usage, undefined);
});

test("登録: 確認の後に削除された写真の再送は復元せず、保存したオブジェクトを消す", () => {
  const plan = planPhotoRegistration({ existing: stored({ status: "deleted" }), session: { count: 3 }, usage: null, facilityId: "f1", sha256: SHA_A, bytes: 100 });
  assert.deepEqual([plan.action, plan.created, plan.deleted, plan.discardObject], ["existing", false, true, true]);
  assert.equal(plan.session, undefined, "枚数・容量を増やさない");
});

test("登録: 上限を超えたら何も書かず、保存したオブジェクトを消す", () => {
  const plan = planPhotoRegistration({ session: { count: 3 }, facilityId: "f1", sha256: SHA_A, bytes: 10 }, small);
  assert.deepEqual(plan, { action: "limit", reason: "session_photos", discardObject: true });
});

/** Firestore のトランザクションと同じく、各送信を最新の状態で順に判定し直す */
function registerAll(uploads, limits) {
  const db = { photos: new Map(), session: null, usage: null };
  const results = uploads.map((upload) => {
    const id = photoIdOf("f1", upload.uploadId);
    const plan = planPhotoRegistration({ existing: db.photos.get(id), session: db.session, usage: db.usage, facilityId: "f1", sha256: upload.sha256, bytes: upload.bytes }, limits);
    if (plan.action === "create") {
      db.photos.set(id, { facilityId: "f1", sha256: upload.sha256, status: "stored", seq: plan.seq });
      db.session = plan.session;
      db.usage = plan.usage;
    }
    return plan;
  });
  return { db, results };
}

const uuid = (n) => `3f2b8c1e-4a5d-4e6f-8a9b-${String(n).padStart(12, "0")}`;

test("同時送信: 上限を超えず、seq は重複せず連続する", () => {
  const uploads = Array.from({ length: 6 }, (_, i) => ({ uploadId: uuid(i), sha256: sha256Hex(String(i)), bytes: 10 }));
  const { db, results } = registerAll(uploads, small);
  assert.deepEqual(results.map(r => r.action), ["create", "create", "create", "limit", "limit", "limit"]);
  assert.deepEqual([...db.photos.values()].map(p => p.seq), [1, 2, 3]);
  assert.deepEqual(db.usage, { photos: 3, bytes: 30 });
});

test("同時送信: 同じIDは1件だけ登録し、内容が違う2件目は既存を変えない", () => {
  const { db, results } = registerAll([
    { uploadId: uuid(1), sha256: SHA_A, bytes: 10 },
    { uploadId: uuid(1), sha256: SHA_A, bytes: 10 },
    { uploadId: uuid(1), sha256: SHA_B, bytes: 10 }
  ], small);
  assert.deepEqual(results.map(r => r.action), ["create", "existing", "conflict"]);
  assert.equal(db.photos.size, 1);
  assert.equal([...db.photos.values()][0].sha256, SHA_A);
  assert.deepEqual(db.usage, { photos: 1, bytes: 10 });
});

/* ---------- 回数制限 ---------- */

test("回数制限: max を超えると停止し、窓を過ぎると数え直す", () => {
  let state = null;
  for (let i = 0; i < STICKER_RATE_LIMITS.tokenMax; i++) state = recordRateLimitFailure(state, STICKER_RATE_LIMITS.tokenMax, NOW);
  assert.equal(state.count, 10);
  assert.equal(isRateLimited(state, NOW), false);
  state = recordRateLimitFailure(state, STICKER_RATE_LIMITS.tokenMax, NOW);
  assert.equal(isRateLimited(state, NOW + 14 * MIN), true);
  assert.equal(isRateLimited(state, NOW + 15 * MIN), false);
  assert.equal(state.expiresAt, NOW + 15 * MIN);
  const later = recordRateLimitFailure(state, STICKER_RATE_LIMITS.tokenMax, NOW + 16 * MIN);
  assert.equal(later.count, 1);
  assert.equal(isRateLimited(null, NOW), false);
});

test("回数制限: 確認に成功した1回を返す。停止は解除しない", () => {
  assert.deepEqual(refundRateLimitAttempt({ count: 3, windowStart: NOW, blockedUntil: 0 }), { count: 2, windowStart: NOW, blockedUntil: 0 });
  assert.equal(refundRateLimitAttempt({ count: 0, blockedUntil: NOW + 5 }).count, 0);
  assert.equal(refundRateLimitAttempt({ count: 3, blockedUntil: NOW + 5 }).blockedUntil, NOW + 5);
  assert.equal(refundRateLimitAttempt(null), null);
});

test("回数制限の文書の ID に元の値を含めない", () => {
  const id = rateLimitDocId("ip", "192.0.2.1");
  assert.equal(isSha256Hex(id), true);
  assert.notEqual(id, rateLimitDocId("token", "192.0.2.1"));
});

/* ---------- JPEG ---------- */

const segment = (marker, payload) => {
  const data = Buffer.from(payload);
  return Buffer.concat([Buffer.from([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff]), data]);
};
const frame = (width, height, marker = 0xc0) => segment(marker, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const JFIF = segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"));
const ICC = segment(0xe2, Buffer.from("ICC_PROFILE\0\x01\x01profile", "latin1"));
const ADOBE = segment(0xee, Buffer.from("Adobe\0\x64\0\0\0\0\0", "latin1"));
const DQT = segment(0xdb, Buffer.alloc(65, 1));
const SOS = segment(0xda, [1, 1, 0, 0, 63, 0]);
/** 画像データ: FF00(埋め込み)と RST を含む。これらを終わりと誤認しないこと */
const SCAN = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, 0x00, 0x78]);

const clean = () => Buffer.concat([SOI, JFIF, ICC, ADOBE, DQT, frame(4080, 3060), SOS, SCAN, EOI]);
const withMetadata = () => Buffer.concat([
  SOI, JFIF,
  segment(0xe1, Buffer.from("Exif\0\0GPS-SECRET", "latin1")),
  segment(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0XMP-SECRET", "latin1")),
  ICC,
  segment(0xe2, Buffer.from("MPF\0MPF-SECRET", "latin1")),
  segment(0xe5, Buffer.from("VENDOR-SECRET", "latin1")),
  segment(0xed, Buffer.from("Photoshop 3.0\0IPTC-SECRET", "latin1")),
  ADOBE,
  segment(0xfe, Buffer.from("COMMENT-SECRET", "latin1")),
  DQT, frame(4080, 3060), SOS, SCAN, EOI,
  Buffer.from("TRAILING-SECRET", "latin1")
]);

test("JPEG: 幅と高さを読み、メタデータのない画像は変わらない", () => {
  const input = clean();
  const result = sanitizeJpeg(input);
  assert.equal(result.ok, true);
  assert.equal(result.width, 4080);
  assert.equal(result.height, 3060);
  assert.ok(result.bytes.equals(input));
});

test("JPEG: Exif・XMP・IPTC・コメント・MPF・EOI より後のデータを除き、画像データはそのまま", () => {
  const result = sanitizeJpeg(withMetadata());
  assert.equal(result.ok, true);
  assert.ok(!result.bytes.toString("latin1").includes("SECRET"));
  assert.ok(result.bytes.equals(clean()), "表示に必要な部分と画像データは1バイトも変わらない");
});

test("JPEG: 埋め込みのサムネイル・署名の違うセグメント・未知のセグメントは残さない", () => {
  const thumbnail = Buffer.from("THUMB-SECRET", "latin1");
  const hidden = [
    segment(0xe0, Buffer.concat([Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\x02\x02", "latin1"), thumbnail])),   // JFIF のサムネイル
    segment(0xe0, Buffer.concat([Buffer.from("JFXX\0\x10", "latin1"), thumbnail])),                                   // JFIF の拡張のサムネイル
    segment(0xe0, Buffer.from("VENDOR-SECRET-THUMB", "latin1")),
    segment(0xee, Buffer.from("Vendor\0THUMB-SECRET", "latin1")),
    segment(0xee, Buffer.from("Adobe\0\x64\0\0\0\0\0THUMB-SECRET", "latin1")),                                     // 署名は同じで長さが違う
    segment(0xf0, thumbnail),                                                                                         // 予約のセグメント
    segment(0xc8, thumbnail)
  ];
  const result = sanitizeJpeg(Buffer.concat([SOI, ...hidden, DQT, frame(4080, 3060), SOS, SCAN, EOI]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.bytes, Buffer.concat([SOI, DQT, frame(4080, 3060), SOS, SCAN, EOI]));
  assert.ok(!result.bytes.includes("SECRET"));
});

test("JPEG: 復号に必要な表は残す", () => {
  const tables = [segment(0xc4, Buffer.alloc(20, 2)), segment(0xcc, [1, 2]), segment(0xdd, [0, 8])];
  const input = Buffer.concat([SOI, DQT, ...tables, frame(100, 50), SOS, SCAN, EOI]);
  assert.deepEqual(sanitizeJpeg(input).bytes, input);
});

test("JPEG: 除去は冪等で、同じ入力は同じ結果", () => {
  const once = sanitizeJpeg(withMetadata()).bytes;
  assert.ok(sanitizeJpeg(once).bytes.equals(once));
  assert.ok(sanitizeJpeg(withMetadata()).bytes.equals(once));
});

test("JPEG: プログレッシブの複数のスキャンの間のコメントも除き、スキャンは残す", () => {
  const dht = segment(0xc4, Buffer.alloc(20, 2));
  const input = Buffer.concat([SOI, frame(100, 50, 0xc2), SOS, SCAN, segment(0xfe, Buffer.from("MID-SECRET", "latin1")), dht, SOS, SCAN, EOI]);
  const result = sanitizeJpeg(input);
  assert.equal(result.ok, true);
  assert.deepEqual([result.width, result.height], [100, 50]);
  assert.ok(result.bytes.equals(Buffer.concat([SOI, frame(100, 50, 0xc2), SOS, SCAN, dht, SOS, SCAN, EOI])));
});

test("JPEG: 形式違い・途中で切れたデータは拒否する", () => {
  const reason = (input) => sanitizeJpeg(input).reason;
  assert.equal(reason(Buffer.from("not a jpeg")), "not_jpeg");
  assert.equal(reason(Buffer.alloc(0)), "not_jpeg");
  assert.equal(reason(null), "not_jpeg");
  assert.equal(reason(Buffer.from([0xff, 0xd8])), "not_jpeg");
  const whole = clean();
  assert.equal(reason(whole.subarray(0, whole.length - 2)), "truncated", "EOI がない");
  assert.equal(reason(whole.subarray(0, 12)), "truncated", "セグメントの途中");
  assert.equal(reason(Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0xff, 0xff, 0x00])])), "truncated", "長さが本体を超える");
  assert.equal(reason(Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00, 0x01])])), "truncated", "長さが小さすぎる");
  assert.equal(reason(Buffer.concat([SOI, JFIF, Buffer.from([0x00, 0x01])])), "truncated", "マーカーがない");
});

test("JPEG: 幅と高さがない・0・大きすぎる画像は拒否する", () => {
  assert.equal(sanitizeJpeg(Buffer.concat([SOI, JFIF, EOI])).reason, "no_dimensions");
  assert.equal(sanitizeJpeg(Buffer.concat([SOI, JFIF, SOS, SCAN, EOI])).reason, "no_dimensions");
  assert.equal(sanitizeJpeg(Buffer.concat([SOI, frame(0, 100), SOS, SCAN, EOI])).reason, "no_dimensions");
  assert.equal(sanitizeJpeg(Buffer.concat([SOI, frame(20000, 20000), SOS, SCAN, EOI])).reason, "too_many_pixels");
  assert.equal(sanitizeJpeg(Buffer.concat([SOI, frame(10000, 10000), SOS, SCAN, EOI])).ok, true, `上限 ${MAX_IMAGE_PIXELS} ちょうどは通る`);
});

test("JPEG: 12.5MP 相当の大きな入力でも短時間で処理する", () => {
  const scan = Buffer.alloc(14 * 1024 * 1024, 0x55);
  const input = Buffer.concat([SOI, JFIF, frame(4080, 3060), SOS, scan, EOI]);
  const start = performance.now();
  assert.equal(sanitizeJpeg(input).ok, true);
  assert.ok(performance.now() - start < 2000);
});
