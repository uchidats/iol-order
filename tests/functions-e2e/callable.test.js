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

// ディーラー画面の確認済みの端末(UID ごと)。メールリンクのログインで確認コードを確かめたときに返った値を持ち、以後の dealerPortalApi に付ける(画面が端末に保存するのと同じ)。
// data に deviceToken: null を書くと付けない(未確認の端末からの呼び出し)
const e2eDevices = new Map();
const uidOfToken = (t) => { try { return JSON.parse(Buffer.from(String(t).split(".")[1], "base64url").toString()).user_id || null; } catch (e) { return null; } };
async function call(name, data, idToken) {
  let payload = data;
  const uid = name === "dealerPortalApi" && idToken ? uidOfToken(idToken) : null;
  if (uid && data && typeof data === "object") {
    const { deviceToken, ...rest } = data;
    const dev = "deviceToken" in data ? deviceToken : e2eDevices.get(uid);
    payload = { ...rest, ...(dev ? { deviceToken: dev } : {}) };
  }
  const r = await fetch(`http://${FN}/${PROJECT}/${REGION}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data: payload })
  });
  const body = await r.json();
  if (uid && body && body.result && typeof body.result.deviceToken === "string") e2eDevices.set(uid, body.result.deviceToken);
  return { http: r.status, body };
}

const getDoc = async (p) => {
  const r = await fetch(`http://${FS}/v1/projects/${PROJECT}/databases/(default)/documents/${p}`, { headers: { Authorization: "Bearer owner" } });
  return r.status === 200 ? r.json() : null;
};

let verified, unverified, operator;
/** ディーラー画面の本人確認: 確認コードを送り(エミュレータではテスト用の文書 v-{uid} に書かれる)、そのコードで確認する(参加を含む) */
async function dealerVerifyE2E(idToken) {
  const sent = await call("dealerPortalApi", { action: "sendCode", deviceToken: null }, idToken);
  if (!sent.body.result) return sent;
  const sink = await getDoc(`dealerJoinCodeTestSink/v-${uidOfToken(idToken)}`);
  return call("dealerPortalApi", { action: "verifyCode", code: sink.fields.code.stringValue, deviceToken: null }, idToken);
}
/** 運営者(カスタムクレーム platformAdmin。エミュレータの管理APIで設定) */
async function createOperator(email) {
  const u = await createUser(email, { verified: true });
  await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
    body: JSON.stringify({ localId: u.uid, customAttributes: JSON.stringify({ platformAdmin: true }) })
  });
  const s = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password-for-emulator", returnSecureToken: true })
  });
  return { uid: u.uid, idToken: (await s.json()).idToken };
}
/** 新しい施設は「申請 → 運営者の承認」で作られる(申請者が最初の管理者)。結果は従来の registerFacility と同じ形(status: created) */
async function registerApproved(data, idToken) {
  const a = await call("registerFacility", { ...data, confirmDuplicate: true }, idToken);
  if (!a.body.result) return a;
  const d = await call("decideFacilityApplication", { applicationId: a.body.result.applicationId, decision: "approve", confirmDuplicate: true }, operator.idToken);
  return d.body.result ? { http: d.http, body: { result: { status: "created", facilityId: d.body.result.facilityId } } } : d;
}
before(async () => {
  verified = await createUser("owner@example.jp", { verified: true });
  unverified = await createUser("unverified@example.jp", { verified: false });
  operator = await createOperator("operator@example.jp");
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

test("callable: メール確認済みのアカウントは施設の登録を申請でき、運営者の承認で施設が有効になり最初の管理者になる", async () => {
  const r = await call("registerFacility", { name: "E2Eクリニック", requestId: "verified-request-0001", applicantName: "申請 太郎" }, verified.idToken);
  assert.equal(r.http, 200);
  assert.deepEqual([r.body.result.status, r.body.result.applicationStatus], ["submitted", "pending"]);
  const fid = r.body.result.applicationId;
  assert.match(fid, /^fac-[0-9a-f]{24}$/);
  assert.equal(await getDoc(`facilities/${fid}`), null, "申請の時点では施設を作らない");
  assert.equal(await getDoc(`facilities/${fid}/members/${verified.uid}`), null, "管理者の権限も付けない");
  // 承認権限: 申請者本人・一般ユーザーは承認できない。運営者の一覧に出る
  assert.equal((await call("decideFacilityApplication", { applicationId: fid, decision: "approve" }, verified.idToken)).body.error.status, "PERMISSION_DENIED");
  assert.equal((await call("listFacilityApplications", {}, verified.idToken)).body.error.status, "PERMISSION_DENIED");
  const list = await call("listFacilityApplications", {}, operator.idToken);
  assert.deepEqual(list.body.result.pending.map(p => [p.id, p.name, p.applicant.name, p.applicant.email]), [[fid, "E2Eクリニック", "申請 太郎", "owner@example.jp"]]);
  const d = await call("decideFacilityApplication", { applicationId: fid, decision: "approve" }, operator.idToken);
  assert.equal(d.body.result.status, "approved");
  assert.equal((await call("decideFacilityApplication", { applicationId: fid, decision: "approve" }, operator.idToken)).body.error.status, "FAILED_PRECONDITION", "二重承認はできない");
  const mem = await getDoc(`facilities/${fid}/members/${verified.uid}`);
  assert.equal(mem.fields.role.stringValue, "admin");
  assert.equal(mem.fields.status, undefined, "membership has no status");
  const fac = await getDoc(`facilities/${fid}`);
  assert.equal(fac.fields.createdBy.stringValue, verified.uid);
});

test("callable: 施設の事前登録 → 初期管理者の参加確認 → 承諾で施設が有効になり管理者になる(運営者以外は事前登録できない)", async () => {
  const denied = await call("preregisterFacility", { name: "E2E事前登録眼科", adminEmail: "prereg-boss@example.jp", requestId: "prereg-e2e-request-0001" }, verified.idToken);
  assert.equal(denied.body.error.status, "PERMISSION_DENIED");
  const r = await call("preregisterFacility", { name: "E2E事前登録眼科", adminEmail: "prereg-boss@example.jp", requestId: "prereg-e2e-request-0001" }, operator.idToken);
  assert.equal(r.body.result.status, "created");
  const fid = r.body.result.facilityId;
  assert.equal((await getDoc(`facilities/${fid}`)).fields.status.stringValue, "preregistered");
  const bossUser = await createUser("prereg-boss@example.jp", { verified: true });
  const mine = (await call("listMyPendingMemberships", {}, bossUser.idToken)).body.result.memberships;
  assert.deepEqual(mine.map(m => [m.facilityId, m.role, m.initialAdmin]), [[fid, "admin", true]]);
  assert.equal(await getDoc(`facilities/${fid}/members/${bossUser.uid}`), null, "承諾前は管理者ではない");
  const joined = await call("respondMembership", { pendingId: mine[0].pendingId, accept: true }, bossUser.idToken);
  assert.equal(joined.body.result.status, "joined");
  assert.equal((await getDoc(`facilities/${fid}`)).fields.status.stringValue, "active");
  assert.equal((await getDoc(`facilities/${fid}/members/${bossUser.uid}`)).fields.role.stringValue, "admin");
});

test("callable: 再送は同じ申請を返す(冪等)。権限の指定は INVALID_ARGUMENT", async () => {
  const again = await call("registerFacility", { name: "E2Eクリニック", requestId: "verified-request-0001" }, verified.idToken);
  assert.deepEqual([again.body.result.status, again.body.result.applicationStatus], ["submitted", "approved"], "同じ要求の再送は同じ申請(処理済み)");
  const forged = await call("registerFacility", { name: "別施設", requestId: "verified-request-0002", role: "admin", platformAdmin: true }, verified.idToken);
  assert.equal(forged.body.error.status, "INVALID_ARGUMENT");
});

test("callable: 利用者管理の事前登録→本人のログインで参加確認→承認。別メールの人は参加できない。旧招待コードの関数はない", async () => {
  const reg = await registerApproved({ name: "事前登録E2E医院", requestId: "verified-request-0003" }, verified.idToken);
  const facilityId = reg.body.result.facilityId;

  // 管理者以外(メール未確認)は登録できない
  const denied = await call("addMember", { facilityId, name: "看護師", email: "nurse@example.jp", role: "orderer" }, unverified.idToken);
  assert.equal(denied.body.error.status, "PERMISSION_DENIED");
  const added = await call("addMember", { facilityId, name: "看護師", email: "nurse@example.jp", role: "orderer" }, verified.idToken);
  assert.equal(added.http, 200);
  const pendingId = added.body.result.pendingId;

  const stranger = await createUser("stranger@example.jp", { verified: true });
  assert.deepEqual((await call("listMyPendingMemberships", {}, stranger.idToken)).body.result.memberships, []);
  const wrong = await call("respondMembership", { pendingId, accept: true }, stranger.idToken);
  assert.equal(wrong.body.error.status, "FAILED_PRECONDITION");
  assert.equal(await getDoc(`facilities/${facilityId}/members/${stranger.uid}`), null);

  const nurse = await createUser("nurse@example.jp", { verified: true });
  const mine = (await call("listMyPendingMemberships", {}, nurse.idToken)).body.result.memberships;
  assert.deepEqual(mine.map(m => [m.facilityId, m.role]), [[facilityId, "orderer"]]);
  const ok = await call("respondMembership", { pendingId, accept: true }, nurse.idToken);
  assert.equal(ok.body.result.status, "joined");
  const mem = await getDoc(`facilities/${facilityId}/members/${nurse.uid}`);
  assert.equal(mem.fields.role.stringValue, "orderer");
  const reuse = await call("respondMembership", { pendingId, accept: true }, nurse.idToken);
  assert.equal(reuse.body.error.status, "FAILED_PRECONDITION");

  // 旧招待コード方式の関数は存在しない(廃止)
  for (const gone of ["createInvite", "acceptInvite"]) {
    const r = await fetch(`http://${FN}/${PROJECT}/${REGION}/${gone}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${verified.idToken}` },
      body: JSON.stringify({ data: { token: "A".repeat(43) } })
    });
    assert.equal(r.status, 404, `${gone} は存在しない`);
  }
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
  const reg = await registerApproved({ name: "注文E2E医院", requestId: "order-e2e-register-01" }, verified.idToken);
  const fid = reg.body.result.facilityId;
  await putDoc(`facilities/${fid}/adoptedIols/jj-dib00v`, { facilityId: fid, catalogIolId: "jj-dib00v", enabled: true });
  await putDoc(`facilities/${fid}/orderers/o1`, { facilityId: fid, name: "山田" });

  const data = { facilityId: fid, requestId: "order-e2e-request-0001", modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: future(30), doctorId: "o1" };
  const ok = await call("createOrder", data, verified.idToken);
  assert.equal(ok.http, 200);
  assert.equal(ok.body.result.status, "accepted");
  assert.match(ok.body.result.orderNumber, /^IOL-\d{8}-01$/);

  const saved = await getDoc(`facilities/${fid}/orders/${ok.body.result.orderId}`);
  assert.equal(saved.fields.status.stringValue, "accepted");
  assert.equal(saved.fields.createdBy.mapValue.fields.uid.stringValue, verified.uid);
  const l0 = saved.fields.lines.arrayValue.values[0].mapValue.fields;
  assert.equal(l0.doctor.mapValue.fields.name.stringValue, "山田");   // 担当医(明細のスナップショット)
  assert.equal(saved.fields.orderer, undefined, "no order-level orderer");

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
  const reg = await registerApproved({ name: "ネリマ眼科クリニック", requestId: "order-e2e-register-02" }, owner2.idToken);
  const fid = reg.body.result.facilityId;
  for (const id of ["jj-dib00v", "nidek-nsp-2"]) await putDoc(`facilities/${fid}/adoptedIols/${id}`, { facilityId: fid, catalogIolId: id, enabled: true });
  await putDoc(`facilities/${fid}/orderers/o1`, { facilityId: fid, name: "山田", active: false });
  const base = { facilityId: fid, requestId: "order-e2e-request-0101" };
  const lines = [
    { modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: future(14), doctorId: "o1" },
    { modelId: "nidek-nsp-2", power: "+5.5D", quantity: 2, surgeryDate: future(21), doctorId: "o1" }
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

test("callable: removeMember は管理者だけが一般注文者の所属を削除できる(履歴つき)。管理者の所属・他人は削除できない", async () => {
  const owner3 = await createUser("rm-owner@example.jp", { verified: true });
  const reg = await registerApproved({ name: "サクラ眼科クリニック", requestId: "rm-e2e-register-0001" }, owner3.idToken);
  const fid = reg.body.result.facilityId;
  const added = await call("addMember", { facilityId: fid, name: "看護師", email: "rm-nurse@example.jp", role: "orderer" }, owner3.idToken);
  const nurse = await createUser("rm-nurse@example.jp", { verified: true });
  assert.equal((await call("respondMembership", { pendingId: added.body.result.pendingId, accept: true }, nurse.idToken)).http, 200);
  const mem = await getDoc(`facilities/${fid}/members/${nurse.uid}`);
  assert.equal(mem.fields.status, undefined, "membership has no status");

  // 注文者は削除できない・管理者の所属は削除できない
  assert.equal((await call("removeMember", { facilityId: fid, uid: owner3.uid }, nurse.idToken)).body.error.status, "PERMISSION_DENIED");
  assert.equal((await call("removeMember", { facilityId: fid, uid: owner3.uid }, owner3.idToken)).body.error.status, "FAILED_PRECONDITION");
  assert.equal((await call("removeMember", { facilityId: fid, uid: nurse.uid }, null)).body.error.status, "UNAUTHENTICATED");
  // 管理者が一般注文者の所属を削除
  const ok = await call("removeMember", { facilityId: fid, uid: nurse.uid }, owner3.idToken);
  assert.equal(ok.body.result.removed, true);
  assert.equal(await getDoc(`facilities/${fid}/members/${nurse.uid}`), null);
  assert.equal((await call("removeMember", { facilityId: fid, uid: nurse.uid }, owner3.idToken)).body.error.status, "NOT_FOUND");
  // 削除された人は、その施設の注文を作れない
  const order = await call("createOrder", { facilityId: fid, requestId: "rm-e2e-order-000001", modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10), ordererId: "x" }, nurse.idToken);
  assert.equal(order.body.error.status, "PERMISSION_DENIED");
});

test("施設設定の変更履歴: 画面と同じ書き込み(Rules を通した updatedBy・削除の記録)から、トリガーが変更者・内容を auditLogs に記録する", async () => {
  const admin = await createUser("audit-admin@example.jp", { verified: true });   // 施設登録の回数制限に当たらないよう、別の利用者
  const reg = await registerApproved({ name: "E2E履歴クリニック", requestId: "audit-request-0001" }, admin.idToken);
  assert.equal(reg.http, 200);
  const fid = reg.body.result.facilityId;
  const base = `projects/${PROJECT}/databases/(default)/documents/facilities/${fid}`;
  const commit = (writes, idToken = admin.idToken) => fetch(`http://${FS}/v1/projects/${PROJECT}/databases/(default)/documents:commit`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ writes })
  });
  const str = (v) => ({ stringValue: v });
  const dealer = (emails, by) => ({
    update: { name: `${base}/facilityDealers/dE2E`, fields: { facilityId: str(fid), name: str("E2E商会"),
      orderEmails: { arrayValue: { values: emails.map(str) } }, ...(by ? { updatedBy: str(by) } : {}) } },
    updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
  });
  assert.equal((await commit([dealer(["a@one.jp"], admin.uid)])).status, 200);
  assert.equal((await commit([dealer(["z@other.jp"], admin.uid)])).status, 200);
  assert.equal((await commit([dealer(["x@evil.example"], "someone-else")])).status, 403, "他人の uid は Rules が拒否");
  assert.equal((await commit([{ delete: `${base}/facilityDealers/dE2E` }, {
    update: { name: `${base}/deletionMarks/facilityDealers_dE2E`, fields: { collection: str("facilityDealers"), docId: str("dE2E"), deletedBy: str(admin.uid) } },
    updateTransforms: [{ fieldPath: "deletedAt", setToServerValue: "REQUEST_TIME" }] }])).status, 200);
  const list = async () => {
    const r = await fetch(`http://${FS}/v1/projects/${PROJECT}/databases/(default)/documents/facilities/${fid}/auditLogs`, { headers: { Authorization: "Bearer owner" } });
    return ((await r.json()).documents || []).filter(d => d.fields.target && d.fields.target.mapValue.fields.collection.stringValue === "facilityDealers");   // 施設の承認の記録(facility.approve)は対象外
  };
  let docs = [];
  for (let i = 0; i < 40 && docs.length < 3; i++) { docs = await list(); if (docs.length < 3) await new Promise(r => setTimeout(r, 250)); }
  const by = (action) => docs.filter(d => d.fields.action.stringValue === `settings.facilityDealers.${action}`).map(d => d.fields);
  assert.deepEqual([by("create").length, by("update").length, by("delete").length], [1, 1, 1], "作成・変更・削除の3件(拒否された書き込みは記録されない)");
  for (const [action, source] of [["create", "updatedBy"], ["update", "updatedBy"], ["delete", "deletionMark"]]) {
    const f = by(action)[0];
    // エミュレータはトリガーに認証情報を渡さない(authType: unknown)が、Rules で検証した値から変更者が決まる
    assert.deepEqual([f.actorType.stringValue, f.actorUid.stringValue, f.actorSource.stringValue, f.actorVerified.booleanValue], ["user", admin.uid, source, true], action);
  }
  const json = JSON.stringify(docs);
  assert.ok(json.includes("z***@other.jp"));
  assert.ok(!json.includes("z@other.jp") && !json.includes("a@one.jp"), "アドレスそのものは記録しない");
});

test("注文メール: createOrder が送信待ちを保存し、トリガーが処理する。送信機能が停止中(MAIL_SENDING_ENABLED=false)なので送らずに held(実際のメールは送らない)", async () => {
  const owner = await createUser("mail-owner@example.jp", { verified: true });
  const reg = await registerApproved({ name: "E2Eメール医院", requestId: "mail-e2e-register-01" }, owner.idToken);
  const fid = reg.body.result.facilityId;
  await putDoc(`facilities/${fid}/adoptedIols/jj-dib00v`, { facilityId: fid, catalogIolId: "jj-dib00v", enabled: true });
  await putDoc(`facilities/${fid}/orderers/o1`, { facilityId: fid, name: "山田" });
  const put = (p, fields) => fetch(`http://${FS}/v1/projects/${PROJECT}/databases/(default)/documents/${p}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Authorization: "Bearer owner" }, body: JSON.stringify({ fields })
  });
  assert.equal((await put(`facilities/${fid}/facilityDealers/dA`, { facilityId: { stringValue: fid }, name: { stringValue: "A商会" }, orderEmails: { arrayValue: { values: [{ stringValue: "order-a@example.jp" }] } } })).status, 200);
  assert.equal((await put(`facilities/${fid}/settings/mail`, { copyEnabled: { booleanValue: true }, copyEmail: { stringValue: "info@example.jp" } })).status, 200);
  const ok = await call("createOrder", { facilityId: fid, requestId: "mail-e2e-request-0001", lines: [{ modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: future(30), doctorId: "o1", dealerId: "dA" }] }, owner.idToken);
  assert.equal(ok.http, 200);
  const oid = ok.body.result.orderId;
  const status = async (m) => ((await getDoc(`facilities/${fid}/orders/${oid}/mails/${m}`)) || { fields: {} }).fields.status?.stringValue;
  let st = [];
  for (let i = 0; i < 80; i++) { st = [await status("d_dA"), await status("copy")]; if (st.every(s => s === "held")) break; await new Promise(r => setTimeout(r, 250)); }   // 最大20秒(トリガーの処理を待つ)
  assert.deepEqual(st, ["held", "held"], "ディーラー宛て・注文控えとも未送信(停止中)");
  const order = await getDoc(`facilities/${fid}/orders/${oid}`);
  assert.equal(order.fields.status.stringValue, "accepted", "停止中は「受付済み(ディーラー未通知)」のまま");
  assert.deepEqual(order.fields.notifications.arrayValue.values.map(v => v.mapValue.fields.status.stringValue), ["held", "held"]);
});

test("ディーラー専用画面: 運営者の会社登録・招待 → 本人の参加 → 関連付け → 施設の管理者の許可 → 注文 → トリガーが索引を作り、自社宛ての明細だけを取得。所属のない人は拒否。注文メールは従来どおり", async () => {
  const owner = await createUser("portal-owner@example.jp", { verified: true });
  const staff = await createUser("staff@dealer-x.example.jp", { verified: true });
  const outsider = await createUser("outsider@dealer-x.example.jp", { verified: true });
  const reg = await registerApproved({ name: "E2Eディーラー閲覧医院", requestId: "portal-e2e-register-01" }, owner.idToken);
  const fid = reg.body.result.facilityId;
  await putDoc(`facilities/${fid}/adoptedIols/jj-dib00v`, { facilityId: fid, catalogIolId: "jj-dib00v", enabled: true });
  await putDoc(`facilities/${fid}/orderers/o1`, { facilityId: fid, name: "山田" });
  const put = (p, fields) => fetch(`http://${FS}/v1/projects/${PROJECT}/databases/(default)/documents/${p}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Authorization: "Bearer owner" }, body: JSON.stringify({ fields })
  });
  for (const [id, n, e] of [["dX", "エックス商事", "order-x@example.jp"], ["dY", "ワイ医療", "order-y@example.jp"]]) {
    assert.equal((await put(`facilities/${fid}/facilityDealers/${id}`, { facilityId: { stringValue: fid }, name: { stringValue: n }, orderEmails: { arrayValue: { values: [{ stringValue: e }] } } })).status, 200);
  }
  const op = (data) => call("dealerPortalOperator", data, operator.idToken);
  // 運営者以外は会社を登録できない
  assert.equal((await call("dealerPortalOperator", { action: "createCompany", name: "不正", requestId: "portal-e2e-company-0" }, owner.idToken)).body.error.status, "PERMISSION_DENIED");
  const cid = (await op({ action: "createCompany", name: "エックス商事", requestId: "portal-e2e-company-1" })).body.result.companyId;
  await op({ action: "inviteStaff", companyId: cid, email: "staff@dealer-x.example.jp", name: "担当", role: "reader" });
  assert.deepEqual((await call("dealerPortalApi", { action: "sendCode" }, outsider.idToken)).body.result, { ok: true, expiresInMinutes: 10 }, "応答は登録の有無で変えない");
  assert.equal(await getDoc(`dealerJoinCodeTestSink/v-${uidOfToken(outsider.idToken)}`), null, "別のメールの人には送らない(参加できない)");
  assert.equal((await call("dealerPortalApi", { action: "context" }, staff.idToken)).body.error.status, "PERMISSION_DENIED", "確認コードなしでは参加・閲覧できない(パスワードのログイン)");
  assert.equal((await dealerVerifyE2E(staff.idToken)).body.result.joined, 1);
  assert.equal((await op({ action: "proposeLink", facilityId: fid, localDealerId: "dX", companyId: cid })).http, 200);
  const st = (await call("facilityDealerPortal", { action: "status", facilityId: fid }, owner.idToken)).body.result.dealers.find(d => d.localDealerId === "dX");
  assert.equal((await call("facilityDealerPortal", { action: "grant", facilityId: fid, localDealerId: "dX", revision: st.link.revision }, owner.idToken)).body.result.status, "active");
  // 2社の明細を含む注文
  const ok = await call("createOrder", { facilityId: fid, requestId: "portal-e2e-order-0001", notes: "共通の備考", lines: [
    { modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: future(30), doctorId: "o1", dealerId: "dY" },
    { modelId: "jj-dib00v", power: "+21.0D", quantity: 2, surgeryDate: future(30), doctorId: "o1", dealerId: "dX" }] }, owner.idToken);
  assert.equal(ok.http, 200);
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const list = () => call("dealerPortalApi", { action: "list", from: today, to: today, facilityFilter: { mode: "all" } }, staff.idToken);
  let items = [];
  for (let i = 0; i < 80; i++) { items = (await list()).body.result.items; if (items.length) break; await new Promise(r => setTimeout(r, 250)); }   // トリガーが索引を作るのを待つ(最大20秒)
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].orderNumber, items[0].lineCount, items[0].totalQuantity], [ok.body.result.orderNumber, 1, 2]);
  const detail = (await call("dealerPortalApi", { action: "get", receiptId: items[0].receiptId }, staff.idToken)).body.result;
  assert.deepEqual(detail.lines.map(l => [l.no, l.power, l.quantity]), [[1, "+21.0D", 2]]);
  assert.ok(!JSON.stringify(detail).includes("ワイ医療") && !JSON.stringify(detail).includes("共通の備考"));
  assert.equal((await call("dealerPortalApi", { action: "context" }, outsider.idToken)).body.error.status, "PERMISSION_DENIED");
  assert.equal((await call("dealerPortalApi", { action: "context" }, null)).body.error.status, "UNAUTHENTICATED");
  // 注文メールは従来どおり(発注先ごと。エミュレータでは送信停止中なので held)
  const mailStatus = async (m) => ((await getDoc(`facilities/${fid}/orders/${ok.body.result.orderId}/mails/${m}`)) || { fields: {} }).fields.status?.stringValue;
  let ms = [];
  for (let i = 0; i < 80; i++) { ms = [await mailStatus("d_dX"), await mailStatus("d_dY")]; if (ms.every(s => s === "held")) break; await new Promise(r => setTimeout(r, 250)); }
  assert.deepEqual(ms, ["held", "held"]);
  // 取消の後は取得できない
  const st2 = (await call("facilityDealerPortal", { action: "status", facilityId: fid }, owner.idToken)).body.result.dealers.find(d => d.localDealerId === "dX");
  assert.equal((await call("facilityDealerPortal", { action: "revoke", facilityId: fid, localDealerId: "dX", revision: st2.link.revision }, owner.idToken)).body.result.status, "revoked");
  assert.equal((await call("dealerPortalApi", { action: "get", receiptId: items[0].receiptId }, staff.idToken)).body.error.status, "NOT_FOUND");
});

// ---------- ディーラー専用画面: 認証主体のホワイトリスト(Auth エミュレータ。既定の「同じメールは1アカウント」) ----------
const AUTH_API = `http://${AUTH}/identitytoolkit.googleapis.com/v1`;
const post = async (url, body) => (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
/** メールリンクでログイン(エミュレータの oobCode を使う) */
async function signInWithEmailLinkE2E(email) {
  await post(`${AUTH_API}/accounts:sendOobCode?key=fake`, { requestType: "EMAIL_SIGNIN", email, continueUrl: "http://localhost/dealer.html", canHandleCodeInApp: true });
  const codes = (await (await fetch(`http://${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`)).json()).oobCodes.filter(c => c.email === email && c.requestType === "EMAIL_SIGNIN");
  const r = await post(`${AUTH_API}/accounts:signInWithEmailLink?key=fake`, { email, oobCode: codes.at(-1).oobCode });
  return { uid: r.localId, idToken: r.idToken, refreshToken: r.refreshToken };
}
/** Google・Microsoft でログイン(エミュレータは署名なしの id_token を受け付ける) */
async function signInWithIdpE2E(providerId, email, { sub, verified = true } = {}) {
  const idt = JSON.stringify({ sub, email, email_verified: verified });
  const r = await post(`${AUTH_API}/accounts:signInWithIdp?key=fake`, { postBody: `id_token=${encodeURIComponent(idt)}&providerId=${providerId}`, requestUri: "http://localhost", returnSecureToken: true });
  return { uid: r.localId, idToken: r.idToken, refreshToken: r.refreshToken, error: r.error };
}
/** トークンの更新(画面の getIdToken(true) と同じ) */
async function refreshE2E(refreshToken) {
  const t = await (await fetch(`http://${AUTH}/securetoken.googleapis.com/v1/token?key=fake`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}` })).json();
  return t.id_token;
}
const decodeToken = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
const needsVerifyE2E = (res) => res.body.error && res.body.error.status === "PERMISSION_DENIED" && res.body.error.details && res.body.error.details.reason === "verification-required";

// 注意: Google・Microsoft のトークンは試験用の模擬トークン(エミュレータ)。エミュレータは同じメールのアカウントを同じ UID に結び付けることがある
// (本番は競合・別の UID になり得る)。どちらでも、認証主体の紐付けで判定することを確かめる
test("ディーラー専用画面の本人確認: メールリンク・Google・Microsoft とも初回は確認コード(承認済みのメール)で同じ担当者に紐付け、確認したブラウザで使える(トークンの更新後も)。新しいブラウザでは確認し直す", async () => {
  const op = (data) => call("dealerPortalOperator", data, operator.idToken);
  const api = (data, token) => call("dealerPortalApi", data, token);
  const cid = (await op({ action: "createCompany", name: "ジー商事", requestId: "portal-e2e-auth-company-1" })).body.result.companyId;
  const email = "staff-a@dealer-g.example.jp";
  const staffId = (await op({ action: "inviteStaff", companyId: cid, email, name: "担当A", role: "reader" })).body.result.staffId;
  // メールリンク: 確認コード → 参加。この端末の値が返る(画面が端末に保存)
  const link = await signInWithEmailLinkE2E(email);
  assert.ok(needsVerifyE2E(await api({ action: "companies" }, link.idToken)));
  const v1 = await dealerVerifyE2E(link.idToken);
  assert.deepEqual([v1.body.result.joined, typeof v1.body.result.deviceToken], [1, "string"]);
  assert.equal((await api({ action: "context" }, link.idToken)).body.result.company.id, cid);
  assert.ok(needsVerifyE2E(await api({ action: "context", deviceToken: null }, link.idToken)), "メールリンクは端末ごと");
  // Google(同じ UID・別の UID のどちらでも): 初回は確認コード。確認したブラウザ(端末の値)で使える
  const g = await signInWithIdpE2E("google.com", email, { sub: "g-staff-a" });
  assert.equal(decodeToken(g.idToken).firebase.sign_in_provider, "google.com");
  assert.ok(needsVerifyE2E(await api({ action: "context", deviceToken: null }, g.idToken)));
  const gv = await dealerVerifyE2E(g.idToken);
  assert.deepEqual([gv.body.result.companies, typeof gv.body.result.deviceToken], [1, "string"]);
  const gDevice = gv.body.result.deviceToken;
  assert.equal((await api({ action: "context", deviceToken: gDevice }, g.idToken)).body.result.company.id, cid);
  assert.ok(needsVerifyE2E(await api({ action: "context", deviceToken: null }, g.idToken)), "新しいブラウザでは確認し直す");
  const gRefreshed = await refreshE2E(g.refreshToken);
  assert.equal(decodeToken(gRefreshed).firebase.sign_in_provider, "google.com", "更新後もログイン方法は変わらない");
  assert.equal((await api({ action: "context", deviceToken: gDevice }, gRefreshed)).body.result.company.id, cid);
  // Microsoft: 同様
  const m = await signInWithIdpE2E("microsoft.com", email, { sub: "m-staff-a" });
  assert.ok(needsVerifyE2E(await api({ action: "context", deviceToken: null }, m.idToken)));
  const mv = await dealerVerifyE2E(m.idToken);
  assert.equal(mv.body.result.companies, 1);
  assert.equal((await api({ action: "context", deviceToken: mv.body.result.deviceToken }, m.idToken)).body.result.company.id, cid);
  // 担当者は1人(会社×メール)。紐付けは3方式
  const binds = await (await fetch(`http://${FS}/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "dealerAuthBindings" }], where: { fieldFilter: { field: { fieldPath: "staffId" }, op: "EQUAL", value: { stringValue: staffId } } } } }) })).json();
  assert.deepEqual(binds.filter(b => b.document).map(b => b.document.fields.provider.stringValue).sort(), ["device", "device", "device", "google", "microsoft"]);
  // 無効化で全方式が一度に失効
  await op({ action: "updateStaff", companyId: cid, staffId, status: "disabled" });
  for (const [t, d] of [[link.idToken, v1.body.result.deviceToken], [gRefreshed, gDevice], [m.idToken, mv.body.result.deviceToken]]) assert.equal((await api({ action: "context", deviceToken: d }, t)).body.error.status, "PERMISSION_DENIED");
});

// Codex の MS-01・G-02 の再現手順(自動の結び付け → パスワードの設定 → 連携の解除 → パスワードで入り直す)をすべて通しても、本人の確認コードなしには閲覧できない
test("ディーラー専用画面の本人確認(MS-01・G-02 の経路): 未登録の Microsoft が既存の UID に入り、パスワードを設定し、連携を外して入り直しても閲覧できない。本人の紐付けは使える。未招待・未確認は不可", async () => {
  const op = (data) => call("dealerPortalOperator", data, operator.idToken);
  const api = (data, token) => call("dealerPortalApi", data, token);
  const cid = (await op({ action: "createCompany", name: "エヌ商事", requestId: "portal-e2e-auth-company-2" })).body.result.companyId;
  const email = "staff-n@dealer-m.example.jp";
  await op({ action: "inviteStaff", companyId: cid, email, name: "担当N", role: "reader" });
  const link = await signInWithEmailLinkE2E(email);
  assert.equal((await dealerVerifyE2E(link.idToken)).body.result.joined, 1);
  // 同じメールを名乗る未登録の Microsoft(エミュレータでは同じ UID に入る)
  const m1 = await signInWithIdpE2E("microsoft.com", email, { sub: "m-intruder" });
  assert.equal(m1.uid, link.uid, "エミュレータの既定では同じ UID");
  assert.ok(needsVerifyE2E(await api({ action: "context", deviceToken: null }, m1.idToken)));
  // パスワードを設定して入り直す(Microsoft は連携されたまま)
  await post(`${AUTH_API}/accounts:update?key=fake`, { idToken: m1.idToken, password: "password-set-by-attacker-03", returnSecureToken: true });
  const pw = await post(`${AUTH_API}/accounts:signInWithPassword?key=fake`, { email, password: "password-set-by-attacker-03", returnSecureToken: true });
  assert.deepEqual([decodeToken(pw.idToken).firebase.sign_in_provider, decodeToken(pw.idToken).email_verified, !!decodeToken(pw.idToken).firebase.identities["microsoft.com"]], ["password", true, true]);
  // 連携を外してパスワードで入り直す(トークンは同じ UID・確認済みのメール・password・Microsoft なし)
  assert.ok(!(await post(`${AUTH_API}/accounts:update?key=fake`, { idToken: pw.idToken, deleteProvider: ["microsoft.com"], returnSecureToken: true })).error);
  const pw2 = await post(`${AUTH_API}/accounts:signInWithPassword?key=fake`, { email, password: "password-set-by-attacker-03", returnSecureToken: true });
  assert.deepEqual([pw2.localId, decodeToken(pw2.idToken).firebase.identities["microsoft.com"]], [link.uid, undefined]);
  for (const t of [pw.idToken, pw2.idToken]) {
    for (const [action, data] of [["context", {}], ["companies", {}], ["list", { from: "2026-01-01", to: "2026-12-31", facilityFilter: { mode: "all" } }], ["setAssignments", { facilityIds: [] }]]) {
      assert.ok(needsVerifyE2E(await api({ action, ...data, deviceToken: null }, t)), action);
    }
  }
  // コードは承認済みのメール(本人)にだけ届く。推測のコードでは確認できない。紐付けは増えない
  // (同じ UID のメールリンクの確認から1分以内なので、送り直しの間隔で断られることもある。確認の成功でも送信の間隔は消えない)
  const sc = await api({ action: "sendCode", deviceToken: null }, pw2.idToken);
  assert.ok((sc.body.result && sc.body.result.ok) || /1分/.test(sc.body.error && sc.body.error.message), JSON.stringify(sc.body));
  assert.equal((await getDoc(`dealerJoinCodeTestSink/v-${link.uid}`)).fields.to.stringValue, email);
  assert.equal((await api({ action: "verifyCode", code: "12345678", deviceToken: null }, pw2.idToken)).body.error.status, "FAILED_PRECONDITION");
  assert.ok(needsVerifyE2E(await api({ action: "context", deviceToken: null }, pw2.idToken)));
  // 本人(確認した端末)は、パスワードの設定・連携の解除の後も使える
  assert.equal((await api({ action: "context" }, (await signInWithEmailLinkE2E(email)).idToken)).body.result.company.id, cid);
  // 未招待の Microsoft・メール未確認の Google は何も見えない・送れない
  const outsider = await signInWithIdpE2E("microsoft.com", "someone@outlook-like.example.com", { sub: "m-out" });
  assert.ok(needsVerifyE2E(await api({ action: "context" }, outsider.idToken)));
  assert.equal((await api({ action: "sendCode" }, outsider.idToken)).body.result.ok, true, "応答は登録の有無で変えない");
  assert.equal(await getDoc(`dealerJoinCodeTestSink/v-${outsider.uid}`), null, "未招待には送らない");
  const unv = await signInWithIdpE2E("google.com", "unverified-g@dealer-m.example.jp", { sub: "g-unv", verified: false });
  assert.equal(decodeToken(unv.idToken).email_verified, false);
  for (const action of ["companies", "context", "sendCode"]) assert.equal((await api({ action }, unv.idToken)).body.error.status, "PERMISSION_DENIED", action);
});

// AB-02(Codex の再現手順): 未登録の Microsoft B の更新トークンを残したまま、本人が B を外し、Microsoft A で紐付けた後に、B の更新トークンで更新したトークン。
// エミュレータでは sign_in_provider は microsoft.com のまま、identities は A になる。B の側には確認したブラウザの値がないので閲覧できない
test("ディーラー専用画面の本人確認(AB-02): 旧 Microsoft B の更新トークンを、解除・A の紐付けの後に更新しても、A として閲覧できない。本人(A・確認したブラウザ)は使える", async () => {
  const op = (data) => call("dealerPortalOperator", data, operator.idToken);
  const api = (data, token) => call("dealerPortalApi", data, token);
  const cid = (await op({ action: "createCompany", name: "ビー商事", requestId: "portal-e2e-auth-company-3" })).body.result.companyId;
  const email = "staff-b@dealer-ab.example.jp";
  await op({ action: "inviteStaff", companyId: cid, email, name: "担当B", role: "reader" });
  const link = await signInWithEmailLinkE2E(email);
  assert.equal((await dealerVerifyE2E(link.idToken)).body.result.joined, 1);
  // 未登録の Microsoft B が同じ UID に入り、B の更新トークンを保持する
  const b = await signInWithIdpE2E("microsoft.com", email, { sub: "m-old-B" });
  assert.equal(b.uid, link.uid);
  assert.ok(needsVerifyE2E(await api({ action: "context", deviceToken: null }, b.idToken)));
  // 本人が B を外し、Microsoft A でログインして確認コードで紐付ける(A のブラウザに値が発行される)
  const linkNow = await signInWithEmailLinkE2E(email);
  assert.ok(!(await post(`${AUTH_API}/accounts:update?key=fake`, { idToken: linkNow.idToken, deleteProvider: ["microsoft.com"], returnSecureToken: true })).error);
  const a = await signInWithIdpE2E("microsoft.com", email, { sub: "m-new-A" });
  assert.equal(a.uid, link.uid);
  const av = await dealerVerifyE2E(a.idToken);
  assert.equal(av.body.result.companies, 1);
  const aDevice = av.body.result.deviceToken;
  // B の古い更新トークンだけで更新 → identities は A を指す
  const bRefreshed = await refreshE2E(b.refreshToken);
  const tok = decodeToken(bRefreshed);
  assert.deepEqual([tok.firebase.sign_in_provider, tok.firebase.identities["microsoft.com"].length], ["microsoft.com", 1]);
  const aId = decodeToken(a.idToken).firebase.identities["microsoft.com"][0];
  assert.equal(tok.firebase.identities["microsoft.com"][0], aId, "エミュレータでは、旧 B の更新トークンでも identities は A(Codex の観測と同じ)");
  for (const [action, data] of [["context", {}], ["companies", {}], ["list", { from: "2026-01-01", to: "2026-12-31", facilityFilter: { mode: "all" } }]]) {
    assert.ok(needsVerifyE2E(await api({ action, ...data, deviceToken: null }, bRefreshed)), action);
  }
  // 本人(A・確認したブラウザ)は使える
  assert.equal((await api({ action: "context", deviceToken: aDevice }, a.idToken)).body.result.company.id, cid);
});
