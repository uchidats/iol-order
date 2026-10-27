// 施設の事前登録(運営者のみ)と、初期管理者の参加承諾による有効化のテスト(Firestoreエミュレータ。実プロジェクトには接続しない)
//   npm run test:functions
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, collection } from "firebase/firestore";
import { createRegistrationService } from "../../functions/src/registration.js";
import { createFacilityApplicationService } from "../../functions/src/facility-applications.js";
import { createFacilityPreregistrationService } from "../../functions/src/facility-preregistrations.js";
import { createMemberService, pendingIdOf, PENDING_TTL_MS } from "../../functions/src/members.js";
import { createOrderService } from "../../functions/src/orders.js";

const PROJECT = "demo-iol-functions";
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185").split(":");
const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");
let env, db, registration, apps, prereg, members, clock;

before(async () => {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  db = getFirestore();
  clock = { t: Date.parse("2026-10-27T00:00:00Z") };
  registration = createRegistrationService({ db, FieldValue, Timestamp, now: () => clock.t });
  apps = createFacilityApplicationService({ db, FieldValue, Timestamp, registration, now: () => clock.t });
  prereg = createFacilityPreregistrationService({ db, FieldValue, Timestamp, registration, now: () => clock.t });
  members = createMemberService({ db, FieldValue, Timestamp, now: () => clock.t });
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(rulesPath, "utf8"), host, port: Number(port) } });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); clock.t = Date.parse("2026-10-27T00:00:00Z"); });

const user = (uid, over = {}) => ({ uid, token: { email: `${uid}@example.jp`, email_verified: true, name: `名前-${uid}`, ...over } });
const ops = (uid = "ops1") => user(uid, { platformAdmin: true });
const boss = (over = {}) => user("bossUid", { email: "boss@example.jp", ...over });
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);
const create = (data, auth = ops()) => prereg.preregisterFacility({ auth, data: { requestId: crypto.randomUUID(), ...data } });
const facOf = async (id) => (await db.doc(`facilities/${id}`).get()).data();
const pidOf = (fid, email = "boss@example.jp") => pendingIdOf(fid, email);
const logs = async () => (await db.collection("platformAuditLogs").get()).docs.map(d => d.data());

test("権限: 事前登録・一覧・編集・取り消しは運営者(platformAdmin)だけ(一般ユーザー・施設の管理者・未ログイン・メール未確認は不可)", async () => {
  await db.doc("facilities/f1").set({ name: "既存", status: "active" });
  await db.doc("facilities/f1/members/adminX").set({ uid: "adminX", role: "admin" });
  const r = await create({ name: "権限の眼科", adminEmail: "boss@example.jp" });
  for (const auth of [user("userA"), user("adminX"), user("x", { platformAdmin: "true" }), null, user("y", { platformAdmin: true, email_verified: false })]) {
    const denied = (e) => ["permission-denied", "unauthenticated"].includes(e.code);
    await assert.rejects(prereg.preregisterFacility({ auth, data: { name: "不正", adminEmail: "a@example.jp", requestId: crypto.randomUUID() } }), denied);
    await assert.rejects(prereg.listPreregistrations({ auth, data: {} }), denied);
    await assert.rejects(prereg.updatePreregistration({ auth, data: { facilityId: r.facilityId, name: "乗っ取り" } }), denied);
    await assert.rejects(prereg.cancelPreregistration({ auth, data: { facilityId: r.facilityId } }), denied);
  }
  assert.equal((await facOf(r.facilityId)).name, "権限の眼科");
  for (const bad of [{ name: "", adminEmail: "a@example.jp" }, { name: "a", adminEmail: "bad" }, { name: "a", adminEmail: "a@example.jp", role: "admin" }, { name: "a", adminEmail: "a@example.jp", requestId: "x" }]) {
    await rejects(prereg.preregisterFacility({ auth: ops(), data: { requestId: crypto.randomUUID(), ...bad } }), "invalid-argument");
  }
});

test("事前登録: 施設は未有効(preregistered)で、所属(管理者の権限)は作らない。初期管理者宛ての参加待ち・操作履歴を残す。同じ要求の再送は同じ登録", async () => {
  const requestId = crypto.randomUUID();
  const r = await prereg.preregisterFacility({ auth: ops(), data: { name: " 事前登録 眼科 ", adminEmail: " Boss@Example.jp ", adminName: "院長 太郎", requestId } });
  assert.equal(r.status, "created");
  const f = await facOf(r.facilityId);
  assert.deepEqual([f.name, f.status, f.initialAdminEmail, f.preregisteredBy.uid], ["事前登録 眼科", "preregistered", "boss@example.jp", "ops1"]);
  assert.equal((await db.collection(`facilities/${r.facilityId}/members`).get()).size, 0, "参加前は管理者の権限を付けない");
  const p = (await db.doc(`pendingMembers/${pidOf(r.facilityId)}`).get()).data();
  assert.deepEqual([p.role, p.initialAdmin, p.preregistration, p.status, p.name, p.facilityName], ["admin", true, true, "pending", "院長 太郎", "事前登録 眼科"]);
  assert.equal((await prereg.preregisterFacility({ auth: ops(), data: { name: "事前登録 眼科", adminEmail: "boss@example.jp", requestId } })).status, "exists");
  assert.equal((await db.collection("facilities").get()).size, 1);
  assert.deepEqual((await logs()).map(l => [l.action, l.facilityId, l.initialAdminEmailMasked, l.actorUid]), [["facility.preregister", r.facilityId, "b***@example.jp", "ops1"]]);
});

test("重複: 登録済みの施設・審査中の申請・事前登録の施設と、表記ゆれを含めて照合する(確認すれば登録できる)。事前登録の施設と同名の一般の申請も重複候補になる", async () => {
  await db.doc("facilities/f1").set({ name: "立川病院", status: "active" });
  await apps.applyFacility({ auth: user("applicant"), data: { name: "さくら眼科クリニック", requestId: crypto.randomUUID() } });
  const d1 = await create({ name: "立川 病院", adminEmail: "a@example.jp" });
  assert.deepEqual([d1.status, d1.exact, d1.candidates], ["duplicate-candidate", true, ["立川病院"]]);
  const d2 = await create({ name: "医療法人社団 さくら眼科クリニック", adminEmail: "a@example.jp" });
  assert.deepEqual([d2.status, d2.exact], ["duplicate-candidate", true], "審査中の申請と重複");
  const r = await create({ name: "目黒眼科", adminEmail: "a@example.jp" });
  const d3 = await create({ name: "目黒 眼科", adminEmail: "b@example.jp" });
  assert.deepEqual([d3.status, d3.exact], ["duplicate-candidate", true], "事前登録の施設と重複");
  assert.equal((await create({ name: "目黒眼科", adminEmail: "b@example.jp", confirmDuplicate: true })).status, "created", "確認すれば登録できる");
  // 一般の利用者が事前登録と同名の施設を申請しようとしても、重複候補になる
  const a = await apps.applyFacility({ auth: user("userX"), data: { name: "目黒眼科", requestId: crypto.randomUUID() } });
  assert.deepEqual([a.status, a.exact], ["duplicate-candidate", true]);
  assert.ok(r.facilityId);
});

test("一覧・編集: 承諾前の登録を表示し、施設名・初期管理者を直せる(以前のメールアドレスでは参加できなくなる。期限は今日から30日)", async () => {
  const r = await create({ name: "入力ミス眼科", adminEmail: "wrong@example.jp", adminName: "院長" });
  clock.t += 20 * 86400000;
  let list = (await prereg.listPreregistrations({ auth: ops(), data: {} })).preregistrations;
  assert.deepEqual(list.map(x => [x.facilityId, x.name, x.adminEmail, x.adminName, x.state]), [[r.facilityId, "入力ミス眼科", "wrong@example.jp", "院長", "pending"]]);
  assert.equal((await prereg.updatePreregistration({ auth: ops(), data: { facilityId: r.facilityId, name: "正しい眼科", adminEmail: "boss@example.jp" } })).status, "updated");
  assert.equal((await db.doc(`pendingMembers/${pidOf(r.facilityId, "wrong@example.jp")}`).get()).exists, false, "以前のメールアドレスの参加待ちは消す");
  const p = (await db.doc(`pendingMembers/${pidOf(r.facilityId)}`).get()).data();
  assert.deepEqual([p.facilityName, p.name, p.expiresAt.toMillis()], ["正しい眼科", "院長", clock.t + PENDING_TTL_MS]);
  await rejects(members.respondMembership({ auth: user("w", { email: "wrong@example.jp" }), data: { pendingId: pidOf(r.facilityId, "wrong@example.jp"), accept: true } }), "failed-precondition");
  list = (await prereg.listPreregistrations({ auth: ops(), data: {} })).preregistrations;
  assert.deepEqual(list.map(x => [x.name, x.adminEmail]), [["正しい眼科", "boss@example.jp"]]);
  // 期限切れ・辞退も一覧で分かる
  clock.t += PENDING_TTL_MS + 1;
  assert.equal((await prereg.listPreregistrations({ auth: ops(), data: {} })).preregistrations[0].state, "expired");
  assert.deepEqual((await logs()).map(l => l.action).sort(), ["facility.preregister", "facility.preregistration.update"]);
});

test("取り消し: 承諾前だけ。施設と参加待ちを削除し、初期管理者は参加できない。承諾後は取り消し・編集できない", async () => {
  const r = await create({ name: "取り消す眼科", adminEmail: "boss@example.jp" });
  assert.equal((await prereg.cancelPreregistration({ auth: ops(), data: { facilityId: r.facilityId } })).status, "cancelled");
  assert.equal((await db.doc(`facilities/${r.facilityId}`).get()).exists, false);
  assert.equal((await db.doc(`pendingMembers/${pidOf(r.facilityId)}`).get()).exists, false);
  await rejects(members.respondMembership({ auth: boss(), data: { pendingId: pidOf(r.facilityId), accept: true } }), "failed-precondition");
  await rejects(prereg.cancelPreregistration({ auth: ops(), data: { facilityId: r.facilityId } }), "not-found");
  const r2 = await create({ name: "承諾される眼科", adminEmail: "boss@example.jp" });
  await members.respondMembership({ auth: boss(), data: { pendingId: pidOf(r2.facilityId), accept: true } });
  await rejects(prereg.cancelPreregistration({ auth: ops(), data: { facilityId: r2.facilityId } }), "failed-precondition");
  await rejects(prereg.updatePreregistration({ auth: ops(), data: { facilityId: r2.facilityId, name: "変更" } }), "failed-precondition");
  assert.equal((await facOf(r2.facilityId)).status, "active");
});

test("参加: 指定のメール(確認済み)の本人が承諾すると、同じ処理で施設を有効化し最初の管理者になる(施設名はそのまま。運営者の再承認は不要)", async () => {
  const r = await create({ name: "参加する眼科", adminEmail: "boss@example.jp", adminName: "院長 花子" });
  const fid = r.facilityId, pid = pidOf(fid);
  // 参加確認の一覧に出る(施設名・管理者・最初の管理者の印)
  const mine = (await members.listMyPendingMemberships({ auth: boss(), data: {} })).memberships;
  assert.deepEqual(mine.map(m => [m.facilityId, m.facilityName, m.role, m.roleLabel, m.initialAdmin]), [[fid, "参加する眼科", "admin", "管理者", true]]);
  assert.deepEqual((await members.listMyPendingMemberships({ auth: user("other"), data: {} })).memberships, [], "他の人には出ない");
  // 第三者・メール未確認は承諾できない
  await rejects(members.respondMembership({ auth: user("other"), data: { pendingId: pid, accept: true } }), "failed-precondition");
  await rejects(members.respondMembership({ auth: boss({ email_verified: false }), data: { pendingId: pid, accept: true } }), "permission-denied");
  assert.equal((await facOf(fid)).status, "preregistered");
  // 本人の承諾
  const res = await members.respondMembership({ auth: boss(), data: { pendingId: pid, accept: true } });
  assert.deepEqual([res.status, res.role], ["joined", "admin"]);
  const f = await facOf(fid);
  assert.deepEqual([f.status, f.name, f.activatedBy], ["active", "参加する眼科", "bossUid"]);
  const m = (await db.doc(`facilities/${fid}/members/bossUid`).get()).data();
  assert.deepEqual([m.role, m.email, m.displayName], ["admin", "boss@example.jp", "院長 花子"]);
  assert.equal((await db.doc(`pendingMembers/${pid}`).get()).exists, false);
  const audit = (await db.collection(`facilities/${fid}/auditLogs`).get()).docs.map(d => [d.get("action"), d.get("via")]).sort();
  assert.deepEqual(audit, [["facility.activate", "preregistration"], ["member.join", "facility-preregistration"]]);
  // 二重承諾はできない(所属・施設は1つ)
  await rejects(members.respondMembership({ auth: boss(), data: { pendingId: pid, accept: true } }), "failed-precondition");
  assert.equal((await db.collection(`facilities/${fid}/members`).get()).size, 1);
});

test("参加: 同時の承諾でも有効化・管理者は1回だけ。期限切れは承諾できない。辞退すると施設は未有効のまま(編集で再登録できる)", async () => {
  const r = await create({ name: "同時承諾の眼科", adminEmail: "boss@example.jp" });
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => members.respondMembership({ auth: boss(), data: { pendingId: pidOf(r.facilityId), accept: true } })));
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.equal((await db.collection(`facilities/${r.facilityId}/members`).get()).size, 1);
  const r2 = await create({ name: "期限切れの眼科", adminEmail: "boss@example.jp" });
  clock.t += PENDING_TTL_MS + 1;
  await rejects(members.respondMembership({ auth: boss(), data: { pendingId: pidOf(r2.facilityId), accept: true } }), "failed-precondition");
  assert.equal((await facOf(r2.facilityId)).status, "preregistered");
  const r3 = await create({ name: "辞退される眼科", adminEmail: "boss@example.jp" });
  assert.equal((await members.respondMembership({ auth: boss(), data: { pendingId: pidOf(r3.facilityId), accept: false } })).status, "declined");
  assert.equal((await facOf(r3.facilityId)).status, "preregistered");
  assert.equal((await prereg.listPreregistrations({ auth: ops(), data: {} })).preregistrations.find(x => x.facilityId === r3.facilityId).state, "declined");
  await prereg.updatePreregistration({ auth: ops(), data: { facilityId: r3.facilityId, adminEmail: "boss@example.jp" } });
  assert.equal((await members.respondMembership({ auth: boss(), data: { pendingId: pidOf(r3.facilityId), accept: true } })).status, "joined", "編集(再登録)すれば参加できる");
});

test("未有効の施設では注文できず、施設の管理の操作もできない。既存の施設・所属・注文は変わらない", async () => {
  await db.doc("facilities/f1").set({ name: "既存の眼科", status: "active" });
  await db.doc("facilities/f1/members/adminX").set({ uid: "adminX", role: "admin" });
  await db.doc("facilities/f1/orders/o1").set({ orderNumber: "IOL-20261027-01" });
  const before = JSON.stringify([(await facOf("f1")), (await db.doc("facilities/f1/members/adminX").get()).data(), (await db.doc("facilities/f1/orders/o1").get()).data()]);
  const r = await create({ name: "未有効の眼科", adminEmail: "boss@example.jp" });
  const orders = createOrderService({ db, FieldValue, now: () => clock.t });
  await assert.rejects(orders.createOrder({ auth: boss(), data: { facilityId: r.facilityId, requestId: crypto.randomUUID(), lines: [{ modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: "2026-11-10", doctorId: "o1" }] } }));
  await rejects(members.addMember({ auth: boss(), data: { facilityId: r.facilityId, name: "x", email: "x@example.jp", role: "orderer" } }), "permission-denied");
  await rejects(registration.renameFacility({ auth: boss(), data: { facilityId: r.facilityId, name: "改名" } }), "permission-denied");
  const after = JSON.stringify([(await facOf("f1")), (await db.doc("facilities/f1/members/adminX").get()).data(), (await db.doc("facilities/f1/orders/o1").get()).data()]);
  assert.equal(after, before);
});

test("Rules: 未有効の施設・初期管理者の参加待ちは、本人・他施設の管理者を含め、クライアントから読めない(運営者は施設を読める)", async () => {
  const r = await create({ name: "Rules の眼科", adminEmail: "boss@example.jp" });
  const c = (uid, claims) => env.authenticatedContext(uid, { email_verified: true, ...claims }).firestore();
  await assertFails(getDoc(doc(c("bossUid", { email: "boss@example.jp" }), `facilities/${r.facilityId}`)));
  await assertFails(getDoc(doc(c("userA"), `facilities/${r.facilityId}`)));
  await assertFails(getDoc(doc(c("bossUid", { email: "boss@example.jp" }), `pendingMembers/${pidOf(r.facilityId)}`)));
  await assertFails(getDocs(collection(c("bossUid"), `facilities/${r.facilityId}/members`)));
  const ok = await getDoc(doc(c("ops1", { platformAdmin: true }), `facilities/${r.facilityId}`));
  assert.equal(ok.get("status"), "preregistered");
});
