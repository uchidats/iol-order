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
