import test from "node:test";
import assert from "node:assert/strict";
import { orderedMakers, orderedModelsOf, applyIolOrder, buildIolOrderSetting, moveItem } from "../src/domain/iol-order.js";
import { buildLensOptions } from "../src/domain/lens-options.js";

const M = [
  { id: "a1", manufacturer: "A" }, { id: "a2", manufacturer: "A" }, { id: "a3", manufacturer: "A", isToric: true },
  { id: "b1", manufacturer: "B" }, { id: "b2", manufacturer: "B", isMultifocal: true }
];
const ids = (l) => l.map(m => m.id);

test("未設定(null/空)は標準の順番のまま", () => {
  for (const s of [null, undefined, {}, { makerOrder: [], modelOrder: [] }, { makerOrder: "x" }]) {
    assert.deepEqual(ids(applyIolOrder(M, s)), ["a1", "a2", "a3", "b1", "b2"]);
  }
});

test("メーカーの順番とメーカー内のモデルの順番を適用する", () => {
  const s = { makerOrder: ["B", "A"], modelOrder: ["a3", "a1", "b2"] };
  assert.deepEqual(orderedMakers(M, s), ["B", "A"]);
  assert.deepEqual(ids(orderedModelsOf(M, "A", s)), ["a3", "a1", "a2"]);
  assert.deepEqual(ids(applyIolOrder(M, s)), ["b2", "b1", "a3", "a1", "a2"]);
});

test("後から追加されたメーカー・モデルは既存の順番を崩さず末尾。マスターに無いIDは無視", () => {
  const s = { makerOrder: ["B", "GONE"], modelOrder: ["a2", "a1", "ghost"] };
  assert.deepEqual(orderedMakers(M, s), ["B", "A"]);
  assert.deepEqual(ids(orderedModelsOf(M, "A", s)), ["a2", "a1", "a3"]);
  const more = [...M, { id: "c1", manufacturer: "C" }, { id: "b3", manufacturer: "B" }];
  assert.deepEqual(ids(applyIolOrder(more, { makerOrder: ["B", "A"], modelOrder: ["b2", "b1"] })), ["b2", "b1", "b3", "a1", "a2", "a3", "c1"]);
});

test("絞り込み(トーリック/多焦点)後も、並び順が保たれる", () => {
  const s = { makerOrder: ["B", "A"], modelOrder: ["b2", "b1", "a3"] };
  const ordered = applyIolOrder(M, s);
  assert.deepEqual(ids(ordered.filter(m => m.isToric || m.isMultifocal)), ["b2", "a3"]);
});

test("保存内容は画面の並び順から作り、重複・不明なものを除く。モデルを増減させない", () => {
  const s = buildIolOrderSetting(M, ["B", "A", "A", "X"], ["b2", "a1", "a1", "zz"]);
  assert.deepEqual(s, { makerOrder: ["B", "A"], modelOrder: ["b2", "a1"] });
});

test("moveItem: 1つ上/下へ。端では動かず、元の配列は変更しない", () => {
  const a = ["x", "y", "z"];
  assert.deepEqual(moveItem(a, 1, -1), ["y", "x", "z"]);
  assert.deepEqual(moveItem(a, 1, 1), ["x", "z", "y"]);
  assert.deepEqual(moveItem(a, 0, -1), a);
  assert.deepEqual(moveItem(a, 2, 1), a);
  assert.deepEqual(a, ["x", "y", "z"]);
});

test("注文フォームの選択肢(トーリックの型番展開を含む)も並び順に従う", () => {
  const models = [
    { id: "a1", manufacturer: "A", name: "A1", isToric: false, isMultifocal: false },
    { id: "b1", manufacturer: "B", name: "B1", isToric: true, isMultifocal: false, toricModels: ["T1", "T2"] }
  ];
  const keys = (ms) => buildLensOptions(ms).map(o => o.key);
  assert.deepEqual(keys(applyIolOrder(models, null)), ["a1", "b1|T1", "b1|T2"]);
  assert.deepEqual(keys(applyIolOrder(models, { makerOrder: ["B", "A"], modelOrder: [] })), ["b1|T1", "b1|T2", "a1"]);
});
