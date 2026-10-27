// ディーラー専用画面(第1段階)のテスト(Firestoreエミュレータ。実プロジェクトには接続しない)。  npm run test:functions
// 2社(X・Y)・2施設(A・B)。施設Aの発注先 dA1 → 会社X、dA2 → 会社Y、施設Bの発注先 dB1 → 会社X。
// 会社所属 × 施設の明示的な許可 × 自社宛ての明細 の3条件、取消・無効化・メール変更、担当施設と権限の分離、既存の注文・メールへの影響を確認する。
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp, FieldPath } from "firebase-admin/firestore";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, collection, collectionGroup, query, where } from "firebase/firestore";
import { createOrderService } from "../../functions/src/orders.js";
import { createDealerPortalService, buildDealerOrderView, ownLinesOf, jstDateOf, initialFacilitySelection, receiptIdOf } from "../../functions/src/dealer-portal.js";

const PROJECT = "demo-iol-functions";
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185").split(":");
const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");
let env, db, portal, orders, testOrders, clock, enabled;

before(async () => {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  db = getFirestore();
  clock = { t: null };
  enabled = { v: true };
  portal = createDealerPortalService({ db, FieldValue, Timestamp, FieldPath, isEnabled: () => enabled.v, now: () => clock.t ?? Date.now() });
  orders = createOrderService({ db, FieldValue, isEnabled: () => true });
  testOrders = createOrderService({ db, FieldValue, isEnabled: () => true, getPolicy: () => ({ unrestricted: false, facilityIds: ["fA"], uids: ["ordA"], testMode: true }) });
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(rulesPath, "utf8"), host, port: Number(port) } });
});
after(async () => { await env.clearFirestore(); await env.cleanup(); });

const auth = (uid, over = {}) => ({ uid, token: { email: `${uid}@example.jp`, email_verified: true, name: uid, ...over } });
const ops = () => auth("ops1", { platformAdmin: true });
const staffAuth = (uid) => auth(uid, { email: `${uid}@corp.example.jp` });
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);
const op = (action, data = {}) => portal.operator({ auth: ops(), data: { action, ...data } });
const api = (uid, action, data = {}) => portal.portal({ auth: typeof uid === "string" ? staffAuth(uid) : uid, data: { action, ...data } });
const fac = (uid, action, data = {}) => portal.facility({ auth: auth(uid), data: { action, ...data } });
const today = () => jstDateOf(Date.now());
const surgery = () => jstDateOf(Date.now() + 10 * 24 * 3600 * 1000);
const range = (over = {}) => ({ from: jstDateOf(Date.now() - 2 * 24 * 3600 * 1000), to: today(), facilityFilter: { mode: "all" }, ...over });
let C = {};   // 会社ID

beforeEach(async () => {
  await env.clearFirestore();
  clock.t = null; enabled.v = true;
  for (const [f, name] of [["fA", "A眼科"], ["fB", "B眼科"]]) {
    await db.doc(`facilities/${f}`).set({ name, status: "active" });
    for (const id of ["jj-dib00v"]) await db.doc(`facilities/${f}/adoptedIols/${id}`).set({ facilityId: f, catalogIolId: id, enabled: true });
    await db.doc(`facilities/${f}/orderers/o1`).set({ facilityId: f, name: `${name}の山田`, email: "doctor@hospital.example.jp" });
  }
  const members = [["fA", "adminA", "admin"], ["fA", "subA", "subadmin"], ["fA", "ordA", "orderer"], ["fA", "proxyA", "proxy"], ["fB", "adminB", "admin"], ["fB", "ordB", "orderer"]];
  for (const [f, uid, role] of members) await db.doc(`facilities/${f}/members/${uid}`).set({ uid, role });
  await db.doc("facilities/fA/facilityDealers/dA1").set({ facilityId: "fA", name: "エックス商事A窓口", orderEmails: ["order-x@x.example.jp"] });
  await db.doc("facilities/fA/facilityDealers/dA2").set({ facilityId: "fA", name: "ワイ医療", orderEmails: ["order-y@y.example.jp"] });
  await db.doc("facilities/fB/facilityDealers/dB1").set({ facilityId: "fB", name: "エックス商事B窓口", orderEmails: ["order-xb@x.example.jp"] });
  C.X = (await op("createCompany", { name: "エックス商事", requestId: crypto.randomUUID() })).companyId;
  C.Y = (await op("createCompany", { name: "ワイ医療", requestId: crypto.randomUUID() })).companyId;
  for (const [cid, uid, role] of [[C.X, "x1", "companyAdmin"], [C.X, "x2", "reader"], [C.Y, "y1", "reader"]]) {
    const { invitationId } = await op("inviteStaff", { companyId: cid, email: `${uid}@corp.example.jp`, name: `担当${uid}`, role });
    await api(uid, "respond", { invitationId, accept: true });
  }
  await op("proposeLink", { facilityId: "fA", localDealerId: "dA1", companyId: C.X });
  await op("proposeLink", { facilityId: "fA", localDealerId: "dA2", companyId: C.Y });
  await op("proposeLink", { facilityId: "fB", localDealerId: "dB1", companyId: C.X });
});

const statusOf = async (uid, facilityId) => (await fac(uid, "status", { facilityId })).dealers;
const revOf = async (facilityId, lid) => ((await db.doc(`facilities/${facilityId}/dealerPortalLinks/${lid}`).get()).get("revision"));
const grant = async (uid, facilityId, lid) => fac(uid, "grant", { facilityId, localDealerId: lid, revision: await revOf(facilityId, lid) });
const revoke = async (uid, facilityId, lid) => fac(uid, "revoke", { facilityId, localDealerId: lid, revision: await revOf(facilityId, lid) });
const line = (over = {}) => ({ modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: surgery(), doctorId: "o1", ...over });
/** 注文して、トリガーの代わりに索引を作る */
async function placeOrder(facilityId, uid, lines, { notes = "共通の備考(患者の情報を含むかもしれない)", service = orders } = {}) {
  const r = await service.createOrder({ auth: auth(uid), data: { facilityId, requestId: crypto.randomUUID(), notes, lines } });
  await portal.indexOrder(facilityId, r.orderId);
  return r;
}
const list = (uid, over = {}) => api(uid, "list", { ...range(), ...over });

test("権限: 会社・支店・担当者・関連付けの管理は運営者だけ。招待は本人のメールでしか承諾できず、未招待・期限切れ・取り消しは参加できない", async () => {
  for (const a of [auth("adminA"), staffAuth("x1"), auth("z", { platformAdmin: "true" }), null]) {
    await assert.rejects(portal.operator({ auth: a, data: { action: "overview" } }), (e) => ["permission-denied", "unauthenticated"].includes(e.code));
  }
  await rejects(op("createCompany", { name: "x", requestId: "short" }), "invalid-argument");
  await rejects(op("inviteStaff", { companyId: C.X, email: "bad", name: "", role: "reader" }), "invalid-argument");
  await rejects(op("inviteStaff", { companyId: C.X, email: "a@b.jp", name: "", role: "owner" }), "invalid-argument");
  await rejects(op("inviteStaff", { companyId: C.X, email: "a@b.jp", name: "", role: "reader", extra: 1 }), "invalid-argument");
  const { invitationId } = await op("inviteStaff", { companyId: C.Y, email: "new@corp.example.jp", name: "新人", role: "reader" });
  // 他人(x1)は承諾できない。未招待の人には会社名も出さない
  await rejects(api("x1", "respond", { invitationId, accept: true }), "failed-precondition");
  assert.deepEqual((await api("x1", "invitations")).invitations, []);
  assert.deepEqual((await api("new", "invitations")).invitations, [{ invitationId, companyName: "ワイ医療", role: "reader" }]);
  await rejects(api("stranger", "context"), "permission-denied");
  // 期限切れ
  clock.t = Date.now() + 31 * 24 * 3600 * 1000;
  assert.deepEqual((await api("new", "invitations")).invitations, []);
  await rejects(api("new", "respond", { invitationId, accept: true }), "failed-precondition");
  clock.t = null;
  // 取り消し後は承諾できない
  await op("cancelInvitation", { invitationId });
  await rejects(api("new", "respond", { invitationId, accept: true }), "failed-precondition");
  // 支店: 同じ会社の有効な支店だけ。他社の支店は指定できない
  const { branchId } = await op("upsertBranch", { companyId: C.Y, name: "東京支店" });
  await rejects(op("updateStaff", { companyId: C.X, uid: "x1", branchId }), "invalid-argument");
  await op("updateStaff", { companyId: C.Y, uid: "y1", branchId });
  assert.equal((await api("y1", "context")).me.branch.name, "東京支店");
  await op("updateStaff", { companyId: C.Y, uid: "y1", branchId: null });
  assert.equal((await api("y1", "context")).me.branch, null, "支店なしでも使える");
});

test("所属: ディーラーの担当者を施設の members に加えない(施設の所属の検索に現れない)", async () => {
  const cg = await db.collectionGroup("members").get();
  assert.deepEqual(cg.docs.map(d => d.id).sort(), ["adminA", "adminB", "ordA", "ordB", "proxyA", "subA"]);
  const staff = await db.collectionGroup("staff").get();
  assert.deepEqual(staff.docs.map(d => d.id).sort(), ["x1", "x2", "y1"]);
});

test("施設の許可・取消: 管理者・副管理者の両方が自施設でできる。注文者・代行入力者・他施設の管理者・ディーラー・運営者の案なしは不可。操作者と役割を記録", async () => {
  for (const uid of ["ordA", "proxyA", "adminB", "x1", "stranger"]) {
    await rejects(fac(uid, "status", { facilityId: "fA" }), "permission-denied");
    await rejects(grant(uid, "fA", "dA1"), "permission-denied");
  }
  let st = await statusOf("subA", "fA");
  assert.deepEqual(st.map(d => [d.localDealerId, d.link.companyName, d.link.status, d.link.grant]), [["dA1", "エックス商事", "proposed", null], ["dA2", "ワイ医療", "proposed", null]]);
  await rejects(fac("subA", "grant", { facilityId: "fA", localDealerId: "dA1", revision: 99 }), "failed-precondition");
  await grant("subA", "fA", "dA1");   // 副管理者が許可
  await grant("adminA", "fA", "dA2"); // 管理者が許可
  await rejects(grant("adminA", "fA", "dA1"), "failed-precondition");   // 二重の許可
  st = await statusOf("adminA", "fA");
  assert.deepEqual(st.map(d => [d.localDealerId, d.link.status, d.link.grant.grantedByRole]), [["dA1", "active", "subadmin"], ["dA2", "active", "admin"]]);
  await revoke("subA", "fA", "dA2");
  const logs = (await db.collection("dealerPortalAuditLogs").get()).docs.map(d => d.data()).filter(l => l.action.startsWith("grant."));
  assert.deepEqual(logs.map(l => [l.action, l.actorUid, l.actorRole, l.facilityId]).sort(), [["grant.activate", "adminA", "admin", "fA"], ["grant.activate", "subA", "subadmin", "fA"], ["grant.revoke", "subA", "subadmin", "fA"]].sort());
  // 運営者の関連付け案がない発注先は許可できない
  await db.doc("facilities/fB/facilityDealers/dB9").set({ facilityId: "fB", name: "未登録" });
  await rejects(fac("adminB", "grant", { facilityId: "fB", localDealerId: "dB9", revision: 0 }), "not-found");
  // 閲覧を許可中の関連付けは運営者も会社を変えられない(取消→新しい許可が必要)
  await rejects(op("proposeLink", { facilityId: "fA", localDealerId: "dA1", companyId: C.Y }), "failed-precondition");
});

test("情報の分離: 1つの注文に2社の明細が混在しても、各社には自社宛ての明細だけ。他社の明細・名称・宛先・通知、共通備考、入力者、担当医のメールは返さない", async () => {
  await grant("adminA", "fA", "dA1");
  await grant("adminA", "fA", "dA2");
  const r = await placeOrder("fA", "ordA", [line({ dealerId: "dA2", power: "+18.0D" }), line({ dealerId: "dA1", power: "+21.0D", quantity: 2 }), line({ dealerId: "dA2", power: "+19.0D" }), line({ dealerId: "dA1", power: "+22.0D" })]);
  const xl = await list("x1");
  assert.equal(xl.items.length, 1);
  assert.deepEqual([xl.items[0].orderNumber, xl.items[0].facilityName, xl.items[0].lineCount, xl.items[0].totalQuantity], [r.orderNumber, "A眼科", 2, 3], "件数・枚数は自社分から数え直す");
  const xd = await api("x1", "get", { receiptId: xl.items[0].receiptId });
  assert.deepEqual(xd.lines.map(l => [l.no, l.power, l.quantity]), [[1, "+21.0D", 2], [2, "+22.0D", 1]], "明細番号は自社分で 1 から");
  assert.equal(xd.lines[0].doctorName, "A眼科の山田");
  assert.equal(xd.mail.status, "pending");
  const yd = await api("y1", "get", { receiptId: (await list("y1")).items[0].receiptId });
  assert.deepEqual(yd.lines.map(l => l.power), ["+18.0D", "+19.0D"]);
  for (const [view, other] of [[xd, ["ワイ医療", "order-y@y.example.jp", "+18.0D", "+19.0D", "dA2"]], [yd, ["エックス商事", "order-x@x.example.jp", "+21.0D", "+22.0D", "dA1"]]]) {
    const json = JSON.stringify(view);
    for (const s of [...other, "共通の備考", "ordA", "doctor@hospital.example.jp", "requestId", "contentHash", "notifications", "createdBy", "copy", "注文控え"]) {
      assert.ok(!json.includes(s), `返さない: ${s}`);
    }
  }
  // 他社の受信 ID は「対象を表示できません」(存在を区別しない)
  await rejects(api("y1", "get", { receiptId: xl.items[0].receiptId }), "not-found");
  await rejects(api("y1", "get", { receiptId: "rcp-unknown" }), "not-found");
  // 既存の注文・メール: 注文は1件、発注先ごとのメール(送信待ち)は従来どおり2通
  const mails = await db.collection(`facilities/fA/orders/${r.orderId}/mails`).get();
  assert.deepEqual(mails.docs.map(d => d.id).sort(), ["d_dA1", "d_dA2"]);
  const o = (await db.doc(`facilities/fA/orders/${r.orderId}`).get()).data();
  assert.equal(o.notes, "共通の備考(患者の情報を含むかもしれない)", "注文の記録は変えない");
});

test("許可の後の新規注文だけ。テスト注文・発注先の矛盾・未許可の施設は公開しない。会社の範囲を超えた施設の指定は拒否", async () => {
  const before = await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);   // 許可の前
  await grant("adminA", "fA", "dA1");
  const afterOrder = await placeOrder("fA", "ordA", [line({ dealerId: "dA1", power: "+23.0D" })]);
  await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })], { service: testOrders });   // テスト注文
  await placeOrder("fB", "ordB", [line({ dealerId: "dB1" })]);   // 施設Bは未許可
  const items = (await list("x1")).items;
  assert.deepEqual(items.map(i => i.orderNumber), [afterOrder.orderNumber]);
  // 許可の前の注文は、索引を作り直しても対象外
  await portal.indexOrder("fA", before.orderId);
  assert.equal((await list("x1")).items.length, 1);
  // 未許可の施設(B)を検索条件に入れると、選び直しを求める
  await rejects(list("x1", { facilityFilter: { mode: "selected", facilityIds: ["fA", "fB"] } }), "invalid-argument");
  await rejects(list("x1", { facilityFilter: { mode: "all", facilityIds: ["fA"] } }), "invalid-argument");
  await rejects(list("x1", { facilityFilter: undefined }), "invalid-argument");
  // 発注先の矛盾(dealerId と dealer.id が違う)は推測で公開しない
  const o = { lines: [{ dealerId: "dA1", dealer: { id: "dA2" }, item: {} }] };
  assert.equal(ownLinesOf(o, "dA1"), null);
  assert.equal(buildDealerOrderView(o, "dA1"), null);
});

test("取消: 取消の後は一覧・詳細・次ページを拒否。再許可は新しい許可で、以前の注文は自動で戻らない。施設・会社の停止、発注先の削除も拒否", async () => {
  await grant("adminA", "fA", "dA1");
  await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);
  await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);
  const first = await list("x1", { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const rid = first.items[0].receiptId;
  await revoke("subA", "fA", "dA1");
  await rejects(api("x1", "get", { receiptId: rid }), "not-found");
  await rejects(list("x1", { limit: 1, cursor: first.nextCursor, facilityFilter: { mode: "selected", facilityIds: ["fA"] } }), "invalid-argument");
  assert.deepEqual((await list("x1")).items, []);
  assert.deepEqual((await api("x1", "context")).facilities, []);
  // 再許可: 以前の受信は戻らない。再許可の後の注文だけ
  await grant("adminA", "fA", "dA1");
  assert.deepEqual((await list("x1")).items, []);
  await rejects(api("x1", "get", { receiptId: rid }), "not-found");
  const again = await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);
  assert.deepEqual((await list("x1")).items.map(i => i.orderNumber), [again.orderNumber]);
  const rid2 = (await list("x1")).items[0].receiptId;
  // 発注先の削除・施設の停止・会社の停止
  await db.doc("facilities/fA/facilityDealers/dA1").delete();
  await rejects(api("x1", "get", { receiptId: rid2 }), "not-found");
  await db.doc("facilities/fA/facilityDealers/dA1").set({ facilityId: "fA", name: "エックス商事A窓口" });
  await api("x1", "get", { receiptId: rid2 });
  await db.doc("facilities/fA").update({ status: "suspended" });
  await rejects(api("x1", "get", { receiptId: rid2 }), "not-found");
  await db.doc("facilities/fA").update({ status: "active" });
  await op("updateCompany", { companyId: C.X, status: "suspended" });
  await rejects(api("x1", "get", { receiptId: rid2 }), "permission-denied");
  await rejects(api("x1", "context"), "permission-denied");
});

test("退職・所属変更: 担当者の無効化、ログインのメールの変更、他社への所属なしは拒否。再招待で復帰", async () => {
  await grant("adminA", "fA", "dA1");
  await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);
  const rid = (await list("x2")).items[0].receiptId;
  await op("updateStaff", { companyId: C.X, uid: "x2", status: "disabled" });
  await rejects(list("x2"), "permission-denied");
  await rejects(api("x2", "get", { receiptId: rid }), "permission-denied");
  // 他社の会社IDを指定しても読めない
  await rejects(api("y1", "list", { companyId: C.X, ...range() }), "permission-denied");
  // メールアドレスが変わった(承認済みのメールと一致しない)
  await rejects(api(auth("x1", { email: "x1@other.example.jp" }), "context"), "permission-denied");
  await rejects(api(auth("x1", { email: "x1@corp.example.jp", email_verified: false }), "context"), "permission-denied");
  // 再招待・承諾で復帰
  const { invitationId } = await op("inviteStaff", { companyId: C.X, email: "x2@corp.example.jp", name: "担当x2", role: "reader" });
  await api("x2", "respond", { invitationId, accept: true });
  assert.equal((await list("x2")).items.length, 1);
});

test("担当施設: 担当者ごとに複数。初期選択は担当施設、未設定は許可済みの全施設。担当施設は表示用で、閲覧権限は増減しない", async () => {
  await grant("adminA", "fA", "dA1");
  await grant("adminB", "fB", "dB1");
  const a = await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);
  const b = await placeOrder("fB", "ordB", [line({ dealerId: "dB1" })]);
  // 未設定: 許可済みの全施設を初期選択
  let ctx = await api("x1", "context");
  assert.equal(ctx.selection, "all-unassigned");
  assert.deepEqual(ctx.selectedFacilityIds.sort(), ["fA", "fB"]);
  assert.deepEqual(ctx.facilities.map(f => [f.id, f.name]), [["fA", "A眼科"], ["fB", "B眼科"]]);
  // x1 は B を担当、x2 は A と B を担当
  await api("x1", "setAssignments", { facilityIds: ["fB"] });
  await op("updateStaff", { companyId: C.X, uid: "x2", facilityIds: ["fA", "fB"] });   // 運営者の代行
  ctx = await api("x1", "context");
  assert.deepEqual([ctx.selection, ctx.selectedFacilityIds, ctx.facilities.map(f => [f.id, f.assigned])], ["assigned", ["fB"], [["fB", true], ["fA", false]]], "担当施設を先頭に");
  assert.deepEqual((await api("x2", "context")).selectedFacilityIds.sort(), ["fA", "fB"]);
  // 担当外の許可済み施設(A)も、選択すれば閲覧・詳細を見られる
  const onlyA = await list("x1", { facilityFilter: { mode: "selected", facilityIds: ["fA"] } });
  assert.deepEqual(onlyA.items.map(i => i.orderNumber), [a.orderNumber]);
  await api("x1", "get", { receiptId: onlyA.items[0].receiptId });
  // 複数選択(OR)・全選択・空の選択(0件)
  assert.equal((await list("x1", { facilityFilter: { mode: "selected", facilityIds: ["fA", "fB"] } })).items.length, 2);
  assert.equal((await list("x1", { facilityFilter: { mode: "all" } })).items.length, 2);
  assert.deepEqual((await list("x1", { facilityFilter: { mode: "selected", facilityIds: [] } })).items, []);
  // 許可されていない施設は担当施設にできない(担当施設で権限は増えない)
  await revoke("adminB", "fB", "dB1");
  await rejects(api("x1", "setAssignments", { facilityIds: ["fB"] }), "invalid-argument");
  ctx = await api("x1", "context");
  assert.deepEqual([ctx.selection, ctx.selectedFacilityIds, ctx.assignedFacilityIds], ["all-unassigned", ["fA"], []], "取消済みの施設は有効な担当施設から外す");
  assert.ok(!JSON.stringify(ctx).includes("B眼科"));
  assert.deepEqual((await list("x1")).items.map(i => i.orderNumber), [a.orderNumber], "担当施設(B)が保存されていても、取消後は読めない");
  assert.ok(b);
  // 純粋関数
  assert.deepEqual(initialFacilitySelection([], ["fA"]).selection, "none");
});

test("検索: 注文番号の完全一致・日本時間の期間・最大366日・複数施設をまたぐページング(全件を重複なく)・カーソルの改ざん・期限切れ", async () => {
  await grant("adminA", "fA", "dA1");
  await grant("adminB", "fB", "dB1");
  const made = [];
  for (let i = 0; i < 3; i++) {
    made.push(await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]));
    made.push(await placeOrder("fB", "ordB", [line({ dealerId: "dB1" })]));
  }
  // 同じ注文番号(別施設): 両方を施設名つきで返す
  const num = made[0].orderNumber;
  const same = await list("x1", { orderNumber: ` ${num} ` });
  assert.ok(same.items.length >= 1 && same.items.every(i => i.orderNumber === num));
  assert.deepEqual((await list("x1", { orderNumber: num.slice(0, -1) })).items, [], "部分一致はしない");
  // 期間: 未来だけの期間は0件、366日超・逆順・不正な日付は拒否
  const future = jstDateOf(Date.now() + 5 * 24 * 3600 * 1000);
  assert.deepEqual((await list("x1", { from: future, to: future })).items, []);
  await rejects(list("x1", { from: "2025-01-01", to: today() }), "invalid-argument");
  await rejects(list("x1", { from: today(), to: jstDateOf(Date.now() - 2 * 24 * 3600 * 1000) }), "invalid-argument");
  await rejects(list("x1", { from: "2026-02-30", to: today() }), "invalid-argument");
  // ページング: 2件ずつで6件を重複なく、新しい順
  const seen = [];
  let cursor;
  for (let p = 0; p < 5; p++) {
    const r = await list("x1", { limit: 2, ...(cursor ? { cursor } : {}) });
    seen.push(...r.items);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  assert.equal(seen.length, 6);
  assert.equal(new Set(seen.map(i => i.receiptId)).size, 6);
  const times = seen.map(i => Date.parse(i.orderedAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  // カーソル: 別の条件・別の人・改ざん・期限切れは拒否
  const r1 = await list("x1", { limit: 1 });
  await rejects(list("x1", { limit: 1, cursor: r1.nextCursor, orderNumber: num }), "invalid-argument");
  await rejects(list("x2", { limit: 1, cursor: r1.nextCursor }), "invalid-argument");
  await rejects(list("x1", { limit: 1, cursor: r1.nextCursor.slice(0, -2) + "xx" }), "invalid-argument");
  clock.t = Date.now() + 2 * 3600 * 1000;
  await rejects(list("x1", { limit: 1, cursor: r1.nextCursor }), "invalid-argument");
  clock.t = null;
  await rejects(list("x1", { limit: 101 }), "invalid-argument");
  await rejects(list("x1", { unknown: 1 }), "invalid-argument");
});

test("索引: 同じ注文の重複処理は1件。作り直しは既定で確認だけ、実行しても重複しない。メールは作らない。機能スイッチで停止できる", async () => {
  await grant("adminA", "fA", "dA1");
  const r = await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);
  await portal.indexOrder("fA", r.orderId);
  await portal.indexOrder("fA", r.orderId);
  assert.equal((await db.collection(`dealerCompanies/${C.X}/receipts`).get()).size, 1);
  // 索引が消えた場合の作り直し
  const g = (await db.doc("facilities/fA/dealerPortalLinks/dA1").get()).get("currentGrantId");
  await db.doc(`dealerCompanies/${C.X}/receipts/${receiptIdOf(g, "fA", r.orderId)}`).delete();
  const dry = await op("reindex", { facilityId: "fA", from: today(), to: today() });
  assert.deepEqual([dry.dryRun, dry.orders], [true, 1]);
  assert.equal((await db.collection(`dealerCompanies/${C.X}/receipts`).get()).size, 0);
  const done = await op("reindex", { facilityId: "fA", from: today(), to: today(), apply: true });
  assert.deepEqual([done.dryRun, done.created], [false, 1]);
  assert.equal((await db.collection(`facilities/fA/orders/${r.orderId}/mails`).get()).size, 1, "メールは増えない");
  // 機能スイッチ
  enabled.v = false;
  await rejects(list("x1"), "failed-precondition");
  await rejects(fac("adminA", "status", { facilityId: "fA" }), "failed-precondition");
  const r2 = await orders.createOrder({ auth: auth("ordA"), data: { facilityId: "fA", requestId: crypto.randomUUID(), notes: "", lines: [line({ dealerId: "dA1" })] } });
  assert.equal((await portal.indexOrder("fA", r2.orderId)).disabled, true);
  assert.ok((await db.doc(`facilities/fA/orders/${r2.orderId}`).get()).exists, "ポータルを止めても注文は受け付ける");
  enabled.v = true;
});

test("Rules: 新しい領域(会社・担当者・索引・許可・関連付け・参加待ち)は、担当者・施設の管理者・運営者もクライアントから直接読めない。担当者は施設の注文を読めない", async () => {
  await grant("adminA", "fA", "dA1");
  const r = await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);
  const g = (await db.doc("facilities/fA/dealerPortalLinks/dA1").get()).get("currentGrantId");
  const rid = receiptIdOf(g, "fA", r.orderId);
  const clients = [
    env.authenticatedContext("x1", { email: "x1@corp.example.jp", email_verified: true }).firestore(),
    env.authenticatedContext("adminA", { email: "adminA@example.jp", email_verified: true }).firestore(),
    env.authenticatedContext("ops1", { email: "ops1@example.jp", email_verified: true, platformAdmin: true }).firestore(),
    env.unauthenticatedContext().firestore()
  ];
  for (const c of clients) {
    for (const p of [`dealerCompanies/${C.X}`, `dealerCompanies/${C.X}/staff/x1`, `dealerCompanies/${C.X}/receipts/${rid}`, `dealerPortalGrants/${g}`,
      "facilities/fA/dealerPortalLinks/dA1", "dealerStaffIndex/x1", `dealerCompanyInvitations/x`]) {
      await assertFails(getDoc(doc(c, p)));
    }
    await assertFails(getDocs(collection(c, `dealerCompanies/${C.X}/receipts`)));
    await assertFails(getDocs(query(collectionGroup(c, "staff"), where("uid", "==", "x1"))));
  }
  const x1 = clients[0];
  await assertFails(getDoc(doc(x1, `facilities/fA/orders/${r.orderId}`)));
  await assertFails(getDocs(collection(x1, "facilities/fA/orders")));
  await assertFails(getDoc(doc(x1, `facilities/fA/orders/${r.orderId}/mails/d_dA1`)));
  await assertFails(getDoc(doc(x1, "facilities/fA/facilityDealers/dA1")));
});
