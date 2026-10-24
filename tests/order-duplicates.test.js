import test from "node:test";
import assert from "node:assert/strict";
import { findPastOrderDuplicates, formatOrderDate } from "../src/domain/order-duplicates.js";

const ts = (iso) => ({ toMillis: () => Date.parse(iso) });
const pl = (over = {}) => ({ lineNo: 1, item: { modelId: "jj-dib00v", toricModel: "", power: "+20.0D", quantity: 1 }, surgeryDate: "2026-11-10", doctor: { id: "o1", name: "山田" }, status: "accepted", ...over });
const order = (id, createdAt, lines, over = {}) => ({ id, orderNumber: `IOL-${id}`, createdAt: ts(createdAt), status: "accepted", lines, ...over });
const cur = (over = {}) => ({ lineNo: 1, modelId: "jj-dib00v", toricModel: "", modelName: "DIB00V", power: "+20.0D", surgeryDate: "2026-11-10", doctorId: "o1", quantity: 1, ...over });

test("重複の条件: モデル・度数・手術日・担当医がすべて一致。枚数は含めない。1つでも違えば重複ではない", () => {
  const orders = [order("a", "2026-10-20T03:00:00Z", [pl({ item: { modelId: "jj-dib00v", toricModel: "", power: "+20.0D", quantity: 2 } })])];
  const hit = findPastOrderDuplicates([cur({ quantity: 1 })], orders);
  assert.equal(hit.length, 1, "枚数が違っても重複");
  assert.deepEqual([hit[0].lineNo, hit[0].modelName, hit[0].power, hit[0].dates], [1, "DIB00V", "+20.0D", ["2026/10/20"]]);
  for (const over of [{ modelId: "hoya-xy1" }, { power: "+20.5D" }, { surgeryDate: "2026-11-11" }, { doctorId: "o2" }]) {
    assert.deepEqual(findPastOrderDuplicates([cur(over)], orders), [], JSON.stringify(over));
  }
});

test("トーリックは正式型番まで一致が必要(DIW300 と DIW225 は別のモデル)", () => {
  const orders = [order("t", "2026-10-20T00:00:00Z", [pl({ item: { modelId: "jj-diwxxx-toric", toricModel: "DIW300", power: "+18.5D", quantity: 1 } })])];
  const c = { modelId: "jj-diwxxx-toric", modelName: "DIW300", power: "+18.5D" };
  assert.equal(findPastOrderDuplicates([cur({ ...c, toricModel: "DIW300" })], orders).length, 1);
  assert.equal(findPastOrderDuplicates([cur({ ...c, toricModel: "DIW225" })], orders).length, 0);
});

test("レンズごとに判定: 重複したレンズだけを、レンズ番号順に返す。同じレンズに一致する過去の注文が複数あれば、すべての注文日(新しい順・同じ日は1つ)", () => {
  const orders = [
    order("o1", "2026-10-01T01:00:00Z", [pl()]),
    order("o2", "2026-10-22T15:30:00Z", [pl(), pl({ item: { modelId: "hoya-xy1", toricModel: "", power: "+19.5D" }, surgeryDate: "2026-11-12", doctor: { id: "o2" } })]),   // 日本時間では 10/23
    order("o3", "2026-10-23T01:00:00Z", [pl()])                                                                                                     // 日本時間 10/23(o2 と同じ日)
  ];
  const cl = [cur({ lineNo: 1, modelId: "nidek-nsp-2", power: "+5.5D" }), cur({ lineNo: 2 }), cur({ lineNo: 3, modelId: "hoya-xy1", modelName: "XY1", power: "+19.5D", surgeryDate: "2026-11-12", doctorId: "o2" })];
  const r = findPastOrderDuplicates(cl, orders);
  assert.deepEqual(r.map(x => x.lineNo), [2, 3], "重複したレンズだけ");
  assert.deepEqual(r[0].dates, ["2026/10/23", "2026/10/01"]);
  assert.deepEqual(r[0].matches.map(m => m.orderId), ["o3", "o2", "o1"], "新しい注文から");
  assert.equal(r[0].matches.length, 3);
  assert.deepEqual(r[1].dates, ["2026/10/23"]);
});

test("下書き・送信失敗・取り消しの注文(と明細)は対象外。発注済み(accepted / notified など)は対象", () => {
  for (const status of ["draft", "failed", "notification_failed", "cancelled", "canceled", "rejected"]) {
    assert.deepEqual(findPastOrderDuplicates([cur()], [order("x", "2026-10-20T00:00:00Z", [pl()], { status })]), [], `注文: ${status}`);
    assert.deepEqual(findPastOrderDuplicates([cur()], [order("x", "2026-10-20T00:00:00Z", [pl({ status })])]), [], `明細: ${status}`);
  }
  for (const status of ["accepted", "notification_pending", "notified"]) {
    assert.equal(findPastOrderDuplicates([cur()], [order("x", "2026-10-20T00:00:00Z", [pl()], { status })]).length, 1, status);
  }
  // 1つの注文の中で、失敗した明細だけが対象外
  const mixed = order("m", "2026-10-20T00:00:00Z", [pl({ status: "notification_failed" }), pl({ item: { modelId: "hoya-xy1", toricModel: "", power: "+19.5D" } })]);
  assert.equal(findPastOrderDuplicates([cur()], [mixed]).length, 0);
  assert.equal(findPastOrderDuplicates([cur({ modelId: "hoya-xy1", power: "+19.5D" })], [mixed]).length, 1);
});

test("旧形式の注文(注文全体の orderer / 旧単一IOL形式)も照合できる。担当医が分からない・今回の担当医が未選択なら一致しない", () => {
  const v2 = { id: "v2", orderNumber: "IOL-v2", createdAt: ts("2026-09-01T00:00:00Z"), status: "accepted", orderer: { id: "o1", name: "山田" }, lines: [{ lineNo: 1, item: { modelId: "jj-dib00v", toricModel: "", power: "+20.0D" }, surgeryDate: "2026-11-10" }] };
  const v1 = { id: "v1", orderNumber: "IOL-v1", createdAt: ts("2026-08-01T00:00:00Z"), status: "accepted", orderer: { id: "o1" }, item: { modelId: "jj-dib00v", toricModel: "", power: "+20.0D" }, surgeryDate: "2026-11-10" };
  assert.deepEqual(findPastOrderDuplicates([cur()], [v2, v1])[0].dates, ["2026/09/01", "2026/08/01"]);
  assert.deepEqual(findPastOrderDuplicates([cur({ doctorId: "" })], [v2]), []);
  assert.deepEqual(findPastOrderDuplicates([cur()], [{ ...v2, orderer: null }]), []);
  assert.deepEqual(findPastOrderDuplicates([cur()], []), []);
  assert.deepEqual(findPastOrderDuplicates([cur()], undefined), []);
});

test("注文日は日本時間のYYYY/MM/DD", () => {
  assert.equal(formatOrderDate(ts("2026-12-31T15:00:00Z")), "2027/01/01");
  assert.equal(formatOrderDate(null), "—");
});
