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

test("確認メッセージに、対象・影響・再参加には再登録が必要なことが含まれる", () => {
  const msg = confirmMessage(members[1]);
  assert.match(msg, /山田（y@example\.jp）/);
  assert.match(msg, /所属をこの施設から削除/);
  assert.match(msg, /利用できなくなります/);
  assert.match(msg, /「追加」から登録/);
  assert.doesNotMatch(msg, /無効|有効/);
});

// ---------- 役割(副管理者・代行入力者) ----------
import { canManageRole, assignableRoles, roleChoices, roleLabel, pendingState, sortPending, formatExpiry, MEMBER_ROLES, MANAGER_ROLES } from "../src/domain/member-admin.js";
import * as serverRoles from "../functions/src/roles.js";

test("画面の役割の定義は、サーバー(functions/src/roles.js)と一致する", () => {
  assert.deepEqual([...MEMBER_ROLES], [...serverRoles.MEMBER_ROLES]);
  assert.deepEqual([...MANAGER_ROLES], [...serverRoles.MANAGER_ROLES]);
  for (const a of [...MEMBER_ROLES, "viewer", undefined]) for (const t of [...MEMBER_ROLES, "viewer"]) {
    assert.equal(canManageRole(a, t), serverRoles.canManageRole(a, t), `${a} → ${t}`);
  }
  assert.deepEqual(MEMBER_ROLES.map(roleLabel), ["管理者", "副管理者", "注文者", "代行入力者"]);
});

test("事前登録で選べる役割: 管理者は副管理者・注文者・代行入力者、副管理者は注文者・代行入力者。注文者・代行入力者は選べない", () => {
  assert.deepEqual(assignableRoles("admin"), ["subadmin", "orderer", "proxy"]);
  assert.deepEqual(assignableRoles("subadmin"), ["orderer", "proxy"]);
  assert.deepEqual(assignableRoles("orderer"), []);
  assert.deepEqual(assignableRoles("proxy"), []);
});

test("役割の変更先: 副管理者は注文者⇔代行入力者のみ。管理者・副管理者は変更できない。最後の管理者は降格できない", () => {
  const list = [m("a1", "admin"), m("s1", "subadmin"), m("o1", "orderer"), m("p1", "proxy")];
  assert.deepEqual(roleChoices(list, list[2], "subadmin"), ["orderer", "proxy"]);
  assert.deepEqual(roleChoices(list, list[3], "subadmin"), ["orderer", "proxy"]);
  assert.deepEqual(roleChoices(list, list[1], "subadmin"), []);
  assert.deepEqual(roleChoices(list, list[0], "subadmin"), []);
  assert.deepEqual(roleChoices(list, list[1], "admin"), ["admin", "subadmin", "orderer", "proxy"]);
  assert.deepEqual(roleChoices(list, list[0], "admin"), [], "最後の管理者");
  const two = [...list, m("a2", "admin")];
  assert.deepEqual(roleChoices(two, two[0], "admin"), ["admin", "subadmin", "orderer", "proxy"]);
  assert.deepEqual(roleChoices(list, list[2], "orderer"), []);
});

test("削除: 副管理者は注文者・代行入力者のみ。管理者は副管理者も削除できるが、管理者は削除できない", () => {
  const list = [m("a1", "admin"), m("s1", "subadmin"), m("s2", "subadmin"), m("o1", "orderer"), m("p1", "proxy")];
  assert.equal(planMemberRemoval(list, list[3], "s1", "subadmin").ok, true);
  assert.equal(planMemberRemoval(list, list[4], "s1", "subadmin").ok, true);
  assert.equal(planMemberRemoval(list, list[2], "s1", "subadmin").ok, false);
  assert.equal(planMemberRemoval(list, list[0], "s1", "subadmin").ok, false);
  assert.equal(planMemberRemoval(list, list[1], "a1", "admin").ok, true);
  assert.equal(planMemberRemoval(list, list[3], "o1x", "orderer").ok, false);
});

test("参加待ちの状態: 期限内=参加待ち、期限切れ、辞退。並びは 参加待ち→期限切れ→辞退", () => {
  const now = Date.parse("2026-10-25T00:00:00Z");
  const p = (name, status, exp) => ({ name, status, expiresAt: exp === null ? null : new Date(exp).toISOString() });
  const list = [p("c", "declined", now + 1e6), p("b", "pending", now - 1), p("a", "pending", now + 1e6)];
  assert.deepEqual(list.map(x => pendingState(x, now)), ["declined", "expired", "pending"]);
  assert.deepEqual(sortPending(list, now).map(x => x.name), ["a", "b", "c"]);
  assert.equal(pendingState(p("d", "pending", null), now), "expired");
  assert.equal(pendingState({ status: "pending", expiresAt: { seconds: now / 1000 + 10 } }, now), "pending", "Firestore の Timestamp 形式");
  assert.equal(formatExpiry("2026-11-24T00:00:00Z"), "2026/11/24");
});
