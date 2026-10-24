// 実際の callable 関数(functions/index.js)を Functions + Auth + Firestore エミュレータで通しで検証する
//   npm run test:functions:e2e
// 実プロジェクトには接続しない（demo- プロジェクト）。
import test, { before } from "node:test";
import assert from "node:assert/strict";

const PROJECT = "demo-iol-e2e";
const REGION = "asia-northeast1";
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FS = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185";
const FN = "127.0.0.1:5001";

async function createUser(email, { verified }) {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password-for-emulator", returnSecureToken: true })
  });
  const j = await r.json();
  if (verified) {
    // エミュレータ管理APIでメール確認済みにする
    await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
      body: JSON.stringify({ localId: j.localId, emailVerified: true })
    });
    // 最新のクレーム(email_verified)を含むトークンを取り直す
    const s = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password-for-emulator", returnSecureToken: true })
    });
    return { uid: j.localId, idToken: (await s.json()).idToken };
  }
  return { uid: j.localId, idToken: j.idToken };
}

async function call(name, data, idToken) {
  const r = await fetch(`http://${FN}/${PROJECT}/${REGION}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data })
  });
  return { http: r.status, body: await r.json() };
}

const getDoc = async (p) => {
  const r = await fetch(`http://${FS}/v1/projects/${PROJECT}/databases/(default)/documents/${p}`, { headers: { Authorization: "Bearer owner" } });
  return r.status === 200 ? r.json() : null;
};

let verified, unverified;
before(async () => {
  verified = await createUser("owner@example.jp", { verified: true });
  unverified = await createUser("unverified@example.jp", { verified: false });
});

test("callable: 未ログインは unauthenticated で拒否", async () => {
  const r = await call("registerFacility", { name: "施設", requestId: "a".repeat(20) }, null);
  assert.equal(r.body.error.status, "UNAUTHENTICATED");
});

test("callable: メール未確認のアカウントは PERMISSION_DENIED で拒否され、何も作られない", async () => {
  const requestId = "unverified-request-0001";
  const r = await call("registerFacility", { name: "未確認施設", requestId }, unverified.idToken);
  assert.equal(r.body.error.status, "PERMISSION_DENIED");
  assert.equal(await getDoc(`registrationQuota/${unverified.uid}`), null);
});

test("callable: メール確認済みのアカウントは施設を登録でき、最初の管理者になる", async () => {
  const r = await call("registerFacility", { name: "E2Eクリニック", requestId: "verified-request-0001" }, verified.idToken);
  assert.equal(r.http, 200);
  assert.equal(r.body.result.status, "created");
  const fid = r.body.result.facilityId;
  assert.match(fid, /^fac-[0-9a-f]{24}$/);
  const mem = await getDoc(`facilities/${fid}/members/${verified.uid}`);
  assert.equal(mem.fields.role.stringValue, "admin");
  assert.equal(mem.fields.status.stringValue, "active");
  const fac = await getDoc(`facilities/${fid}`);
  assert.equal(fac.fields.createdBy.stringValue, verified.uid);
});

test("callable: 再送は同じ施設を返す(冪等)。権限の指定は INVALID_ARGUMENT", async () => {
  const again = await call("registerFacility", { name: "E2Eクリニック", requestId: "verified-request-0001" }, verified.idToken);
  assert.equal(again.body.result.status, "exists");
  const forged = await call("registerFacility", { name: "別施設", requestId: "verified-request-0002", role: "admin", platformAdmin: true }, verified.idToken);
  assert.equal(forged.body.error.status, "INVALID_ARGUMENT");
});

test("callable: 招待の発行→別アカウントでの参加。招待なし・別メールの参加は拒否", async () => {
  const reg = await call("registerFacility", { name: "招待E2E医院", requestId: "verified-request-0003" }, verified.idToken);
  const facilityId = reg.body.result.facilityId;

  // 管理者以外は発行できない
  const denied = await call("createInvite", { facilityId, email: "nurse@example.jp" }, unverified.idToken);
  assert.ok(["PERMISSION_DENIED"].includes(denied.body.error.status));

  const inv = await call("createInvite", { facilityId, email: "nurse@example.jp" }, verified.idToken);
  assert.equal(inv.http, 200);
  const token = inv.body.result.token;

  const stranger = await createUser("stranger@example.jp", { verified: true });
  const wrong = await call("acceptInvite", { token }, stranger.idToken);
  assert.equal(wrong.body.error.status, "FAILED_PRECONDITION");
  assert.equal(await getDoc(`facilities/${facilityId}/members/${stranger.uid}`), null);

  const nurse = await createUser("nurse@example.jp", { verified: true });
  const ok = await call("acceptInvite", { token }, nurse.idToken);
  assert.equal(ok.body.result.facilityId, facilityId);
  const mem = await getDoc(`facilities/${facilityId}/members/${nurse.uid}`);
  assert.equal(mem.fields.role.stringValue, "orderer");

  const reuse = await call("acceptInvite", { token }, nurse.idToken);
  assert.equal(reuse.body.error.status, "FAILED_PRECONDITION");
});

// ---------- 注文受付(createOrder) ----------
const putDoc = async (p, fields) => {
  const toValue = (v) => typeof v === "boolean" ? { booleanValue: v } : { stringValue: v };
  const r = await fetch(`http://${FS}/v1/projects/${PROJECT}/databases/(default)/documents/${p}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toValue(v)])) })
  });
  assert.equal(r.status, 200);
};
const future = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

test("callable: createOrder は検証して保存し(accepted)、再送は同じ注文番号、別内容は拒否。未認証・他人は拒否", async () => {
  const reg = await call("registerFacility", { name: "注文E2E医院", requestId: "order-e2e-register-01" }, verified.idToken);
  const fid = reg.body.result.facilityId;
  await putDoc(`facilities/${fid}/adoptedIols/jj-dib00v`, { facilityId: fid, catalogIolId: "jj-dib00v", enabled: true });
  await putDoc(`facilities/${fid}/orderers/o1`, { facilityId: fid, name: "山田" });

  const data = { facilityId: fid, requestId: "order-e2e-request-0001", modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: future(30), ordererId: "o1" };
  const ok = await call("createOrder", data, verified.idToken);
  assert.equal(ok.http, 200);
  assert.equal(ok.body.result.status, "accepted");
  assert.match(ok.body.result.orderNumber, /^IOL-\d{8}-0001$/);

  const saved = await getDoc(`facilities/${fid}/orders/${ok.body.result.orderId}`);
  assert.equal(saved.fields.status.stringValue, "accepted");
  assert.equal(saved.fields.createdBy.mapValue.fields.uid.stringValue, verified.uid);
  assert.equal(saved.fields.orderer.mapValue.fields.name.stringValue, "山田");

  const again = await call("createOrder", data, verified.idToken);
  assert.equal(again.body.result.orderNumber, ok.body.result.orderNumber);
  assert.equal(again.body.result.replayed, true);

  const changed = await call("createOrder", { ...data, power: "+21.0D" }, verified.idToken);
  assert.equal(changed.body.error.status, "ALREADY_EXISTS");
  const badPower = await call("createOrder", { ...data, requestId: "order-e2e-request-0002", power: "+20.2D" }, verified.idToken);
  assert.equal(badPower.body.error.status, "INVALID_ARGUMENT");

  assert.equal((await call("createOrder", data, null)).body.error.status, "UNAUTHENTICATED");
  assert.equal((await call("createOrder", data, unverified.idToken)).body.error.status, "PERMISSION_DENIED");
  const outsider = await createUser("order-outsider@example.jp", { verified: true });
  assert.equal((await call("createOrder", { ...data, requestId: "order-e2e-request-0003" }, outsider.idToken)).body.error.status, "PERMISSION_DENIED");
});

test("callable: createOrder は複数明細(まとめ発注)を受け付け、従来の単一IOL形式も同じ注文として扱う", async () => {
  const owner2 = await createUser("bulk-owner@example.jp", { verified: true });
  const reg = await call("registerFacility", { name: "ネリマ眼科クリニック", requestId: "order-e2e-register-02" }, owner2.idToken);
  const fid = reg.body.result.facilityId;
  for (const id of ["jj-dib00v", "nidek-nsp-2"]) await putDoc(`facilities/${fid}/adoptedIols/${id}`, { facilityId: fid, catalogIolId: id, enabled: true });
  await putDoc(`facilities/${fid}/orderers/o1`, { facilityId: fid, name: "山田", active: false });
  const base = { facilityId: fid, requestId: "order-e2e-request-0101", ordererId: "o1" };
  const lines = [
    { modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: future(14) },
    { modelId: "nidek-nsp-2", power: "+5.5D", quantity: 2, surgeryDate: future(21) }
  ];
  const ok = await call("createOrder", { ...base, lines }, owner2.idToken);
  assert.equal(ok.body.result.lineCount, 2);
  assert.equal(ok.body.result.totalQuantity, 3);
  const saved = await getDoc(`facilities/${fid}/orders/${ok.body.result.orderId}`);
  assert.equal(saved.fields.lines.arrayValue.values.length, 2);
  // 1明細でも不正なら全体を拒否(明細番号つき)
  const bad = await call("createOrder", { ...base, requestId: "order-e2e-request-0102", lines: [lines[0], { ...lines[1], power: "+4.5D" }] }, owner2.idToken);
  assert.equal(bad.body.error.status, "INVALID_ARGUMENT");
  assert.match(bad.body.error.message, /明細2/);
  // 従来の単一IOL形式
  const single = { ...base, requestId: "order-e2e-request-0103", ...lines[0] };
  const s1 = await call("createOrder", single, owner2.idToken);
  const s2 = await call("createOrder", { ...base, requestId: "order-e2e-request-0103", lines: [lines[0]] }, owner2.idToken);
  assert.equal(s2.body.result.orderNumber, s1.body.result.orderNumber);
  assert.equal(s2.body.result.replayed, true);
});
