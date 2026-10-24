// 所属 status 廃止の移行: 計画と実行条件の検証(ネットワーク・書き込みなし)
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { buildMemberPlan, parseMemberArgs, PROJECT } from "../scripts/admin/member-migration.mjs";

const mem = (facilityId, id, fields) => ({ facilityId, id, fields, updateTime: "2026-10-24T00:00:00.000000Z" });
const data = [
  mem("fT", "adminT", { uid: "adminT", role: "admin", status: "active" }),
  mem("fT", "ord1", { uid: "ord1", role: "orderer", status: "active", lastAuditId: "a1" }),
  mem("fT", "off1", { uid: "off1", role: "orderer", status: "disabled", displayName: "元注文者" }),
  mem("fS", "adminS", { uid: "adminS", role: "admin", status: "active" }),
  mem("fS", "new1", { uid: "new1", role: "orderer" })
];

test("phase 1: 無効の所属は、削除するか明示的に有効に戻すかを指定しない限り実行できない(勝手に有効にしない)", () => {
  const p = buildMemberPlan(data, { phase: 1 });
  assert.equal(p.ok, false);
  assert.match(p.errors.join("\n"), /fT\/off1.*勝手には有効にしません/);
  assert.deepEqual(p.ops, []);
});

test("phase 1: 削除指定なら無効の所属だけを削除、有効に戻す指定ならその所属だけ status=active。有効な所属・role には触れない", () => {
  const del = buildMemberPlan(data, { phase: 1, removeDisabled: ["fT/off1"] });
  assert.equal(del.ok, true);
  assert.deepEqual(del.ops.map(o => [o.type, o.key]), [["delete", "fT/off1"]]);
  const res = buildMemberPlan(data, { phase: 1, restoreDisabled: ["fT/off1"] });
  assert.deepEqual(res.ops.map(o => [o.type, o.key]), [["restore", "fT/off1"]]);
  for (const p of [del, res]) assert.ok(!p.ops.some(o => ["fT/adminT", "fT/ord1", "fS/adminS", "fS/new1"].includes(o.key)));
});

test("phase 2: 無効の所属が残っていると実行できない(status を取り除くと有効になってしまう)", () => {
  const p = buildMemberPlan(data, { phase: 2 });
  assert.equal(p.ok, false);
  assert.match(p.errors.join("\n"), /fT\/off1.*無効の所属が残っています/);
});

test("phase 2: 無効が無ければ、status と lastAuditId を持つ所属からだけフィールドを取り除く。新形式の所属は触らない", () => {
  const clean = data.filter(x => x.id !== "off1");
  const p = buildMemberPlan(clean, { phase: 2 });
  assert.equal(p.ok, true);
  assert.deepEqual(p.ops.map(o => [o.key, o.fields.join()]), [["fT/adminT", "status"], ["fT/ord1", "status,lastAuditId"], ["fS/adminS", "status"]]);
  assert.deepEqual(p.summary, { total: 4, admins: 2, orderers: 2, statusActive: 3, statusDisabled: 0, noStatus: 1, ops: 3 });
});

test("判断の指定ミス・想定外の値・施設の管理者が居なくなる削除はエラー", () => {
  assert.equal(buildMemberPlan(data, { phase: 1, removeDisabled: ["fT/off1"], restoreDisabled: ["fT/off1"] }).ok, false);
  assert.equal(buildMemberPlan(data, { phase: 1, removeDisabled: ["fT/off1", "fX/none"] }).ok, false);
  assert.match(buildMemberPlan(data, { phase: 1, removeDisabled: ["fT/off1", "fT/ord1"] }).errors.join("\n"), /fT\/ord1.*無効\(status=disabled\)の所属ではありません/);
  assert.equal(buildMemberPlan([mem("f", "x", { role: "orderer", status: "paused" })], { phase: 2 }).ok, false);
  assert.equal(buildMemberPlan([mem("f", "x", { role: "owner" })], { phase: 2 }).ok, false);
  // 無効な唯一の管理者は削除できない(施設に管理者が居なくなる)
  const onlyAdminOff = [mem("f", "adm", { role: "admin", status: "disabled" }), mem("f", "o", { role: "orderer", status: "active" })];
  assert.match(buildMemberPlan(onlyAdminOff, { phase: 1, removeDisabled: ["f/adm"] }).errors.join("\n"), /有効な管理者が居なくなる/);
  assert.equal(buildMemberPlan(onlyAdminOff, { phase: 1, restoreDisabled: ["f/adm"] }).ok, true);
});

test("実行条件: 既定は dry-run・phase 必須。実行には --execute・--backup・--confirm <プロジェクトID> がすべて必要", () => {
  assert.ok(parseMemberArgs([]).errors.some(e => e.includes("--phase")));
  assert.deepEqual(parseMemberArgs(["--phase", "1"]).errors, []);
  assert.equal(parseMemberArgs(["--phase", "1"]).mode, "dry-run");
  assert.ok(parseMemberArgs(["--phase", "3"]).errors.length > 0);
  assert.ok(parseMemberArgs(["--phase", "2", "--execute"]).errors.length >= 2);
  assert.ok(parseMemberArgs(["--phase", "2", "--execute", "--backup", "b.json", "--confirm", "other"]).errors.some(e => e.includes("--confirm")));
  assert.deepEqual(parseMemberArgs(["--phase", "2", "--execute", "--backup", "b.json", "--confirm", PROJECT]).errors, []);
  assert.ok(parseMemberArgs(["--phase", "1", "--backup", "b.json"]).errors.length > 0);
  assert.ok(parseMemberArgs(["--phase", "1", "--project", "prod"]).errors.length > 0);
  const a = parseMemberArgs(["--phase", "1", "--remove-disabled", "a/1,b/2", "--restore-disabled", "c/3"]);
  assert.deepEqual([a.removeDisabled, a.restoreDisabled], [["a/1", "b/2"], ["c/3"]]);
});

test("CLI: 条件を満たさない --execute は、ネットワークに触れる前に終了コード2で拒否される", () => {
  const r = spawnSync(process.execPath, ["scripts/admin/migrate-member-status.mjs", "--phase", "1", "--execute"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--backup/);
  assert.match(r.stderr, /--confirm/);
});
