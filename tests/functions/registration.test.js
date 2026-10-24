// 施設セルフ登録・招待参加のテスト（Firestoreエミュレータ上で実行。実プロジェクトには接続しない）
//   npm run test:functions
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, getDocs, collection } from "firebase/firestore";
import {
  createRegistrationService, deriveFacilityId, hashToken, nameKey, compareNames, LIMITS
} from "../../functions/src/registration.js";

const PROJECT = "demo-iol-functions"; // demo- プロジェクトはエミュレータ専用
const HOST_PORT = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185";
const [host, port] = HOST_PORT.split(":");
const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");

let env, db, service, clock;

before(async () => {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  db = getFirestore();
  clock = { t: Date.parse("2026-10-24T00:00:00Z") };
  service = createRegistrationService({ db, FieldValue, Timestamp, now: () => clock.t });
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: fs.readFileSync(rulesPath, "utf8"), host, port: Number(port) }
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); clock.t = Date.parse("2026-10-24T00:00:00Z"); });

// ---------- ヘルパー ----------
const user = (uid, over = {}) => ({ uid, token: { email: `${uid}@example.jp`, email_verified: true, name: `名前-${uid}`, ...over } });
const uuid = () => crypto.randomUUID();
const reg = (auth, name, extra = {}) => service.registerFacility({ auth, data: { name, requestId: uuid(), ...extra } });
const rejects = (promise, code) => assert.rejects(promise, (e) => e.code === code, `expected ${code}`);
const count = async (p) => (await db.collection(p).get()).size;
const seedFacility = (id, name, extra = {}) => db.doc(`facilities/${id}`).set({ name, status: "active", ...extra });
const seedMember = (fid, uid, role = "orderer", status = "active") => db.doc(`facilities/${fid}/members/${uid}`).set({ uid, role, status });

// ================= 新規施設登録 =================
test("正常系: 施設・最初の管理者の所属・利用枠が作成され、IDはサーバーが生成する", async () => {
  const a = user("userA");
  const requestId = uuid();
  const r = await service.registerFacility({ auth: a, data: { name: "  新しい　クリニック ", requestId } });
  assert.equal(r.status, "created");
  assert.equal(r.facilityId, deriveFacilityId("userA", requestId));
  assert.match(r.facilityId, /^fac-[0-9a-f]{24}$/);

  const fac = (await db.doc(`facilities/${r.facilityId}`).get()).data();
  assert.equal(fac.name, "新しい クリニック"); // 正規化(全角空白→半角・前後の空白除去)
  assert.equal(fac.status, "active");
  assert.equal(fac.createdBy, "userA");
  assert.equal(fac.selfRegistered, true);
  assert.ok(fac.createdAt && fac.updatedAt);

  const mem = (await db.doc(`facilities/${r.facilityId}/members/userA`).get()).data();
  assert.equal(mem.role, "admin");
  assert.equal(mem.status, "active");
  assert.equal(mem.uid, "userA");
  assert.equal((await db.doc("registrationQuota/userA").get()).get("count"), 1);
  assert.equal(await count("facilities"), 1);
});

test("施設IDは要求ごとに異なり、クライアントの指定では決まらない", async () => {
  const a = user("userA");
  const r1 = await reg(a, "施設1");
  const r2 = await reg(a, "別の施設2");
  assert.notEqual(r1.facilityId, r2.facilityId);
  for (const bad of [{ facilityId: "tachikawa-hospital" }, { id: "x" }, { uid: "other" }]) {
    await rejects(service.registerFacility({ auth: a, data: { name: "施設3", requestId: uuid(), ...bad } }), "invalid-argument");
  }
});

test("未ログイン・メール未確認・メールなしは拒否され、何も書き込まれない", async () => {
  const data = { name: "施設", requestId: uuid() };
  await rejects(service.registerFacility({ auth: null, data }), "unauthenticated");
  await rejects(service.registerFacility({ auth: undefined, data }), "unauthenticated");
  await rejects(service.registerFacility({ auth: { uid: "" }, data }), "unauthenticated");
  await rejects(service.registerFacility({ auth: user("u1", { email_verified: false }), data }), "permission-denied");
  await rejects(service.registerFacility({ auth: user("u1", { email_verified: undefined }), data }), "permission-denied");
  await rejects(service.registerFacility({ auth: user("u1", { email_verified: "true" }), data }), "permission-denied");
  await rejects(service.registerFacility({ auth: user("u1", { email: undefined }), data }), "permission-denied");
  assert.equal(await count("facilities"), 0);
  assert.equal(await count("registrationQuota"), 0);
});

test("入力検証: 空・長すぎる施設名、不正なリクエストID、未知のキー(権限の指定)は拒否", async () => {
  const a = user("userA");
  const ok = { name: "施設", requestId: uuid() };
  for (const bad of [
    { ...ok, name: "" }, { ...ok, name: "   " }, { ...ok, name: "あ".repeat(101) }, { ...ok, name: 123 }, { ...ok, name: undefined },
    { ...ok, requestId: "short" }, { ...ok, requestId: "x".repeat(65) }, { ...ok, requestId: "../../etc/passwd-xxxxxxxx" }, { name: "施設" },
    { ...ok, confirmDuplicate: "yes" },
    { ...ok, role: "admin" }, { ...ok, platformAdmin: true }, { ...ok, claims: { platformAdmin: true } }, { ...ok, status: "active" }
  ]) {
    await rejects(service.registerFacility({ auth: a, data: bad }), "invalid-argument");
  }
  for (const bad of [null, undefined, "x", 1, []]) {
    await rejects(service.registerFacility({ auth: a, data: bad }), "invalid-argument");
  }
  assert.equal(await count("facilities"), 0);
});

test("整合性: 途中で失敗したらロールバックされ(施設も利用枠も作られない)、同じ要求の再試行で成功する", async () => {
  const a = user("userA");
  const requestId = uuid();
  const fid = deriveFacilityId("userA", requestId);
  // 管理者所属の作成だけが失敗する状況を作る（所属ドキュメントが既に存在）
  await db.doc(`facilities/${fid}/members/userA`).set({ uid: "userA", role: "orderer", status: "active" });
  await assert.rejects(service.registerFacility({ auth: a, data: { name: "施設", requestId } }));
  assert.equal((await db.doc(`facilities/${fid}`).get()).exists, false, "施設だけが残ってはいけない");
  assert.equal((await db.doc("registrationQuota/userA").get()).exists, false, "利用枠だけが消費されてはいけない");

  await db.doc(`facilities/${fid}/members/userA`).delete(); // 障害が解消
  const r = await service.registerFacility({ auth: a, data: { name: "施設", requestId } });
  assert.equal(r.status, "created");
  assert.equal((await db.doc(`facilities/${fid}/members/userA`).get()).get("role"), "admin");
  assert.equal((await db.doc("registrationQuota/userA").get()).get("count"), 1);
});

test("冪等性: 同じ要求の再送は同じ施設を返し、重複作成も利用枠の二重消費もしない", async () => {
  const a = user("userA");
  const data = { name: "施設", requestId: uuid() };
  const r1 = await service.registerFacility({ auth: a, data });
  const r2 = await service.registerFacility({ auth: a, data });
  assert.deepEqual([r1.status, r2.status], ["created", "exists"]);
  assert.equal(r1.facilityId, r2.facilityId);
  assert.equal(await count("facilities"), 1);
  assert.equal((await db.doc("registrationQuota/userA").get()).get("count"), 1);
  // 別ユーザーが同じ requestId を使っても別IDになり、他人の施設を奪えない
  const rb = await service.registerFacility({ auth: user("userB"), data: { name: "別施設", requestId: data.requestId } });
  assert.notEqual(rb.facilityId, r1.facilityId);
});

test("同時実行: 同じ要求の並列送信でも施設は1つだけ", async () => {
  const a = user("userA");
  const data = { name: "施設", requestId: uuid() };
  const results = await Promise.all(Array.from({ length: 8 }, () => service.registerFacility({ auth: a, data })));
  assert.equal(results.filter(r => r.status === "created").length, 1);
  assert.equal(new Set(results.map(r => r.facilityId)).size, 1);
  assert.equal(await count("facilities"), 1);
  assert.equal((await db.doc("registrationQuota/userA").get()).get("count"), 1);
  assert.equal(await count("facilities/" + results[0].facilityId + "/members"), 1);
});

test("同時実行: 同じ名前で別の要求(別タブの二重送信)でも、確認なしでは1施設だけ作られる", async () => {
  const a = user("userA");
  const results = await Promise.all(Array.from({ length: 6 }, () => reg(a, "二重送信クリニック")));
  assert.equal(results.filter(r => r.status === "created").length, 1);
  assert.equal(results.filter(r => r.status === "duplicate-candidate").length, 5);
  assert.equal(await count("facilities"), 1);
  assert.equal((await db.doc("registrationQuota/userA").get()).get("count"), 1);
});

test("同時実行: 別ユーザーの並列登録は互いに干渉せず、それぞれが自分の施設の管理者になる", async () => {
  const users = ["u1", "u2", "u3", "u4"].map(u => user(u));
  const results = await Promise.all(users.map((u, i) => reg(u, `独立した施設${i}`)));
  assert.ok(results.every(r => r.status === "created"));
  assert.equal(await count("facilities"), 4);
  for (const [i, u] of users.entries()) {
    const mems = await db.collection(`facilities/${results[i].facilityId}/members`).get();
    assert.deepEqual(mems.docs.map(d => d.id), [u.uid]);
  }
});

test("重複候補: 既存施設と同名・類似なら登録せず、他施設の名前やIDは返さない", async () => {
  await seedFacility("tachikawa-hospital", "立川病院", { createdBy: "x" });
  await seedMember("tachikawa-hospital", "adminT", "admin");
  const a = user("userA");
  for (const name of ["立川病院", "立川 病院", "立川病院 ", "立川　病院"]) {
    const r = await reg(a, name);
    assert.equal(r.status, "duplicate-candidate", name);
    assert.equal(r.exact, true);
    assert.deepEqual(Object.keys(r).sort(), ["exact", "similarCount", "status"]);
  }
  const similar = await reg(a, "立川病院眼科");
  assert.equal(similar.status, "duplicate-candidate");
  assert.equal(similar.exact, false);
  assert.equal(await count("facilities"), 1, "候補検出時は何も作成されない");
  assert.equal((await db.doc("registrationQuota/userA").get()).exists, false);
  // 無関係な名前はそのまま登録できる
  assert.equal((await reg(a, "山田クリニック")).status, "created");
});

test("重複候補でも、利用者が同名施設と確認(confirmDuplicate)すれば登録できる。既存施設は変更されない", async () => {
  await seedFacility("tachikawa-hospital", "立川病院", { createdBy: "x" });
  await seedMember("tachikawa-hospital", "adminT", "admin");
  const before = (await db.doc("facilities/tachikawa-hospital").get()).data();
  const r = await reg(user("userA"), "立川病院", { confirmDuplicate: true });
  assert.equal(r.status, "created");
  assert.equal(await count("facilities"), 2);
  assert.deepEqual((await db.doc("facilities/tachikawa-hospital").get()).data(), before);
  assert.deepEqual((await db.collection("facilities/tachikawa-hospital/members").get()).docs.map(d => d.id), ["adminT"]);
});

test("セルフ登録の上限(1ユーザー3施設)を超えると拒否され、何も作られない", async () => {
  const a = user("userA");
  const names = ["アルファ眼科", "ベータ医院", "ガンマ病院"];
  assert.equal(names.length, LIMITS.maxFacilitiesPerUser);
  for (const n of names) assert.equal((await reg(a, n)).status, "created");
  await rejects(reg(a, "四つ目の施設"), "resource-exhausted");
  assert.equal(await count("facilities"), LIMITS.maxFacilitiesPerUser);
  assert.equal((await db.doc("registrationQuota/userA").get()).get("count"), LIMITS.maxFacilitiesPerUser);
  assert.equal((await reg(user("userB"), "他ユーザーは別枠")).status, "created");
});

test("施設ID導出が衝突する他人の施設を上書き・奪取できない", async () => {
  const requestId = uuid();
  const fid = deriveFacilityId("userA", requestId);
  await seedFacility(fid, "先に存在", { createdBy: "someoneElse" });
  await rejects(service.registerFacility({ auth: user("userA"), data: { name: "新規", requestId } }), "already-exists");
  assert.equal((await db.doc(`facilities/${fid}`).get()).get("name"), "先に存在");
  assert.equal((await db.doc(`facilities/${fid}/members/userA`).get()).exists, false);
});

test("名前の類似判定", () => {
  const k = nameKey;
  assert.equal(compareNames(k("立川病院"), k("立川 病院")), "exact");
  assert.equal(compareNames(k("ABC Clinic"), k("abc-clinic")), "exact");
  assert.equal(compareNames(k("立川病院"), k("立川病院眼科")), "similar");
  assert.equal(compareNames(k("sakura clinic"), k("sakura clinik")), "similar");
  assert.equal(compareNames(k("立川病院"), k("山田クリニック")), null);
  assert.equal(compareNames(k("病院"), k("立川病院")), null, "短すぎる共通部分では類似としない");
  assert.equal(compareNames("", k("x")), null);
});

// ================= 招待 =================
async function setupFacilityWithAdmin(uid = "adminA", name = "招待テスト施設") {
  const admin = user(uid);
  const r = await reg(admin, name);
  return { admin, facilityId: r.facilityId };
}

test("招待: 施設管理者だけが発行でき、保存されるのはトークンのハッシュのみ", async () => {
  const { admin, facilityId } = await setupFacilityWithAdmin();
  const r = await service.createInvite({ auth: admin, data: { facilityId, email: "Nurse@Example.JP " } });
  assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(r.email, "nurse@example.jp");
  assert.equal(r.expiresAt, new Date(clock.t + LIMITS.inviteTtlMs).toISOString());

  const snap = await db.collection("invites").get();
  assert.equal(snap.size, 1);
  assert.equal(snap.docs[0].id, hashToken(r.token));
  const d = snap.docs[0].data();
  assert.deepEqual([d.facilityId, d.email, d.role, d.status, d.createdBy], [facilityId, "nurse@example.jp", "orderer", "pending", "adminA"]);
  assert.ok(!JSON.stringify([snap.docs[0].id, d]).includes(r.token), "トークン本体は保存しない");
});

test("招待: 管理者以外・他施設の管理者・未確認ユーザー・停止中の施設では発行できない", async () => {
  const { facilityId } = await setupFacilityWithAdmin();
  await seedMember(facilityId, "ordererA", "orderer");
  const other = await reg(user("adminB"), "別の施設B");
  const body = { facilityId, email: "x@example.jp" };
  await rejects(service.createInvite({ auth: user("ordererA"), data: body }), "permission-denied");
  await rejects(service.createInvite({ auth: user("stranger"), data: body }), "permission-denied");
  await rejects(service.createInvite({ auth: user("adminB"), data: body }), "permission-denied");
  await rejects(service.createInvite({ auth: user("adminA", { email_verified: false }), data: body }), "permission-denied");
  await rejects(service.createInvite({ auth: null, data: body }), "unauthenticated");
  await db.doc(`facilities/${facilityId}`).update({ status: "suspended" });
  await rejects(service.createInvite({ auth: user("adminA"), data: body }), "permission-denied");
  assert.equal(await count("invites"), 0);
  assert.ok(other.facilityId);
});

test("招待: 権限(role)の指定や不正なメール・未知のキーは拒否。発行されるのは常に orderer", async () => {
  const { admin, facilityId } = await setupFacilityWithAdmin();
  for (const bad of [
    { facilityId, email: "x@example.jp", role: "admin" }, { facilityId, email: "x@example.jp", platformAdmin: true },
    { facilityId, email: "broken" }, { facilityId, email: "" }, { facilityId, email: "a@" + "x".repeat(250) + ".jp" },
    { facilityId: "../x", email: "x@example.jp" }, { email: "x@example.jp" }
  ]) {
    await rejects(service.createInvite({ auth: admin, data: bad }), "invalid-argument");
  }
  assert.equal(await count("invites"), 0);
});

test("招待: 未使用の招待が上限を超えると発行できない", async () => {
  const { admin, facilityId } = await setupFacilityWithAdmin();
  for (let i = 0; i < LIMITS.maxPendingInvitesPerFacility; i++) {
    await service.createInvite({ auth: admin, data: { facilityId, email: `u${i}@example.jp` } });
  }
  await rejects(service.createInvite({ auth: admin, data: { facilityId, email: "over@example.jp" } }), "resource-exhausted");
});

test("参加: 招待されたメールアドレスの確認済みアカウントだけが参加でき、orderer 権限になる", async () => {
  const { admin, facilityId } = await setupFacilityWithAdmin();
  const { token } = await service.createInvite({ auth: admin, data: { facilityId, email: "nurse@example.jp" } });
  const nurse = user("nurse1", { email: "Nurse@Example.jp" }); // 大文字小文字の違いは同一視
  const r = await service.acceptInvite({ auth: nurse, data: { token } });
  assert.deepEqual(r, { facilityId });
  const mem = (await db.doc(`facilities/${facilityId}/members/nurse1`).get()).data();
  assert.deepEqual([mem.uid, mem.role, mem.status], ["nurse1", "orderer", "active"]);
  const inv = (await db.doc(`invites/${hashToken(token)}`).get()).data();
  assert.equal(inv.status, "used");
  assert.equal(inv.usedBy, "nurse1");
});

test("参加の拒否: 無効・使用済み・期限切れ・別メール宛て・未確認・未ログインは、すべて同じ応答(探索対策)", async () => {
  const { admin, facilityId } = await setupFacilityWithAdmin();
  const { token } = await service.createInvite({ auth: admin, data: { facilityId, email: "nurse@example.jp" } });
  const messages = new Set();
  const fail = async (auth, data, code = "failed-precondition") => {
    await assert.rejects(service.acceptInvite({ auth, data }), (e) => { messages.add(e.message); return e.code === code; });
  };
  await fail(user("x1", { email: "other@example.jp" }), { token });                       // 別のメールアドレス
  await fail(user("x2", { email: "nurse@example.jp" }), { token: "A".repeat(43) });       // 存在しないコード
  await fail(user("x2", { email: "nurse@example.jp" }), { token: "short" });              // 形式不正
  await fail(user("x2", { email: "nurse@example.jp" }), { token: "../../x".padEnd(40, "a") });
  assert.equal(await count(`facilities/${facilityId}/members`), 1, "拒否された試行で所属が増えない");

  await assert.rejects(service.acceptInvite({ auth: user("x3", { email: "nurse@example.jp", email_verified: false }), data: { token } }), (e) => e.code === "permission-denied");
  await assert.rejects(service.acceptInvite({ auth: null, data: { token } }), (e) => e.code === "unauthenticated");

  clock.t += LIMITS.inviteTtlMs + 1;                                                        // 期限切れ
  await fail(user("x4", { email: "nurse@example.jp" }), { token });
  clock.t -= LIMITS.inviteTtlMs + 1;

  await service.acceptInvite({ auth: user("nurse1", { email: "nurse@example.jp" }), data: { token } });
  await fail(user("x5", { email: "nurse@example.jp" }), { token });                       // 使用済み
  assert.equal(messages.size, 1, "失敗理由を区別できない同一メッセージであること");
  assert.equal(await count(`facilities/${facilityId}/members`), 2);
});

test("参加: 同じ招待の同時使用は1回だけ成功する", async () => {
  const { admin, facilityId } = await setupFacilityWithAdmin();
  const { token } = await service.createInvite({ auth: admin, data: { facilityId, email: "nurse@example.jp" } });
  const nurse = user("nurse1", { email: "nurse@example.jp" });
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => service.acceptInvite({ auth: nurse, data: { token } })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(await count(`facilities/${facilityId}/members`), 2);
});

test("参加: 招待で管理者を降格しない / 無効化されていた所属は orderer として再有効化 / 停止中の施設には参加できない", async () => {
  const { admin, facilityId } = await setupFacilityWithAdmin();
  const mk = (email) => service.createInvite({ auth: admin, data: { facilityId, email } });

  const t1 = await mk("adminA@example.jp"); // 管理者自身宛て
  await service.acceptInvite({ auth: admin, data: { token: t1.token } });
  assert.equal((await db.doc(`facilities/${facilityId}/members/adminA`).get()).get("role"), "admin");

  await seedMember(facilityId, "was-disabled", "orderer", "disabled");
  const t2 = await mk("was-disabled@example.jp");
  await service.acceptInvite({ auth: user("was-disabled"), data: { token: t2.token } });
  assert.equal((await db.doc(`facilities/${facilityId}/members/was-disabled`).get()).get("status"), "active");

  const t3 = await mk("late@example.jp");
  await db.doc(`facilities/${facilityId}`).update({ status: "suspended" });
  await assert.rejects(service.acceptInvite({ auth: user("late"), data: { token: t3.token } }), (e) => e.code === "failed-precondition");
  assert.equal((await db.doc(`facilities/${facilityId}/members/late`).get()).exists, false);
});

test("招待なしでは参加できない: サービスに招待以外の参加経路は無く、他人の施設IDを指定しても所属は作られない", async () => {
  const { facilityId } = await setupFacilityWithAdmin();
  const s = user("stranger");
  await assert.rejects(service.acceptInvite({ auth: s, data: { facilityId, token: "A".repeat(43) } }), (e) => e.code === "failed-precondition" || e.code === "invalid-argument");
  await assert.rejects(service.registerFacility({ auth: s, data: { name: "x施設", requestId: uuid(), facilityId } }), (e) => e.code === "invalid-argument");
  assert.equal((await db.doc(`facilities/${facilityId}/members/stranger`).get()).exists, false);
});

// ================= Security Rules との整合（クライアントから見た結果） =================
const as = (uid, claims = {}) => env.authenticatedContext(uid, { email_verified: true, ...claims }).firestore();

test("登録後: 新しい管理者は自施設の設定を読み書きでき、他施設・他ユーザーとは分離される", async () => {
  await seedFacility("tachikawa-hospital", "立川病院", { createdBy: "x" });
  await seedMember("tachikawa-hospital", "adminT", "admin");
  const a = await reg(user("userA"), "新規クリニック");
  const b = await reg(user("userB"), "もう一つの医院");
  const fa = a.facilityId, fb = b.facilityId;

  // 自施設: 読める・設定を書ける
  await assertSucceeds(getDoc(doc(as("userA"), `facilities/${fa}`)));
  await assertSucceeds(setDoc(doc(as("userA"), `facilities/${fa}/orderers/o1`), { facilityId: fa, name: "新規注文者", active: true }));
  await assertSucceeds(getDocs(collection(as("userA"), `facilities/${fa}/members`)));
  // 他施設（立川病院・他の新規施設）は読めない・書けない
  for (const other of ["tachikawa-hospital", fb]) {
    await assertFails(getDoc(doc(as("userA"), `facilities/${other}`)));
    await assertFails(getDocs(collection(as("userA"), `facilities/${other}/orderers`)));
    await assertFails(setDoc(doc(as("userA"), `facilities/${other}/orderers/evil`), { facilityId: other, name: "x", active: true }));
    await assertFails(getDocs(collection(as("userA"), `facilities/${other}/members`)));
  }
  // 立川病院の管理者は新しい施設に入れない
  await assertFails(getDoc(doc(as("adminT"), `facilities/${fa}`)));
  // 自分で admin 権限を付与・自己参加はできない（登録経路を除く）
  await assertFails(setDoc(doc(as("userA"), `facilities/${fb}/members/userA`), { uid: "userA", role: "admin", status: "active" }));
  await assertFails(setDoc(doc(as("userA"), `facilities/${fa}/members/userA`), { uid: "userA", role: "admin", status: "active", extra: 1 }));
});

test("クライアント(運営者権限なし)は施設を作成できない", async () => {
  for (const c of [as("adminA"), as("stranger"), as("opsAdmin", { platformAdmin: false })]) {
    await assertFails(setDoc(doc(c, "facilities/fac-forged-by-client"), { name: "偽施設", status: "active", createdBy: "x", selfRegistered: true }));
  }
});

test("招待と利用枠は、運営者権限を含むどのクライアントからも読み書きできない（サーバー専用）", async () => {
  const { admin, facilityId } = await setupFacilityWithAdmin();
  const { token } = await service.createInvite({ auth: admin, data: { facilityId, email: "nurse@example.jp" } });
  for (const c of [as("adminA"), as("stranger"), as("opsAdmin", { platformAdmin: true })]) {
    await assertFails(getDoc(doc(c, `invites/${hashToken(token)}`)));
    await assertFails(getDocs(collection(c, "invites")));
    await assertFails(setDoc(doc(c, `invites/${hashToken("B".repeat(43))}`), { facilityId, email: "x@example.jp", role: "admin", status: "pending" }));
    await assertFails(getDoc(doc(c, "registrationQuota/adminA")));
    await assertFails(setDoc(doc(c, "registrationQuota/adminA"), { count: 0, keys: [] }));
  }
});

// ================= レート制限・期限切れ招待・複数施設 =================
test("レート制限: 同一ユーザーの連続呼び出しは上限で拒否され、時間経過で回復し、他ユーザーには影響しない", async () => {
  const a = user("userA");
  const fire = () => service.registerFacility({ auth: a, data: { name: "重複確認クリニック", requestId: uuid() } });
  await fire(); // created
  for (let i = 1; i < LIMITS.rateMax.registerFacility; i++) await fire(); // 重複候補の確認も数える
  await rejects(fire(), "resource-exhausted");
  await reg(user("userB"), "別ユーザーの施設"); // 影響なし
  clock.t += LIMITS.rateWindowMs;
  assert.equal((await fire()).status, "duplicate-candidate");
});

test("レート制限: 招待の受諾の失敗連打は上限で拒否され、発行も呼び出し回数が数えられる", async () => {
  const { admin, facilityId } = await setupFacilityWithAdmin();
  await service.createInvite({ auth: admin, data: { facilityId, email: "x@example.jp" } });
  assert.equal((await db.doc("rateLimits/adminA_createInvite").get()).get("count"), 1);
  const bad = { auth: user("guess"), data: { token: "A".repeat(43) } };
  for (let i = 0; i < LIMITS.rateMax.acceptInvite; i++) await rejects(service.acceptInvite(bad), "failed-precondition");
  await rejects(service.acceptInvite(bad), "resource-exhausted");
});

test("招待: 期限切れの未使用招待は上限に数えず、管理者が発行できなくなることはない", async () => {
  const { admin, facilityId } = await setupFacilityWithAdmin();
  for (let i = 0; i < LIMITS.maxPendingInvitesPerFacility; i++) {
    await service.createInvite({ auth: admin, data: { facilityId, email: `u${i}@example.jp` } });
  }
  clock.t += LIMITS.inviteTtlMs + 1;
  const r = await service.createInvite({ auth: admin, data: { facilityId, email: "new@example.jp" } });
  assert.ok(r.token);
});

test("既存施設に所属するユーザーも、上限(3施設)の範囲で新しい施設を登録でき、元の所属は変わらない", async () => {
  const a = user("userA");
  await seedFacility("existing", "既存クリニック");
  await seedMember("existing", "userA", "orderer");
  const r = await reg(a, "二つ目の施設");
  assert.equal(r.status, "created");
  assert.equal((await db.doc("facilities/existing/members/userA").get()).get("role"), "orderer");
  assert.equal((await db.doc(`facilities/${r.facilityId}/members/userA`).get()).get("role"), "admin");
});

test("同じメールアドレス(同一アカウント)が複数施設に所属でき、施設ごとに権限が独立する。別アカウントの同メールは参加できない", async () => {
  const a = user("userA", { email: "dr@example.jp" });
  const f1 = await setupFacilityWithAdmin("adm1", "施設one");
  const f2 = await setupFacilityWithAdmin("adm2", "施設two");
  for (const f of [f1, f2]) {
    const inv = await service.createInvite({ auth: f.admin, data: { facilityId: f.facilityId, email: "DR@example.jp" } });
    assert.deepEqual(await service.acceptInvite({ auth: a, data: { token: inv.token } }), { facilityId: f.facilityId });
  }
  for (const f of [f1, f2]) {
    assert.equal((await db.doc(`facilities/${f.facilityId}/members/userA`).get()).get("role"), "orderer");
  }
  const mine = await db.collectionGroup("members").where("uid", "==", "userA").get();
  assert.equal(mine.size, 2);
  // 別のUIDでも、メール確認済みで同じメールなら招待は使える仕様(メール=本人確認の根拠)。未確認は拒否される
  const inv = await service.createInvite({ auth: f1.admin, data: { facilityId: f1.facilityId, email: "other@example.jp" } });
  await rejects(service.acceptInvite({ auth: user("userX", { email: "other@example.jp", email_verified: false }), data: { token: inv.token } }), "permission-denied");
});
