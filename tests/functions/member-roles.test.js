// 利用者管理(役割・事前登録・参加確認・役割変更)のテスト（Firestoreエミュレータ上で実行。実プロジェクトには接続しない）
//   npm run test:functions
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { getDocs, getDoc, doc, collection, query, where, setDoc } from "firebase/firestore";
import { createMemberService, pendingIdOf, PENDING_TTL_MS } from "../../functions/src/members.js";
import { createRegistrationService } from "../../functions/src/registration.js";

const PROJECT = "demo-iol-functions";
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185").split(":");
const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");

let env, db, svc, registration, clock;
const T0 = Date.parse("2026-10-24T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  db = getFirestore();
  clock = { t: T0 };
  svc = createMemberService({ db, FieldValue, Timestamp, now: () => clock.t });
  registration = createRegistrationService({ db, FieldValue, Timestamp, now: () => clock.t });
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(rulesPath, "utf8"), host, port: Number(port) } });
});
after(async () => { await env.clearFirestore(); await env.cleanup(); });

const F = "fac-aaaaaaaaaaaaaaaaaaaaaaaa", G = "fac-bbbbbbbbbbbbbbbbbbbbbbbb";
const user = (uid, over = {}) => ({ uid, token: { email: `${uid}@example.jp`, email_verified: true, name: `名前-${uid}`, ...over } });
const invitee = (uid, email, over = {}) => ({ uid, token: { email, email_verified: true, name: `本人-${uid}`, ...over } });
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);
const mem = async (f, uid) => (await db.doc(`facilities/${f}/members/${uid}`).get());
const pend = async (f, email) => (await db.doc(`pendingMembers/${pendingIdOf(f, email)}`).get());
const logs = async (f = F) => (await db.collection(`facilities/${f}/auditLogs`).get()).docs.map(d => d.data());
const add = (auth, d) => svc.addMember({ auth, data: { facilityId: F, ...d } });

beforeEach(async () => {
  await env.clearFirestore();
  clock.t = T0;
  await db.doc(`facilities/${F}`).set({ name: "A眼科", status: "active" });
  await db.doc(`facilities/${G}`).set({ name: "B眼科", status: "active" });
  await db.doc("facilities/fac-suspended-0000000000").set({ name: "停止中", status: "suspended" });
  const seed = [[F, "adminA", "admin"], [F, "subA", "subadmin"], [F, "ordA", "orderer"], [F, "proxyA", "proxy"], [G, "adminB", "admin"], [G, "subB", "subadmin"], ["fac-suspended-0000000000", "subS", "subadmin"]];
  for (const [f, uid, role] of seed) await db.doc(`facilities/${f}/members/${uid}`).set({ uid, role, displayName: uid, email: `${uid.toLowerCase()}@example.jp` });
});

// ================= 事前登録 =================
test("事前登録: 管理者は副管理者・注文者・代行入力者を登録できる。30日の期限・操作履歴が記録され、所属はまだ作られない", async () => {
  for (const [email, role] of [["s@example.jp", "subadmin"], ["o@example.jp", "orderer"], ["p@example.jp", "proxy"]]) {
    const r = await add(user("adminA"), { name: " 新人  太郎 ", email: ` ${email.toUpperCase()} `, role });
    assert.equal(r.status, "pending");
    assert.equal(r.email, email);
    assert.equal(r.name, "新人 太郎");
    assert.equal(r.expiresAt, new Date(T0 + PENDING_TTL_MS).toISOString());
    const p = await pend(F, email);
    assert.deepEqual([p.get("facilityId"), p.get("email"), p.get("role"), p.get("status"), p.get("createdBy").uid], [F, email, role, "pending", "adminA"]);
    assert.equal(p.get("expiresAt").toMillis(), T0 + 30 * DAY);
  }
  assert.equal((await db.collection(`facilities/${F}/members`).get()).size, 4, "所属は増えない");
  assert.deepEqual((await logs()).map(l => l.action), ["member.preregister", "member.preregister", "member.preregister"]);
});

test("事前登録: 副管理者は注文者・代行入力者だけ。管理者の事前登録は誰もできない。注文者・代行入力者・他施設・停止中は不可", async () => {
  assert.equal((await add(user("subA"), { name: "a", email: "o@example.jp", role: "orderer" })).status, "pending");
  assert.equal((await add(user("subA"), { name: "a", email: "p@example.jp", role: "proxy" })).status, "pending");
  await rejects(add(user("subA"), { name: "a", email: "s@example.jp", role: "subadmin" }), "permission-denied");
  await rejects(add(user("subA"), { name: "a", email: "x@example.jp", role: "admin" }), "invalid-argument");
  await rejects(add(user("adminA"), { name: "a", email: "x@example.jp", role: "admin" }), "invalid-argument");
  for (const uid of ["ordA", "proxyA", "adminB", "subB", "stranger"]) await rejects(add(user(uid), { name: "a", email: "y@example.jp", role: "orderer" }), "permission-denied");
  await rejects(svc.addMember({ auth: user("subS"), data: { facilityId: "fac-suspended-0000000000", name: "a", email: "y@example.jp", role: "orderer" } }), "permission-denied");
  await rejects(add(null, { name: "a", email: "y@example.jp", role: "orderer" }), "unauthenticated");
  await rejects(add(user("adminA", { email_verified: false }), { name: "a", email: "y@example.jp", role: "orderer" }), "permission-denied");
  assert.equal((await pend(F, "s@example.jp")).exists, false);
  assert.equal((await pend(F, "y@example.jp")).exists, false);
});

test("事前登録: 入力検証(不正なメール・名前・役割・余計な項目)。既に所属している人・有効な参加待ちの二重登録は不可", async () => {
  await rejects(add(user("adminA"), { name: "a", email: "bad", role: "orderer" }), "invalid-argument");
  await rejects(add(user("adminA"), { name: "", email: "a@example.jp", role: "orderer" }), "invalid-argument");
  await rejects(add(user("adminA"), { name: "あ".repeat(51), email: "a@example.jp", role: "orderer" }), "invalid-argument");
  await rejects(add(user("adminA"), { name: "a", email: "a@example.jp", role: "viewer" }), "invalid-argument");
  await rejects(add(user("adminA"), { name: "a", email: "a@example.jp", role: "orderer", uid: "x" }), "invalid-argument");
  await rejects(svc.addMember({ auth: user("adminA"), data: { facilityId: "../x", name: "a", email: "a@example.jp", role: "orderer" } }), "invalid-argument");
  await rejects(add(user("adminA"), { name: "a", email: "ORDA@example.jp", role: "proxy" }), "already-exists");
  await add(user("adminA"), { name: "a", email: "a@example.jp", role: "orderer" });
  await rejects(add(user("adminA"), { name: "a", email: "a@example.jp", role: "proxy" }), "already-exists");
});

test("事前登録: 副管理者は、副管理者宛ての(期限切れの)参加待ちを上書き・取り消し・再登録できない", async () => {
  await add(user("adminA"), { name: "s", email: "s@example.jp", role: "subadmin" });
  clock.t = T0 + 31 * DAY;
  await rejects(add(user("subA"), { name: "s", email: "s@example.jp", role: "orderer" }), "permission-denied");
  const pendingId = pendingIdOf(F, "s@example.jp");
  await rejects(svc.cancelPendingMember({ auth: user("subA"), data: { facilityId: F, pendingId } }), "permission-denied");
  await rejects(svc.renewPendingMember({ auth: user("subA"), data: { facilityId: F, pendingId } }), "permission-denied");
  assert.equal((await pend(F, "s@example.jp")).get("role"), "subadmin");
});

// ================= 参加確認(本人) =================
test("参加確認: 本人宛ての有効な参加待ちだけが一覧に出て、承認すると uid の所属になる(役割・名前・メール)。参加待ちは消え、操作履歴が残る", async () => {
  await add(user("adminA"), { name: "新人", email: "new@example.jp", role: "proxy" });
  const me = invitee("newUid", "New@Example.jp");
  const list = await svc.listMyPendingMemberships({ auth: me, data: {} });
  assert.equal(list.memberships.length, 1);
  const item = list.memberships[0];
  assert.deepEqual([item.facilityId, item.facilityName, item.role, item.roleLabel], [F, "A眼科", "proxy", "代行入力者"]);
  assert.ok(!JSON.stringify(list).includes("adminA@") && !("email" in item), "他の利用者の情報やメールは返さない");
  const r = await svc.respondMembership({ auth: me, data: { pendingId: item.pendingId, accept: true } });
  assert.deepEqual(r, { status: "joined", facilityId: F, role: "proxy" });
  const m = await mem(F, "newUid");
  assert.deepEqual([m.get("uid"), m.get("role"), m.get("displayName"), m.get("email")], ["newUid", "proxy", "新人", "new@example.jp"]);
  assert.equal((await pend(F, "new@example.jp")).exists, false);
  assert.ok((await logs()).some(l => l.action === "member.join" && l.targetUid === "newUid" && l.targetRole === "proxy"));
  assert.deepEqual((await svc.listMyPendingMemberships({ auth: me })).memberships, []);
  // 参加後は Rules でも所属として扱われる(代行入力者 = 注文者と同じ)
  await assertSucceeds(getDoc(doc(env.authenticatedContext("newUid").firestore(), `facilities/${F}`)));
  await assertFails(getDocs(collection(env.authenticatedContext("newUid").firestore(), `facilities/${F}/members`)));
});

test("参加確認: メール未確認・別のメール・取り消し済み・辞退済みは承認できない(同じ応答)。所属は作られない", async () => {
  const { pendingId } = await add(user("adminA"), { name: "新人", email: "new@example.jp", role: "orderer" });
  await rejects(svc.respondMembership({ auth: invitee("u1", "new@example.jp", { email_verified: false }), data: { pendingId, accept: true } }), "permission-denied");
  assert.deepEqual((await svc.listMyPendingMemberships({ auth: invitee("u2", "other@example.jp") })).memberships, []);
  await rejects(svc.respondMembership({ auth: invitee("u2", "other@example.jp"), data: { pendingId, accept: true } }), "failed-precondition");
  await rejects(svc.listMyPendingMemberships({ auth: invitee("u1", "new@example.jp", { email_verified: false }) }), "permission-denied");
  await rejects(svc.respondMembership({ auth: null, data: { pendingId, accept: true } }), "unauthenticated");
  await rejects(svc.respondMembership({ auth: invitee("u3", "new@example.jp"), data: { pendingId, accept: "yes" } }), "invalid-argument");
  await rejects(svc.respondMembership({ auth: invitee("u3", "new@example.jp"), data: { pendingId: "x", accept: true } }), "invalid-argument");
  await rejects(svc.respondMembership({ auth: invitee("u3", "new@example.jp"), data: { pendingId, accept: true, role: "admin" } }), "invalid-argument");
  // 取り消し後は承認できない
  await svc.cancelPendingMember({ auth: user("subA"), data: { facilityId: F, pendingId } });
  await rejects(svc.respondMembership({ auth: invitee("u3", "new@example.jp"), data: { pendingId, accept: true } }), "failed-precondition");
  for (const u of ["u1", "u2", "u3"]) assert.equal((await mem(F, u)).exists, false);
});

test("参加確認: 30日の期限をサーバーで確認する(期限切れは一覧に出ず、承認できない)。再登録すると、今日から30日で承認できる", async () => {
  const { pendingId } = await add(user("adminA"), { name: "新人", email: "new@example.jp", role: "orderer" });
  const me = invitee("newUid", "new@example.jp");
  clock.t = T0 + 30 * DAY - 1000;
  assert.equal((await svc.listMyPendingMemberships({ auth: me })).memberships.length, 1, "期限の直前は有効");
  clock.t = T0 + 30 * DAY;
  assert.deepEqual((await svc.listMyPendingMemberships({ auth: me })).memberships, []);
  await rejects(svc.respondMembership({ auth: me, data: { pendingId, accept: true } }), "failed-precondition");
  assert.equal((await mem(F, "newUid")).exists, false);
  // 期限切れでも、二重登録の確認では「有効な参加待ち」とみなさない(追加で上書き)
  const r = await svc.renewPendingMember({ auth: user("subA"), data: { facilityId: F, pendingId } });
  assert.equal(r.expiresAt, new Date(T0 + 60 * DAY).toISOString());
  assert.equal((await svc.respondMembership({ auth: me, data: { pendingId, accept: true } })).status, "joined");
  assert.ok((await logs()).some(l => l.action === "member.preregister.renew"));
});

test("参加確認: 辞退すると所属は作られず「辞退」と記録される。辞退後は承認できず、再登録で参加待ちに戻る", async () => {
  const { pendingId } = await add(user("adminA"), { name: "新人", email: "new@example.jp", role: "orderer" });
  const me = invitee("newUid", "new@example.jp");
  assert.equal((await svc.respondMembership({ auth: me, data: { pendingId, accept: false } })).status, "declined");
  assert.equal((await pend(F, "new@example.jp")).get("status"), "declined");
  assert.equal((await mem(F, "newUid")).exists, false);
  assert.deepEqual((await svc.listMyPendingMemberships({ auth: me })).memberships, []);
  await rejects(svc.respondMembership({ auth: me, data: { pendingId, accept: true } }), "failed-precondition");
  assert.ok((await logs()).some(l => l.action === "member.decline"));
  await svc.renewPendingMember({ auth: user("adminA"), data: { facilityId: F, pendingId } });
  assert.equal((await svc.respondMembership({ auth: me, data: { pendingId, accept: true } })).status, "joined");
});

test("複数施設: 同じメールアドレスを複数の施設に登録でき、施設ごとに別の役割で参加できる。片方の承認・辞退は他方に影響しない", async () => {
  const a = await add(user("adminA"), { name: "新人", email: "new@example.jp", role: "orderer" });
  const b = await svc.addMember({ auth: user("subB"), data: { facilityId: G, name: "新人", email: "new@example.jp", role: "proxy" } });
  const me = invitee("newUid", "new@example.jp");
  assert.deepEqual((await svc.listMyPendingMemberships({ auth: me })).memberships.map(m => [m.facilityId, m.role]).sort(), [[F, "orderer"], [G, "proxy"]]);
  await svc.respondMembership({ auth: me, data: { pendingId: a.pendingId, accept: true } });
  await svc.respondMembership({ auth: me, data: { pendingId: b.pendingId, accept: false } });
  assert.equal((await mem(F, "newUid")).get("role"), "orderer");
  assert.equal((await mem(G, "newUid")).exists, false);
  assert.equal((await pend(G, "new@example.jp")).get("status"), "declined");
});

test("メールアドレスの再利用: 参加は uid で管理する。参加後にそのメールが別の人(別 uid)に割り当てられても、所属は増えない。再登録された場合だけ、新しい uid が参加できる", async () => {
  const { pendingId } = await add(user("adminA"), { name: "前任", email: "shared@example.jp", role: "orderer" });
  await svc.respondMembership({ auth: invitee("oldUid", "shared@example.jp"), data: { pendingId, accept: true } });
  const next = invitee("newUid", "shared@example.jp");
  assert.deepEqual((await svc.listMyPendingMemberships({ auth: next })).memberships, []);
  await rejects(svc.respondMembership({ auth: next, data: { pendingId, accept: true } }), "failed-precondition");
  assert.equal((await mem(F, "newUid")).exists, false);
  // 同じメールの所属があるうちは、再登録もできない(先に前任の所属を削除する)
  await rejects(add(user("adminA"), { name: "後任", email: "shared@example.jp", role: "orderer" }), "already-exists");
  await svc.removeMember({ auth: user("adminA"), data: { facilityId: F, uid: "oldUid" } });
  const again = await add(user("adminA"), { name: "後任", email: "shared@example.jp", role: "orderer" });
  assert.equal((await svc.respondMembership({ auth: next, data: { pendingId: again.pendingId, accept: true } })).status, "joined");
  assert.equal((await mem(F, "oldUid")).exists, false);
});

test("招待コードで既に参加済みの人が承認した場合は、役割を変えず参加待ちだけを消す", async () => {
  await db.doc(`facilities/${F}/members/dupUid`).set({ uid: "dupUid", role: "orderer", email: "dup2@example.jp" });
  const { pendingId } = await add(user("adminA"), { name: "x", email: "dup@example.jp", role: "subadmin" });
  const r = await svc.respondMembership({ auth: invitee("dupUid", "dup@example.jp"), data: { pendingId, accept: true } });
  assert.deepEqual(r, { status: "already-member", facilityId: F, role: "orderer" });
  assert.equal((await mem(F, "dupUid")).get("role"), "orderer", "昇格しない");
  assert.equal((await pend(F, "dup@example.jp")).exists, false);
});

// ================= 役割の変更 =================
const change = (auth, uid, role, f = F) => svc.changeMemberRole({ auth, data: { facilityId: f, uid, role } });

test("役割の変更: 管理者はすべての役割を変更でき、操作履歴に変更前後が残る", async () => {
  assert.deepEqual(await change(user("adminA"), "ordA", "subadmin"), { changed: true, role: "subadmin", fromRole: "orderer" });
  assert.deepEqual(await change(user("adminA"), "subA", "admin"), { changed: true, role: "admin", fromRole: "subadmin" });
  assert.deepEqual(await change(user("adminA"), "proxyA", "proxy"), { changed: false, role: "proxy" });
  assert.equal((await mem(F, "ordA")).get("role"), "subadmin");
  const l = (await logs()).filter(x => x.action === "member.role");
  assert.deepEqual(l.map(x => [x.targetUid, x.fromRole, x.toRole, x.actorUid]).sort(), [["ordA", "orderer", "subadmin", "adminA"], ["subA", "subadmin", "admin", "adminA"]]);
});

test("役割の変更(権限昇格の防止): 副管理者は注文者⇔代行入力者のみ。自分・他の副管理者・管理者の変更や、副管理者・管理者への昇格はできない", async () => {
  assert.equal((await change(user("subA"), "ordA", "proxy")).changed, true);
  assert.equal((await change(user("subA"), "ordA", "orderer")).changed, true);
  await rejects(change(user("subA"), "ordA", "subadmin"), "permission-denied");
  await rejects(change(user("subA"), "ordA", "admin"), "permission-denied");
  await rejects(change(user("subA"), "subA", "admin"), "permission-denied");
  await rejects(change(user("subA"), "subA", "orderer"), "permission-denied");
  await rejects(change(user("subA"), "adminA", "orderer"), "permission-denied");
  for (const uid of ["ordA", "proxyA"]) await rejects(change(user(uid), uid, "admin"), "permission-denied");
  await rejects(change(user("adminB"), "ordA", "admin"), "permission-denied", "他施設の管理者");
  await rejects(change(user("adminA"), "adminB", "orderer", G), "permission-denied");
  await rejects(change(user("adminA"), "ordA", "viewer"), "invalid-argument");
  await rejects(change(user("adminA"), "nobody", "orderer"), "not-found");
  assert.deepEqual([(await mem(F, "subA")).get("role"), (await mem(F, "adminA")).get("role"), (await mem(G, "adminB")).get("role")], ["subadmin", "admin", "admin"]);
});

test("最後の管理者: 降格できない(自分自身も)。別の管理者がいれば降格できる", async () => {
  await rejects(change(user("adminA"), "adminA", "subadmin"), "failed-precondition");
  assert.equal((await mem(F, "adminA")).get("role"), "admin");
  await change(user("adminA"), "subA", "admin");
  assert.equal((await change(user("adminA"), "adminA", "subadmin")).changed, true, "別の管理者がいれば自分を降格できる");
  await rejects(change(user("subA"), "subA", "orderer"), "failed-precondition");
});

// ================= 所属の削除 =================
const remove = (auth, uid, f = F) => svc.removeMember({ auth, data: { facilityId: f, uid } });

test("削除: 副管理者は注文者・代行入力者を削除できる。管理者・副管理者・自分は削除できない。管理者は副管理者を削除できるが、管理者は削除できない", async () => {
  assert.equal((await remove(user("subA"), "proxyA")).removed, true);
  assert.equal((await remove(user("subA"), "ordA")).removed, true);
  await db.doc(`facilities/${F}/members/sub2`).set({ uid: "sub2", role: "subadmin" });
  await rejects(remove(user("subA"), "sub2"), "permission-denied");
  await rejects(remove(user("subA"), "adminA"), "failed-precondition");
  await rejects(remove(user("subA"), "subA"), "failed-precondition");
  assert.equal((await remove(user("adminA"), "sub2")).removed, true);
  await rejects(remove(user("adminA"), "adminA"), "failed-precondition");
  await change(user("adminA"), "subA", "admin");
  await rejects(remove(user("adminA"), "subA"), "failed-precondition", "管理者は先に役割を変更する");
  for (const uid of ["ordB", "stranger"]) await rejects(remove(user(uid), "subA"), "permission-denied");
  const actions = (await logs()).filter(l => l.action === "member.remove").map(l => [l.targetUid, l.targetRole]);
  assert.deepEqual(actions.sort(), [["ordA", "orderer"], ["proxyA", "proxy"], ["sub2", "subadmin"]]);
});

test("削除: 削除した人宛ての参加待ちも消え、その施設に再び参加できない(他施設の参加待ちは残る)", async () => {
  await db.doc(`facilities/${F}/members/ordX`).set({ uid: "ordX", role: "orderer", email: "x@example.jp" });
  await db.doc(`pendingMembers/${pendingIdOf(F, "x@example.jp")}`).set({ facilityId: F, email: "x@example.jp", role: "proxy", status: "pending", expiresAt: Timestamp.fromMillis(T0 + DAY) });
  await svc.addMember({ auth: user("adminB"), data: { facilityId: G, name: "x", email: "x@example.jp", role: "orderer" } });
  await remove(user("adminA"), "ordX");
  assert.equal((await pend(F, "x@example.jp")).exists, false);
  assert.equal((await pend(G, "x@example.jp")).exists, true);
});

// ================= 施設の削除 =================
test("施設の削除: その施設の参加待ちも削除される。他施設の参加待ちは残る。副管理者は施設を削除できない", async () => {
  const a = user("adminZ");
  const { facilityId } = await registration.registerFacility({ auth: a, data: { name: "削除する施設", requestId: crypto.randomUUID() } });
  await svc.addMember({ auth: a, data: { facilityId, name: "x", email: "x@example.jp", role: "orderer" } });
  await svc.addMember({ auth: user("adminB"), data: { facilityId: G, name: "x", email: "x@example.jp", role: "orderer" } });
  await db.doc(`facilities/${facilityId}/members/subZ`).set({ uid: "subZ", role: "subadmin" });
  await rejects(registration.deleteFacility({ auth: user("subZ"), data: { facilityId } }), "permission-denied");
  await db.doc(`facilities/${facilityId}/members/subZ`).delete();
  await registration.deleteFacility({ auth: a, data: { facilityId } });
  assert.equal((await pend(facilityId, "x@example.jp")).exists, false);
  assert.equal((await pend(G, "x@example.jp")).exists, true);
});

test("施設名の変更は管理者のみ(副管理者は不可)", async () => {
  const a = user("adminZ");
  const { facilityId } = await registration.registerFacility({ auth: a, data: { name: "名前変更の施設", requestId: crypto.randomUUID() } });
  await db.doc(`facilities/${facilityId}/members/subZ`).set({ uid: "subZ", role: "subadmin" });
  await rejects(registration.renameFacility({ auth: user("subZ"), data: { facilityId, name: "乗っ取り" } }), "permission-denied");
  assert.equal((await db.doc(`facilities/${facilityId}`).get()).get("name"), "名前変更の施設");
});

test("参加待ちは、クライアントから直接は作成・承認できない(サーバー経由のみ)。管理者・副管理者は自施設の一覧を読める", async () => {
  await add(user("adminA"), { name: "x", email: "x@example.jp", role: "orderer" });
  const cli = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  await assertSucceeds(getDocs(query(collection(cli("subA"), "pendingMembers"), where("facilityId", "==", F))));
  await assertFails(getDocs(query(collection(cli("ordA"), "pendingMembers"), where("facilityId", "==", F))));
  await assertFails(setDoc(doc(cli("x", { email: "x@example.jp", email_verified: true }), `facilities/${F}/members/x`), { uid: "x", role: "orderer" }));
});
