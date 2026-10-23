import test from "node:test";
import assert from "node:assert/strict";
import { submitOrder, parseOrderResponse, OrderError } from "../src/api/order-client.js";
import { resolveConfig } from "../src/config.js";

const GAS = { orderMode: "gas", orderApiUrl: "https://script.google.com/macros/s/TEST/exec" };
const jsonResponse = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test("既定設定は dryrun で URL を持たない", () => {
  const c = resolveConfig();
  assert.equal(c.orderMode, "dryrun");
  assert.equal(c.orderApiUrl, "");
});

test("許可されないURLの gas 設定は dryrun に戻る", () => {
  const c = resolveConfig({ orderMode: "gas", orderApiUrl: "https://example.com/x" });
  assert.equal(c.orderMode, "dryrun");
  assert.equal(c.orderApiUrl, "");
});

test("dryrun では fetch を呼ばない", async () => {
  let called = false;
  await assert.rejects(
    submitOrder({}, resolveConfig(), async () => { called = true; }),
    (e) => e instanceof OrderError && e.kind === "dryrun"
  );
  assert.equal(called, false);
});

test("orderId を含む成功応答のみ受理し、番号はサーバー値そのまま", async () => {
  const r = await submitOrder({}, GAS, async () => jsonResponse({ success: true, orderId: "SRV-001" }));
  assert.equal(r.orderId, "SRV-001");
});

test("orderId が無い応答は成功にしない（unconfirmed）", async () => {
  for (const body of [{ success: true }, { status: "ok" }, { success: true, orderId: "" }, {}, null]) {
    await assert.rejects(
      submitOrder({}, GAS, async () => jsonResponse(body)),
      (e) => e.kind === "unconfirmed"
    );
  }
});

test("サーバーが明示的にエラーを返した場合は failed", async () => {
  await assert.rejects(
    submitOrder({}, GAS, async () => jsonResponse({ status: "error", message: "NG" })),
    (e) => e.kind === "failed" && e.message === "NG"
  );
});

test("通信エラー・HTTPエラー・非JSONは unconfirmed", async () => {
  await assert.rejects(submitOrder({}, GAS, async () => { throw new TypeError("net"); }), (e) => e.kind === "unconfirmed");
  await assert.rejects(submitOrder({}, GAS, async () => jsonResponse({}, false, 500)), (e) => e.kind === "unconfirmed");
  await assert.rejects(
    submitOrder({}, GAS, async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } })),
    (e) => e.kind === "unconfirmed"
  );
});

test("parseOrderResponse は番号を補完しない", () => {
  assert.throws(() => parseOrderResponse({ success: true }), OrderError);
});
