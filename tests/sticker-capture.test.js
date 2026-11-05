// 看護師の撮影画面の流れ(DOM なし)と、通信の部品
import test from "node:test";
import assert from "node:assert/strict";
import { createCaptureController } from "../src/sticker/capture-controller.js";
import { createCaptureApi, sha256OfBlob, stickerFunctionsBase } from "../src/data/sticker-capture-api.js";
import { MESSAGES, UPLOAD_RETRY_DELAYS, classifyUpload, formatSentAt, formatSurgeryUpTo, lastSentLabel, shortDate, surgeryDateError } from "../src/domain/sticker-capture.js";

const NOW = Date.parse("2026-11-05T01:00:00Z");   // 日本時間 11/5 10:00
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const shot = (n = 1) => ({ blob: new Blob([`image-${n}`]), width: 3060, height: 4080 });
const okBody = (over = {}) => ({ photoId: "p", created: true, seq: 1, takenAt: "2026-11-05T01:00:00.000Z", lastSurgeryDate: null, ...over });
const verified = (over = {}) => ({ ok: true, result: { ticket: "T1", expiresAt: NOW + 30 * 60000, facilityName: "A眼科", lastSentAt: null, lastSurgeryDate: null, ...over } });

function harness({ verify = [verified()], upload = [], clock = { t: NOW } } = {}) {
  const calls = { verify: [], upload: [], sleep: [] };
  let n = 0;
  const controller = createCaptureController({
    token: TOKEN, sha256: async () => "hash", newUploadId: () => `id-${(n += 1)}`, now: () => clock.t, sleep: async (ms) => { calls.sleep.push(ms); },
    api: {
      verify: async (a) => { calls.verify.push(a); return verify.length > 1 ? verify.shift() : verify[0]; },
      upload: async (a) => { calls.upload.push(a); return upload.length > 1 ? upload.shift() : upload[0]; }
    }
  });
  return { controller, s: controller.state, calls, clock };
}

test("流れ: コード → 撮影 → 確認 → 送信 → 完了 → 続けて撮影。枚数と最終送信が更新される", async () => {
  const { controller: c, s, calls } = harness({ upload: [{ status: 200, body: okBody({ lastSurgeryDate: "2026-11-04" }) }, { status: 200, body: okBody({ takenAt: "2026-11-05T01:05:00.000Z", lastSurgeryDate: "2026-11-04" }) }] });
  assert.equal(s.screen, "code");
  await c.verify("123456");
  assert.deepEqual([s.screen, s.facilityName], ["camera", "A眼科"]);
  c.takePhoto(shot(1));
  assert.equal(s.screen, "review");
  c.setSurgeryDate("2026-11-04");
  await c.send();
  assert.deepEqual([s.screen, s.sentCount, s.photo, s.surgeryLocked, s.last.lastSurgeryDate], ["done", 1, null, true, "2026-11-04"]);
  assert.deepEqual(calls.upload[0].lastSurgeryDate, "2026-11-04");
  c.continueShooting();
  assert.equal(s.screen, "camera");
  c.takePhoto(shot(2));
  await c.send();
  assert.deepEqual([s.sentCount, s.done.count, s.last.lastSentAt], [2, 2, "2026-11-05T01:05:00.000Z"]);
  assert.equal(calls.verify.length, 1, "同じセッションではコードを再入力しない");
  assert.notEqual(calls.upload[0].uploadId, calls.upload[1].uploadId);
});

test("入口トークンがなければコード入力を出さない", async () => {
  const c = createCaptureController({ token: null, sha256: async () => "h", api: {} });
  assert.equal(c.state.screen, "no-token");
  await c.verify("123456");
  assert.equal(c.state.screen, "no-token");
});

test("コードの確認の失敗: 理由ごとの文言で、画面を進めない", async () => {
  for (const [reason, text] of [["failed", MESSAGES.codeWrong], ["blocked", MESSAGES.codeBlocked], ["network", MESSAGES.connection]]) {
    const { controller: c, s } = harness({ verify: [{ ok: false, reason }] });
    await c.verify("000000");
    assert.deepEqual([s.screen, s.error, s.busy, s.facilityName], ["code", text, false, ""]);
  }
});

test("再送: 通信の失敗は 1・2・4 秒後に同じIDで再送し、成功すれば1枚だけ数える", async () => {
  const { controller: c, s, calls } = harness({ upload: [{ status: null, body: null }, { status: 503, body: {} }, { status: 200, body: okBody() }] });
  await c.verify("123456");
  c.takePhoto(shot());
  await c.send();
  assert.equal(calls.upload.length, 3);
  assert.equal(new Set(calls.upload.map(u => u.uploadId)).size, 1);
  assert.deepEqual(calls.sleep, [1000, 2000]);
  assert.equal(s.sentCount, 1);
});

test("再送: 自動の再送でも失敗したら写真を残して [再送信] を出し、同じIDで送れる", async () => {
  const { controller: c, s, calls } = harness({ upload: [{ status: null, body: null }, { status: null, body: null }, { status: null, body: null }, { status: null, body: null }, { status: 200, body: okBody() }] });
  await c.verify("123456");
  c.takePhoto(shot());
  await c.send();
  assert.equal(calls.upload.length, UPLOAD_RETRY_DELAYS.length + 1);
  assert.deepEqual([s.screen, s.canResend, s.error, s.sending], ["review", true, MESSAGES.sendFailed, false]);
  assert.ok(s.photo);
  await c.send();
  assert.equal(s.screen, "done");
  assert.equal(new Set(calls.upload.map(u => u.uploadId)).size, 1);
});

test("チケットの期限切れ(401): 写真と日付を残してコード入力へ戻り、確認の後に同じIDで自動で再送する。新しいセッションになる", async () => {
  const { controller: c, s, calls } = harness({
    verify: [verified(), verified({ ticket: "T2" })],
    upload: [{ status: 401, body: { error: "ticket" } }, { status: 200, body: okBody({ lastSurgeryDate: "2026-11-04" }) }]
  });
  await c.verify("123456");
  c.takePhoto(shot());
  c.setSurgeryDate("2026-11-04");
  await c.send();
  assert.deepEqual([s.screen, s.notice, s.surgeryDate], ["code", MESSAGES.reenterCode, "2026-11-04"]);
  assert.ok(s.photo);
  await c.verify("123456");
  assert.equal(s.screen, "done");
  assert.deepEqual(calls.upload.map(u => u.ticket), ["T1", "T2"]);
  assert.equal(calls.upload[0].uploadId, calls.upload[1].uploadId);
  assert.equal(calls.upload[1].lastSurgeryDate, "2026-11-04");
});

test("チケットの期限: 30分を過ぎていれば送らずにコード入力へ戻す", async () => {
  const clock = { t: NOW };
  const { controller: c, s, calls } = harness({ clock, upload: [{ status: 200, body: okBody() }] });
  await c.verify("123456");
  c.takePhoto(shot());
  clock.t = NOW + 30 * 60000;
  await c.send();
  assert.deepEqual([s.screen, calls.upload.length], ["code", 0]);
  assert.ok(s.photo);
});

test("撮り直すと新しいIDになる。再送は同じID", async () => {
  const { controller: c, s } = harness({ upload: [{ status: 200, body: okBody() }] });
  await c.verify("123456");
  c.takePhoto(shot(1));
  const first = s.photo.uploadId;
  c.retake();
  assert.deepEqual([s.screen, s.photo], ["camera", null]);
  c.takePhoto(shot(2));
  assert.notEqual(s.photo.uploadId, first);
});

test("重複の再送(created: false)は枚数も最終送信も変えず、日付はサーバーの値にそろえる", async () => {
  const { controller: c, s } = harness({ upload: [{ status: 200, body: okBody({ created: false, lastSurgeryDate: "2026-11-03" }) }] });
  await c.verify("123456");
  c.takePhoto(shot());
  c.setSurgeryDate("2026-11-04");
  await c.send();
  assert.deepEqual([s.sentCount, s.last.lastSentAt, s.surgeryDate, s.surgeryLocked], [0, null, "2026-11-03", true]);
});

test("最終手術日: 最初の成功で固定し、2枚目以降は変更できない。最初の失敗の間は直せる。未来の日付は送らない", async () => {
  const { controller: c, s, calls } = harness({ upload: [{ status: null, body: null }, { status: null, body: null }, { status: null, body: null }, { status: null, body: null }, { status: 200, body: okBody({ lastSurgeryDate: "2026-11-03" }) }] });
  await c.verify("123456");
  c.takePhoto(shot());
  c.setSurgeryDate("2026-11-06");
  await c.send();
  assert.deepEqual([s.error, calls.upload.length], [MESSAGES.futureDate, 0]);
  c.setSurgeryDate("2026-11-04");
  await c.send();
  c.setSurgeryDate("2026-11-03");
  await c.send();
  assert.equal(calls.upload.at(-1).lastSurgeryDate, "2026-11-03");
  c.continueShooting();
  c.setSurgeryDate("2026-11-01");
  assert.equal(s.surgeryDate, "2026-11-03");
});

test("上限・内容の違いは再送せず理由を出す。写真は残す", async () => {
  const { controller: c, s, calls } = harness({ upload: [{ status: 429, body: { error: "limit", message: "送信の上限に達しました。時間をおいてお試しください" } }] });
  await c.verify("123456");
  c.takePhoto(shot());
  await c.send();
  assert.deepEqual([calls.upload.length, s.error, s.canResend, s.screen], [1, "送信の上限に達しました。時間をおいてお試しください", false, "review"]);
  assert.ok(s.photo);
});

test("15MB を超える画像は送らない", async () => {
  const { controller: c, s, calls } = harness({ upload: [{ status: 200, body: okBody() }] });
  await c.verify("123456");
  c.takePhoto({ ...shot(), blob: { size: 15 * 1024 * 1024 + 1 } });
  await c.send();
  assert.deepEqual([s.error, calls.upload.length], [MESSAGES.tooLarge, 0]);
});

test("二重送信を防ぐ", async () => {
  let release;
  const c = createCaptureController({ token: TOKEN, sha256: async () => "h", newUploadId: () => "id", now: () => NOW,
    api: { verify: async () => verified(), upload: () => new Promise(r => { release = () => r({ status: 200, body: okBody() }); }) } });
  await c.verify("123456");
  c.takePhoto(shot());
  const first = c.send();
  await c.send();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(c.state.sending, true);
  release();
  await first;
  assert.equal(c.state.sentCount, 1);
});

test("終了: セッションと写真を消し、遅れて届いた結果を表示しない", async () => {
  let release;
  const c = createCaptureController({ token: TOKEN, sha256: async () => "h", newUploadId: () => "id", now: () => NOW,
    api: { verify: async () => verified(), upload: () => new Promise(r => { release = () => r({ status: 200, body: okBody() }); }) } });
  await c.verify("123456");
  c.takePhoto(shot());
  const sending = c.send();
  await new Promise(r => setTimeout(r, 0));
  c.finish();
  release();
  await sending;
  assert.deepEqual([c.state.screen, c.state.photo, c.state.facilityName, c.state.sentCount, c.state.done], ["code", null, "", 0, null]);
  assert.ok(!JSON.stringify(c.state).includes("T1"), "チケットは画面の状態に出ない");
});

test("状態にコードとチケットを持たない", async () => {
  const { controller: c, s } = harness({ upload: [{ status: 200, body: okBody() }] });
  await c.verify("246810");
  c.takePhoto(shot());
  const text = JSON.stringify(s);
  assert.ok(!text.includes("246810") && !text.includes("T1"));
});

// ---------- 表示 ----------
test("前回の送信の表示: 日本時間で、今年以外は年も付ける", () => {
  assert.equal(formatSentAt("2026-11-04T01:35:00Z", NOW), "11/4(水) 10:35");
  assert.equal(formatSentAt("2025-12-26T07:10:00Z", NOW), "2025/12/26(金) 16:10");
  assert.equal(formatSurgeryUpTo("2026-11-04", NOW), "11月4日の手術分まで");
  assert.equal(formatSurgeryUpTo("2025-12-26", NOW), "2025年12月26日の手術分まで");
  assert.equal(shortDate("2026-11-04", NOW), "11/4");
  assert.equal(lastSentLabel({ lastSentAt: "2026-11-04T01:35:00Z", lastSurgeryDate: "2026-11-04" }, NOW), "最終送信 11/4(水) 10:35 ・ 11月4日の手術分まで");
  assert.equal(lastSentLabel({ lastSentAt: "2026-11-04T01:35:00Z", lastSurgeryDate: null }, NOW), "最終送信 11/4(水) 10:35");
  assert.equal(lastSentLabel({ lastSentAt: null }, NOW), "送信履歴なし");
});

test("最終手術日の入力: 空と過去は可、未来だけ不可(日本時間)", () => {
  assert.equal(surgeryDateError("", NOW), "");
  assert.equal(surgeryDateError("2020-01-01", NOW), "");
  assert.equal(surgeryDateError("2026-11-05", NOW), "");
  assert.equal(surgeryDateError("2026-11-06", NOW), MESSAGES.futureDate);
});

test("送信の応答の分類", () => {
  assert.equal(classifyUpload(200, {}).kind, "ok");
  assert.equal(classifyUpload(401, {}).kind, "ticket");
  for (const s of [null, 500, 503]) assert.equal(classifyUpload(s, null).kind, "retry");
  assert.equal(classifyUpload(400, { error: "length" }).kind, "retry");
  assert.deepEqual(classifyUpload(400, { error: "surgery_date" }), { kind: "rejected", message: MESSAGES.futureDate });
  assert.deepEqual(classifyUpload(413, {}), { kind: "rejected", message: MESSAGES.tooLarge });
  assert.deepEqual(classifyUpload(403, {}), { kind: "rejected", message: MESSAGES.unavailable });
  for (const s of [409, 415]) assert.deepEqual(classifyUpload(s, {}), { kind: "rejected", message: MESSAGES.badImage });
});

// ---------- 通信 ----------
const response = (status, body) => ({ ok: status < 400, status, json: async () => body });

test("通信: 確認は callable の形式で送り、応答を分類する", async () => {
  const sent = [];
  const api = createCaptureApi({ baseUrl: "https://f.test", fetchImpl: async (url, init) => { sent.push([url, init]); return response(200, { result: { ticket: "T" } }); } });
  assert.deepEqual(await api.verify({ token: TOKEN, code: "123456" }), { ok: true, result: { ticket: "T" } });
  assert.equal(sent[0][0], "https://f.test/stickerEntryApi");
  assert.deepEqual(JSON.parse(sent[0][1].body), { data: { token: TOKEN, code: "123456" } });
  const of = (r) => createCaptureApi({ baseUrl: "x", fetchImpl: r }).verify({ token: TOKEN, code: "1" });
  assert.deepEqual(await of(async () => response(403, { error: { status: "PERMISSION_DENIED" } })), { ok: false, reason: "failed" });
  assert.deepEqual(await of(async () => response(429, { error: { status: "RESOURCE_EXHAUSTED" } })), { ok: false, reason: "blocked" });
  assert.deepEqual(await of(async () => { throw new Error("offline"); }), { ok: false, reason: "network" });
  assert.deepEqual(await of(async () => response(500, null)), { ok: false, reason: "network" });
});

test("通信: 保存は画像をそのまま PUT し、必要なヘッダーだけを送る。通信の失敗は status: null", async () => {
  const sent = [];
  const blob = new Blob(["x"]);
  const api = createCaptureApi({ baseUrl: "https://f.test", fetchImpl: async (url, init) => { sent.push([url, init]); return response(200, { photoId: "p" }); } });
  await api.upload({ ticket: "T", uploadId: "u", sha256: "h", blob, lastSurgeryDate: null, blurWarned: false });
  assert.equal(sent[0][0], "https://f.test/stickerPhotoUpload");
  assert.equal(sent[0][1].method, "PUT");
  assert.equal(sent[0][1].body, blob);
  assert.deepEqual(sent[0][1].headers, { "Content-Type": "image/jpeg", "X-Sticker-Ticket": "T", "X-Upload-Id": "u", "X-Content-Sha256": "h" });
  await api.upload({ ticket: "T", uploadId: "u", sha256: "h", blob, lastSurgeryDate: "2026-11-04", blurWarned: true });
  assert.deepEqual([sent[1][1].headers["X-Last-Surgery-Date"], sent[1][1].headers["X-Blur-Warned"]], ["2026-11-04", "1"]);
  const offline = createCaptureApi({ baseUrl: "x", fetchImpl: async () => { throw new Error("offline"); } });
  assert.deepEqual(await offline.upload({ ticket: "T", uploadId: "u", sha256: "h", blob }), { status: null, body: null });
});

test("通信の補助: 関数の URL と画像の SHA-256", async () => {
  assert.equal(stickerFunctionsBase("medconf-iol-dev"), "https://asia-northeast1-medconf-iol-dev.cloudfunctions.net");
  assert.equal(await sha256OfBlob(new Blob(["abc"])), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
