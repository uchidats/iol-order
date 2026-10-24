import test from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS, parseEmailList, validateOrderers, planOrdererWrites, validateAdoption, planAdoptedWrites,
  validateDealers, planDealerWrites, moveItem
} from "../src/domain/facility-settings.js";
import { IOL_MODELS } from "../src/data/iol-models.js";
import { resolveAdoptedModels } from "../src/data/static-repository.js";

const F = "fac1";

test("メール一覧: 区切り・重複・形式・上限", () => {
  assert.deepEqual(parseEmailList("a@example.jp, b@example.jp\nA@example.jp;c@example.jp").emails, ["a@example.jp", "b@example.jp", "c@example.jp"]);
  assert.equal(parseEmailList("").errors.length, 0);
  assert.equal(parseEmailList("not-an-email").errors.length, 1);
  assert.equal(parseEmailList("a@example.jp b").errors.length, 1);
  const six = [1, 2, 3, 4, 5, 6].map(n => `u${n}@example.jp`).join("\n");
  assert.ok(parseEmailList(six).errors.some(e => e.includes(String(LIMITS.emailsPerList))));
  assert.equal(parseEmailList("a@" + "x".repeat(250) + ".jp").errors.length, 1);
});

test("注文者: 必須・長さ・重複・メール形式を検証", () => {
  const ok = validateOrderers([{ name: " 内田 ", email: "" }, { name: "角田", email: "t@example.jp" }]);
  assert.equal(ok.ok, true);
  assert.equal(ok.cleaned[0].name, "内田");
  assert.equal(validateOrderers([{ name: "" }]).ok, false);
  assert.equal(validateOrderers([{ name: "あ".repeat(51) }]).ok, false);
  assert.equal(validateOrderers([{ name: "A" }, { name: " a " }]).ok, false); // 大文字小文字・空白差の重複
  assert.equal(validateOrderers([{ name: "ＡＢ" }, { name: "ab" }]).ok, false); // 全角半角の重複
  const bad = validateOrderers([{ name: "A", email: "broken" }]);
  assert.deepEqual(bad.errors.map(e => e.field), ["email"]);
});

test("注文者の書き込み計画: 並び順は配列順、変更・新規のみ", () => {
  const original = [
    { id: "o1", name: "内田", sortOrder: 10 },
    { id: "o2", name: "角田", sortOrder: 20, email: "t@example.jp" }
  ];
  // 変更なし
  assert.deepEqual(planOrdererWrites(original, validateOrderers(original.map(o => ({ ...o }))).cleaned, F), []);
  // 並べ替え + 新規
  const edited = validateOrderers([
    { id: "o2", name: "角田", email: "t@example.jp" },
    { id: "o1", name: "内田", email: "" },
    { id: null, name: "利根川", email: "" }
  ]).cleaned;
  const w = planOrdererWrites(original, edited, F);
  assert.equal(w.length, 3);
  assert.deepEqual(w.find(x => x.id === "o2").data, { facilityId: F, name: "角田", sortOrder: 10, email: "t@example.jp" });
  for (const x of w) assert.equal("active" in x.data, false, "new documents never carry active");
  assert.equal(w.find(x => x.id === "o1").data.sortOrder, 20);
  const created = w.find(x => x.id === null);
  assert.equal(created.data.sortOrder, 30);
  assert.ok(!("email" in created.data)); // 空のメールは保存しない
});

test("採用IOL: マスターに無いIDは拒否", () => {
  assert.equal(validateAdoption(["hoya-xy1"], IOL_MODELS).ok, true);
  const r = validateAdoption(["hoya-xy1", "made-up-iol"], IOL_MODELS);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknown, ["made-up-iol"]);
});

test("採用IOLの書き込み計画: ドキュメントID=マスターID、解除は enabled=false、dealerIdは保持", () => {
  const existing = [
    { id: "hoya-xy1", enabled: true, dealerId: "d1" },
    { id: "nidek-nsp-2", enabled: false }
  ];
  const w = planAdoptedWrites(IOL_MODELS, existing, ["nidek-nsp-2", "alcon-cna0t0"], F);
  const byId = Object.fromEntries(w.map(x => [x.id, x.data]));
  assert.deepEqual(Object.keys(byId).sort(), ["alcon-cna0t0", "hoya-xy1", "nidek-nsp-2"]);
  assert.deepEqual(byId["alcon-cna0t0"], { facilityId: F, catalogIolId: "alcon-cna0t0", enabled: true });
  assert.deepEqual(byId["hoya-xy1"], { facilityId: F, catalogIolId: "hoya-xy1", enabled: false, dealerId: "d1" });
  assert.equal(byId["nidek-nsp-2"].enabled, true);
  // 変更が無ければ書き込みなし
  assert.deepEqual(planAdoptedWrites(IOL_MODELS, existing, ["hoya-xy1"], F), []);
});

test("採用IOL → 注文フォームのモデル一覧: 有効なものだけ反映される", () => {
  const adopted = [
    { id: "hoya-xy1", catalogIolId: "hoya-xy1", enabled: true },
    { id: "nidek-nsp-2", catalogIolId: "nidek-nsp-2", enabled: false },
    { id: "ghost", catalogIolId: "ghost", enabled: true } // マスターに無い → 無視
  ];
  assert.deepEqual(resolveAdoptedModels(adopted).map(m => m.displayName), ["HOYA / XY1"]);
});

test("ディーラー: 発注用メールと使用報告用メールを別々に保持", () => {
  const v = validateDealers([{ name: "D1", orderEmailsText: "order@example.jp", usageEmailsText: "u1@example.jp\nu2@example.jp" }]);
  assert.equal(v.ok, true);
  assert.deepEqual(v.cleaned[0].orderEmails, ["order@example.jp"]);
  assert.deepEqual(v.cleaned[0].usageReportEmails, ["u1@example.jp", "u2@example.jp"]);
  const bad = validateDealers([{ name: "D1", orderEmailsText: "x", usageEmailsText: "y@example.jp" }]);
  assert.deepEqual(bad.errors.map(e => e.field), ["orderEmails"]);
  const bad2 = validateDealers([{ name: "D1", orderEmailsText: "", usageEmailsText: "y" }]);
  assert.deepEqual(bad2.errors.map(e => e.field), ["usageEmails"]);
  assert.equal(validateDealers([{ name: "", orderEmailsText: "", usageEmailsText: "" }]).ok, false);
  assert.equal(validateDealers([{ name: "D", orderEmailsText: "", usageEmailsText: "" }, { name: "d", orderEmailsText: "", usageEmailsText: "" }]).ok, false);
});

test("ディーラーの書き込み計画: 変更検出と dealerId の保持", () => {
  const original = [{ id: "d1", name: "D1", sortOrder: 10, orderEmails: ["o@example.jp"], usageReportEmails: [], dealerId: "g1" }];
  const same = validateDealers([{ id: "d1", name: "D1", orderEmailsText: "o@example.jp", usageEmailsText: "" }]).cleaned;
  assert.deepEqual(planDealerWrites(original, same, F), []);
  const changed = validateDealers([{ id: "d1", name: "D1", orderEmailsText: "o@example.jp", usageEmailsText: "r@example.jp" }]).cleaned;
  const w = planDealerWrites(original, changed, F);
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].data.usageReportEmails, ["r@example.jp"]);
  assert.equal(w[0].data.dealerId, "g1");
});

test("moveItem: 範囲外は変更しない", () => {
  assert.deepEqual(moveItem([1, 2, 3], 1, -1), [2, 1, 3]);
  assert.deepEqual(moveItem([1, 2, 3], 1, 1), [1, 3, 2]);
  assert.deepEqual(moveItem([1, 2, 3], 0, -1), [1, 2, 3]);
  assert.deepEqual(moveItem([1, 2, 3], 2, 1), [1, 2, 3]);
});
