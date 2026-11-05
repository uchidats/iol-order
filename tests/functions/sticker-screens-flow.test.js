// 統合: 施設設定 → QR → 撮影・送信 → 閲覧(医療機関・ディーラー)を、画面側の部品(src/data・src/sticker)と本物のサーバーの処理でつなぐ。
// Firestore エミュレータと偽のバケットを使う(実際のバケットには接続しない)。画面ごとに別々に作った部品の、呼び出しの名前・項目・応答の食い違いをここで検出する
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { createStickerPhotoService } from "../../functions/src/sticker-photo-service.js";
import { RegistrationError } from "../../functions/src/registration.js";
import { parseEntryToken } from "../../src/domain/sticker-photo.js";
import { createStickerPhotoApi } from "../../src/data/sticker-photo-api.js";
import { createStickerSettingsApi } from "../../src/data/sticker-settings-api.js";
import { createCaptureController } from "../../src/sticker/capture-controller.js";
import { createCaptureApi, sha256OfBlob } from "../../src/data/sticker-capture-api.js";
import { MESSAGES } from "../../src/domain/sticker-capture.js";

const PROJECT = "demo-iol-functions";
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185").split(":");
const F = "fA", G = "fB", CODE = "246810", SECRET = "s".repeat(40), T0 = Date.parse("2026-11-05T01:00:00Z"), MIN = 60 * 1000;
const ORIGIN = "https://iol.medconf.jp";
const seg = (m, b) => Buffer.concat([Buffer.from([0xff, m, (b.length + 2) >> 8, (b.length + 2) & 0xff]), Buffer.from(b)]);
const jpeg = (salt = 0) => Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xc0, [8, 0, 8, 0, 16, 1, 1, 0x11, 0]), seg(0xda, [1, 1, 0, 0, 63, 0]), Buffer.from([1, 2, 3, salt]), Buffer.from([0xff, 0xd9])]);
const CODES = { "permission-denied": ["PERMISSION_DENIED", 403], "resource-exhausted": ["RESOURCE_EXHAUSTED", 429] };

let db, env, clock, objects, svc, uploadSeq;

before(async () => {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  db = getFirestore();
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: "rules_version = '2'; service cloud.firestore { match /databases/{d}/documents { match /{x=**} { allow read, write: if false; } } }", host, port: Number(port) } });
});
after(async () => { await env.clearFirestore(); await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  clock = { t: T0 };
  objects = new Map();
  uploadSeq = 0;
  for (const fid of [F, G]) await db.doc("facilities/" + fid).set({ name: fid + "眼科", status: "active" });
  for (const [fid, uid, role] of [[F, "adminA", "admin"], [F, "ordA", "orderer"], [G, "adminB", "admin"]]) await db.doc("facilities/" + fid + "/members/" + uid).set({ uid, role });
  await db.doc("dealerCompanies/cX").set({ name: "X商事", status: "active" });
  await db.doc("dealerCompanies/cY").set({ name: "Y医療", status: "active" });
  await db.doc("facilities/" + F + "/facilityDealers/dA").set({ facilityId: F, name: "X商事 立川", orderEmails: ["x@example.jp"] });
  await db.doc("facilities/" + F + "/dealerPortalLinks/dA").set({ companyId: "cX", status: "proposed", currentGrantId: null });   // 受注閲覧は許可していない
  svc = createStickerPhotoService({
    db, FieldValue, Timestamp, now: () => clock.t, isEnabled: () => true, facilityIds: () => [F, G], ticketSecret: () => SECRET,
    makeThumbnail: async () => Buffer.from("thumb"),
    makeQrSvg: async (url) => '<svg data-url="' + url + '"></svg>',
    verifyIdToken: async (token) => { if (!token.startsWith("id-")) throw new Error("bad token"); return { uid: token.slice(3), email: token.slice(3) + "@x.jp", email_verified: true }; },
    authorizeDealer: async (auth, companyId) => {
      const own = { staffX: "cX", staffY: "cY" }[auth.uid];
      if (!own || (companyId && companyId !== own)) throw new RegistrationError("permission-denied", "no");
      return { companyId: own };
    },
    bucket: { save: async (n, b) => { objects.set(n, b); }, read: async (n) => objects.get(n) ?? null, delete: async (n) => { objects.delete(n); }, list: async () => ({ items: [], nextPageToken: null }) }
  });
});

const lower = (headers) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
function fakeRes() {
  const out = { statusCode: 0, body: null };
  const res = { set: () => res, status: (c) => { out.statusCode = c; return res; }, json: (b) => { out.body = b; return res; }, send: (b) => { out.body = b; return res; } };
  return { out, res };
}

/** ログイン中の本人の、画面側の API(施設設定・閲覧が使う src/data/sticker-photo-api.js)。callable と画像の取得を本物の処理へつなぐ */
function clientOf(uid) {
  const httpsCallable = (_, name) => async (payload) => {
    assert.equal(name, "stickerPhotoApi");
    try { return { data: await svc.api({ auth: { uid, token: { email: uid + "@x.jp", email_verified: true } }, data: payload }) }; }
    catch (e) { throw Object.assign(new Error(e.message), { code: "functions/" + e.code }); }
  };
  const fetchImpl = async (url, init) => {
    const headers = lower({ ...init.headers, Origin: ORIGIN });
    const { out, res } = fakeRes();
    await svc.handleImage({ method: init.method, query: Object.fromEntries(new URL(url).searchParams), headers, get: (n) => headers[n.toLowerCase()] }, res);
    return { ok: out.statusCode < 400, status: out.statusCode, blob: async () => new Blob([out.body]) };
  };
  return createStickerPhotoApi({ functions: {}, httpsCallable, imageUrl: "https://functions.test/stickerPhotoImage", getIdToken: async () => "id-" + uid, device: { get: () => "device" }, fetchImpl });
}

/** 看護師の画面の fetch(ログインなし) */
async function captureFetch(url, init) {
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
  const headers = lower({ ...init.headers, Origin: ORIGIN, "Content-Length": raw.length });
  const { out, res } = fakeRes();
  await svc.handleUpload({ method: init.method, rawBody: raw, headers, get: (n) => headers[n.toLowerCase()] }, res);
  return { ok: out.statusCode < 400, status: out.statusCode, json: async () => out.body };
}
const nurse = (token) => createCaptureController({
  token, sha256: sha256OfBlob, now: () => clock.t, sleep: async () => {},
  newUploadId: () => "3f2b8c1e-4a5d-4e6f-8a9b-" + String((uploadSeq += 1)).padStart(12, "0"),
  api: createCaptureApi({ baseUrl: "https://functions.test", fetchImpl: captureFetch })
});
const photo = (salt) => ({ blob: new Blob([jpeg(salt)], { type: "image/jpeg" }), width: 16, height: 8 });
async function shoot(c, salt) {
  c.takePhoto(photo(salt));
  await c.send();
  assert.deepEqual([c.state.screen, c.state.error], ["done", ""]);
  c.continueShooting();
}
/** 施設設定の QR(SVG)から、看護師の端末が開く URL の入口トークンを取り出す */
const tokenOfQr = (svg) => parseEntryToken(new URL(/data-url="([^"]+)"/.exec(svg)[1]).hash);
const denied = (p) => assert.rejects(p, (e) => e.code === "functions/permission-denied");
const facilityView = (uid, canDelete = false) => clientOf(uid).facilitySource({ facilityId: F, facilityName: "fA眼科", canDelete });

test("統合: 施設設定のコード・QR → 撮影・送信 → 医療機関の一覧・画像。別の施設の所属者は読めない", async () => {
  const settings = createStickerSettingsApi(clientOf("adminA").settingsCall);
  assert.equal((await settings.getSettings(F)).accessCodeSet, false);
  await settings.setAccessCode(F, CODE);
  const token = tokenOfQr((await settings.getEntryQr(F)).svg);
  assert.ok(token, "QR の URL は sticker.html が読める形");

  const c = nurse(token);
  await c.verify(CODE);
  assert.deepEqual([c.state.screen, c.state.facilityName], ["camera", "fA眼科"]);
  await shoot(c, 1);
  await shoot(c, 2);

  // 医療機関の閲覧(注文者でも読める。削除は管理者だけに渡す)
  const viewer = facilityView("ordA");
  const list = await viewer.listPage(F, {});
  assert.deepEqual(list.photos.map(p => p.seq).sort(), [1, 2]);
  assert.equal(viewer.deletePhoto, null);
  const id = list.photos[0].photoId;
  assert.equal(await (await viewer.readImage({ facilityId: F, photoId: id, size: "thumb" })).text(), "thumb");
  assert.ok((await viewer.readImage({ facilityId: F, photoId: id, size: "full" })).size > 0);

  // 別の施設の管理者: 一覧・削除・設定は拒否、画像は「ない」と同じ
  const other = facilityView("adminB", true);
  await denied(other.listPage(F, {}));
  assert.equal(await other.readImage({ facilityId: F, photoId: id, size: "full" }), null);
  await denied(other.deletePhoto(F, id));
  await denied(createStickerSettingsApi(clientOf("adminB").settingsCall).getEntryQr(F));
  await denied(createStickerSettingsApi(clientOf("ordA").settingsCall).setAccessCode(F, "999999"));

  // 管理者の削除は一覧・画像から消える
  await facilityView("adminA", true).deletePhoto(F, id);
  assert.equal((await viewer.listPage(F, {})).photos.length, 1);
  assert.equal(await viewer.readImage({ facilityId: F, photoId: id, size: "full" }), null);
});

test("統合: ディーラーの閲覧は施設設定の「写真の共有」だけで決まり、受注閲覧の許可とは独立。許可の後の写真だけが見え、取り消すと見えない", async () => {
  const settings = createStickerSettingsApi(clientOf("adminA").settingsCall);
  await settings.setAccessCode(F, CODE);
  const c = nurse(tokenOfQr((await settings.getEntryQr(F)).svg));
  await c.verify(CODE);
  await shoot(c, 1);
  const first = (await facilityView("ordA").listPage(F, {})).photos[0].photoId;

  const dealer = clientOf("staffX").dealerSource({ companyId: "cX" });
  assert.deepEqual(await dealer.loadFacilities(), [], "共有の前は施設が出ない");
  await denied(dealer.listPage(F, {}));
  assert.equal(await dealer.readImage({ facilityId: F, photoId: first, size: "full" }), null);

  clock.t += MIN;
  assert.deepEqual((await settings.getSettings(F)).dealers.map(d => [d.localDealerId, d.linked, d.shared]), [["dA", true, false]]);
  await settings.setDealerShare(F, "dA", true);
  clock.t += MIN;
  await shoot(c, 2);

  assert.deepEqual(await dealer.loadFacilities(), [{ facilityId: F, name: "fA眼科" }]);
  const seen = (await dealer.listPage(F, {})).photos;
  assert.equal(seen.length, 1, "許可の前の写真は見えない");
  assert.notEqual(seen[0].photoId, first);
  const shared = seen[0].photoId;
  assert.ok((await dealer.readImage({ facilityId: F, photoId: shared, size: "full" })).size > 0);
  assert.equal(await dealer.readImage({ facilityId: F, photoId: first, size: "full" }), null);
  assert.equal(dealer.deletePhoto, null);

  // 別の会社の担当者・会社を偽った要求は読めない。ディーラーは医療機関の経路でも読めない
  const otherCo = clientOf("staffY").dealerSource({ companyId: "cY" });
  assert.deepEqual(await otherCo.loadFacilities(), []);
  assert.equal(await otherCo.readImage({ facilityId: F, photoId: shared, size: "full" }), null);
  const forged = clientOf("staffY").dealerSource({ companyId: "cX" });
  assert.equal(await forged.readImage({ facilityId: F, photoId: shared, size: "full" }), null);
  await denied(forged.listPage(F, {}));
  assert.equal(await facilityView("staffX").readImage({ facilityId: F, photoId: shared, size: "full" }), null);
  await denied(facilityView("staffX").listPage(F, {}));

  // 受注閲覧の記録には触っていない
  assert.equal((await db.collection("dealerPortalGrants").get()).size, 0);
  const link = (await db.doc("facilities/" + F + "/dealerPortalLinks/dA").get()).data();
  assert.deepEqual([link.status, link.currentGrantId], ["proposed", null]);

  // 取り消すと、すぐに見えない。医療機関の閲覧は変わらない
  await settings.setDealerShare(F, "dA", false);
  assert.deepEqual(await dealer.loadFacilities(), []);
  assert.equal(await dealer.readImage({ facilityId: F, photoId: shared, size: "full" }), null);
  assert.equal((await facilityView("ordA").listPage(F, {})).photos.length, 2);
});

test("統合: QR の作り直し・コードの変更は撮影画面にすぐ効く。写真は残したまま再入力で同じ写真として1回だけ保存する", async () => {
  const settings = createStickerSettingsApi(clientOf("adminA").settingsCall);
  await settings.setAccessCode(F, CODE);
  const oldToken = tokenOfQr((await settings.getEntryQr(F)).svg);
  const c = nurse(oldToken);
  await c.verify(CODE);
  c.takePhoto(photo(7));
  const id = c.state.photo.uploadId;

  // 送信の前にコードを変更 → 発行済みのチケットは 401 → コードの再入力(写真はそのまま)
  await settings.setAccessCode(F, "135790");
  await c.send();
  assert.equal(c.state.screen, "code");
  assert.equal(c.state.photo.uploadId, id);
  await c.verify(CODE);
  assert.equal(c.state.error, MESSAGES.codeWrong, "古いコードは通らない");
  await c.verify("135790");
  assert.deepEqual([c.state.screen, c.state.sentCount], ["done", 1], "再入力の後に自動で送る");
  const docs = (await db.collection("facilities/" + F + "/stickerPhotos").get()).docs.map(d => d.data());
  assert.deepEqual(docs.map(d => d.uploadId), [id]);

  // QR を作り直すと、古い QR の端末は確認できない。新しい QR は使える
  const newToken = tokenOfQr((await settings.rotateEntryQr(F)).svg);
  assert.notEqual(newToken, oldToken);
  const stale = nurse(oldToken);
  await stale.verify("135790");
  assert.deepEqual([stale.state.screen, stale.state.error], ["code", MESSAGES.codeWrong]);
  const fresh = nurse(newToken);
  await fresh.verify("135790");
  assert.equal(fresh.state.screen, "camera");
});
