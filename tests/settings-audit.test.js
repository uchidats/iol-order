import test from "node:test";
import assert from "node:assert/strict";
import { describeSettingChange, maskEmail } from "../functions/src/settings-audit.js";

test("メールアドレスは伏せ字と指紋だけ(アドレスそのものは残さない)。大文字小文字・空白は同じアドレス", () => {
  const m = maskEmail(" Order@Dealer.example.jp ");
  assert.equal(m.masked, "o***@dealer.example.jp");
  assert.match(m.fp, /^[0-9a-f]{8}$/);
  assert.deepEqual(maskEmail("order@dealer.example.jp"), m);
  assert.notEqual(maskEmail("other@dealer.example.jp").fp, m.fp);
  assert.ok(!JSON.stringify(m).includes("order@"));
  assert.equal(maskEmail(""), null);
});

test("ディーラーの発注用メール: 追加・削除を、伏せ字・指紋・件数で記録する", () => {
  const before = { name: "A商会", orderEmails: ["a@one.jp", "b@one.jp"], usageReportEmails: ["r@one.jp"], sortOrder: 10, updatedAt: 1 };
  const after = { name: "A商会", orderEmails: ["a@one.jp", "x@evil.example"], usageReportEmails: ["r@one.jp"], sortOrder: 10, updatedAt: 2 };
  const d = describeSettingChange(before, after);
  assert.equal(d.action, "update");
  assert.deepEqual(Object.keys(d.changes), ["orderEmails"]);
  assert.deepEqual(d.changes.orderEmails.added.map(x => x.masked), ["x***@evil.example"]);
  assert.deepEqual(d.changes.orderEmails.removed.map(x => x.masked), ["b***@one.jp"]);
  assert.deepEqual([d.changes.orderEmails.countBefore, d.changes.orderEmails.countAfter], [2, 2]);
  assert.ok(!JSON.stringify(d).includes("x@evil.example") && !JSON.stringify(d).includes("b@one.jp"));
  // すべて削除
  const cleared = describeSettingChange(before, { ...before, orderEmails: [] });
  assert.equal(cleared.changes.orderEmails.countAfter, 0);
  assert.equal(cleared.changes.orderEmails.removed.length, 2);
});

test("並び順・更新日時だけの変更、大文字小文字だけのメールの違いは記録しない", () => {
  assert.equal(describeSettingChange({ name: "山田", sortOrder: 1, updatedAt: 1 }, { name: "山田", sortOrder: 2, updatedAt: 2 }), null);
  assert.equal(describeSettingChange({ name: "A", orderEmails: ["a@x.jp"] }, { name: "A", orderEmails: ["A@X.jp "] }), null);
});

test("担当医・採用IOL: 作成・変更・削除。担当医のメールも伏せ字", () => {
  const c = describeSettingChange(null, { facilityId: "f", name: "山田", email: "y@clinic.jp", sortOrder: 1 });
  assert.equal(c.action, "create");
  assert.deepEqual(c.changes.name, { before: null, after: "山田" });
  assert.equal(c.changes.email.after.masked, "y***@clinic.jp");
  assert.equal("facilityId" in c.changes, false);
  const u = describeSettingChange({ catalogIolId: "m", enabled: true }, { catalogIolId: "m", enabled: false });
  assert.deepEqual(u, { action: "update", changes: { enabled: { before: true, after: false } } });
  const del = describeSettingChange({ name: "A商会", orderEmails: ["a@one.jp"] }, null);
  assert.equal(del.action, "delete");
  assert.equal(del.changes.orderEmails.removed[0].masked, "a***@one.jp");
});

import { resolveActor, authDiagnostics } from "../functions/src/settings-audit.js";
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });
const T = "2026-10-25T03:00:00.000Z";

test("変更者: 作成・更新は、この書き込みで更新時刻が新しくなった updatedBy(Rules で検証済み)を優先する", async () => {
  const before = { name: "A", updatedAt: ts("2026-10-24T00:00:00Z"), updatedBy: "old" };
  const after = { name: "B", updatedAt: ts(T), updatedBy: "adminA" };
  assert.deepEqual(await resolveActor({ before, after, authType: "unknown", time: T }), { actorType: "user", actorUid: "adminA", actorSource: "updatedBy", actorVerified: true });
  assert.equal((await resolveActor({ before: null, after, authType: undefined, time: T })).actorUid, "adminA", "作成");
  // Admin SDK が updatedAt を変えずに書いた: 前回の updatedBy(old)を使わない
  const stale = await resolveActor({ before, after: { ...after, updatedAt: before.updatedAt, updatedBy: "old" }, authType: "unknown", time: T });
  assert.deepEqual([stale.actorType, stale.actorUid], ["unknown", null]);
  // 旧データ・旧画面(updatedBy なし)
  assert.equal((await resolveActor({ before: { name: "A" }, after: { name: "B", updatedAt: ts(T) }, authType: "unknown", time: T })).actorType, "unknown");
});

test("変更者: サーバー処理(service_account / system)は updatedBy があっても server。uid は記録しない", async () => {
  for (const authType of ["service_account", "system"]) {
    const r = await resolveActor({ before: null, after: { name: "B", updatedAt: ts(T), updatedBy: "adminA" }, authType, authId: "sa@x.iam.gserviceaccount.com", time: T });
    assert.deepEqual([r.actorType, r.actorUid], ["server", null], authType);
  }
});

test("変更者: 削除は、同じ一括書き込みの削除の記録(時刻が削除イベントに近いもの)だけを使う", async () => {
  const before = { name: "A商会", updatedAt: ts("2026-10-24T00:00:00Z") };
  const mark = { deletedBy: "subA", deletedAt: ts(T) };
  assert.deepEqual(await resolveActor({ before, after: null, mark, authType: "unknown", time: "2026-10-25T03:00:00.300Z" }), { actorType: "user", actorUid: "subA", actorSource: "deletionMark", actorVerified: true });
  assert.equal((await resolveActor({ before, after: null, mark, authType: "unknown", time: "2026-10-25T03:10:00Z" })).actorType, "unknown", "古い記録(10分前)は使わない");
  assert.equal((await resolveActor({ before: { updatedAt: ts("2026-10-25T04:00:00Z") }, after: null, mark, authType: "unknown", time: T })).actorType, "unknown", "最後の更新より前の記録は使わない");
  assert.equal((await resolveActor({ before, after: null, mark: null, authType: "unknown", time: T })).actorType, "unknown", "記録なし(旧画面・Admin SDK)");
});

test("変更者: Auth Context は補助。app_user の authId がこの施設の所属の uid と一致するときだけ、未検証として記録する", async () => {
  const base = { before: { name: "A" }, after: { name: "B" }, authType: "app_user", time: T };
  assert.deepEqual(await resolveActor({ ...base, authId: "adminA", isMember: async (u) => u === "adminA" }), { actorType: "user", actorUid: "adminA", actorSource: "authContext", actorVerified: false });
  assert.equal((await resolveActor({ ...base, authId: "hash-or-other", isMember: async () => false })).actorType, "unknown");
  assert.equal((await resolveActor({ ...base, authId: "a b@c", isMember: async () => true })).actorType, "unknown", "uid の形式でないものは使わない");
});

test("診断用の認証情報: authId はサービスアカウントのときだけ残す。それ以外は変更者との一致だけ", () => {
  assert.deepEqual(authDiagnostics("service_account", "sa@x.iam.gserviceaccount.com", null), { type: "service_account", id: "sa@x.iam.gserviceaccount.com" });
  assert.deepEqual(authDiagnostics("app_user", "adminA", "adminA"), { type: "app_user", idMatchesActor: true });
  assert.deepEqual(authDiagnostics("user", "developer@example.jp", null), { type: "user" }, "個人のアカウント(IAMユーザー)の識別情報は残さない");
  assert.deepEqual(authDiagnostics(undefined, undefined, null), { type: "unknown" });
});

test("updatedBy の変更だけでは記録しない(変更内容の項目に含めない)", () => {
  assert.equal(describeSettingChange({ name: "A", updatedBy: "x" }, { name: "A", updatedBy: "y" }), null);
});
