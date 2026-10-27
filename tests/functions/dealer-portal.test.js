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
/** 続きを最後までたどる(同じ検索)。各ページの newSinceSearch もまとめる */
async function rest(uid, first, over = {}, call = (c) => list(uid, { ...over, cursor: c })) {
  const items = [], flags = [];
  let r = first;
  while (r.nextCursor) { r = await call(r.nextCursor); items.push(...r.items); flags.push(r.newSinceSearch); }
  return { items, complete: r.complete, newSinceSearch: flags.some(Boolean) };
}

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
  let rid2 = (await list("x1")).items[0].receiptId;
  // 発注先の削除・施設の停止・会社の停止
  await db.doc("facilities/fA/facilityDealers/dA1").delete();
  await rejects(api("x1", "get", { receiptId: rid2 }), "not-found");
  // 同じ ID・同じ内容で作り直しても、別の発注先として扱う(施設が取消・再許可するまで公開しない。F-01)
  await db.doc("facilities/fA/facilityDealers/dA1").set({ facilityId: "fA", name: "エックス商事A窓口", orderEmails: ["order-x@x.example.jp"] });
  await rejects(api("x1", "get", { receiptId: rid2 }), "not-found");
  await revoke("adminA", "fA", "dA1");
  await grant("adminA", "fA", "dA1");
  await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);
  rid2 = (await list("x1")).items[0].receiptId;
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

// ======================= Codex レビュー(docs/reviews/dealer-portal-audit.md)の再現 =======================

test("F-01: 閲覧を許可中の発注先は、識別項目(名称・宛名・発注用メール・連携ID)の変更と削除を Rules で拒否する(先に取消)。並び順・使用報告用メールは変更できる。指紋の不一致(サーバー側の書き換え)でも公開を止める", async () => {
  await grant("adminA", "fA", "dA1");
  await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);
  const rid1 = (await list("x1")).items[0].receiptId;
  const { updateDoc, deleteDoc: del, setDoc: put, serverTimestamp } = await import("firebase/firestore");
  const adminDb = env.authenticatedContext("adminA", { email: "adminA@example.jp", email_verified: true }).firestore();
  const ref = doc(adminDb, "facilities/fA/facilityDealers/dA1");
  const by = () => ({ updatedBy: "adminA", updatedAt: serverTimestamp() });
  // 許可中: 名称・宛名・発注用メール・連携IDの変更、削除、(削除後の)作り直しは拒否
  for (const patch of [{ name: "ワイ医療(切替)" }, { orderEmails: ["order-y@y.example.jp"] }, { mailName: "ワイ医療 御中" }, { dealerId: "global-y" }]) {
    await assertFails(updateDoc(ref, { ...patch, ...by() }));
  }
  await assertFails(del(ref));
  // 並び順・使用報告用メールは変更できる(公開も続く)
  await updateDoc(ref, { sortOrder: 2000, usageReportEmails: ["usage@x.example.jp"], ...by() });
  assert.equal((await list("x1")).items.length, 1);
  assert.equal((await statusOf("adminA", "fA")).find(d => d.localDealerId === "dA1").link.grant.stale, false);
  // 許可していない発注先(dA2 は案のみ)は従来どおり変更できる
  await updateDoc(doc(adminDb, "facilities/fA/facilityDealers/dA2"), { name: "ワイ医療2", ...by() });
  // サーバー側の書き換え(Rules を通らない)で別の会社に変わった場合も、指紋の不一致で公開を止め、施設の画面に「停止中」
  await db.doc("facilities/fA/facilityDealers/dA1").update({ name: "ワイ医療(切替)", orderEmails: ["order-y@y.example.jp"] });
  assert.deepEqual((await list("x1")).items, []);
  await rejects(api("x1", "get", { receiptId: rid1 }), "not-found");
  assert.equal((await statusOf("adminA", "fA")).find(d => d.localDealerId === "dA1").link.grant.stale, true);
  // 取消の後は変更できる → 運営者が会社Yへ関連付け → 再許可で会社Yへ(許可の後の注文だけ)
  await revoke("adminA", "fA", "dA1");
  await updateDoc(ref, { name: "ワイ医療(切替2)", ...by() });
  await op("proposeLink", { facilityId: "fA", localDealerId: "dA1", companyId: C.Y });
  await grant("adminA", "fA", "dA1");
  const r3 = await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);
  assert.deepEqual((await list("y1")).items.map(i => i.orderNumber), [r3.orderNumber]);
  assert.deepEqual((await list("x1")).items, []);
});

test("F-01(再レビュー): 発注先を他社へ変えて元に戻しても、途中の他社宛て注文は旧会社に索引・返却しない(遅延イベント・再試行・作り直し・詳細とも)。戻した後の新しい注文と、変更前の注文は従来どおり", async () => {
  await grant("adminA", "fA", "dA1");
  const before = await placeOrder("fA", "ordA", [line({ dealerId: "dA1", power: "+19.0D" })]);
  const xDealer = (await db.doc("facilities/fA/facilityDealers/dA1").get()).data();
  const receiptsX = async () => (await db.collection(`dealerCompanies/${C.X}/receipts`).get()).docs.map(d => d.get("sourceOrderId"));
  // Rules を通らない経路(サーバー側の書き換え)で X → Y に変え、Y 宛ての注文を作る(注文メールの宛先も Y)。索引は遅れる
  await db.doc("facilities/fA/facilityDealers/dA1").update({ name: "ワイ医療(切替)", orderEmails: ["order-y@y.example.jp"] });
  const yPeriod = await orders.createOrder({ auth: auth("ordA"), data: { facilityId: "fA", requestId: crypto.randomUUID(), notes: "", lines: [line({ dealerId: "dA1", power: "+23.5D" })] } });
  const yOrder = (await db.doc(`facilities/fA/orders/${yPeriod.orderId}`).get()).data();
  assert.equal(yOrder.lines[0].dealer.name, "ワイ医療(切替)", "注文には注文時点の発注先が保存される");
  // メールだけ Y に変えた注文(名称は X のまま)
  await db.doc("facilities/fA/facilityDealers/dA1").update({ name: xDealer.name });
  const mailOnly = await orders.createOrder({ auth: auth("ordA"), data: { facilityId: "fA", requestId: crypto.randomUUID(), notes: "", lines: [line({ dealerId: "dA1", power: "+24.5D" })] } });
  // X の元の値へ戻す(取消・再許可はしない)。指紋は元に戻る
  await db.doc("facilities/fA/facilityDealers/dA1").update({ name: xDealer.name, orderEmails: xDealer.orderEmails });
  assert.equal((await statusOf("adminA", "fA")).find(d => d.localDealerId === "dA1").link.grant.stale, false);
  // 遅れて届いた索引イベント・再試行・運営者の作り直し: 途中の注文は X に索引しない
  for (const o of [yPeriod, mailOnly]) {
    assert.equal((await portal.indexOrderEvent({ facilityId: "fA", orderId: o.orderId, eventTime: new Date().toISOString() })).created, 0);
    assert.equal((await portal.indexOrder("fA", o.orderId)).created, 0);
  }
  await op("reindex", { facilityId: "fA", from: today(), to: today(), apply: true });
  assert.deepEqual(await receiptsX(), [before.orderId]);
  // 索引が何らかの理由で作られていても、詳細は返さない(注文時点の発注先を照合)
  const g = (await db.doc("facilities/fA/dealerPortalLinks/dA1").get()).get("currentGrantId");
  const forged = receiptIdOf(g, "fA", yPeriod.orderId);
  await db.doc(`dealerCompanies/${C.X}/receipts/${forged}`).set({ grantId: g, facilityId: "fA", localDealerId: "dA1", sourceOrderId: yPeriod.orderId, orderNumber: yOrder.orderNumber, orderedAt: yOrder.createdAt, lineCount: 1, totalQuantity: 1 });
  await rejects(api("x1", "get", { receiptId: forged }), "not-found");
  await db.doc(`dealerCompanies/${C.X}/receipts/${forged}`).delete();
  const json = JSON.stringify((await list("x1")).items);
  assert.ok(!json.includes(yPeriod.orderNumber) && !json.includes(mailOnly.orderNumber));
  // 変更前の注文と、戻した後の新しい注文は従来どおり X に公開
  const after = await placeOrder("fA", "ordA", [line({ dealerId: "dA1", power: "+25.5D" })]);
  assert.deepEqual((await list("x1")).items.map(i => i.orderNumber).sort(), [before.orderNumber, after.orderNumber].sort());
  const d = await api("x1", "get", { receiptId: (await list("x1")).items.find(i => i.orderNumber === after.orderNumber).receiptId });
  assert.equal(d.lines[0].power, "+25.5D");
  // 他社の明細は混ざらない・注文とメールは従来どおり(Y 期間の注文のメールは Y の宛先のまま)
  assert.deepEqual((await db.doc(`facilities/fA/orders/${yPeriod.orderId}/mails/d_dA1`).get()).get("to"), ["order-y@y.example.jp"]);
});

test("F-02: 無効化の前に発行した参加待ちでは復帰できない(無効化で取り消す・発行時刻も照合)。無効化の後に発行した案内なら復帰できる", async () => {
  await grant("adminA", "fA", "dA1");
  await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);
  // 有効な担当者に再招待(参加待ち) → 承諾の前に運営者が無効化
  const { invitationId } = await op("inviteStaff", { companyId: C.X, email: "x2@corp.example.jp", name: "担当x2", role: "reader" });
  await op("updateStaff", { companyId: C.X, uid: "x2", status: "disabled" });
  assert.equal((await db.doc(`dealerCompanyInvitations/${invitationId}`).get()).get("status"), "cancelled", "無効化と同時に参加待ちを取り消す");
  await rejects(api("x2", "respond", { invitationId, accept: true }), "failed-precondition");
  await rejects(api("x2", "context"), "permission-denied");
  assert.equal((await db.doc(`dealerCompanies/${C.X}/staff/x2`).get()).get("status"), "disabled");
  // 取消が漏れた(参加待ちのまま残った)場合も、無効化より前に発行された案内は使えない
  await db.doc(`dealerCompanyInvitations/${invitationId}`).update({ status: "pending" });
  await rejects(api("x2", "respond", { invitationId, accept: true }), "failed-precondition");
  await rejects(list("x2"), "permission-denied");
  // 同じメールの別アカウント(別UID)も、取り消された案内では参加できない
  await rejects(api(auth("x2b", { email: "x2@corp.example.jp" }), "respond", { invitationId, accept: true }), "failed-precondition");
  // 無効化の後に運営者が発行した案内で復帰
  const again = await op("inviteStaff", { companyId: C.X, email: "x2@corp.example.jp", name: "担当x2", role: "reader" });
  await api("x2", "respond", { invitationId: again.invitationId, accept: true });
  assert.equal((await list("x2")).items.length, 1);
  // 辞退は無効化の後でもできる(状態は変わらない)
  await op("updateStaff", { companyId: C.X, uid: "x2", status: "disabled" });
  const third = await op("inviteStaff", { companyId: C.X, email: "x2@corp.example.jp", name: "担当x2", role: "reader" });
  await api("x2", "respond", { invitationId: third.invitationId, accept: false });
  await rejects(api("x2", "context"), "permission-denied");
});

test("F-03: 索引の一時的な失敗は例外で知らせて再試行に任せる(2社のうち1社が失敗しても、もう1社は作る。再実行で重複しない)。古いイベントは打ち切り。作り直しは続きから最後まで", async () => {
  await grant("adminA", "fA", "dA1");
  await grant("adminA", "fA", "dA2");
  const r = await orders.createOrder({ auth: auth("ordA"), data: { facilityId: "fA", requestId: crypto.randomUUID(), notes: "", lines: [line({ dealerId: "dA1" }), line({ dealerId: "dA2", power: "+21.0D" })] } });
  // 2回目のトランザクション(2社目)だけ一度失敗させる
  let calls = 0;
  const flaky = new Proxy(db, { get(t, p) {
    if (p === "runTransaction") return (fn, o) => (++calls === 2 ? Promise.reject(Object.assign(new Error("UNAVAILABLE"), { code: 14 })) : t.runTransaction(fn, o));
    const v = t[p]; return typeof v === "function" ? v.bind(t) : v;
  } });
  const flakyPortal = createDealerPortalService({ db: flaky, FieldValue, Timestamp, FieldPath, isEnabled: () => true });
  await assert.rejects(flakyPortal.indexOrder("fA", r.orderId), (e) => e.partial && e.partial.created === 1 && e.partial.failed === 1);
  const count = async (cid) => (await db.collection(`dealerCompanies/${cid}/receipts`).get()).size;
  assert.deepEqual([await count(C.X) + await count(C.Y)], [1], "1社目は作成済み");
  // 再試行(同じイベントの再実行)で残りを作る。作成済みは重複しない
  await portal.indexOrderEvent({ facilityId: "fA", orderId: r.orderId, eventTime: new Date().toISOString() });
  await portal.indexOrderEvent({ facilityId: "fA", orderId: r.orderId, eventTime: new Date().toISOString() });
  assert.deepEqual([await count(C.X), await count(C.Y)], [1, 1]);
  // 24時間を過ぎたイベントは打ち切る(運営者が作り直す)
  const old = await orders.createOrder({ auth: auth("ordA"), data: { facilityId: "fA", requestId: crypto.randomUUID(), notes: "", lines: [line({ dealerId: "dA1" })] } });
  assert.deepEqual(await portal.indexOrderEvent({ facilityId: "fA", orderId: old.orderId, eventTime: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }), { expired: true });
  assert.equal(await count(C.X), 1);
  // 作り直し: 上限ごとに続きの位置を返し、最後まで到達する(同じ日に上限を超える注文があっても)
  for (let i = 0; i < 2; i++) await orders.createOrder({ auth: auth("ordA"), data: { facilityId: "fA", requestId: crypto.randomUUID(), notes: "", lines: [line({ dealerId: "dA1" })] } });
  let cursor, created = 0, pages = 0, seen = 0;
  do {
    const res = await op("reindex", { facilityId: "fA", from: today(), to: today(), apply: true, limit: 2, ...(cursor ? { cursor } : {}) });
    created += res.created; seen += res.orders; pages++;
    cursor = res.nextCursor;
  } while (cursor && pages < 10);
  assert.equal(seen, 4, "4件の注文をすべて走査");
  assert.equal(created, 3, "索引のない3件(古いイベントの1件と新しい2件)を作成");
  assert.equal(await count(C.X), 4);
  await rejects(op("reindex", { facilityId: "fB", from: today(), to: today(), cursor: "eyJrIjoieCJ9" }), "invalid-argument");
  assert.equal((await db.collection(`facilities/fA/orders/${r.orderId}/mails`).get()).size, 2, "メールは増えない");
});

test("F-04: 続きのページも検索時点(最初のページを読んだ時点)の内容で読む。検索中に索引が追加されても、ページの間で欠けたり重なったりせず、追加は newSinceSearch で知らせる(再検索で表示)", async () => {
  await grant("adminA", "fA", "dA1");
  const make = () => orders.createOrder({ auth: auth("ordA"), data: { facilityId: "fA", requestId: crypto.randomUUID(), notes: "", lines: [line({ dealerId: "dA1" })] } });
  const old = await make(); await portal.indexOrder("fA", old.orderId);
  const front = await make(); await portal.indexOrder("fA", front.orderId);
  const late = await make();   // 一番新しいが、索引が遅れている
  const p1 = await list("x1", { limit: 1 });
  assert.deepEqual(p1.items.map(i => i.orderNumber), [front.orderNumber]);
  assert.equal(p1.newSinceSearch, false);
  await portal.indexOrder("fA", late.orderId);   // 読み終えた範囲(先頭側)に反映
  const p2 = await rest("x1", p1, { limit: 1 });
  assert.deepEqual([p2.items.map(i => i.orderNumber), p2.complete, p2.newSinceSearch], [[old.orderNumber], true, true], "検索時点の内容は欠けずに最後まで。追加は知らせる");
  assert.deepEqual((await list("x1")).items.map(i => i.orderNumber), [late.orderNumber, front.orderNumber, old.orderNumber], "再検索で表示");
  // 未読の範囲(カーソルより古い側)に遅れて入った索引も、同じ検索の続きには混ぜない(重複・順序の乱れなし)。知らせて再検索で表示
  await db.recursiveDelete(db.collection(`dealerCompanies/${C.X}/receipts`));
  await portal.indexOrder("fA", late.orderId);
  await portal.indexOrder("fA", front.orderId);
  const q1 = await list("x1", { limit: 1 });
  await portal.indexOrder("fA", old.orderId);
  const q2 = await rest("x1", q1, { limit: 1 });
  assert.deepEqual([...q1.items, ...q2.items].map(i => i.orderNumber), [late.orderNumber, front.orderNumber]);
  assert.deepEqual([q2.complete, q2.newSinceSearch], [true, true]);
  // 別の施設(検索条件の外)に追加された索引では知らせない
  await grant("adminB", "fB", "dB1");
  const s1 = await list("x1", { limit: 1, facilityFilter: { mode: "selected", facilityIds: ["fA"] } });
  await placeOrder("fB", "ordB", [line({ dealerId: "dB1" })]);
  const s2 = await list("x1", { limit: 1, cursor: s1.nextCursor, facilityFilter: { mode: "selected", facilityIds: ["fA"] } });
  assert.equal(s2.newSinceSearch, false);
  assert.equal(s2.items.length, 1);
});

test("F-04(再レビュー): 次ページの処理中(読み取りの直前)に索引が追加されても、そのページは検索時点の内容で、欠けたまま全件と判断しない(追加は知らせる)", async () => {
  await grant("adminA", "fA", "dA1");
  const make = () => orders.createOrder({ auth: auth("ordA"), data: { facilityId: "fA", requestId: crypto.randomUUID(), notes: "", lines: [line({ dealerId: "dA1" })] } });
  const o1 = await make(); await portal.indexOrder("fA", o1.orderId);
  const o2 = await make(); await portal.indexOrder("fA", o2.orderId);
  const o3 = await make();   // 最新。索引が遅れている
  const p1 = await list("x1", { limit: 1 });
  assert.deepEqual(p1.items.map(i => i.orderNumber), [o2.orderNumber]);
  // 次ページの要求の途中(一覧の読み取りの直前)で、o3 の索引を実際の indexOrder で作る
  let injected = false;
  const racy = new Proxy(db, { get(t, p) {
    if (p === "runTransaction") return async (fn, o) => {
      if (!injected && o && o.readOnly) { injected = true; await portal.indexOrder("fA", o3.orderId); }
      return t.runTransaction(fn, o);
    };
    const v = t[p]; return typeof v === "function" ? v.bind(t) : v;
  } });
  const racyPortal = createDealerPortalService({ db: racy, FieldValue, Timestamp, FieldPath, isEnabled: () => true });
  const p2 = await rest("x1", p1, {}, (c) => racyPortal.portal({ auth: staffAuth("x1"), data: { action: "list", ...range(), limit: 1, cursor: c } }));
  assert.ok(injected);
  assert.deepEqual(p2.items.map(i => i.orderNumber), [o1.orderNumber]);
  assert.deepEqual([p2.complete, p2.newSinceSearch], [true, true], "欠けたまま「新しい注文なし」としない");
  assert.deepEqual((await list("x1")).items.map(i => i.orderNumber), [o3.orderNumber, o2.orderNumber, o1.orderNumber]);
});

test("F-06: 所属の変更後(旧会社で無効化)も、会社を指定せずに有効な会社を開ける。有効な所属が2社なら選択、すべて無効なら拒否。会社の候補は有効な所属だけ", async () => {
  await grant("adminA", "fA", "dA1");
  await grant("adminA", "fA", "dA2");
  // x1 が会社Xを退職し、会社Yへ参加
  await op("updateStaff", { companyId: C.X, uid: "x1", status: "disabled" });
  const { invitationId } = await op("inviteStaff", { companyId: C.Y, email: "x1@corp.example.jp", name: "担当x1", role: "reader" });
  await api("x1", "respond", { invitationId, accept: true });
  assert.deepEqual((await db.doc("dealerStaffIndex/x1").get()).get("companyIds").sort(), [C.X, C.Y].sort(), "所属の一覧には旧会社も残る");
  const ctx = await api("x1", "context");
  assert.equal(ctx.company.id, C.Y, "有効な1社を開く");
  assert.deepEqual((await api("x1", "companies")).companies, [{ companyId: C.Y, name: "ワイ医療" }]);
  await rejects(api("x1", "context", { companyId: C.X }), "permission-denied");
  // 有効な所属が2社: 会社の指定が必要。候補は2社
  const inv2 = await op("inviteStaff", { companyId: C.X, email: "y1@corp.example.jp", name: "担当y1", role: "reader" });
  await api("y1", "respond", { invitationId: inv2.invitationId, accept: true });
  await rejects(api("y1", "context"), "failed-precondition");
  assert.deepEqual((await api("y1", "companies")).companies.map(c => c.name), ["エックス商事", "ワイ医療"]);
  assert.equal((await api("y1", "context", { companyId: C.X })).company.id, C.X);
  // 会社Xを停止すると、y1 は有効な1社(Y)になる
  await op("updateCompany", { companyId: C.X, status: "suspended" });
  assert.equal((await api("y1", "context")).company.id, C.Y);
  // すべて無効
  await op("updateStaff", { companyId: C.Y, uid: "x1", status: "disabled" });
  await rejects(api("x1", "context"), "permission-denied");
  assert.deepEqual((await api("x1", "companies")).companies, []);
  assert.deepEqual((await api("stranger", "companies")).companies, []);
  await rejects(api("x1", "companies", { companyId: C.Y }), "invalid-argument");
});

test("F-06(再レビュー): 無効な旧所属が20件以上残っていても、有効な会社を会社の指定なしで開ける(有効かどうかを確かめてから選ぶ)", async () => {
  const uid = "hopper";
  const old = [];
  for (let i = 0; i < 21; i++) {
    const cid = `dco-old-${String(i).padStart(2, "0")}`;
    old.push(cid);
    await db.doc(`dealerCompanies/${cid}`).set({ name: `旧会社${i}`, status: i % 2 ? "suspended" : "active", accessMode: "companyWide", policyVersion: 1 });
    await db.doc(`dealerCompanies/${cid}/staff/${uid}`).set({ uid, approvedEmail: `${uid}@corp.example.jp`, role: "reader", status: "disabled" });
  }
  // 有効な会社(X)は一覧の22件目
  await db.doc(`dealerCompanies/${C.X}/staff/${uid}`).set({ uid, approvedEmail: `${uid}@corp.example.jp`, role: "reader", status: "active", facilityAssignments: [] });
  await db.doc(`dealerStaffIndex/${uid}`).set({ companyIds: [...old, C.X] });
  assert.deepEqual((await api(uid, "companies")).companies, [{ companyId: C.X, name: "エックス商事" }]);
  assert.equal((await api(uid, "context")).company.id, C.X);
  // 招待の承諾では、新しい所属を一覧の先頭に加える
  const { invitationId } = await op("inviteStaff", { companyId: C.Y, email: `${uid}@corp.example.jp`, name: "", role: "reader" });
  await api(uid, "respond", { invitationId, accept: true });
  assert.equal((await db.doc(`dealerStaffIndex/${uid}`).get()).get("companyIds")[0], C.Y);
  assert.deepEqual((await api(uid, "companies")).companies.map(c => c.companyId).sort(), [C.X, C.Y].sort());
  await rejects(api(uid, "context"), "failed-precondition");   // 有効2社: 会社の選択が必要
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
