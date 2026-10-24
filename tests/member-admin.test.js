import test from "node:test";
import assert from "node:assert/strict";
import {
  MEMBER_ACTION, planMemberToggle, isLastActiveAdmin, sortMembers, memberLabel, confirmMessage, newAuditId, buildMemberChange
} from "../src/domain/member-admin.js";

const m = (uid, role, status = "active", extra = {}) => ({ uid, role, status, ...extra });
const members = [m("a1", "admin", "active", { displayName: "管理者" }), m("o1", "orderer"), m("o2", "orderer", "disabled")];

test("一般注文者は無効化・再有効化できる", () => {
  assert.deepEqual(planMemberToggle(members, members[1], "a1"), { ok: true, action: MEMBER_ACTION.DISABLE, to: "disabled" });
  assert.deepEqual(planMemberToggle(members, members[2], "a1"), { ok: true, action: MEMBER_ACTION.ENABLE, to: "active" });
});

test("自分自身・管理者・最後の有効な管理者・不明な権限は操作できない", () => {
  assert.equal(planMemberToggle(members, members[1], "o1").ok, false);
  const last = planMemberToggle(members, members[0], "someoneElse");
  assert.equal(last.ok, false);
  assert.match(last.reason, /最後の有効な管理者/);
  const two = [...members, m("a2", "admin")];
  assert.match(planMemberToggle(two, two[0], "a2").reason, /管理者の変更はできません/);
  assert.equal(planMemberToggle(members, m("x", "owner"), "a1").ok, false);
  assert.equal(planMemberToggle(members, null, "a1").ok, false);
  assert.equal(planMemberToggle(members, members[1], "").ok, false);
});

test("最後の有効な管理者の判定: 無効な管理者は数えない", () => {
  const list = [m("a1", "admin"), m("a2", "admin", "disabled")];
  assert.equal(isLastActiveAdmin(list, list[0]), true);
  assert.equal(isLastActiveAdmin(list, list[1]), false);
  assert.equal(isLastActiveAdmin([m("a1", "admin"), m("a2", "admin")], list[0]), false);
});

test("一覧の並び: 管理者→有効な注文者→無効な注文者。氏名未登録は表示を補う", () => {
  const list = sortMembers([m("o2", "orderer", "disabled"), m("o1", "orderer", "active", { displayName: "ぬ" }), m("a1", "admin")]);
  assert.deepEqual(list.map(x => x.uid), ["a1", "o1", "o2"]);
  assert.equal(memberLabel(m("x", "orderer")), "（氏名未登録）");
  assert.equal(memberLabel(m("x", "orderer", "active", { displayName: " 山田 " })), "山田");
});

test("確認メッセージに対象と影響が含まれる", () => {
  const t = m("o1", "orderer", "active", { displayName: "山田", email: "y@example.jp" });
  assert.match(confirmMessage(t, { to: "disabled" }), /山田（y@example.jp）.*無効化.*利用できなくなります/s);
  assert.match(confirmMessage(t, { to: "active" }), /再度有効/);
});

test("書き込み内容: 所属は status と記録IDだけ。記録に操作者・対象・前後の状態が入り、権限は含まれない", () => {
  const target = m("o1", "orderer", "active", { displayName: "山田" });
  const plan = planMemberToggle(members, target, "a1");
  const id = newAuditId(() => "11111111-2222-3333-4444-555555555555");
  assert.equal(id, "11111111222233334444555555555555");
  const c = buildMemberChange({ facilityId: "f1", target, plan, actor: { uid: "a1", displayName: "管理者" }, auditId: id });
  assert.deepEqual(c.memberUpdate, { status: "disabled", lastAuditId: id });
  assert.deepEqual(c.log, {
    action: "member.disable", targetUid: "o1", targetRole: "orderer", fromStatus: "active", toStatus: "disabled",
    actorUid: "a1", targetName: "山田", actorName: "管理者"
  });
  assert.ok(!("role" in c.memberUpdate));
});
