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
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, collectionGroup, query, where, deleteField
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
  await assertSucceeds(setDoc(doc(db, "facilities/fA/adoptedIols/n1"), { facilityId: "fA", catalogIolId: "c", enabled: true }));
  await assertSucceeds(setDoc(doc(db, "facilities/fA/facilityDealers/n1"), {
    facilityId: "fA", dealerId: "d", name: "n", active: true, orderEmails: ["a@example.jp"]
  }));
  await assertSucceeds(deleteDoc(doc(db, "facilities/fA/orderers/o1")));
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
  await assertSucceeds(setDoc(doc(db, "facilities/fA/members/newOrd"), member("newOrd", "orderer")));
  await assertSucceeds(updateDoc(doc(db, "facilities/fA/members/ordA"), { status: "disabled" }));
  await assertSucceeds(deleteDoc(doc(db, "facilities/fA/members/newOrd")));
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
