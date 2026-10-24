import test from "node:test";
import assert from "node:assert/strict";
import { IOL_MODELS } from "../src/data/iol-models.js";
import { baseModelName, displayLabel, featureBadges } from "../src/domain/lens-labels.js";
import { buildLensOptions } from "../src/domain/lens-options.js";

const base = { manufacturer: "X", displayName: "X / Y" };

test("バッジは isToric / isMultifocal だけで決まる(多焦点 → トーリックの順、両方なら2つ)", () => {
  assert.deepEqual(featureBadges({ isToric: false, isMultifocal: false }), []);
  assert.deepEqual(featureBadges({ isToric: true, isMultifocal: false }), ["トーリック"]);
  assert.deepEqual(featureBadges({ isToric: false, isMultifocal: true }), ["多焦点"]);
  assert.deepEqual(featureBadges({ isToric: true, isMultifocal: true }), ["多焦点", "トーリック"]);
  assert.deepEqual(featureBadges(null), []);
  // 名前に「トーリック」と書いてあっても、フラグが無ければバッジは出ない(文字列から推測しない)
  assert.deepEqual(featureBadges({ ...base, displayName: "X / Y (トーリック)", isToric: false, isMultifocal: false }), []);
});

test("モデル名に埋め込まれた「（トーリック）」などの括弧書きは、表示時に取り除く(全角・半角・複数・多焦点も)", () => {
  const n = (displayName) => baseModelName({ ...base, displayName });
  assert.equal(n("J&J / DIWxxx (トーリック)"), "DIWxxx");
  assert.equal(n("J&J / DIWxxx（トーリック）"), "DIWxxx");
  assert.equal(n("ALCON / CNA0Tx / CNW0Tx (トーリック)"), "CNA0Tx / CNW0Tx");  // 型番の区切りのスラッシュは残す
  assert.equal(n("A / B (トーリック) （トーリック）"), "B");                    // 重複していても整理する
  assert.equal(n("A / B（多焦点）"), "B");
  assert.equal(n("A / B (多焦点トーリック)"), "B");
  assert.equal(n("ALCON / MN60MA (イエロー)"), "MN60MA (イエロー)");              // 特徴以外の括弧書きは残す
  assert.equal(n("HOYA / XY1"), "XY1");
});

test("全モデル: 表示名に「トーリック」の括弧書きは残らず、メーカー名は1回だけ", () => {
  for (const m of IOL_MODELS) {
    const name = baseModelName(m), label = displayLabel(m);
    assert.doesNotMatch(label, /[（(]\s*(多焦点)?(トーリック|多焦点)\s*[）)]/, m.id);
    assert.equal(label, `${m.manufacturer} / ${name}`);
    assert.equal(label.split(m.manufacturer).length - 1, 1, m.id + " manufacturer once");
  }
});

test("確定した分類: トーリックは4系列、多焦点は2系列で、バッジの組み合わせは単焦点なし/トーリック/多焦点/多焦点+トーリック", () => {
  const byId = Object.fromEntries(IOL_MODELS.map(m => [m.id, featureBadges(m)]));
  assert.deepEqual(byId["santen-ls-313mf15"], ["多焦点"]);
  assert.deepEqual(byId["santen-ls-313mf15-tx-toric"], ["多焦点", "トーリック"]);
  assert.deepEqual(byId["jj-diwxxx-toric"], ["トーリック"]);
  assert.deepEqual(byId["jj-dib00v"], []);
  assert.equal(Object.values(byId).filter(b => b.includes("トーリック")).length, 4);
  assert.equal(Object.values(byId).filter(b => b.includes("多焦点")).length, 2);
});

test("選択肢の表示名にも括弧書きの重複はない(トーリックは「メーカー / 型番」)", () => {
  for (const o of buildLensOptions(IOL_MODELS)) assert.doesNotMatch(o.label, /トーリック/, o.key);
});
