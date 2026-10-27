// 新しい施設の登録申請(運営者の承認制)のテスト(Firestoreエミュレータ。実際のメールは送らない: 送信は偽の配信サービス)
//   npm run test:functions
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, getDocs, collection } from "firebase/firestore";
import { createRegistrationService, deriveFacilityId } from "../../functions/src/registration.js";
import { createFacilityApplicationService, createApplicationNotifier, buildApplicationMail } from "../../functions/src/facility-applications.js";
import { createMemberService, pendingIdOf } from "../../functions/src/members.js";
import { createOrderService } from "../../functions/src/orders.js";
import { canApproveFacilities } from "../../functions/src/roles.js";

const PROJECT = "demo-iol-functions";
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185").split(":");
const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");
let env, db, registration, apps, members, clock;

before(async () => {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  db = getFirestore();
  clock = { t: Date.parse("2026-10-27T00:00:00Z") };
  registration = createRegistrationService({ db, FieldValue, Timestamp, now: () => clock.t });
  apps = createFacilityApplicationService({ db, FieldValue, Timestamp, registration, now: () => clock.t });
  members = createMemberService({ db, FieldValue, Timestamp, now: () => clock.t });
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(rulesPath, "utf8"), host, port: Number(port) } });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); clock.t = Date.parse("2026-10-27T00:00:00Z"); });

const user = (uid, over = {}) => ({ uid, token: { email: `${uid}@example.jp`, email_verified: true, name: `名前-${uid}`, ...over } });
const ops = (uid = "ops1") => user(uid, { platformAdmin: true });
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);
const apply = (auth, name, extra = {}) => apps.applyFacility({ auth, data: { name, requestId: crypto.randomUUID(), ...extra } });
const decide = (auth, data) => apps.decideApplication({ auth, data });
const appOf = async (id) => (await db.doc(`facilityApplications/${id}`).get()).data();
const count = async (p) => (await db.collection(p).get()).size;

// ================= 申請 =================
test("申請: 施設は作らず(有効化しない)、管理者の権限も付けない。施設名・申請者名・メールアドレス・申請日時を保存する", async () => {
  const r = await apply(user("userA"), "  新しい　眼科 ", { applicantName: " 申請 太郎 " });
  assert.deepEqual([r.status, r.applicationStatus], ["submitted", "pending"]);
  assert.match(r.applicationId, /^fac-[0-9a-f]{24}$/);
  const a = await appOf(r.applicationId);
  assert.equal(a.name, "新しい 眼科");
  assert.equal(a.status, "pending");
  assert.deepEqual(a.applicant, { uid: "userA", email: "usera@example.jp", name: "申請 太郎" });
  assert.ok(a.createdAt);
  assert.deepEqual(a.history.map(h => [h.action, h.byUid]), [["submitted", "userA"]]);
  assert.equal(a.notification.status, "pending");
  assert.equal(await count("facilities"), 0, "施設は作らない");
  assert.equal((await db.collectionGroup("members").get()).size, 0, "管理者の所属も作らない");
  // 申請者名が未入力なら、ログイン情報の表示名
  const r2 = await apply(user("userB"), "別の医院");
  assert.equal((await appOf(r2.applicationId)).applicant.name, "名前-userB");
});

test("未承認の施設(申請中)では注文できない", async () => {
  const r = await apply(user("userA"), "申請中の眼科");
  const orders = createOrderService({ db, FieldValue, now: () => clock.t });
  await assert.rejects(orders.createOrder({ auth: user("userA"), data: { facilityId: r.applicationId, requestId: crypto.randomUUID(), lines: [{ modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: "2026-11-10", doctorId: "o1" }] } }));
  assert.equal(await count(`facilities/${r.applicationId}/orders`), 0);
});

test("申請: 既存施設・審査中の申請と重複しそうなら申請しない(確認すれば申請できる)。同じ要求の再送は同じ申請", async () => {
  await db.doc("facilities/tachikawa").set({ name: "立川病院", status: "active" });
  const dup = await apply(user("userA"), "立川 病院");
  assert.deepEqual([dup.status, dup.exact], ["duplicate-candidate", true]);
  const first = await apply(user("userB"), "さくら眼科クリニック");
  const pendDup = await apply(user("userC"), "さくら眼科クリニック");
  assert.deepEqual([pendDup.status, pendDup.exact], ["duplicate-candidate", true], "審査中の申請とも重複を確認する");
  assert.equal((await apply(user("userC"), "さくら眼科クリニック", { confirmDuplicate: true })).status, "submitted");
  const requestId = crypto.randomUUID();
  const a1 = await apps.applyFacility({ auth: user("userD"), data: { name: "独立医院", requestId } });
  const a2 = await apps.applyFacility({ auth: user("userD"), data: { name: "独立医院", requestId } });
  assert.equal(a1.applicationId, a2.applicationId);
  assert.equal((await db.doc("registrationQuota/userD").get()).get("count"), 1, "再送で利用枠を二重に消費しない");
  assert.ok(first.applicationId);
});

test("申請: 並列の同じ要求でも申請は1件。他人の申請IDは奪えない", async () => {
  const requestId = crypto.randomUUID();
  const rs = await Promise.all(Array.from({ length: 6 }, () => apps.applyFacility({ auth: user("userA"), data: { name: "並列医院", requestId } })));
  assert.equal(new Set(rs.map(r => r.applicationId)).size, 1);
  assert.equal(await count("facilityApplications"), 1);
  await db.doc(`facilityApplications/${deriveFacilityId("userB", requestId)}`).set({ name: "他人", status: "pending", applicant: { uid: "someone" } });
  await rejects(apps.applyFacility({ auth: user("userB"), data: { name: "奪取", requestId } }), "already-exists");
});

// ================= 承認・却下の権限 =================
test("承認権限: 運営者(platformAdmin)だけ。一般ユーザー・施設管理者・未ログイン・メール未確認は一覧・承認・却下とも拒否", async () => {
  assert.equal(canApproveFacilities({ isPlatformAdmin: true }), true);
  assert.equal(canApproveFacilities({ isPlatformAdmin: false }), false);
  const r = await apply(user("userA"), "権限確認医院");
  await db.doc("facilities/f1").set({ name: "既存", status: "active" });
  await db.doc("facilities/f1/members/adminX").set({ uid: "adminX", role: "admin" });
  for (const auth of [user("userB"), user("adminX"), user("x", { platformAdmin: "true" }), null, user("y", { platformAdmin: true, email_verified: false })]) {
    await assert.rejects(apps.listApplications({ auth, data: {} }), (e) => ["permission-denied", "unauthenticated"].includes(e.code));
    await assert.rejects(decide(auth, { applicationId: r.applicationId, decision: "approve" }), (e) => ["permission-denied", "unauthenticated"].includes(e.code));
  }
  assert.equal((await appOf(r.applicationId)).status, "pending");
});

test("申請者は自分の申請を承認・却下できない(運営者でも。同じメールアドレスの別アカウントも不可)", async () => {
  const r = await apply(ops("opsA"), "自分の医院");
  await rejects(decide(ops("opsA"), { applicationId: r.applicationId, decision: "approve" }), "permission-denied");
  await rejects(decide(ops("opsA"), { applicationId: r.applicationId, decision: "reject" }), "permission-denied");
  await rejects(decide(user("opsA2", { platformAdmin: true, email: "opsa@example.jp" }), { applicationId: r.applicationId, decision: "approve" }), "permission-denied");
  assert.equal((await appOf(r.applicationId)).status, "pending");
  assert.equal(await count("facilities"), 0);
});

// ================= 承認 =================
test("承認(申請者が最初の管理者): 施設を有効化し、申請者を管理者にする。承認の履歴・施設の操作履歴を残す", async () => {
  const r = await apply(user("userA"), "承認される眼科", { applicantName: "申請者A" });
  const d = await decide(ops(), { applicationId: r.applicationId, decision: "approve" });
  assert.deepEqual([d.status, d.facilityId, d.firstAdmin], ["approved", r.applicationId, { type: "applicant", status: "granted" }]);
  const fac = (await db.doc(`facilities/${r.applicationId}`).get()).data();
  assert.deepEqual([fac.name, fac.status, fac.createdBy, fac.applicationId, fac.approvedBy.uid], ["承認される眼科", "active", "userA", r.applicationId, "ops1"]);
  assert.deepEqual((await db.doc(`facilities/${r.applicationId}/members/userA`).get()).data().role, "admin");
  const a = await appOf(r.applicationId);
  assert.equal(a.status, "approved");
  assert.equal(a.decidedBy.uid, "ops1");
  assert.deepEqual(a.history.map(h => h.action), ["submitted", "approved"]);
  assert.equal(a.firstAdmin.type, "applicant");
  const logs = await db.collection(`facilities/${r.applicationId}/auditLogs`).get();
  assert.deepEqual(logs.docs.map(x => [x.get("action"), x.get("actorUid")]), [["facility.approve", "ops1"]]);
});

test("承認(別の責任者を最初の管理者に指定): 本人が確認済みのメールでログインし、参加を承諾したときだけ管理者になる", async () => {
  const r = await apply(user("userA"), "責任者指定の医院");
  const d = await decide(ops(), { applicationId: r.applicationId, decision: "approve", firstAdmin: { name: "責任者 花子", email: "Boss@Example.jp" } });
  assert.deepEqual(d.firstAdmin, { type: "designated", status: "pending" });
  const fid = r.applicationId;
  assert.equal((await db.collection(`facilities/${fid}/members`).get()).size, 0, "承諾まで管理者はいない(申請者にも権限を付けない)");
  const pid = pendingIdOf(fid, "boss@example.jp");
  const p = (await db.doc(`pendingMembers/${pid}`).get()).data();
  assert.deepEqual([p.role, p.initialAdmin, p.email, p.status], ["admin", true, "boss@example.jp", "pending"]);
  // 別のメールアドレスの人・メール未確認では承諾できない
  await rejects(members.respondMembership({ auth: user("userA"), data: { pendingId: pid, accept: true } }), "failed-precondition");
  await rejects(members.respondMembership({ auth: user("boss", { email: "boss@example.jp", email_verified: false }), data: { pendingId: pid, accept: true } }), "permission-denied");
  // 本人(確認済みのメール)が一覧で確認して承諾すると、管理者になる
  const boss = user("bossUid", { email: "boss@example.jp" });
  assert.deepEqual((await members.listMyPendingMemberships({ auth: boss, data: {} })).memberships.map(m => [m.facilityName, m.role]), [["責任者指定の医院", "admin"]]);
  assert.equal((await members.respondMembership({ auth: boss, data: { pendingId: pid, accept: true } })).status, "joined");
  assert.equal((await db.doc(`facilities/${fid}/members/bossUid`).get()).get("role"), "admin");
  assert.equal((await db.doc(`facilities/${fid}/members/userA`).get()).exists, false);
});

test("管理者の参加待ちは、承認で指定した最初の管理者だけ(施設の管理者の事前登録では作れず、手で作られたものも承諾できない)", async () => {
  await db.doc("facilities/f1").set({ name: "既存", status: "active" });
  await db.doc("facilities/f1/members/adminX").set({ uid: "adminX", role: "admin", email: "adminx@example.jp" });
  await rejects(members.addMember({ auth: user("adminX"), data: { facilityId: "f1", name: "x", email: "x@example.jp", role: "admin" } }), "invalid-argument");
  const pid = pendingIdOf("f1", "x@example.jp");
  await db.doc(`pendingMembers/${pid}`).set({ facilityId: "f1", email: "x@example.jp", name: "x", role: "admin", status: "pending", expiresAt: Timestamp.fromMillis(clock.t + 86400000) });
  await rejects(members.respondMembership({ auth: user("x", { email: "x@example.jp" }), data: { pendingId: pid, accept: true } }), "failed-precondition");
});

test("却下: 施設は作らず、理由と履歴を残す。処理済みの申請は再び承認・却下できない", async () => {
  const r = await apply(user("userA"), "却下される医院");
  const d = await decide(ops(), { applicationId: r.applicationId, decision: "reject", reason: "施設を確認できませんでした" });
  assert.equal(d.status, "rejected");
  const a = await appOf(r.applicationId);
  assert.deepEqual([a.status, a.reason, a.history.map(h => h.action)], ["rejected", "施設を確認できませんでした", ["submitted", "rejected"]]);
  assert.equal(await count("facilities"), 0);
  await rejects(decide(ops("ops2"), { applicationId: r.applicationId, decision: "approve" }), "failed-precondition");
  await rejects(decide(ops("ops2"), { applicationId: r.applicationId, decision: "reject" }), "failed-precondition");
  // 入力検証
  for (const bad of [{ decision: "approve" }, { applicationId: "x", decision: "approve" }, { applicationId: r.applicationId, decision: "maybe" },
    { applicationId: r.applicationId, decision: "reject", firstAdmin: { name: "a", email: "a@example.jp" } }, { applicationId: r.applicationId, decision: "approve", role: "admin" }]) {
    await rejects(decide(ops(), bad), "invalid-argument");
  }
});

test("同時操作: 同じ申請を複数の運営者が同時に承認・却下しても、処理されるのは1回だけ(施設・管理者は1つ)", async () => {
  const r = await apply(user("userA"), "同時承認の医院");
  const results = await Promise.allSettled([
    ...Array.from({ length: 4 }, (_, i) => decide(ops(`ops${i}`), { applicationId: r.applicationId, decision: "approve" })),
    decide(ops("opsR"), { applicationId: r.applicationId, decision: "reject" })
  ]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.ok(results.filter(x => x.status === "rejected").every(x => x.reason.code === "failed-precondition"));
  const a = await appOf(r.applicationId);
  assert.equal(a.history.length, 2);
  if (a.status === "approved") assert.equal((await db.collection(`facilities/${r.applicationId}/members`).get()).size, 1);
  else assert.equal(await count("facilities"), 0);
});

test("承認: 既存施設と同名なら確認(confirmDuplicate)が必要。既存の施設・管理者・利用者は変わらない", async () => {
  await db.doc("facilities/tachikawa").set({ name: "立川病院", status: "active" });
  await db.doc("facilities/tachikawa/members/adminT").set({ uid: "adminT", role: "admin" });
  const before = (await db.doc("facilities/tachikawa").get()).data();
  const r = await apply(user("userA"), "立川病院", { confirmDuplicate: true });
  const d1 = await decide(ops(), { applicationId: r.applicationId, decision: "approve" });
  assert.deepEqual([d1.status, d1.exact, d1.candidates], ["duplicate-candidate", true, ["立川病院"]]);
  assert.equal((await appOf(r.applicationId)).status, "pending");
  assert.equal((await decide(ops(), { applicationId: r.applicationId, decision: "approve", confirmDuplicate: true })).status, "approved");
  assert.deepEqual((await db.doc("facilities/tachikawa").get()).data(), before);
  assert.deepEqual((await db.collection("facilities/tachikawa/members").get()).docs.map(x => x.id), ["adminT"]);
});

test("一覧: 審査中(古い順・既存施設との重複候補つき)と最近の承認・却下。申請者のメールアドレスは承認権限のある人だけに返す", async () => {
  await db.doc("facilities/tachikawa").set({ name: "立川病院", status: "active" });
  const a = await apply(user("userA"), "立川病院", { confirmDuplicate: true, applicantName: "申請A" });
  clock.t += 1000;
  const b = await apply(user("userB"), "目黒眼科");
  const c = await apply(user("userC"), "却下の医院");
  await decide(ops(), { applicationId: c.applicationId, decision: "reject", reason: "重複" });
  const list = await apps.listApplications({ auth: ops(), data: {} });
  assert.deepEqual(list.pending.map(p => p.id), [a.applicationId, b.applicationId]);
  assert.deepEqual(list.pending[0].applicant, { name: "申請A", email: "usera@example.jp" });
  assert.deepEqual([list.pending[0].duplicates.exact, list.pending[0].duplicates.candidates], [true, ["立川病院"]]);
  assert.equal(list.pending[1].duplicates.exact, false);
  assert.deepEqual(list.recent.map(x => [x.id, x.status, x.reason, x.decidedBy.email]), [[c.applicationId, "rejected", "重複", "ops1@example.jp"]]);
});

// ================= 運営者への通知 =================
test("通知: 申請ごとに1回、運営者へ施設名・申請者名・メールアドレスを送る(返信先は申請者)。二重に送らない", async () => {
  const sent = [];
  const notifier = createApplicationNotifier({ db, FieldValue, isEnabled: () => true, recipients: () => ["ops@medconf.example", " "], getSender: () => ({ send: async (m) => { sent.push(m); return { ok: true, id: "msg_1" }; } }) });
  const r = await apply(user("userA"), "通知の眼科", { applicantName: "申請 太郎" });
  const ref = db.doc(`facilityApplications/${r.applicationId}`);
  assert.equal(await notifier.notify(ref), "accepted");
  assert.equal(await notifier.notify(ref), "skipped", "二重に送らない");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["ops@medconf.example"]);
  assert.deepEqual(sent[0].replyTo, ["usera@example.jp"]);
  assert.equal(sent[0].subject, "【IOL Order】施設登録の申請: 通知の眼科");
  for (const s of ["施設名: 通知の眼科", "申請者名: 申請 太郎", "メールアドレス: usera@example.jp"]) assert.ok(sent[0].text.includes(s), s);
  assert.match(sent[0].idempotencyKey, /^iol-app-[0-9a-f]{40}$/);
  assert.equal((await appOf(r.applicationId)).notification.status, "accepted");
});

test("通知: 失敗しても申請は残り、結果を記録する。送信停止中は held、宛先なしは not_configured、MAIL_TEST_ONLY はテスト用の宛先だけ", async () => {
  const mk = (over) => createApplicationNotifier({ db, FieldValue, isEnabled: () => true, recipients: () => ["ops@medconf.example"], getSender: () => ({ send: async () => ({ ok: true, id: "m" }) }), ...over });
  const cases = [
    [mk({ getSender: () => ({ send: async () => ({ ok: false, retryable: true, error: "HTTP 500" }) }) }), "failed"],
    [mk({ getSender: () => ({ send: async () => { throw new Error("network"); } }) }), "failed"],
    [mk({ isEnabled: () => false }), "settled", "held"],
    [mk({ recipients: () => [""] }), "settled", "not_configured"]
  ];
  for (const [n, [notifier, ret, status = ret]] of cases.entries()) {
    const r = await apply(user(`user${n}`), `通知テスト医院${n}`, { confirmDuplicate: true });
    assert.equal(await notifier.notify(db.doc(`facilityApplications/${r.applicationId}`)), ret);
    const a = await appOf(r.applicationId);
    assert.deepEqual([a.status, a.name, a.notification.status], ["pending", `通知テスト医院${n}`, status]);
  }
  const sent = [];
  const testOnly = mk({ testOnly: () => true, testRecipient: () => "dev@example.jp", getSender: () => ({ send: async (m) => { sent.push(m); return { ok: true, id: "t" }; } }) });
  const r = await apply(user("userT"), "テスト宛ての医院");
  await testOnly.notify(db.doc(`facilityApplications/${r.applicationId}`));
  assert.deepEqual([sent[0].to, sent[0].replyTo], [["dev@example.jp"], null]);
  assert.match(sent[0].subject, /^【テスト】/);
});

test("通知メール: 改行を含む入力でも件名・項目は1行。申請日時は日本時間", () => {
  const m = buildApplicationMail({ name: "眼科\nBcc: x@evil.jp", applicant: { name: "太郎\r\n花子", email: "a@example.jp" } }, Date.parse("2026-10-27T03:04:00Z"));
  assert.ok(!/[\r\n]/.test(m.subject));
  assert.ok(m.text.includes("施設名: 眼科 Bcc: x@evil.jp") && m.text.includes("申請者名: 太郎 花子"));
  assert.ok(m.text.includes("申請日時: 2026/10/27 12:04"));
});

// ================= Security Rules =================
test("Rules: 申請はクライアントから読み書きできない(運営者を含む。サーバー経由のみ)", async () => {
  const r = await apply(user("userA"), "Rules確認の医院");
  for (const c of [env.authenticatedContext("userA", { email_verified: true }).firestore(), env.authenticatedContext("ops1", { email_verified: true, platformAdmin: true }).firestore(), env.unauthenticatedContext().firestore()]) {
    await assertFails(getDoc(doc(c, `facilityApplications/${r.applicationId}`)));
    await assertFails(getDocs(collection(c, "facilityApplications")));
    await assertFails(setDoc(doc(c, "facilityApplications/fac-000000000000000000000000"), { name: "偽", status: "approved" }));
  }
});

// ================= 申請の削除(運営者のみ) =================
const del = (auth, applicationId) => apps.deleteApplication({ auth, data: { applicationId } });

test("削除: 運営者(platformAdmin)だけ。一般ユーザー・施設の管理者・申請者本人・未ログイン・メール未確認は不可", async () => {
  await db.doc("facilities/f1").set({ name: "既存", status: "active" });
  await db.doc("facilities/f1/members/adminX").set({ uid: "adminX", role: "admin" });
  const r = await apply(user("userA"), "削除権限の医院");
  for (const auth of [user("userB"), user("adminX"), user("userA"), user("x", { platformAdmin: "true" }), null, user("y", { platformAdmin: true, email_verified: false })]) {
    await assert.rejects(del(auth, r.applicationId), (e) => ["permission-denied", "unauthenticated"].includes(e.code));
  }
  assert.equal((await appOf(r.applicationId)).status, "pending");
  for (const bad of [{}, { applicationId: "x" }, { applicationId: r.applicationId, force: true }]) await rejects(apps.deleteApplication({ auth: ops(), data: bad }), "invalid-argument");
});

test("削除: 審査中・却下済みは削除でき、承認済みは削除できない(施設との整合性)。削除は運営者の操作履歴に残る", async () => {
  const pend = await apply(user("userA"), "審査中の医院");
  const rej = await apply(user("userB"), "却下された医院");
  await decide(ops(), { applicationId: rej.applicationId, decision: "reject", reason: "確認できない" });
  const appr = await apply(user("userC"), "承認された医院");
  await decide(ops(), { applicationId: appr.applicationId, decision: "approve" });
  await rejects(del(ops(), appr.applicationId), "failed-precondition");
  assert.equal((await appOf(appr.applicationId)).status, "approved");
  assert.equal((await db.doc(`facilities/${appr.applicationId}`).get()).get("status"), "active", "承認済みの施設はそのまま");
  assert.deepEqual(await del(ops(), pend.applicationId), { status: "deleted", applicationId: pend.applicationId });
  assert.deepEqual(await del(ops(), rej.applicationId), { status: "deleted", applicationId: rej.applicationId });
  assert.equal((await db.doc(`facilityApplications/${pend.applicationId}`).get()).exists, false);
  assert.equal((await db.doc(`facilityApplications/${rej.applicationId}`).get()).exists, false);
  await rejects(del(ops(), pend.applicationId), "not-found");
  const logs = (await db.collection("platformAuditLogs").get()).docs.map(d => d.data()).sort((a, b) => a.applicationStatus.localeCompare(b.applicationStatus));
  assert.deepEqual(logs.map(l => [l.action, l.applicationStatus, l.facilityName, l.applicantUid, l.applicantEmailMasked, l.actorUid, l.historyCount]), [
    ["facilityApplication.delete", "pending", "審査中の医院", "userA", "u***@example.jp", "ops1", 1],
    ["facilityApplication.delete", "rejected", "却下された医院", "userB", "u***@example.jp", "ops1", 2]]);
  assert.ok(logs.every(l => l.at));
});

test("削除: 申請者の申請枠を1件空け、重複判定(審査中の申請との照合・同じ人の同名の再申請)に数えない。施設・所属・注文には影響しない", async () => {
  await db.doc("facilities/f1").set({ name: "既存の眼科", status: "active" });
  await db.doc("facilities/f1/members/adminX").set({ uid: "adminX", role: "admin" });
  await db.doc("facilities/f1/orders/o1").set({ orderNumber: "IOL-20261027-01", status: "notified" });
  const before = JSON.stringify([(await db.doc("facilities/f1").get()).data(), (await db.doc("facilities/f1/members/adminX").get()).data(), (await db.doc("facilities/f1/orders/o1").get()).data()]);
  const r = await apply(user("userA"), "架空の眼科クリニック");
  assert.deepEqual([(await db.doc("registrationQuota/userA").get()).get("count"), (await db.doc("registrationQuota/userA").get()).get("keys").length], [1, 1]);
  assert.equal((await apply(user("userB"), "架空の眼科クリニック")).status, "duplicate-candidate", "削除前は審査中の申請と重複");
  await del(ops(), r.applicationId);
  const q = (await db.doc("registrationQuota/userA").get()).data();
  assert.deepEqual([q.count, q.keys], [0, []], "申請枠を空ける");
  assert.equal((await apply(user("userB"), "架空の眼科クリニック")).status, "submitted", "削除後は重複に数えない");
  assert.equal((await apply(user("userA"), "架空の眼科クリニック")).status, "duplicate-candidate", "(他の人の審査中の申請とは重複する)");
  const after = JSON.stringify([(await db.doc("facilities/f1").get()).data(), (await db.doc("facilities/f1/members/adminX").get()).data(), (await db.doc("facilities/f1/orders/o1").get()).data()]);
  assert.equal(after, before, "既存の施設・所属・注文は変わらない");
});

test("削除: 削除した申請の通知は送らない。同時の削除は1回だけ処理する", async () => {
  const sent = [];
  const notifier = createApplicationNotifier({ db, FieldValue, isEnabled: () => true, recipients: () => ["ops@medconf.example"], getSender: () => ({ send: async (m) => { sent.push(m); return { ok: true, id: "x" }; } }) });
  const r = await apply(user("userA"), "通知前に削除する医院");
  await del(ops(), r.applicationId);
  assert.equal(await notifier.notify(db.doc(`facilityApplications/${r.applicationId}`)), "skipped");
  assert.equal(sent.length, 0);
  const r2 = await apply(user("userB"), "同時削除の医院");
  const results = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => del(ops(`ops${i}`), r2.applicationId)));
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.equal((await db.collection("platformAuditLogs").get()).size, 2);
});

test("Rules: 運営者の操作履歴(platformAuditLogs)はクライアントから読み書きできない(運営者を含む)", async () => {
  const r = await apply(user("userA"), "Rules削除の医院");
  await del(ops(), r.applicationId);
  const id = (await db.collection("platformAuditLogs").get()).docs[0].id;
  for (const c of [env.authenticatedContext("userA", { email_verified: true }).firestore(), env.authenticatedContext("ops1", { email_verified: true, platformAdmin: true }).firestore(), env.unauthenticatedContext().firestore()]) {
    await assertFails(getDoc(doc(c, `platformAuditLogs/${id}`)));
    await assertFails(getDocs(collection(c, "platformAuditLogs")));
    await assertFails(setDoc(doc(c, "platformAuditLogs/forged"), { action: "x" }));
  }
});
