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

let verified, unverified, operator;
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
  for (let i = 0; i < 40; i++) { st = [await status("d_dA"), await status("copy")]; if (st.every(s => s === "held")) break; await new Promise(r => setTimeout(r, 250)); }
  assert.deepEqual(st, ["held", "held"], "ディーラー宛て・注文控えとも未送信(停止中)");
  const order = await getDoc(`facilities/${fid}/orders/${oid}`);
  assert.equal(order.fields.status.stringValue, "accepted", "停止中は「受付済み(ディーラー未通知)」のまま");
  assert.deepEqual(order.fields.notifications.arrayValue.values.map(v => v.mapValue.fields.status.stringValue), ["held", "held"]);
});
