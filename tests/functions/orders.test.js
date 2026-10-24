// 注文受付(createOrder)のテスト（Firestoreエミュレータ上で実行。実プロジェクトには接続しない）
//   npm run test:functions
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, collection } from "firebase/firestore";
import { createOrderService, ORDER_STATUS, ORDER_LIMITS, deriveOrderId, jstDate } from "../../functions/src/orders.js";

const PROJECT = "demo-iol-functions";
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185").split(":");
const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");

let env, db, service, clock, enabled;

before(async () => {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  db = getFirestore();
  clock = { t: Date.parse("2026-10-24T00:00:00Z") }; // JST 2026-10-24 09:00
  enabled = { v: true };
  service = createOrderService({ db, FieldValue, now: () => clock.t, isEnabled: () => enabled.v });
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(rulesPath, "utf8"), host, port: Number(port) } });
});
after(async () => { await env.clearFirestore(); await env.cleanup(); }); // 後続のテストファイルにデータを残さない

const F = "fA";
beforeEach(async () => {
  await env.clearFirestore();
  clock.t = Date.parse("2026-10-24T00:00:00Z");
  enabled.v = true;
  await db.doc(`facilities/${F}`).set({ name: "A眼科", status: "active" });
  await db.doc("facilities/fB").set({ name: "B眼科", status: "active" });
  await seedMember(F, "ordA", "orderer");
  await seedMember(F, "adminA", "admin");
  await seedMember(F, "offA", "orderer", "disabled");
  await seedMember("fB", "ordB", "orderer");
  for (const f of [F, "fB"]) {
    for (const id of ["jj-dib00v", "jj-diwxxx-toric", "nidek-nsp-2", "alcon-mn60ma-yellow"]) {
      await db.doc(`facilities/${f}/adoptedIols/${id}`).set({ facilityId: f, catalogIolId: id, enabled: true });
    }
    await db.doc(`facilities/${f}/orderers/o1`).set({ facilityId: f, name: "山田", email: "y@orderer.jp", active: true });
    await db.doc(`facilities/${f}/orderers/o2`).set({ facilityId: f, name: "佐藤", active: true });
    await db.doc(`facilities/${f}/orderers/o3`).set({ facilityId: f, name: "休止", active: false });
  }
  await db.doc(`facilities/${F}/adoptedIols/alcon-cna0t0`).set({ facilityId: F, catalogIolId: "alcon-cna0t0", enabled: false }); // 採用解除
});

const seedMember = (fid, uid, role = "orderer", status = "active") => db.doc(`facilities/${fid}/members/${uid}`).set({ uid, role, status });
const user = (uid, over = {}) => ({ uid, token: { email: `${uid}@login.jp`, email_verified: true, name: `ログイン-${uid}`, ...over } });
const rid = () => crypto.randomUUID();
const body = (over = {}) => ({
  facilityId: F, requestId: rid(), modelId: "jj-dib00v", power: "+20.0D", quantity: 1,
  surgeryDate: "2026-11-10", ordererId: "o1", notes: "右眼", ...over
});
const order = (auth, data) => service.createOrder({ auth, data });
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);
const orders = async (f = F) => (await db.collection(`facilities/${f}/orders`).get()).docs;

// ================= 正常系・スナップショット =================
test("正常系: 検証して保存され、受付済み(accepted)・サーバー発行の注文番号・マスターのスナップショットが記録される", async () => {
  const d = body();
  const r = await order(user("ordA"), d);
  assert.equal(r.status, ORDER_STATUS.ACCEPTED);
  assert.equal(r.replayed, false);
  assert.match(r.orderNumber, /^IOL-20261024-0001$/);
  assert.equal(r.orderId, deriveOrderId("ordA", d.requestId));

  const o = (await db.doc(`facilities/${F}/orders/${r.orderId}`).get()).data();
  assert.equal(o.status, "accepted");
  assert.equal(o.facilityId, F);
  assert.equal(o.facilityName, "A眼科");
  assert.deepEqual(o.item, {
    modelId: "jj-dib00v", manufacturer: "J&J", model: "DIB00V", displayName: "J&J / DIB00V",
    isToric: false, toricModel: "", power: "+20.0D", quantity: 1
  });
  assert.equal(o.surgeryDate, "2026-11-10");
  assert.deepEqual(o.orderer, { id: "o1", name: "山田", email: "y@orderer.jp" }); // マスターから取得
  assert.deepEqual(o.createdBy, { uid: "ordA", email: "orda@login.jp", displayName: "ログイン-ordA" }); // 注文者とは別に記録
  assert.equal(o.notes, "右眼");
  assert.ok(o.createdAt && o.acceptedAt && o.requestId === d.requestId && o.schemaVersion === 1);
});

test("注文者のメールは任意: 未登録でも受け付けられ、null で保存される。管理者も注文できる", async () => {
  const r = await order(user("adminA"), body({ ordererId: "o2" }));
  const o = (await db.doc(`facilities/${F}/orders/${r.orderId}`).get()).data();
  assert.equal(o.orderer.email, null);
  assert.equal(o.createdBy.uid, "adminA");
});

test("マスターを後で変更しても、過去の注文の内容は変わらない(スナップショット)", async () => {
  const r = await order(user("ordA"), body());
  await db.doc(`facilities/${F}/orderers/o1`).update({ name: "改名", email: "new@x.jp" });
  await db.doc(`facilities/${F}`).update({ name: "改名眼科" });
  const o = (await db.doc(`facilities/${F}/orders/${r.orderId}`).get()).data();
  assert.equal(o.orderer.name, "山田");
  assert.equal(o.orderer.email, "y@orderer.jp");
  assert.equal(o.facilityName, "A眼科");
});

test("注文番号は日付ごと・施設ごとの連番で、サーバーが発行する", async () => {
  const a = await order(user("ordA"), body());
  const b = await order(user("ordA"), body());
  const c = await order(user("ordB", {}), body({ facilityId: "fB" }));
  assert.deepEqual([a.orderNumber, b.orderNumber], ["IOL-20261024-0001", "IOL-20261024-0002"]);
  assert.equal(c.orderNumber, "IOL-20261024-0001");
  clock.t += 24 * 60 * 60 * 1000;
  assert.equal((await order(user("ordA"), body())).orderNumber, "IOL-20261025-0001");
});

test("クライアントは注文番号・状態・作成者・価格・レンズ名・注文者名などを指定できない(未知のキーは拒否)", async () => {
  for (const extra of [{ orderNumber: "X" }, { status: "notified" }, { createdBy: "evil" }, { price: 1 }, { displayName: "偽" }, { orderer: "偽" }, { email: "a@b.jp" }, { role: "admin" }]) {
    await rejects(order(user("ordA"), body(extra)), "invalid-argument");
  }
  assert.equal((await orders()).length, 0);
});

// ================= 認証・権限 =================
test("未認証・メール未確認・所属なし・他施設・無効化されたユーザーは拒否され、何も保存されない", async () => {
  await rejects(order(null, body()), "unauthenticated");
  await rejects(order(user("ordA", { email_verified: false }), body()), "permission-denied");
  await rejects(order(user("stranger"), body()), "permission-denied");
  await rejects(order(user("ordB"), body()), "permission-denied");          // 他施設の所属者が自施設以外へ
  await rejects(order(user("ordA"), body({ facilityId: "fB" })), "permission-denied"); // 自施設の所属者が他施設へ
  await rejects(order(user("offA"), body()), "permission-denied");          // 無効化されたユーザー
  await db.doc(`facilities/${F}`).update({ status: "suspended" });
  await rejects(order(user("ordA"), body()), "permission-denied");          // 停止中の施設
  assert.equal((await orders()).length + (await orders("fB")).length, 0);
});

test("無効化された後の再送でも、既存の注文を返さず拒否する(権限は毎回再確認)", async () => {
  const d = body();
  await order(user("ordA"), d);
  await db.doc(`facilities/${F}/members/ordA`).update({ status: "disabled" });
  await rejects(order(user("ordA"), d), "permission-denied");
});

test("権限の無い role(不明な値)の所属は注文できない", async () => {
  await seedMember(F, "weird", "viewer");
  await rejects(order(user("weird"), body()), "permission-denied");
});

test("キルスイッチ: 無効な間は認証済みの所属者でも受け付けない", async () => {
  enabled.v = false;
  await rejects(order(user("ordA"), body()), "failed-precondition");
  assert.equal((await orders()).length, 0);
  enabled.v = true;
  await order(user("ordA"), body());
});

// ================= 内容の検証 =================
test("未採用・採用解除・存在しないIOLモデルは拒否される", async () => {
  await rejects(order(user("ordA"), body({ modelId: "alcon-cna0t0" })), "invalid-argument");   // 採用解除
  await rejects(order(user("ordA"), body({ modelId: "hoya-xy1" })), "invalid-argument");       // 未採用
  await rejects(order(user("ordA"), body({ modelId: "no-such-model" })), "invalid-argument");
  await rejects(order(user("ordA"), body({ modelId: "../../x" })), "invalid-argument");
});

test("度数: モデルの範囲・刻みに合わないもの、形式の違うものは拒否される", async () => {
  for (const power of ["+5.5D", "+30.5D", "+20.2D", "20.0D", "+20D", "abc", "", "+20.0D ", "-5.0D"]) {
    await rejects(order(user("ordA"), body({ power })), "invalid-argument");
  }
  await order(user("ordA"), body({ power: "+6.0D" }));
  await order(user("ordA"), body({ power: "+30.0D" }));
  // 別のモデルの範囲(-5〜+5 / 1.0刻み)
  await order(user("ordA"), body({ modelId: "alcon-mn60ma-yellow", power: "-5.0D" }));
  await order(user("ordA"), body({ modelId: "alcon-mn60ma-yellow", power: "0D" }));
  await rejects(order(user("ordA"), body({ modelId: "alcon-mn60ma-yellow", power: "+0.5D" })), "invalid-argument");
  await rejects(order(user("ordA"), body({ modelId: "alcon-mn60ma-yellow", power: "+20.0D" })), "invalid-argument");
  // 区間ごとに刻みが違うモデル(1.0〜5.0は1.0刻み、5.0〜27.0は0.5刻み)
  await order(user("ordA"), body({ modelId: "nidek-nsp-2", power: "+3.0D" }));
  await order(user("ordA"), body({ modelId: "nidek-nsp-2", power: "+5.5D" }));
  await rejects(order(user("ordA"), body({ modelId: "nidek-nsp-2", power: "+4.5D" })), "invalid-argument");
});

test("トーリック: 型番は必須で、そのモデルの型番のみ。非トーリックに型番は付けられない", async () => {
  const t = { modelId: "jj-diwxxx-toric" };
  await rejects(order(user("ordA"), body({ ...t })), "invalid-argument");
  await rejects(order(user("ordA"), body({ ...t, toricModel: "" })), "invalid-argument");
  await rejects(order(user("ordA"), body({ ...t, toricModel: "ZZZ" })), "invalid-argument");
  await rejects(order(user("ordA"), body({ toricModel: "DIW150" })), "invalid-argument");
  const r = await order(user("ordA"), body({ ...t, toricModel: "DIW225" }));
  const o = (await db.doc(`facilities/${F}/orders/${r.orderId}`).get()).data();
  assert.equal(o.item.toricModel, "DIW225");
  assert.equal(o.item.isToric, true);
});

test("枚数・手術日・備考・識別子の検証", async () => {
  for (const quantity of [0, 3, -1, "1 枚", 1.5, null]) await rejects(order(user("ordA"), body({ quantity })), "invalid-argument");
  for (const surgeryDate of ["2026-10-23", "2026-02-30", "2026/11/10", "20261110", "", null, "2028-01-01"]) {
    await rejects(order(user("ordA"), body({ surgeryDate })), "invalid-argument");
  }
  await order(user("ordA"), body({ surgeryDate: "2026-10-24" })); // 本日(日本時間)は可
  await rejects(order(user("ordA"), body({ notes: "あ".repeat(ORDER_LIMITS.notesMax + 1) })), "invalid-argument");
  await rejects(order(user("ordA"), body({ requestId: "short" })), "invalid-argument");
  await rejects(order(user("ordA"), body({ requestId: "x".repeat(65) })), "invalid-argument");
  await rejects(order(user("ordA"), body({ facilityId: "a/b" })), "invalid-argument");
  await rejects(order(user("ordA"), { ...body(), facilityId: undefined }), "invalid-argument");
  await rejects(order(user("ordA"), null), "invalid-argument");
  await rejects(order(user("ordA"), []), "invalid-argument");
});

test("手術日の「本日」は日本時間で判定する(UTCでは前日でも、日本ではその日)", async () => {
  clock.t = Date.parse("2026-10-24T20:00:00Z"); // JST 10-25 05:00
  assert.equal(jstDate(clock.t), "2026-10-25");
  await rejects(order(user("ordA"), body({ surgeryDate: "2026-10-24" })), "invalid-argument");
  await order(user("ordA"), body({ surgeryDate: "2026-10-25" }));
});

test("注文者: 施設のマスターにいる有効な注文者のみ。存在しない・休止・他施設の注文者は拒否される", async () => {
  await rejects(order(user("ordA"), body({ ordererId: "nobody" })), "invalid-argument");
  await rejects(order(user("ordA"), body({ ordererId: "o3" })), "invalid-argument"); // active=false
  await db.doc("facilities/fB/orderers/onlyB").set({ facilityId: "fB", name: "他施設の人", active: true });
  await rejects(order(user("ordA"), body({ ordererId: "onlyB" })), "invalid-argument");
  assert.equal((await orders()).length, 0);
});

// ================= 冪等性・二重送信 =================
test("同じ requestId・同じ内容の再送は、既存の注文番号を返し、二重登録しない", async () => {
  const d = body();
  const a = await order(user("ordA"), d);
  const b = await order(user("ordA"), { ...d });
  assert.equal(b.replayed, true);
  assert.equal(b.orderNumber, a.orderNumber);
  assert.equal(b.orderId, a.orderId);
  assert.equal((await orders()).length, 1);
  assert.equal((await db.doc(`facilities/${F}/orderCounters/20261024`).get()).get("count"), 1);
});

test("同じ requestId で内容が違う場合は拒否され、元の注文は変わらない", async () => {
  const d = body();
  const a = await order(user("ordA"), d);
  for (const change of [{ power: "+21.0D" }, { quantity: 2 }, { surgeryDate: "2026-11-11" }, { ordererId: "o2" }, { modelId: "nidek-nsp-2" }, { notes: "左眼" }]) {
    await rejects(order(user("ordA"), { ...d, ...change }), "already-exists");
  }
  const o = (await db.doc(`facilities/${F}/orders/${a.orderId}`).get()).data();
  assert.equal(o.item.power, "+20.0D");
  assert.equal((await orders()).length, 1);
});

test("同時送信(同じ requestId を並列で20回)でも注文は1件だけ作られ、全員が同じ注文番号を受け取る", async () => {
  const d = body();
  const results = await Promise.all(Array.from({ length: 20 }, () => order(user("ordA"), d)));
  assert.equal(new Set(results.map(r => r.orderNumber)).size, 1);
  assert.equal(results.filter(r => !r.replayed).length, 1);
  assert.equal((await orders()).length, 1);
});

test("同時送信(別々の注文を並列で10件)では、注文番号が重複・欠番しない", async () => {
  const rs = await Promise.all(Array.from({ length: 10 }, () => order(user("ordA"), body())));
  const nums = rs.map(r => r.orderNumber).sort();
  assert.deepEqual(nums, Array.from({ length: 10 }, (_, i) => `IOL-20261024-${String(i + 1).padStart(4, "0")}`));
});

test("通信断後の再試行: 1回目は保存済みだが応答を受け取れなかった想定で、再試行しても1件のまま", async () => {
  const d = body();
  await order(user("ordA"), d); // 応答は失われた
  const retry = await order(user("ordA"), d);
  assert.equal(retry.replayed, true);
  assert.equal((await orders()).length, 1);
});

test("別のユーザーが同じ requestId を使っても、互いに干渉しない", async () => {
  const requestId = rid();
  const a = await order(user("ordA"), body({ requestId }));
  const b = await order(user("adminA"), body({ requestId, power: "+21.0D" }));
  assert.notEqual(a.orderId, b.orderId);
  assert.equal((await orders()).length, 2);
});

test("検証に失敗した注文は、注文番号を消費せず、何も保存しない", async () => {
  await rejects(order(user("ordA"), body({ power: "+99.0D" })), "invalid-argument");
  const r = await order(user("ordA"), body());
  assert.equal(r.orderNumber, "IOL-20261024-0001");
});

test("レート制限: 同一ユーザーの連続呼び出しは上限で拒否される", async () => {
  for (let i = 0; i < ORDER_LIMITS.rateMax; i++) await rejects(order(user("ordA"), body({ power: "+99.0D" })), "invalid-argument");
  await rejects(order(user("ordA"), body()), "resource-exhausted");
  await order(user("adminA"), body()); // 他ユーザーには影響しない
});

// ================= Security Rules(注文はクライアントから書けず、施設外には読ませない) =================
test("Rules: 注文はどのクライアントからも作成・変更・削除できない。読めるのは自施設の有効な所属者のみ", async () => {
  const r = await order(user("ordA"), body());
  const path = `facilities/${F}/orders/${r.orderId}`;
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();

  // 自施設の所属者は読める(管理者・注文者)
  for (const uid of ["ordA", "adminA"]) assert.equal((await getDoc(doc(ctx(uid), path))).exists(), true);
  // 他施設・所属なし・無効化・未認証は読めない
  for (const c of [ctx("ordB"), ctx("stranger"), ctx("offA"), env.unauthenticatedContext().firestore()]) {
    await assertFails(getDoc(doc(c, path)));
    await assertFails(getDocs(collection(c, `facilities/${F}/orders`)));
  }
  // 書き込みは全員不可(運営者含む)
  for (const c of [ctx("ordA"), ctx("adminA"), ctx("ops", { platformAdmin: true })]) {
    await assertFails(setDoc(doc(c, `facilities/${F}/orders/forged`), { status: "accepted", facilityId: F }));
    await assertFails(updateDoc(doc(c, path), { status: "notified" }));
    await assertFails(deleteDoc(doc(c, path)));
  }
  // カウンター・レート制限はクライアントから見えない
  await assertFails(getDoc(doc(ctx("adminA"), `facilities/${F}/orderCounters/20261024`)));
  await assertFails(setDoc(doc(ctx("adminA"), `facilities/${F}/orderCounters/20261024`), { count: 0 }));
});
