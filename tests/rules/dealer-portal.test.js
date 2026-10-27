// ディーラー専用画面の新しい領域の Rules テスト(エミュレータ)。クライアントからは誰も読み書きできない(サーバーだけが扱う)。  npm run test:rules
import test, { before, after, beforeEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, setDoc, deleteDoc, collection, collectionGroup, query, where } from "firebase/firestore";

const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
let env;
before(async () => { env = await initializeTestEnvironment({ projectId: "demo-iol-rules-dealer", firestore: { rules: fs.readFileSync(rulesPath, "utf8"), host, port: Number(port) } }); });
after(async () => { await env.clearFirestore(); await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "facilities/fA"), { name: "A", status: "active" });
    await setDoc(doc(db, "facilities/fA/members/adminA"), { uid: "adminA", role: "admin" });
    await setDoc(doc(db, "facilities/fA/facilityDealers/d1"), { facilityId: "fA", name: "X" });
    await setDoc(doc(db, "facilities/fA/dealerPortalLinks/d1"), { companyId: "c1", status: "active", currentGrantId: "g1" });
    await setDoc(doc(db, "dealerCompanies/c1"), { name: "X", status: "active" });
    await setDoc(doc(db, "dealerCompanies/c1/staff/x1"), { uid: "x1", status: "active", role: "companyAdmin" });
    await setDoc(doc(db, "dealerCompanies/c1/receipts/r1"), { facilityId: "fA" });
    await setDoc(doc(db, "dealerPortalGrants/g1"), { companyId: "c1", facilityId: "fA", status: "active" });
    await setDoc(doc(db, "dealerStaffIndex/x1"), { companyIds: ["c1"] });
    await setDoc(doc(db, "dealerCompanyInvitations/i1"), { companyId: "c1", email: "x1@corp.example.jp" });
  });
});

const PATHS = ["dealerCompanies/c1", "dealerCompanies/c1/staff/x1", "dealerCompanies/c1/receipts/r1", "dealerCompanies/c1/branches/b1",
  "dealerPortalGrants/g1", "dealerPortalAuditLogs/l1", "dealerStaffIndex/x1", "dealerCompanyInvitations/i1", "facilities/fA/dealerPortalLinks/d1"];

test("ディーラーの担当者・施設の管理者・運営者・未ログインのいずれも、新しい領域を読み書きできない(自己登録・許可の偽装を防ぐ)", async () => {
  const clients = [
    env.authenticatedContext("x1", { email: "x1@corp.example.jp", email_verified: true }).firestore(),
    env.authenticatedContext("adminA", { email: "a@example.jp", email_verified: true }).firestore(),
    env.authenticatedContext("ops", { email: "o@example.jp", email_verified: true, platformAdmin: true }).firestore(),
    env.unauthenticatedContext().firestore()
  ];
  for (const db of clients) {
    for (const p of PATHS) {
      await assertFails(getDoc(doc(db, p)));
      await assertFails(setDoc(doc(db, p), { status: "active", companyIds: ["c1"], uid: "x1" }));
      await assertFails(deleteDoc(doc(db, p)));
    }
    await assertFails(getDocs(collection(db, "dealerCompanies")));
    await assertFails(getDocs(collection(db, "dealerPortalGrants")));
    await assertFails(getDocs(query(collectionGroup(db, "receipts"), where("facilityId", "==", "fA"))));
  }
  // 既存の権限は変わらない: 施設の管理者は自施設のディーラー設定を読める
  await assertSucceeds(getDoc(doc(clients[1], "facilities/fA/facilityDealers/d1")));
});
