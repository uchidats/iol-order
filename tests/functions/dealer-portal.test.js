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
import { doc, getDoc, getDocs, setDoc, collection, collectionGroup, query, where } from "firebase/firestore";
import { createOrderService } from "../../functions/src/orders.js";
import { createOrderCancelService } from "../../functions/src/order-cancel.js";
import { managerPolicyError } from "../../functions/src/dealer-portal.js";
import { parseTestAccess, TEST_MODE_MAX_MS } from "../../functions/src/dealer-portal.js";
import { createDealerPortalService, buildDealerOrderView, ownLinesOf, jstDateOf, initialFacilitySelection, receiptIdOf, staffIdOf, weekDatesOf, surgeryDatesOf } from "../../functions/src/dealer-portal.js";

const PROJECT = "demo-iol-functions";
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185").split(":");
const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");
let env, db, portal, orders, testOrders, clock, enabled;
const sentCodes = [], sendResult = { v: { ok: true } };
// 確認済みの端末(UID ごと)。メールリンクのログインで確認コードを確かめたときに返った値を持ち、以後の呼び出しに付ける(画面が端末に保存するのと同じ)
const devices = new Map();

before(async () => {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  db = getFirestore();
  clock = { t: null };
  enabled = { v: true };
  // 確認コード: 送ったもの(宛先・コード・会社名)を記録する偽の送信。sendResult で送信の失敗も試せる
  portal = createDealerPortalService({ db, FieldValue, Timestamp, FieldPath, isEnabled: () => enabled.v, now: () => clock.t ?? Date.now(),
    sendJoinCode: async (m) => { sentCodes.push(m); return sendResult.v; } });
  orders = createOrderService({ db, FieldValue, isEnabled: () => true });
  testOrders = createOrderService({ db, FieldValue, isEnabled: () => true, getPolicy: () => ({ unrestricted: false, facilityIds: ["fA"], uids: ["ordA"], testMode: true }) });
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(rulesPath, "utf8"), host, port: Number(port) } });
});
after(async () => { await env.clearFirestore(); await env.cleanup(); });

// 既定はメールのリンク(sign_in_provider: password)。Google などは over で指定する
const auth = (uid, over = {}) => ({ uid, token: { email: `${uid}@example.jp`, email_verified: true, name: uid, firebase: { sign_in_provider: "password" }, auth_time: Math.floor((clock.t ?? Date.now()) / 1000), ...over } });
const ops = () => auth("ops1", { platformAdmin: true });
const staffAuth = (uid) => auth(uid, { email: `${uid}@corp.example.jp` });
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);
const op = (action, data = {}) => portal.operator({ auth: ops(), data: { action, ...data } });
/** data に deviceToken を書けばその値(null なら付けない)。書かなければ、その UID の確認済みの端末を付ける */
async function api(uid, action, data = {}) {
  const a = typeof uid === "string" ? staffAuth(uid) : uid;
  const { deviceToken, ...rest } = data;
  const dev = "deviceToken" in data ? deviceToken : devices.get(a.uid);
  const r = await portal.portal({ auth: a, data: { action, ...rest, ...(dev ? { deviceToken: dev } : {}) } });
  if (r && typeof r.deviceToken === "string") devices.set(a.uid, r.deviceToken);
  if (action === "sendCode") await deliverJobs();   // 確認コードの送信は別の処理(本番はトリガー)。テストでは要求の後にここで行う
  return r;
}
/** 送信の依頼を処理する(本番の deliverDealerAuthCode トリガーの代わり) */
async function deliverJobs(service = portal) {
  for (const j of (await db.collection("dealerAuthCodeJobs").get()).docs) await service.deliverCodeJob(j.id);
}
const challengeOf = async (uid) => (await db.collection("dealerAuthChallenges").where("uid", "==", uid).get()).docs[0];
const fac = (uid, action, data = {}) => portal.facility({ auth: auth(uid), data: { action, ...data } });
const today = () => jstDateOf(Date.now());
const surgery = () => jstDateOf(Date.now() + 10 * 24 * 3600 * 1000);
const range = (over = {}) => ({ from: jstDateOf(Date.now() - 2 * 24 * 3600 * 1000), to: today(), facilityFilter: { mode: "all" }, ...over });
let C = {};   // 会社ID

beforeEach(async () => {
  await env.clearFirestore();
  clock.t = null; enabled.v = true; devices.clear();
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
    await op("inviteStaff", { companyId: cid, email: `${uid}@corp.example.jp`, name: `担当${uid}`, role });
    await join(uid);
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
/** 担当者の ID(会社×承認済みのメール)。テストの担当者のメールは {uid}@corp.example.jp */
const sid = (cid, uid) => staffIdOf(cid, `${uid}@corp.example.jp`);
/** 準備用: 確認コードの送信回数の記録を消す(送信回数の制限は専用のテストで確かめる) */
async function resetCodes() { for (const d of (await db.collection("dealerAuthChallenges").get()).docs) await d.ref.delete(); }
/** 正規の本人確認(参加を含む): 確認コードを送り(承認済みのメールに届く)、そのコードで確認する。メールリンクなら端末の値が返り、以後の呼び出しに付く */
async function join(who) {
  await resetCodes();
  const u = typeof who === "string" ? who : who.uid;
  const before = sentCodes.length;
  await api(who, "sendCode", { deviceToken: null });
  const m = sentCodes.slice(before).filter(x => x.key === `v-${u}`).at(-1);
  // 対象(招待・有効な所属)がなければ、応答は同じでもメールは送られない
  if (!m) throw Object.assign(new Error("確認コードは送られていません"), { code: "no-code-sent" });
  return api(who, "verifyCode", { code: m.code, deviceToken: null });
}
/** 続きを最後までたどる(同じ検索)。各ページの newSinceSearch もまとめる */
async function rest(uid, first, over = {}, call = (c) => list(uid, { ...over, cursor: c })) {
  const items = [], flags = [];
  let r = first;
  while (r.nextCursor) { r = await call(r.nextCursor); items.push(...r.items); flags.push(r.newSinceSearch); }
  return { items, complete: r.complete, newSinceSearch: flags.some(Boolean) };
}

test("権限: 会社・支店・担当者・関連付けの管理は運営者だけ。参加は招待されたメールの確認コードだけで、未招待・期限切れ・取り消しは参加できない", async () => {
  for (const a of [auth("adminA"), staffAuth("x1"), auth("z", { platformAdmin: "true" }), null]) {
    await assert.rejects(portal.operator({ auth: a, data: { action: "overview" } }), (e) => ["permission-denied", "unauthenticated"].includes(e.code));
  }
  await rejects(op("createCompany", { name: "x", requestId: "short" }), "invalid-argument");
  await rejects(op("inviteStaff", { companyId: C.X, email: "bad", name: "", role: "reader" }), "invalid-argument");
  await rejects(op("inviteStaff", { companyId: C.X, email: "a@b.jp", name: "", role: "owner" }), "invalid-argument");
  await rejects(op("inviteStaff", { companyId: C.X, email: "a@b.jp", name: "", role: "reader", extra: 1 }), "invalid-argument");
  const { staffId } = await op("inviteStaff", { companyId: C.Y, email: "new@corp.example.jp", name: "新人", role: "reader" });
  // 他人(x1)の確認コードでは参加にならない(x1 自身の所属だけ)。未招待の人には確認コードを送らず(応答は同じ)、会社名も出ない
  await join("x1");
  assert.equal((await db.doc(`dealerStaff/${staffId}`).get()).get("status"), "invited");
  await rejects(join("stranger"), "no-code-sent");
  await rejects(api("stranger", "context"), "permission-denied");
  // 期限切れ
  clock.t = Date.now() + 31 * 24 * 3600 * 1000;
  await rejects(join("new"), "no-code-sent");
  clock.t = null;
  // 取り消し後は参加できない
  await op("cancelInvitation", { companyId: C.Y, staffId });
  await rejects(join("new"), "no-code-sent");
  // 招待は会社×メールで1つ(同じメールの重複はデータの構造上できない)
  await op("inviteStaff", { companyId: C.Y, email: "NEW@corp.example.jp ", name: "新人", role: "reader" });
  assert.equal((await db.collection("dealerStaff").where("approvedEmail", "==", "new@corp.example.jp").get()).size, 1);
  // 支店: 同じ会社の有効な支店だけ。他社の支店は指定できない
  const { branchId } = await op("upsertBranch", { companyId: C.Y, name: "東京支店" });
  await rejects(op("updateStaff", { companyId: C.X, staffId: sid(C.X, "x1"), branchId }), "invalid-argument");
  await op("updateStaff", { companyId: C.Y, staffId: sid(C.Y, "y1"), branchId });
  assert.equal((await api("y1", "context")).me.branch.name, "東京支店");
  await op("updateStaff", { companyId: C.Y, staffId: sid(C.Y, "y1"), branchId: null });
  assert.equal((await api("y1", "context")).me.branch, null, "支店なしでも使える");
});

test("所属: ディーラーの担当者を施設の members に加えない(施設の所属の検索に現れない)", async () => {
  const cg = await db.collectionGroup("members").get();
  assert.deepEqual(cg.docs.map(d => d.id).sort(), ["adminA", "adminB", "ordA", "ordB", "proxyA", "subA"]);
  const staff = await db.collection("dealerStaff").get();
  assert.deepEqual(staff.docs.map(d => [d.get("approvedEmail"), d.get("status")]).sort(), [["x1@corp.example.jp", "active"], ["x2@corp.example.jp", "active"], ["y1@corp.example.jp", "active"]]);
  assert.deepEqual(staff.docs.map(d => d.id).sort(), [sid(C.X, "x1"), sid(C.X, "x2"), sid(C.Y, "y1")].sort(), "担当者の ID は UID ではない");
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
  await op("updateStaff", { companyId: C.X, staffId: sid(C.X, "x2"), status: "disabled" });
  await rejects(list("x2"), "permission-denied");
  await rejects(api("x2", "get", { receiptId: rid }), "permission-denied");
  // 他社の会社IDを指定しても読めない
  await rejects(api("y1", "list", { companyId: C.X, ...range() }), "permission-denied");
  // メールアドレスが変わった(承認済みのメールと一致しない)
  await rejects(api(auth("x1", { email: "x1@other.example.jp" }), "context"), "permission-denied");   // 確認済みの端末でも、メールが違えば使えない
  await rejects(api(auth("x1", { email: "x1@corp.example.jp", email_verified: false }), "context"), "permission-denied");
  // 再招待・確認コードで復帰
  await op("inviteStaff", { companyId: C.X, email: "x2@corp.example.jp", name: "担当x2", role: "reader" });
  await join("x2");
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
  await op("updateStaff", { companyId: C.X, staffId: sid(C.X, "x2"), facilityIds: ["fA", "fB"] });   // 運営者の代行
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
  assert.equal((await fac("adminA", "status", { facilityId: "fA" })).portalEnabled, false, "停止中も状態の確認はできる(取消のため。N-01)");
  await rejects(grant("adminA", "fA", "dA2"), "failed-precondition");
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
  // mainとの統合: 閲覧許可中も件名プレフィックスは変更できるが、C1制御文字は拒否する
  await updateDoc(ref, { subjectPrefix: "＠@@", ...by() });
  assert.equal((await getDoc(ref)).get("subjectPrefix"), "＠@@");
  await assertFails(updateDoc(ref, { subjectPrefix: "@\u0085@", ...by() }));
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

test("F-02: 無効化の後は、前の招待・前の紐付けでは復帰できない(世代)。無効化の後に発行した招待と確認コードでだけ復帰できる。同じメールの別の UID も同じ担当者", async () => {
  await grant("adminA", "fA", "dA1");
  await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);
  const x2 = sid(C.X, "x2");
  const before = (await db.doc(`dealerStaff/${x2}`).get()).get("authRevision");
  await op("updateStaff", { companyId: C.X, staffId: x2, status: "disabled" });
  assert.equal((await db.doc(`dealerStaff/${x2}`).get()).get("authRevision"), before + 1, "無効化で世代を進める");
  await rejects(api("x2", "context"), "permission-denied");
  await rejects(join("x2"), "no-code-sent");
  // 文書を直接「有効」に戻しても(運営者の操作を経ない)、前の世代の紐付けは使えない
  await db.doc(`dealerStaff/${x2}`).update({ status: "active" });
  await rejects(list("x2"), "permission-denied");
  await db.doc(`dealerStaff/${x2}`).update({ status: "disabled" });
  // 無効化の後に発行した招待で、同じメールの別の UID からも復帰できる(運営者の UID の移行は不要。同じ担当者・同じ担当施設)
  await op("inviteStaff", { companyId: C.X, email: "x2@corp.example.jp", name: "担当x2", role: "reader" });
  const other = auth("x2-new-uid", { email: "x2@corp.example.jp" });
  await join(other);
  assert.equal((await api(other, "list", range())).items.length, 1);
  assert.equal((await db.collection("dealerStaff").where("approvedEmail", "==", "x2@corp.example.jp").get()).size, 1);
  await rejects(api("x2", "context"), "permission-denied", "旧 UID の旧端末は使えない");
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
  const p2 = await rest("x1", p1, {}, (c) => racyPortal.portal({ auth: staffAuth("x1"), data: { action: "list", ...range(), limit: 1, cursor: c, deviceToken: devices.get("x1") } }));
  assert.ok(injected);
  assert.deepEqual(p2.items.map(i => i.orderNumber), [o1.orderNumber]);
  assert.deepEqual([p2.complete, p2.newSinceSearch], [true, true], "欠けたまま「新しい注文なし」としない");
  assert.deepEqual((await list("x1")).items.map(i => i.orderNumber), [o3.orderNumber, o2.orderNumber, o1.orderNumber]);
});

test("F-06: 所属の変更後(旧会社で無効化)も、会社を指定せずに有効な会社を開ける。有効な所属が2社なら選択、すべて無効なら拒否。会社の候補は有効な所属だけ", async () => {
  await grant("adminA", "fA", "dA1");
  await grant("adminA", "fA", "dA2");
  // x1 が会社Xを退職し、会社Yへ参加
  await op("updateStaff", { companyId: C.X, staffId: sid(C.X, "x1"), status: "disabled" });
  await op("inviteStaff", { companyId: C.Y, email: "x1@corp.example.jp", name: "担当x1", role: "reader" });
  await join("x1");
  assert.equal((await db.collection("dealerAuthBindings").where("staffId", "==", sid(C.X, "x1")).get()).size, 1, "旧会社の紐付けは残るが、世代が違うので使えない");
  const ctx = await api("x1", "context");
  assert.equal(ctx.company.id, C.Y, "有効な1社を開く");
  assert.deepEqual((await api("x1", "companies")).companies, [{ companyId: C.Y, name: "ワイ医療" }]);
  await rejects(api("x1", "context", { companyId: C.X }), "permission-denied");
  // 有効な所属が2社: 会社の指定が必要。候補は2社
  await op("inviteStaff", { companyId: C.X, email: "y1@corp.example.jp", name: "担当y1", role: "reader" });
  await join("y1");
  await rejects(api("y1", "context"), "failed-precondition");
  assert.deepEqual((await api("y1", "companies")).companies.map(c => c.name), ["エックス商事", "ワイ医療"]);
  assert.equal((await api("y1", "context", { companyId: C.X })).company.id, C.X);
  // 会社Xを停止すると、y1 は有効な1社(Y)になる
  await op("updateCompany", { companyId: C.X, status: "suspended" });
  assert.equal((await api("y1", "context")).company.id, C.Y);
  // すべて無効
  await op("updateStaff", { companyId: C.Y, staffId: sid(C.Y, "x1"), status: "disabled" });
  await rejects(api("x1", "context"), "permission-denied");
  await assert.rejects(api("x1", "companies"), (e) => e.code === "permission-denied", "無効化で紐付けも使えない");
  await assert.rejects(api("stranger", "companies"), (e) => e.code === "permission-denied");
  await rejects(api("x1", "companies", { companyId: C.Y }), "invalid-argument");
});

/** 同じ認証主体に、無効・停止の旧所属の紐付けを n 件作る(DB に直接) */
async function oldBindings(uid, n, prefix) {
  const email = `${uid}@corp.example.jp`;
  const key = (await db.collection("dealerAuthBindings").where("staffId", "==", sid(C.X, uid)).get()).docs[0].get("principalKey");
  for (let start = 0; start < n; start += 250) {
    const batch = db.batch();
    for (let i = start; i < Math.min(n, start + 250); i++) {
      const cid = `${prefix}-${String(i).padStart(3, "0")}`;
      const st = staffIdOf(cid, email);
      batch.set(db.doc(`dealerCompanies/${cid}`), { name: `旧会社${i}`, status: i % 2 ? "suspended" : "active", accessMode: "companyWide", policyVersion: 1 });
      batch.set(db.doc(`dealerStaff/${st}`), { staffId: st, companyId: cid, approvedEmail: email, role: "reader", status: i % 2 ? "active" : "disabled", authRevision: 2 });
      batch.set(db.doc(`dealerAuthBindings/old-${cid}`), { companyId: cid, staffId: st, principalKey: key, provider: "device", authRevision: i % 2 ? 2 : 1, verifiedAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 3600e3) });
    }
    await batch.commit();
  }
}

test("F-06(再レビュー・再々レビュー): 同じ認証主体に無効・停止の旧所属の紐付けが多数(20件超・500件超)残っていても、件数で切らずに確かめ、有効な会社を開ける。参加で有効な所属を削らない", async () => {
  await oldBindings("x1", 21, "dco-old");
  assert.deepEqual((await api("x1", "companies")).companies, [{ companyId: C.X, name: "エックス商事" }]);
  assert.equal((await api("x1", "context")).company.id, C.X);
  await oldBindings("x2", 520, "dco-h");
  assert.deepEqual((await api("x2", "companies")).companies, [{ companyId: C.X, name: "エックス商事" }]);
  assert.equal((await api("x2", "context")).company.id, C.X);
  // 新しい会社に参加しても、有効な所属(X)は残る
  await op("inviteStaff", { companyId: C.Y, email: "x2@corp.example.jp", name: "", role: "reader" });
  await join("x2");
  assert.deepEqual((await api("x2", "companies")).companies.map(c => c.companyId).sort(), [C.X, C.Y].sort());
  await rejects(api("x2", "context"), "failed-precondition");   // 有効2社: 会社の選択が必要
});

test("N-01: 機能の停止中も、施設の管理者・副管理者は許可中の発注先を取り消せる(状態の確認も可)。取消の後は発注先を変更でき、再開後の新しい許可は取消前・停止中の注文を公開しない。停止中は許可・閲覧・索引は止まる", async () => {
  await grant("adminA", "fA", "dA1");
  const before = await placeOrder("fA", "ordA", [line({ dealerId: "dA1", power: "+19.0D" })]);
  const { updateDoc, serverTimestamp } = await import("firebase/firestore");
  const adminDb = env.authenticatedContext("adminA", { email: "adminA@example.jp", email_verified: true }).firestore();
  const ref = doc(adminDb, "facilities/fA/facilityDealers/dA1");
  const by = () => ({ updatedBy: "adminA", updatedAt: serverTimestamp() });
  enabled.v = false;   // 運用中に機能を停止
  // 停止中: 担当者の閲覧・施設の許可は止まり、発注先は許可中のためロックされている
  await rejects(list("x1"), "failed-precondition");
  await rejects(grant("adminA", "fA", "dA2"), "failed-precondition");
  await assertFails(updateDoc(ref, { orderEmails: ["new-x@x.example.jp"], ...by() }));
  // 状態の確認と取消はできる(停止中であることも返す)。注文者・他施設の管理者は取り消せない
  const st = await fac("subA", "status", { facilityId: "fA" });
  assert.equal(st.portalEnabled, false);
  assert.equal(st.dealers.find(d => d.localDealerId === "dA1").link.status, "active");
  await rejects(revoke("ordA", "fA", "dA1"), "permission-denied");
  await rejects(revoke("adminB", "fA", "dA1"), "permission-denied");
  await revoke("subA", "fA", "dA1");
  assert.equal((await db.doc("facilities/fA/dealerPortalLinks/dA1").get()).get("status"), "revoked");
  // 取消の後は、発注先の宛先を通常の操作で変更できる
  await updateDoc(ref, { orderEmails: ["new-x@x.example.jp"], ...by() });
  const during = await placeOrder("fA", "ordA", [line({ dealerId: "dA1", power: "+20.5D" })]);   // 停止中の注文(索引は作らない)
  assert.equal((await portal.indexOrder("fA", during.orderId)).disabled, true);
  // 再開 → 新しい許可: 許可の後の注文だけ(取消前・停止中の注文は出ない)
  enabled.v = true;
  assert.equal((await fac("adminA", "status", { facilityId: "fA" })).portalEnabled, true);
  await grant("adminA", "fA", "dA1");
  await portal.indexOrder("fA", during.orderId);
  await portal.indexOrder("fA", before.orderId);
  const after = await placeOrder("fA", "ordA", [line({ dealerId: "dA1", power: "+21.5D" })]);
  assert.deepEqual((await list("x1")).items.map(i => i.orderNumber), [after.orderNumber]);
  // 他社(Y)には出ない
  assert.ok(!JSON.stringify((await list("y1")).items).includes(after.orderNumber));
});

test("N-02: 続きのカーソルは、検索時点から読み取り可能な時間(59.5分)まで。59分後の続きは読め、それを超えると先頭からの再検索を求める。返すカーソルの期限も延ばさない", async () => {
  await grant("adminA", "fA", "dA1");
  for (let i = 0; i < 3; i++) await placeOrder("fA", "ordA", [line({ dealerId: "dA1", power: `+${18 + i}.0D` })]);
  const t0 = Date.now();
  const p1 = await list("x1", { limit: 1 });
  const decode = (c) => JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
  const c1 = decode(p1.nextCursor);
  const asMs = c1.as[0] * 1000 + Math.floor(c1.as[1] / 1e6);
  assert.ok(c1.exp <= asMs + 59.5 * 60 * 1000 + 1);
  clock.t = t0 + 59 * 60 * 1000;   // 59分後
  const p2 = await list("x1", { limit: 1, cursor: p1.nextCursor });
  assert.equal(p2.items.length, 1);
  const c2 = decode(p2.nextCursor);
  assert.deepEqual(c2.as, c1.as, "検索時点は同じ");
  assert.ok(c2.exp <= asMs + 59.5 * 60 * 1000 + 1, "続きのたびに期限を延ばさない");
  clock.t = t0 + 61 * 60 * 1000;   // 検索時点から1時間超
  await assert.rejects(list("x1", { limit: 1, cursor: p2.nextCursor }), (e) => e.code === "invalid-argument" && /先頭から検索し直してください/.test(e.message));
  clock.t = null;
  assert.equal((await list("x1")).items.length, 3, "再検索は読める");
});

// ======================= 本人確認: 担当者 ID × 認証主体のホワイトリスト(docs/dealer-portal.md「認証主体」) =======================
const googleAuth = (uid, email, gid, over = {}) => auth(uid, { email, firebase: { sign_in_provider: "google.com", identities: { "google.com": [gid], email: [email] } }, ...over });
// Microsoft は email_verified が false でもよい(紐付けの確認コードを証明にする)
const msAuth = (uid, email, mid, over = {}) => auth(uid, { email, email_verified: false, firebase: { sign_in_provider: "microsoft.com", identities: { "microsoft.com": [mid], ...(email ? { email: [email] } : {}) } }, ...over });
// メールリンク・通常のパスワード(トークン上は区別できない)。identities で連携中のほかのプロバイダーを足せる
const pwAuth = (uid, email, identities = {}) => auth(uid, { email, firebase: { sign_in_provider: "password", identities: { email: [email], ...identities } } });
const needsVerify = (e) => e.code === "permission-denied" && e.details && e.details.reason === "verification-required";
/** 確認コードを送り(承認済みのメールに届く)、そのコードで確認する(認証主体ごとの送信回数は数えたまま) */
async function verifyAs(who, extra = {}) {
  await api(who, "sendCode", extra);
  return api(who, "verifyCode", { code: sentCodes.at(-1).code, ...extra });
}
const bindingsOf = async (staffId) => (await db.collection("dealerAuthBindings").where("staffId", "==", staffId).get()).docs.map(d => d.data());
const providersOf = async (staffId) => (await bindingsOf(staffId)).map(b => b.provider).sort();
const UNIFORM = { ok: true, expiresInMinutes: 10 };

test("認証主体: Google・Microsoft・メールリンクとも、初回は承認済みのメールへの確認コードで担当者に紐付け、確認したブラウザの端末の値も発行する。別の UID でも同じ担当者(担当施設も同じ)。新しいブラウザでは確認し直す", async () => {
  await grant("adminA", "fA", "dA1");
  await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);
  const email = "n1@corp.example.jp";
  const { staffId } = await op("inviteStaff", { companyId: C.X, email, name: "新人", role: "reader" });
  assert.equal(staffId, sid(C.X, "n1"));
  // Google(UID u-g): 確認前は会社・一覧を出さない
  const g = googleAuth("u-g", email, "g-n1");
  for (const [action, data] of [["companies", {}], ["context", {}], ["list", range()]]) await assert.rejects(api(g, action, data), needsVerify, action);
  assert.deepEqual(await api(g, "sendCode"), UNIFORM);
  const mail = sentCodes.at(-1);
  assert.deepEqual([mail.purpose, mail.key, mail.to, mail.companyName], ["verify", "v-u-g", email, "エックス商事"], "送り先はサーバーが確定した承認済みのメール");
  assert.match(mail.code, /^\d{8}$/);
  const gv = await api(g, "verifyCode", { code: mail.code });
  assert.deepEqual([gv.ok, gv.companies, gv.joined], [true, 1, 1]);
  assert.match(gv.deviceToken, /^[A-Za-z0-9_-]{43}$/, "Google でも確認したブラウザに端末の値を返す(AB-02)");
  assert.equal((await db.doc(`dealerStaff/${staffId}`).get()).get("status"), "active", "参加(招待の承諾)も同時に");
  assert.equal((await api(g, "context")).company.id, C.X);
  assert.equal((await api(g, "list", range())).items.length, 1);
  await assert.rejects(api(g, "context", { deviceToken: null }), needsVerify, "Google でも新しいブラウザでは確認し直す");
  await api(g, "setAssignments", { facilityIds: ["fA"] });
  // Microsoft(別の UID。email_verified は false): 同じ担当者・同じ担当施設
  const m = msAuth("u-m", email, "m-n1");
  await assert.rejects(api(m, "context"), needsVerify);
  const mv = await verifyAs(m);
  assert.deepEqual([mv.companies, mv.joined], [1, 0]);
  const ctx = await api(m, "context");
  assert.deepEqual([ctx.company.id, ctx.selection, ctx.selectedFacilityIds], [C.X, "assigned", ["fA"]], "ログイン方法が違っても同じ担当者");
  // メールリンク(別の UID)
  const p = pwAuth("u-p", email);
  await assert.rejects(api(p, "context"), needsVerify);
  await verifyAs(p);
  assert.equal((await api(p, "context")).company.id, C.X);
  await assert.rejects(api(p, "context", { deviceToken: null }), needsVerify);
  // 担当者は1つ(会社×メール)。紐付けは Google・Microsoft と、確認したブラウザ3つ
  assert.equal((await db.collection("dealerStaff").where("approvedEmail", "==", email).get()).size, 1);
  assert.deepEqual(await providersOf(staffId), ["device", "device", "device", "google", "microsoft"]);
  const stored = (await bindingsOf(staffId)).filter(b => b.provider === "device");
  assert.ok(!JSON.stringify(stored).includes(gv.deviceToken), "端末の値はハッシュだけを保存");
  // 確認済みのブラウザでも、紐付けていない認証主体では使えない(端末の値と認証主体の両方が必要)
  await assert.rejects(api(googleAuth("u-g", email, "g-other"), "context", { deviceToken: devices.get("u-g") }), needsVerify);
});

test("AB-02: 更新したトークンの identities は「いま連携されているアカウント」を示し得る。紐付け済みの Microsoft の ID を名乗る古い更新セッションでも、確認したブラウザの端末の値がなければ閲覧できない", async () => {
  await grant("adminA", "fA", "dA1");
  await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);
  const email = "x1@corp.example.jp";
  // 本人が Microsoft A を紐付け(同じ UID x1。確認したブラウザの値も発行)
  const a = msAuth("x1", email, "m-A");
  await verifyAs(a);
  const aDevice = devices.get("x1");
  assert.equal((await api(a, "list", range())).items.length, 1);
  // B の古い更新トークンで更新したトークン(Codex の再現と同じ形: sign_in_provider は microsoft.com、identities はいまの A)。B のブラウザには値がない
  const bRefreshed = msAuth("x1", email, "m-A");
  for (const [action, data] of [["context", {}], ["companies", {}], ["list", range()], ["setAssignments", { facilityIds: ["fA"] }]]) {
    await assert.rejects(api(bRefreshed, action, { ...data, deviceToken: null }), needsVerify, action);
  }
  await assert.rejects(api(bRefreshed, "context", { deviceToken: "A".repeat(43) }), needsVerify, "偽の値");
  await assert.rejects(api(bRefreshed, "context", { deviceToken: devices.get("y1") }), needsVerify, "別の担当者のブラウザの値");
  // B が確認コードを要求しても届くのは本人のメール。B は確認できない
  clock.t = Date.now() + 2 * 60 * 1000;   // 同じ認証主体の送り直しは1分あける
  await api(bRefreshed, "sendCode", { deviceToken: null });
  assert.equal(sentCodes.at(-1).to, email);
  clock.t = null;
  // 本人(確認したブラウザ)は使える
  assert.equal((await api(a, "context", { deviceToken: aDevice })).company.id, C.X);
});

test("認証主体: 承認済みのメールと違うアカウント・メールの取れない Microsoft・未確認のメール・識別子が1つでない・ほかのログイン方法は拒否(推測で補わない)。登録の有無は応答で区別しない(AB-03)", async () => {
  // 個人の Gmail・未確認メールの Microsoft で、登録のないメール: 応答は登録がある場合と同じ。メールは送らず、照合もできない
  for (const who of [googleAuth("u-x", "x1.personal@gmail.com", "g-personal"), msAuth("u-mx", "nobody@corp.example.jp", "m-nobody")]) {
    await assert.rejects(api(who, "context"), needsVerify);
    const before = sentCodes.length;
    assert.deepEqual(await api(who, "sendCode"), UNIFORM, "登録の有無で応答を変えない");
    assert.equal(sentCodes.length, before, "未登録には送らない");
    await rejects(api(who, "verifyCode", { code: "12345678" }), "failed-precondition");
  }
  const registered = msAuth("u-mr", "x2@corp.example.jp", "m-x2");
  assert.deepEqual(await api(registered, "sendCode"), UNIFORM);
  // Microsoft のメールが取れない
  for (const who of [msAuth("u-m0", "", "m-0"), msAuth("u-m1", "not-an-email", "m-1")]) {
    for (const action of ["context", "sendCode", "verifyCode"]) await assert.rejects(api(who, action, action === "verifyCode" ? { code: "12345678" } : {}), (e) => e.code === "permission-denied" && /メールアドレスを確認できません/.test(e.message), action);
  }
  // 識別子がちょうど1つでない・未確認のメール(Google・メールリンク。文字列の "true" も不可)
  const email = "x1@corp.example.jp";
  for (const who of [auth("x1", { email, firebase: { sign_in_provider: "google.com", identities: { "google.com": ["g-a", "g-b"] } } }),
    auth("x1", { email, firebase: { sign_in_provider: "google.com", identities: {} } }),
    auth("x1", { email, firebase: { sign_in_provider: "microsoft.com", identities: { "microsoft.com": ["m-a", "m-b"] } } }),
    googleAuth("x1", email, "g-x1", { email_verified: false }), googleAuth("x1", email, "g-x1", { email_verified: "true" }),
    auth("x1", { email, email_verified: false }), auth("x1", { email, email_verified: "true" }), auth("x1", { email, email_verified: undefined })]) {
    for (const action of ["context", "companies", "sendCode"]) await rejects(api(who, action), "permission-denied");
  }
  for (const provider of ["anonymous", "custom", "phone", undefined]) await rejects(api(auth("x1", { email, firebase: { sign_in_provider: provider } }), "context"), "permission-denied");
  await rejects(portal.portal({ auth: null, data: { action: "context" } }), "unauthenticated");
});

test("MS-01・G-02 の経路(ホワイトリスト): 未登録の Microsoft・自分の Google が既存の UID に入っても、パスワードを設定・連携を解除して入り直しても、本人の確認コードなしには閲覧できない。本人の紐付けは使える", async () => {
  await grant("adminA", "fA", "dA1");
  await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);
  const email = "x1@corp.example.jp";
  const rid = (await list("x1")).items[0].receiptId;   // 本人(メールリンク・確認済みの端末)
  const emailDevice = devices.get("x1");   // メールリンクで発行した値(方式ごとに別)
  await verifyAs(googleAuth("x1", email, "g-x1"));       // 本人の Google も紐付け済み(同じブラウザ。Google に発行した値は Google のログインだけ)
  const bound = await providersOf(sid(C.X, "x1"));
  const intruders = [
    msAuth("x1", email, "m-evil"),
    pwAuth("x1", email, { "microsoft.com": ["m-evil"] }),
    pwAuth("x1", email),
    pwAuth("x1", email, { "google.com": ["g-x1"] }),
    auth("x1", { email, firebase: { sign_in_provider: "microsoft.com", identities: { "microsoft.com": ["m-evil"], "google.com": ["g-x1"] } } }),
    googleAuth("x1", email, "g-attacker"),
    googleAuth("x1", email, "g-x1")   // 本人の Google の ID を名乗る別のブラウザのセッション(AB-02)
  ];
  for (const who of intruders) {
    for (const [action, data] of [["context", {}], ["companies", {}], ["list", range()], ["get", { receiptId: rid }], ["setAssignments", { facilityIds: ["fA"] }]]) {
      await assert.rejects(api(who, action, { ...data, deviceToken: null }), needsVerify, `${who.token.firebase.sign_in_provider} ${action}`);
    }
  }
  await assert.rejects(api(pwAuth("x1", email), "context", { deviceToken: "A".repeat(43) }), needsVerify);
  await assert.rejects(api(pwAuth("x1", email), "context", { deviceToken: devices.get("y1") }), needsVerify, "別の担当者の端末");
  const evil = intruders[0];
  await api(evil, "sendCode", { deviceToken: null });
  assert.equal(sentCodes.at(-1).to, email);
  const code = sentCodes.at(-1).code;
  for (let i = 0; i < 5; i++) await assert.rejects(api(evil, "verifyCode", { code: code === "00000000" ? "11111111" : "00000000", deviceToken: null }), (e) => /確認コードが違います/.test(e.message));
  await assert.rejects(api(evil, "verifyCode", { code, deviceToken: null }), (e) => /無効/.test(e.message), "5回の誤りの後は正しいコードも無効");
  assert.deepEqual(await providersOf(sid(C.X, "x1")), bound, "紐付けは増えない");
  assert.equal((await api("x1", "get", { receiptId: rid, deviceToken: emailDevice })).facilityId, "fA");
  assert.equal((await api(googleAuth("x1", email, "g-x1"), "context")).company.id, C.X, "本人の Google(確認したブラウザ)");
});

test("AB-01: 確認コードは送った時点の対象(会社・担当者・世代・状態)にだけ使える。無効化→再有効化、無効化→再招待、送信後に届いた招待には、前のコードを使えない", async () => {
  const email = "x1@corp.example.jp", x1 = sid(C.X, "x1");
  // 経路1: 未登録の Google でコードを送る → 無効化 → 再有効化 → 前のコードで照合
  const g = googleAuth("u-ab1", email, "g-ab1");
  await api(g, "sendCode");
  const c1 = sentCodes.at(-1).code;
  await op("updateStaff", { companyId: C.X, staffId: x1, status: "disabled" });
  await op("updateStaff", { companyId: C.X, staffId: x1, status: "active" });
  await assert.rejects(api(g, "verifyCode", { code: c1 }), (e) => e.code === "failed-precondition" && /無効/.test(e.message));
  await assert.rejects(api(g, "context"), needsVerify);
  assert.ok(!(await providersOf(x1)).includes("google"), "新しい世代に紐付けない");
  // 新しいコードなら使える
  clock.t = Date.now() + 2 * 60 * 1000;
  await verifyAs(g);
  clock.t = null;
  assert.equal((await api(g, "context")).company.id, C.X);
  // 経路2: Microsoft でコードを送る → 無効化 → 同じメールへ再招待 → 前のコードで照合(招待は承諾されない)
  const x2 = sid(C.X, "x2");
  const m = msAuth("u-ab2", "x2@corp.example.jp", "m-ab2");
  await api(m, "sendCode");
  const c2 = sentCodes.at(-1).code;
  await op("updateStaff", { companyId: C.X, staffId: x2, status: "disabled" });
  await op("inviteStaff", { companyId: C.X, email: "x2@corp.example.jp", name: "担当x2", role: "reader" });
  await assert.rejects(api(m, "verifyCode", { code: c2 }), (e) => /無効/.test(e.message));
  assert.equal((await db.doc(`dealerStaff/${x2}`).get()).get("status"), "invited", "前のコードでは新しい招待を承諾しない");
  await assert.rejects(api(m, "context"), needsVerify);
  // 経路3: 送信の後に届いた別の会社の招待には使わない(送った時点の対象だけ。メールに書いた会社と一致)
  const p = pwAuth("u-ab3", email);
  await api(p, "sendCode");
  const c3 = sentCodes.at(-1);
  assert.equal(c3.companyName, "エックス商事");
  await op("inviteStaff", { companyId: C.Y, email, name: "", role: "reader" });
  const r = await api(p, "verifyCode", { code: c3.code });
  assert.deepEqual([r.companies, r.joined], [1, 0]);
  assert.equal((await db.doc(`dealerStaff/${sid(C.Y, "x1")}`).get()).get("status"), "invited");
  assert.equal((await api(p, "companies")).pendingInvitation, true, "新しい案内は、改めて確認コードで参加");
});

test("AB-02(再レビュー): 端末の値は発行したときの認証主体・方式に結び付く。置き換えた旧 Microsoft B に発行した値で、A に置き換えた後の更新セッション(identities は A)から閲覧できない。方式をまたいだ転用もできない", async () => {
  await grant("adminA", "fA", "dA1");
  await placeOrder("fA", "ordA", [line({ dealerId: "dA1" })]);
  const email = "x1@corp.example.jp", x1 = sid(C.X, "x1");
  // 再現A: Microsoft B が確認コードを通し、B のブラウザに値 D_B が発行される
  const b = msAuth("x1", email, "m-B");
  const dB = (await verifyAs(b)).deviceToken;
  assert.equal((await api(b, "context", { deviceToken: dB })).company.id, C.X);
  // 本人が B を外し、Microsoft A で確認コードを通す(B の紐付けと、B に発行した値は消える)
  clock.t = Date.now() + 2 * 60 * 1000;
  const a = msAuth("x1", email, "m-A");
  const dA = (await verifyAs(a)).deviceToken;
  clock.t = null;
  const binds = await bindingsOf(x1);
  assert.ok(!binds.some(x => x.principalKey === "microsoft:m-B" || x.issuedFor === "microsoft:m-B"), "置き換えた主体の紐付け・端末の値は残さない");
  // B の古い更新トークンで更新したセッション(sign_in_provider は microsoft.com・identities は A)が、旧 D_B を付けても閲覧できない
  const bRefreshed = msAuth("x1", email, "m-A");
  for (const [action, data] of [["context", {}], ["companies", {}], ["list", range()], ["setAssignments", { facilityIds: ["fA"] }]]) {
    await assert.rejects(api(bRefreshed, action, { ...data, deviceToken: dB }), needsVerify, action);
  }
  assert.equal((await api(a, "context", { deviceToken: dA })).company.id, C.X, "本人(A・A に発行した値)は使える");
  // 置き換えの削除が漏れても(古いデータ)、発行した主体が違えば使えない
  await db.doc(`dealerAuthBindings/legacy-B`).set({ companyId: C.X, staffId: x1, principalKey: "device:legacy", provider: "device", issuedFor: "microsoft:m-B", uid: "x1", authRevision: 1, verifiedAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 3600e3) });
  // 再現B: 方式をまたいだ転用(同じ担当者)。Google G・Microsoft A・メールリンクで、それぞれ発行した値を別の方式・主体に付けても拒否
  clock.t = Date.now() + 4 * 60 * 1000;
  const g = googleAuth("x1", email, "g-G");
  const dG = (await verifyAs(g)).deviceToken;
  clock.t = null;
  const dP = devices.get("x1") === dG ? null : null;   // (メールリンクで参加したときの値は devices に上書きされたため、改めて取る)
  clock.t = Date.now() + 6 * 60 * 1000;
  const p = pwAuth("x1", email);
  const dPw = (await verifyAs(p)).deviceToken;
  clock.t = null;
  assert.equal(dP, null);
  const cases = [
    [g, dA, "Google に Microsoft の値"], [a, dG, "Microsoft に Google の値"],
    [p, dG, "password に Google の値"], [p, dA, "password に Microsoft の値"],
    [g, dPw, "Google にメールリンクの値"], [a, dPw, "Microsoft にメールリンクの値"],
    [googleAuth("x1", email, "g-other"), dG, "未登録の Google に登録済みの Google の値"],
    [pwAuth("x1-other-uid", email), dG, "別の UID の password に Google の値"]
  ];
  for (const [who, dev, label] of cases) await assert.rejects(api(who, "context", { deviceToken: dev }), needsVerify, label);
  // 同じ主体・方式なら使える(別の UID でも同じ主体なら設計どおり)
  for (const [who, dev] of [[g, dG], [a, dA], [p, dPw], [pwAuth("x1-other-uid", email), dPw]]) assert.equal((await api(who, "context", { deviceToken: dev })).company.id, C.X);
  // 担当者の無効化で、すべて失効
  await op("updateStaff", { companyId: C.X, staffId: x1, status: "disabled" });
  for (const [who, dev] of [[g, dG], [a, dA], [p, dPw]]) await assert.rejects(api(who, "context", { deviceToken: dev }), needsVerify);
});

test("AB-03(再レビュー): 確認コードの要求への応答は、登録の有無・送信の成否・送信の待ち時間に関係なく同じ。送信は要求の後の別の処理で行う", async () => {
  await op("inviteStaff", { companyId: C.X, email: "reg@corp.example.jp", name: "", role: "reader" });
  let slow = 0;
  const slowSender = createDealerPortalService({ db, FieldValue, Timestamp, FieldPath, isEnabled: () => true, now: () => Date.now(),
    sendJoinCode: async (m) => { slow++; await new Promise(r => setTimeout(r, 300)); sentCodes.push(m); return { ok: false, error: "provider-down" }; } });
  const call = (who) => slowSender.portal({ auth: who, data: { action: "sendCode" } });
  const before = sentCodes.length;
  const t0 = Date.now();
  const reg = await call(msAuth("u-reg", "reg@corp.example.jp", "m-reg"));
  const t1 = Date.now();
  const unreg = await call(msAuth("u-unreg", "nobody@corp.example.jp", "m-unreg"));
  const t2 = Date.now();
  assert.deepEqual(reg, unreg, "同じ応答");
  assert.equal(slow, 0, "要求の中では送らない(送信の待ち時間・失敗が応答に出ない)");
  assert.ok(t1 - t0 < 300 && t2 - t1 < 300, `応答は送信を待たない: ${t1 - t0}ms / ${t2 - t1}ms`);
  // 送信の処理: 登録のあるメールだけ送る。失敗は記録だけ
  await deliverJobs(slowSender);
  assert.equal(slow, 1);
  assert.equal(sentCodes.length, before + 1);
  assert.deepEqual([(await challengeOf("u-reg")).get("deliveryStatus"), (await challengeOf("u-unreg")).get("deliveryStatus")], ["failed", "no-target"]);
  // どちらも照合の結果は同じ(違うコード)。送信の依頼は1回だけ処理(再処理しても送らない)
  for (const who of [msAuth("u-reg", "reg@corp.example.jp", "m-reg"), msAuth("u-unreg", "nobody@corp.example.jp", "m-unreg")]) {
    await assert.rejects(slowSender.portal({ auth: who, data: { action: "verifyCode", code: "00000000" } }), (e) => /確認コードが違います/.test(e.message));
  }
  await deliverJobs(slowSender);
  assert.equal(slow, 1);
  assert.equal((await db.collection("dealerAuthCodeJobs").get()).size, 0);
});

test("確認コードの送信の直前の読み直し: 依頼の後に担当者の無効化・招待の取消・会社の停止があれば送らない。期限切れの依頼からはコードを作らない", async () => {
  // 要求だけ(送信の処理はまだ)を行う
  const request = (who) => portal.portal({ auth: who, data: { action: "sendCode" } });
  const before = sentCodes.length;
  // 1) 有効な担当者 → 依頼の後に無効化
  await request(msAuth("u-d1", "x1@corp.example.jp", "m-d1"));
  await op("updateStaff", { companyId: C.X, staffId: sid(C.X, "x1"), status: "disabled" });
  // 2) 招待中 → 依頼の後に取消
  const inv = await op("inviteStaff", { companyId: C.Y, email: "nd2@corp.example.jp", name: "", role: "reader" });
  await request(msAuth("u-d2", "nd2@corp.example.jp", "m-d2"));
  await op("cancelInvitation", { companyId: C.Y, staffId: inv.staffId });
  // 取消だけの効果を独立して確認(会社はまだ active)。会社停止と重ねない。
  await deliverJobs();
  assert.equal(sentCodes.length, before, "招待取消だけで配送されない");
  {
    const canceled = (await challengeOf("u-d2")).data();
    assert.deepEqual([canceled.deliveryStatus, canceled.targets.length, typeof canceled.hash], ["target-changed", 0, "string"]);
  }
  // 3) 有効な担当者 → 依頼の後に会社を停止
  await request(msAuth("u-d3", "y1@corp.example.jp", "m-d3"));
  await op("updateCompany", { companyId: C.Y, status: "suspended" });
  await deliverJobs();
  assert.equal(sentCodes.length, before, "取消・無効化・会社の停止の後は送らない");
  for (const u of ["u-d1", "u-d2", "u-d3"]) {
    const ch = (await challengeOf(u)).data();
    assert.deepEqual([ch.deliveryStatus, ch.targets.length, typeof ch.hash], ["target-changed", 0, "string"], u);
  }
  // 照合の結果は送った場合と同じ形(違うコード)。紐付けはできない
  await assert.rejects(portal.portal({ auth: msAuth("u-d1", "x1@corp.example.jp", "m-d1"), data: { action: "verifyCode", code: "00000000" } }), (e) => /確認コードが違います/.test(e.message));
  // 4) 期限切れの依頼(5分を過ぎて処理された)からはコードを作らない
  await op("updateCompany", { companyId: C.Y, status: "active" });
  await request(msAuth("u-d4", "y1@corp.example.jp", "m-d4"));
  clock.t = Date.now() + 6 * 60 * 1000;
  await deliverJobs();
  clock.t = null;
  const ch4 = (await challengeOf("u-d4")).data();
  assert.deepEqual([ch4.deliveryStatus, ch4.hash], ["expired", undefined], "期限切れの依頼: コードなし");
  assert.equal(sentCodes.length, before);
  assert.equal((await db.collection("dealerAuthCodeJobs").get()).size, 0, "依頼は残さない");
  // 期限内・対象が有効なら従来どおり送る
  clock.t = Date.now() + 8 * 60 * 1000;
  await request(msAuth("u-d4", "y1@corp.example.jp", "m-d4"));
  await deliverJobs();
  clock.t = null;
  assert.equal(sentCodes.length, before + 1);
  assert.equal((await challengeOf("u-d4")).get("deliveryStatus"), "sent");
});

test("週表示(手術日): 月曜〜日曜の自社宛ての明細を手術日ごとに。複数の手術日の注文は各週にその週の明細だけ(注文番号は同じ・ほかの手術日を示す)。他社・未許可の施設・取消後は出ない", async () => {
  // 来週以降の月曜(注文できる手術日の範囲内)。W1 の火曜と、翌週 W2 の火曜
  const base = Date.now() + 8 * 24 * 3600e3;
  let mon = jstDateOf(base);
  while (!weekDatesOf(mon)) mon = jstDateOf(Date.parse(`${mon}T00:00:00Z`) + 24 * 3600e3 - 9 * 3600e3);
  const W1 = weekDatesOf(mon), W2 = weekDatesOf(jstDateOf(Date.parse(`${mon}T00:00:00Z`) + 7 * 24 * 3600e3 - 9 * 3600e3 + 12 * 3600e3));
  assert.equal(W1.length, 7); assert.equal(W2[0] > W1[6], true);
  await grant("adminA", "fA", "dA1");
  await grant("adminA", "fA", "dA2");
  const o = await placeOrder("fA", "ordA", [
    line({ dealerId: "dA1", surgeryDate: W1[1] }), line({ dealerId: "dA1", surgeryDate: W2[1], power: "+21.0D" }),
    line({ dealerId: "dA2", surgeryDate: W1[1], power: "+19.0D" }), line({ dealerId: "dA1", surgeryDate: W1[1], power: "+22.0D", quantity: 2 })]);
  await placeOrder("fB", "ordB", [line({ dealerId: "dB1", surgeryDate: W1[2] })]);   // 未許可の施設(fB)
  const week = (uid, weekStart, over = {}) => api(uid, "week", { weekStart, facilityFilter: { mode: "all" }, ...over });
  const flat = (r) => r.days.flatMap(d => d.orders.map(x => [d.date, x.orderNumber, x.lines.map(l => `${l.power}x${l.quantity}`).join(","), x.otherDates.join(",")]));
  const x1 = await week("x1", W1[0]);
  assert.deepEqual([x1.weekStart, x1.weekEnd, x1.days.length, x1.truncated], [W1[0], W1[6], 7, false]);
  assert.deepEqual(flat(x1), [[W1[1], o.orderNumber, "+20.0Dx1,+22.0Dx2", W2[1]]], "W1 は W1 の自社宛ての明細だけ(ほかの手術日を示す)");
  const item = x1.days[1].orders[0];
  assert.deepEqual(Object.keys(item).sort(), ["facilityId", "facilityName", "lines", "orderNumber", "orderedAt", "otherDates", "ownLineCount", "receiptId"]);
  assert.deepEqual([item.facilityName, item.ownLineCount, Object.keys(item.lines[0]).sort()], ["A眼科", 3, ["manufacturer", "model", "no", "power", "quantity", "toricModel"]], "返す項目は列挙したものだけ(担当医・他社・備考は返さない)");
  assert.deepEqual(flat(await week("x1", W2[0])), [[W2[1], o.orderNumber, "+21.0Dx1", W1[1]]], "W2 は同じ注文番号で W2 の明細だけ");
  assert.deepEqual(flat(await week("y1", W1[0])).map(x => x.slice(0, 3)), [[W1[1], o.orderNumber, "+19.0Dx1"]], "他社(Y)は自社宛ての明細だけ");
  assert.deepEqual(flat(await week("y1", W2[0])), []);
  // 施設の絞り込み(選択した施設だけ)・選択なし・未許可の施設は選べない
  assert.deepEqual(flat(await week("x1", W1[0], { facilityFilter: { mode: "selected", facilityIds: [] } })), []);
  await assert.rejects(week("x1", W1[0], { facilityFilter: { mode: "selected", facilityIds: ["fB"] } }), (e) => e.code === "invalid-argument");
  // 入力: 月曜でない・形式が違う・余分な項目
  for (const ws of [W1[1], "2026/11/02", "2026-02-30", undefined]) await assert.rejects(week("x1", ws), (e) => e.code === "invalid-argument", String(ws));
  await assert.rejects(api("x1", "week", { weekStart: W1[0], facilityFilter: { mode: "all" }, from: "x" }), (e) => e.code === "invalid-argument");
  // 許可の取消の後は出ない(索引が残っていても、毎回認可する)
  await revoke("adminA", "fA", "dA1");
  assert.deepEqual(flat(await week("x1", W1[0])), []);
  // 機能の停止中は拒否
  enabled.v = false;
  await assert.rejects(week("x1", W1[0]), (e) => e.code === "failed-precondition");
  enabled.v = true;
  // 週表示より前に作った受信の索引(手術日なし)は、作り直し(索引の再処理)で補う
  await grant("adminA", "fA", "dA1");
  const o2 = await placeOrder("fA", "ordA", [line({ dealerId: "dA1", surgeryDate: W1[3] })]);
  const rref = (await db.collection(`dealerCompanies/${C.X}/receipts`).where("sourceOrderId", "==", o2.orderId).get()).docs[0].ref;
  assert.deepEqual((await rref.get()).get("surgeryDates"), [W1[3]]);
  await rref.update({ surgeryDates: FieldValue.delete() });
  assert.deepEqual(flat(await week("x1", W1[0])), [], "手術日のない索引は週表示に出ない");
  await portal.indexOrder("fA", o2.orderId);
  assert.deepEqual((await rref.get()).get("surgeryDates"), [W1[3]]);
  assert.deepEqual(flat(await week("x1", W1[0])).map(x => x[1]), [o2.orderNumber]);
  assert.deepEqual(surgeryDatesOf([{ surgeryDate: "2026-11-03" }, { surgeryDate: "2026-11-02" }, { surgeryDate: "2026-11-03" }, { surgeryDate: "bad" }, null]), ["2026-11-02", "2026-11-03"]);
});

test("役割の規則(純粋関数): 会社管理者は自社の全員(自分の役割・無効化を除く)。支店管理者は自分の支店の閲覧者だけ。昇格・任命・他の支店への異動は不可。閲覧者は操作できない", () => {
  const P = managerPolicyError;
  const CA = { role: "companyAdmin", branchId: "t" }, BA = { role: "branchAdmin", branchId: "t" };
  // 会社管理者
  assert.equal(P(CA, { targetRole: "reader", nextRole: "companyAdmin", targetBranchId: "o" }), null, "他の支店の閲覧者を会社管理者に");
  assert.equal(P(CA, { targetRole: "companyAdmin", nextRole: "branchAdmin" }), null, "別の会社管理者の降格");
  assert.equal(P(CA, { targetRole: "branchAdmin", statusChange: true, targetBranchId: "o", nextBranchId: "t" }), null);
  assert.match(P(CA, { self: true, targetRole: "companyAdmin", nextRole: "branchAdmin" }), /自分自身/);
  assert.match(P(CA, { self: true, targetRole: "companyAdmin", statusChange: true }), /自分自身/);
  assert.equal(P(CA, { self: true, targetRole: "companyAdmin", targetBranchId: "t", nextBranchId: "o" }), null, "自分の氏名・支店の変更");
  // 支店管理者: 自分の支店の閲覧者
  assert.equal(P(BA, { targetRole: "reader", targetBranchId: "t" }), null, "自分の支店の閲覧者の招待・氏名・担当施設");
  assert.equal(P(BA, { targetRole: "reader", targetBranchId: "t", statusChange: true }), null, "無効化・再有効化");
  assert.equal(P(BA, { self: true, targetRole: "branchAdmin", targetBranchId: "t" }), null, "自分の氏名・担当施設");
  // 支店管理者: できないこと
  assert.match(P(BA, { targetRole: "reader", nextRole: "companyAdmin", targetBranchId: "t" }), /会社管理者の任命/);
  assert.match(P(BA, { targetRole: "companyAdmin", targetBranchId: "t" }), /会社管理者の任命/);
  assert.match(P(BA, { targetRole: "reader", nextRole: "branchAdmin", targetBranchId: "t" }), /支店管理者の任命/);
  assert.match(P(BA, { targetRole: "branchAdmin", targetBranchId: "t" }), /支店管理者の任命/, "同じ支店の別の支店管理者");
  assert.match(P(BA, { targetRole: "branchAdmin", nextRole: "reader", targetBranchId: "t" }), /支店管理者の任命/);
  assert.match(P(BA, { targetRole: "reader", targetBranchId: "o" }), /自分の支店の担当者だけ/, "他の支店の閲覧者");
  assert.match(P(BA, { targetRole: "reader", targetBranchId: null }), /自分の支店の担当者だけ/, "支店未設定の閲覧者");
  assert.match(P(BA, { targetRole: "reader", targetBranchId: "t", nextBranchId: "o" }), /自分の支店の担当者だけ/, "他の支店への異動");
  assert.match(P(BA, { targetRole: "reader", targetBranchId: "o", nextBranchId: "t" }), /自分の支店の担当者だけ/, "他の支店からの引き抜き");
  assert.match(P(BA, { self: true, targetRole: "branchAdmin", targetBranchId: "t", statusChange: true }), /自分自身/);
  assert.match(P(BA, { self: true, targetRole: "branchAdmin", targetBranchId: "t", nextBranchId: "o" }), /自分の支店の担当者だけ/, "自分の異動");
  assert.match(P({ role: "branchAdmin", branchId: null }, { targetRole: "reader", targetBranchId: null }), /所属支店が設定されていない/);
  assert.match(P({ role: "reader", branchId: "t" }, { targetRole: "reader", targetBranchId: "t" }), /会社管理者・支店管理者のみ/);
  assert.match(P(null, { targetRole: "reader" }), /会社管理者・支店管理者のみ/);
});

/**
 * 架空の せんじゅメディカル(東京支店・大阪支店)。会社管理者 sadm(東京)、支店管理者 tadm(東京)・tadm2(東京)・oadm(大阪)、閲覧者 r1(東京)・r2(大阪)。
 * 閲覧の許可: B眼科の発注先 dB2(関連付け+許可)。A眼科の発注先 dA3 は関連付けだけ(許可前)
 */
async function setupSenju() {
  const S = (await op("createCompany", { name: "せんじゅメディカル", requestId: crypto.randomUUID() })).companyId;
  const tokyo = (await op("upsertBranch", { companyId: S, name: "東京支店" })).branchId;
  await op("inviteStaff", { companyId: S, email: "sadm@corp.example.jp", name: "東京の責任者", role: "companyAdmin", branchId: tokyo });
  await join("sadm");
  const m = (uid, action, data = {}) => api(uid, action, data);
  const osaka = (await m("sadm", "manageBranch", { name: "大阪支店" })).branchId;
  for (const [u, role, b] of [["tadm", "branchAdmin", tokyo], ["tadm2", "branchAdmin", tokyo], ["oadm", "branchAdmin", osaka], ["r1", "reader", tokyo], ["r2", "reader", osaka]]) {
    await m("sadm", "manageInvite", { email: `${u}@corp.example.jp`, name: u, role, branchId: b });
    await join(u);
  }
  await db.doc("facilities/fB/facilityDealers/dB2").set({ facilityId: "fB", name: "せんじゅメディカル", orderEmails: ["order-s@s.example.jp"] });
  await db.doc("facilities/fA/facilityDealers/dA3").set({ facilityId: "fA", name: "せんじゅメディカルA", orderEmails: ["order-sa@s.example.jp"] });
  await op("proposeLink", { facilityId: "fB", localDealerId: "dB2", companyId: S });
  await op("proposeLink", { facilityId: "fA", localDealerId: "dA3", companyId: S });
  await grant("adminB", "fB", "dB2");
  return { S, tokyo, osaka, m, sidOf: (uid) => sid(S, uid) };
}
const deniedBy = (p, re) => assert.rejects(p, (e) => e.code === "permission-denied" && (!re || re.test(e.message)), String(re));

test("会社管理者: 自社の全支店・担当者・支店・担当施設を管理できる。自分の役割・無効化と最後の会社管理者は守る。担当施設は会社に関連付けられ許可された施設だけ", async () => {
  const { S, tokyo, osaka, m, sidOf } = await setupSenju();
  const view = async (uid = "sadm") => Object.fromEntries((await m(uid, "manage")).staff.map(x => [x.email.split("@")[0], [x.role, x.status, x.branchId]]));
  let ov = await m("sadm", "manage");
  assert.deepEqual([ov.me, ov.branches.map(b => b.name).sort()], [{ staffId: sidOf("sadm"), role: "companyAdmin", branchId: tokyo }, ["大阪支店", "東京支店"].sort()]);
  assert.deepEqual(Object.keys(ov.staff[0]).sort(), ["branchId", "email", "facilityIds", "name", "role", "staffId", "status", "verified"], "ログイン方法の内部の ID は返さない");
  assert.deepEqual(ov.facilities, [{ facilityId: "fB", name: "B眼科" }], "担当施設の候補は許可された施設だけ(関連付けだけの A眼科・他社の施設は出さない)");
  assert.deepEqual(Object.keys(await view()).sort(), ["oadm", "r1", "r2", "sadm", "tadm", "tadm2"]);
  // 他の支店を含む全員: 異動・昇格・降格・無効化・再有効化、支店管理者の任命・解除
  await m("sadm", "manageUpdateStaff", { staffId: sidOf("r1"), branchId: osaka });
  await m("sadm", "manageUpdateStaff", { staffId: sidOf("r2"), role: "branchAdmin" });
  await m("sadm", "manageUpdateStaff", { staffId: sidOf("r2"), role: "reader" });
  await m("sadm", "manageUpdateStaff", { staffId: sidOf("oadm"), status: "disabled" });
  await m("sadm", "manageUpdateStaff", { staffId: sidOf("oadm"), status: "active" });
  await join("oadm");   // 有効に戻した後は本人確認をし直す
  assert.deepEqual([(await view()).r1, (await view()).r2], [["reader", "active", osaka], ["reader", "active", osaka]]);
  // 担当施設: 許可された施設だけ。関連付けだけの施設・他社の施設・存在しない施設は断る
  await m("sadm", "manageUpdateStaff", { staffId: sidOf("r1"), facilityIds: ["fB"] });
  assert.deepEqual((await m("sadm", "manage")).staff.find(x => x.staffId === sidOf("r1")).facilityIds, ["fB"]);
  for (const ids of [["fA"], ["fB", "fA"], ["fX"]]) await rejects(m("sadm", "manageUpdateStaff", { staffId: sidOf("r1"), facilityIds: ids }), "invalid-argument");
  await rejects(m("sadm", "manageUpdateStaff", { staffId: sidOf("r1"), facilityIds: "fB" }), "invalid-argument");
  assert.equal((await m("r1", "context")).facilities.find(f => f.id === "fB").assigned, true, "本人の受注一覧の初期選択に反映");
  await m("sadm", "manageUpdateStaff", { staffId: sidOf("sadm"), facilityIds: ["fB"], name: "東京の責任者(改)" });   // 自分の氏名・担当施設
  // 自分の役割・無効化は不可。新しい会社管理者を任命した後は、別の会社管理者として降格できる
  await deniedBy(m("sadm", "manageUpdateStaff", { staffId: sidOf("sadm"), role: "branchAdmin" }), /自分自身/);
  await deniedBy(m("sadm", "manageUpdateStaff", { staffId: sidOf("sadm"), status: "disabled" }), /自分自身/);
  await m("sadm", "manageUpdateStaff", { staffId: sidOf("oadm"), role: "companyAdmin" });
  await m("oadm", "manageUpdateStaff", { staffId: sidOf("sadm"), role: "branchAdmin" });
  assert.equal((await m("sadm", "manage")).me.role, "branchAdmin", "再ログイン・再確認なしで、支店管理者として使える");
  await deniedBy(m("sadm", "manageBranch", { name: "x支店" }), /会社管理者のみ/, "降格された元の会社管理者は支店を変えられない");
  // 支店: 所属する担当者がいれば無効にできない。いなければ無効にでき、無効の支店は選べない
  await assert.rejects(m("oadm", "manageBranch", { branchId: osaka, name: "大阪支店", status: "inactive" }), (e) => e.code === "failed-precondition" && /所属する担当者/.test(e.message));
  const nagoya = (await m("oadm", "manageBranch", { name: "名古屋支店" })).branchId;
  await m("oadm", "manageBranch", { branchId: nagoya, name: "名古屋支店", status: "inactive" });
  await rejects(m("oadm", "manageUpdateStaff", { staffId: sidOf("r1"), branchId: nagoya }), "invalid-argument");
  await m("oadm", "manageBranch", { branchId: osaka, name: "大阪支社" });
  assert.deepEqual((await m("oadm", "manage")).branches.map(b => [b.name, b.status]).sort(), [["名古屋支店", "inactive"], ["大阪支社", "active"], ["東京支店", "active"]].sort());
  // 招待の取消(会社管理者の招待も)
  await m("oadm", "manageInvite", { email: "nadm@corp.example.jp", name: "", role: "companyAdmin" });
  await m("oadm", "manageCancelInvite", { staffId: sidOf("nadm") });
  // 最後の会社管理者: 運営者は例外(復旧・会社の停止など)
  await op("updateStaff", { companyId: S, staffId: sidOf("oadm"), role: "reader" });
  assert.equal((await view("tadm")).tadm[0], "branchAdmin");
  // 監査の記録: ディーラーの操作は担当者 ID と役割、運営者の操作は operator
  const logs = (await db.collection("dealerPortalAuditLogs").where("companyId", "==", S).get()).docs.map(d => d.data());
  assert.ok(logs.some(l => l.action === "staff.update" && l.actorStaffId === sidOf("sadm") && l.actorRole === "companyAdmin" && l.fields.includes("facilityAssignments") && l.operator === false));
  assert.ok(logs.some(l => l.action === "staff.update" && l.actorStaffId === sidOf("oadm") && l.actorRole === "companyAdmin" && l.role === "branchAdmin"));
  assert.ok(logs.some(l => l.action === "staff.invite" && l.operator === true && l.role === "companyAdmin"));
});

test("支店管理者: 自分の支店の閲覧者だけを管理できる。支店・支店管理者・会社管理者・他の支店には触れない。一覧も自分の支店だけ", async () => {
  const { S, tokyo, osaka, m, sidOf } = await setupSenju();
  // 一覧: 自分の支店の担当者(会社管理者を含む)と自分だけ。支店は自分の支店だけ(他の支店の名称・担当者は返さない)
  let ov = await m("tadm", "manage");
  assert.deepEqual(ov.me, { staffId: sidOf("tadm"), role: "branchAdmin", branchId: tokyo });
  assert.deepEqual(ov.branches.map(b => b.branchId), [tokyo]);
  assert.deepEqual(ov.staff.map(x => x.email.split("@")[0]).sort(), ["r1", "sadm", "tadm", "tadm2"]);
  assert.deepEqual(ov.facilities, [{ facilityId: "fB", name: "B眼科" }]);
  // できること: 自分の支店への閲覧者の招待・取消、閲覧者の氏名・担当施設・無効化・再有効化、自分の氏名・担当施設
  await m("tadm", "manageInvite", { email: "r3@corp.example.jp", name: "閲覧者3", role: "reader", branchId: tokyo });
  await m("tadm", "manageCancelInvite", { staffId: sidOf("r3") });
  await m("tadm", "manageInvite", { email: "r3@corp.example.jp", name: "閲覧者3", role: "reader", branchId: tokyo });   // 取り消した招待は新しい招待と同じ
  await m("tadm", "manageUpdateStaff", { staffId: sidOf("r1"), name: "閲覧者1(改)", facilityIds: ["fB"] });
  await m("tadm", "manageUpdateStaff", { staffId: sidOf("r1"), branchId: tokyo });   // 同じ支店のまま(変更なし)は可
  await m("tadm", "manageUpdateStaff", { staffId: sidOf("r1"), status: "disabled" });
  await assert.rejects(m("r1", "context"), needsVerify, "無効化した閲覧者はすぐに使えない");
  await m("tadm", "manageUpdateStaff", { staffId: sidOf("r1"), status: "active" });
  await join("r1");   // 有効に戻した後は本人確認をし直す
  await m("tadm", "manageUpdateStaff", { staffId: sidOf("tadm"), name: "東京の支店管理者(改)", facilityIds: [] });
  // 権限の昇格: 会社管理者・支店管理者への任命・招待はできない
  await deniedBy(m("tadm", "manageInvite", { email: "x@corp.example.jp", name: "", role: "companyAdmin", branchId: tokyo }), /会社管理者の任命/);
  await deniedBy(m("tadm", "manageInvite", { email: "x@corp.example.jp", name: "", role: "branchAdmin", branchId: tokyo }), /支店管理者の任命/);
  await deniedBy(m("tadm", "manageUpdateStaff", { staffId: sidOf("r1"), role: "companyAdmin" }), /会社管理者の任命/);
  await deniedBy(m("tadm", "manageUpdateStaff", { staffId: sidOf("r1"), role: "branchAdmin" }), /支店管理者の任命/);
  // 同じ支店の別の支店管理者・会社管理者: 解除・無効化・編集はできない
  await deniedBy(m("tadm", "manageUpdateStaff", { staffId: sidOf("tadm2"), role: "reader" }), /支店管理者の任命/);
  await deniedBy(m("tadm", "manageUpdateStaff", { staffId: sidOf("tadm2"), status: "disabled" }), /支店管理者の任命/);
  await deniedBy(m("tadm", "manageUpdateStaff", { staffId: sidOf("tadm2"), name: "変更", facilityIds: ["fB"] }), /支店管理者の任命/);
  await deniedBy(m("tadm", "manageUpdateStaff", { staffId: sidOf("sadm"), name: "変更" }), /会社管理者の任命/);
  // 他の支店: 招待・異動・引き抜き・編集・無効化・取消はできない
  await deniedBy(m("tadm", "manageInvite", { email: "o9@corp.example.jp", name: "", role: "reader", branchId: osaka }), /自分の支店の担当者だけ/);
  await deniedBy(m("tadm", "manageInvite", { email: "o9@corp.example.jp", name: "", role: "reader" }), /自分の支店の担当者だけ/, "支店未設定での招待");
  await deniedBy(m("tadm", "manageUpdateStaff", { staffId: sidOf("r1"), branchId: osaka }), /自分の支店の担当者だけ/);
  await deniedBy(m("tadm", "manageUpdateStaff", { staffId: sidOf("r1"), branchId: null }), /自分の支店の担当者だけ/);
  await deniedBy(m("tadm", "manageUpdateStaff", { staffId: sidOf("r2"), branchId: tokyo }), /自分の支店の担当者だけ/);
  await deniedBy(m("tadm", "manageUpdateStaff", { staffId: sidOf("r2"), name: "変更" }), /自分の支店の担当者だけ/);
  await deniedBy(m("tadm", "manageUpdateStaff", { staffId: sidOf("r2"), status: "disabled" }), /自分の支店の担当者だけ/);
  await deniedBy(m("tadm", "manageUpdateStaff", { staffId: sidOf("r2"), facilityIds: ["fB"] }), /自分の支店の担当者だけ/);
  await m("sadm", "manageInvite", { email: "p1@corp.example.jp", name: "", role: "reader", branchId: osaka });
  await deniedBy(m("tadm", "manageCancelInvite", { staffId: sidOf("p1") }), /自分の支店の担当者だけ/);
  // 他の支店の担当者(参加待ち・無効・有効)のメール: 状態・支店を示さない同じ文言で断る(Low-1)
  const generic = /^このメールアドレスは招待できません/;
  await deniedBy(m("tadm", "manageInvite", { email: "p1@corp.example.jp", name: "", role: "reader", branchId: tokyo }), generic, "他の支店の参加待ちの上書き");
  await deniedBy(m("tadm", "manageInvite", { email: "r2@corp.example.jp", name: "", role: "reader", branchId: tokyo }), generic, "他の支店の有効な担当者(「すでに参加」を返さない)");
  await deniedBy(m("tadm", "manageInvite", { email: "oadm@corp.example.jp", name: "", role: "reader", branchId: tokyo }), generic, "他の支店の支店管理者");
  await assert.rejects(m("tadm", "manageInvite", { email: "r1@corp.example.jp", name: "", role: "reader", branchId: tokyo }), (e) => e.code === "failed-precondition" && /すでに参加/.test(e.message), "自分の支店の有効な担当者は従来の文言");
  await m("sadm", "manageUpdateStaff", { staffId: sidOf("r2"), status: "disabled" });
  await deniedBy(m("tadm", "manageInvite", { email: "r2@corp.example.jp", name: "", role: "reader", branchId: tokyo }), generic, "他の支店の無効の担当者の再招待");
  await m("sadm", "manageInvite", { email: "c1@corp.example.jp", name: "", role: "companyAdmin", branchId: osaka });
  await deniedBy(m("tadm", "manageCancelInvite", { staffId: sidOf("c1") }), /会社管理者の任命/);
  await m("sadm", "manageCancelInvite", { staffId: sidOf("c1") });
  await m("tadm", "manageInvite", { email: "c1@corp.example.jp", name: "", role: "reader", branchId: tokyo });   // 取り消された招待は新しい招待(閲覧者として)
  // 取り消した招待からの招待は担当施設を引き継がない(Low-2)。無効化→再招待は従来どおり残す
  await m("sadm", "manageUpdateStaff", { staffId: sidOf("r2"), facilityIds: ["fB"] });
  await m("sadm", "manageInvite", { email: "r2@corp.example.jp", name: "", role: "reader", branchId: osaka });   // 無効の r2 を再招待(担当施設は残る)
  assert.deepEqual((await db.doc(`dealerStaff/${sidOf("r2")}`).get()).get("facilityAssignments"), ["fB"], "無効化からの再招待は担当施設を残す");
  await m("sadm", "manageCancelInvite", { staffId: sidOf("r2") });
  await m("tadm", "manageInvite", { email: "r2@corp.example.jp", name: "", role: "reader", branchId: tokyo });   // 取り消された招待は新しい招待
  assert.deepEqual((await db.doc(`dealerStaff/${sidOf("r2")}`).get()).get("facilityAssignments"), [], "取り消しからの招待は担当施設を引き継がない");
  assert.deepEqual((await m("tadm", "manage")).staff.find(x => x.staffId === sidOf("r2")).facilityIds, []);
  // 自分自身: 無効化・降格・異動はできない
  await deniedBy(m("tadm", "manageUpdateStaff", { staffId: sidOf("tadm"), status: "disabled" }), /自分自身/);
  await deniedBy(m("tadm", "manageUpdateStaff", { staffId: sidOf("tadm"), role: "reader" }), /自分自身/);
  await deniedBy(m("tadm", "manageUpdateStaff", { staffId: sidOf("tadm"), branchId: osaka }), /自分の支店の担当者だけ/);
  // 支店の追加・名称変更・無効化は会社管理者だけ
  for (const data of [{ name: "名古屋支店" }, { branchId: tokyo, name: "東京支社" }, { branchId: osaka, name: "大阪支店", status: "inactive" }]) {
    await deniedBy(m("tadm", "manageBranch", data), /会社管理者のみ/);
  }
  // 会社管理者による異動・降格・所属支店の解除は、次の操作からすぐに反映
  await m("sadm", "manageUpdateStaff", { staffId: sidOf("tadm"), branchId: osaka });
  ov = await m("tadm", "manage");
  assert.deepEqual([ov.branches.map(b => b.branchId), ov.staff.map(x => x.email.split("@")[0]).sort()], [[osaka], ["oadm", "p1", "tadm"].sort()]);
  await deniedBy(m("tadm", "manageUpdateStaff", { staffId: sidOf("r1"), name: "x" }), /自分の支店の担当者だけ/);
  await m("sadm", "manageUpdateStaff", { staffId: sidOf("tadm"), branchId: null });
  ov = await m("tadm", "manage");
  assert.deepEqual([ov.branches, ov.staff.map(x => x.staffId)], [[], [sidOf("tadm")]]);
  await deniedBy(m("tadm", "manageInvite", { email: "z@corp.example.jp", name: "", role: "reader" }), /所属支店が設定されていない/);
  await m("sadm", "manageUpdateStaff", { staffId: sidOf("tadm"), role: "reader", branchId: tokyo });
  await deniedBy(m("tadm", "manage"), /会社管理者・支店管理者のみ/);
  // 閲覧者: 管理の操作はできない
  for (const [action, data] of [["manage", {}], ["manageBranch", { name: "x支店" }], ["manageInvite", { email: "z@corp.example.jp", name: "", role: "reader", branchId: tokyo }],
    ["manageUpdateStaff", { staffId: sidOf("r1"), name: "x" }], ["manageCancelInvite", { staffId: sidOf("r3") }]]) await deniedBy(m("r1", action, data), /会社管理者・支店管理者のみ/);
  // 監査の記録: 支店管理者の操作は担当者 ID と役割
  const logs = (await db.collection("dealerPortalAuditLogs").where("companyId", "==", S).get()).docs.map(d => d.data());
  assert.ok(logs.some(l => l.action === "staff.invite" && l.actorStaffId === sidOf("tadm") && l.actorRole === "branchAdmin" && l.operator === false));
});

test("会社管理者・支店管理者: 他社の担当者・支店は操作できない。閲覧は会社単位のまま(施設の許可が必須。役割・支店で広がらない)", async () => {
  const { S, tokyo, m, sidOf } = await setupSenju();
  // 他社(エックス商事の会社管理者 x1): 会社 ID・担当者 ID を指定しても操作できない
  await deniedBy(m("x1", "manage", { companyId: S }));
  await assert.rejects(m("x1", "manageUpdateStaff", { staffId: sidOf("r1"), status: "disabled" }), (e) => e.code === "not-found" || e.code === "permission-denied");
  await assert.rejects(m("x1", "manageUpdateStaff", { staffId: sidOf("r1"), facilityIds: [] }), (e) => e.code === "not-found" || e.code === "permission-denied");
  await assert.rejects(m("x1", "manageCancelInvite", { staffId: sidOf("r1") }), (e) => e.code === "not-found" || e.code === "permission-denied" || e.code === "failed-precondition");
  await assert.rejects(m("x1", "manageBranch", { branchId: tokyo, name: "乗っ取り", status: "inactive" }), (e) => e.code === "not-found");
  // 他社の担当者を自社に招待しても、他社の担当者の文書(会社×メール)は変わらない
  await m("x1", "manageInvite", { email: "r1@corp.example.jp", name: "", role: "reader" });
  const r1 = (await db.doc(`dealerStaff/${sidOf("r1")}`).get()).data();
  assert.deepEqual([r1.companyId, r1.status, r1.branchId], [S, "active", tokyo]);
  // 担当施設: 他社に許可された施設(エックス商事の A眼科)は選べない
  await grant("adminA", "fA", "dA1");
  await rejects(m("sadm", "manageUpdateStaff", { staffId: sidOf("r1"), facilityIds: ["fA"] }), "invalid-argument");
  assert.deepEqual((await m("x1", "manage")).facilities.map(f => f.facilityId), ["fA"]);
  // 閲覧: 許可された施設(B眼科)の自社宛ての注文だけ。役割・支店に関係なく会社単位。許可前の A眼科(dA3)・他社宛ては見えない
  await placeOrder("fB", "ordB", [line({ dealerId: "dB2" })]);
  await placeOrder("fA", "ordA", [line({ dealerId: "dA3" }), line({ dealerId: "dA1", power: "+21.0D" })]);
  for (const uid of ["sadm", "tadm", "oadm", "r1", "r2"]) assert.deepEqual((await list(uid)).items.map(i => i.facilityId), ["fB"], uid);
  assert.deepEqual((await list("x1")).items.map(i => i.facilityId), ["fA"]);
  // 施設が取り消すと、会社管理者・担当施設の設定に関係なく見えない
  await m("sadm", "manageUpdateStaff", { staffId: sidOf("r1"), facilityIds: ["fB"] });
  await revoke("adminB", "fB", "dB2");
  for (const uid of ["sadm", "r1"]) assert.deepEqual((await list(uid)).items, [], uid);
  assert.deepEqual((await m("sadm", "manage")).facilities, [], "取消後の施設は担当施設の候補から外れる");
  // 機能の停止中は管理もできない
  enabled.v = false;
  await rejects(m("sadm", "manage"), "failed-precondition");
  enabled.v = true;
});

test("会社管理者・支店管理者の招待の上限: 24時間の招待の数を超えると断る(運営者は対象外)", async () => {
  const S = (await op("createCompany", { name: "上限テスト", requestId: crypto.randomUUID() })).companyId;
  const b = (await op("upsertBranch", { companyId: S, name: "本店" })).branchId;
  await op("inviteStaff", { companyId: S, email: "lim@corp.example.jp", name: "", role: "branchAdmin", branchId: b });
  await join("lim");
  let n = 0, err = null;
  for (; n < 40; n++) {
    try { await api("lim", "manageInvite", { email: `v${n}@corp.example.jp`, name: "", role: "reader", branchId: b }); }
    catch (e) { err = e; break; }
  }
  assert.ok(err && err.code === "resource-exhausted" && /24時間/.test(err.message), String(err && err.message));
  assert.equal(n, 29, "運営者の招待(1件)を含めて24時間で30件まで");
  await op("inviteStaff", { companyId: S, email: "opinvite@corp.example.jp", name: "", role: "reader" });   // 運営者は対象外
});

test("試験モードの設定の解釈(純粋関数): UID はカンマ区切りの英数字だけ。期限はタイムゾーン付きの ISO 8601 だけ(空・不正は閉じる)", () => {
  assert.deepEqual(parseTestAccess(" opA1, bad-uid ,opB2,,", "2026-11-08T18:00:00+09:00"), { uids: ["opA1", "opB2"], untilMs: Date.parse("2026-11-08T09:00:00Z") });
  assert.equal(parseTestAccess("opA1", "2026-11-08T09:00:00Z").untilMs, Date.parse("2026-11-08T09:00:00Z"));
  for (const bad of ["", "2026-11-08", "2026-11-08T18:00:00", "tomorrow", "2026-13-40T99:00:00+09:00"]) assert.equal(parseTestAccess("opA1", bad).untilMs, null, bad);
  assert.deepEqual(parseTestAccess("", "").uids, []);
  assert.equal(TEST_MODE_MAX_MS, 14 * 24 * 3600 * 1000);
});

/**
 * 運営者の試験モード(機能は停止のまま)。試験の UID・期限・いまも有効な運営者(ID トークンとユーザー記録)の3つを満たすときだけ、
 * 試験用の会社(testOnly)のログイン・参加・担当者の管理を使える。注文の閲覧・施設の許可・索引は停止のまま。確認コードは運営者本人だけに送る
 */
async function setupTestMode() {
  const cfg = { uids: ["opt1"], untilMs: Date.now() + 24 * 3600 * 1000 };
  const operators = new Set(["opt1", "opt2"]);
  const svc = createDealerPortalService({ db, FieldValue, Timestamp, FieldPath, isEnabled: () => false, now: () => clock.t ?? Date.now(),
    testAccess: () => cfg, isCurrentOperator: async (uid) => operators.has(uid), sendJoinCode: async (m) => { sentCodes.push(m); return sendResult.v; } });
  const opAuth = (uid, over = {}) => auth(uid, { email: `${uid}@corp.example.jp`, platformAdmin: true, ...over });
  /** 試験モードのサービスを担当者として呼ぶ(確認済みの端末の値は devices に保持) */
  const call = async (a, action, data = {}) => {
    const r = await svc.portal({ auth: a, data: { action, ...data, ...(devices.get(a.uid) ? { deviceToken: devices.get(a.uid) } : {}) } });
    if (r && typeof r.deviceToken === "string") devices.set(a.uid, r.deviceToken);
    if (action === "sendCode") for (const j of (await db.collection("dealerAuthCodeJobs").get()).docs) await svc.deliverCodeJob(j.id);
    return r;
  };
  const T = (await op("createCompany", { name: "試験商事", requestId: crypto.randomUUID(), testOnly: true })).companyId;
  return { cfg, operators, svc, opAuth, call, T };
}
const closed = (p, what) => assert.rejects(p, (e) => e.code === "failed-precondition" && /現在ご利用いただけません/.test(e.message), what);

test("試験モード: 条件を満たす運営者は、試験用の会社だけでログイン・参加・担当者の管理ができる。注文の閲覧・担当施設は停止のまま。確認コードは本人に試験用の会社の分だけ", async () => {
  const { svc, opAuth, call, T } = await setupTestMode();
  assert.equal((await db.doc(`dealerCompanies/${T}`).get()).get("name"), "【試験】試験商事");
  assert.equal((await db.doc(`dealerCompanies/${T}`).get()).get("testOnly"), true);
  // 運営者を試験用の会社(会社管理者)と、実際の会社(エックス商事。閲覧者)の両方に招待
  await op("inviteStaff", { companyId: T, email: "opt1@corp.example.jp", name: "運営者", role: "companyAdmin" });
  await op("inviteStaff", { companyId: C.X, email: "opt1@corp.example.jp", name: "運営者", role: "reader" });
  await resetCodes();
  const before = sentCodes.length;
  await call(opAuth("opt1"), "sendCode");
  const mails = sentCodes.slice(before);
  assert.equal(mails.length, 1);
  assert.deepEqual([mails[0].to, mails[0].companyName], ["opt1@corp.example.jp", "【試験】試験商事"], "本人に、試験用の会社の分だけ");
  const v = await call(opAuth("opt1"), "verifyCode", { code: mails[0].code });
  assert.deepEqual([v.companies, v.joined], [1, 1]);
  assert.equal((await db.doc(`dealerStaff/${sid(C.X, "opt1")}`).get()).get("status"), "invited", "実際の会社の招待は承諾しない");
  assert.deepEqual((await call(opAuth("opt1"), "companies")).companies.map(c => c.companyId), [T]);
  const ctx = await call(opAuth("opt1"), "context", { companyId: T });
  assert.deepEqual([ctx.testMode, ctx.facilities, ctx.me.role], [true, [], "companyAdmin"]);
  await rejects(call(opAuth("opt1"), "context", { companyId: C.X }), "permission-denied");
  // 担当者の管理(試験用の会社の中だけ)
  const b = (await call(opAuth("opt1"), "manageBranch", { companyId: T, name: "試験支店" })).branchId;
  await call(opAuth("opt1"), "manageInvite", { companyId: T, email: "opt2@corp.example.jp", name: "", role: "reader", branchId: b });
  const ov = await call(opAuth("opt1"), "manage", { companyId: T });
  assert.deepEqual([ov.facilities, ov.staff.map(s => s.email).sort()], [[], ["opt1@corp.example.jp", "opt2@corp.example.jp"]]);
  // 注文の閲覧・担当施設は試験モードでも停止(停止中と同じ応答)
  for (const [action, data] of [["list", range()], ["week", { weekStart: "2026-11-02", facilityFilter: { mode: "all" } }], ["get", { receiptId: "rcp-x" }], ["setAssignments", { facilityIds: [] }]]) {
    await closed(call(opAuth("opt1"), action, { companyId: T, ...data }), action);
  }
  // 施設の閲覧の許可・受信の索引も停止のまま
  await closed(svc.facility({ auth: auth("adminA"), data: { action: "grant", facilityId: "fA", localDealerId: "dA1", revision: await revOf("fA", "dA1") } }), "grant");
  assert.equal((await svc.indexOrder("fA", "any")).disabled, true);
  // 監査の記録・注文メールの outbox に試験の操作は注文を作らない
  assert.equal((await db.collection("orders").get()).size + (await db.collectionGroup("orders").get()).size, 0, "注文は作られない");
});

test("試験モードの拒否: 一般の利用者・試験の UID 以外・トークンの運営者の印がない・権限を失った運営者・期限切れ・期限が長すぎる・設定なしは、停止中と同じ応答(確認コードも送らない)", async () => {
  const { cfg, operators, svc, opAuth, call, T } = await setupTestMode();
  await op("inviteStaff", { companyId: T, email: "opt1@corp.example.jp", name: "", role: "companyAdmin" });
  await op("inviteStaff", { companyId: T, email: "opt2@corp.example.jp", name: "", role: "companyAdmin" });
  await op("inviteStaff", { companyId: T, email: "x9@corp.example.jp", name: "", role: "reader" });
  // 一般の利用者(実際の会社の担当者・試験用の会社に招待された一般の人)
  for (const a of [staffAuth("x1"), staffAuth("x9")]) for (const action of ["companies", "sendCode", "context", "manage"]) await closed(call(a, action), `${a.uid} ${action}`);
  // 運営者でも試験の UID にない(opt2)
  await closed(call(opAuth("opt2"), "sendCode"), "リスト外の運営者");
  // 試験の UID でも、ID トークンに運営者の印がない
  await closed(call(auth("opt1", { email: "opt1@corp.example.jp" }), "sendCode"), "トークンの印なし");
  // 参加まで済ませてから、条件を外す
  await resetCodes();
  const before = sentCodes.length;
  await call(opAuth("opt1"), "sendCode");
  await call(opAuth("opt1"), "verifyCode", { code: sentCodes.slice(before).at(-1).code });
  assert.equal((await call(opAuth("opt1"), "manage", { companyId: T })).me.role, "companyAdmin");
  // 権限を失った運営者(ユーザー記録で確認。トークンにはまだ印が残っていても拒否)
  operators.delete("opt1");
  await closed(call(opAuth("opt1"), "manage", { companyId: T }), "権限を失った運営者");
  operators.add("opt1");
  // 運営者の確認に失敗したときも閉じる
  const svcErr = createDealerPortalService({ db, FieldValue, Timestamp, FieldPath, isEnabled: () => false, testAccess: () => cfg, isCurrentOperator: async () => { throw new Error("auth down"); } });
  await closed(svcErr.portal({ auth: opAuth("opt1"), data: { action: "manage", companyId: T, deviceToken: devices.get("opt1") } }), "確認の失敗");
  // 期限切れ・期限が長すぎる(14日を超える)・期限なし・UID なし
  for (const [u, until, what] of [[["opt1"], Date.now() - 1000, "期限切れ"], [["opt1"], Date.now() + 15 * 24 * 3600 * 1000, "期限が長すぎる"], [["opt1"], null, "期限なし"], [[], Date.now() + 3600 * 1000, "UID なし"]]) {
    cfg.uids = u; cfg.untilMs = until;
    await closed(call(opAuth("opt1"), "manage", { companyId: T }), what);
  }
  // 期限は時刻の経過でも閉じる(自動)
  cfg.uids = ["opt1"]; cfg.untilMs = Date.now() + 60 * 1000;
  assert.equal((await call(opAuth("opt1"), "manage", { companyId: T })).me.role, "companyAdmin");
  clock.t = Date.now() + 2 * 60 * 1000;
  await closed(call(opAuth("opt1"), "manage", { companyId: T }), "期限の経過");
  clock.t = null;
  // 確認コードの送信: 依頼の後に権限を失った・期限が過ぎたら送らない
  cfg.untilMs = Date.now() + 3600 * 1000;
  await resetCodes();
  const n0 = sentCodes.length;
  await svc.portal({ auth: opAuth("opt1"), data: { action: "sendCode" } });
  operators.delete("opt1");
  for (const j of (await db.collection("dealerAuthCodeJobs").get()).docs) await svc.deliverCodeJob(j.id);
  assert.equal(sentCodes.length, n0, "権限を失った後は送らない");
  operators.add("opt1");
  // 試験モードで依頼していない確認コード(機能の停止中の一般の依頼)は送らない
  await db.collection("dealerAuthChallenges").doc("c_manual").set({ targets: [{ companyId: T, staffId: sid(T, "x9"), authRevision: 1, status: "invited" }], testMode: false, uid: "x9", kind: "device", email: "x9@corp.example.jp", requestId: "r1", deliveryStatus: "queued" });
  const job = await db.collection("dealerAuthCodeJobs").add({ challengeId: "c_manual", requestId: "r1", expiresAtMs: Date.now() + 60000 });
  await svc.deliverCodeJob(job.id);
  assert.equal(sentCodes.length, n0);
});

test("会社名の変更(運営者): 会社 ID・担当者・支店・関連付けはそのまま。試験用の会社は【試験】と印を残す", async () => {
  const b = (await op("upsertBranch", { companyId: C.X, name: "本社" })).branchId;
  const before = (await op("overview")).companies.find(c => c.companyId === C.X);
  await op("updateCompany", { companyId: C.X, name: "エックス商事株式会社" });
  const after = (await op("overview")).companies.find(c => c.companyId === C.X);
  assert.equal(after.name, "エックス商事株式会社");
  assert.deepEqual([after.staff.map(s => s.staffId).sort(), after.branches.map(x => x.branchId), after.testOnly], [before.staff.map(s => s.staffId).sort(), [b], false]);
  assert.deepEqual((await op("overview")).facilities.find(f => f.facilityId === "fA").dealers.find(d => d.localDealerId === "dA1").link.companyId, C.X, "関連付けは同じ会社 ID のまま");
  assert.equal((await api("x1", "context", { companyId: C.X })).company.name, "エックス商事株式会社", "担当者の画面にも反映(ログインし直し不要)");
  const T = (await op("createCompany", { name: "試験商事", requestId: crypto.randomUUID(), testOnly: true })).companyId;
  for (const name of ["改名商事", "【試験】改名2"]) {
    await op("updateCompany", { companyId: T, name });
    const t = (await op("overview")).companies.find(c => c.companyId === T);
    assert.deepEqual([t.name, t.testOnly], [name.startsWith("【試験】") ? name : `【試験】${name}`, true]);
  }
});

test("会社の削除(運営者): 依存するデータが1件もない会社だけ。担当者(取消済みの招待を含む)・支店・関連付け・閲覧の許可・受信の記録があれば拒否し、何も消さない", async () => {
  const create = async (name, extra = {}) => (await op("createCompany", { name, requestId: crypto.randomUUID(), ...extra })).companyId;
  const exists = async (cid) => (await db.doc(`dealerCompanies/${cid}`).get()).exists;
  const blocked = async (cid, re, what) => {
    await assert.rejects(op("deleteCompany", { companyId: cid }), (e) => e.code === "failed-precondition" && re.test(e.message) && /会社を停止/.test(e.message), what);
    assert.equal(await exists(cid), true, `${what}: 削除されない`);
  };
  // 依存なし: 削除でき、一覧から消え、監査の記録は残る(試験用の会社も同じ)
  const E = await create("誤登録商事");
  const T = await create("試験の空き", { testOnly: true });
  for (const cid of [E, T]) {
    assert.deepEqual(await op("deleteCompany", { companyId: cid }), { ok: true });
    assert.equal(await exists(cid), false);
  }
  assert.equal((await op("overview")).companies.some(c => c.companyId === E || c.companyId === T), false);
  const logs = (await db.collection("dealerPortalAuditLogs").where("action", "==", "company.delete").get()).docs.map(d => d.data());
  assert.deepEqual(logs.map(l => [l.companyId, l.name, l.operator, l.testOnly === true]).sort(), [[E, "誤登録商事", true, false], [T, "【試験】試験の空き", true, true]].sort());
  await rejects(op("deleteCompany", { companyId: E }), "not-found");
  // 担当者: 参加済み(エックス商事)・参加待ち・取消済みの招待
  await blocked(C.X, /担当者/, "参加済みの担当者");
  const I = await create("招待中商事");
  await op("inviteStaff", { companyId: I, email: "inv@corp.example.jp", name: "", role: "reader" });
  await blocked(I, /担当者/, "参加待ち");
  await op("cancelInvitation", { companyId: I, staffId: sid(I, "inv") });
  await blocked(I, /担当者/, "取消済みの招待");
  // 支店(無効を含む)
  const B = await create("支店あり商事");
  const br = (await op("upsertBranch", { companyId: B, name: "本店" })).branchId;
  await op("upsertBranch", { companyId: B, branchId: br, name: "本店", status: "inactive" });
  await blocked(B, /支店/, "無効の支店");
  // 施設の発注先との関連付け(許可前)
  const L = await create("関連付け商事");
  await db.doc("facilities/fB/facilityDealers/dB9").set({ facilityId: "fB", name: "関連付けの窓口", orderEmails: ["l@l.example.jp"] });
  await op("proposeLink", { facilityId: "fB", localDealerId: "dB9", companyId: L });
  await blocked(L, /関連付け/, "関連付け(許可前)");
  // 閲覧の許可の記録(取消済み)と受信の記録: エックス商事とは別の会社で、記録だけを作って確かめる
  const G = await create("許可記録商事");
  await db.doc("dealerPortalGrants/dgr-test-revoked").set({ companyId: G, facilityId: "fA", localDealerId: "dZ", status: "revoked" });
  await blocked(G, /閲覧の許可/, "取消済みの許可の記録");
  const R = await create("受信記録商事");
  await db.doc(`dealerCompanies/${R}/receipts/rcp-test`).set({ facilityId: "fA", orderId: "o1" });
  await blocked(R, /注文の受信/, "受信の記録");
  // 運営者以外・不正な入力
  await rejects(portal.operator({ auth: auth("adminA"), data: { action: "deleteCompany", companyId: G } }), "permission-denied");
  await rejects(op("deleteCompany", { companyId: G, force: true }), "invalid-argument");
  await rejects(op("deleteCompany", { companyId: "../x" }), "invalid-argument");
  // ディーラーの担当者・施設の管理者の API には削除の操作はない
  await rejects(api("x1", "deleteCompany", { companyId: C.X }), "invalid-argument");
  assert.equal(await exists(C.X), true);
});

test("試験用の会社(testOnly): 施設の発注先との関連付け・閲覧の許可を拒否(機能の有効化後も)。印は作成時だけ・運営者だけが付けられ、変更・解除できない。名前の【試験】は残る", async () => {
  const { T } = await setupTestMode();
  // 関連付けの拒否(運営者でも)
  await assert.rejects(op("proposeLink", { facilityId: "fA", localDealerId: "dA1", companyId: T }), (e) => e.code === "failed-precondition" && /試験用の会社/.test(e.message));
  // 何らかの経緯で関連付けがあっても、閲覧の許可は拒否(機能が有効でも)
  await db.doc("facilities/fA/facilityDealers/dT1").set({ facilityId: "fA", name: "試験の窓口", orderEmails: ["t@t.example.jp"] });
  await db.doc("facilities/fA/dealerPortalLinks/dT1").set({ companyId: T, status: "proposed", currentGrantId: null, revision: 1 });
  await assert.rejects(grant("adminA", "fA", "dT1"), (e) => e.code === "failed-precondition");
  assert.equal((await db.collection("dealerPortalGrants").where("companyId", "==", T).get()).size, 0);
  // 印の変更・解除: 運営者の API は受け付けない。不正な値の作成も拒否
  await rejects(op("updateCompany", { companyId: T, testOnly: false }), "invalid-argument");
  await rejects(op("createCompany", { name: "x", requestId: crypto.randomUUID(), testOnly: "yes" }), "invalid-argument");
  await op("updateCompany", { companyId: T, name: "改名商事" });
  assert.deepEqual([(await db.doc(`dealerCompanies/${T}`).get()).get("name"), (await db.doc(`dealerCompanies/${T}`).get()).get("testOnly")], ["【試験】改名商事", true]);
  // 一般の会社は印なし・従来どおり
  assert.equal((await db.doc(`dealerCompanies/${C.X}`).get()).get("testOnly"), undefined);
  // 運営者以外は会社を作れない(印も付けられない)
  await rejects(portal.operator({ auth: auth("adminA"), data: { action: "createCompany", name: "x", requestId: crypto.randomUUID(), testOnly: true } }), "permission-denied");
  // クライアント(運営者を含む)は会社の文書を直接読み書きできない(Rules)
  const opDb = env.authenticatedContext("opt1", { platformAdmin: true, email: "opt1@corp.example.jp", email_verified: true }).firestore();
  await assertFails(getDoc(doc(opDb, `dealerCompanies/${T}`)));
  await assertFails(setDoc(doc(opDb, `dealerCompanies/${T}`), { testOnly: false }, { merge: true }));
  // 運営者の一覧に試験用の印を返す
  assert.equal((await op("overview")).companies.find(c => c.companyId === T).testOnly, true);
});

test("注文の取り消し: 受信の索引は取消可能な時間の後に作る(待つ)。取り消した注文は索引にしない。万一の既存の索引も一覧・週表示・詳細に出さない", async () => {
  await grant("adminA", "fA", "dA1");
  const slept = [];
  const p2 = createDealerPortalService({ db, FieldValue, Timestamp, FieldPath, isEnabled: () => true, now: () => Date.now(), sleep: async (ms) => { slept.push(ms); } });
  const cancelSvc = createOrderCancelService({ db, FieldValue });
  const create = async () => (await orders.createOrder({ auth: auth("ordA"), data: { facilityId: "fA", requestId: crypto.randomUUID(), notes: "", lines: [line({ dealerId: "dA1" })] } }));
  const undo = (orderId) => cancelSvc.cancelOrder({ auth: auth("ordA"), data: { facilityId: "fA", orderId } });
  const event = (orderId) => p2.indexOrderEvent({ facilityId: "fA", orderId, eventTime: new Date().toISOString() });
  // 取り消さない注文: 取消の期限 + 余裕まで待ってから作る
  const a = await create();
  await event(a.orderId);
  assert.equal(slept.length, 1);
  assert.ok(slept[0] > 10000 && slept[0] <= 12000, `取消の期限の後まで待つ(${slept[0]}ms)`);
  assert.equal((await list("x1")).items.length, 1);
  // 取消可能な時間内に取り消した注文: 索引を作らない
  const b = await create();
  await undo(b.orderId);
  assert.deepEqual(await event(b.orderId), { created: 0, skipped: 1 });
  assert.equal((await list("x1")).items.length, 1);
  // 万一、取り消しの前に索引ができていた: 取り消しで印を付け、一覧・週表示・詳細のどれにも出さない
  const c = await create();
  await portal.indexOrder("fA", c.orderId);
  const before = (await list("x1")).items.map(i => i.orderNumber);
  assert.ok(before.includes(c.orderNumber));
  const rid = (await db.collection(`dealerCompanies/${C.X}/receipts`).where("sourceOrderId", "==", c.orderId).get()).docs[0].id;
  await undo(c.orderId);
  assert.equal((await db.doc(`dealerCompanies/${C.X}/receipts/${rid}`).get()).get("cancelled"), true);
  assert.deepEqual((await list("x1")).items.map(i => i.orderNumber), [a.orderNumber]);
  await rejects(api("x1", "get", { receiptId: rid }), "not-found");
  const wk = await api("x1", "week", { weekStart: (() => { const d = new Date(surgery() + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); })(), facilityFilter: { mode: "all" } });
  assert.ok(!JSON.stringify(wk).includes(c.orderNumber), "週表示にも出さない");
});

test("無効化・再有効化・再招待: 無効化で Google・Microsoft・メールリンクの紐付けを一度に失効(世代)。有効に戻しても確認し直すまで使えない。再招待の前の紐付けは使えない", async () => {
  const email = "x1@corp.example.jp", staffId = sid(C.X, "x1");
  const g = googleAuth("ug1", email, "g-x1"), m = msAuth("um1", email, "m-x1");
  await verifyAs(g);
  await verifyAs(m);
  for (const who of ["x1", g, m]) assert.equal((await api(who, "context")).company.id, C.X);
  await op("updateStaff", { companyId: C.X, staffId, status: "disabled" });
  for (const who of ["x1", g, m]) await assert.rejects(api(who, "context"), needsVerify);
  // 無効の間は確認コードを送らない(応答は同じ)
  const before = sentCodes.length;
  clock.t = Date.now() + 2 * 60 * 1000;
  assert.deepEqual(await api(g, "sendCode"), UNIFORM);
  assert.equal(sentCodes.length, before);
  clock.t = null;
  await op("updateStaff", { companyId: C.X, staffId, status: "active" });
  for (const who of ["x1", g, m]) await assert.rejects(api(who, "context"), needsVerify);
  clock.t = Date.now() + 4 * 60 * 1000;
  await verifyAs(g);
  clock.t = null;
  assert.equal((await api(g, "context")).company.id, C.X);
  await assert.rejects(api(m, "context"), needsVerify, "Microsoft は確認し直すまで使えない");
  // 再招待: 無効 → 招待中(世代を進める)。参加済みの担当者は招待できない。招待中は運営者の設定変更の対象外
  await rejects(op("inviteStaff", { companyId: C.X, email, name: "", role: "reader" }), "failed-precondition");
  const x2 = sid(C.X, "x2");
  const oldDevice = devices.get("x2");
  await op("updateStaff", { companyId: C.X, staffId: x2, status: "disabled" });
  await op("inviteStaff", { companyId: C.X, email: "x2@corp.example.jp", name: "担当x2", role: "reader" });
  const s2 = (await db.doc(`dealerStaff/${x2}`).get()).data();
  assert.deepEqual([s2.status, s2.authRevision], ["invited", 3]);
  await rejects(op("updateStaff", { companyId: C.X, staffId: x2, status: "active" }), "failed-precondition");
  await assert.rejects(api("x2", "context", { deviceToken: oldDevice }), needsVerify, "再招待の前の端末は使えない");
  // 取り消し → 送らない。再招待 → 参加
  await op("cancelInvitation", { companyId: C.X, staffId: x2 });
  await rejects(join("x2"), "no-code-sent");
  await rejects(op("cancelInvitation", { companyId: C.X, staffId: x2 }), "failed-precondition");
  await op("inviteStaff", { companyId: C.X, email: "x2@corp.example.jp", name: "担当x2", role: "reader" });
  await join("x2");
  assert.equal((await api("x2", "context")).company.id, C.X);
  await rejects(op("updateStaff", { companyId: C.Y, staffId: x2, status: "disabled" }), "not-found");
  await rejects(op("updateStaff", { companyId: C.X, staffId: "dstf_none", status: "disabled" }), "not-found");
  await rejects(op("updateStaff", { companyId: C.X, uid: "x2", status: "disabled" }), "invalid-argument");
});

test("複数社: 1回の確認コードで、送った時点の期限内の招待・有効な所属のある会社すべてに紐付ける(会社ごとに確認)。停止中の会社・期限切れ・取り消しの招待には紐付けない。後から届いた招待も確認コードで参加", async () => {
  const email = "multi@corp.example.jp";
  const Z = (await op("createCompany", { name: "ゼット商会", requestId: crypto.randomUUID() })).companyId;
  const W = (await op("createCompany", { name: "ダブリュー", requestId: crypto.randomUUID() })).companyId;
  const V = (await op("createCompany", { name: "ブイ", requestId: crypto.randomUUID() })).companyId;
  for (const cid of [C.X, C.Y, Z, W]) await op("inviteStaff", { companyId: cid, email, name: "", role: "reader" });
  clock.t = Date.now() - 31 * 24 * 3600 * 1000;
  await op("inviteStaff", { companyId: V, email, name: "", role: "reader" });   // 期限切れの招待
  clock.t = null;
  await op("updateCompany", { companyId: Z, status: "suspended" });
  await op("cancelInvitation", { companyId: W, staffId: sid(W, "multi") });
  const g = googleAuth("u-multi", email, "g-multi");
  await api(g, "sendCode");
  assert.equal(sentCodes.at(-1).companyName.split("、").sort().join("、"), ["エックス商事", "ワイ医療"].sort().join("、"), "メールに書く会社名も対象の会社だけ");
  const r = await api(g, "verifyCode", { code: sentCodes.at(-1).code });
  assert.deepEqual([r.companies, r.joined], [2, 2]);
  assert.deepEqual((await api(g, "companies")).companies.map(c => c.companyId).sort(), [C.X, C.Y].sort());
  assert.equal((await api(g, "companies")).pendingInvitation, false);
  for (const [cid, st] of [[Z, "invited"], [W, "cancelled"], [V, "invited"]]) assert.equal((await db.doc(`dealerStaff/${sid(cid, "multi")}`).get()).get("status"), st);
  await rejects(api(g, "context"), "failed-precondition");   // 2社: 会社の選択が必要
  await op("updateCompany", { companyId: Z, status: "active" });
  assert.equal((await api(g, "companies")).pendingInvitation, true);
  clock.t = Date.now() + 2 * 60 * 1000;
  const r2 = await verifyAs(g);
  assert.deepEqual([r2.companies, r2.joined], [3, 1]);
  clock.t = null;
  const r3 = await api(g, "companies");
  assert.deepEqual([r3.companies.length, r3.pendingInvitation], [3, false]);
  assert.equal((await db.collection("dealerStaff").where("approvedEmail", "==", email).get()).size, 5);
});

test("確認コード: 一度だけ・10分・誤り5回・送り直しは1分あける・認証主体ごとに24時間5回(成功で消えない。AB-05)・メールごとに24時間10回。認証主体・UID に結び付く。同時に使っても1回だけ。送れないときは確認できない。停止中は不可", async () => {
  const email = "code@corp.example.jp";
  await op("inviteStaff", { companyId: C.X, email, name: "", role: "reader" });
  const g = googleAuth("u-c", email, "g-c");
  const t0 = Date.now();
  const at = (min) => { clock.t = t0 + min * 60 * 1000; };
  at(0);
  await api(g, "sendCode");
  await assert.rejects(api(g, "sendCode"), (e) => /1分/.test(e.message));
  const c1 = sentCodes.at(-1).code;
  for (const other of [googleAuth("u-c", email, "g-c2"), msAuth("u-c", email, "m-c"), pwAuth("u-c2", email), googleAuth("u-c9", email, "g-c")]) {
    await assert.rejects(api(other, "verifyCode", { code: c1 }), (e) => /無効/.test(e.message));
  }
  at(11);
  await assert.rejects(api(g, "verifyCode", { code: c1 }), (e) => /無効/.test(e.message));
  for (let i = 1; i < 5; i++) { at(12 + i * 2); await api(g, "sendCode"); }
  at(30);
  await assert.rejects(api(g, "sendCode"), (e) => /上限/.test(e.message));
  at(24 * 60 + 1);
  await api(g, "sendCode");
  // 同時の照合: 正しいコードを同時に2回使っても成功は1回
  const c2 = sentCodes.at(-1).code;
  const both = await Promise.allSettled([api(g, "verifyCode", { code: c2 }), api(g, "verifyCode", { code: c2 })]);
  assert.deepEqual(both.map(x => x.status).sort(), ["fulfilled", "rejected"]);
  assert.deepEqual(await providersOf(sid(C.X, "code")), ["device", "google"]);
  // 成功しても送信回数・最後の送信時刻は残る(AB-05)
  await assert.rejects(api(g, "sendCode"), (e) => /1分/.test(e.message), "成功の直後も1分あける");
  for (let i = 1; i < 5; i++) { at(24 * 60 + 1 + i * 2); await api(g, "sendCode"); await api(g, "verifyCode", { code: sentCodes.at(-1).code }); }
  at(24 * 60 + 20);
  await assert.rejects(api(g, "sendCode"), (e) => /上限/.test(e.message), "成功を挟んでも24時間で5回まで");
  // 同時の誤入力: 記録は5回で止まる
  const m = msAuth("u-cm", email, "m-cm");
  at(24 * 60 + 25);
  await api(m, "sendCode");
  const cm = sentCodes.at(-1).code;
  await Promise.allSettled(Array.from({ length: 8 }, () => api(m, "verifyCode", { code: cm === "00000000" ? "11111111" : "00000000" })));
  const ch = (await db.collection("dealerAuthChallenges").where("uid", "==", "u-cm").get()).docs[0].data();
  assert.equal(ch.attempts, 5);
  await assert.rejects(api(m, "verifyCode", { code: cm }), (e) => /無効/.test(e.message));
  // 同時の送信: 予約は1回だけ
  const pp = pwAuth("u-cp", email);
  at(24 * 60 + 30);
  const sends = await Promise.allSettled(Array.from({ length: 5 }, () => api(pp, "sendCode")));
  assert.equal(sends.filter(x => x.status === "fulfilled").length, 1);
  // メールごとに24時間で10回(認証主体を替えても)
  for (let i = 0; i < 20 && (await db.collection("dealerAuthChallenges").get()).docs.find(d => d.id.startsWith("m_") && d.get("sends") >= 10) === undefined; i++) {
    await api(googleAuth(`u-q${i}`, email, `g-q${i}`), "sendCode");
  }
  await assert.rejects(api(googleAuth("u-qq", email, "g-qq"), "sendCode"), (e) => /このメールアドレスへの確認コードの送信回数の上限/.test(e.message));
  at(3 * 24 * 60);
  // 送れないとき(送信の失敗・送信手段なし)も、要求への応答は同じ(AB-03)。結果は記録だけ。照合はできない
  sendResult.v = { ok: false, error: "mail-disabled" };
  assert.deepEqual(await api(googleAuth("u-f", email, "g-f"), "sendCode"), UNIFORM, "送信の失敗は応答に出さない");
  assert.equal((await challengeOf("u-f")).get("deliveryStatus"), "failed");
  sendResult.v = { ok: true };
  const noSender = createDealerPortalService({ db, FieldValue, Timestamp, FieldPath, isEnabled: () => true });
  assert.deepEqual(await noSender.portal({ auth: googleAuth("u-f2", email, "g-f2"), data: { action: "sendCode" } }), UNIFORM);
  await deliverJobs(noSender);
  assert.equal((await challengeOf("u-f2")).get("deliveryStatus"), "not-sent");
  enabled.v = false;
  await rejects(api(g, "sendCode"), "failed-precondition");
  await rejects(api(g, "verifyCode", { code: "12345678" }), "failed-precondition");
  enabled.v = true;
  clock.t = null;
});

test("確認済みの端末: 期限180日・担当者ごとに10台(古いものから消す)。値は1回だけ返し、ハッシュだけを保存", async () => {
  const email = "x2@corp.example.jp";
  const first = devices.get("x2");
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) {
    clock.t = t0 + (i + 1) * 25 * 3600 * 1000;
    await verifyAs(pwAuth(`x2-dev${i}`, email));
  }
  const devs = (await bindingsOf(sid(C.X, "x2"))).filter(b => b.provider === "device");
  assert.equal(devs.length, 10);
  await assert.rejects(api("x2", "context", { deviceToken: first }), needsVerify, "最も古い端末は消える");
  clock.t = t0 + 11 * 25 * 3600 * 1000 + 181 * 24 * 3600 * 1000;
  await assert.rejects(api(pwAuth("x2-dev9", email), "context"), needsVerify, "180日を過ぎた端末は使えない");
  clock.t = null;
});

// ======================= 最新 main との統合の確認(検証ブランチ): 採用IOLの既定ディーラー × ディーラー画面の閲覧許可 =======================
test("共存: 閲覧を許可中も、施設は採用IOLの既定ディーラーを保存できる(発注先の名称・削除はロック)。既定ディーラー宛ての注文は、その会社にだけ公開される。取消の後は発注先を削除できる", async () => {
  await grant("adminA", "fA", "dA1");
  const { setDoc: put, updateDoc, deleteDoc: del, serverTimestamp } = await import("firebase/firestore");
  const adminDb = env.authenticatedContext("adminA", { email: "adminA@example.jp", email_verified: true }).firestore();
  const by = () => ({ updatedBy: "adminA", updatedAt: serverTimestamp() });
  // 採用IOLの既定ディーラー(会社Xに関連付けた dA1)を、施設の管理者が通常の操作(Rules)で保存できる
  await put(doc(adminDb, "facilities/fA/adoptedIols/jj-dib00v"), { facilityId: "fA", catalogIolId: "jj-dib00v", enabled: true, dealerId: "dA1", ...by() });
  assert.equal((await db.doc("facilities/fA/adoptedIols/jj-dib00v").get()).get("dealerId"), "dA1");
  // 発注先の並び順は変えられるが、名称の変更・削除は許可中はロック(既定ディーラーの参照先が別の会社に変わらない)
  await updateDoc(doc(adminDb, "facilities/fA/facilityDealers/dA1"), { sortOrder: 3000, ...by() });
  await assertFails(updateDoc(doc(adminDb, "facilities/fA/facilityDealers/dA1"), { name: "別会社", ...by() }));
  await assertFails(del(doc(adminDb, "facilities/fA/facilityDealers/dA1")));
  // 注文画面が既定ディーラー(dA1)を選んだ注文と、手動で dA2 を選んだ明細の混在: 会社Xには dA1 の明細だけ、会社Yは未許可なので何も出ない
  const r = await placeOrder("fA", "ordA", [line({ dealerId: "dA1" }), line({ dealerId: "dA2", power: "+21.0D" })]);
  const xs = (await list("x1")).items;
  assert.deepEqual(xs.map(i => [i.orderNumber, i.lineCount]), [[r.orderNumber, 1]]);
  assert.deepEqual((await list("y1")).items, []);
  // 取消の後は、発注先を削除できる(採用IOLの既定は画面側で「既定なし」に戻す)
  await revoke("adminA", "fA", "dA1");
  await del(doc(adminDb, "facilities/fA/facilityDealers/dA1"));
  assert.equal((await db.doc("facilities/fA/facilityDealers/dA1").get()).exists, false);
  await rejects(api("x1", "get", { receiptId: xs[0].receiptId }), "not-found");
});

test("Rules: 新しい領域(会社・担当者・紐付け・確認コード・索引・許可・関連付け)は、担当者・施設の管理者・運営者もクライアントから直接読めない。担当者は施設の注文を読めない", async () => {
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
    const bind = (await db.collection("dealerAuthBindings").limit(1).get()).docs[0].id;
    const chal = (await db.collection("dealerAuthChallenges").limit(1).get()).docs[0];
    for (const p of [`dealerCompanies/${C.X}`, `dealerStaff/${sid(C.X, "x1")}`, `dealerCompanies/${C.X}/receipts/${rid}`, `dealerPortalGrants/${g}`,
      "facilities/fA/dealerPortalLinks/dA1", `dealerAuthBindings/${bind}`, ...(chal ? [`dealerAuthChallenges/${chal.id}`] : [])]) {
      await assertFails(getDoc(doc(c, p)));
    }
    await assertFails(getDocs(collection(c, `dealerCompanies/${C.X}/receipts`)));
    await assertFails(getDocs(query(collection(c, "dealerStaff"), where("approvedEmail", "==", "x1@corp.example.jp"))));
    await assertFails(getDocs(query(collection(c, "dealerAuthBindings"), where("staffId", "==", sid(C.X, "x1")))));
  }
  const x1 = clients[0];
  await assertFails(getDoc(doc(x1, `facilities/fA/orders/${r.orderId}`)));
  await assertFails(getDocs(collection(x1, "facilities/fA/orders")));
  await assertFails(getDoc(doc(x1, `facilities/fA/orders/${r.orderId}/mails/d_dA1`)));
  await assertFails(getDoc(doc(x1, "facilities/fA/facilityDealers/dA1")));
});
