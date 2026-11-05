// IOL シール写真(R09)のサーバーの処理。Firestore エミュレータと偽のバケットで確かめる(実際のバケットには接続しない)
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp, FieldPath } from "firebase-admin/firestore";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { createStickerPhotoService, clientIpOf } from "../../functions/src/sticker-photo-service.js";
import { createStickerBucket } from "../../functions/src/sticker-bucket.js";
import { RegistrationError } from "../../functions/src/registration.js";
import { createDealerPortalService } from "../../functions/src/dealer-portal.js";
import {
  STICKER_LIMITS, STICKER_RATE_LIMITS, hashAccessCode, verifyAccessCode, issueTicket, sha256Hex, photoIdOf, newEntryToken, rateLimitDocId, usageDayKey
} from "../../functions/src/sticker-photo.js";

const sharp = createRequire(new URL("../../functions/package.json", import.meta.url))("sharp");
const PROJECT = "demo-iol-functions";
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185").split(":");
const SECRET = "s".repeat(40);
const ORIGIN = "https://iol.medconf.jp";
const CODE = "123456";
const T0 = Date.parse("2026-11-05T01:00:00Z");
const MIN = 60 * 1000;
const F = "fA", G = "fB";
const TOKEN = newEntryToken();
const TOKEN_B = newEntryToken();

let db, env, clock, enabled, bucket, svc, accessRecord, baseJpeg, codeChecks;

/** 偽のバケット。保存の途中で止める(gate)・失敗させる(failSave)ことができる */
function fakeBucket() {
  const objects = new Map();
  return {
    objects, gate: null, failSave: false, failDelete: false,
    async save(name, bytes) {
      if (this.failSave) throw new Error("save failed");
      if (this.gate) await this.gate(name);
      objects.set(name, { bytes: Buffer.from(bytes), updatedMs: clock.t });
    },
    async read(name) { return objects.get(name)?.bytes ?? null; },
    async delete(name) { if (this.failDelete) throw new Error("delete failed"); objects.delete(name); },
    async list() { return { items: [...objects].map(([name, o]) => ({ name, updatedMs: o.updatedMs })), nextPageToken: null }; }
  };
}

const mk = (over = {}) => createStickerPhotoService({
  db, FieldValue, Timestamp, bucket, now: () => clock.t, isEnabled: () => enabled.on, facilityIds: () => enabled.facilities, ticketSecret: () => SECRET,
  checkCode: async (code, stored) => { codeChecks.n += 1; return verifyAccessCode(code, stored); },
  verifyIdToken: async (token) => { if (!token.startsWith("id-")) throw new Error("bad token"); return { uid: token.slice(3), email: `${token.slice(3)}@x.jp`, email_verified: true }; },
  authorizeDealer: async (auth, companyId) => {
    if (auth.uid !== "staffX" || (companyId && companyId !== "cX")) throw new RegistrationError("permission-denied", "no");
    return { companyId: "cX" };
  },
  makeQrSvg: async (url) => `<svg data-url="${url}"></svg>`,
  ...over
});

before(async () => {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  db = getFirestore();
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: "rules_version = '2'; service cloud.firestore { match /databases/{d}/documents { match /{x=**} { allow read, write: if false; } } }", host, port: Number(port) } });
  accessRecord = await hashAccessCode(CODE);
  baseJpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#dde" } }).jpeg({ quality: 90 }).toBuffer();
});
after(async () => { await env.clearFirestore(); await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  clock = { t: T0 };
  enabled = { on: true, facilities: [F, G] };
  codeChecks = { n: 0 };
  bucket = fakeBucket();
  svc = mk();
  for (const [fid, token] of [[F, TOKEN], [G, TOKEN_B]]) {
    await db.doc(`facilities/${fid}`).set({ name: `${fid}眼科`, status: "active" });
    await db.doc(`facilities/${fid}/stickerSettings/access`).set({ ...accessRecord, codeGeneration: 1 });
    await db.doc(`facilities/${fid}/stickerSettings/entry`).set({ token });
    await db.doc(`stickerEntries/${token}`).set({ facilityId: fid, status: "active" });
  }
  for (const [fid, uid, role] of [[F, "adminA", "admin"], [F, "subA", "subadmin"], [F, "ordA", "orderer"], [F, "proxyA", "proxy"], [G, "adminB", "admin"]]) {
    await db.doc(`facilities/${fid}/members/${uid}`).set({ uid, role });
  }
  await db.doc("dealerCompanies/cX").set({ name: "X商事", status: "active" });
  await db.doc(`facilities/${F}/facilityDealers/dA`).set({ facilityId: F, name: "X商事 立川", orderEmails: ["x@example.jp"] });
  await db.doc(`facilities/${F}/dealerPortalLinks/dA`).set({ companyId: "cX", status: "proposed", currentGrantId: null });
});

const user = (uid, over = {}) => ({ uid, token: { email: `${uid}@x.jp`, email_verified: true, ...over } });
const api = (uid, action, data = {}, s = svc) => s.api({ auth: uid ? user(uid) : null, data: { action, ...data } });
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);
const verify = (token, code, ip = "198.51.100.7", s = svc) => s.verify({ data: { token, code }, ip });
const uuid = (n) => `3f2b8c1e-4a5d-4e6f-8a9b-${String(n).padStart(12, "0")}`;
const ticketFor = (fid = F, generation = 1, t = clock.t) => issueTicket({ facilityId: fid, codeGeneration: generation, secret: SECRET, now: t }).ticket;

/** Exif・コメントを足した JPEG(本文の別の内容を作るときは salt を変える) */
const withExif = (salt = "") => {
  const exif = Buffer.from(`Exif\0\0GPS-SECRET${salt}`, "latin1");
  return Buffer.concat([baseJpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, 0, exif.length + 2]), exif, baseJpeg.subarray(2)]);
};

function reqOf({ method = "PUT", headers = {}, rawBody, query }) {
  const lower = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { method, rawBody, query, headers: lower, get: (name) => lower[name.toLowerCase()] };
}
function resOf() {
  const r = { statusCode: 0, headers: {}, body: undefined };
  r.set = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}
async function put({ ticket = ticketFor(), body = baseJpeg, uploadId = uuid(1), headers = {}, s = svc, sha } = {}) {
  const res = resOf();
  await s.handleUpload(reqOf({
    rawBody: body,
    headers: { Origin: ORIGIN, "Content-Length": body.length, "X-Sticker-Ticket": ticket, "X-Upload-Id": uploadId, "X-Content-Sha256": sha ?? sha256Hex(body), ...headers }
  }), res);
  return res;
}
async function image(uid, { facility = F, photo, size, headers = {}, s = svc } = {}) {
  const res = resOf();
  await s.handleImage(reqOf({ method: "GET", query: { facility, photo, ...(size ? { size } : {}) }, headers: { Origin: ORIGIN, ...(uid ? { Authorization: `Bearer id-${uid}` } : {}), ...headers } }), res);
  return res;
}
const photoDoc = (id, fid = F) => db.doc(`facilities/${fid}/stickerPhotos/${id}`).get();
const originals = () => [...bucket.objects.keys()].filter(n => !n.endsWith("_thumb.jpg"));
const usage = async (fid = F) => (await db.doc(`facilities/${fid}/stickerUsage/${usageDayKey(clock.t)}`).get()).data();
/** 保存の途中で止めるための鍵 */
function latch() { let open; const opened = new Promise(r => { open = r; }); return { opened, open }; }
/** 条件を満たすまで待つ(偽のバケットに届くまで) */
async function until(cond) { for (let i = 0; i < 400 && !cond(); i += 1) await new Promise(r => setTimeout(r, 10)); assert.ok(cond(), "timeout"); }

// ================= 入口の確認 =================
test("確認: 正しいコードでチケットと施設名・前回の送信を返す。回数は積み上がらない", async () => {
  const r = await verify(TOKEN, CODE);
  assert.equal(r.facilityName, "fA眼科");
  assert.deepEqual([r.lastSentAt, r.lastSurgeryDate], [null, null]);
  assert.equal(r.expiresAt, clock.t + 30 * MIN);
  assert.equal((await put({ ticket: r.ticket })).statusCode, 200);
  const limit = await db.doc(`stickerRateLimits/${rateLimitDocId("token", TOKEN)}`).get();
  assert.equal(limit.get("count"), 0);
});

test("確認: コードの誤り・無効なトークン・無効化・未設定・機能の停止は、すべて同じ応答で、同じ計算をする", async () => {
  const revoked = newEntryToken();
  await db.doc(`stickerEntries/${revoked}`).set({ facilityId: F, status: "revoked" });
  const noCode = newEntryToken();
  await db.doc("facilities/fC").set({ name: "C", status: "active" });
  await db.doc(`stickerEntries/${noCode}`).set({ facilityId: "fC", status: "active" });
  const outsider = newEntryToken();
  await db.doc("facilities/fD").set({ name: "D", status: "active" });
  await db.doc("facilities/fD/stickerSettings/access").set({ ...accessRecord, codeGeneration: 1 });
  await db.doc(`stickerEntries/${outsider}`).set({ facilityId: "fD", status: "active" });
  const seen = [];
  for (const [token, code, i] of [[TOKEN, "999999", 1], [newEntryToken(), CODE, 2], [revoked, CODE, 3], [noCode, CODE, 4], [outsider, CODE, 5], ["short", CODE, 6], [TOKEN, "12", 7]]) {
    const before = codeChecks.n;
    await assert.rejects(verify(token, code, `198.51.100.${i}`), (e) => { seen.push(`${e.code}|${e.message}`); return true; });
    assert.equal(codeChecks.n, before + 1, "どの場合もコードの計算を1回行う");
  }
  enabled.on = false;
  await assert.rejects(verify(TOKEN, CODE, "198.51.100.8"), (e) => { seen.push(`${e.code}|${e.message}`); return true; });
  assert.equal(new Set(seen).size, 1, "応答で区別できない");
  assert.ok(!seen[0].includes("fA"));
});

test("確認: 回数制限はトークンの有無によらず同じ。超えると正しいコードも止まり、時間が過ぎると戻る", async () => {
  const unknown = newEntryToken();
  for (const token of [TOKEN, unknown]) {
    for (let i = 0; i < STICKER_RATE_LIMITS.tokenMax; i += 1) await rejects(verify(token, "999999", `203.0.113.${i}`), "permission-denied");
    await rejects(verify(token, CODE, "203.0.113.200"), "resource-exhausted");
    await rejects(verify(token, CODE, "203.0.113.201"), "resource-exhausted");
  }
  clock.t += STICKER_RATE_LIMITS.blockMs + 1;
  assert.ok((await verify(TOKEN, CODE)).ticket);
});

test("確認: 送信元ごとの回数制限は、別のトークンを試しても効く", async () => {
  for (let i = 0; i < STICKER_RATE_LIMITS.ipMax; i += 1) await rejects(verify(newEntryToken(), CODE, "192.0.2.9"), "permission-denied");
  await rejects(verify(TOKEN, CODE, "192.0.2.9"), "resource-exhausted");
  assert.ok((await verify(TOKEN, CODE, "192.0.2.10")).ticket, "別の送信元は通る");
});

test("同時の確認: 30件を同時に送っても、上限を超えてコードを試せない", async () => {
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => verify(TOKEN, String(100000 + i), `203.0.113.${i}`)));
  assert.equal(codeChecks.n, STICKER_RATE_LIMITS.tokenMax, "確認できるのは上限の回数だけ");
  assert.equal(results.filter(r => r.reason?.code === "resource-exhausted").length, 30 - STICKER_RATE_LIMITS.tokenMax);
  await rejects(verify(TOKEN, CODE, "203.0.113.100"), "resource-exhausted");
});

test("送信元の IP: クライアントが書ける先頭ではなく、末尾の値を使う", () => {
  assert.equal(clientIpOf({ headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 198.51.100.7" } }), "198.51.100.7");
  assert.equal(clientIpOf({ headers: {}, ip: "198.51.100.8" }), "198.51.100.8");
});

test("確認: 前回の送信は保存済みの最新。削除した写真は除き、最新のセッションが未入力なら古い日付を持ち出さない", async () => {
  const ticket = ticketFor();
  const a = await put({ ticket, uploadId: uuid(1), headers: { "X-Last-Surgery-Date": "2026-11-04" } });
  clock.t += MIN;
  const b = await put({ ticket, uploadId: uuid(2) });
  let r = await verify(TOKEN, CODE);
  assert.deepEqual([r.lastSentAt, r.lastSurgeryDate], [b.body.takenAt, "2026-11-04"], "同じセッションの値");
  clock.t += MIN;
  const c = await put({ uploadId: uuid(3), ticket: ticketFor() });
  r = await verify(TOKEN, CODE);
  assert.deepEqual([r.lastSentAt, r.lastSurgeryDate], [c.body.takenAt, null]);
  await api("adminA", "delete", { facilityId: F, photoId: c.body.photoId });
  r = await verify(TOKEN, CODE);
  assert.equal(r.lastSentAt, b.body.takenAt);
  assert.ok(a.body.photoId);
});

// ================= チケット・コード・QR =================
test("チケット: 期限切れ・改ざん・別の鍵は 401。コードを変更すると発行済みのチケットも拒否する", async () => {
  const t = ticketFor();
  clock.t += 30 * MIN;
  assert.equal((await put({ ticket: t })).statusCode, 401);
  assert.equal((await put({ ticket: `${ticketFor()}x` })).statusCode, 401);
  assert.equal((await put({ ticket: issueTicket({ facilityId: F, codeGeneration: 1, secret: "o".repeat(40), now: clock.t }).ticket })).statusCode, 401);
  const live = ticketFor();
  await api("subA", "setAccessCode", { facilityId: F, code: "654321" });
  assert.equal((await put({ ticket: live })).statusCode, 401);
  await rejects(verify(TOKEN, CODE), "permission-denied");
  assert.ok((await verify(TOKEN, "654321")).ticket);
  assert.equal(bucket.objects.size, 0);
});

test("設定: コードは平文で保存せず再表示もしない。形式違い・権限のない人は変更できない", async () => {
  await rejects(api("ordA", "setAccessCode", { facilityId: F, code: "654321" }), "permission-denied");
  await rejects(api("adminB", "setAccessCode", { facilityId: F, code: "654321" }), "permission-denied");
  await rejects(api("adminA", "setAccessCode", { facilityId: F, code: "12345" }), "invalid-argument");
  await api("adminA", "setAccessCode", { facilityId: F, code: "654321" });
  const stored = (await db.doc(`facilities/${F}/stickerSettings/access`).get()).data();
  assert.equal(stored.codeGeneration, 2);
  assert.ok(!JSON.stringify(stored).includes("654321"));
  const logs = await db.collection("stickerAuditLogs").get();
  assert.ok(!JSON.stringify(logs.docs.map(d => d.data())).includes("654321"));
  const settings = await api("adminA", "getSettings", { facilityId: F });
  assert.equal(settings.accessCodeSet, true);
  assert.ok(!JSON.stringify(settings).includes(stored.hash));
});

test("台紙の注意事項: 初期値は2行。施設ごとに保存し、編集は管理者・副管理者だけ。空欄も保存でき、150文字を超えると拒否する", async () => {
  const DEFAULT = "挿入されなかったレンズのシールには上から大きく×を書く\n前回使用した台紙は、次の手術日の朝に撮影・送信する";
  const note = async (uid, fid) => (await api(uid, "getSettings", { facilityId: fid })).sheetNote;
  assert.equal(await note("adminA", F), DEFAULT);
  assert.equal(await note("ordA", F), DEFAULT, "印刷するので所属者全員に返す");
  await rejects(api("ordA", "setSheetNote", { facilityId: F, note: "x" }), "permission-denied");
  await rejects(api("adminB", "setSheetNote", { facilityId: F, note: "x" }), "permission-denied");
  await rejects(api("staffX", "setSheetNote", { facilityId: F, note: "x" }), "permission-denied");
  await rejects(api("adminA", "setSheetNote", { facilityId: F, note: 1 }), "invalid-argument");
  await rejects(api("adminA", "setSheetNote", { facilityId: F }), "invalid-argument");
  await rejects(api("adminA", "setSheetNote", { facilityId: F, note: "x", extra: 1 }), "invalid-argument");
  await rejects(api("adminA", "setSheetNote", { facilityId: F, note: "あ".repeat(151) }), "invalid-argument");
  assert.equal((await db.doc(`facilities/${F}/stickerSettings/sheet`).get()).exists, false, "拒否したときは保存しない");

  assert.deepEqual(await api("subA", "setSheetNote", { facilityId: F, note: "1行目\r\n2行目\n \n" }), { ok: true, sheetNote: "1行目\n2行目" });
  assert.equal(await note("ordA", F), "1行目\n2行目");
  assert.equal(await note("adminB", G), DEFAULT, "ほかの施設と混ざらない");
  await api("adminA", "setSheetNote", { facilityId: F, note: "あ".repeat(150) });
  assert.equal((await note("adminA", F)).length, 150);
  await api("adminA", "setSheetNote", { facilityId: F, note: "" });
  assert.equal(await note("adminA", F), "", "空欄は初期値に戻さない");

  const logs = (await db.collection("stickerAuditLogs").get()).docs.map(d => d.data()).filter(l => l.action === "sheet.note");
  assert.equal(logs.length, 3);
  assert.equal(logs[0].facilityId, F);
  await rejects(api("adminA", "setSheetNote", { facilityId: F, note: "x" }, mk({ isEnabled: () => false })), "failed-precondition");
  await rejects(api("adminA", "setSheetNote", { facilityId: F, note: "x" }, mk({ facilityIds: () => [] })), "permission-denied");
});

test("QR: 所属者が取得でき、SVG の中身は URL だけ。作り直しは管理者・副管理者だけで、旧トークンは確実に無効になる", async () => {
  await rejects(api("adminB", "getEntryQr", { facilityId: F }), "permission-denied");
  await rejects(api("staffX", "getEntryQr", { facilityId: F }), "permission-denied");
  await rejects(api("ordA", "rotateEntryQr", { facilityId: F }), "permission-denied");
  await rejects(api("adminB", "rotateEntryQr", { facilityId: F }), "permission-denied");
  const first = await api("adminA", "getEntryQr", { facilityId: F });
  assert.ok(first.svg.includes(`sticker.html#f=${TOKEN}`));
  assert.ok(first.url.endsWith(`sticker.html#f=${TOKEN}`) && first.svg.includes(first.url), "リンクの URL は QR に符号化した値と同じ");
  assert.ok(!first.svg.includes(F) && !first.svg.includes(CODE));
  const again = await api("subA", "getEntryQr", { facilityId: F });
  assert.equal(again.svg, first.svg, "作り直すまで同じ");
  const rotated = await api("adminA", "rotateEntryQr", { facilityId: F });
  assert.notEqual(rotated.svg, first.svg);
  assert.notEqual(rotated.url, first.url);
  assert.ok(rotated.svg.includes(rotated.url), "作り直した後のリンクも QR と同じ");
  await rejects(verify(TOKEN, CODE), "permission-denied");
  const fresh = /#f=([A-Za-z0-9_-]{22})/.exec(rotated.svg)[1];
  assert.ok((await verify(fresh, CODE)).ticket);
  assert.equal((await db.doc(`stickerEntries/${TOKEN}`).get()).get("status"), "revoked");
});

test("QR: 同時に初回の取得をしても、トークンは1つだけ発行する", async () => {
  await db.doc(`facilities/${F}/stickerSettings/entry`).delete();
  await db.doc(`stickerEntries/${TOKEN}`).delete();
  const list = await Promise.all(Array.from({ length: 6 }, () => api("adminA", "getEntryQr", { facilityId: F })));
  assert.equal(new Set(list.map(x => x.svg)).size, 1);
  const entries = await db.collection("stickerEntries").where("facilityId", "==", F).get();
  assert.equal(entries.size, 1);
});

test("QR の既定の生成: 実際の qrcode の SVG を返す", async () => {
  const r = await api("adminA", "getEntryQr", { facilityId: F }, mk({ makeQrSvg: undefined }));
  assert.ok(r.svg.startsWith("<svg") && r.svg.includes("path"));
});

// ================= 保存: 形式・容量・解像度・メタデータ =================
test("保存: Exif を除いて保存し、施設はチケットから決める。記録に幅・高さが入り、サムネイルが作られる", async () => {
  const body = withExif();
  const r = await put({ body, headers: { "X-Blur-Warned": "1", "X-Last-Surgery-Date": "2026-11-05" } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.body.created, r.body.seq, r.body.lastSurgeryDate], [true, 1, "2026-11-05"]);
  assert.equal(r.body.photoId, photoIdOf(F, uuid(1)));
  assert.equal(r.headers["access-control-allow-origin"], ORIGIN);
  const d = (await photoDoc(r.body.photoId)).data();
  assert.deepEqual([d.facilityId, d.status, d.width, d.height, d.blurWarned, d.sha256], [F, "stored", 640, 480, true, sha256Hex(body)]);
  assert.ok(d.storagePath.startsWith(`${F}/`));
  const saved = bucket.objects.get(d.storagePath).bytes;
  assert.ok(!saved.includes("GPS-SECRET"));
  assert.deepEqual(saved, baseJpeg, "画素は変えない");
  assert.equal(d.bytes, saved.length);
  const thumb = await sharp(bucket.objects.get(d.thumbPath).bytes).metadata();
  assert.deepEqual([Math.max(thumb.width, thumb.height), thumb.exif], [400, undefined]);
  assert.deepEqual(await usage(), { photos: 1, bytes: saved.length });
});

test("保存: 形式・大きさ・内容の不一致は保存しない", async () => {
  const cases = [
    [await put({ headers: { "Content-Length": undefined } }), 413],
    [await put({ headers: { "Content-Length": STICKER_LIMITS.imageBytes + 1 } }), 413],
    [await put({ headers: { "Content-Length": baseJpeg.length + 1 } }), 400],
    [await put({ sha: "0".repeat(64) }), 400],
    [await put({ sha: "xyz" }), 400],
    [await put({ uploadId: "not-a-uuid" }), 400],
    [await put({ uploadId: uuid(1).toUpperCase() }), 400],
    [await put({ body: Buffer.from("not an image at all") }), 415],
    [await put({ body: Buffer.concat([baseJpeg.subarray(0, 200)]) }), 415],
    [await put({ headers: { "X-Last-Surgery-Date": "2026-11-06" } }), 400],
    [await put({ headers: { "X-Last-Surgery-Date": "2026-13-01" } }), 400]
  ];
  for (const [res, status] of cases) assert.equal(res.statusCode, status);
  assert.equal(bucket.objects.size, 0);
  assert.equal((await db.collection(`facilities/${F}/stickerPhotos`).get()).size, 0);
});

test("保存: 1億画素を超える画像は拒否する", async () => {
  const huge = Buffer.from(baseJpeg);
  const sof = huge.indexOf(Buffer.from([0xff, 0xc0]));
  huge.writeUInt16BE(20000, sof + 5);
  huge.writeUInt16BE(20000, sof + 7);
  assert.equal((await put({ body: huge })).statusCode, 415);
});

test("CORS: 許可したオリジン以外は処理せず、OPTIONS は必要なものだけ返す。許可しないメソッドは 405", async () => {
  const other = resOf();
  await svc.handleUpload(reqOf({ headers: { Origin: "https://evil.example" }, rawBody: baseJpeg }), other);
  assert.equal(other.statusCode, 403);
  const pre = resOf();
  await svc.handleUpload(reqOf({ method: "OPTIONS", headers: { Origin: ORIGIN } }), pre);
  assert.deepEqual([pre.statusCode, pre.headers["access-control-allow-methods"], pre.headers["access-control-allow-credentials"], pre.headers.vary], [204, "PUT, OPTIONS", undefined, "Origin"]);
  assert.ok(pre.headers["access-control-allow-headers"].includes("X-Upload-Id"));
  const post = resOf();
  await svc.handleUpload(reqOf({ method: "POST", headers: { Origin: ORIGIN } }), post);
  assert.equal(post.statusCode, 405);
  const img = resOf();
  await svc.handleImage(reqOf({ method: "OPTIONS", headers: { Origin: ORIGIN } }), img);
  assert.equal(img.headers["access-control-allow-methods"], "GET, OPTIONS");
});

test("機能の停止・対象外の施設・無効な施設では保存しない", async () => {
  enabled.on = false;
  assert.equal((await put()).statusCode, 503);
  enabled.on = true;
  enabled.facilities = [G];
  assert.equal((await put()).statusCode, 403);
  enabled.facilities = [F, G];
  await db.doc(`facilities/${F}`).update({ status: "suspended" });
  assert.equal((await put()).statusCode, 403);
  assert.equal(bucket.objects.size, 0);
});

test("保存の失敗: バケットに書けなければ記録も使用量も残さず、再送できる", async () => {
  bucket.failSave = true;
  assert.equal((await put()).statusCode, 503);
  assert.equal((await db.collection(`facilities/${F}/stickerPhotos`).get()).size, 0);
  assert.equal(await usage(), undefined);
  bucket.failSave = false;
  assert.equal((await put()).body.created, true);
});

test("サムネイルの失敗: 写真の保存は成功のままで、画像の取得は原本を返す", async () => {
  const s = mk({ makeThumbnail: async () => { throw new Error("thumb failed"); } });
  const r = await put({ s });
  assert.equal(r.body.created, true);
  assert.equal((await photoDoc(r.body.photoId)).get("thumbPath"), null);
  const got = await image("ordA", { photo: r.body.photoId, size: "thumb" });
  assert.deepEqual([got.statusCode, got.body], [200, baseJpeg]);
});

// ================= 再送・セッション・上限 =================
test("再送: 同じIDは再認証の後でも同じ写真で、記録・使用量・オブジェクトを増やさない。SHA-256 が同じでもIDが違えば別の写真", async () => {
  const a = await put();
  const b = await put({ ticket: ticketFor() });
  assert.deepEqual([b.statusCode, b.body.created, b.body.photoId, b.body.takenAt], [200, false, a.body.photoId, a.body.takenAt]);
  assert.equal(originals().length, 1);
  assert.equal((await usage()).photos, 1);
  const c = await put({ uploadId: uuid(2) });
  assert.equal(c.body.created, true);
  assert.notEqual(c.body.photoId, a.body.photoId);
});

test("再送: 同じIDで内容が違えば 409 で、既存の写真を変えない", async () => {
  const a = await put();
  const path = (await photoDoc(a.body.photoId)).get("storagePath");
  const other = withExif("other");
  const r = await put({ body: other });
  assert.equal(r.statusCode, 409);
  assert.equal((await photoDoc(a.body.photoId)).get("sha256"), sha256Hex(baseJpeg));
  assert.deepEqual(bucket.objects.get(path).bytes, baseJpeg);
});

test("セッション: 最初の写真の最終手術日で固定する。2枚目以降に違う値を送っても変わらず、seq が続く", async () => {
  const ticket = ticketFor();
  const a = await put({ ticket, uploadId: uuid(1) });
  const b = await put({ ticket, uploadId: uuid(2), headers: { "X-Last-Surgery-Date": "2026-11-04" } });
  assert.deepEqual([a.body.lastSurgeryDate, b.body.lastSurgeryDate, b.body.seq], [null, null, 2]);
  const t2 = ticketFor();
  const c = await put({ ticket: t2, uploadId: uuid(3), headers: { "X-Last-Surgery-Date": "2026-11-04" } });
  const d = await put({ ticket: t2, uploadId: uuid(4), headers: { "X-Last-Surgery-Date": "2026-11-03" } });
  assert.deepEqual([c.body.lastSurgeryDate, d.body.lastSurgeryDate, d.body.seq], ["2026-11-04", "2026-11-04", 2]);
});

test("上限: セッション・1日の枚数・容量のどれを超えても 429 で、同じ文言(どの上限かは出さない)", async () => {
  const size = baseJpeg.length;
  const s = mk({ limits: { ...STICKER_LIMITS, sessionPhotos: 1 } });
  const ticket = ticketFor();
  assert.equal((await put({ s, ticket, uploadId: uuid(1) })).statusCode, 200);
  const r1 = await put({ s, ticket, uploadId: uuid(2) });
  const s2 = mk({ limits: { ...STICKER_LIMITS, dailyPhotos: 1 } });
  const r2 = await put({ s: s2, uploadId: uuid(3) });
  const s3 = mk({ limits: { ...STICKER_LIMITS, dailyBytes: size + 1 } });
  const r3 = await put({ s: s3, uploadId: uuid(4) });
  assert.deepEqual([r1.statusCode, r2.statusCode, r3.statusCode], [429, 429, 429]);
  assert.equal(new Set([r1, r2, r3].map(r => JSON.stringify(r.body))).size, 1);
  clock.t += 24 * 60 * MIN;
  assert.equal((await put({ s: s2, uploadId: uuid(5) })).statusCode, 200, "翌日は数え直す");
});

// ================= 同時送信 =================
test("同時送信: 同じ写真を20件同時に送っても、記録・使用量は1件で、残るオブジェクトは記録が指すものだけ", async () => {
  const ticket = ticketFor();
  const results = await Promise.all(Array.from({ length: 20 }, () => put({ ticket })));
  assert.ok(results.every(r => r.statusCode === 200), JSON.stringify(results.map(r => r.statusCode)));
  assert.equal(results.filter(r => r.body.created).length, 1);
  assert.equal(new Set(results.map(r => r.body.photoId)).size, 1);
  assert.equal((await db.collection(`facilities/${F}/stickerPhotos`).get()).size, 1);
  assert.equal((await usage()).photos, 1);
  const d = (await photoDoc(results[0].body.photoId)).data();
  assert.deepEqual(originals(), [d.storagePath]);
  assert.equal((await image("ordA", { photo: results[0].body.photoId })).statusCode, 200);
});

test("同時送信: 別々の写真を15件同時に送っても、上限(10枚)を超えず seq が重複しない", async () => {
  const s = mk({ limits: { ...STICKER_LIMITS, sessionPhotos: 10 } });
  const ticket = ticketFor();
  const results = await Promise.all(Array.from({ length: 15 }, (_, i) => put({ s, ticket, uploadId: uuid(i + 1) })));
  const ok = results.filter(r => r.statusCode === 200);
  assert.equal(ok.length, 10);
  assert.equal(results.filter(r => r.statusCode === 429).length, 5);
  assert.deepEqual(ok.map(r => r.body.seq).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(originals().length, 10, "上限で負けた分のオブジェクトは残らない");
  assert.equal((await usage()).photos, 10);
});

test("同時送信: 1日の容量の上限を別々のセッションからの同時送信でも超えない", async () => {
  const s = mk({ limits: { ...STICKER_LIMITS, dailyBytes: baseJpeg.length * 3 } });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => put({ s, ticket: ticketFor(), uploadId: uuid(i + 1) })));
  assert.equal(results.filter(r => r.statusCode === 200).length, 3);
  assert.equal((await usage()).bytes, baseJpeg.length * 3);
});

test("同時送信: 同じIDで内容の違う送信は1件だけ登録し、負けた送信は勝った写真を消さない", async () => {
  const bodies = Array.from({ length: 6 }, (_, i) => withExif(String(i)));
  const results = await Promise.all(bodies.map(body => put({ body })));
  assert.equal(results.filter(r => r.statusCode === 200 && r.body.created).length, 1);
  assert.equal(results.filter(r => r.statusCode === 409).length, 5);
  const id = photoIdOf(F, uuid(1));
  const d = (await photoDoc(id)).data();
  assert.deepEqual(originals(), [d.storagePath]);
  assert.equal((await image("ordA", { photo: id })).statusCode, 200);
});

test("上限で負けた送信は、同じ写真を別のセッションから保存した送信のオブジェクトを消さない", async () => {
  const s = mk({ limits: { ...STICKER_LIMITS, sessionPhotos: 1 } });
  const ticket = ticketFor();
  const gates = [latch(), latch()];
  let arrived = 0;
  bucket.gate = async () => { const g = gates[arrived]; arrived += 1; if (g) await g.opened; };
  const loser = put({ s, ticket, uploadId: uuid(1) });           // セッション A
  await until(() => arrived === 1);
  const winner = put({ s, ticket: ticketFor(), uploadId: uuid(1) });   // 同じ写真を、再認証の後のセッション B から
  await until(() => arrived === 2);
  bucket.gate = null;
  assert.equal((await put({ s, ticket, uploadId: uuid(2) })).statusCode, 200);   // セッション A が上限に達する
  gates[0].open();
  assert.equal((await loser).statusCode, 429);
  gates[1].open();
  const r = await winner;
  assert.equal(r.body.created, true);
  const d = (await photoDoc(r.body.photoId)).data();
  assert.ok(bucket.objects.has(d.storagePath), "保存済みの写真は消えない");
  assert.equal((await image("ordA", { photo: r.body.photoId })).statusCode, 200);
});

// ================= 削除との競合 =================
test("削除: 管理者・副管理者だけが削除でき、画像が消える。削除した写真は再送しても復活しない", async () => {
  const r = await put();
  const id = r.body.photoId;
  await rejects(api("ordA", "delete", { facilityId: F, photoId: id }), "permission-denied");
  await rejects(api("adminB", "delete", { facilityId: F, photoId: id }), "permission-denied");
  await rejects(api("adminB", "delete", { facilityId: G, photoId: id }), "not-found");
  await api("subA", "delete", { facilityId: F, photoId: id });
  assert.equal(bucket.objects.size, 0);
  const d = (await photoDoc(id)).data();
  assert.deepEqual([d.status, d.deleted.by], ["deleted", "subA"]);
  const again = await put({ ticket: ticketFor() });
  assert.deepEqual([again.statusCode, again.body.created], [200, false]);
  assert.equal((await photoDoc(id)).get("status"), "deleted");
  assert.equal(bucket.objects.size, 0, "再送の画像は保存されない");
  assert.equal((await image("ordA", { photo: id })).statusCode, 404);
  assert.deepEqual((await api("ordA", "list", { facilityId: F })).photos, []);
  assert.deepEqual(await api("adminA", "delete", { facilityId: F, photoId: id }), { ok: true }, "もう一度の削除は成功のまま");
});

test("削除との競合: 保存の途中で写真が削除されても、復活せず、途中の画像も残らない", async () => {
  const first = await put();
  const id = first.body.photoId;
  // 1枚目の記録がまだ見えない前提で、もう1つの送信を保存の直前まで進める
  await db.doc(`facilities/${F}/stickerPhotos/${id}`).delete();
  const saved = [...bucket.objects.keys()];
  const g = latch();
  let reached = false;
  bucket.gate = async () => { reached = true; await g.opened; };
  const racing = put({ ticket: ticketFor() });
  await until(() => reached);
  bucket.gate = null;
  await db.doc(`facilities/${F}/stickerPhotos/${id}`).set({ facilityId: F, sha256: sha256Hex(baseJpeg), status: "stored", storagePath: saved.find(n => !n.endsWith("_thumb.jpg")), thumbPath: saved.find(n => n.endsWith("_thumb.jpg")), takenAt: Timestamp.fromMillis(clock.t) });
  await api("adminA", "delete", { facilityId: F, photoId: id });
  g.open();
  const r = await racing;
  assert.deepEqual([r.statusCode, r.body.created], [200, false]);
  assert.equal((await photoDoc(id)).get("status"), "deleted");
  assert.equal(bucket.objects.size, 0, "途中で保存した画像も消える");
});

test("削除との競合: サムネイルの作成中に削除されても、サムネイルを残さない", async () => {
  const g = latch();
  let reached = false;
  const s = mk({ makeThumbnail: async () => { reached = true; await g.opened; return Buffer.from("thumb"); } });
  const racing = put({ s });
  await until(() => reached);
  await api("adminA", "delete", { facilityId: F, photoId: photoIdOf(F, uuid(1)) });
  g.open();
  assert.equal((await racing).body.created, true);
  assert.equal(bucket.objects.size, 0);
});

test("削除: 画像の削除に失敗しても記録は deleted のままで見えず、片付けが消す", async () => {
  const r = await put();
  bucket.failDelete = true;
  await api("adminA", "delete", { facilityId: F, photoId: r.body.photoId });
  bucket.failDelete = false;
  assert.equal((await image("ordA", { photo: r.body.photoId })).statusCode, 404);
  assert.equal(bucket.objects.size, 2);
  clock.t += 25 * 60 * MIN;
  assert.equal((await svc.cleanup()).removedObjects, 2);
  assert.equal(bucket.objects.size, 0);
});

// ================= 一覧・施設の分離 =================
test("一覧: 自施設の所属者だけ。返す項目は列挙したものだけで、保存先・アップロードID・SHA-256 は返さない", async () => {
  const r = await put({ headers: { "X-Blur-Warned": "1" } });
  await put({ ticket: ticketFor(G), uploadId: uuid(9) });
  const { photos, nextCursor } = await api("proxyA", "list", { facilityId: F });
  assert.equal(nextCursor, null);
  assert.equal(photos.length, 1);
  assert.deepEqual(Object.keys(photos[0]).sort(), ["blurWarned", "height", "lastSurgeryDate", "photoId", "seq", "sessionId", "takenAt", "width"]);
  assert.deepEqual([photos[0].photoId, photos[0].blurWarned], [r.body.photoId, true]);
  await rejects(api("adminB", "list", { facilityId: F }), "permission-denied");
  await rejects(api("nobody", "list", { facilityId: F }), "permission-denied");
  await rejects(api(null, "list", { facilityId: F }), "unauthenticated");
  await rejects(svc.api({ auth: user("ordA", { email_verified: false }), data: { action: "list", facilityId: F } }), "permission-denied");
  await db.doc(`facilities/${F}`).update({ status: "suspended" });
  await rejects(api("ordA", "list", { facilityId: F }), "permission-denied");
});

test("一覧: 運営者でも所属がなければ読めない。未知の項目・処理は拒否する", async () => {
  await rejects(svc.api({ auth: user("op", { platformAdmin: true }), data: { action: "list", facilityId: F } }), "permission-denied");
  await rejects(api("ordA", "list", { facilityId: F, extra: 1 }), "invalid-argument");
  await rejects(api("ordA", "unknown"), "invalid-argument");
  await rejects(api("ordA", "list", { facilityId: F, from: "2026/11/01" }), "invalid-argument");
});

test("一覧: 期間と続きの読み込み。別の施設の写真をカーソルに使えない", async () => {
  const s = mk({ limits: { ...STICKER_LIMITS, listPageSize: 2 } });
  const ids = [];
  for (let i = 0; i < 5; i += 1) { ids.push((await put({ uploadId: uuid(i + 1) })).body.photoId); clock.t += MIN; }
  const other = await put({ ticket: ticketFor(G), uploadId: uuid(9) });
  const seen = [];
  let cursor;
  for (let i = 0; i < 3; i += 1) {
    const page = await api("ordA", "list", { facilityId: F, ...(cursor ? { cursor } : {}) }, s);
    seen.push(...page.photos.map(p => p.photoId));
    cursor = page.nextCursor;
  }
  assert.deepEqual(seen, [...ids].reverse());
  assert.equal(cursor, null);
  await rejects(api("ordA", "list", { facilityId: F, cursor: other.body.photoId }), "invalid-argument");
  assert.equal((await api("ordA", "list", { facilityId: F, from: "2026-11-06" })).photos.length, 0);
  assert.equal((await api("ordA", "list", { facilityId: F, to: "2026-11-04" })).photos.length, 0);
  assert.equal((await api("ordA", "list", { facilityId: F, from: "2026-11-05", to: "2026-11-05" })).photos.length, 5);
});

test("施設の分離: 同じアップロードIDでも別の写真。別の施設の所属者はチケットも画像も使えない", async () => {
  const a = await put({ ticket: ticketFor(F) });
  const b = await put({ ticket: ticketFor(G) });
  assert.notEqual(a.body.photoId, b.body.photoId);
  assert.equal(b.body.created, true);
  assert.equal((await image("adminB", { facility: F, photo: a.body.photoId })).statusCode, 404);
  assert.equal((await image("adminB", { facility: G, photo: a.body.photoId })).statusCode, 404, "施設を変えても別の施設の写真は読めない");
  assert.equal((await image("adminA", { facility: F, photo: b.body.photoId })).statusCode, 404);
});

// ================= 画像の取得 =================
test("画像: ログイン必須で、キャッシュさせない。サムネイルと原本を返す", async () => {
  const r = await put();
  const noAuth = await image(null, { photo: r.body.photoId });
  assert.equal(noAuth.statusCode, 401);
  assert.equal(noAuth.headers["cache-control"], "private, no-store");
  const badToken = resOf();
  await svc.handleImage(reqOf({ method: "GET", query: { facility: F, photo: r.body.photoId }, headers: { Authorization: "Bearer forged" } }), badToken);
  assert.equal(badToken.statusCode, 401);
  const full = await image("ordA", { photo: r.body.photoId });
  assert.deepEqual([full.statusCode, full.body, full.headers["content-type"], full.headers["cache-control"], full.headers["x-content-type-options"]], [200, baseJpeg, "image/jpeg", "private, no-store", "nosniff"]);
  const thumb = await image("ordA", { photo: r.body.photoId, size: "thumb" });
  assert.equal(thumb.statusCode, 200);
  assert.notDeepEqual(thumb.body, baseJpeg);
});

test("画像: 見えない理由で応答を変えない(未所属・形式違い・存在しない写真・施設の対象外はすべて 404)", async () => {
  const r = await put();
  const id = r.body.photoId;
  const results = [
    await image("nobody", { photo: id }), await image("ordA", { photo: "0".repeat(64) }), await image("ordA", { photo: "x" }),
    await image("ordA", { photo: id, size: "huge" }), await image("ordA", { facility: "../fA", photo: id })
  ];
  enabled.facilities = [G];
  results.push(await image("ordA", { photo: id }));
  assert.ok(results.every(x => x.statusCode === 404), JSON.stringify(results.map(x => x.statusCode)));
  assert.equal(new Set(results.map(x => JSON.stringify(x.body))).size, 1);
});

test("画像: 所属を外されると次の要求から読めない(毎回確かめる)", async () => {
  const r = await put();
  assert.equal((await image("ordA", { photo: r.body.photoId })).statusCode, 200);
  await db.doc(`facilities/${F}/members/ordA`).delete();
  assert.equal((await image("ordA", { photo: r.body.photoId })).statusCode, 404);
});

// ================= ディーラーの閲覧(受注閲覧の権限と独立) =================
const dealerHeaders = { "X-Dealer-Company": "cX", "X-Dealer-Device": "device" };
const dealerList = (data = {}) => api("staffX", "dealerList", { companyId: "cX", ...data });
const share = (shared, uid = "subA") => api(uid, "setDealerShare", { facilityId: F, localDealerId: "dA", shared });

test("共有: 管理者・副管理者だけが許可でき、関連付けのない発注先は許可できない。許可前の写真は見えない", async () => {
  await rejects(share(true, "ordA"), "permission-denied");
  await rejects(share(true, "adminB"), "permission-denied");
  await db.doc(`facilities/${F}/facilityDealers/dNone`).set({ facilityId: F, name: "未関連付け" });
  await rejects(api("adminA", "setDealerShare", { facilityId: F, localDealerId: "dNone", shared: true }), "failed-precondition");
  const before = await put({ uploadId: uuid(1) });
  clock.t += MIN;
  await share(true);
  clock.t += MIN;
  const after = await put({ uploadId: uuid(2) });
  const r = await dealerList({ facilityId: F });
  assert.deepEqual(r.photos.map(p => p.photoId), [after.body.photoId]);
  assert.deepEqual(r.facilities, [{ facilityId: F, name: "fA眼科" }]);
  assert.equal((await image("staffX", { photo: after.body.photoId, headers: dealerHeaders })).statusCode, 200);
  assert.equal((await image("staffX", { photo: before.body.photoId, headers: dealerHeaders })).statusCode, 404);
});

test("独立: 受注閲覧の許可があっても写真は見えず、写真の許可は受注の許可を作らない", async () => {
  const r = await put();
  // 受注閲覧を許可中(既存の形)。写真の許可はない
  await db.doc(`facilities/${F}/dealerPortalLinks/dA`).update({ status: "active", currentGrantId: "gOrder" });
  await db.doc("dealerPortalGrants/gOrder").set({ companyId: "cX", facilityId: F, localDealerId: "dA", status: "active", effectiveFrom: Timestamp.fromMillis(T0 - MIN) });
  assert.deepEqual((await dealerList()).facilities, []);
  await rejects(dealerList({ facilityId: F }), "permission-denied");
  assert.equal((await image("staffX", { photo: r.body.photoId, headers: dealerHeaders })).statusCode, 404);
  // 受注の許可を消して、写真だけを許可する
  await db.doc("dealerPortalGrants/gOrder").delete();
  await db.doc(`facilities/${F}/dealerPortalLinks/dA`).update({ status: "proposed", currentGrantId: null });
  await share(true);
  assert.equal((await db.collection("dealerPortalGrants").get()).size, 0, "写真の許可は dealerPortalGrants に入らない");
  const link = (await db.doc(`facilities/${F}/dealerPortalLinks/dA`).get()).data();
  assert.deepEqual([link.status, link.currentGrantId], ["proposed", null], "関連付けを変えない");
  const portal = createDealerPortalService({ db, FieldValue, Timestamp, FieldPath });
  assert.equal((await portal.allowedScope("cX")).size, 0, "受注の閲覧範囲に入らない");
});

test("独立: 受注閲覧を取り消しても写真の共有は続き、写真の共有を取り消しても受注の許可に触らない", async () => {
  await share(true);
  clock.t += MIN;
  const r = await put();
  await db.doc(`facilities/${F}/dealerPortalLinks/dA`).update({ status: "revoked", currentGrantId: null });   // 受注閲覧の取消
  assert.deepEqual((await dealerList({ facilityId: F })).photos.map(p => p.photoId), [r.body.photoId]);
  await db.doc("dealerPortalGrants/gOrder").set({ companyId: "cX", facilityId: F, localDealerId: "dA", status: "active" });
  await share(false);
  assert.equal((await db.doc("dealerPortalGrants/gOrder").get()).get("status"), "active");
  assert.equal((await image("staffX", { photo: r.body.photoId, headers: dealerHeaders })).statusCode, 404, "取消はすぐ反映される");
  assert.deepEqual((await dealerList()).facilities, []);
});

test("共有: 再び許可すると、それ以前と取消の間の写真は見えない", async () => {
  await share(true);
  clock.t += MIN;
  const during = await put({ uploadId: uuid(1) });
  await share(false);
  clock.t += MIN;
  const revokedTime = await put({ uploadId: uuid(2) });
  clock.t += MIN;
  await share(true);
  clock.t += MIN;
  const after = await put({ uploadId: uuid(3) });
  assert.deepEqual((await dealerList({ facilityId: F })).photos.map(p => p.photoId), [after.body.photoId]);
  for (const r of [during, revokedTime]) assert.equal((await image("staffX", { photo: r.body.photoId, headers: dealerHeaders })).statusCode, 404);
});

test("共有: 発注先の変更・関連付けの会社の変更の後は公開を止める。別の会社・未確認の担当者は読めない", async () => {
  await share(true);
  clock.t += MIN;
  const r = await put();
  await rejects(api("stranger", "dealerList", { companyId: "cX" }), "permission-denied");
  assert.equal((await image("stranger", { photo: r.body.photoId, headers: dealerHeaders })).statusCode, 404);
  assert.equal((await image("staffX", { photo: r.body.photoId, headers: { ...dealerHeaders, "X-Dealer-Company": "cY" } })).statusCode, 404);
  await db.doc(`facilities/${F}/dealerPortalLinks/dA`).update({ companyId: "cY" });
  assert.deepEqual((await dealerList()).facilities, []);
  await db.doc(`facilities/${F}/dealerPortalLinks/dA`).update({ companyId: "cX" });
  assert.equal((await dealerList()).facilities.length, 1);
  await db.doc(`facilities/${F}/facilityDealers/dA`).update({ orderEmails: ["changed@example.jp"] });
  assert.deepEqual((await dealerList()).facilities, [], "発注先の識別項目が変わると止まる");
  assert.equal((await api("adminA", "getSettings", { facilityId: F })).dealers[0].stale, true);
});

test("ディーラーは削除・設定の操作ができず、一覧の項目も医療機関と同じ列挙だけ", async () => {
  await share(true);
  clock.t += MIN;
  const r = await put();
  await rejects(api("staffX", "delete", { facilityId: F, photoId: r.body.photoId }), "permission-denied");
  await rejects(api("staffX", "getSettings", { facilityId: F }), "permission-denied");
  const { photos } = await dealerList({ facilityId: F });
  assert.deepEqual(Object.keys(photos[0]).sort(), ["blurWarned", "height", "lastSurgeryDate", "photoId", "seq", "sessionId", "takenAt", "width"]);
});

test("設定の表示: 関連付け・共有の状態を返し、コードのハッシュは返さない", async () => {
  await share(true);
  const s = await api("adminA", "getSettings", { facilityId: F });
  assert.deepEqual([s.accessCodeSet, s.entryIssued], [true, true]);
  assert.deepEqual([s.dealers[0].localDealerId, s.dealers[0].linked, s.dealers[0].shared, s.dealers[0].stale, s.dealers[0].companyName], ["dA", true, true, false, "X商事"]);
  assert.equal(s.canManage, true);
  await rejects(api("adminB", "getSettings", { facilityId: F }), "permission-denied");
});

// ================= 片付け =================
test("片付け: 記録のない古いオブジェクトだけを消し、新しいもの・記録のあるもの・形の違うものは残す", async () => {
  const r = await put();
  const d = (await photoDoc(r.body.photoId)).data();
  const orphan = `${F}/${"a".repeat(64)}_${"b".repeat(16)}.jpg`;
  bucket.objects.set(orphan, { bytes: Buffer.from("x"), updatedMs: clock.t });
  bucket.objects.set("other/file.txt", { bytes: Buffer.from("x"), updatedMs: clock.t });
  const replaced = `${F}/${r.body.photoId}_${"c".repeat(16)}.jpg`;   // 同じ写真の、記録を作れなかった試行
  bucket.objects.set(replaced, { bytes: Buffer.from("x"), updatedMs: clock.t });
  assert.equal((await svc.cleanup()).removedObjects, 0, "送信中かもしれない新しいものは消さない");
  clock.t += 25 * 60 * MIN;
  assert.equal((await svc.cleanup()).removedObjects, 2);
  assert.deepEqual([...bucket.objects.keys()].sort(), [d.storagePath, d.thumbPath, "other/file.txt"].sort());
});

test("片付け: 期限切れの回数制限の記録だけを消す", async () => {
  await rejects(verify(TOKEN, "999999"), "permission-denied");
  assert.equal((await db.collection("stickerRateLimits").get()).size, 3, "送信元・トークン(短い窓)・トークン(24時間)");
  assert.equal((await svc.cleanup()).removedLimits, 0);
  clock.t += STICKER_RATE_LIMITS.windowMs + 1;
  assert.equal((await svc.cleanup()).removedLimits, 2);
  assert.equal((await db.collection("stickerRateLimits").get()).size, 1, "24時間の窓の記録は残る");
  clock.t += STICKER_RATE_LIMITS.dayWindowMs;
  assert.equal((await svc.cleanup()).removedLimits, 1);
  assert.equal((await db.collection("stickerRateLimits").get()).size, 0);
  const summary = (await db.collection("stickerAuditLogs").where("action", "==", "verify.daySummary").get()).docs.map(d => d.data());
  assert.deepEqual(summary.map(d => [d.tokenHash, d.failures]), [[rateLimitDocId("tokenDay", TOKEN), 1]], "消す前に、その日の失敗の数を監査に残す");
});

// ================= バケットの部品 =================
test("バケットの部品: 保存はキャッシュ禁止、ないものの読み出しは null、削除は存在しなくても成功、一覧はページごと", async () => {
  const calls = [];
  const file = (name) => ({
    save: async (bytes, opts) => calls.push(["save", name, opts]),
    download: async () => { if (name === "none") throw Object.assign(new Error("x"), { code: 404 }); if (name === "boom") throw new Error("boom"); return [Buffer.from("ok")]; },
    delete: async (opts) => calls.push(["delete", name, opts])
  });
  const b = createStickerBucket(() => ({ file, getFiles: async (q) => [[{ name: "a", metadata: { updated: "2026-11-05T00:00:00Z" } }], q.pageToken ? null : { pageToken: "n" }] }));
  await b.save("x.jpg", Buffer.from("x"));
  assert.deepEqual(calls[0][2], { resumable: false, contentType: "image/jpeg", metadata: { cacheControl: "private, no-store" } });
  assert.deepEqual(await b.read("y"), Buffer.from("ok"));
  assert.equal(await b.read("none"), null);
  await assert.rejects(b.read("boom"));
  await b.delete("x.jpg");
  assert.deepEqual(calls[1][2], { ignoreNotFound: true });
  const page = await b.list();
  assert.deepEqual([page.items[0].name, page.nextPageToken], ["a", "n"]);
  assert.equal((await b.list({ pageToken: "n" })).nextPageToken, null);
});

// ================= 入口トークンごとの 24 時間の失敗の上限 =================
const DAY_KEY = rateLimitDocId("tokenDay", TOKEN);
const auditOf = async (action) => (await db.collection("stickerAuditLogs").where("action", "==", action).get()).docs.map(d => d.data());
/** 短い窓の制限にかからない速さ(10 分に 10 回)で、誤ったコードを n 回送る。送信元は毎回変える */
async function slowFailures(n, token = TOKEN) {
  for (let i = 0; i < n; i += 1) {
    if (i > 0 && i % STICKER_RATE_LIMITS.tokenMax === 0) clock.t += STICKER_RATE_LIMITS.windowMs + 1;
    await rejects(verify(token, String(100000 + i), "198.51.100." + (i % 250)), "permission-denied");
  }
  clock.t += STICKER_RATE_LIMITS.windowMs + 1;
}

test("24時間の上限: 短い窓の制限を避けた低速の総当たりも 50 回で止まり、正しいコードも通らない。ほかの施設には波及しない", async () => {
  await slowFailures(STICKER_RATE_LIMITS.tokenDayMax);
  assert.equal(codeChecks.n, STICKER_RATE_LIMITS.tokenDayMax);
  await rejects(verify(TOKEN, CODE, "203.0.113.1"), "resource-exhausted");
  await rejects(verify(TOKEN, CODE, "203.0.113.2"), "resource-exhausted");
  assert.equal(codeChecks.n, STICKER_RATE_LIMITS.tokenDayMax, "停止の後はコードを確かめない");
  clock.t += 23 * 60 * MIN;
  await rejects(verify(TOKEN, CODE, "203.0.113.3"), "resource-exhausted");
  assert.ok((await verify(TOKEN_B, CODE, "203.0.113.1")).ticket, "別の施設の QR は使える");
  // 監査: 停止の範囲・トークンのハッシュ・失敗の数。コードとトークンの平文は残さない
  const blocked = await auditOf("verify.blocked");
  assert.equal(blocked.length, 1);
  assert.deepEqual([blocked[0].scopes, blocked[0].tokenHash, blocked[0].dayFailures], [["tokenDay"], DAY_KEY, STICKER_RATE_LIMITS.tokenDayMax + 1]);
  const all = JSON.stringify((await db.collection("stickerAuditLogs").get()).docs.map(d => d.data())) + JSON.stringify((await db.collection("stickerRateLimits").get()).docs.map(d => [d.id, d.data()]));
  for (const secret of [TOKEN, "198.51.100.", "203.0.113."]) assert.ok(!all.includes(secret), "平文を残さない: " + secret);
  const keys = new Set((await db.collection("stickerAuditLogs").get()).docs.flatMap(d => Object.keys(d.data())));
  for (const k of keys) assert.ok(["action", "at", "ipHash", "scopes", "tokenHash", "dayFailures", "facilityId", "sessionId"].includes(k), "監査の項目: " + k);
});

test("24時間の上限: 時間が過ぎると戻り、その日の失敗の数を監査に残す", async () => {
  await slowFailures(STICKER_RATE_LIMITS.tokenDayMax);
  await rejects(verify(TOKEN, CODE), "resource-exhausted");
  clock.t += STICKER_RATE_LIMITS.dayBlockMs + 1;
  assert.ok((await verify(TOKEN, CODE)).ticket);
  assert.deepEqual((await auditOf("verify.daySummary")).map(d => [d.tokenHash, d.failures]), [[DAY_KEY, STICKER_RATE_LIMITS.tokenDayMax + 1]]);
});

test("24時間の上限: 正しい入力は数えない。誤入力をはさんだ通常の利用が続いても止まらない", async () => {
  for (let i = 0; i < 70; i += 1) {
    clock.t += 2 * MIN;
    if (i % 3 === 0) await rejects(verify(TOKEN, "999999"), "permission-denied");   // ときどき打ち間違える(1 日で 24 回)
    assert.ok((await verify(TOKEN, CODE)).ticket);
  }
  const day = await db.doc("stickerRateLimits/" + DAY_KEY).get();
  assert.ok(day.get("count") < STICKER_RATE_LIMITS.tokenDayMax);
  assert.deepEqual(await auditOf("verify.blocked"), []);
});

test("復旧: 管理者・副管理者がコードを変更すると、停止はすぐに解ける。権限のない人は解除できず、解除は監査に残る", async () => {
  await slowFailures(STICKER_RATE_LIMITS.tokenDayMax);
  await rejects(verify(TOKEN, CODE), "resource-exhausted");
  const before = await api("adminA", "getSettings", { facilityId: F });
  assert.equal(before.verifyBlockedUntil, new Date(clock.t + STICKER_RATE_LIMITS.dayBlockMs).toISOString());
  assert.equal(before.verifyFailures24h, STICKER_RATE_LIMITS.tokenDayMax + 1);
  assert.equal((await api("adminB", "getSettings", { facilityId: G })).verifyBlockedUntil, null, "別の施設の表示には出ない");
  // 注文者・別の施設の管理者は解除できない
  await rejects(api("ordA", "setAccessCode", { facilityId: F, code: "135790" }), "permission-denied");
  await rejects(api("adminB", "setAccessCode", { facilityId: F, code: "135790" }), "permission-denied");
  await rejects(verify(TOKEN, CODE), "resource-exhausted");
  // 副管理者が変更 → すぐに新しいコードで通る。古いコードは通らない
  await api("subA", "setAccessCode", { facilityId: F, code: "135790" });
  await rejects(verify(TOKEN, CODE), "permission-denied");
  assert.ok((await verify(TOKEN, "135790")).ticket);
  const after = await api("adminA", "getSettings", { facilityId: F });
  assert.deepEqual([after.verifyBlockedUntil, after.verifyFailures24h], [null, 1]);
  const change = (await auditOf("code.change"))[0];
  assert.deepEqual([change.limitsCleared, change.wasBlocked, change.clearedDayFailures, change.actorUid], [true, true, STICKER_RATE_LIMITS.tokenDayMax + 1, "subA"]);
  assert.ok(!JSON.stringify(change).includes("135790"));
  // 解除の後も制限は効く(新しいコードへの総当たりも 50 回で止まる。解除の後の失敗は、上の 1 回とここの 49 回)
  clock.t += STICKER_RATE_LIMITS.windowMs + 1;
  await slowFailures(STICKER_RATE_LIMITS.tokenDayMax - 1);
  await rejects(verify(TOKEN, "999999"), "resource-exhausted");
  await rejects(verify(TOKEN, "135790"), "resource-exhausted");
});

test("復旧: QR を作り直すと、新しい QR は同じコードですぐに使える。停止した古い QR は無効のまま", async () => {
  await slowFailures(STICKER_RATE_LIMITS.tokenDayMax);
  await rejects(verify(TOKEN, CODE), "resource-exhausted");
  const svg = (await api("adminA", "rotateEntryQr", { facilityId: F })).svg;
  const fresh = /#f=([A-Za-z0-9_-]{22})/.exec(svg)[1];
  assert.ok((await verify(fresh, CODE)).ticket);
  clock.t += STICKER_RATE_LIMITS.dayBlockMs + 1;
  await rejects(verify(TOKEN, CODE), "permission-denied");
});

test("コードの変更: 停止していなくても短い窓の停止を解き、送信元の制限は解かない", async () => {
  for (let i = 0; i <= STICKER_RATE_LIMITS.tokenMax; i += 1) await verify(TOKEN, "999999", "203.0.113." + i).catch(() => {});
  await rejects(verify(TOKEN, CODE, "203.0.113.99"), "resource-exhausted");
  await api("adminA", "setAccessCode", { facilityId: F, code: "135790" });
  assert.ok((await verify(TOKEN, "135790", "203.0.113.99")).ticket);
  // 送信元の制限は残る
  for (let i = 0; i <= STICKER_RATE_LIMITS.ipMax; i += 1) await verify(newEntryToken(), CODE, "192.0.2.77").catch(() => {});
  await api("adminA", "setAccessCode", { facilityId: F, code: "246802" });
  await rejects(verify(TOKEN, "246802", "192.0.2.77"), "resource-exhausted");
});

// ================= 共有の許可の記録と、施設・発注先の一致 =================
test("共有の許可: 記録の中の施設・発注先が違えば使わない。読まず、取り消さず、上書きもしない", async () => {
  const r = await put();
  await share(true);
  const ref = db.doc("stickerPhotoGrants/" + F + "_dA");
  const good = (await ref.get()).data();
  // 同じ ID に、別の施設の内容の記録がある状態
  for (const wrong of [{ facilityId: G }, { localDealerId: "dZ" }]) {
    await ref.set({ ...good, ...wrong });
    assert.deepEqual((await dealerList()).facilities, [], JSON.stringify(wrong));
    await rejects(dealerList({ facilityId: F }), "permission-denied");
    await rejects(dealerList({ facilityId: G }), "permission-denied");
    assert.equal((await image("staffX", { photo: r.body.photoId, headers: dealerHeaders })).statusCode, 404);
    const s = await api("adminA", "getSettings", { facilityId: F });
    assert.deepEqual([s.dealers[0].shared, s.dealers[0].stale], [false, false]);
    await rejects(share(true), "failed-precondition");
    await rejects(share(false), "failed-precondition");
    assert.deepEqual((await ref.get()).data(), { ...good, ...wrong }, "記録を変えない");
  }
  // ID と中身が一致する記録は、これまでどおり
  await ref.set(good);
  assert.deepEqual((await dealerList()).facilities.map(f => f.facilityId), [F]);
  // 中身は正しいが、別の ID に置かれた記録も使わない
  await ref.delete();
  await db.doc("stickerPhotoGrants/other").set(good);
  assert.deepEqual((await dealerList()).facilities, []);
});

// ================= メニューの表示のための問い合わせ =================
test("利用できる施設か: 所属していて、機能と施設が有効なときだけ true。理由は区別せず、権限の代わりにはならない", async () => {
  const status = (uid, fid = F) => api(uid, "status", { facilityId: fid });
  for (const uid of ["adminA", "subA", "ordA", "proxyA"]) assert.deepEqual(await status(uid), { enabled: true }, uid);
  assert.deepEqual(await status("adminB"), { enabled: false }, "別の施設の所属者");
  assert.deepEqual(await status("staffX"), { enabled: false }, "ディーラーの担当者");
  assert.deepEqual(await status("adminA", "nope"), { enabled: false });
  assert.deepEqual(await svc.api({ auth: user("adminA", { email_verified: false }), data: { action: "status", facilityId: F } }), { enabled: false }, "メール未確認");
  await rejects(api(null, "status", { facilityId: F }), "unauthenticated");
  await rejects(api("adminA", "status", { facilityId: F, extra: 1 }), "invalid-argument");
  // 対象の施設から外す → その施設だけ false(ほかの施設は変わらない)
  enabled.facilities = [G];
  assert.deepEqual([await status("adminA"), await status("adminB", G)], [{ enabled: false }, { enabled: true }]);
  // 機能の停止中はエラーにせず false。ほかの処理は停止のエラーのまま
  enabled.facilities = [F, G];
  enabled.on = false;
  assert.deepEqual(await status("adminA"), { enabled: false });
  await rejects(api("adminA", "list", { facilityId: F }), "failed-precondition");
  // 施設が停止 → false
  enabled.on = true;
  await db.doc("facilities/" + F).update({ status: "suspended" });
  assert.deepEqual(await status("adminA"), { enabled: false });
});

test("ディーラーのメニュー: 共有を許可された施設があるときだけ施設が返り、取り消すと空に戻る", async () => {
  assert.deepEqual((await dealerList()).facilities, []);
  await share(true);
  assert.equal((await dealerList()).facilities.length, 1);
  await share(false);
  assert.deepEqual((await dealerList()).facilities, []);
});

// ================= 機能の停止中の、外部から呼べる入口 =================
test("機能の停止中: ログインなしで呼べる確認・保存と、画像・API は、正しいコード・チケット・所属があっても拒否し、写真を読み書きしない", async () => {
  const stored = await put();   // 有効な間に保存した写真
  assert.equal(stored.statusCode, 200);
  await share(true);
  const ticket = ticketFor();
  const before = { objects: bucket.objects.size, photos: (await db.collection("facilities/" + F + "/stickerPhotos").get()).size };
  enabled.on = false;

  // 確認(ログインなし): 正しい入口とコードでも、誤りと同じ応答。チケット・施設名を返さない
  await rejects(verify(TOKEN, CODE), "permission-denied");
  await rejects(verify(newEntryToken(), CODE), "permission-denied");
  // 保存(ログインなし): 有効な間に発行したチケットでも 503。チケットなし・別オリジン・別メソッドも通らない
  assert.equal((await put({ ticket, uploadId: uuid(9) })).statusCode, 503);
  assert.equal((await put({ ticket: "x.y", uploadId: uuid(9) })).statusCode, 503);
  const evil = resOf();
  await svc.handleUpload(reqOf({ rawBody: baseJpeg, headers: { Origin: "https://evil.example", "X-Sticker-Ticket": ticket } }), evil);
  assert.equal(evil.statusCode, 403);
  const post = resOf();
  await svc.handleUpload(reqOf({ method: "POST", rawBody: baseJpeg, headers: { Origin: ORIGIN, "X-Sticker-Ticket": ticket } }), post);
  assert.equal(post.statusCode, 405);
  // 画像: 未ログインは 401、所属者・共有先のディーラーでも 404(存在を示さない)
  assert.equal((await image(null, { photo: stored.body.photoId })).statusCode, 401);
  assert.equal((await image("adminA", { photo: stored.body.photoId })).statusCode, 404);
  assert.equal((await image("staffX", { photo: stored.body.photoId, headers: dealerHeaders })).statusCode, 404);
  // API: 未ログインは unauthenticated、ログイン済みは停止のエラー(一覧・削除・設定・共有・ディーラーの一覧)
  await rejects(api(null, "list", { facilityId: F }), "unauthenticated");
  for (const [uid, action, data] of [["adminA", "list", { facilityId: F }], ["adminA", "delete", { facilityId: F, photoId: stored.body.photoId }],
    ["adminA", "getSettings", { facilityId: F }], ["adminA", "setAccessCode", { facilityId: F, code: "135790" }], ["adminA", "getEntryQr", { facilityId: F }],
    ["adminA", "rotateEntryQr", { facilityId: F }], ["adminA", "setDealerShare", { facilityId: F, localDealerId: "dA", shared: false }], ["staffX", "dealerList", { companyId: "cX" }]]) {
    await rejects(api(uid, action, data), "failed-precondition");
  }
  // 何も変わっていない(写真・画像・コード・QR・共有)
  assert.deepEqual({ objects: bucket.objects.size, photos: (await db.collection("facilities/" + F + "/stickerPhotos").get()).size }, before);
  assert.equal((await photoDoc(stored.body.photoId)).get("status"), "stored");
  assert.equal((await db.doc("facilities/" + F + "/stickerSettings/access").get()).get("codeGeneration"), 1);
  assert.equal((await db.doc("stickerEntries/" + TOKEN).get()).get("status"), "active");
  assert.equal((await db.doc("stickerPhotoGrants/" + F + "_dA").get()).get("status"), "active");
  // 再び有効にすると、元のとおり使える
  enabled.on = true;
  assert.equal((await image("adminA", { photo: stored.body.photoId })).statusCode, 200);
});

// ================= 役割ごとの権限(施設設定「IOLシール写真」) =================
test("役割ごとの権限: 注文者・代理入力者は、設定の表示・QR の取得・写真の閲覧だけ。コード・QR の作り直し・共有・削除はサーバーが拒否し、何も変わらない", async () => {
  const stored = await put();
  assert.equal(stored.statusCode, 200);
  const adminQr = await api("adminA", "getEntryQr", { facilityId: F });
  const access = () => db.doc("facilities/" + F + "/stickerSettings/access").get();
  const before = { generation: (await access()).get("codeGeneration"), audits: (await db.collection("stickerAuditLogs").get()).size };

  for (const uid of ["ordA", "proxyA"]) {
    // 表示: コードの状態と停止の有無だけ。共有の状態・失敗の数・ハッシュ・トークンは返さない
    const s = await api(uid, "getSettings", { facilityId: F });
    assert.deepEqual(Object.keys(s).sort(), ["accessCodeSet", "accessCodeUpdatedAt", "canManage", "entryIssued", "sheetNote", "verifyBlockedUntil"], uid);
    assert.deepEqual([s.accessCodeSet, s.entryIssued, s.canManage, s.verifyBlockedUntil], [true, true, false, null], uid);
    assert.ok(!JSON.stringify(s).includes(TOKEN) && !JSON.stringify(s).includes((await access()).get("hash")), uid);
    // QR: 管理者と同じ(作り直さない)
    const memberQr = await api(uid, "getEntryQr", { facilityId: F });
    assert.deepEqual(memberQr, adminQr, uid);
    // 写真の閲覧
    assert.equal((await api(uid, "list", { facilityId: F })).photos.length, 1, uid);
    assert.equal((await image(uid, { photo: stored.body.photoId })).statusCode, 200, uid);
    // 変更の操作はすべて拒否
    await rejects(api(uid, "setAccessCode", { facilityId: F, code: "246810" }), "permission-denied");
    await rejects(api(uid, "rotateEntryQr", { facilityId: F }), "permission-denied");
    await rejects(api(uid, "setDealerShare", { facilityId: F, localDealerId: "dA", shared: true }), "permission-denied");
    await rejects(api(uid, "setDealerShare", { facilityId: F, localDealerId: "dA", shared: false }), "permission-denied");
    await rejects(api(uid, "delete", { facilityId: F, photoId: stored.body.photoId }), "permission-denied");
    // 別の施設には届かない
    await rejects(api(uid, "getSettings", { facilityId: G }), "permission-denied");
    await rejects(api(uid, "getEntryQr", { facilityId: G }), "permission-denied");
  }
  // 何も変わっていない(コードの世代・QR・共有・写真・監査)
  assert.equal((await access()).get("codeGeneration"), before.generation);
  assert.equal((await db.doc("stickerEntries/" + TOKEN).get()).get("status"), "active");
  assert.equal((await db.doc("stickerPhotoGrants/" + F + "_dA").get()).exists, false);
  assert.equal((await photoDoc(stored.body.photoId)).get("status"), "stored");
  assert.equal((await db.collection("stickerAuditLogs").get()).size, before.audits);
  assert.ok((await verify(TOKEN, CODE)).ticket, "今のコードと QR はそのまま使える");

  // 管理者・副管理者は、表示に共有の状態を含み、変更の操作ができる
  for (const uid of ["adminA", "subA"]) {
    const s = await api(uid, "getSettings", { facilityId: F });
    assert.equal(s.canManage, true, uid);
    assert.ok(Array.isArray(s.dealers) && typeof s.verifyFailures24h === "number", uid);
  }
  assert.deepEqual(await api("subA", "setDealerShare", { facilityId: F, localDealerId: "dA", shared: true }), { ok: true, shared: true });
  assert.deepEqual(await api("subA", "setAccessCode", { facilityId: F, code: "246810" }), { ok: true });
  assert.ok((await api("subA", "rotateEntryQr", { facilityId: F })).svg);
  assert.deepEqual(await api("subA", "delete", { facilityId: F, photoId: stored.body.photoId }), { ok: true });
});

test("役割ごとの権限: QR の初回の発行は管理者・副管理者だけ。注文者・代理入力者は未発行なら案内で拒否され、何も作られない。コードの確認が停止中のときは、注文者にも停止の時刻だけを返す", async () => {
  // 施設 G の QR をまだ出していない状態にする
  await db.doc("facilities/" + G + "/stickerSettings/entry").delete();
  assert.equal((await api("adminB", "getSettings", { facilityId: G })).entryIssued, false);
  const entries = async () => (await db.collection("stickerEntries").where("facilityId", "==", G).where("status", "==", "active").get()).size;
  const activeBefore = await entries();
  for (const [uid, role] of [["ordG", "orderer"], ["proxyG", "proxy"]]) {
    await db.doc("facilities/" + G + "/members/" + uid).set({ uid, role });
    await assert.rejects(api(uid, "getEntryQr", { facilityId: G }), (e) => e.code === "failed-precondition" && /管理者・副管理者に発行を依頼/.test(e.message), uid);
    assert.equal((await api(uid, "getSettings", { facilityId: G })).entryIssued, false, uid);
  }
  assert.equal((await db.doc("facilities/" + G + "/stickerSettings/entry").get()).exists, false, "発行の記録を作らない");
  assert.equal(await entries(), activeBefore, "入口を作らない");
  // 副管理者は初回の発行ができ、発行の後は注文者・代理入力者も同じ QR を表示できる
  await db.doc("facilities/" + G + "/members/subG").set({ uid: "subG", role: "subadmin" });
  const qr = await api("subG", "getEntryQr", { facilityId: G });
  assert.match(qr.svg, /sticker\.html#f=[A-Za-z0-9_-]{22}/);
  for (const uid of ["ordG", "proxyG", "adminB"]) assert.equal((await api(uid, "getEntryQr", { facilityId: G })).svg, qr.svg, uid);
  assert.equal((await api("ordG", "getSettings", { facilityId: G })).entryIssued, true);
  // 発行済みの入口が無効になっていても、注文者は発行し直せない(管理者はできる)
  const token = (await db.doc("facilities/" + G + "/stickerSettings/entry").get()).get("token");
  await db.doc("stickerEntries/" + token).update({ status: "revoked" });
  await assert.rejects(api("ordG", "getEntryQr", { facilityId: G }), (e) => e.code === "failed-precondition");
  assert.notEqual((await api("adminB", "getEntryQr", { facilityId: G })).svg, qr.svg);
  // 停止中
  for (let i = 0; i < 12; i++) await verify(TOKEN, "000000").catch(() => {});
  const s = await api("ordA", "getSettings", { facilityId: F });
  assert.ok(typeof s.verifyBlockedUntil === "string" && s.canManage === false);
  assert.equal(s.verifyFailures24h, undefined);
});
