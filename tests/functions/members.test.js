// 利用者の所属削除(removeMember)のテスト（Firestoreエミュレータ上で実行。実プロジェクトには接続しない）
//   npm run test:functions
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { getDocs, collection } from "firebase/firestore";
import { createMemberService, pendingIdOf } from "../../functions/src/members.js";
import { createRegistrationService } from "../../functions/src/registration.js";

const PROJECT = "demo-iol-functions";
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185").split(":");
const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");

let env, db, service, registration, clock, lookups;

before(async () => {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  db = getFirestore();
  clock = { t: Date.parse("2026-10-24T00:00:00Z") };
  lookups = [];
  service = createMemberService({ db, FieldValue, Timestamp, now: () => clock.t, lookupEmail: async (uid) => { lookups.push(uid); return uid === "legacy" ? "legacy@example.jp" : null; } });
  registration = createRegistrationService({ db, FieldValue, Timestamp, now: () => clock.t });
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(rulesPath, "utf8"), host, port: Number(port) } });
});
after(async () => { await env.clearFirestore(); await env.cleanup(); });

const F = "fac-aaaaaaaaaaaaaaaaaaaaaaaa"; // 招待の発行は施設IDの形式(fac-…)を検証する
const user = (uid, over = {}) => ({ uid, token: { email: `${uid}@example.jp`, email_verified: true, name: `名前-${uid}`, ...over } });
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);
const remove = (auth, data) => service.removeMember({ auth, data });
const exists = async (p) => (await db.doc(p).get()).exists;
const logs = async (f = F) => (await db.collection(`facilities/${f}/auditLogs`).get()).docs.map(d => d.data());

beforeEach(async () => {
  await env.clearFirestore();
  lookups.length = 0;
  clock.t = Date.parse("2026-10-24T00:00:00Z");
  await db.doc(`facilities/${F}`).set({ name: "A眼科", status: "active" });
  await db.doc("facilities/fB").set({ name: "B眼科", status: "active" });
  await db.doc(`facilities/${F}/members/adminA`).set({ uid: "adminA", role: "admin", displayName: "管理者A", email: "admina@example.jp" });
  await db.doc(`facilities/${F}/members/ordA`).set({ uid: "ordA", role: "orderer", displayName: "注文者A", email: "orda@example.jp" });
  await db.doc(`facilities/${F}/members/ordA2`).set({ uid: "ordA2", role: "orderer", displayName: "注文者A2", email: "orda2@example.jp" });
  await db.doc("facilities/fB/members/adminB").set({ uid: "adminB", role: "admin" });
  await db.doc("facilities/fB/members/ordB").set({ uid: "ordB", role: "orderer" });
});

test("施設管理者は、一般注文者の所属を削除できる。所属の削除と操作履歴の記録が同時に行われ、他の所属は変わらない", async () => {
  const r = await remove(user("adminA"), { facilityId: F, uid: "ordA" });
  assert.equal(r.removed, true);
  assert.equal(await exists(`facilities/${F}/members/ordA`), false);
  assert.equal(await exists(`facilities/${F}/members/ordA2`), true);
  assert.equal(await exists(`facilities/${F}/members/adminA`), true);
  assert.equal(await exists("facilities/fB/members/ordB"), true);
  const [log, ...rest] = await logs();
  assert.equal(rest.length, 0);
  assert.equal(log.action, "member.remove");
  assert.equal(log.targetUid, "ordA");
  assert.equal(log.targetRole, "orderer");
  assert.equal(log.targetName, "注文者A");
  assert.equal(log.targetEmail, "orda@example.jp");
  assert.equal(log.actorUid, "adminA");
  assert.equal(log.actorName, "名前-adminA");
  assert.ok(log.at);
});

test("削除と履歴は原子的: 履歴の書き込みが失敗したら、所属も削除されない", async () => {
  await db.doc(`facilities/${F}/auditLogs/taken`).set({ action: "x" });
  const broken = new Proxy(db, { get(t, k) {
    if (k === "collection") return (p) => { const c = t.collection(p); return p.endsWith("/auditLogs") ? { doc: () => c.doc("taken") } : c; }; // 既に存在するIDへの作成 → 失敗
    const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
  } });
  const s = createMemberService({ db: broken, FieldValue, now: () => clock.t });
  await assert.rejects(s.removeMember({ auth: user("adminA"), data: { facilityId: F, uid: "ordA" } }));
  assert.equal(await exists(`facilities/${F}/members/ordA`), true, "member kept when the log could not be written");
  assert.equal((await logs()).length, 1, "no new log");
});

test("削除できない: 管理者自身・他の管理者・最後の管理者(管理者の所属は削除できない)", async () => {
  await rejects(remove(user("adminA"), { facilityId: F, uid: "adminA" }), "failed-precondition");
  await db.doc(`facilities/${F}/members/adminA2`).set({ uid: "adminA2", role: "admin" });
  await rejects(remove(user("adminA"), { facilityId: F, uid: "adminA2" }), "failed-precondition");
  await rejects(remove(user("adminA2"), { facilityId: F, uid: "adminA" }), "failed-precondition");
  for (const u of ["adminA", "adminA2", "ordA"]) assert.equal(await exists(`facilities/${F}/members/${u}`), true);
  assert.equal((await logs()).length, 0);
});

test("削除できない: 一般注文者・所属なし・未認証・メール未確認・他施設の管理者・停止中の施設", async () => {
  await rejects(remove(user("ordA"), { facilityId: F, uid: "ordA2" }), "permission-denied");       // 注文者は削除できない
  await rejects(remove(user("ordA"), { facilityId: F, uid: "ordA" }), "permission-denied");        // 自分自身も
  await rejects(remove(user("stranger"), { facilityId: F, uid: "ordA" }), "permission-denied");
  await rejects(remove(null, { facilityId: F, uid: "ordA" }), "unauthenticated");
  await rejects(remove(user("adminA", { email_verified: false }), { facilityId: F, uid: "ordA" }), "permission-denied");
  await rejects(remove(user("adminB"), { facilityId: F, uid: "ordA" }), "permission-denied");      // 他施設の管理者
  await rejects(remove(user("adminA"), { facilityId: "fB", uid: "ordB" }), "permission-denied");    // 自施設以外の所属
  await rejects(remove(user("adminA"), { facilityId: "nope", uid: "ordA" }), "permission-denied");
  await db.doc(`facilities/${F}`).update({ status: "suspended" });
  await rejects(remove(user("adminA"), { facilityId: F, uid: "ordA" }), "permission-denied");
  for (const p of [`facilities/${F}/members/ordA`, `facilities/${F}/members/ordA2`, "facilities/fB/members/ordB"]) assert.equal(await exists(p), true);
  assert.equal((await logs()).length + (await logs("fB")).length, 0);
});

test("入力の検証: 余分なキー・不正なID・型違いは拒否。存在しない所属・二重の削除は not-found", async () => {
  for (const bad of [null, [], "x", {}, { facilityId: F }, { uid: "ordA" }, { facilityId: F, uid: "ordA", role: "admin" }, { facilityId: F, uid: "a/b" }, { facilityId: 1, uid: "ordA" }, { facilityId: F, uid: "" }]) {
    await rejects(remove(user("adminA"), bad), "invalid-argument");
  }
  await rejects(remove(user("adminA"), { facilityId: F, uid: "nobody" }), "not-found");
  await remove(user("adminA"), { facilityId: F, uid: "ordA" });
  await rejects(remove(user("adminA"), { facilityId: F, uid: "ordA" }), "not-found");
  assert.equal((await logs()).length, 1, "only one log for one removal");
});

test("削除後は、そのユーザーの既存セッション(Security Rules)でも、その施設のデータにアクセスできない", async () => {
  const ordCtx = () => env.authenticatedContext("ordA").firestore();
  await db.doc(`facilities/${F}/orderers/o1`).set({ facilityId: F, name: "山田" });
  assert.equal((await getDocs(collection(ordCtx(), `facilities/${F}/orderers`))).size, 1);
  await remove(user("adminA"), { facilityId: F, uid: "ordA" });
  for (const sub of ["orderers", "adoptedIols", "facilityDealers", "orders", "members", "auditLogs"]) {
    await assertFails(getDocs(collection(ordCtx(), `facilities/${F}/${sub}`)));
  }
  // 他の注文者・管理者は影響を受けない
  assert.equal((await getDocs(collection(env.authenticatedContext("ordA2").firestore(), `facilities/${F}/orderers`))).size, 1);
});

test("所属にメールが記録されていない古い所属でも、認証情報のメールで、その人宛ての参加待ちを取り消す。旧招待コードのデータには触れない", async () => {
  await db.doc(`facilities/${F}/members/legacy`).set({ uid: "legacy", role: "orderer" });
  await db.doc(`pendingMembers/${pendingIdOf(F, "legacy@example.jp")}`).set({ facilityId: F, email: "legacy@example.jp", role: "proxy", status: "pending" });
  await db.doc("invites/legacy-hash").set({ facilityId: F, email: "legacy@example.jp", status: "pending" });   // 旧方式の残りのデータ(使用不能)
  const r = await remove(user("adminA"), { facilityId: F, uid: "legacy" });
  assert.deepEqual(r, { removed: true });
  assert.deepEqual(lookups, ["legacy"]);
  assert.equal(await exists(`pendingMembers/${pendingIdOf(F, "legacy@example.jp")}`), false);
  assert.equal((await db.doc("invites/legacy-hash").get()).get("status"), "pending", "旧データは変更しない");
  assert.equal((await logs())[0].targetEmail, "legacy@example.jp");
});

test("操作履歴は削除後も残り、所属を削除された人の履歴(誰が・いつ・誰を)を後から確認できる", async () => {
  await remove(user("adminA"), { facilityId: F, uid: "ordA" });
  await remove(user("adminA"), { facilityId: F, uid: "ordA2" });
  const l = await logs();
  assert.deepEqual(l.map(x => x.targetUid).sort(), ["ordA", "ordA2"]);
  assert.ok(l.every(x => x.actorUid === "adminA" && x.action === "member.remove"));
});
