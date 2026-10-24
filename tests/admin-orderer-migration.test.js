// 注文者 active 廃止の移行: 計画と実行条件の検証(ネットワーク・書き込みなし)
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { buildPlan, parseMigrationArgs, PROJECT } from "../scripts/admin/orderer-migration.mjs";

const o = (facilityId, id, fields) => ({ facilityId, id, fields, updateTime: "2026-10-24T00:00:00.000000Z" });
const data = [
  o("fT", "t1", { name: "内田", active: true, sortOrder: 10 }),
  o("fT", "t2", { name: "内田2", active: false, sortOrder: 20 }),
  o("fS", "s1", { name: "内田", active: true }),
  o("fS", "s2", { name: "新形式", sortOrder: 20 })
];

test("移行計画: 件数の集計(全体・active=true・active=false・既に新形式)", () => {
  const p = buildPlan(data, { removeInactive: ["fT/t2"] });
  assert.deepEqual(p.summary, { total: 4, withActiveField: 3, inactive: 1, activeTrue: 2, toDelete: 1, toDropActive: 2, alreadyNewFormat: 1 });
  assert.equal(p.ok, true);
});

test("移行計画: 無効(active=false)は、残すか削除するかを明示しない限り実行できない", () => {
  const p = buildPlan(data);
  assert.equal(p.ok, false);
  assert.match(p.errors.join("\n"), /fT\/t2.*内田2.*--keep-inactive か --remove-inactive/);
});

test("移行計画: 残す指定なら active だけを除去し、削除はしない。削除指定ならそのドキュメントだけ削除", () => {
  const keep = buildPlan(data, { keepInactive: ["fT/t2"] });
  assert.deepEqual(keep.ops.map(x => [x.type, x.key]), [["dropActive", "fT/t1"], ["dropActive", "fT/t2"], ["dropActive", "fS/s1"]]);
  const del = buildPlan(data, { removeInactive: ["fT/t2"] });
  assert.deepEqual(del.ops.map(x => [x.type, x.key]), [["dropActive", "fT/t1"], ["delete", "fT/t2"], ["dropActive", "fS/s1"]]);
  // 既に新形式のドキュメントには何もしない
  assert.ok(!keep.ops.some(x => x.key === "fS/s2"));
});

test("移行計画: 判断の指定ミス(存在しない・有効な注文者・両方指定)や、不正な値はエラー。有効な注文者は削除できない", () => {
  assert.equal(buildPlan(data, { keepInactive: ["fT/t2"], removeInactive: ["fT/t2"] }).ok, false);
  assert.equal(buildPlan(data, { keepInactive: ["fT/t2", "fX/none"] }).ok, false);
  const p = buildPlan(data, { keepInactive: ["fT/t2"], removeInactive: ["fT/t1"] }); // t1 は有効
  assert.equal(p.ok, false);
  assert.match(p.errors.join("\n"), /fT\/t1.*無効\(active=false\)の注文者ではありません/);
  assert.equal(buildPlan([o("f", "x", { name: "a", active: "no" })], {}).ok, false);
});

test("実行条件: 既定は dry-run。実行には --execute・--backup・--confirm <プロジェクトID> がすべて必要。--project は指定できない", () => {
  assert.equal(parseMigrationArgs([]).mode, "dry-run");
  assert.deepEqual(parseMigrationArgs([]).errors, []);
  assert.ok(parseMigrationArgs(["--execute"]).errors.length >= 2);
  assert.ok(parseMigrationArgs(["--execute", "--backup", "b.json"]).errors.some(e => e.includes("--confirm")));
  assert.ok(parseMigrationArgs(["--execute", "--confirm", "other-project", "--backup", "b.json"]).errors.some(e => e.includes("--confirm")));
  assert.deepEqual(parseMigrationArgs(["--execute", "--confirm", PROJECT, "--backup", "b.json"]).errors, []);
  assert.ok(parseMigrationArgs(["--backup", "b.json"]).errors.length > 0, "backup without execute is rejected");
  assert.ok(parseMigrationArgs(["--project", "prod"]).errors.length > 0);
  assert.ok(parseMigrationArgs(["--wat"]).errors.length > 0);
  const a = parseMigrationArgs(["--keep-inactive", "a/1,b/2", "--remove-inactive", "c/3"]);
  assert.deepEqual([a.keepInactive, a.removeInactive], [["a/1", "b/2"], ["c/3"]]);
});

test("CLI: 条件を満たさない --execute は、ネットワークに触れる前に終了コード2で拒否される", () => {
  const r = spawnSync(process.execPath, ["scripts/admin/migrate-orderer-active.mjs", "--execute"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--backup/);
  assert.match(r.stderr, /--confirm/);
});

test("対象コレクション: 既定は orderers。ディーラー(facilityDealers)も指定でき、それ以外は拒否される", () => {
  assert.equal(parseMigrationArgs([]).collection, "orderers");
  assert.deepEqual(parseMigrationArgs(["--collection", "facilityDealers"]).errors, []);
  assert.equal(parseMigrationArgs(["--collection", "facilityDealers"]).collection, "facilityDealers");
  for (const bad of ["members", "facilities", "", "orders"]) assert.ok(parseMigrationArgs(["--collection", bad]).errors.length > 0, bad);
});
