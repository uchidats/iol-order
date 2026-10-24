import test from "node:test";
import assert from "node:assert/strict";
import { IOL_MODELS } from "../src/data/iol-models.js";
import { buildLensOptions, filterLensOptions, findLensOption } from "../src/domain/lens-options.js";
import { filterPowersByModel } from "../src/domain/power-filter.js";
import { resolveAdoptedModels } from "../src/data/static-repository.js";
import { buildCreateOrderRequest } from "../src/domain/order-request.js";

const adoptAll = () => resolveAdoptedModels(IOL_MODELS.map(m => ({ catalogIolId: m.id, enabled: true })));
const labels = (opts) => opts.map(o => o.label);

test("分類: 全系列に isMultifocal(真偽値)があり、確定した分類と一致する", () => {
  const multifocal = new Set(["santen-ls-313mf15", "santen-ls-313mf15-tx-toric"]);
  for (const m of IOL_MODELS) {
    assert.equal(typeof m.isMultifocal, "boolean", `${m.id} has isMultifocal`);
    assert.equal(m.isMultifocal, multifocal.has(m.id), m.id);
  }
  const toric = IOL_MODELS.filter(m => m.isToric).map(m => m.id).sort();
  assert.deepEqual(toric, ["alcon-cna0tx-cnw0tx-toric", "jj-diwxxx-toric", "nidek-np-tx-toric", "santen-ls-313mf15-tx-toric"]);
  // Eyhance(DIB00V / DIW)は強化単焦点として単焦点
  assert.equal(IOL_MODELS.find(m => m.id === "jj-dib00v").isMultifocal, false);
  assert.equal(IOL_MODELS.find(m => m.id === "jj-diwxxx-toric").isMultifocal, false);
});

test("絞り込み: 両方OFF=単焦点・ノントーリックのみ(全メーカー横断)", () => {
  const r = filterLensOptions(buildLensOptions(adoptAll()), {});
  assert.deepEqual(labels(r), [
    "J&J / DIB00V", "ALCON / CNA0T0", "SANTEN / NX-70S", "NIDEK / NSP-2", "HOYA / XY1", "HOYA / PY-60AD", "ALCON / MN60MA"
  ]);
});

test("絞り込み: トーリックON=全メーカーの単焦点トーリックを正式型番ごとに表示", () => {
  const r = filterLensOptions(buildLensOptions(adoptAll()), { toric: true });
  assert.deepEqual(labels(r), [
    "J&J / DIW150", "J&J / DIW225", "J&J / DIW300", "J&J / DIW375", "J&J / DIW450", "J&J / DIW525", "J&J / DIW600",
    "ALCON / CNA0T2", "ALCON / CNA0T3", "ALCON / CNA0T4", "ALCON / CNA0T5", "ALCON / CNA0T6", "ALCON / CNW0T7", "ALCON / CNW0T8", "ALCON / CNW0T9",
    "NIDEK / NP-T3", "NIDEK / NP-T4", "NIDEK / NP-T5", "NIDEK / NP-T6", "NIDEK / NP-T7"
  ]);
});

test("絞り込み: 多焦点ON=多焦点・ノントーリック。両方ON=多焦点かつトーリックのみ", () => {
  const all = buildLensOptions(adoptAll());
  assert.deepEqual(labels(filterLensOptions(all, { multifocal: true })), ["SANTEN / LS-313MF15"]);
  assert.deepEqual(labels(filterLensOptions(all, { multifocal: true, toric: true })), [
    "SANTEN / LS-313MF15 T1", "SANTEN / LS-313MF15 T2", "SANTEN / LS-313MF15 T3"
  ]);
});

test("施設が採用している系列だけが対象。未採用・採用解除の系列は出ない", () => {
  const adopted = resolveAdoptedModels([
    { catalogIolId: "jj-dib00v", enabled: true }, { catalogIolId: "santen-ls-313mf15", enabled: false },
    { catalogIolId: "nidek-np-tx-toric", enabled: true }
  ]);
  const all = buildLensOptions(adopted);
  assert.deepEqual(labels(filterLensOptions(all, {})), ["J&J / DIB00V"]);
  assert.deepEqual(filterLensOptions(all, { multifocal: true }), []);
  assert.equal(filterLensOptions(all, { toric: true }).length, 5);
});

test("分類が無い(isMultifocal が真偽値でない)系列は推測せず表示しない", () => {
  const unknown = { ...IOL_MODELS[0], id: "x", isMultifocal: undefined };
  assert.deepEqual(buildLensOptions([unknown]), []);
});

test("メーカーに送る正式型番を保持: 選択肢から系列ID・系列名・型番を取り出して従来の注文内容を作れる", () => {
  const all = buildLensOptions(adoptAll());
  const o = findLensOption(all, "jj-diwxxx-toric|DIW300");
  assert.equal(o.model.id, "jj-diwxxx-toric");
  assert.equal(o.toricModel, "DIW300");
  assert.equal(o.model.displayName, "J&J / DIWxxx (トーリック)"); // 従来の model 値
  const req = buildCreateOrderRequest({
    facilityId: "f", clientRequestId: "r".repeat(20), ordererId: "o1",
    lines: [{ modelId: o.model.id, toricModel: o.toricModel, power: "+20.0D", quantity: 1, surgeryDate: "2026-11-10" }]
  });
  assert.equal(req.lines[0].modelId, "jj-diwxxx-toric");
  assert.equal(req.lines[0].toricModel, "DIW300"); // createOrder が検証する(系列の型番に含まれること)
  // すべての選択肢の型番は、サーバーが検証するマスターの型番に含まれる
  for (const x of all) if (x.isToric) assert.ok(x.model.toricModels.includes(x.toricModel));
});

test("度数制限は系列ごと: 同じ系列の型番はすべて同じ度数候補(従来と同じ)", () => {
  const all = buildLensOptions(adoptAll());
  for (const x of all) assert.deepEqual(filterPowersByModel(x.model), filterPowersByModel(IOL_MODELS.find(m => m.id === x.model.id)));
  const nidek = all.filter(x => x.model.id === "nidek-np-tx-toric").map(x => filterPowersByModel(x.model).join());
  assert.equal(new Set(nidek).size, 1);
});

test("選択肢のキーは一意", () => {
  const all = buildLensOptions(adoptAll());
  assert.equal(new Set(all.map(o => o.key)).size, all.length);
});

test("プルダウンの表示はモデル名だけ(メーカーは見出し)。値・全文の表示名・注文データ用の情報は変わらない", () => {
  const all = buildLensOptions(adoptAll());
  const by = Object.fromEntries(all.map(o => [o.key, o]));
  assert.equal(by["alcon-cna0t0"].shortLabel, "CNA0T0");
  assert.equal(by["alcon-cna0t0"].label, "ALCON / CNA0T0");     // 確認画面などで使う全文
  assert.equal(by["jj-dib00v"].shortLabel, "DIB00V");
  assert.equal(by["jj-diwxxx-toric|DIW300"].shortLabel, "DIW300");
  assert.equal(by["jj-diwxxx-toric|DIW300"].label, "J&J / DIW300");
  assert.equal(by["alcon-mn60ma-yellow"].shortLabel, "MN60MA");
  assert.equal(by["alcon-mn60ma-yellow"].label, "ALCON / MN60MA");
  assert.equal(by["alcon-mn60ma-yellow"].model.displayName, "ALCON / MN60MA (イエロー)"); // 発注用の名称(内部)は変更しない
  assert.equal(by["alcon-mn60ma-yellow"].model.model, "MN60MA (イエロー)");
  for (const o of all) assert.doesNotMatch(o.shortLabel, /\//.test(o.model.model) ? /^$/ : / \/ /, o.key); // 型番内のスラッシュ以外に「メーカー / 」は含まない
  assert.equal(by["alcon-cna0tx-cnw0tx-toric|CNW0T8"].key, "alcon-cna0tx-cnw0tx-toric|CNW0T8");     // キー(系列ID|型番)は不変
  assert.equal(by["alcon-cna0tx-cnw0tx-toric|CNW0T8"].toricModel, "CNW0T8");
  assert.equal(by["alcon-cna0tx-cnw0tx-toric|CNW0T8"].manufacturer, "ALCON");
});

test("異なるメーカーでモデル名が重複する場合は、識別できる表示(メーカー / モデル名)を維持する。同じメーカー内の重複は対象外", () => {
  const mk = (id, manufacturer, model) => ({ id, manufacturer, model, displayName: `${manufacturer} / ${model}`, isToric: false, toricModels: [], isMultifocal: false });
  const o = buildLensOptions([mk("a1", "AAA", "X100"), mk("b1", "BBB", "X100"), mk("b2", "BBB", "Y200")]);
  assert.deepEqual(o.map(x => x.shortLabel), ["AAA / X100", "BBB / X100", "Y200"]);
  assert.deepEqual(o.map(x => x.key), ["a1", "b1", "b2"]);
});
