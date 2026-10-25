// firestore.rules の役割の一覧と、Functions 側の定義(functions/src/roles.js)が一致することを確認する
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEMBER_ROLES, MANAGER_ROLES, canManageRole } from "../functions/src/roles.js";

const rules = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../firestore.rules"), "utf8");
const listIn = (fn) => {
  const m = rules.match(new RegExp(`function ${fn}\\(\\) \\{ return \\[([^\\]]*)\\]; \\}`));
  assert.ok(m, `${fn} が firestore.rules に見つかりません`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
};

test("Rules と Functions の役割の一覧が一致する", () => {
  assert.deepEqual(listIn("memberRoles"), [...MEMBER_ROLES]);
  assert.deepEqual(listIn("managerRoles"), [...MANAGER_ROLES]);
});

test("Rules の所属判定・管理者判定は、役割の一覧の関数だけを使う(役割の直書きをしない)", () => {
  assert.ok(!/role in \['admin', 'orderer'\]/.test(rules), "旧来の役割の直書きが残っている");
  assert.match(rules, /get\(memberPath\(fid\)\)\.data\.role in memberRoles\(\)/);
  assert.match(rules, /get\(memberPath\(fid\)\)\.data\.role in managerRoles\(\)/);
  assert.match(rules, /request\.resource\.data\.role in memberRoles\(\)/);
});

test("権限の範囲: 副管理者が扱えるのは注文者・代行入力者だけ。管理者・副管理者の権限管理は管理者のみ", () => {
  const all = ["admin", "subadmin", "orderer", "proxy"];
  assert.deepEqual(all.filter(r => canManageRole("admin", r)), all);
  assert.deepEqual(all.filter(r => canManageRole("subadmin", r)), ["orderer", "proxy"]);
  for (const actor of ["orderer", "proxy", "viewer", undefined]) assert.deepEqual(all.filter(r => canManageRole(actor, r)), []);
  assert.equal(canManageRole("admin", "viewer"), false);
});
