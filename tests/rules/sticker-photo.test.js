// IOL シール写真(R09)の領域の Rules テスト(エミュレータ)。クライアントからは誰も読み書きできない(サーバーだけが扱う)。
// Firestore は未定義のパスも拒否するので、Rules に明示されていることは本文で確かめる。あわせて一覧に必要な複合インデックスも確かめる。
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, collectionGroup, query, where } from "firebase/firestore";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rules = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");

const TOP_LEVEL = ["stickerEntries", "stickerPhotoGrants", "stickerAuditLogs", "stickerRateLimits"];
const FACILITY = ["stickerSettings", "stickerPhotos", "stickerSessions", "stickerUsage"];
const PATHS = [
  "stickerEntries/token1", "stickerPhotoGrants/fA_d1", "stickerAuditLogs/l1", "stickerRateLimits/r1",
  "facilities/fA/stickerSettings/access", "facilities/fA/stickerSettings/entry", "facilities/fA/stickerPhotos/p1",
  "facilities/fA/stickerSessions/s1", "facilities/fA/stickerUsage/20261105"
];

let env;
before(async () => { env = await initializeTestEnvironment({ projectId: "demo-iol-rules-sticker", firestore: { rules, host, port: Number(port) } }); });
after(async () => { await env.clearFirestore(); await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "facilities/fA"), { name: "A", status: "active" });
    await setDoc(doc(db, "facilities/fA/members/adminA"), { uid: "adminA", role: "admin" });
    await setDoc(doc(db, "facilities/fA/members/subA"), { uid: "subA", role: "subadmin" });
    await setDoc(doc(db, "facilities/fA/members/ordererA"), { uid: "ordererA", role: "orderer" });
    await setDoc(doc(db, "facilities/fA/orders/o1"), { facilityId: "fA", status: "accepted" });
    await setDoc(doc(db, "facilities/fA/orderSurgeryIndex/i1"), { orderId: "o1", deleted: false });
    await setDoc(doc(db, "dealerPortalGrants/g1"), { companyId: "c1", facilityId: "fA", status: "active" });
    await setDoc(doc(db, "dealerCompanies/c1"), { name: "X", status: "active" });
    for (const p of PATHS) await setDoc(doc(db, p), { facilityId: "fA", companyId: "c1", status: "stored", storagePath: "fA/p1.jpg" });
  });
});

const verified = (uid, extra = {}) => env.authenticatedContext(uid, { email: `${uid}@example.jp`, email_verified: true, ...extra }).firestore();

test("所属者・管理者・運営者・未ログインのいずれも、写真の領域を読み書きできない", async () => {
  const clients = [verified("adminA"), verified("subA"), verified("ordererA"), verified("outsider"), verified("ops", { platformAdmin: true }), env.unauthenticatedContext().firestore()];
  for (const db of clients) {
    for (const p of PATHS) {
      await assertFails(getDoc(doc(db, p)));
      await assertFails(setDoc(doc(db, p), { status: "stored" }));
      await assertFails(updateDoc(doc(db, p), { status: "deleted" }));
      await assertFails(deleteDoc(doc(db, p)));
    }
    for (const name of TOP_LEVEL) await assertFails(getDocs(collection(db, name)));
    for (const name of FACILITY) await assertFails(getDocs(collection(db, `facilities/fA/${name}`)));
  }
});

test("写真の記録は所属者でも直接読めない(一覧の問い合わせ・collectionGroup を含む)", async () => {
  const db = verified("ordererA");
  await assertFails(getDocs(query(collection(db, "facilities/fA/stickerPhotos"), where("facilityId", "==", "fA"))));
  await assertFails(getDocs(query(collection(db, "facilities/fA/stickerPhotos"), where("status", "==", "stored"))));
  await assertFails(getDocs(query(collectionGroup(db, "stickerPhotos"), where("facilityId", "==", "fA"))));
});

test("写真の共有の許可は、ディーラーの担当者が読めず、受注の閲覧の許可の領域とも別", async () => {
  const dealer = verified("x1");
  await assertFails(getDocs(query(collection(dealer, "stickerPhotoGrants"), where("companyId", "==", "c1"))));
  await assertFails(getDoc(doc(dealer, "stickerPhotoGrants/fA_d1")));
  await assertFails(getDoc(doc(dealer, "dealerPortalGrants/g1")));
});

test("既存の領域は変わらない: 所属者は施設・注文・索引を読め、ディーラーの領域は読めない", async () => {
  const member = verified("ordererA");
  await assertSucceeds(getDoc(doc(member, "facilities/fA")));
  await assertSucceeds(getDoc(doc(member, "facilities/fA/orders/o1")));
  await assertSucceeds(getDoc(doc(member, "facilities/fA/orderSurgeryIndex/i1")));
  await assertSucceeds(getDocs(query(collectionGroup(member, "members"), where("uid", "==", "ordererA"))));
  await assertFails(getDoc(doc(member, "dealerCompanies/c1")));
  await assertFails(getDoc(doc(member, "dealerPortalGrants/g1")));
  await assertFails(getDoc(doc(verified("outsider"), "facilities/fA/orders/o1")));
});

test("Rules に、写真の領域がすべて明示的な全拒否として書かれている", () => {
  const denied = (name) => new RegExp(`match /${name}/\\{\\w+\\} \\{\\s*allow read, write: if false;\\s*\\}`).test(rules);
  for (const name of [...TOP_LEVEL, ...FACILITY]) assert.ok(denied(name), `${name} が全拒否でない`);
  const facilityBlock = rules.slice(rules.indexOf("match /facilities/{fid} {"), rules.indexOf("match /invites/{inviteId}"));
  for (const name of FACILITY) assert.ok(facilityBlock.includes(`match /${name}/`), `${name} は施設の下`);
  for (const name of TOP_LEVEL) assert.ok(!facilityBlock.includes(`match /${name}/`), `${name} は最上位`);
});

test("複合インデックス: stickerPhotos の一覧(status・takenAt 降順)があり、既存のものは残っている", () => {
  const { indexes } = JSON.parse(fs.readFileSync(path.join(ROOT, "firestore.indexes.json"), "utf8"));
  const sticker = indexes.filter(i => i.collectionGroup.startsWith("sticker"));
  assert.deepEqual(sticker, [{
    collectionGroup: "stickerPhotos",
    queryScope: "COLLECTION",
    fields: [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "takenAt", order: "DESCENDING" }]
  }]);
  assert.deepEqual(indexes.filter(i => !i.collectionGroup.startsWith("sticker")).map(i => i.collectionGroup), ["orderSurgeryIndex", "invites"]);
});
