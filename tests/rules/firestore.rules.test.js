// Firestore Security Rules テスト（Firestoreエミュレータ上で実行。実プロジェクトには接続しない）
//   npm run test:rules
import assert from "node:assert/strict";
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

const member = (uid, role) => ({ uid, role });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [id, status] of [["fA", "active"], ["fB", "active"], ["fS", "suspended"]]) {
      await setDoc(doc(db, "facilities", id), { name: id, status });
    }
    await setDoc(doc(db, "facilities/fA/members/adminA"), member("adminA", "admin"));
    await setDoc(doc(db, "facilities/fA/members/ordA"), member("ordA", "orderer"));
    await setDoc(doc(db, "facilities/fB/members/ordB"), member("ordB", "orderer"));
    await setDoc(doc(db, "facilities/fB/members/adminB"), member("adminB", "admin"));
    await setDoc(doc(db, "facilities/fS/members/ordS"), member("ordS", "orderer"));
    for (const f of ["fA", "fB", "fS"]) {
      await setDoc(doc(db, `facilities/${f}/orderers/o1`), { facilityId: f, name: "x" });
      await setDoc(doc(db, `facilities/${f}/adoptedIols/a1`), { facilityId: f, catalogIolId: "c", enabled: true });
      await setDoc(doc(db, `facilities/${f}/facilityDealers/d1`), { facilityId: f, dealerId: "d", name: "n" });
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
  await assertFails(setDoc(doc(db, "facilities/fA/orderers/new"), { facilityId: "fA", name: "x" }));
  await assertFails(setDoc(doc(db, "facilities/fA/adoptedIols/new"), { facilityId: "fA", catalogIolId: "c", enabled: true }));
  await assertFails(deleteDoc(doc(db, "facilities/fA/orderers/o1")));
});

// ---------- 施設管理者の範囲 ----------
test("施設管理者は自施設の注文者・採用IOL・ディーラーを管理できる", async () => {
  const db = as("adminA");
  await assertSucceeds(setDoc(doc(db, "facilities/fA/orderers/n1"), { facilityId: "fA", name: "新規" }));
  await assertSucceeds(setDoc(doc(db, "facilities/fA/adoptedIols/hoya-xy1"), { facilityId: "fA", catalogIolId: "hoya-xy1", enabled: true }));
  await assertSucceeds(setDoc(doc(db, "facilities/fA/facilityDealers/n1"), {
    facilityId: "fA", dealerId: "d", name: "n", orderEmails: ["a@example.jp"]
  }));
  await assertSucceeds(getDocs(collection(db, "facilities/fA/members")));
});

test("施設管理者でも他施設は読み書きできない", async () => {
  const db = as("adminA");
  await assertFails(getDoc(doc(db, "facilities/fB")));
  await assertFails(setDoc(doc(db, "facilities/fB/orderers/n1"), { facilityId: "fB", name: "x" }));
  await assertFails(setDoc(doc(db, "facilities/fA/orderers/n2"), { facilityId: "fB", name: "x" }));
  await assertFails(setDoc(doc(db, "facilities/fB/members/evil"), member("evil", "orderer")));
});

test("入力形式の検証: 余分なフィールドや不正な型は拒否", async () => {
  const db = as("adminA");
  await assertFails(setDoc(doc(db, "facilities/fA/orderers/n1"), { facilityId: "fA", name: "x", role: "admin" }));
  await assertFails(setDoc(doc(db, "facilities/fA/orderers/n1"), { facilityId: "fA", name: "" }));
  // 注文者に有効/無効はない: 新しい形式(active なし)だけが書ける
  await assertFails(setDoc(doc(db, "facilities/fA/orderers/n1"), { facilityId: "fA", name: "x", active: true }));
  await assertFails(setDoc(doc(db, "facilities/fA/orderers/n1"), { facilityId: "fA", name: "x", active: false }));
  await assertFails(setDoc(doc(db, "facilities/fA/orderers/n1"), { facilityId: "fA", name: "x", active: "yes" }));
  await assertSucceeds(setDoc(doc(db, "facilities/fA/orderers/n1"), { facilityId: "fA", name: "x", email: "x@example.jp", sortOrder: 10 }));
  await assertFails(setDoc(doc(db, "facilities/fA/facilityDealers/n1"), {
    facilityId: "fA", dealerId: "d", name: "n", orderEmails: ["1", "2", "3", "4", "5", "6"]
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
});

// ---------- 利用者管理(所属の削除・操作履歴) ----------
// 所属の削除はCloud Functions(removeMember)だけが行う。クライアントは所属も操作履歴も書けない。
const memberWrites = (db, fid, uid) => [
  () => setDoc(doc(db, `facilities/${fid}/members/${uid}`), { uid, role: "orderer" }),
  () => updateDoc(doc(db, `facilities/${fid}/members/${uid}`), { role: "orderer" }),
  () => updateDoc(doc(db, `facilities/${fid}/members/${uid}`), { status: "active" }),
  () => deleteDoc(doc(db, `facilities/${fid}/members/${uid}`))
];

test("利用者管理: 施設管理者・注文者・運営者を含め、どのクライアントも所属を作成・変更・削除できない(削除はサーバー経由のみ)", async () => {
  for (const [who, db] of [["adminA", as("adminA")], ["ordA", as("ordA")], ["adminB", as("adminB")], ["stranger", as("stranger")]]) {
    for (const [fid, uid] of [["fA", "ordA"], ["fA", "adminA"], ["fA", "newbie"], ["fB", "ordB"]]) {
      for (const w of memberWrites(db, fid, uid)) await assertFails(w());
    }
  }
  // 運営者(platformAdmin)は削除できる(Admin SDK 相当の運営操作)
  await assertSucceeds(deleteDoc(doc(platform(), "facilities/fA/members/ordA")));
});

test("利用者管理: 所属が削除されると、そのユーザーの既存セッションでも、次のリクエストからその施設のデータにアクセスできない", async () => {
  const ord = as("ordA");
  await assertSucceeds(getDocs(collection(ord, "facilities/fA/orderers")));
  await assertSucceeds(getDoc(doc(ord, "facilities/fA")));
  await env.withSecurityRulesDisabled(async (ctx) => { await deleteDoc(doc(ctx.firestore(), "facilities/fA/members/ordA")); }); // removeMember 相当
  for (const sub of ["orderers", "adoptedIols", "facilityDealers", "orders", "members", "auditLogs"]) {
    await assertFails(getDocs(collection(ord, `facilities/fA/${sub}`)));
  }
  await assertFails(getDoc(doc(ord, "facilities/fA")));
  assert.equal((await assertSucceeds(getDoc(doc(ord, "facilities/fA/members/ordA")))).exists(), false); // 自分の所属の有無は確認できるが、存在しない
  // 他施設の所属には影響しない
  await assertSucceeds(getDocs(collection(as("ordB"), "facilities/fB/orderers")));
  // 所属ドキュメントのない人は、所属確認のクエリも空
  const mine = await assertSucceeds(getDocs(query(collectionGroup(ord, "members"), where("uid", "==", "ordA"))));
  assert.equal(mine.size, 0);
});

test("利用者管理: 操作履歴(auditLogs)は施設管理者と運営者だけが読め、どのクライアントも作成・変更・削除できない", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "facilities/fA/auditLogs/l1"), { action: "member.remove", targetUid: "x", actorUid: "adminA" });
  });
  await assertSucceeds(getDoc(doc(as("adminA"), "facilities/fA/auditLogs/l1")));
  await assertSucceeds(getDocs(collection(as("adminA"), "facilities/fA/auditLogs")));
  await assertSucceeds(getDoc(doc(platform(), "facilities/fA/auditLogs/l1")));
  for (const db of [as("ordA"), as("adminB"), as("stranger"), anon()]) {
    await assertFails(getDoc(doc(db, "facilities/fA/auditLogs/l1")));
    await assertFails(getDocs(collection(db, "facilities/fA/auditLogs")));
  }
  for (const db of [as("adminA"), as("ordA"), platform()]) {
    await assertFails(setDoc(doc(db, "facilities/fA/auditLogs/new"), { action: "member.remove", targetUid: "ordA", actorUid: "adminA" }));
    await assertFails(updateDoc(doc(db, "facilities/fA/auditLogs/l1"), { actorUid: "someone" }));
    await assertFails(deleteDoc(doc(db, "facilities/fA/auditLogs/l1")));
  }
});

test("利用者管理: 所属一覧は自施設の管理者だけが読める", async () => {
  await assertSucceeds(getDocs(collection(as("adminA"), "facilities/fA/members")));
  await assertFails(getDocs(collection(as("adminA"), "facilities/fB/members")));
  await assertFails(getDocs(collection(as("ordA"), "facilities/fA/members")));
  await assertFails(getDocs(collection(as("offA"), "facilities/fA/members")));
});

test("所属に status(有効/無効)を持たせた旧形式のドキュメントも、移行までは所属として扱われる(読み取り)。新規作成では status は許可されない", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "facilities/fA/members/legacy"), { uid: "legacy", role: "orderer", status: "active", lastAuditId: "x" });
  });
  await assertSucceeds(getDocs(collection(as("legacy"), "facilities/fA/orderers"))); // status があっても所属は有効
  await assertFails(setDoc(doc(platform(), "facilities/fA/members/n1"), { uid: "n1", role: "orderer", status: "active" })); // 新形式のみ
  await assertSucceeds(setDoc(doc(platform(), "facilities/fA/members/n1"), { uid: "n1", role: "orderer" }));
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
  const base = { facilityId: "fA", name: "注文者" };
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
  const base = { facilityId: "fA", name: "ディーラーX" };
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
  await ng(db, "facilities/fA/facilityDealers/d-bad", { facilityId: "fA" }); // name 必須
  await ng(db, "facilities/fA/facilityDealers/d-bad", { ...base, secretNote: "x" });
});

test("施設設定は所属先の施設管理者だけが変更できる", async () => {
  const orderer = { facilityId: "fA", name: "新規" };
  const iol = { facilityId: "fA", catalogIolId: "hoya-xy1", enabled: true };
  const dealer = { facilityId: "fA", name: "D" };
  const targets = [
    ["facilities/fA/orderers/z1", orderer],
    ["facilities/fA/adoptedIols/hoya-xy1", iol],
    ["facilities/fA/facilityDealers/z1", dealer]
  ];
  for (const [p, data] of targets) {
    await ng(as("ordA"), p, data);       // 同施設の orderer 権限
    await ng(as("adminB"), p, data);     // 他施設の管理者
    await ng(as("stranger"), p, data);   // 所属なし
    await ng(as("offA"), p, data);       // 所属を削除された人
    await ng(anon(), p, data);           // 未認証
    await ok(as("adminA"), p, data);     // 所属先の管理者
  }
});

test("採用IOLの削除は運営者のみ（施設管理者は採用を外して運用）", async () => {
  for (const p of ["facilities/fA/adoptedIols/a1"]) {
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

test("旧形式(active つき)の注文者ドキュメントも、移行までは読め、新しい形式で上書きすると active が無くなる", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "facilities/fA/orderers/legacy"), { facilityId: "fA", name: "旧形式", active: false, sortOrder: 5 });
  });
  const snap = await assertSucceeds(getDoc(doc(as("ordA"), "facilities/fA/orderers/legacy")));
  if (snap.get("active") !== false) throw new Error("legacy doc not readable as-is");
  // 旧形式のまま更新(active を残す)は拒否。新しい形式で置き換えれば通る
  await assertFails(updateDoc(doc(as("adminA"), "facilities/fA/orderers/legacy"), { name: "旧形式2" }));
  await assertSucceeds(setDoc(doc(as("adminA"), "facilities/fA/orderers/legacy"), { facilityId: "fA", name: "旧形式2", sortOrder: 5 }));
  const after = await getDoc(doc(as("ordA"), "facilities/fA/orderers/legacy"));
  if ("active" in after.data()) throw new Error("active should be gone after replacing with the new format");
  await assertSucceeds(deleteDoc(doc(as("adminA"), "facilities/fA/orderers/legacy")));
});

test("ディーラーに有効/無効はない: active を含む書き込みは拒否。自施設の施設管理者は削除でき、他施設・orderer・未認証は削除できない", async () => {
  const db = as("adminA");
  await assertFails(setDoc(doc(db, "facilities/fA/facilityDealers/x1"), { facilityId: "fA", name: "D", active: true }));
  await assertFails(setDoc(doc(db, "facilities/fA/facilityDealers/x1"), { facilityId: "fA", name: "D", active: false }));
  await assertSucceeds(setDoc(doc(db, "facilities/fA/facilityDealers/x1"), { facilityId: "fA", name: "D", orderEmails: ["o@example.jp"], usageReportEmails: ["u@example.jp"], sortOrder: 10 }));
  for (const c of [as("ordA"), as("adminB"), as("stranger"), as("offA"), anon()]) {
    await assertFails(deleteDoc(doc(c, "facilities/fA/facilityDealers/d1")));
  }
  await assertFails(deleteDoc(doc(as("adminA"), "facilities/fB/facilityDealers/d1"))); // 他施設
  await assertSucceeds(deleteDoc(doc(as("adminA"), "facilities/fA/facilityDealers/d1")));
  if ((await getDoc(doc(platform(), "facilities/fB/facilityDealers/d1"))).exists() === false) throw new Error("other facility affected");
  // 過去の注文(orders)は書き換えられない・影響を受けない
  if (!(await getDoc(doc(platform(), "facilities/fA/orders/ord1"))).exists()) throw new Error("order history affected");
  // 旧形式(active つき)のドキュメントは、移行までは読める。新しい形式で置き換えれば active が無くなる
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), "facilities/fA/facilityDealers/legacy"), { facilityId: "fA", name: "旧", active: false }); });
  await assertSucceeds(getDoc(doc(as("ordA"), "facilities/fA/facilityDealers/legacy")));
  await assertFails(updateDoc(doc(as("adminA"), "facilities/fA/facilityDealers/legacy"), { name: "旧2" }));
  await assertSucceeds(setDoc(doc(as("adminA"), "facilities/fA/facilityDealers/legacy"), { facilityId: "fA", name: "旧2" }));
});

// ---------- IOLモデルの表示順(displaySettings/iolOrder) ----------
test("表示順: 施設管理者だけが自施設の表示順を保存できる。所属メンバーは読める", async () => {
  const body = { makerOrder: ["J&J", "ALCON"], modelOrder: ["jj-dib00v", "alcon-cna0t0"], updatedAt: serverTimestamp() };
  await assertSucceeds(setDoc(doc(as("adminA"), "facilities/fA/displaySettings/iolOrder"), body));
  await assertSucceeds(updateDoc(doc(as("adminA"), "facilities/fA/displaySettings/iolOrder"), { makerOrder: ["ALCON"] }));
  await assertSucceeds(getDoc(doc(as("ordA"), "facilities/fA/displaySettings/iolOrder")));
  await assertSucceeds(getDoc(doc(platform(), "facilities/fA/displaySettings/iolOrder")));
  await assertFails(setDoc(doc(as("ordA"), "facilities/fA/displaySettings/iolOrder"), body));
  await assertFails(setDoc(doc(as("adminB"), "facilities/fA/displaySettings/iolOrder"), body));
  await assertFails(setDoc(doc(anon(), "facilities/fA/displaySettings/iolOrder"), body));
  await assertFails(getDoc(doc(as("ordB"), "facilities/fA/displaySettings/iolOrder")));
  await assertFails(getDoc(doc(anon(), "facilities/fA/displaySettings/iolOrder")));
});

test("表示順: 形式の検証(別のドキュメントID・余計なキー・不正な型は拒否)", async () => {
  const db = as("adminA");
  await assertFails(setDoc(doc(db, "facilities/fA/displaySettings/other"), { makerOrder: [], modelOrder: [] }));
  await assertFails(setDoc(doc(db, "facilities/fA/displaySettings/iolOrder"), { makerOrder: [], modelOrder: [], enabled: true }));
  await assertFails(setDoc(doc(db, "facilities/fA/displaySettings/iolOrder"), { makerOrder: "x", modelOrder: [] }));
  await assertFails(setDoc(doc(db, "facilities/fA/displaySettings/iolOrder"), { makerOrder: [] }));
  await assertFails(setDoc(doc(db, "facilities/fA/displaySettings/iolOrder"), { makerOrder: [], modelOrder: Array(201).fill("a") }));
  await assertSucceeds(setDoc(doc(db, "facilities/fA/displaySettings/iolOrder"), { makerOrder: [], modelOrder: [] }));
  await assertSucceeds(deleteDoc(doc(db, "facilities/fA/displaySettings/iolOrder")));
});
