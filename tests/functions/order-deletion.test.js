// 注文の削除(deleteOrder。論理削除)と、手術日順の索引(indexOrderSurgeryDates)のテスト（Firestoreエミュレータ上で実行。実プロジェクトには接続しない）
//   npm run test:functions
// 送信の処理は本物(order-mail-outbox.js の createMailDispatchService)を、偽の配信サービスで動かす(実メールは送らない)。
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { getDoc, getDocs, doc, setDoc, updateDoc, collection, query, where, orderBy } from "firebase/firestore";
import { createOrderService } from "../../functions/src/orders.js";
import { createOrderDeletionService } from "../../functions/src/order-deletion.js";
import { createOrderSurgeryIndexService, surgeryIndexEntries } from "../../functions/src/order-surgery-index.js";
import { createMailDispatchService, MAIL_LIMITS } from "../../functions/src/order-mail-outbox.js";

const PROJECT = "demo-iol-functions";
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185").split(":");
const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");

let env, db, orders, deletion, surgeryIndex, dispatch, sent, behavior, enabled, clock;

before(async () => {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  db = getFirestore();
  clock = { t: Date.parse("2026-10-26T00:00:00Z") };
  orders = createOrderService({ db, FieldValue, now: () => clock.t, isEnabled: () => true });
  deletion = createOrderDeletionService({ db, FieldValue });
  surgeryIndex = createOrderSurgeryIndexService({ db });
  dispatch = createMailDispatchService({ db, FieldValue, Timestamp, now: () => clock.t, isEnabled: () => enabled,
    getSender: () => ({ send: async (msg) => { sent.push(msg); return behavior(msg, sent.length); } }) });
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(rulesPath, "utf8"), host, port: Number(port) } });
});
after(async () => { await env.clearFirestore(); await env.cleanup(); });

const F = "fA";
beforeEach(async () => {
  await env.clearFirestore();
  clock.t = Date.parse("2026-10-26T00:00:00Z");
  sent = []; enabled = true; behavior = (msg, n) => ({ ok: true, id: `msg_${n}` });
  await db.doc(`facilities/${F}`).set({ name: "A眼科", status: "active" });
  await db.doc("facilities/fB").set({ name: "B眼科", status: "active" });
  for (const [f, uid, role] of [[F, "adminA", "admin"], [F, "subA", "subadmin"], [F, "ordA", "orderer"], [F, "proxyA", "proxy"], ["fB", "adminB", "admin"]]) {
    await db.doc(`facilities/${f}/members/${uid}`).set({ uid, role });
  }
  await db.doc(`facilities/${F}/adoptedIols/jj-dib00v`).set({ facilityId: F, catalogIolId: "jj-dib00v", enabled: true });
  await db.doc(`facilities/${F}/orderers/o1`).set({ facilityId: F, name: "山田" });
  await db.doc(`facilities/${F}/facilityDealers/d1`).set({ facilityId: F, name: "A商会", orderEmails: ["order@dealer.example.jp"] });
  await db.doc(`facilities/${F}/facilityDealers/d2`).set({ facilityId: F, name: "B医療", orderEmails: ["order@b.example.jp"] });
  await db.doc(`facilities/${F}/settings/mail`).set({ copyEnabled: true, copyEmail: "info@clinic.example.jp" });
});

const user = (uid, over = {}) => ({ uid, token: { email: `${uid}@login.jp`, email_verified: true, name: `ログイン-${uid}`, ...over } });
const del = (auth, data) => deletion.deleteOrder({ auth, data });
const rejects = (p, code, re) => assert.rejects(p, (e) => e.code === code && (!re || re.test(e.message)), `expected ${code}`);
const line = (over = {}) => ({ modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: "2026-11-10", doctorId: "o1", dealerId: "d1", ...over });
/** 通常の注文(テスト目的で作った通常の注文と同じ)。発注先2社 + 注文控え → 送信待ちのメール3通(d_d1・d_d2 は pending、copy は waiting) */
async function placeOrder(lines = [line(), line({ dealerId: "d2", power: "+21.0D", surgeryDate: "2026-11-12" })]) {
  const r = await orders.createOrder({ auth: user("ordA"), data: { facilityId: F, requestId: crypto.randomUUID(), notes: "テスト目的", lines } });
  return r.orderId;
}
const mailRef = (orderId, id) => db.doc(`facilities/${F}/orders/${orderId}/mails/${id}`);
const mailsOf = async (orderId) => Object.fromEntries((await db.collection(`facilities/${F}/orders/${orderId}/mails`).get()).docs.map(d => [d.id, d.data()]));
const statuses = async (orderId) => Object.fromEntries(Object.entries(await mailsOf(orderId)).map(([k, v]) => [k, v.status]));
const orderOf = async (orderId) => (await db.doc(`facilities/${F}/orders/${orderId}`).get()).data();
const auditOf = async (f = F) => (await db.collection(`facilities/${f}/auditLogs`).where("action", "==", "order.delete").get()).docs.map(d => d.data());

test("管理者・副管理者は論理削除できる: 未送信(送信待ち・控えの待機)は送信を中止し、以後の自動送信・定期処理でも送らない。注文・明細・メールの記録は残る", async () => {
  for (const actor of ["adminA", "subA"]) {
    const id = await placeOrder();
    assert.deepEqual(await statuses(id), { copy: "waiting", d_d1: "pending", d_d2: "pending" });
    const before = await orderOf(id);
    const r = await del(user(actor), { facilityId: F, orderId: id });
    assert.deepEqual(r, { orderId: id, deleted: true, alreadyDeleted: false, cancelledMails: 3, keptMails: 0 });
    assert.deepEqual(await statuses(id), { copy: "cancelled", d_d1: "cancelled", d_d2: "cancelled" });
    const m = await mailsOf(id);
    assert.deepEqual([m.d_d1.previousStatus, m.copy.previousStatus, m.d_d1.cancelledBy], ["pending", "waiting", actor]);
    assert.ok(m.d_d1.subject && m.d_d1.text && m.d_d1.to.length, "メールの記録(件名・本文・宛先)は残す");
    const after = await orderOf(id);
    assert.equal(after.deleted, true);
    assert.deepEqual(after.deletedBy, { uid: actor, role: actor === "adminA" ? "admin" : "subadmin", displayName: `ログイン-${actor}` });
    assert.deepEqual(after.lines, before.lines, "明細はそのまま");
    assert.deepEqual(after.notifications.map(n => n.status), ["cancelled", "cancelled", "cancelled"]);
    // 作成時のトリガー(sendOrderMail)・定期実行(retryOrderMails)・注文控えの解放(syncOrder)が後から動いても送らない
    for (const k of ["d_d1", "d_d2", "copy"]) assert.equal(await dispatch.processMail(mailRef(id, k)), "skipped");
    await dispatch.syncOrder(db.doc(`facilities/${F}/orders/${id}`));
    await dispatch.processDue();
    clock.t += 24 * 3600e3; await dispatch.processDue();
    assert.equal(sent.length, 0, "削除後は1通も送らない");
    assert.deepEqual(await statuses(id), { copy: "cancelled", d_d1: "cancelled", d_d2: "cancelled" });
    // 2回目: 何もしない(記録も増やさない)
    assert.equal((await del(user(actor), { facilityId: F, orderId: id })).alreadyDeleted, true);
    assert.equal((await auditOf()).filter(a => a.orderId === id).length, 1);
  }
  const logs = await auditOf();
  assert.deepEqual(logs.map(a => [a.actorRole, a.cancelledMails, a.keptMails]).sort(), [["admin", 3, 0], ["subadmin", 3, 0]]);
  assert.equal((await db.collection(`facilities/${F}/orders`).get()).size, 2, "新たな注文は作られない");
});

test("送信済みは取り消さない・残す。再送待ち(retry)・送信停止中の保留(held)・控えの待機は中止し、再送もしない", async () => {
  // d1 は送信済み(accepted)、d2 は一時的な失敗で再送待ち(retry)、控えは待機(waiting)
  behavior = (msg) => (msg.to[0] === "order@b.example.jp" ? { ok: false, retryable: true, error: "HTTP 503" } : { ok: true, id: `msg_${sent.length}` });
  const id = await placeOrder();
  await dispatch.processMail(mailRef(id, "d_d1"));
  await dispatch.processMail(mailRef(id, "d_d2"));
  assert.deepEqual(await statuses(id), { copy: "waiting", d_d1: "accepted", d_d2: "retry" });
  const sentBefore = sent.length;
  const r = await del(user("adminA"), { facilityId: F, orderId: id });
  assert.deepEqual([r.cancelledMails, r.keptMails], [2, 1]);
  assert.deepEqual(await statuses(id), { copy: "cancelled", d_d1: "accepted", d_d2: "cancelled" }, "送信済みはそのまま");
  behavior = () => ({ ok: true, id: "late" });
  for (let i = 0; i < MAIL_LIMITS.maxAttempts; i++) { clock.t += 4 * 3600e3; await dispatch.processDue(); }
  assert.equal(sent.length, sentBefore, "再送しない・控えも送らない");
  // 送信停止中(held)の注文も削除でき、保留は中止になる(後で送信を再開しても送らない)
  enabled = false;
  const id2 = await placeOrder();
  for (const k of ["d_d1", "d_d2"]) await dispatch.processMail(mailRef(id2, k));
  assert.deepEqual(await statuses(id2), { copy: "held", d_d1: "held", d_d2: "held" }, "送信停止中: ディーラー宛て・控えとも保留");
  await del(user("subA"), { facilityId: F, orderId: id2 });
  assert.deepEqual(await statuses(id2), { copy: "cancelled", d_d1: "cancelled", d_d2: "cancelled" });
  enabled = true;
  await dispatch.processDue();
  assert.equal(sent.length, sentBefore);
});

test("送信の処理中(sending)は、送信を止められるか保証できないため削除しない(何も書かない)。結果が決まった後は削除できる", async () => {
  const id = await placeOrder();
  // 送信処理の「確保」だけ済んだ状態(配信サービスへの送信中)を作る: 送信を待たせる
  let release;
  behavior = () => new Promise(r => { release = () => r({ ok: true, id: "m1" }); });
  const inflight = dispatch.processMail(mailRef(id, "d_d1"));
  for (let i = 0; i < 50 && (await statuses(id)).d_d1 !== "sending"; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal((await statuses(id)).d_d1, "sending");
  const before = await orderOf(id);
  await rejects(del(user("adminA"), { facilityId: F, orderId: id }), "failed-precondition", /送信処理中/);
  assert.deepEqual(await orderOf(id), before, "注文は変えない");
  assert.equal((await statuses(id)).copy, "waiting", "ほかのメールも変えない");
  assert.deepEqual(await auditOf(), []);
  // 送信の処理中に期限(5分)を過ぎて止まった扱いでも、同じく断る(定期処理が拾い直すまで)
  clock.t += MAIL_LIMITS.leaseMs + 1000;
  await rejects(del(user("adminA"), { facilityId: F, orderId: id }), "failed-precondition");
  // 送信の結果が決まった(送信済み)後は削除でき、送信済みは残す。控えは中止
  clock.t -= MAIL_LIMITS.leaseMs + 1000;
  const finish = release;
  behavior = (msg, n) => ({ ok: true, id: `msg_${n}` });
  finish(); await inflight;
  assert.deepEqual(await statuses(id), { copy: "waiting", d_d1: "accepted", d_d2: "pending" });
  const sentBefore = sent.length;
  const r = await del(user("adminA"), { facilityId: F, orderId: id });
  assert.deepEqual([r.cancelledMails, r.keptMails], [2, 1]);
  assert.deepEqual(await statuses(id), { copy: "cancelled", d_d1: "accepted", d_d2: "cancelled" });
  await dispatch.processDue();
  assert.equal(sent.length, sentBefore, "注文控えも送らない");
  // 知らない状態のメールがあれば削除しない
  const id2 = await placeOrder([line()]);
  await mailRef(id2, "d_d1").update({ status: "mystery" });
  await rejects(del(user("adminA"), { facilityId: F, orderId: id2 }), "failed-precondition", /状態を確認できない/);
});

test("削除と送信の確保が同時に起きても、送られるか・削除されるかのどちらか一方(削除の後に送られない)", async () => {
  for (let round = 0; round < 6; round++) {
    const id = await placeOrder([line()]);
    const sentBefore = sent.length;
    const [d, s] = await Promise.allSettled([del(user("adminA"), { facilityId: F, orderId: id }), dispatch.processMail(mailRef(id, "d_d1"))]);
    const st = await statuses(id);
    if (d.status === "fulfilled") {
      // 削除が先: 送信待ちは中止され、送られていない。または送信が先に終わってから削除(送信済みは残る)
      assert.ok(st.d_d1 === "cancelled" || st.d_d1 === "accepted", JSON.stringify(st));
      if (st.d_d1 === "cancelled") assert.equal(sent.length, sentBefore, "中止したメールは送らない");
    } else {
      // 送信の確保が先: 削除は断られ、注文はそのまま
      assert.match(d.reason.message, /送信処理中/);
      assert.notEqual((await orderOf(id)).deleted, true);
    }
    assert.equal(s.status, "fulfilled");
  }
});

test("注文者・代行入力者・他施設の管理者・所属なし・未確認のメール・未ログイン・運営者のクレームだけ・停止中の施設は削除できない(何も書かない)", async () => {
  const id = await placeOrder();
  const before = [await orderOf(id), await statuses(id)];
  for (const uid of ["ordA", "proxyA", "adminB", "stranger"]) await rejects(del(user(uid), { facilityId: F, orderId: id }), "permission-denied");
  await rejects(del(user("adminA", { email_verified: false }), { facilityId: F, orderId: id }), "permission-denied");
  await rejects(del(null, { facilityId: F, orderId: id }), "unauthenticated");
  await rejects(del(user("ops", { platformAdmin: true }), { facilityId: F, orderId: id }), "permission-denied");
  await db.doc(`facilities/${F}`).update({ status: "suspended" });
  await rejects(del(user("adminA"), { facilityId: F, orderId: id }), "permission-denied");
  assert.deepEqual([await orderOf(id), await statuses(id)], before);
  assert.deepEqual(await auditOf(), []);
});

test("入力の検証: 施設・注文の ID の形式、余分な項目、存在しない注文、他施設の注文", async () => {
  for (const data of [null, [], {}, { facilityId: F }, { facilityId: F, orderId: "a/b" }, { facilityId: "../x", orderId: "o" }, { facilityId: F, orderId: "o1", deleted: false }]) {
    await rejects(del(user("adminA"), data), "invalid-argument");
  }
  await rejects(del(user("adminA"), { facilityId: F, orderId: "missing" }), "not-found");
  await rejects(del(user("adminA"), { facilityId: "fB", orderId: await placeOrder() }), "permission-denied");
});

test("テスト注文(testOrder)も削除できる。記録にテスト注文であることを残す", async () => {
  await db.doc(`facilities/${F}/orders/t1`).set({ orderNumber: "IOL-20261024-09", testOrder: true, status: "accepted", lines: [] });
  await del(user("subA"), { facilityId: F, orderId: "t1" });
  assert.equal((await orderOf("t1")).deleted, true);
  assert.deepEqual((await auditOf()).map(a => [a.orderNumber, a.testOrder]), [["IOL-20261024-09", true]]);
});

test("手術日の索引: 手術日ごとに1件(複数の手術日は日ごと)。冪等。削除で印が付き、削除の後に作られても印を写す。手術日の読めない旧データも最後に出す", async () => {
  const id = await placeOrder([line(), line({ dealerId: "d2", surgeryDate: "2026-11-12" }), line({ power: "+21.5D" })]);
  await surgeryIndex.indexOrder(F, id);
  await surgeryIndex.indexOrder(F, id);   // 再試行しても重複しない
  const idx = async () => (await db.collection(`facilities/${F}/orderSurgeryIndex`).where("orderId", "==", id).get()).docs.map(d => [d.id, d.get("surgeryDate"), d.get("lineNos"), d.get("deleted")]).sort();
  assert.deepEqual(await idx(), [[`${id}_2026-11-10`, "2026-11-10", [1, 3], false], [`${id}_2026-11-12`, "2026-11-12", [2], false]]);
  assert.ok((await db.doc(`facilities/${F}/orderSurgeryIndex/${id}_2026-11-10`).get()).get("createdAt").toMillis() > 0);
  await del(user("adminA"), { facilityId: F, orderId: id });
  assert.deepEqual((await idx()).map(x => x[3]), [true, true], "削除で印");
  // 削除が索引の作成より先(トリガーが遅れた)でも、作成時に注文の印を写す
  const id2 = await placeOrder([line()]);
  await del(user("adminA"), { facilityId: F, orderId: id2 });
  await surgeryIndex.indexOrder(F, id2);
  assert.equal((await db.doc(`facilities/${F}/orderSurgeryIndex/${id2}_2026-11-10`).get()).get("deleted"), true);
  // 旧形式(注文全体の手術日)・手術日の読めない明細・明細なし
  assert.deepEqual(surgeryIndexEntries(F, "v1", { item: {}, surgeryDate: "2026-09-01", createdAt: null }).map(e => [e.id, e.data.surgeryDate, e.data.lineNos]), [["v1_2026-09-01", "2026-09-01", [1]]]);
  assert.deepEqual(surgeryIndexEntries(F, "x", { lines: [{ lineNo: 1, surgeryDate: "2026/09/01" }] }).map(e => [e.id, e.data.surgeryDate]), [["x_nodate", ""]]);
  assert.deepEqual(surgeryIndexEntries(F, "y", { lines: [] }).map(e => e.id), ["y_nodate"]);
  assert.equal(await surgeryIndex.indexOrder(F, "missing").then(r => r.created), 0);
});

test("Rules: 手術日の索引は所属メンバーと運営者だけが読める(手術日順の問い合わせも)。書き込みはだれもできない。注文の論理削除の印・メールの中止もクライアントからはできない", async () => {
  const id = await placeOrder();
  await surgeryIndex.indexOrder(F, id);
  const as = (uid, claims = {}) => env.authenticatedContext(uid, { email: `${uid}@login.jp`, email_verified: true, ...claims }).firestore();
  const q = (fdb) => query(collection(fdb, `facilities/${F}/orderSurgeryIndex`), where("deleted", "==", false), orderBy("surgeryDate", "desc"), orderBy("createdAt", "desc"));
  for (const uid of ["ordA", "proxyA", "adminA"]) {
    assert.equal((await assertSucceeds(getDocs(q(as(uid))))).size, 2, uid);
  }
  await assertSucceeds(getDocs(q(as("ops", { platformAdmin: true }))));
  await assertFails(getDocs(q(as("adminB"))));
  await assertFails(getDoc(doc(as("stranger"), `facilities/${F}/orderSurgeryIndex/${id}_2026-11-10`)));
  for (const uid of ["adminA", "ordA"]) {
    await assertFails(setDoc(doc(as(uid), `facilities/${F}/orderSurgeryIndex/fake_2026-01-01`), { orderId: "fake", surgeryDate: "2026-01-01", deleted: false }));
    await assertFails(updateDoc(doc(as(uid), `facilities/${F}/orderSurgeryIndex/${id}_2026-11-10`), { deleted: true }));
    await assertFails(updateDoc(doc(as(uid), `facilities/${F}/orders/${id}`), { deleted: true }));
    await assertFails(updateDoc(doc(as(uid), `facilities/${F}/orders/${id}/mails/d_d1`), { status: "cancelled" }));
  }
});
