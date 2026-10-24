import test from "node:test";
import assert from "node:assert/strict";
import { buildCreateOrderRequest } from "../src/domain/order-request.js";
import { createOrderApi } from "../src/data/order-api.js";
import { resolveConfig, ORDER_MODES } from "../src/config.js";

const pending = {
  facilityId: "f1", clientRequestId: "req-0123456789abcdef", modelId: "jj-diwxxx-toric", model: "J&J / DIWxxx (トーリック)",
  manufacturer: "J&J", toricModel: "DIW225", power: "+20.0D", quantity: "2 枚", surgeryDate: "2026-11-10",
  orderer: "山田", ordererId: "o1", email: "y@orderer.jp", notes: "右眼", facilityName: "A眼科", submittedAt: "x"
};

test("サーバーへ送るのは識別子と選択値のみ。表示名・注文者名・メール・施設名・価格は送らない", () => {
  assert.deepEqual(buildCreateOrderRequest(pending), {
    facilityId: "f1", requestId: "req-0123456789abcdef", modelId: "jj-diwxxx-toric", power: "+20.0D", quantity: 2,
    surgeryDate: "2026-11-10", ordererId: "o1", toricModel: "DIW225", notes: "右眼"
  });
});

test("非トーリック・備考なしでは toricModel / notes を送らない。枚数は数値", () => {
  const r = buildCreateOrderRequest({ ...pending, toricModel: "", notes: "", quantity: "1 枚" });
  assert.equal("toricModel" in r, false);
  assert.equal("notes" in r, false);
  assert.equal(r.quantity, 1);
});

test("同じ確認内容の再送は同じ requestId になる(画面が保持する clientRequestId をそのまま使う)", () => {
  assert.equal(buildCreateOrderRequest(pending).requestId, buildCreateOrderRequest({ ...pending }).requestId);
});

test("createOrderApi は callable createOrder を呼び、結果の data を返す", async () => {
  const calls = [];
  const api = createOrderApi({ functions: { f: 1 }, httpsCallable: (fns, name) => async (p) => { calls.push([fns, name, p]); return { data: { orderNumber: "IOL-1" } }; } });
  assert.deepEqual(await api.createOrder({ a: 1 }), { orderNumber: "IOL-1" });
  assert.deepEqual(calls, [[{ f: 1 }, "createOrder", { a: 1 }]]);
});

test("server-dev は設定で明示したときだけ有効。既定は dryrun のまま。GASのURLは使わない", () => {
  assert.equal(resolveConfig().orderMode, "dryrun");
  assert.equal(resolveConfig({ orderMode: "bogus" }).orderMode, "dryrun");
  const c = resolveConfig({ orderMode: "server-dev", orderApiUrl: "https://script.google.com/macros/s/X/exec" });
  assert.equal(c.orderMode, ORDER_MODES.SERVER_DEV);
  assert.equal(c.orderApiUrl, "");
});
