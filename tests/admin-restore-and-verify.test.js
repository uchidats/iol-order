// バックアップからの復元(計画・引数)と、公開サイトのバージョン確認(比較)のテスト。ネットワーク・書き込みなし
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { readBackup, planRestore, parseRestoreArgs, docPathOf, PROJECT } from "../scripts/admin/restore-plan.mjs";
import { extractStamp, diffStamps, parseVerifyArgs } from "../scripts/verify-deployed.mjs";

const D = "projects/medconf-iol-dev/databases/(default)/documents";
const raw = (p, fields) => ({ name: `${D}/${p}`, fields, updateTime: "t0" });
const s = (v) => ({ stringValue: v });
const backup = { project: PROJECT, collection: "orderers", docs: [
  raw("facilities/f/orderers/a", { name: s("内田"), active: { booleanValue: true } }),
  raw("facilities/f/orderers/b", { name: s("内田2"), active: { booleanValue: false } }),
  raw("facilities/f/orderers/c", { name: s("削除済"), active: { booleanValue: false } })
] };
const cur = new Map([
  ["facilities/f/orderers/a", { fields: { name: s("内田") }, updateTime: "t1" }],                                        // active が無い(移行後)
  ["facilities/f/orderers/b", { fields: { name: s("改名後"), active: { booleanValue: false } }, updateTime: "t2" }],   // 既に同じ
  ["facilities/f/orderers/c", null]                                                                                      // 削除済み
]);

test("復元計画: active だけを戻し、他のフィールド(名前など)には触れない。同じ値・削除済みは対象外", () => {
  const p = planRestore("orderers", backup.docs, cur);
  assert.equal(p.ok, true);
  assert.deepEqual(p.ops.map(o => [o.type, o.path, o.fields]), [["restore", "facilities/f/orderers/a", ["active"]]]);
  assert.deepEqual(p.ops[0].body, { fields: { active: { booleanValue: true } } });
  assert.equal(p.ops[0].updateTime, "t1");
  assert.equal(p.skipped.length, 2);
  assert.match(p.skipped.join("\n"), /orderers\/c.*--recreate-deleted/);
});

test("復元計画: --recreate-deleted のときだけ削除済みを再作成する(全フィールド)", () => {
  const p = planRestore("orderers", backup.docs, cur, { recreateDeleted: true });
  const re = p.ops.find(o => o.type === "recreate");
  assert.equal(re.path, "facilities/f/orderers/c");
  assert.deepEqual(re.body.fields, backup.docs[2].fields);
});

test("復元計画: 所属は status と lastAuditId だけを戻す(role などは触れない)", () => {
  const b = readBackup({ project: PROJECT, phase: 2, members: [raw("facilities/f/members/u", { uid: s("u"), role: s("orderer"), status: s("active"), lastAuditId: s("x") })] });
  assert.equal(b.kind, "members");
  const c = new Map([["facilities/f/members/u", { fields: { uid: s("u"), role: s("admin") }, updateTime: "t" }]]);
  const p = planRestore(b.kind, b.docs, c);
  assert.deepEqual(p.ops[0].fields, ["status", "lastAuditId"]);
  assert.deepEqual(Object.keys(p.ops[0].body.fields).sort(), ["lastAuditId", "status"]);
});

test("バックアップの検証: 別プロジェクト・未対応の種類・不正な形式は拒否", () => {
  assert.ok(readBackup({ ...backup, project: "other" }).error);
  assert.ok(readBackup({ ...backup, collection: "orders" }).error);
  assert.ok(readBackup(null).error);
  assert.ok(readBackup({ project: PROJECT }).error);
  assert.equal(docPathOf(backup.docs[0]), "facilities/f/orderers/a");
});

test("復元の実行条件: 既定は dry-run。--backup 必須、実行には --confirm <プロジェクトID>", () => {
  assert.ok(parseRestoreArgs([]).errors.length > 0);
  assert.deepEqual(parseRestoreArgs(["--backup", "b.json"]).errors, []);
  assert.equal(parseRestoreArgs(["--backup", "b.json"]).mode, "dry-run");
  assert.ok(parseRestoreArgs(["--backup", "b.json", "--execute"]).errors.some(e => e.includes("--confirm")));
  assert.deepEqual(parseRestoreArgs(["--backup", "b.json", "--execute", "--confirm", PROJECT]).errors, []);
  assert.ok(parseRestoreArgs(["--backup", "b.json", "--project", "x"]).errors.length > 0);
  const r = spawnSync(process.execPath, ["scripts/admin/restore-from-backup.mjs", "--execute", "--backup", "x.json"], { encoding: "utf8" });
  assert.equal(r.status, 2);
});

test("公開版の確認: 手元と同じ import map・?v= なら一致。違い・旧版(import map なし)は不一致", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const local = extractStamp(html);
  assert.ok(Object.keys(local.imports).length > 10 && local.css && local.main);
  assert.deepEqual(diffStamps(local, extractStamp(html.replace(/\r?\n/g, "\r\n"))), []);
  const changed = html.replace(/("\.\/src\/main\.js": "\.\/src\/main\.js\?v=)[0-9a-f]+/, "$1ffffffffff");
  assert.match(diffStamps(local, extractStamp(changed)).join("\n"), /src\/main\.js/);
  assert.ok(diffStamps(local, extractStamp("<html><head></head></html>")).length > 0);
  assert.ok(parseVerifyArgs(["--url", "http://x"]).errors.length > 0);
  assert.deepEqual(parseVerifyArgs(["--wait", "20", "--interval", "30"]).errors, []);
});
