// Firestore Security Rules テスト（Firestoreエミュレータ上で実行。実プロジェクトには接続しない）
//   npm run test:rules
import test, { before, after, beforeEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initializeTestEnvironment, assertSucceeds, assertFails
} from "@firebase/rules-unit-testing";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, collectionGroup, query, where, deleteField, writeBatch, serverTimestamp
} from "firebase/firestore";

const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-iol-rules", // demo- プロジェクトはエミュレータ専用
    firestore: { rules: fs.readFileSync(rulesPath, "utf8"), host, port: Number(port) }
  });
});
after(async () => { await env.cleanup(); });

const member = (uid, role, status = "active") => ({ uid, role, status });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [id, status] of [["fA", "active"], ["fB", "active"], ["fS", "suspended"]]) {
      await setDoc(doc(db, "facilities", id), { name: id, status });
    }
    await setDoc(doc(db, "facilities/fA/members/adminA"), member("adminA", "admin"));
    await setDoc(doc(db, "facilities/fA/members/ordA"), member("ordA", "orderer"));
    await setDoc(doc(db, "facilities/fA/members/offA"), member("offA", "orderer", "disabled"));
    await setDoc(doc(db, "facilities/fB/members/ordB"), member("ordB", "orderer"));
    await setDoc(doc(db, "facilities/fB/members/adminB"), member("adminB", "admin"));
    await setDoc(doc(db, "facilities/fS/members/ordS"), member("ordS", "orderer"));
    for (const f of ["fA", "fB", "fS"]) {
      await setDoc(doc(db, `facilities/${f}/orderers/o1`), { facilityId: f, name: "x", active: true });
      await setDoc(doc(db, `facilities/${f}/adoptedIols/a1`), { facilityId: f, catalogIolId: "c", enabled: true });
      await setDoc(doc(db, `facilities/${f}/facilityDealers/d1`), { facilityId: f, dealerId: "d", name: "n", active: true });
      await setDoc(doc(db, `facilities/${f}/orders/ord1`), { status: "received" });
    }
    await setDoc(doc(db, "iolCatalog/c1"), { model: "m" });
    await setDoc(doc(db, "dealers/dl1"), { name: "dealer", memberUids: ["dealerUid"] });
  });
});

const as = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const platform = () => as("ops", { platformAdmin: true });

// ---------- 未認証・所属なし ----------
test("未認証は何も読めない", async () => {
  const db = anon();
  await assertFails(getDoc(doc(db, "facilities/fA")));
  await assertFails(getDocs(collection(db, "facilities/fA/orderers")));
  await assertFails(getDoc(doc(db, "iolCatalog/c1")));
  await assertFails(getDocs(query(collectionGroup(db, "members"), where("uid", "==", "ordA"))));
});

test("認証済みでも所属が無ければ施設情報・注文者・注文にアクセスできない", async () => {
  const db = as("stranger");
  await assertFails(getDoc(doc(db, "facilities/fA")));
  await assertFails(getDocs(collection(db, "facilities/fA/orderers")));
  await assertFails(getDocs(collection(db, "facilities/fA/adoptedIols")));
  await assertFails(getDocs(collection(db, "facilities/fA/orders")));
  await assertFails(getDocs(collection(db, "facilities")));
});

test("所属確認クエリ: 自分の uid なら成功（結果は空）、他人の uid・無条件は拒否", async () => {
  const db = as("stranger");
  const mine = await assertSucceeds(getDocs(query(collectionGroup(db, "members"), where("uid", "==", "stranger"))));
  if (mine.size !== 0) throw new Error("所属が無い人に所属が返った");
  await assertFails(getDocs(query(collectionGroup(db, "members"), where("uid", "==", "ordA"))));
  await assertFails(getDocs(collectionGroup(db, "members")));
});

test("所属ユーザーは自分の所属だけを取得できる", async () => {
  const db = as("ordA");
  const snap = await assertSucceeds(getDocs(query(collectionGroup(db, "members"), where("uid", "==", "ordA"))));
  if (snap.size !== 1) throw new Error("自分の所属が取得できない");
});

// ---------- 施設間の分離 ----------
test("メンバーは自施設のデータを読め、他施設は読めない", async () => {
  const db = as("ordA");
  await assertSucceeds(getDoc(doc(db, "facilities/fA")));
  await assertSucceeds(getDocs(collection(db, "facilities/fA/orderers")));
  await assertSucceeds(getDocs(collection(db, "facilities/fA/adoptedIols")));
  await assertSucceeds(getDocs(collection(db, "facilities/fA/facilityDealers")));
  await assertSucceeds(getDocs(collection(db, "facilities/fA/orders")));
  await assertFails(getDoc(doc(db, "facilities/fB")));
  await assertFails(getDocs(collection(db, "facilities/fB/orderers")));
  await assertFails(getDocs(collection(db, "facilities/fB/orders")));
  await assertFails(getDoc(doc(db, "facilities/fB/members/ordB")));
});

test("無効化された所属・停止中の施設ではアクセスできない", async () => {
  await assertFails(getDoc(doc(as("offA"), "facilities/fA")));
  await assertFails(getDocs(collection(as("offA"), "facilities/fA/orderers")));
  await assertFails(getDocs(collection(as("ordS"), "facilities/fS/orderers")));
});

test("注文者(orderer)は他メンバーの一覧を読めず、設定も変更できない", async () => {
  const db = as("ordA");
  await assertFails(getDocs(collection(db, "facilities/fA/members")));
  await assertFails(getDoc(doc(db, "facilities/fA/members/adminA")));
  await assertSucceeds(getDoc(doc(db, "facilities/fA/members/ordA")));
  await assertFails(setDoc(doc(db, "facilities/fA/orderers/new"), { facilityId: "fA", name: "x", active: true }));
  await assertFails(setDoc(doc(db, "facilities/fA/adoptedIols/new"), { facilityId: "fA", catalogIolId: "c", enabled: true }));
  await assertFails(deleteDoc(doc(db, "facilities/fA/orderers/o1")));
});

// ---------- 施設管理者の範囲 ----------
test("施設管理者は自施設の注文者・採用IOL・ディーラーを管理できる", async () => {
  const db = as("adminA");
  await assertSucceeds(setDoc(doc(db, "facilities/fA/orderers/n1"), { facilityId: "fA", name: "新規", active: true }));
  await assertSucceeds(setDoc(doc(db, "facilities/fA/adoptedIols/hoya-xy1"), { facilityId: "fA", catalogIolId: "hoya-xy1", enabled: true }));
  await assertSucceeds(setDoc(doc(db, "facilities/fA/facilityDealers/n1"), {
    facilityId: "fA", dealerId: "d", name: "n", active: true, orderEmails: ["a@example.jp"]
  }));
  await assertSucceeds(getDocs(collection(db, "facilities/fA/members")));
});

test("施設管理者でも他施設は読み書きできない", async () => {
  const db = as("adminA");
  await assertFails(getDoc(doc(db, "facilities/fB")));
  await assertFails(setDoc(doc(db, "facilities/fB/orderers/n1"), { facilityId: "fB", name: "x", active: true }));
  await assertFails(setDoc(doc(db, "facilities/fA/orderers/n2"), { facilityId: "fB", name: "x", active: true }));
  await assertFails(setDoc(doc(db, "facilities/fB/members/evil"), member("evil", "orderer")));
});

test("入力形式の検証: 余分なフィールドや不正な型は拒否", async () => {
  const db = as("adminA");
  await assertFails(setDoc(doc(db, "facilities/fA/orderers/n1"), { facilityId: "fA", name: "x", active: true, role: "admin" }));
  await assertFails(setDoc(doc(db, "facilities/fA/orderers/n1"), { facilityId: "fA", name: "", active: true }));
  await assertFails(setDoc(doc(db, "facilities/fA/orderers/n1"), { facilityId: "fA", name: "x", active: "yes" }));
  await assertFails(setDoc(doc(db, "facilities/fA/facilityDealers/n1"), {
    facilityId: "fA", dealerId: "d", name: "n", active: true, orderEmails: ["1", "2", "3", "4", "5", "6"]
  }));
});

test("施設管理者は施設名のみ変更でき、status は変更できない", async () => {
  const db = as("adminA");
  await assertSucceeds(updateDoc(doc(db, "facilities/fA"), { name: "新名称" }));
  await assertFails(updateDoc(doc(db, "facilities/fA"), { status: "suspended" }));
  await assertFails(updateDoc(doc(db, "facilities/fA"), { name: "x", createdBy: "adminA" }));
  await assertFails(deleteDoc(doc(db, "facilities/fA")));
});

// ---------- 権限の自己付与の防止 ----------
test("自分の所属ドキュメントはいかなる権限でも自分では変更できない", async () => {
  await assertFails(updateDoc(doc(as("ordA"), "facilities/fA/members/ordA"), { role: "admin" }));
  await assertFails(setDoc(doc(as("ordA"), "facilities/fA/members/ordA"), member("ordA", "admin")));
  await assertFails(updateDoc(doc(as("adminA"), "facilities/fA/members/adminA"), { status: "disabled" }));
  await assertFails(setDoc(doc(as("adminA"), "facilities/fA/members/adminA"), member("adminA", "admin")));
  await assertFails(deleteDoc(doc(as("adminA"), "facilities/fA/members/adminA")));
});

test("所属の無いユーザーは自分を施設に追加できない（自己参加不可）", async () => {
  await assertFails(setDoc(doc(as("stranger"), "facilities/fA/members/stranger"), member("stranger", "orderer")));
  await assertFails(setDoc(doc(as("stranger"), "facilities/fA/members/stranger"), member("stranger", "admin")));
  await assertFails(setDoc(doc(as("ordA"), "facilities/fB/members/ordA"), member("ordA", "orderer")));
});

test("施設管理者は admin 権限を付与・昇格できない（orderer のみ管理可）", async () => {
  const db = as("adminA");
  await assertFails(setDoc(doc(db, "facilities/fA/members/newAdmin"), member("newAdmin", "admin")));
  await assertFails(updateDoc(doc(db, "facilities/fA/members/ordA"), { role: "admin" }));
  // 施設管理者は所属を直接作成・削除できない（参加は招待経由のサーバー処理のみ）
  await assertFails(setDoc(doc(db, "facilities/fA/members/newOrd"), member("newOrd", "orderer")));
  await assertFails(deleteDoc(doc(db, "facilities/fA/members/ordA")));
  await assertSucceeds(toggle(db, "fA", "ordA", "active", "disabled"));
});

// ---------- 利用者管理(無効化・再有効化・操作記録) ----------
const AUD = "aud0123456789abcdef";
function toggle(db, fid, uid, from, to, { actorUid = "adminA", auditId = AUD, member: memberPatch = {}, log = {}, skipLog = false, skipMember = false } = {}) {
  const b = writeBatch(db);
  if (!skipMember) {
    b.update(doc(db, `facilities/${fid}/members/${uid}`), { status: to, updatedAt: serverTimestamp(), lastAuditId: auditId, ...memberPatch });
  }
  if (!skipLog) {
    b.set(doc(db, `facilities/${fid}/auditLogs/${auditId}`), {
      action: to === "disabled" ? "member.disable" : "member.enable", targetUid: uid, targetRole: "orderer",
      fromStatus: from, toStatus: to, actorUid, at: serverTimestamp(), ...log
    });
  }
  return b.commit();
}

test("利用者管理: 無効化すると、その注文者の既存セッションでも自施設のデータにアクセスできなくなる。再有効化で戻る", async () => {
  const ord = as("ordA");
  await assertSucceeds(getDocs(collection(ord, "facilities/fA/orderers")));
  await assertSucceeds(toggle(as("adminA"), "fA", "ordA", "active", "disabled"));
  await assertFails(getDocs(collection(ord, "facilities/fA/orderers")));
  await assertFails(getDocs(collection(ord, "facilities/fA/adoptedIols")));
  await assertFails(getDocs(collection(ord, "facilities/fA/facilityDealers")));
  await assertFails(getDoc(doc(ord, "facilities/fA")));
  await assertFails(getDocs(collection(ord, "facilities/fA/orders")));
  await assertSucceeds(toggle(as("adminA"), "fA", "ordA", "disabled", "active", { auditId: "aud0123456789abcdeg" }));
  await assertSucceeds(getDocs(collection(ord, "facilities/fA/orderers")));
});

test("利用者管理: 操作記録が残り、施設管理者のみ読め、書き換え・削除はできない", async () => {
  await assertSucceeds(toggle(as("adminA"), "fA", "ordA", "active", "disabled"));
  const admin = as("adminA");
  const snap = await assertSucceeds(getDoc(doc(admin, `facilities/fA/auditLogs/${AUD}`)));
  const d = snap.data();
  if (d.action !== "member.disable" || d.targetUid !== "ordA" || d.actorUid !== "adminA" || !d.at) throw new Error("audit log content");
  await assertSucceeds(getDocs(collection(admin, "facilities/fA/auditLogs")));
  await assertFails(updateDoc(doc(admin, `facilities/fA/auditLogs/${AUD}`), { toStatus: "active" }));
  await assertFails(deleteDoc(doc(admin, `facilities/fA/auditLogs/${AUD}`)));
  await assertFails(getDocs(collection(as("ordA"), "facilities/fA/auditLogs")));
  await assertFails(getDocs(collection(as("adminB"), "facilities/fA/auditLogs")));
  await assertFails(getDocs(collection(anon(), "facilities/fA/auditLogs")));
});

test("利用者管理: 操作記録なしの所属変更、所属変更なしの記録、記録内容の偽装は拒否", async () => {
  const db = as("adminA");
  await assertFails(toggle(db, "fA", "ordA", "active", "disabled", { skipLog: true }));
  await assertFails(updateDoc(doc(db, "facilities/fA/members/ordA"), { status: "disabled" }));
  await assertFails(toggle(db, "fA", "ordA", "active", "disabled", { skipMember: true }));
  await assertFails(toggle(db, "fA", "ordA", "active", "disabled", { log: { actorUid: "someoneElse" } }));
  await assertFails(toggle(db, "fA", "ordA", "active", "disabled", { log: { toStatus: "active" } }));
  await assertFails(toggle(db, "fA", "ordA", "active", "disabled", { log: { action: "member.enable" } }));
  await assertFails(toggle(db, "fA", "ordA", "active", "disabled", { log: { targetUid: "ordZ" } }));
  await assertFails(toggle(db, "fA", "ordA", "active", "disabled", { log: { extra: 1 } }));
  await assertFails(toggle(db, "fA", "ordA", "active", "disabled", { member: { updatedAt: new Date("2020-01-01") } }));
  await assertFails(toggle(db, "fA", "ordA", "active", "disabled", { auditId: "short" }));
  // 状態が変わらない操作・実際の状態と食い違う記録
  await assertFails(toggle(db, "fA", "ordA", "active", "active", { log: { action: "member.disable", toStatus: "disabled" } }));
  await assertFails(toggle(db, "fA", "offA", "active", "disabled"));
});

test("利用者管理: 権限(role)・他の項目は変更できない。自分自身・管理者・他施設の所属は変更できない", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "facilities/fA/members/adminA2"), member("adminA2", "admin"));
  });
  const db = as("adminA");
  await assertFails(toggle(db, "fA", "ordA", "active", "disabled", { member: { role: "admin" } }));
  await assertFails(toggle(db, "fA", "ordA", "active", "disabled", { member: { displayName: "改名" } }));
  await assertFails(toggle(db, "fA", "adminA", "active", "disabled")); // 自分自身(最後の有効な管理者)
  await assertFails(toggle(db, "fA", "adminA2", "active", "disabled", { log: { targetRole: "admin" } }));
  await assertFails(toggle(db, "fA", "adminA2", "active", "disabled"));
  await assertFails(toggle(as("adminB"), "fA", "ordA", "active", "disabled", { actorUid: "adminB" })); // 他施設の管理者
  await assertFails(toggle(db, "fB", "ordB", "active", "disabled")); // 他施設の所属
  await assertFails(toggle(as("ordA"), "fA", "offA", "disabled", "active", { actorUid: "ordA" })); // 注文者は管理操作不可
  await assertFails(toggle(as("offA"), "fA", "ordA", "active", "disabled", { actorUid: "offA" })); // 無効化された管理操作者
  // 結果として何も変わっていない
  for (const p of ["facilities/fA/members/ordA", "facilities/fA/members/adminA", "facilities/fA/members/adminA2", "facilities/fB/members/ordB"]) {
    if ((await getDoc(doc(platform(), p))).data().status !== "active") throw new Error("changed: " + p);
  }
});

test("利用者管理: 所属一覧は自施設の管理者だけが読める", async () => {
  await assertSucceeds(getDocs(collection(as("adminA"), "facilities/fA/members")));
  await assertFails(getDocs(collection(as("adminA"), "facilities/fB/members")));
  await assertFails(getDocs(collection(as("ordA"), "facilities/fA/members")));
  await assertFails(getDocs(collection(as("offA"), "facilities/fA/members")));
});

test("所属ドキュメントの uid 偽装・不正フィールドは拒否", async () => {
  const db = as("adminA");
  await assertFails(setDoc(doc(db, "facilities/fA/members/x1"), member("someoneElse", "orderer")));
  await assertFails(setDoc(doc(db, "facilities/fA/members/x2"), { ...member("x2", "orderer"), isOwner: true }));
});

test("他の admin の所属は施設管理者でも変更できない", async () => {
  await assertFails(updateDoc(doc(as("adminA"), "facilities/fA/members/adminA"), { status: "disabled" }));
  // 別施設の admin が相手の admin を操作することも不可
  await assertFails(updateDoc(doc(as("adminB"), "facilities/fA/members/adminA"), { status: "disabled" }));
});

test("platformAdmin クレーム無しのユーザーは運営者操作を行えない", async () => {
  const db = as("adminA", { platformAdmin: false });
  await assertFails(setDoc(doc(db, "facilities/new"), { name: "n", status: "active" }));
  await assertFails(setDoc(doc(db, "iolCatalog/x"), { model: "m" }));
});

test("運営者(platformAdmin)のみ施設作成・admin付与・マスター更新ができる", async () => {
  const db = platform();
  await assertSucceeds(setDoc(doc(db, "facilities/fNew"), { name: "新施設", status: "pending" }));
  await assertSucceeds(setDoc(doc(db, "facilities/fNew/members/firstAdmin"), member("firstAdmin", "admin")));
  await assertSucceeds(setDoc(doc(db, "iolCatalog/c2"), { model: "m2" }));
  await assertSucceeds(setDoc(doc(db, "dealers/dl2"), { name: "d", memberUids: [] }));
  await assertFails(deleteDoc(doc(db, "facilities/fA"))); // 施設削除は誰も不可
});

// ---------- マスター・注文 ----------
test("IOLカタログはログイン済みなら読め、書けるのは運営者のみ", async () => {
  await assertSucceeds(getDoc(doc(as("stranger"), "iolCatalog/c1")));
  await assertFails(setDoc(doc(as("adminA"), "iolCatalog/c1"), { model: "hack" }));
});

test("ディーラー情報は運営者と自社メンバーのみ読め、施設管理者は書けない", async () => {
  await assertSucceeds(getDoc(doc(as("dealerUid"), "dealers/dl1")));
  await assertFails(getDoc(doc(as("adminA"), "dealers/dl1")));
  await assertFails(getDoc(doc(as("stranger"), "dealers/dl1")));
  await assertFails(setDoc(doc(as("adminA"), "dealers/dl1"), { name: "x", memberUids: ["adminA"] }));
  await assertFails(updateDoc(doc(as("dealerUid"), "dealers/dl1"), { memberUids: ["dealerUid", "evil"] }));
});

test("注文はクライアントから作成・変更・削除できない（管理者・運営者も不可）", async () => {
  for (const db of [as("ordA"), as("adminA"), platform()]) {
    await assertFails(setDoc(doc(db, "facilities/fA/orders/new"), { status: "received", orderId: "FAKE-1" }));
    await assertFails(updateDoc(doc(db, "facilities/fA/orders/ord1"), { status: "sent" }));
    await assertFails(deleteDoc(doc(db, "facilities/fA/orders/ord1")));
  }
});

test("未定義のコレクションは全拒否（users 等）", async () => {
  await assertFails(setDoc(doc(as("ordA"), "users/ordA"), { role: "admin" }));
  await assertFails(getDoc(doc(as("ordA"), "users/ordA")));
  await assertFails(getDoc(doc(platform(), "unknown/x")));
});

// ---------- 施設の位置情報（現在地による施設選択の補助データ） ----------
test("施設管理者は自施設の位置情報と判定距離を登録・削除できる", async () => {
  const db = as("adminA");
  await assertSucceeds(updateDoc(doc(db, "facilities/fA"), { location: { lat: 35.0, lng: 139.0 }, geoRadiusM: 150 }));
  await assertSucceeds(updateDoc(doc(db, "facilities/fA"), { geoRadiusM: 300 }));
  await assertSucceeds(updateDoc(doc(db, "facilities/fA"), { location: deleteField(), geoRadiusM: deleteField() }));
});

test("位置情報の不正な値・余分なキーは拒否", async () => {
  const db = as("adminA");
  await assertFails(updateDoc(doc(db, "facilities/fA"), { location: { lat: 200, lng: 139 } }));
  await assertFails(updateDoc(doc(db, "facilities/fA"), { location: { lat: 35, lng: -181 } }));
  await assertFails(updateDoc(doc(db, "facilities/fA"), { location: { lat: "35", lng: 139 } }));
  await assertFails(updateDoc(doc(db, "facilities/fA"), { location: { lat: 35 } }));
  await assertFails(updateDoc(doc(db, "facilities/fA"), { location: { lat: 35, lng: 139, alt: 1 } }));
  await assertFails(updateDoc(doc(db, "facilities/fA"), { geoRadiusM: 5 }));
  await assertFails(updateDoc(doc(db, "facilities/fA"), { geoRadiusM: 100000 }));
  await assertFails(updateDoc(doc(db, "facilities/fA"), { geoRadiusM: "150" }));
});

test("位置情報は orderer・他施設の管理者は変更できないが、所属メンバーは読める", async () => {
  await assertFails(updateDoc(doc(as("ordA"), "facilities/fA"), { location: { lat: 35, lng: 139 } }));
  await assertFails(updateDoc(doc(as("adminB"), "facilities/fA"), { location: { lat: 35, lng: 139 } }));
  await assertSucceeds(updateDoc(doc(as("adminA"), "facilities/fA"), { location: { lat: 35, lng: 139 }, geoRadiusM: 100 }));
  await assertSucceeds(getDoc(doc(as("ordA"), "facilities/fA")));
  await assertFails(getDoc(doc(as("ordB"), "facilities/fA")));
});

test("位置情報と同時に status 等を変更することはできない", async () => {
  await assertFails(updateDoc(doc(as("adminA"), "facilities/fA"), { location: { lat: 35, lng: 139 }, status: "suspended" }));
});

// ---------- 施設設定（注文者・採用IOL・ディーラー） ----------
const ok = (db, p, data) => assertSucceeds(setDoc(doc(db, p), data));
const ng = (db, p, data) => assertFails(setDoc(doc(db, p), data));

test("注文者: 並び順(sortOrder)とメールの検証", async () => {
  const db = as("adminA");
  const base = { facilityId: "fA", name: "注文者", active: true };
  await ok(db, "facilities/fA/orderers/s1", { ...base, sortOrder: 10, email: "doctor@example.jp" });
  await ok(db, "facilities/fA/orderers/s2", { ...base, sortOrder: 0 });
  for (const bad of [-1, 1.5, "10", 100001]) await ng(db, "facilities/fA/orderers/s3", { ...base, sortOrder: bad });
  for (const bad of ["not-an-email", "a@b", "@example.jp", "a b@example.jp", "", 123]) {
    await ng(db, "facilities/fA/orderers/s4", { ...base, email: bad });
  }
  await ng(db, "facilities/fA/orderers/s5", { ...base, name: "あ".repeat(51) });
});

test("採用IOL: ドキュメントIDと catalogIolId が一致し、共通マスターのIDのみ許可", async () => {
  const db = as("adminA");
  await ok(db, "facilities/fA/adoptedIols/alcon-cna0t0", { facilityId: "fA", catalogIolId: "alcon-cna0t0", enabled: true });
  await ok(db, "facilities/fA/adoptedIols/alcon-cna0t0", { facilityId: "fA", catalogIolId: "alcon-cna0t0", enabled: false }); // 採用解除
  await ok(db, "facilities/fA/adoptedIols/hoya-xy1", { facilityId: "fA", catalogIolId: "hoya-xy1", enabled: true, dealerId: "dealer-1" });
  // 存在しないIOL / ID不一致 / 他施設ID / 余分なフィールド
  await ng(db, "facilities/fA/adoptedIols/unknown-iol", { facilityId: "fA", catalogIolId: "unknown-iol", enabled: true });
  await ng(db, "facilities/fA/adoptedIols/hoya-xy1", { facilityId: "fA", catalogIolId: "nidek-nsp-2", enabled: true });
  await ng(db, "facilities/fA/adoptedIols/auto-id-1", { facilityId: "fA", catalogIolId: "hoya-xy1", enabled: true });
  await ng(db, "facilities/fA/adoptedIols/hoya-py-60ad", { facilityId: "fB", catalogIolId: "hoya-py-60ad", enabled: true });
  await ng(db, "facilities/fA/adoptedIols/hoya-py-60ad", { facilityId: "fA", catalogIolId: "hoya-py-60ad", enabled: true, price: 1 });
  await ng(db, "facilities/fA/adoptedIols/hoya-py-60ad", { facilityId: "fA", catalogIolId: "hoya-py-60ad", enabled: "true" });
});

test("ディーラー: 発注用と使用報告用のメールを別々に管理し、形式を検証", async () => {
  const db = as("adminA");
  const base = { facilityId: "fA", name: "ディーラーX", active: true };
  await ok(db, "facilities/fA/facilityDealers/d-ok", {
    ...base, orderEmails: ["order@example.jp"], usageReportEmails: ["report1@example.jp", "report2@example.jp"], sortOrder: 20
  });
  await ok(db, "facilities/fA/facilityDealers/d-min", base); // メール未設定でも登録可
  await ok(db, "facilities/fA/facilityDealers/d-link", { ...base, dealerId: "global-dealer-1", orderEmails: [], usageReportEmails: [] });
  const five = ["1", "2", "3", "4", "5"].map(n => n + "@example.jp");
  await ok(db, "facilities/fA/facilityDealers/d-five", { ...base, orderEmails: five });
  for (const field of ["orderEmails", "usageReportEmails"]) {
    await ng(db, "facilities/fA/facilityDealers/d-bad", { ...base, [field]: ["ok@example.jp", "broken"] });
    await ng(db, "facilities/fA/facilityDealers/d-bad", { ...base, [field]: ["broken"] });
    await ng(db, "facilities/fA/facilityDealers/d-bad", { ...base, [field]: [...five.slice(0, 4), "bad"] }); // 5件目も検証される
    await ng(db, "facilities/fA/facilityDealers/d-bad", { ...base, [field]: [...five, "6@example.jp"] });
    await ng(db, "facilities/fA/facilityDealers/d-bad", { ...base, [field]: "order@example.jp" }); // リスト以外
    await ng(db, "facilities/fA/facilityDealers/d-bad", { ...base, [field]: [123] });
  }
  await ng(db, "facilities/fA/facilityDealers/d-bad", { facilityId: "fA", active: true }); // name 必須
  await ng(db, "facilities/fA/facilityDealers/d-bad", { ...base, secretNote: "x" });
});

test("施設設定は所属先の施設管理者だけが変更できる", async () => {
  const orderer = { facilityId: "fA", name: "新規", active: true };
  const iol = { facilityId: "fA", catalogIolId: "hoya-xy1", enabled: true };
  const dealer = { facilityId: "fA", name: "D", active: true };
  const targets = [
    ["facilities/fA/orderers/z1", orderer],
    ["facilities/fA/adoptedIols/hoya-xy1", iol],
    ["facilities/fA/facilityDealers/z1", dealer]
  ];
  for (const [p, data] of targets) {
    await ng(as("ordA"), p, data);       // 同施設の orderer 権限
    await ng(as("adminB"), p, data);     // 他施設の管理者
    await ng(as("stranger"), p, data);   // 所属なし
    await ng(as("offA"), p, data);       // 無効化された所属
    await ng(anon(), p, data);           // 未認証
    await ok(as("adminA"), p, data);     // 所属先の管理者
  }
});

test("採用IOL・ディーラーの削除は運営者のみ（施設管理者は無効化で運用）", async () => {
  for (const p of ["facilities/fA/adoptedIols/a1", "facilities/fA/facilityDealers/d1"]) {
    await assertFails(deleteDoc(doc(as("adminA"), p)));
    await assertFails(deleteDoc(doc(as("ordA"), p)));
  }
  await assertSucceeds(deleteDoc(doc(platform(), "facilities/fA/orderers/o1")));
});

test("注文者マスターは自施設の施設管理者が削除できる。他施設・orderer・無効な所属・未認証は削除できず、所属や注文は変わらない", async () => {
  await assertFails(deleteDoc(doc(as("ordA"), "facilities/fA/orderers/o1")));
  await assertFails(deleteDoc(doc(as("offA"), "facilities/fA/orderers/o1")));
  await assertFails(deleteDoc(doc(as("adminB"), "facilities/fA/orderers/o1")));
  await assertFails(deleteDoc(doc(as("adminA"), "facilities/fB/orderers/o1")));
  await assertFails(deleteDoc(doc(anon(), "facilities/fA/orderers/o1")));
  await assertSucceeds(deleteDoc(doc(as("adminA"), "facilities/fA/orderers/o1")));
  const ops = platform();
  if ((await getDoc(doc(ops, "facilities/fA/orderers/o1"))).exists()) throw new Error("not deleted");
  if (!(await getDoc(doc(ops, "facilities/fB/orderers/o1"))).exists()) throw new Error("other facility affected");
  if (!(await getDoc(doc(ops, "facilities/fA/members/adminA"))).exists()) throw new Error("member affected");
  if (!(await getDoc(doc(ops, "facilities/fA/orders/ord1"))).exists()) throw new Error("order history affected");
});

test("設定の読取は所属メンバーのみ。他施設の設定は読めない", async () => {
  for (const sub of ["orderers", "adoptedIols", "facilityDealers"]) {
    await assertSucceeds(getDocs(collection(as("ordA"), "facilities/fA/" + sub)));
    await assertFails(getDocs(collection(as("ordA"), "facilities/fB/" + sub)));
    await assertFails(getDocs(collection(as("stranger"), "facilities/fA/" + sub)));
  }
});
