// サービス紹介「IOL Orderについて」の本文(platformContent/serviceIntroduction)の Rules テスト(エミュレータ)。  npm run test:rules
// 現在(platformAdmin のみ)と、将来の一般公開(introductionPublic() = true に置き換えたもの)の両方を確認する。
import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, collection, setDoc, deleteDoc } from "firebase/firestore";

const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
const RULES = fs.readFileSync(rulesPath, "utf8");
const SWITCH = "function introductionPublic() { return false; }";
let envs;

before(async () => {
  assert.ok(RULES.includes(SWITCH), "一般公開はしない設定(introductionPublic = false)");
  const make = (projectId, rules) => initializeTestEnvironment({ projectId, firestore: { rules, host, port: Number(port) } });
  envs = { current: await make("demo-iol-rules-content", RULES), released: await make("demo-iol-rules-content-public", RULES.replace(SWITCH, "function introductionPublic() { return true; }")) };
});
after(async () => { for (const e of Object.values(envs)) { await e.clearFirestore(); await e.cleanup(); } });

beforeEach(async () => {
  for (const e of Object.values(envs)) {
    await e.clearFirestore();
    await e.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "platformContent/serviceIntroduction"), { markdown: "# 紹介", sha256: "x" });
      await setDoc(doc(db, "platformContent/other"), { markdown: "別" });
      await setDoc(doc(db, "facilities/fA"), { name: "A", status: "active" });
      await setDoc(doc(db, "facilities/fA/members/adminA"), { uid: "adminA", role: "admin" });
    });
  }
});

const ops = (mode) => envs[mode].authenticatedContext("op", { platformAdmin: true, email_verified: true }).firestore();
const user = (mode, uid) => envs[mode].authenticatedContext(uid, { email_verified: true }).firestore();
const anon = (mode) => envs[mode].unauthenticatedContext().firestore();

test("[現在] 紹介の本文は platformAdmin だけが読める。未ログイン・一般利用者(施設の管理者を含む)は読めない", async () => {
  await assertSucceeds(getDoc(doc(ops("current"), "platformContent/serviceIntroduction")));
  await assertFails(getDoc(doc(user("current", "adminA"), "platformContent/serviceIntroduction")), "施設の管理者");
  await assertFails(getDoc(doc(user("current", "someone"), "platformContent/serviceIntroduction")), "ログインした一般利用者");
  await assertFails(getDoc(doc(anon("current"), "platformContent/serviceIntroduction")), "未ログイン");
  await assertFails(getDoc(doc(user("current", "fake"), "platformContent/serviceIntroduction")), "クレームなし");
  await assertFails(getDoc(doc(envs.current.authenticatedContext("x", { platformAdmin: "true" }).firestore(), "platformContent/serviceIntroduction")), "文字列の true は不可");
});

test("[現在] 一覧・他の文書は読めない。書き込みは運営者を含めクライアントからはできない", async () => {
  await assertFails(getDocs(collection(ops("current"), "platformContent")), "一覧は不可");
  await assertFails(getDoc(doc(ops("current"), "platformContent/other")), "紹介以外の文書");
  for (const db of [ops("current"), user("current", "adminA"), anon("current")]) {
    await assertFails(setDoc(doc(db, "platformContent/serviceIntroduction"), { markdown: "改ざん" }));
    await assertFails(deleteDoc(doc(db, "platformContent/serviceIntroduction")));
  }
});

test("[将来の一般公開] introductionPublic() を true にしたときだけ誰でも読める(書き込み・一覧は不可のまま)", async () => {
  await assertSucceeds(getDoc(doc(anon("released"), "platformContent/serviceIntroduction")));
  await assertSucceeds(getDoc(doc(user("released", "someone"), "platformContent/serviceIntroduction")));
  await assertFails(getDoc(doc(anon("released"), "platformContent/other")));
  await assertFails(getDocs(collection(anon("released"), "platformContent")));
  await assertFails(setDoc(doc(ops("released"), "platformContent/serviceIntroduction"), { markdown: "改ざん" }));
});
