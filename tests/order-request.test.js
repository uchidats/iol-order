import test from "node:test";
import assert from "node:assert/strict";
import { buildCreateOrderRequest } from "../src/domain/order-request.js";
import { toOrderLines, totalQuantity, findDuplicateLines, lineKey, MAX_LINES, MAX_TOTAL_QUANTITY } from "../src/domain/order-lines.js";
import { ORDER_LIMITS } from "../functions/src/orders.js";
import { IOL_MODELS } from "../src/data/iol-models.js";
import { buildLensOptions, findLensOption } from "../src/domain/lens-options.js";
import { createOrderApi } from "../src/data/order-api.js";
import { resolveConfig, ORDER_MODES } from "../src/config.js";

const options = buildLensOptions(IOL_MODELS);
const lens = (key) => findLensOption(options, key);
const values = [
  { lens: lens("jj-dib00v"), power: "+20.0D", quantity: 1, surgeryDate: "2026-11-10" },
  { lens: lens("jj-diwxxx-toric|DIW300"), power: "+18.5D", quantity: 2, surgeryDate: "2026-11-12" }
];

const pending = () => {
  const lines = toOrderLines(values);
  return {
    facilityId: "f1", clientRequestId: "req-0123456789abcdef", lines, totalQuantity: totalQuantity(lines),
    orderer: "山田", ordererId: "o1", email: "y@orderer.jp", notes: "まとめ発注", facilityName: "A眼科", submittedAt: "x"
  };
};

test("サーバーへ送るのは識別子と選択値のみ。明細ごとに系列ID・正式型番・度数・枚数・手術日。表示名・注文者名・メール・施設名は送らない", () => {
  assert.deepEqual(buildCreateOrderRequest(pending()), {
    facilityId: "f1", requestId: "req-0123456789abcdef", ordererId: "o1", notes: "まとめ発注",
    lines: [
      { modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: "2026-11-10" },
      { modelId: "jj-diwxxx-toric", power: "+18.5D", quantity: 2, surgeryDate: "2026-11-12", toricModel: "DIW300" }
    ]
  });
  const json = JSON.stringify(buildCreateOrderRequest(pending()));
  for (const forbidden of ["y@orderer.jp", "山田", "A眼科", "J&J / DIB00V", "label"]) assert.ok(!json.includes(forbidden), forbidden);
});

test("備考なしでは notes を送らない。トーリックでない明細に toricModel は付かない", () => {
  const p = pending();
  p.notes = "";
  const r = buildCreateOrderRequest(p);
  assert.equal("notes" in r, false);
  assert.equal("toricModel" in r.lines[0], false);
});

test("同じ確認内容の再送は同じ requestId になる(画面が保持する clientRequestId をそのまま使う)", () => {
  assert.equal(buildCreateOrderRequest(pending()).requestId, buildCreateOrderRequest(pending()).requestId);
});

test("明細: 系列名・系列ID・メーカー・正式型番を従来どおり別々に保持し、合計枚数を数える", () => {
  const lines = toOrderLines(values);
  assert.deepEqual(lines.map(l => [l.lineNo, l.modelId, l.model, l.toricModel, l.label]), [
    [1, "jj-dib00v", "J&J / DIB00V", "", "J&J / DIB00V"],
    [2, "jj-diwxxx-toric", "J&J / DIWxxx (トーリック)", "DIW300", "J&J / DIW300"]
  ]);
  assert.equal(totalQuantity(lines), 3);
});

test("明細の重複判定: 同じレンズ・型番・度数・手術日は重複(枚数は無関係)。手術日・度数・型番が違えば別明細", () => {
  const a = { lens: lens("jj-diwxxx-toric|DIW300"), power: "+18.5D", quantity: 1, surgeryDate: "2026-11-12" };
  assert.deepEqual(findDuplicateLines([a, { ...a, quantity: 2 }]), [1]);
  assert.deepEqual(findDuplicateLines([a, { ...a, surgeryDate: "2026-11-13" }]), []);
  assert.deepEqual(findDuplicateLines([a, { ...a, power: "+19.0D" }]), []);
  assert.deepEqual(findDuplicateLines([a, { ...a, lens: lens("jj-diwxxx-toric|DIW225") }]), []);
  assert.equal(lineKey(a), lineKey({ ...a, quantity: 2 }));
});

test("クライアントの上限はサーバー(createOrder)の上限と一致している", () => {
  assert.equal(MAX_LINES, ORDER_LIMITS.maxLines);
  assert.equal(MAX_TOTAL_QUANTITY, ORDER_LIMITS.maxTotalQuantity);
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
