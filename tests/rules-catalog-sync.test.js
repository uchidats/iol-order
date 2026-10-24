import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IOL_MODELS } from "../src/data/iol-models.js";

const rules = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../firestore.rules"), "utf8");

// firestore.rules の validCatalogIolId に列挙されたID
function idsInRules() {
  const m = rules.match(/function validCatalogIolId\(v\) \{[\s\S]*?v in \[([\s\S]*?)\]/);
  assert.ok(m, "validCatalogIolId が firestore.rules に見つかりません");
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

test("共通IOLマスターのIDは一意で、不変の識別子として形式が揃っている", () => {
  const ids = IOL_MODELS.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9-]*$/);
});

test("firestore.rules の許可IOL ID一覧が IOL_MODELS と完全に一致する", () => {
  assert.deepEqual([...idsInRules()].sort(), IOL_MODELS.map(m => m.id).sort());
});

test("ルールのメール正規表現とクライアント検証が同じ入力を受理・拒否する", async () => {
  const { isValidEmail } = await import("../src/domain/order-validation.js");
  const m = rules.match(/v\.matches\('([^']+)'\)/);
  assert.ok(m);
  // ルール内の '\\s' は文字列エスケープ後に '\s' になる
  const re = new RegExp(m[1].replace(/\\\\/g, "\\"));
  for (const v of ["a@example.jp", "a.b+c@sub.example.co.jp", "a@b", "@example.jp", "a b@example.jp", "a@@example.jp", "a@example", ""]) {
    assert.equal(re.test(v), isValidEmail(v), v);
  }
});
