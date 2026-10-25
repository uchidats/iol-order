// 施設設定の変更者(updatedBy・削除の記録 deletionMarks)の Rules テスト(エミュレータ)。  npm run test:rules
// 現在の firestore.rules(移行中: actorRequired() = false)と、必須にした版(true に置き換えたもの)の両方を確認する。
import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, deleteDoc, writeBatch, serverTimestamp } from "firebase/firestore";

const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
const RULES = fs.readFileSync(rulesPath, "utf8");
const SWITCH = "function actorRequired() { return false; }";
let envs;

before(async () => {
  assert.ok(RULES.includes(SWITCH), "移行中の設定(actorRequired = false)");
  const make = (projectId, rules) => initializeTestEnvironment({ projectId, firestore: { rules, host, port: Number(port) } });
  envs = { transition: await make("demo-iol-rules-actor", RULES), strict: await make("demo-iol-rules-actor-strict", RULES.replace(SWITCH, "function actorRequired() { return true; }")) };
});
after(async () => { for (const e of Object.values(envs)) { await e.clearFirestore(); await e.cleanup(); } });

beforeEach(async () => {
  for (const e of Object.values(envs)) {
    await e.clearFirestore();
    await e.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "facilities/fA"), { name: "A", status: "active" });
      await setDoc(doc(db, "facilities/fA/members/adminA"), { uid: "adminA", role: "admin" });
      await setDoc(doc(db, "facilities/fA/members/subA"), { uid: "subA", role: "subadmin" });
      await setDoc(doc(db, "facilities/fA/members/ordA"), { uid: "ordA", role: "orderer" });
      await setDoc(doc(db, "facilities/fA/orderers/o1"), { facilityId: "fA", name: "山田" });
      await setDoc(doc(db, "facilities/fA/facilityDealers/d1"), { facilityId: "fA", name: "A商会", orderEmails: ["a@one.jp"] });
    });
  }
});

const as = (mode, uid) => envs[mode].authenticatedContext(uid).firestore();
const doctor = (over = {}) => ({ facilityId: "fA", name: "山田", sortOrder: 10, updatedAt: serverTimestamp(), updatedBy: "adminA", ...over });
const delWithMark = (db, col, id, by) => {
  const b = writeBatch(db);
  b.delete(doc(db, `facilities/fA/${col}/${id}`));
  b.set(doc(db, `facilities/fA/deletionMarks/${col}_${id}`), { collection: col, docId: id, deletedBy: by, deletedAt: serverTimestamp() });
  return b.commit();
};

for (const mode of ["transition", "strict"]) {
  test(`[${mode}] 作成・更新の updatedBy は本人の uid と、この書き込みの時刻でなければならない`, async () => {
    const db = as(mode, "adminA");
    await assertSucceeds(setDoc(doc(db, "facilities/fA/orderers/o1"), doctor()));
    await assertSucceeds(setDoc(doc(db, "facilities/fA/orderers/oNew"), doctor({ name: "新任" })));
    await assertFails(setDoc(doc(db, "facilities/fA/orderers/o1"), doctor({ updatedBy: "subA" })), "他人の uid");
    await assertFails(setDoc(doc(db, "facilities/fA/orderers/o1"), doctor({ updatedAt: new Date("2026-01-01T00:00:00Z") })), "古い時刻");
    await assertFails(setDoc(doc(db, "facilities/fA/orderers/o1"), (({ updatedAt, ...rest }) => rest)(doctor())), "時刻なし");
    await assertSucceeds(setDoc(doc(as(mode, "subA"), "facilities/fA/orderers/o1"), doctor({ updatedBy: "subA" })), "副管理者も本人の uid");
    await assertFails(setDoc(doc(as(mode, "ordA"), "facilities/fA/orderers/o1"), doctor({ updatedBy: "ordA" })), "注文者は設定を変更できない");
    // 採用IOL・ディーラーも同じ
    await assertSucceeds(setDoc(doc(db, "facilities/fA/adoptedIols/jj-dib00v"), { facilityId: "fA", catalogIolId: "jj-dib00v", enabled: true, updatedAt: serverTimestamp(), updatedBy: "adminA" }));
    await assertFails(setDoc(doc(db, "facilities/fA/adoptedIols/jj-dib00v"), { facilityId: "fA", catalogIolId: "jj-dib00v", enabled: false, updatedAt: serverTimestamp(), updatedBy: "x" }));
    await assertSucceeds(setDoc(doc(db, "facilities/fA/facilityDealers/d1"), { facilityId: "fA", name: "A商会", orderEmails: ["z@other.jp"], updatedAt: serverTimestamp(), updatedBy: "adminA" }));
    await assertFails(setDoc(doc(db, "facilities/fA/facilityDealers/d1"), { facilityId: "fA", name: "A商会", orderEmails: ["z@other.jp"], updatedAt: serverTimestamp(), updatedBy: "subA" }));
  });

  test(`[${mode}] 削除の記録: 削除と同じ一括書き込みで、本人の uid と時刻を書く。他人の名前・削除なしの単独の記録の読み取りはできない`, async () => {
    const db = as(mode, "adminA");
    await assertFails(delWithMark(db, "orderers", "o1", "subA"), "他人の uid では削除できない");
    await assertSucceeds(delWithMark(db, "orderers", "o1", "adminA"));
    await assertSucceeds(delWithMark(db, "facilityDealers", "d1", "adminA"));
    await assertFails(getDoc(doc(db, "facilities/fA/deletionMarks/orderers_o1")), "記録はクライアントから読めない");
    await assertFails(deleteDoc(doc(db, "facilities/fA/deletionMarks/orderers_o1")), "記録は消せない");
    await assertFails(setDoc(doc(db, "facilities/fA/deletionMarks/orderers_zz"), { collection: "orderers", docId: "other", deletedBy: "adminA", deletedAt: serverTimestamp() }), "IDと内容が一致しない");
    await assertFails(setDoc(doc(db, "facilities/fA/deletionMarks/members_x"), { collection: "members", docId: "x", deletedBy: "adminA", deletedAt: serverTimestamp() }), "対象外のコレクション");
    await assertFails(setDoc(doc(as(mode, "ordA"), "facilities/fA/deletionMarks/orderers_o9"), { collection: "orderers", docId: "o9", deletedBy: "ordA", deletedAt: serverTimestamp() }), "注文者は書けない");
  });
}

for (const mode of ["transition", "strict"]) {
  test(`[${mode}] 削除の記録は、削除と同じ一括書き込みでなければ使えない(先に書いた記録・後から書いた記録では削除できない)`, async () => {
    const db = as(mode, "adminA");
    // 記録だけを先に書いてから、別の書き込みで削除する → 記録の時刻が削除の時刻と違うので拒否
    await assertSucceeds(setDoc(doc(db, "facilities/fA/deletionMarks/orderers_o1"), { collection: "orderers", docId: "o1", deletedBy: "adminA", deletedAt: serverTimestamp() }));
    await assertFails(deleteDoc(doc(db, "facilities/fA/orderers/o1")));
    // 同じ一括書き込みなら削除できる
    await assertSucceeds(delWithMark(db, "orderers", "o1", "adminA"));
  });
}

test("[transition] 移行中は、updatedBy・削除の記録がない旧画面の書き込みも受け付ける(既存の保存・並び替え・削除を止めない)", async () => {
  const db = as("transition", "adminA");
  await assertSucceeds(setDoc(doc(db, "facilities/fA/orderers/o1"), { facilityId: "fA", name: "山田", sortOrder: 20, updatedAt: serverTimestamp() }));
  await assertSucceeds(deleteDoc(doc(db, "facilities/fA/facilityDealers/d1")));
});

test("[strict] 必須にした後は、updatedBy のない作成・更新と、記録のない削除を拒否する", async () => {
  const db = as("strict", "adminA");
  await assertFails(setDoc(doc(db, "facilities/fA/orderers/o1"), { facilityId: "fA", name: "山田", sortOrder: 20, updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(db, "facilities/fA/facilityDealers/d1")));
  await assertSucceeds(delWithMark(db, "facilityDealers", "d1", "adminA"));
});
