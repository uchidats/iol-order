// 施設設定の変更履歴(settings-audit)のテスト（Firestoreエミュレータ上で実行。実プロジェクトには接続しない）
//   npm run test:functions
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { createSettingsAuditService } from "../../functions/src/settings-audit.js";

const PROJECT = "demo-iol-functions";
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185").split(":");
const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");
let env, db, audit;

before(async () => {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  db = getFirestore();
  audit = createSettingsAuditService({ db, FieldValue });
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(rulesPath, "utf8"), host, port: Number(port) } });
});
after(async () => { await env.clearFirestore(); await env.cleanup(); });

const F = "fA";
beforeEach(async () => {
  await env.clearFirestore();
  await db.doc(`facilities/${F}`).set({ name: "A眼科", status: "active" });
  await db.doc(`facilities/${F}/members/adminA`).set({ uid: "adminA", role: "admin", displayName: "管理 太郎" });
  await db.doc(`facilities/${F}/members/ordA`).set({ uid: "ordA", role: "orderer" });
});
const logs = async () => (await db.collection(`facilities/${F}/auditLogs`).get()).docs.map(d => ({ id: d.id, ...d.data() }));
const T = "2026-10-25T03:00:00.000Z";
const at = (iso) => Timestamp.fromDate(new Date(iso));
// 画面からの更新(Rules で検証済みの updatedBy と、この書き込みの時刻)。Auth Context は未確定(unknown)とする
const ev = (over = {}) => ({
  eventId: "evt-1", collection: "facilityDealers", facilityId: F, docId: "d1",
  before: { name: "A商会", orderEmails: ["a@one.jp"], updatedAt: at("2026-10-24T00:00:00Z") },
  after: { name: "A商会", orderEmails: ["z@other.jp"], updatedAt: at(T), updatedBy: "adminA" },
  authType: "unknown", authId: undefined, time: T, ...over
});

test("発注用メールの変更: 変更者(uid・この施設の表示名)・日時・変更内容(伏せ字)を記録。アドレスそのものは残さない", async () => {
  assert.equal(await audit.recordSettingChange(ev()), "recorded");
  const [l] = await logs();
  assert.equal(l.id, "s_evt-1");
  assert.equal(l.action, "settings.facilityDealers.update");
  assert.deepEqual(l.target, { collection: "facilityDealers", id: "d1", label: "A商会" });
  assert.deepEqual([l.actorType, l.actorUid, l.actorName, l.actorSource, l.actorVerified, l.changedAt], ["user", "adminA", "管理 太郎", "updatedBy", true, T]);
  assert.deepEqual(l.auth, { type: "unknown" });
  assert.ok(l.at, "記録時刻(サーバー時刻)");
  assert.deepEqual(l.changes.orderEmails.added.map(x => x.masked), ["z***@other.jp"]);
  assert.deepEqual(l.changes.orderEmails.removed.map(x => x.masked), ["a***@one.jp"]);
  assert.ok(!JSON.stringify(l).includes("z@other.jp") && !JSON.stringify(l).includes("a@one.jp"));
});

test("重複実行: 同じイベントの再配信・再試行は二重に記録しない", async () => {
  assert.equal(await audit.recordSettingChange(ev()), "recorded");
  assert.equal(await audit.recordSettingChange(ev()), "duplicate");
  await Promise.all([1, 2, 3].map(() => audit.recordSettingChange(ev({ eventId: "evt-2" }))));
  assert.equal((await logs()).length, 2);
});

test("記録しない: 並び順だけの変更・対象外のコレクション・施設が削除済み(施設削除で設定も消えた)", async () => {
  assert.equal(await audit.recordSettingChange(ev({ before: { name: "A", sortOrder: 1 }, after: { name: "A", sortOrder: 2, updatedAt: at(T), updatedBy: "adminA" } })), "skipped");
  assert.equal(await audit.recordSettingChange(ev({ collection: "orders" })), "skipped");
  await db.doc(`facilities/${F}`).delete();
  assert.equal(await audit.recordSettingChange(ev({ eventId: "evt-3", after: null })), "skipped");
  assert.equal((await logs()).length, 0, "削除された施設の下に履歴を作らない");
});

test("サーバー処理(Admin SDK = service_account)による変更は actorType=server・変更者なし。サービスアカウント名は診断用に残す", async () => {
  await audit.recordSettingChange(ev({ eventId: "evt-4", collection: "orderers", docId: "o1", before: { name: "山田", email: "y@clinic.jp" }, after: null, authType: "service_account", authId: "iol-functions-dev@x.iam.gserviceaccount.com" }));
  const [l] = await logs();
  assert.equal(l.action, "settings.orderers.delete");
  assert.deepEqual([l.actorType, l.actorUid, l.target.label], ["server", null, "山田"]);
  assert.deepEqual(l.auth, { type: "service_account", id: "iol-functions-dev@x.iam.gserviceaccount.com" });
  assert.equal(l.changes.email.before.masked, "y***@clinic.jp");
});

test("削除: 同じ一括書き込みの削除の記録(deletionMarks)から変更者を記録する。記録がない削除は変更者不明", async () => {
  await db.doc(`facilities/${F}/deletionMarks/facilityDealers_d1`).set({ collection: "facilityDealers", docId: "d1", deletedBy: "adminA", deletedAt: at(T) });
  await audit.recordSettingChange(ev({ eventId: "evt-5", after: null, time: "2026-10-25T03:00:00.200Z" }));
  await audit.recordSettingChange(ev({ eventId: "evt-6", docId: "d2", after: null }));
  const byId = Object.fromEntries((await logs()).map(l => [l.id, l]));
  assert.deepEqual([byId["s_evt-5"].actorUid, byId["s_evt-5"].actorSource, byId["s_evt-5"].actorName], ["adminA", "deletionMark", "管理 太郎"]);
  assert.deepEqual([byId["s_evt-6"].actorType, byId["s_evt-6"].actorUid], ["unknown", null]);
});

test("旧画面(updatedBy なし)の変更: Auth Context の authId がこの施設の所属の uid のときだけ未検証として記録。それ以外は不明", async () => {
  const old = { before: { name: "A商会", orderEmails: ["a@one.jp"] }, after: { name: "A商会", orderEmails: ["b@one.jp"] } };
  await audit.recordSettingChange(ev({ eventId: "evt-7", ...old, authType: "app_user", authId: "adminA" }));
  await audit.recordSettingChange(ev({ eventId: "evt-8", ...old, authType: "app_user", authId: "not-a-member" }));
  const byId = Object.fromEntries((await logs()).map(l => [l.id, l]));
  assert.deepEqual([byId["s_evt-7"].actorUid, byId["s_evt-7"].actorVerified, byId["s_evt-7"].auth], ["adminA", false, { type: "app_user", idMatchesActor: true }]);
  assert.deepEqual([byId["s_evt-8"].actorType, byId["s_evt-8"].actorUid, byId["s_evt-8"].auth], ["unknown", null, { type: "app_user" }]);
  assert.ok(!JSON.stringify(byId["s_evt-8"]).includes("not-a-member"), "一致しない authId は残さない");
});

test("Rules: 履歴は管理者が読める・注文者は読めない。画面からは誰も作成・変更できない", async () => {
  await audit.recordSettingChange(ev());
  const admin = env.authenticatedContext("adminA").firestore();
  const ord = env.authenticatedContext("ordA").firestore();
  await assertSucceeds(getDoc(doc(admin, `facilities/${F}/auditLogs/s_evt-1`)));
  await assertFails(getDoc(doc(ord, `facilities/${F}/auditLogs/s_evt-1`)));
  await assertFails(setDoc(doc(admin, `facilities/${F}/auditLogs/fake`), { action: "x" }));
});
