// 注文の取り消し(受付の直後の10秒だけ。functions/src/order-cancel.js)と、その間のメールの送信の保留(order-mail-outbox.js の sendAfterMs)。
// 送信の処理は本物(createMailDispatchService)を、偽の配信サービスで動かす(実メールは送らない)。時計はテストが進める。
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { createOrderService, ORDER_CANCEL } from "../../functions/src/orders.js";
import { createOrderCancelService } from "../../functions/src/order-cancel.js";
import { createOrderDeletionService } from "../../functions/src/order-deletion.js";
import { createMailDispatchService } from "../../functions/src/order-mail-outbox.js";

const PROJECT = "demo-iol-functions";
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185").split(":");
const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");

let env, db, orders, cancel, deletion, dispatch, sent, clock, slept;
const T0 = Date.parse("2026-10-26T00:00:00Z");

before(async () => {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  db = getFirestore();
  clock = { t: T0 };
  orders = createOrderService({ db, FieldValue, now: () => clock.t, isEnabled: () => true });   // 既定の取消時間(10秒)
  cancel = createOrderCancelService({ db, FieldValue, now: () => clock.t });
  deletion = createOrderDeletionService({ db, FieldValue });
  // 送信の処理の「待つ」は、時計を進めるだけ(実際には待たない)
  dispatch = createMailDispatchService({ db, FieldValue, Timestamp, now: () => clock.t, isEnabled: () => true,
    getSender: () => ({ send: async (msg) => { sent.push(msg); return { ok: true, id: `msg_${sent.length}` }; } }),
    sleep: async (ms) => { slept.push(ms); clock.t += ms; } });
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(rulesPath, "utf8"), host, port: Number(port) } });
});
after(async () => { await env.clearFirestore(); await env.cleanup(); });

const F = "fA";
beforeEach(async () => {
  await env.clearFirestore();
  clock.t = T0; sent = []; slept = [];
  await db.doc(`facilities/${F}`).set({ name: "A眼科", status: "active" });
  await db.doc("facilities/fB").set({ name: "B眼科", status: "active" });
  for (const [f, uid, role] of [[F, "adminA", "admin"], [F, "ordA", "orderer"], [F, "proxyA", "proxy"], ["fB", "adminB", "admin"]]) await db.doc(`facilities/${f}/members/${uid}`).set({ uid, role });
  await db.doc(`facilities/${F}/adoptedIols/jj-dib00v`).set({ facilityId: F, catalogIolId: "jj-dib00v", enabled: true });
  await db.doc(`facilities/${F}/orderers/o1`).set({ facilityId: F, name: "山田" });
  await db.doc(`facilities/${F}/facilityDealers/d1`).set({ facilityId: F, name: "A商会", orderEmails: ["order@dealer.example.jp"] });
  await db.doc(`facilities/${F}/settings/mail`).set({ copyEnabled: true, copyEmail: "info@clinic.example.jp" });
});

const user = (uid, over = {}) => ({ uid, token: { email: `${uid}@login.jp`, email_verified: true, name: `ログイン-${uid}`, ...over } });
const line = (over = {}) => ({ modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: "2026-11-10", doctorId: "o1", dealerId: "d1", ...over });
const place = (uid = "ordA", lines = [line()]) => orders.createOrder({ auth: user(uid), data: { facilityId: F, requestId: crypto.randomUUID(), notes: "", lines } });
const undo = (uid, orderId, svc = cancel) => svc.cancelOrder({ auth: user(uid), data: { facilityId: F, orderId } });
const mailRef = (orderId, id) => db.doc(`facilities/${F}/orders/${orderId}/mails/${id}`);
const statuses = async (orderId) => Object.fromEntries((await db.collection(`facilities/${F}/orders/${orderId}/mails`).get()).docs.map(d => [d.id, d.get("status")]));
const orderOf = async (orderId) => (await db.doc(`facilities/${F}/orders/${orderId}`).get()).data();
const tooLate = (p) => assert.rejects(p, (e) => e.code === "failed-precondition" && e.details && e.details.reason === "too-late" && /取り消せませんでした/.test(e.message));

test("取消時間は10秒(サーバーの時計)。受付は即時に保存し、期限とサーバーの現在時刻を返す。メールは期限まで送らず、期限の後は従来どおり送る", async () => {
  assert.equal(ORDER_CANCEL.windowMs, 10 * 1000);
  const r = await place();
  assert.deepEqual([r.cancelUntilMs, r.serverNowMs, r.status], [T0 + 10000, T0, "accepted"]);
  const o = await orderOf(r.orderId);
  assert.equal(o.cancelUntilMs, T0 + 10000, "注文は即時に保存(期限も記録)");
  const m = (await mailRef(r.orderId, "d_d1").get()).data();
  assert.deepEqual([m.status, m.sendAfterMs], ["pending", T0 + 10000], "送信の保留 = 取消の期限");
  // 期限の前: 作成時のトリガー・定期実行でも送らない(送信待ちのまま)
  clock.t = T0 + 9999;
  assert.equal(await dispatch.processMail(mailRef(r.orderId, "d_d1")), "skipped");
  await dispatch.processDue();
  assert.deepEqual([sent.length, (await statuses(r.orderId)).d_d1], [0, "pending"]);
  // 期限の後: 従来どおり送り、ディーラー宛ての後に注文控え
  clock.t = T0 + 10000;
  assert.equal(await dispatch.processMail(mailRef(r.orderId, "d_d1")), "accepted");
  assert.deepEqual(sent.map(s => s.to[0]), ["order@dealer.example.jp", "info@clinic.example.jp"]);
  assert.equal((await orderOf(r.orderId)).status, "notified");
});

test("作成時のトリガー(sendOrderMail)は期限まで待ってから送る。待つ間に取り消されれば送らない(10分ごとの定期実行でも送らない)", async () => {
  const a = await place();
  await dispatch.processMailWhenDue(mailRef(a.orderId, "d_d1"));
  assert.ok(slept.length === 1 && slept[0] >= 10000 && slept[0] <= 10000 + 1000, `期限まで待つ(${slept})`);
  assert.equal(sent.length, 2, "期限の後に送る(ディーラー宛て・注文控え)");
  // 待つ間に取り消された: 待ち始めた後に取り消し → 待ち終わっても送らない
  clock.t = T0; slept.length = 0; sent.length = 0;
  const b = await place();
  const waiting = createMailDispatchService({ db, FieldValue, Timestamp, now: () => clock.t, isEnabled: () => true,
    getSender: () => ({ send: async (msg) => { sent.push(msg); return { ok: true, id: "x" }; } }),
    sleep: async (ms) => { clock.t += 3000; await undo("ordA", b.orderId); clock.t += ms - 3000; } });   // 待っている間(3秒後)に本人が取り消す
  assert.equal(await waiting.processMailWhenDue(mailRef(b.orderId, "d_d1")), "skipped");
  clock.t += 24 * 3600e3; await dispatch.processDue();
  assert.equal(sent.length, 0);
  assert.deepEqual(await statuses(b.orderId), { copy: "cancelled", d_d1: "cancelled" });
});

test("期限内の取り消し(本人): 注文は「取消済み」で残り、メールは送信を中止。以後どの処理でも送らない。2回目は何もしない", async () => {
  for (const who of ["ordA", "proxyA", "adminA"]) {
    clock.t = T0;
    const r = await place(who);
    clock.t = T0 + 9999;   // 期限の直前
    assert.deepEqual(await undo(who, r.orderId), { orderId: r.orderId, cancelled: true, alreadyCancelled: false, cancelledMails: 2 });
    const o = await orderOf(r.orderId);
    assert.deepEqual([o.cancelled, o.status, o.deleted, o.orderNumber], [true, "cancelled", undefined, r.orderNumber], "注文番号はそのまま(戻さない)");
    assert.equal(o.cancelledBy.uid, who);
    assert.deepEqual(o.notifications.map(n => n.status), ["cancelled", "cancelled"]);
    assert.deepEqual(await statuses(r.orderId), { copy: "cancelled", d_d1: "cancelled" });
    clock.t = T0 + 60000;
    for (const k of ["d_d1", "copy"]) assert.equal(await dispatch.processMail(mailRef(r.orderId, k)), "skipped");
    await dispatch.syncOrder(db.doc(`facilities/${F}/orders/${r.orderId}`));
    await dispatch.processDue();
    assert.equal(sent.length, 0, "取り消した注文は1通も送らない");
    assert.equal((await orderOf(r.orderId)).status, "cancelled", "送信の状態の同期で上書きしない");
    assert.equal((await undo(who, r.orderId)).alreadyCancelled, true, "2回目(期限の後でも)は成功のまま何もしない");
  }
  const logs = (await db.collection(`facilities/${F}/auditLogs`).where("action", "==", "order.cancel").get()).docs.map(d => d.data());
  assert.equal(logs.length, 3);
  assert.equal((await db.collection(`facilities/${F}/orders`).get()).size, 3, "注文は消さない");
});

test("期限の後(通信の遅れを含む)は取り消せない: 「取り消せませんでした」。何も書かず、メールは従来どおり送る", async () => {
  const r = await place();
  clock.t = T0 + 10000;   // ちょうど期限
  await tooLate(undo("ordA", r.orderId));
  clock.t = T0 + 15000;
  await tooLate(undo("ordA", r.orderId));
  const o = await orderOf(r.orderId);
  assert.deepEqual([o.cancelled, o.status], [undefined, "accepted"]);
  assert.equal(await dispatch.processMail(mailRef(r.orderId, "d_d1")), "accepted");
  assert.equal(sent.length, 2);
});

test("送信を始めた注文は、期限内に見えても取り消し成功にしない(送信の確保と取り消しはどちらか一方だけ)", { timeout: 300000 }, async () => {
  // 送信の処理の時計が先に期限を過ぎ、確保した(sending)後に、時計の遅れた取り消しが届く
  const r = await place();
  let release;
  const blocked = createMailDispatchService({ db, FieldValue, Timestamp, now: () => T0 + 10000, isEnabled: () => true,
    // 最初の1通(ディーラー宛て)だけ送信の途中で止める(続く注文控えは止めない)
    getSender: () => ({ send: (msg) => (release ? (sent.push(msg), Promise.resolve({ ok: true, id: "m2" })) : new Promise(res => { release = () => { sent.push(msg); res({ ok: true, id: "m1" }); }; })) }) });
  const sending = blocked.processMail(mailRef(r.orderId, "d_d1"));
  await new Promise(res => setTimeout(res, 300));
  assert.equal((await statuses(r.orderId)).d_d1, "sending");
  const slowClock = createOrderCancelService({ db, FieldValue, now: () => T0 + 5000 });   // まだ期限内だと思っている
  await tooLate(undo("ordA", r.orderId, slowClock));
  release(); await sending;
  assert.equal((await orderOf(r.orderId)).cancelled, undefined);
  // 同時に起きた場合(6回。注文の論理削除のテストと同じ): 送信の確保と取り消しのどちらか一方だけが成功する。取り消しが成功したら1通も送られていない
  for (let i = 0; i < 6; i++) {
    sent.length = 0;
    const x = await place();
    const sender = createMailDispatchService({ db, FieldValue, Timestamp, now: () => T0 + 10000, isEnabled: () => true,
      getSender: () => ({ send: async (msg) => { sent.push(msg); return { ok: true, id: `r${i}` }; } }) });
    const [c, s] = await Promise.allSettled([undo("ordA", x.orderId, slowClock), sender.processMail(mailRef(x.orderId, "d_d1"))]);
    const cancelled = c.status === "fulfilled";
    const o = await orderOf(x.orderId);
    if (cancelled) {
      assert.equal(sent.length, 0, `${i}: 取り消しが成功したら送らない`);
      assert.equal(o.status, "cancelled");
    } else {
      assert.ok(c.reason.details && c.reason.details.reason === "too-late", `${i}: 取り消せなかった理由 ${c.reason && c.reason.message}`);
      assert.equal(s.value, "accepted");
      assert.notEqual(o.cancelled, true);
    }
  }
});

test("取り消せない: 他人の注文・所属なし・他施設・未ログイン・入力の誤り・論理削除した注文(何も書かない)", async () => {
  const r = await place("ordA");
  clock.t = T0 + 1000;
  for (const uid of ["proxyA", "adminA", "adminB", "nobody"]) {
    await assert.rejects(undo(uid, r.orderId), (e) => e.code === "not-found", uid);
  }
  await assert.rejects(cancel.cancelOrder({ auth: null, data: { facilityId: F, orderId: r.orderId } }), (e) => e.code === "unauthenticated");
  await assert.rejects(cancel.cancelOrder({ auth: user("ordA", { email_verified: false }), data: { facilityId: F, orderId: r.orderId } }), (e) => e.code === "permission-denied");
  for (const data of [{ facilityId: F }, { facilityId: F, orderId: r.orderId, force: true }, { facilityId: "../x", orderId: r.orderId }]) {
    await assert.rejects(cancel.cancelOrder({ auth: user("ordA"), data }), (e) => e.code === "invalid-argument");
  }
  assert.deepEqual(await statuses(r.orderId), { copy: "waiting", d_d1: "pending" });
  // 管理者が論理削除した注文は、本人でも取り消し済みにしない
  const d = await place("ordA");
  await deletion.deleteOrder({ auth: user("adminA"), data: { facilityId: F, orderId: d.orderId } });
  await tooLate(undo("ordA", d.orderId));
  assert.equal((await orderOf(d.orderId)).cancelled, undefined);
  // 取消時間のない旧い注文(期限の記録なし)は取り消せない
  await db.doc(`facilities/${F}/orders/${r.orderId}`).update({ cancelUntilMs: FieldValue.delete() });
  await tooLate(undo("ordA", r.orderId));
});

test("注文控えだけの注文(発注先の宛先なし)も、控えを期限まで送らず、取り消せば送らない", async () => {
  await db.doc(`facilities/${F}/facilityDealers/d1`).update({ orderEmails: [] });
  // 本番の注文は発注先へ送れないと受け付けないため、控えだけになるのはテスト注文(開発用受付)だけ
  const testOrders = createOrderService({ db, FieldValue, now: () => clock.t, isEnabled: () => true, getPolicy: () => ({ facilityIds: [F], uids: ["ordA"] }) });
  const a = await testOrders.createOrder({ auth: user("ordA"), data: { facilityId: F, requestId: crypto.randomUUID(), notes: "", lines: [line()] } });
  assert.deepEqual(await statuses(a.orderId), { copy: "pending" });
  assert.equal((await mailRef(a.orderId, "copy").get()).get("sendAfterMs"), T0 + 10000);
  assert.equal(await dispatch.processMail(mailRef(a.orderId, "copy")), "skipped");
  clock.t = T0 + 2000;
  await undo("ordA", a.orderId);
  clock.t = T0 + 60000; await dispatch.processDue();
  assert.deepEqual([sent.length, (await statuses(a.orderId)).copy], [0, "cancelled"]);
});
