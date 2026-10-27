import test from "node:test";
import assert from "node:assert/strict";
import { createRegistrationApi, describeCallableError } from "../src/data/registration-api.js";
import * as flow from "../src/domain/registration-flow.js";

const mem = () => {
  const d = new Map();
  return { getItem: k => d.get(k) ?? null, setItem: (k, v) => d.set(k, String(v)), removeItem: k => d.delete(k) };
};

test("API: 送るのは施設名・要求ID・確認フラグのみ（権限や施設IDは送れない）", async () => {
  const calls = [];
  const api = createRegistrationApi({
    functions: { name: "fn" },
    httpsCallable: (fns, name) => async (payload) => { calls.push([name, payload]); return { data: { ok: true } }; }
  });
  await api.registerFacility({ name: "施設", requestId: "r".repeat(20) });
  await api.registerFacility({ name: "施設", requestId: "r".repeat(20), confirmDuplicate: true, role: "admin", facilityId: "x" });
  await api.addMember({ facilityId: "fac-1", name: "x", email: "a@example.jp", role: "orderer", uid: "evil" });
  await api.respondMembership({ pendingId: "p", accept: "yes", role: "admin" });
  assert.deepEqual(calls[0], ["registerFacility", { name: "施設", requestId: "r".repeat(20) }]);
  assert.deepEqual(calls[1], ["registerFacility", { name: "施設", requestId: "r".repeat(20), confirmDuplicate: true }]);
  assert.deepEqual(calls[2], ["addMember", { facilityId: "fac-1", name: "x", email: "a@example.jp", role: "orderer" }]);
  assert.deepEqual(calls[3], ["respondMembership", { pendingId: "p", accept: false }], "承認は true のときだけ");
  // 施設の登録申請(申請者名つき)・申請の一覧・承認・却下。承認権限はサーバーが確認する(画面からは申請IDと判断だけを送る)
  await api.registerFacility({ name: "施設", requestId: "r".repeat(20), applicantName: "申請 太郎" });
  await api.listFacilityApplications();
  await api.decideFacilityApplication({ applicationId: "fac-1", decision: "approve", firstAdmin: { name: "責任者", email: "b@example.jp" }, platformAdmin: true });
  await api.decideFacilityApplication({ applicationId: "fac-1", decision: "reject", reason: "重複" });
  assert.deepEqual(calls.slice(4), [
    ["registerFacility", { name: "施設", requestId: "r".repeat(20), applicantName: "申請 太郎" }],
    ["listFacilityApplications", {}],
    ["decideFacilityApplication", { applicationId: "fac-1", decision: "approve", firstAdmin: { name: "責任者", email: "b@example.jp" } }],
    ["decideFacilityApplication", { applicationId: "fac-1", decision: "reject", reason: "重複" }]]);
  // 旧招待コード方式の呼び出し口はない
  assert.equal("createInvite" in api, false);
  assert.equal("acceptInvite" in api, false);
});

test("エラー表示: サーバーの日本語メッセージは表示し、内部エラーは詳細を出さない", () => {
  assert.equal(describeCallableError({ code: "functions/permission-denied", message: "メールの確認が必要です" }), "メールの確認が必要です");
  assert.equal(describeCallableError({ code: "functions/failed-precondition", message: "参加の確認ができませんでした" }), "参加の確認ができませんでした");
  assert.match(describeCallableError({ code: "functions/internal", message: "INTERNAL stack trace ..." }), /処理に失敗しました/);
  assert.ok(!describeCallableError({ code: "functions/internal", message: "secret detail" }).includes("secret"));
  assert.match(describeCallableError({ code: "functions/unavailable", message: "x" }), /接続できません/);
  assert.match(describeCallableError(new Error("boom")), /処理に失敗しました/);
  assert.match(describeCallableError(null), /処理に失敗しました/);
});

test("要求ID: 同じ施設名の再試行は同じID、施設名を変えたら新しいID、成功後はクリア", () => {
  const s = mem();
  let n = 0;
  const uuid = () => `id-${++n}`;
  const a1 = flow.getRequestId(s, "新規 クリニック", uuid);
  const a2 = flow.getRequestId(s, " 新規　クリニック ", uuid); // 正規化後に同じ名前
  assert.equal(a1, a2);
  const b = flow.getRequestId(s, "別のクリニック", uuid);
  assert.notEqual(b, a1);
  flow.clearRequestId(s);
  assert.notEqual(flow.getRequestId(s, "別のクリニック", uuid), b);
});

test("要求IDの保存が使えない環境でも落ちない", () => {
  const broken = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); }, removeItem() { throw new Error("x"); } };
  assert.equal(typeof flow.getRequestId(broken, "施設", () => "id-x"), "string");
  flow.clearRequestId(broken);
});

test("施設名の検証", () => {
  assert.equal(flow.validateFacilityName("立川病院"), "");
  assert.notEqual(flow.validateFacilityName(""), "");
  assert.notEqual(flow.validateFacilityName("   "), "");
  assert.notEqual(flow.validateFacilityName("あ".repeat(101)), "");
  assert.equal(flow.validateFacilityName("あ".repeat(100)), "");
});
