// 看護師の画面の処理(capture-controller・sticker-capture-api)を、本物のサーバーの処理につないで確かめる。
// Firestore エミュレータと偽のバケットを使う(実際のバケットには接続しない)。ヘッダー名・応答の形の食い違いをここで検出する
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { createStickerPhotoService } from "../../functions/src/sticker-photo-service.js";
import { RegistrationError } from "../../functions/src/registration.js";
import { hashAccessCode, newEntryToken } from "../../functions/src/sticker-photo.js";
import { createCaptureController } from "../../src/sticker/capture-controller.js";
import { createCaptureApi, sha256OfBlob } from "../../src/data/sticker-capture-api.js";
import { MESSAGES } from "../../src/domain/sticker-capture.js";

const PROJECT = "demo-iol-functions";
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185").split(":");
const F = "fA", CODE = "123456", TOKEN = newEntryToken(), SECRET = "s".repeat(40), T0 = Date.parse("2026-11-05T01:00:00Z");
// 最小の JPEG(SOI・SOF0 16×8・SOS・EOI)
const seg = (m, b) => Buffer.concat([Buffer.from([0xff, m, (b.length + 2) >> 8, (b.length + 2) & 0xff]), Buffer.from(b)]);
const jpeg = (salt = 0) => Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xc0, [8, 0, 8, 0, 16, 1, 1, 0x11, 0]), seg(0xda, [1, 1, 0, 0, 63, 0]), Buffer.from([1, 2, 3, salt]), Buffer.from([0xff, 0xd9])]);
const CODES = { "permission-denied": ["PERMISSION_DENIED", 403], "resource-exhausted": ["RESOURCE_EXHAUSTED", 429] };

let db, env, clock, objects, access, svc;

before(async () => {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  db = getFirestore();
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: "rules_version = '2'; service cloud.firestore { match /databases/{d}/documents { match /{x=**} { allow read, write: if false; } } }", host, port: Number(port) } });
  access = await hashAccessCode(CODE);
});
after(async () => { await env.clearFirestore(); await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  clock = { t: T0 };
  objects = new Map();
  await db.doc(`facilities/${F}`).set({ name: "A眼科", status: "active" });
  await db.doc(`facilities/${F}/stickerSettings/access`).set({ ...access, codeGeneration: 1 });
  await db.doc(`stickerEntries/${TOKEN}`).set({ facilityId: F, status: "active" });
  svc = createStickerPhotoService({
    db, FieldValue, Timestamp, now: () => clock.t, isEnabled: () => true, facilityIds: () => [F], ticketSecret: () => SECRET,
    makeThumbnail: async () => Buffer.from("thumb"),
    bucket: { save: async (n, b) => { objects.set(n, b); }, read: async (n) => objects.get(n) ?? null, delete: async (n) => { objects.delete(n); }, list: async () => ({ items: [], nextPageToken: null }) }
  });
});

/** 画面の fetch を、本物のサーバーの処理へつなぐ(onCall と onRequest の入出力を再現する) */
async function serverFetch(url, init) {
  if (url.endsWith("/stickerEntryApi")) {
    try {
      const result = await svc.verify({ data: JSON.parse(init.body).data, ip: "198.51.100.7" });
      return { ok: true, status: 200, json: async () => ({ result }) };
    } catch (e) {
      if (!(e instanceof RegistrationError)) throw e;
      const [status, code] = CODES[e.code];
      return { ok: false, status: code, json: async () => ({ error: { status, message: e.message } }) };
    }
  }
  const raw = Buffer.from(await init.body.arrayBuffer());
  const headers = Object.fromEntries(Object.entries({ ...init.headers, Origin: "https://iol.medconf.jp", "Content-Length": raw.length }).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const out = { statusCode: 0, body: null };
  const res = { set: () => res, status: (c) => { out.statusCode = c; return res; }, json: (b) => { out.body = b; return res; }, send: (b) => { out.body = b; return res; } };
  await svc.handleUpload({ method: init.method, rawBody: raw, headers, get: (n) => headers[n.toLowerCase()] }, res);
  return { ok: out.statusCode < 400, status: out.statusCode, json: async () => out.body };
}

const controller = (token = TOKEN) => {
  let n = 0;
  return createCaptureController({
    token, sha256: sha256OfBlob, now: () => clock.t, sleep: async () => {},
    newUploadId: () => `3f2b8c1e-4a5d-4e6f-8a9b-${String((n += 1)).padStart(12, "0")}`,
    api: createCaptureApi({ baseUrl: "https://functions.test", fetchImpl: serverFetch })
  });
};
const photo = (salt = 0, over = {}) => ({ blob: new Blob([jpeg(salt)], { type: "image/jpeg" }), width: 16, height: 8, ...over });
const photos = async () => (await db.collection(`facilities/${F}/stickerPhotos`).get()).docs.map(d => d.data());

test("結合: コード → 撮影 → 送信が本物のサーバーを通り、施設・幅と高さ・最終手術日・ピンぼけの印が記録される", async () => {
  const c = controller();
  await c.verify(CODE);
  assert.deepEqual([c.state.screen, c.state.facilityName, c.state.last.lastSentAt], ["camera", "A眼科", null]);
  c.takePhoto(photo(0, { blurWarned: true }));
  c.setSurgeryDate("2026-11-04");
  await c.send();
  assert.deepEqual([c.state.screen, c.state.sentCount, c.state.error], ["done", 1, ""]);
  const [d] = await photos();
  assert.deepEqual([d.facilityId, d.width, d.height, d.lastSurgeryDate, d.blurWarned, d.seq], [F, 16, 8, "2026-11-04", true, 1]);
  assert.equal(objects.size, 2, "原本とサムネイル");
});

test("結合: 同じセッションの連続撮影は seq が続き、最終手術日は固定される", async () => {
  const c = controller();
  await c.verify(CODE);
  for (const salt of [1, 2, 3]) {
    c.takePhoto(photo(salt));
    if (salt === 1) c.setSurgeryDate("2026-11-04");
    await c.send();
    c.continueShooting();
  }
  const list = (await photos()).sort((a, b) => a.seq - b.seq);
  assert.deepEqual(list.map(p => [p.seq, p.lastSurgeryDate]), [[1, "2026-11-04"], [2, "2026-11-04"], [3, "2026-11-04"]]);
  assert.equal(new Set(list.map(p => p.sessionId)).size, 1);
  assert.equal(c.state.sentCount, 3);
});

test("結合: 30分を過ぎた送信はサーバーが 401 にし、コードの再入力の後に同じIDで送る。二重に保存しない", async () => {
  const c = controller();
  await c.verify(CODE);
  c.takePhoto(photo());
  await c.send();
  c.continueShooting();
  c.takePhoto(photo(5));
  const id = c.state.photo.uploadId;
  clock.t += 30 * 60 * 1000;
  await c.send();
  assert.equal(c.state.screen, "code");
  await c.verify(CODE);
  assert.deepEqual([c.state.screen, c.state.sentCount], ["done", 1], "新しいセッションの1枚目");
  const list = await photos();
  assert.equal(list.length, 2);
  assert.equal(list.filter(p => p.uploadId === id).length, 1);
  assert.equal(new Set(list.map(p => p.sessionId)).size, 2);
});

test("結合: コードが変わると発行済みのチケットは 401 で、再入力へ戻る", async () => {
  const c = controller();
  await c.verify(CODE);
  c.takePhoto(photo());
  await db.doc(`facilities/${F}/stickerSettings/access`).update({ codeGeneration: 2 });
  await c.send();
  assert.deepEqual([c.state.screen, (await photos()).length], ["code", 0]);
  assert.ok(c.state.photo);
});

test("結合: コードの誤り・無効な入口は同じ案内で、回数を超えると止まる", async () => {
  const c = controller();
  await c.verify("999999");
  assert.equal(c.state.error, MESSAGES.codeWrong);
  const unknown = controller(newEntryToken());
  await unknown.verify(CODE);
  assert.equal(unknown.state.error, MESSAGES.codeWrong);
  for (let i = 0; i < 12; i += 1) await c.verify("999999");
  assert.equal(c.state.error, MESSAGES.codeBlocked);
});

test("結合: 送信の後の応答が届かなかった再送は、同じ写真として既存の記録を返す", async () => {
  const c = controller();
  await c.verify(CODE);
  c.takePhoto(photo());
  const original = c.state.photo;
  await c.send();
  c.continueShooting();
  c.state.photo = original;   // 応答が失われて、同じ写真が残っている状態
  c.state.screen = "review";
  await c.send();
  assert.equal((await photos()).length, 1);
  assert.equal(c.state.sentCount, 1, "重複は数えない");
});

test("結合: 画像でないデータはサーバーが拒否し、案内を出す", async () => {
  const c = controller();
  await c.verify(CODE);
  c.takePhoto({ blob: new Blob(["not a jpeg"]), width: 1, height: 1 });
  await c.send();
  assert.deepEqual([c.state.error, c.state.screen], [MESSAGES.badImage, "review"]);
  assert.equal((await photos()).length, 0);
});
