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
import { createOrderService, ORDER_STATUS, ORDER_LIMITS, deriveOrderId, jstDate, orderLinesOf } from "../../functions/src/orders.js";

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
  await seedMember("fB", "ordB", "orderer");
  for (const f of [F, "fB"]) {
    for (const id of ["jj-dib00v", "jj-diwxxx-toric", "nidek-nsp-2", "alcon-mn60ma-yellow"]) {
      await db.doc(`facilities/${f}/adoptedIols/${id}`).set({ facilityId: f, catalogIolId: id, enabled: true });
    }
    await db.doc(`facilities/${f}/orderers/o1`).set({ facilityId: f, name: "山田", email: "y@orderer.jp" });
    await db.doc(`facilities/${f}/orderers/o2`).set({ facilityId: f, name: "佐藤" });
    await db.doc(`facilities/${f}/orderers/o3`).set({ facilityId: f, name: "旧形式", active: false }); // 移行前の旧形式(active フィールドは無視される)
  }
  await db.doc(`facilities/${F}/adoptedIols/alcon-cna0t0`).set({ facilityId: F, catalogIolId: "alcon-cna0t0", enabled: false }); // 採用解除
});

const seedMember = (fid, uid, role = "orderer") => db.doc(`facilities/${fid}/members/${uid}`).set({ uid, role });
const user = (uid, over = {}) => ({ uid, token: { email: `${uid}@login.jp`, email_verified: true, name: `ログイン-${uid}`, ...over } });
const rid = () => crypto.randomUUID();
const body = (over = {}) => ({
  facilityId: F, requestId: rid(), modelId: "jj-dib00v", power: "+20.0D", quantity: 1,
  surgeryDate: "2026-11-10", doctorId: "o1", notes: "右眼", ...over
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
  assert.equal(o.lines.length, 1);
  assert.deepEqual(o.lines[0].item, {
    modelId: "jj-dib00v", manufacturer: "J&J", model: "DIB00V", displayName: "J&J / DIB00V",
    isToric: false, isMultifocal: false, toricModel: "", power: "+20.0D", quantity: 1
  });
  assert.equal(o.lines[0].status, "accepted");
  assert.equal(o.lines[0].dealerId, null);
  assert.equal(o.lines[0].surgeryDate, "2026-11-10");
  assert.deepEqual(o.lines[0].doctor, { id: "o1", name: "山田", email: "y@orderer.jp" }); // 担当医: マスターのスナップショット
  assert.equal("orderer" in o, false, "no order-level orderer in the new format");
  assert.deepEqual(o.doctorIds, ["o1"]);
  assert.deepEqual(o.createdBy, { uid: "ordA", email: "orda@login.jp", displayName: "ログイン-ordA" }); // 担当医とは別に、実際の発注者を認証情報から記録
  assert.equal(o.notes, "右眼");
  assert.ok(o.createdAt && o.acceptedAt && o.requestId === d.requestId && o.schemaVersion === 3);
});

test("担当医のメールは任意: 未登録でも受け付けられ、null で保存される。管理者も注文できる(担当医とは別に、発注者として記録される)", async () => {
  const r = await order(user("adminA"), body({ doctorId: "o2" }));
  const o = (await db.doc(`facilities/${F}/orders/${r.orderId}`).get()).data();
  assert.equal(o.lines[0].doctor.email, null);
  assert.equal(o.createdBy.uid, "adminA");
});

test("マスターを後で変更しても、過去の注文の内容は変わらない(スナップショット)", async () => {
  const r = await order(user("ordA"), body());
  await db.doc(`facilities/${F}/orderers/o1`).update({ name: "改名", email: "new@x.jp" });
  await db.doc(`facilities/${F}`).update({ name: "改名眼科" });
  const o = (await db.doc(`facilities/${F}/orders/${r.orderId}`).get()).data();
  assert.equal(o.lines[0].doctor.name, "山田");
  assert.equal(o.lines[0].doctor.email, "y@orderer.jp");
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
  for (const extra of [{ orderNumber: "X" }, { status: "notified" }, { createdBy: "evil" }, { price: 1 }, { displayName: "偽" }, { orderer: "偽" }, { orderedBy: "偽" }, { actorUid: "x" }, { proxy: true }, { proxyOrder: true }, { ordererName: "偽" }, { doctorName: "偽" }, { email: "a@b.jp" }, { role: "admin" }]) {
    await rejects(order(user("ordA"), body(extra)), "invalid-argument");
  }
  assert.equal((await orders()).length, 0);
});

// ================= 認証・権限 =================
test("未認証・メール未確認・所属なし・他施設・所属を削除されたユーザーは拒否され、何も保存されない", async () => {
  await rejects(order(null, body()), "unauthenticated");
  await rejects(order(user("ordA", { email_verified: false }), body()), "permission-denied");
  await rejects(order(user("stranger"), body()), "permission-denied");
  await rejects(order(user("ordB"), body()), "permission-denied");          // 他施設の所属者が自施設以外へ
  await rejects(order(user("ordA"), body({ facilityId: "fB" })), "permission-denied"); // 自施設の所属者が他施設へ
  await rejects(order(user("offA"), body()), "permission-denied");          // 所属を削除されたユーザー(所属ドキュメントがない)
  await db.doc(`facilities/${F}`).update({ status: "suspended" });
  await rejects(order(user("ordA"), body()), "permission-denied");          // 停止中の施設
  assert.equal((await orders()).length + (await orders("fB")).length, 0);
});

test("所属を削除された後の再送でも、既存の注文を返さず拒否する(権限は毎回再確認)", async () => {
  const d = body();
  await order(user("ordA"), d);
  await db.doc(`facilities/${F}/members/ordA`).delete(); // 所属の削除
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
  assert.equal(o.lines[0].item.toricModel, "DIW225");
  assert.equal(o.lines[0].item.isToric, true);
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

test("担当医: 施設のマスターにいる人のみ。存在しない・他施設の担当医は拒否される。旧形式の active は判定に使わない", async () => {
  await rejects(order(user("ordA"), body({ doctorId: "nobody" })), "invalid-argument");
  // 旧形式(active=false)のドキュメントでも、新形式(active なし)と同じように注文できる(移行期間中の混在)
  const legacy = await order(user("ordA"), body({ doctorId: "o3" }));
  assert.equal((await db.doc(`facilities/${F}/orders/${legacy.orderId}`).get()).get("lines")[0].doctor.name, "旧形式");
  const fresh = await order(user("ordA"), body({ doctorId: "o2" }));
  assert.equal((await db.doc(`facilities/${F}/orders/${fresh.orderId}`).get()).get("lines")[0].doctor.name, "佐藤");
  await db.collection(`facilities/${F}/orders`).get().then(s => Promise.all(s.docs.map(d => d.ref.delete())));
  await db.doc("facilities/fB/orderers/onlyB").set({ facilityId: "fB", name: "他施設の人" });
  await rejects(order(user("ordA"), body({ doctorId: "onlyB" })), "invalid-argument");
  assert.equal((await orders()).length, 0);
});

// ================= 複数明細(まとめ発注) =================
const line = (over = {}) => ({ modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: "2026-11-10", doctorId: "o1", ...over });
const multi = (lines, over = {}) => ({ facilityId: F, requestId: rid(), notes: "まとめ発注", lines, ...over });

test("複数明細: 異なるモデル・度数・枚数・手術日をまとめて1つの注文として保存し、明細ごとにスナップショットとディーラー情報を持つ", async () => {
  await db.doc(`facilities/${F}/adoptedIols/nidek-nsp-2`).update({ dealerId: "dealer-1" });
  await db.doc(`facilities/${F}/facilityDealers/dealer-1`).set({ facilityId: F, name: "テスト商会", orderEmails: ["o@example.jp"] });
  const lines = [
    line(),
    line({ modelId: "jj-diwxxx-toric", toricModel: "DIW300", power: "+18.5D", quantity: 2, surgeryDate: "2026-11-12" }),
    line({ modelId: "nidek-nsp-2", power: "+5.5D", surgeryDate: "2026-11-20" })
  ];
  const r = await order(user("ordA"), multi(lines));
  assert.equal(r.lineCount, 3);
  assert.equal(r.totalQuantity, 4);
  const o = (await db.doc(`facilities/${F}/orders/${r.orderId}`).get()).data();
  assert.equal(o.schemaVersion, 3);
  assert.equal(o.lineCount, 3);
  assert.equal(o.totalQuantity, 4);
  assert.equal(o.firstSurgeryDate, "2026-11-10");
  assert.equal(o.lastSurgeryDate, "2026-11-20");
  assert.deepEqual(o.lines.map(l => l.lineNo), [1, 2, 3]);
  assert.deepEqual(o.lines.map(l => l.status), ["accepted", "accepted", "accepted"]);
  assert.deepEqual(o.lines.map(l => l.surgeryDate), ["2026-11-10", "2026-11-12", "2026-11-20"]);
  assert.deepEqual(o.lines[1].item, {
    modelId: "jj-diwxxx-toric", manufacturer: "J&J", model: "DIWxxx (トーリック)", displayName: "J&J / DIWxxx (トーリック)",
    isToric: true, isMultifocal: false, toricModel: "DIW300", power: "+18.5D", quantity: 2
  });
  assert.deepEqual(o.lines.map(l => l.dealerId), [null, null, "dealer-1"]); // 将来のディーラー振り分け用
  assert.deepEqual(o.lines.map(l => l.dealer), [null, null, { id: "dealer-1", name: "テスト商会" }]); // その時点のディーラー名のスナップショット
  assert.deepEqual(o.lines.map(l => l.doctor.name), ["山田", "山田", "山田"]);
  assert.equal("item" in o, false);
});

test("複数明細: 1つでも不正な明細があれば、注文全体を拒否し、何も保存せず注文番号も消費しない。エラーには明細番号が付く", async () => {
  const bads = [
    [line({ power: "+20.2D" }), /明細2/],
    [line({ modelId: "hoya-xy1" }), /明細2.*採用されていない/],
    [line({ modelId: "jj-diwxxx-toric" }), /明細2/],                  // トーリック型番なし
    [line({ modelId: "jj-diwxxx-toric", toricModel: "XXX" }), /明細2/],
    [line({ toricModel: "DIW150" }), /明細2/],                          // 非トーリックに型番
    [line({ quantity: 3 }), /明細2/],
    [line({ surgeryDate: "2026-10-01" }), /明細2/],
    [line({ surgeryDate: "2026-02-30" }), /明細2/],
    [{ ...line(), extra: 1 }, /明細2/],
    [null, /明細2/]
  ];
  for (const [bad, re] of bads) {
    await assert.rejects(order(user("ordA"), multi([line(), bad])), (e) => e.code === "invalid-argument" && re.test(e.message), JSON.stringify(bad));
  }
  assert.equal((await orders()).length, 0);
  assert.equal((await order(user("ordA"), multi([line()]))).orderNumber, "IOL-20261024-0001");
});

test("複数明細: 明細数・合計枚数の上限、空、重複明細、トップレベルとの混在は拒否される", async () => {
  await rejects(order(user("ordA"), multi([])), "invalid-argument");
  await rejects(order(user("ordA"), { ...multi([line()]), lines: "x" }), "invalid-argument");
  const many = Array.from({ length: ORDER_LIMITS.maxLines + 1 }, (_, i) => line({ surgeryDate: `2026-12-${String((i % 28) + 1).padStart(2, "0")}`, power: `+${10 + i * 0.5}D`.replace(/\.0D$/, ".0D") }));
  await rejects(order(user("ordA"), multi(many)), "invalid-argument");
  // 合計枚数(2枚×21明細)の上限
  const heavy = Array.from({ length: 21 }, (_, i) => line({ quantity: 2, power: `+${(6 + i * 0.5).toFixed(1)}D` }));
  await assert.rejects(order(user("ordA"), multi(heavy)), (e) => e.code === "invalid-argument");
  const twenty = Array.from({ length: 20 }, (_, i) => line({ quantity: 2, power: `+${(6 + i * 0.5).toFixed(1)}D` }));
  await order(user("ordA"), multi(twenty)); // 20明細・40枚は可
  await rejects(order(user("ordA"), multi([line(), line()])), "invalid-argument"); // 同じレンズ・度数・手術日の重複
  await order(user("ordA"), multi([line(), line({ surgeryDate: "2026-11-11" })])); // 手術日が違えば別明細
  await rejects(order(user("ordA"), { ...multi([line()]), modelId: "jj-dib00v" }), "invalid-argument"); // 混在
});

test("複数明細: 同じ requestId の再送は同じ注文番号。明細の変更・順序変更・追加は拒否される。並列でも1件", async () => {
  const d = multi([line(), line({ modelId: "nidek-nsp-2", power: "+5.5D" })]);
  const a = await order(user("ordA"), d);
  const b = await order(user("ordA"), JSON.parse(JSON.stringify(d)));
  assert.equal(b.replayed, true);
  assert.equal(b.orderNumber, a.orderNumber);
  assert.equal(b.lineCount, 2);
  assert.equal(b.totalQuantity, 2);
  for (const changed of [
    { ...d, lines: [d.lines[0]] },
    { ...d, lines: [d.lines[1], d.lines[0]] },
    { ...d, lines: [d.lines[0], { ...d.lines[1], quantity: 2 }] },
    { ...d, lines: [...d.lines, line({ surgeryDate: "2026-11-30" })] }
  ]) await rejects(order(user("ordA"), changed), "already-exists");
  assert.equal((await orders()).length, 1);

  const p = multi([line(), line({ surgeryDate: "2026-11-15" })]);
  const rs = await Promise.all(Array.from({ length: 12 }, () => order(user("ordA"), p)));
  assert.equal(new Set(rs.map(r => r.orderNumber)).size, 1);
  assert.equal(rs.filter(r => !r.replayed).length, 1);
  assert.equal((await orders()).length, 2);
});

test("互換性: 従来の単一IOL形式と、明細1件の形式は同じ内容として扱われ(再送しても二重登録にならない)、保存は明細の形式に統一される", async () => {
  const legacy = body();
  const a = await order(user("ordA"), legacy);
  const asLines = { facilityId: F, requestId: legacy.requestId, notes: legacy.notes,
    lines: [{ modelId: legacy.modelId, power: legacy.power, quantity: legacy.quantity, surgeryDate: legacy.surgeryDate, doctorId: legacy.doctorId }] };
  const b = await order(user("ordA"), asLines);
  assert.equal(b.replayed, true);
  assert.equal(b.orderNumber, a.orderNumber);
  const o = (await db.doc(`facilities/${F}/orders/${a.orderId}`).get()).data();
  assert.equal(o.lines.length, 1);
  assert.equal(orderLinesOf(o)[0].item.modelId, "jj-dib00v");
});

test("互換性: 保存済みの旧形式(schemaVersion 1: item / surgeryDate)の注文も、明細の配列として読める", () => {
  const old = { status: "accepted", item: { modelId: "jj-dib00v", power: "+20.0D", quantity: 1 }, surgeryDate: "2026-11-10" };
  const l = orderLinesOf(old);
  assert.equal(l.length, 1);
  assert.equal(l[0].lineNo, 1);
  assert.equal(l[0].surgeryDate, "2026-11-10");
  assert.equal(l[0].dealerId, null);
  assert.deepEqual(orderLinesOf({ lines: [{ lineNo: 1 }, { lineNo: 2 }] }).length, 2);
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
  for (const change of [{ power: "+21.0D" }, { quantity: 2 }, { surgeryDate: "2026-11-11" }, { doctorId: "o2" }, { modelId: "nidek-nsp-2" }, { notes: "左眼" }]) {
    await rejects(order(user("ordA"), { ...d, ...change }), "already-exists");
  }
  const o = (await db.doc(`facilities/${F}/orders/${a.orderId}`).get()).data();
  assert.equal(o.lines[0].item.power, "+20.0D");
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

// ================= 開発用受付の制限(サーバー側で強制) =================
const restrictedService = (policy) => createOrderService({ db, FieldValue, now: () => clock.t, isEnabled: () => enabled.v, getPolicy: () => policy });
const POLICY = { facilityIds: [F], uids: ["adminA"] };

test("開発用受付: 許可した施設・ユーザーだけが注文でき、保存された注文には testOrder: true が付く(複数明細・再送も可)", async () => {
  const s = restrictedService(POLICY);
  const d = multi([line(), line({ modelId: "nidek-nsp-2", power: "+5.5D", surgeryDate: "2026-11-20" })]);
  const a = await s.createOrder({ auth: user("adminA"), data: d });
  assert.equal(a.lineCount, 2);
  const o = (await db.doc(`facilities/${F}/orders/${a.orderId}`).get()).data();
  assert.equal(o.testOrder, true);
  assert.equal(o.status, "accepted");
  const b = await s.createOrder({ auth: user("adminA"), data: d });
  assert.equal(b.replayed, true);
  assert.equal(b.orderNumber, a.orderNumber);
  assert.equal((await orders()).length, 1);
});

test("開発用受付: 制限のない通常の受付で保存した注文は testOrder: false", async () => {
  const r = await order(user("ordA"), body());
  assert.equal((await db.doc(`facilities/${F}/orders/${r.orderId}`).get()).get("testOrder"), false);
});

test("開発用受付: 許可外の施設・ユーザーは、有効な所属者でも拒否され、何も書き込まれない(利用枠・レート制限も含む)", async () => {
  const s = restrictedService(POLICY);
  await rejects(s.createOrder({ auth: user("ordA"), data: body() }), "permission-denied");                      // 許可外のユーザー(自施設の注文者)
  await rejects(s.createOrder({ auth: user("adminA"), data: body({ facilityId: "fB" }) }), "permission-denied"); // 許可外の施設
  await rejects(s.createOrder({ auth: user("ordB"), data: body({ facilityId: "fB" }) }), "permission-denied");   // どちらも許可外
  await seedMember("fB", "adminA", "admin");
  await rejects(s.createOrder({ auth: user("adminA"), data: body({ facilityId: "fB" }) }), "permission-denied"); // 許可ユーザーが別施設の所属者でも不可
  assert.equal((await orders()).length + (await orders("fB")).length, 0);
  assert.equal((await db.collection("rateLimits").get()).size, 0);
  assert.equal((await db.collection(`facilities/${F}/orderCounters`).get()).size, 0);
});

test("開発用受付: 許可ユーザーでも、その施設の所属者でなければ拒否される(許可リストは所属確認の代わりにならない)", async () => {
  const s = restrictedService({ facilityIds: [F], uids: ["adminA", "outsider"] });
  await rejects(s.createOrder({ auth: user("outsider"), data: body() }), "permission-denied");
  await db.doc(`facilities/${F}/members/adminA`).delete(); // 所属の削除
  await rejects(s.createOrder({ auth: user("adminA"), data: body() }), "permission-denied");
  assert.equal((await orders()).length, 0);
});

test("開発用受付: 許可リストが空・未設定なら全員拒否(安全側)。メール未確認・未認証・キルスイッチも優先される", async () => {
  for (const policy of [{ facilityIds: [], uids: [] }, { facilityIds: [F], uids: [] }, { facilityIds: [], uids: ["adminA"] }, {}, null, { unrestricted: "true" }]) {
    await rejects(restrictedService(policy).createOrder({ auth: user("adminA"), data: body() }), "permission-denied");
  }
  const s = restrictedService(POLICY);
  await rejects(s.createOrder({ auth: null, data: body() }), "unauthenticated");
  await rejects(s.createOrder({ auth: user("adminA", { email_verified: false }), data: body() }), "permission-denied");
  enabled.v = false;
  await rejects(s.createOrder({ auth: user("adminA"), data: body() }), "failed-precondition");
  assert.equal((await orders()).length, 0);
});

test("開発用受付: 拒否メッセージは許可リストの内容(施設ID・UID)を明かさない", async () => {
  const s = restrictedService(POLICY);
  await assert.rejects(s.createOrder({ auth: user("ordA"), data: body() }), (e) => !e.message.includes(F) && !e.message.includes("adminA"));
});

// ================= ディーラー(有効/無効はなく、削除する) =================
test("ディーラー: 削除されたディーラーは発注先にならない。過去の注文に保存したディーラー情報は、削除・改名後も変わらない", async () => {
  await db.doc(`facilities/${F}/adoptedIols/nidek-nsp-2`).update({ dealerId: "dealer-1" });
  await db.doc(`facilities/${F}/facilityDealers/dealer-1`).set({ facilityId: F, name: "テスト商会" });
  const before = await order(user("ordA"), multi([line({ modelId: "nidek-nsp-2", power: "+5.5D" })]));
  const doc1 = () => db.doc(`facilities/${F}/orders/${before.orderId}`).get();
  assert.deepEqual((await doc1()).get("lines")[0].dealer, { id: "dealer-1", name: "テスト商会" });

  await db.doc(`facilities/${F}/facilityDealers/dealer-1`).update({ name: "改名商会" });
  await db.doc(`facilities/${F}/facilityDealers/dealer-1`).delete();                 // ディーラーを削除
  assert.deepEqual((await doc1()).get("lines")[0].dealer, { id: "dealer-1", name: "テスト商会" }, "past order keeps the snapshot");

  const after = await order(user("ordA"), multi([line({ modelId: "nidek-nsp-2", power: "+5.5D" })]));
  const l = (await db.doc(`facilities/${F}/orders/${after.orderId}`).get()).get("lines")[0];
  assert.equal(l.dealerId, null, "deleted dealer is no longer an order destination");
  assert.equal(l.dealer, null);
});

test("ディーラー: 実メール送信の可否(dispatch)。発注先未設定・発注用メール未登録は送信不可。使用報告用メールは発注先に使わない。メールアドレスは注文に保存しない", async () => {
  await db.doc(`facilities/${F}/adoptedIols/nidek-nsp-2`).update({ dealerId: "d-ok" });
  await db.doc(`facilities/${F}/adoptedIols/alcon-mn60ma-yellow`).update({ dealerId: "d-usage" });
  await db.doc(`facilities/${F}/facilityDealers/d-ok`).set({ facilityId: F, name: "OK商会", orderEmails: ["order@example.jp"], usageReportEmails: ["report@example.jp"] });
  await db.doc(`facilities/${F}/facilityDealers/d-usage`).set({ facilityId: F, name: "報告のみ商会", usageReportEmails: ["report@example.jp"] }); // 発注用メールなし
  const r = await order(user("ordA"), multi([
    line({ modelId: "nidek-nsp-2", power: "+5.5D" }),
    line({ modelId: "alcon-mn60ma-yellow", power: "-5.0D", surgeryDate: "2026-11-12" }),
    line({ modelId: "jj-dib00v", power: "+20.0D", surgeryDate: "2026-11-13" })   // 発注先未設定
  ]));
  const o = (await db.doc(`facilities/${F}/orders/${r.orderId}`).get()).data();
  assert.deepEqual(o.lines.map(l => l.dispatch), [
    { allowed: true, reason: null }, { allowed: false, reason: "no-order-email" }, { allowed: false, reason: "dealer-unset" }]);
  assert.equal(o.dispatchAllowed, false, "one blocked line blocks the order");
  assert.deepEqual(o.lines.map(l => l.dealer && l.dealer.name), ["OK商会", "報告のみ商会", null]);
  assert.ok(!JSON.stringify(o).includes("@example.jp"), "no dealer e-mail addresses stored in the order");
});

test("ディーラー: 他の施設のディーラーは発注先にならない(IDが同じでも、自施設に登録されたものだけ)", async () => {
  await db.doc(`facilities/${F}/adoptedIols/nidek-nsp-2`).update({ dealerId: "shared-id" });
  await db.doc("facilities/fB/facilityDealers/shared-id").set({ facilityId: "fB", name: "他施設のディーラー" });
  const r = await order(user("ordA"), multi([line({ modelId: "nidek-nsp-2", power: "+5.5D" })]));
  const l = (await db.doc(`facilities/${F}/orders/${r.orderId}`).get()).get("lines")[0];
  assert.deepEqual([l.dealerId, l.dealer], [null, null]);
});

test("ディーラー: 旧形式(active つき)のディーラーでも、有効/無効に関係なく登録されていれば発注先になる(判定に使わない)", async () => {
  await db.doc(`facilities/${F}/adoptedIols/nidek-nsp-2`).update({ dealerId: "legacy-d" });
  await db.doc(`facilities/${F}/facilityDealers/legacy-d`).set({ facilityId: F, name: "旧形式", active: false });
  const r = await order(user("ordA"), multi([line({ modelId: "nidek-nsp-2", power: "+5.5D" })]));
  assert.equal((await db.doc(`facilities/${F}/orders/${r.orderId}`).get()).get("lines")[0].dealer.name, "旧形式");
});

// ================= 担当医(明細ごと)・実際の発注者 =================
test("担当医が異なる複数レンズを、1回の注文で扱える。明細ごとに担当医のID・氏名をスナップショットし、重複判定は担当医も区別する", async () => {
  const d = multi([
    line({ doctorId: "o1" }),
    line({ doctorId: "o2" }),                                  // 同じレンズ・度数・手術日でも、担当医が違えば別の明細
    line({ modelId: "nidek-nsp-2", power: "+5.5D", doctorId: "o2", surgeryDate: "2026-11-20" })
  ]);
  const r = await order(user("ordA"), d);
  const o = (await db.doc(`facilities/${F}/orders/${r.orderId}`).get()).data();
  assert.deepEqual(o.lines.map(l => l.doctor), [
    { id: "o1", name: "山田", email: "y@orderer.jp" }, { id: "o2", name: "佐藤", email: null }, { id: "o2", name: "佐藤", email: null }
  ]);
  assert.deepEqual(o.doctorIds.sort(), ["o1", "o2"]);
  assert.deepEqual(o.createdBy.uid, "ordA", "one real orderer for the whole order");
  // 同じ担当医・同じレンズ・度数・手術日の重複は拒否
  await rejects(order(user("ordA"), multi([line({ doctorId: "o1" }), line({ doctorId: "o1" })])), "invalid-argument");
});

test("実際の発注者(createdBy)は、サーバーが認証情報から記録する。クライアントが申告する発注者・代理発注の項目は受け付けない", async () => {
  const r = await order(user("adminA", { name: "管理者 太郎" }), multi([line({ doctorId: "o2" })]));
  const o = (await db.doc(`facilities/${F}/orders/${r.orderId}`).get()).data();
  assert.deepEqual(o.createdBy, { uid: "adminA", email: "admina@login.jp", displayName: "管理者 太郎" });
  assert.equal(o.lines[0].doctor.name, "佐藤", "doctor and orderer are separate");
  for (const forged of [{ createdBy: { uid: "ordA" } }, { orderedBy: "x" }, { actorUid: "ordA" }, { proxy: true }, { proxyOrder: true }, { ordererName: "x" }, { doctorName: "x" }, { orderer: { name: "x" } }]) {
    await rejects(order(user("adminA"), multi([line()], forged)), "invalid-argument");
    await rejects(order(user("adminA"), multi([{ ...line(), ...forged }])), "invalid-argument");
  }
});

test("担当医の検証は明細ごと: 存在しない・他施設の担当医は、明細番号つきで注文全体を拒否し、何も保存しない。担当医の指定がない明細は拒否", async () => {
  await db.doc("facilities/fB/orderers/onlyB").set({ facilityId: "fB", name: "他施設の人" });
  for (const bad of ["nobody", "onlyB", "a/b"]) {
    await assert.rejects(order(user("ordA"), multi([line(), line({ doctorId: bad, power: "+21.0D" })])), (e) => e.code === "invalid-argument" && /明細2/.test(e.message), bad);
  }
  const noDoctor = line(); delete noDoctor.doctorId;
  await assert.rejects(order(user("ordA"), multi([noDoctor])), (e) => e.code === "invalid-argument" && /明細1.*担当医/.test(e.message));
  await rejects(order(user("ordA"), multi([line({ doctorId: null })])), "invalid-argument");
  await rejects(order(user("ordA"), multi([line({ doctorId: 5 })])), "invalid-argument");
  assert.equal((await orders()).length, 0);
});

test("冪等性: 同じ requestId で担当医が変わった再送は拒否される。同じ内容の再送は同じ注文番号", async () => {
  const d = multi([line({ doctorId: "o1" }), line({ doctorId: "o2", power: "+21.0D" })]);
  const a = await order(user("ordA"), d);
  assert.equal((await order(user("ordA"), JSON.parse(JSON.stringify(d)))).orderNumber, a.orderNumber);
  await rejects(order(user("ordA"), { ...d, lines: [d.lines[0], { ...d.lines[1], doctorId: "o1" }] }), "already-exists");
  assert.equal((await orders()).length, 1);
});

test("互換性(旧クライアント): トップレベルの ordererId は、担当医を指定していない全明細の担当医として扱われる", async () => {
  const noDoc = (o = {}) => { const l = line(o); delete l.doctorId; return l; };
  const r = await order(user("ordA"), multi([noDoc(), { ...noDoc({ power: "+21.0D" }), doctorId: "o2" }], { ordererId: "o1" }));
  const o = (await db.doc(`facilities/${F}/orders/${r.orderId}`).get()).data();
  assert.deepEqual(o.lines.map(l => l.doctor.id), ["o1", "o2"]);       // 明細の指定が優先
  assert.equal("orderer" in o, false);
  await rejects(order(user("ordA"), multi([noDoc()], { ordererId: "nobody" })), "invalid-argument");
});

test("互換性(読み込み): 旧形式の注文(注文全体の orderer)も、各明細の担当医として読める。新形式はそのまま。実際の発注者は createdBy", () => {
  const v2 = { schemaVersion: 2, orderer: { id: "o1", name: "山田", email: null }, createdBy: { uid: "u1" },
    lines: [{ lineNo: 1, item: { modelId: "jj-dib00v" } }, { lineNo: 2, item: { modelId: "x" } }] };
  assert.deepEqual(orderLinesOf(v2).map(l => l.doctor), [{ id: "o1", name: "山田", email: null }, { id: "o1", name: "山田", email: null }]);
  const v1 = { status: "accepted", item: { modelId: "jj-dib00v" }, surgeryDate: "2026-11-10", orderer: { id: "o9", name: "旧", email: null } };
  assert.equal(orderLinesOf(v1)[0].doctor.name, "旧");
  const v3 = { schemaVersion: 3, createdBy: { uid: "u1" }, lines: [{ lineNo: 1, doctor: { id: "o2", name: "佐藤", email: null } }, { lineNo: 2, doctor: { id: "o1", name: "山田", email: null } }] };
  assert.deepEqual(orderLinesOf(v3).map(l => l.doctor.name), ["佐藤", "山田"]);
  assert.deepEqual(orderLinesOf({ status: "x" }), []);
});
