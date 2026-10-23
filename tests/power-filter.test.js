import test from "node:test";
import assert from "node:assert/strict";
import { IOL_MODELS, GOOGLE_FORM_ALL_POWERS } from "../src/data/iol-models.js";
import { filterPowersByModel, defaultPowerLabel } from "../src/domain/power-filter.js";

const byName = (n) => IOL_MODELS.find(m => m.displayName === n);

test("12モデルが定義されている", () => {
  assert.equal(IOL_MODELS.length, 12);
});

test("標準モデルは +6.0D〜+30.0D の0.5ステップ", () => {
  const p = filterPowersByModel(byName("J&J / DIB00V"));
  assert.equal(p[0], "+6.0D");
  assert.equal(p.at(-1), "+30.0D");
  assert.equal(p.length, 49);
});

test("SANTENは +10.0D〜+27.0D", () => {
  const p = filterPowersByModel(byName("SANTEN / NX-70S"));
  assert.equal(p[0], "+10.0D");
  assert.equal(p.at(-1), "+27.0D");
});

test("NIDEKは区間ごとにステップが変わる", () => {
  const p = filterPowersByModel(byName("NIDEK / NSP-2"));
  assert.ok(p.includes("+1.0D") && p.includes("+5.0D") && p.includes("+5.5D"));
  assert.ok(!p.includes("+3.5D"));
  assert.ok(p.includes("+27.0D") && p.includes("+28.0D") && p.includes("+30.0D"));
  assert.ok(!p.includes("+27.5D"));
});

test("MN60MAは -5.0D〜+5.0D の1.0ステップ", () => {
  const m = byName("ALCON / MN60MA (イエロー)");
  assert.deepEqual(filterPowersByModel(m), ["-5.0D", "-4.0D", "-3.0D", "-2.0D", "-1.0D", "0D", "+1.0D", "+2.0D", "+3.0D", "+4.0D", "+5.0D"]);
});

test("既定度数: MN60MA以外は許容度数に含まれる（MN60MAは元実装どおり初期選択なし）", () => {
  for (const m of IOL_MODELS) {
    const included = filterPowersByModel(m).includes(defaultPowerLabel(m));
    assert.equal(included, m.model.startsWith("MN60MA") ? false : true, m.displayName);
  }
});

test("トーリックモデルは型番を持つ", () => {
  for (const m of IOL_MODELS) {
    assert.equal(m.isToric, m.toricModels.length > 0, m.displayName);
  }
  assert.ok(GOOGLE_FORM_ALL_POWERS.length > 0);
});
