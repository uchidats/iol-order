import test from "node:test";
import assert from "node:assert/strict";
import { orderLinesOf, summarizeOrder, sortOrdersNewestFirst, formatDateTimeJst, toMillis, describeLine } from "../src/domain/order-history.js";
import { orderLinesOf as serverOrderLinesOf } from "../functions/src/orders.js";

const item = (over = {}) => ({ modelId: "jj-dib00v", manufacturer: "J&J", model: "DIB00V", displayName: "J&J / DIB00V", isToric: false, isMultifocal: false, toricModel: "", power: "+20.0D", quantity: 1, ...over });
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });

// 現行(schemaVersion 3): 明細ごとに担当医・ディーラー。担当医・手術日・ディーラーが異なる明細を含む
const v3 = {
  id: "a", schemaVersion: 3, orderNumber: "IOL-20261025-0001", createdAt: ts("2026-10-25T05:30:00Z"), testOrder: true,
  createdBy: { uid: "u1", email: "login@example.jp", displayName: "ログイン太郎" },
  lines: [
    { lineNo: 1, item: item(), surgeryDate: "2026-11-10", doctor: { id: "o1", name: "山田" }, dealerId: "d1", dealer: { id: "d1", name: "A商会" } },
    { lineNo: 2, item: item({ modelId: "jj-diwxxx-toric", model: "DIWxxx (トーリック)", displayName: "J&J / DIWxxx (トーリック)", isToric: true, toricModel: "DIW300", power: "+18.5D", quantity: 2 }),
      surgeryDate: "2026-11-12", doctor: { id: "o2", name: "佐藤" }, dealerId: null, dealer: null }
  ]
};
// 旧 schemaVersion 2: 明細に担当医なし・注文全体の orderer
const v2 = { id: "b", orderNumber: "IOL-20260901-0002", createdAt: ts("2026-09-01T00:00:00Z"), orderer: { id: "o9", name: "旧注文者" }, createdBy: { email: "x@example.jp" },
  lines: [{ lineNo: 1, item: item({ quantity: 2 }), surgeryDate: "2026-10-01", dealerId: null, dealer: null }] };
// 旧 schemaVersion 1: トップレベルの item
const v1 = { id: "c", orderNumber: "IOL-20260801-0001", createdAt: ts("2026-08-01T00:00:00Z"), item: item(), surgeryDate: "2026-09-01", orderer: { id: "o9", name: "最古注文者" }, createdBy: null };

test("一覧: 注文日時(日本時間)・発注者(ログイン情報)・件数・合計枚数。担当医は発注者ではない", () => {
  const s = summarizeOrder(v3);
  assert.equal(s.createdAtLabel, "2026/10/25 14:30");
  assert.equal(s.orderedBy, "ログイン太郎");
  assert.equal(s.lineCount, 2);
  assert.equal(s.totalQuantity, 3);
  assert.equal(s.testOrder, true);
  assert.equal(summarizeOrder(v2).orderedBy, "x@example.jp", "氏名がなければメール");
  assert.equal(summarizeOrder(v1).orderedBy, "（不明）");
});

test("詳細: 明細ごとのメーカー・モデル・度数・枚数・手術日・担当医・発注先。トーリックは型番を表示、発注先なしは null", () => {
  const [a, b] = summarizeOrder(v3).lines;
  assert.deepEqual([a.maker, a.model, a.power, a.quantity, a.surgeryDate, a.doctorName, a.dealerName], ["J&J", "DIB00V", "+20.0D", 1, "2026-11-10", "山田", "A商会"]);
  assert.deepEqual([b.model, b.isToric, b.power, b.quantity, b.surgeryDate, b.doctorName, b.dealerName], ["DIW300", true, "+18.5D", 2, "2026-11-12", "佐藤", null]);
});

test("旧形式(orderer を持つ過去データ)も同じ形で読める。担当医は orderer、発注先は未設定", () => {
  const l2 = summarizeOrder(v2).lines[0];
  assert.deepEqual([l2.doctorName, l2.dealerName, l2.quantity], ["旧注文者", null, 2]);
  const s1 = summarizeOrder(v1);
  assert.deepEqual([s1.lineCount, s1.totalQuantity, s1.lines[0].doctorName, s1.lines[0].surgeryDate], [1, 1, "最古注文者", "2026-09-01"]);
  assert.equal(describeLine({ item: item() }).doctorName, "（記録なし）");
  assert.deepEqual(summarizeOrder({ id: "z" }).lines, [], "明細が読めない注文でも落ちない");
});

test("サーバー(functions)の orderLinesOf と同じ結果を返す(新旧の読み取りを共通化)", () => {
  for (const o of [v3, v2, v1, { id: "z" }]) assert.deepEqual(orderLinesOf(o), serverOrderLinesOf(o));
});

test("新しい順。作成日時が読めない注文は末尾。Timestamp / seconds / ISO を読める", () => {
  const list = [v1, { id: "n", createdAt: null }, v3, v2].map(summarizeOrder);
  assert.deepEqual(sortOrdersNewestFirst(list).map(o => o.id), ["a", "b", "c", "n"]);
  assert.equal(toMillis({ seconds: 10, nanoseconds: 5e6 }), 10005);
  assert.equal(toMillis("2026-10-25T00:00:00Z"), Date.parse("2026-10-25T00:00:00Z"));
  assert.equal(formatDateTimeJst(null), "—");
  assert.equal(formatDateTimeJst(ts("2026-12-31T15:00:00Z")), "2027/01/01 00:00");
});
