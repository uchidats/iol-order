import test from "node:test";
import assert from "node:assert/strict";
import { planMemberRemoval, memberLabel, sortMembers, confirmMessage } from "../src/domain/member-admin.js";

const m = (uid, role, extra = {}) => ({ uid, role, ...extra });
const members = [m("a1", "admin", { displayName: "管理者" }), m("o1", "orderer", { displayName: "山田", email: "y@example.jp" }), m("o2", "orderer")];

test("一般注文者の所属は削除できる(他人の orderer のみ)", () => {
  assert.deepEqual(planMemberRemoval(members, members[1], "a1"), { ok: true });
  assert.deepEqual(planMemberRemoval(members, members[2], "a1"), { ok: true });
});

test("自分自身・管理者・最後の管理者・不明な権限・不明な対象は削除できない", () => {
  assert.equal(planMemberRemoval(members, members[1], "o1").ok, false);          // 自分自身
  const last = planMemberRemoval(members, members[0], "someoneElse");            // 最後の管理者
  assert.equal(last.ok, false);
  assert.match(last.reason, /最後の管理者/);
  const two = [...members, m("a2", "admin")];
  assert.match(planMemberRemoval(two, two[0], "a2").reason, /管理者の所属は削除できません/); // 管理者は何人いても不可
  assert.equal(planMemberRemoval(members, m("x", "owner"), "a1").ok, false);
  assert.equal(planMemberRemoval(members, null, "a1").ok, false);
  assert.equal(planMemberRemoval(members, members[1], "").ok, false);
});

test("画面に有効/無効の概念は残っていない(関数・表示名・状態)", async () => {
  const mod = await import("../src/domain/member-admin.js");
  for (const gone of ["planMemberToggle", "buildMemberChange", "newAuditId", "isLastActiveAdmin", "MEMBER_ACTION"]) assert.equal(gone in mod, false, gone);
});

test("一覧の並び: 管理者 → 注文者、氏名。氏名未登録は表示を補う", () => {
  const list = sortMembers([m("o2", "orderer", { displayName: "いろは" }), m("o1", "orderer", { displayName: "あいう" }), m("a1", "admin", { displayName: "ん" })]);
  assert.deepEqual(list.map(x => x.uid), ["a1", "o1", "o2"]);
  assert.equal(memberLabel(m("x", "orderer")), "（氏名未登録）");
  assert.equal(memberLabel(m("x", "orderer", { displayName: " 山田 " })), "山田");
});

test("確認メッセージに、対象・影響・再参加には新しい招待が必要なことが含まれる", () => {
  const msg = confirmMessage(members[1]);
  assert.match(msg, /山田（y@example\.jp）/);
  assert.match(msg, /所属をこの施設から削除/);
  assert.match(msg, /利用できなくなります/);
  assert.match(msg, /新しい招待/);
  assert.doesNotMatch(msg, /無効|有効/);
});
