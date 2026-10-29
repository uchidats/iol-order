// 注文の削除(deleteOrder。論理削除)のテスト（Firestoreエミュレータ上で実行。実プロジェクトには接続しない）
//   npm run test:functions
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { createOrderService } from "../../functions/src/orders.js";
import { createOrderDeletionService } from "../../functions/src/order-deletion.js";

const PROJECT = "demo-iol-functions";
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185").split(":");
const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");

let env, db, orders, deletion;

before(async () => {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  db = getFirestore();
  orders = createOrderService({ db, FieldValue, isEnabled: () => true });
  deletion = createOrderDeletionService({ db, FieldValue });
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(rulesPath, "utf8"), host, port: Number(port) } });
});
after(async () => { await env.clearFirestore(); await env.cleanup(); });

const F = "fA";
beforeEach(async () => {
  await env.clearFirestore();
  await db.doc(`facilities/${F}`).set({ name: "A眼科", status: "active" });
  await db.doc("facilities/fB").set({ name: "B眼科", status: "active" });
  for (const [f, uid, role] of [[F, "adminA", "admin"], [F, "subA", "subadmin"], [F, "ordA", "orderer"], [F, "proxyA", "proxy"], ["fB", "adminB", "admin"]]) {
    await db.doc(`facilities/${f}/members/${uid}`).set({ uid, role });
  }
  await db.doc(`facilities/${F}/adoptedIols/jj-dib00v`).set({ facilityId: F, catalogIolId: "jj-dib00v", enabled: true });
  await db.doc(`facilities/${F}/orderers/o1`).set({ facilityId: F, name: "山田" });
  await db.doc(`facilities/${F}/facilityDealers/d1`).set({ facilityId: F, name: "A商会", orderEmails: ["order@dealer.example.jp"] });
});

const user = (uid, over = {}) => ({ uid, token: { email: `${uid}@login.jp`, email_verified: true, name: `ログイン-${uid}`, ...over } });
const del = (auth, data) => deletion.deleteOrder({ auth, data });
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);
/** 通常の注文(テスト目的で作った通常の注文と同じ)。発注先あり → 送信待ちのメール(mails)も作られる */
async function placeOrder() {
  const r = await orders.createOrder({ auth: user("ordA"), data: { facilityId: F, requestId: crypto.randomUUID(), notes: "テスト目的",
    lines: [{ modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: "2026-11-10", doctorId: "o1", dealerId: "d1" }] } });
  return r.orderId;
}
const snapshot = async (orderId) => {
  const o = (await db.doc(`facilities/${F}/orders/${orderId}`).get()).data();
  const mails = (await db.collection(`facilities/${F}/orders/${orderId}/mails`).get()).docs.map(d => [d.id, d.data()]);
  return { o, mails };
};
const auditOf = async (f = F) => (await db.collection(`facilities/${f}/auditLogs`).where("action", "==", "order.delete").get()).docs.map(d => d.data());

test("管理者・副管理者は論理削除できる: 注文・明細・メールの記録は残り、deleted と削除者・時刻を記録。操作の記録は1件。2回目は何もしない", async () => {
  for (const actor of ["adminA", "subA"]) {
    const id = await placeOrder();
    const before = await snapshot(id);
    assert.ok(before.mails.length >= 1, "発注先宛ての送信待ちがある");
    const r = await del(user(actor), { facilityId: F, orderId: id });
    assert.deepEqual(r, { orderId: id, deleted: true, alreadyDeleted: false });
    const after = await snapshot(id);
    const { deleted, deletedAt, deletedBy, ...rest } = after.o;
    assert.equal(deleted, true);
    assert.ok(deletedAt && typeof deletedAt.toMillis === "function");
    assert.deepEqual(deletedBy, { uid: actor, role: actor === "adminA" ? "admin" : "subadmin", displayName: `ログイン-${actor}` });
    const { updatedAt: _u1, ...restBefore } = before.o;
    const { updatedAt: _u2, ...restAfter } = rest;
    assert.deepEqual(restAfter, restBefore, "注文の内容(明細・状態・送信の記録)は変えない");
    assert.deepEqual(after.mails, before.mails, "送信待ち・送信済みのメールの記録はそのまま(新しいメールも作らない)");
    // 2回目: 何もしない
    assert.deepEqual(await del(user(actor), { facilityId: F, orderId: id }), { orderId: id, deleted: true, alreadyDeleted: true });
    assert.equal((await auditOf()).filter(a => a.orderId === id).length, 1);
  }
  const logs = await auditOf();
  assert.deepEqual(logs.map(a => [a.actorUid, a.actorRole, a.testOrder]).sort(), [["adminA", "admin", false], ["subA", "subadmin", false]]);
  assert.ok(logs.every(a => /^IOL-/.test(a.orderNumber)));
  assert.equal((await db.collection(`facilities/${F}/orders`).get()).size, 2, "新たな注文は作られない");
});

test("注文者・代行入力者・他施設の管理者・所属なし・未確認のメール・未ログインは削除できない(何も書かない)", async () => {
  const id = await placeOrder();
  const before = await snapshot(id);
  for (const uid of ["ordA", "proxyA", "adminB", "stranger"]) await rejects(del(user(uid), { facilityId: F, orderId: id }), "permission-denied");
  await rejects(del(user("adminA", { email_verified: false }), { facilityId: F, orderId: id }), "permission-denied");
  await rejects(del(null, { facilityId: F, orderId: id }), "unauthenticated");
  // 運営者のクレームだけでは削除できない(施設の管理者・副管理者のみ)
  await rejects(del(user("ops", { platformAdmin: true }), { facilityId: F, orderId: id }), "permission-denied");
  // 停止中の施設
  await db.doc(`facilities/${F}`).update({ status: "suspended" });
  await rejects(del(user("adminA"), { facilityId: F, orderId: id }), "permission-denied");
  assert.deepEqual(await snapshot(id), before);
  assert.deepEqual(await auditOf(), []);
});

test("入力の検証: 施設・注文の ID の形式、余分な項目、存在しない注文", async () => {
  for (const data of [null, [], {}, { facilityId: F }, { facilityId: F, orderId: "a/b" }, { facilityId: "../x", orderId: "o" }, { facilityId: F, orderId: "o1", deleted: false }]) {
    await rejects(del(user("adminA"), data), "invalid-argument");
  }
  await rejects(del(user("adminA"), { facilityId: F, orderId: "missing" }), "not-found");
  await rejects(del(user("adminA"), { facilityId: "fB", orderId: await placeOrder() }), "permission-denied");
});

test("テスト注文(testOrder)も削除できる。記録にテスト注文であることを残す", async () => {
  await db.doc(`facilities/${F}/orders/t1`).set({ orderNumber: "IOL-20261024-09", testOrder: true, status: "accepted", lines: [] });
  await del(user("subA"), { facilityId: F, orderId: "t1" });
  assert.equal((await db.doc(`facilities/${F}/orders/t1`).get()).get("deleted"), true);
  assert.deepEqual((await auditOf()).map(a => [a.orderNumber, a.testOrder]), [["IOL-20261024-09", true]]);
});
