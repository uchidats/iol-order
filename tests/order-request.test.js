import test from "node:test";
import assert from "node:assert/strict";
import { buildCreateOrderRequest } from "../src/domain/order-request.js";
import { toOrderLines, totalQuantity, findDuplicateLines, lineKey, MAX_LINES, MAX_TOTAL_QUANTITY } from "../src/domain/order-lines.js";
import { ORDER_LIMITS } from "../functions/src/orders.js";
import { IOL_MODELS } from "../src/data/iol-models.js";
import { buildLensOptions, findLensOption } from "../src/domain/lens-options.js";
import { createOrderApi } from "../src/data/order-api.js";
import { resolveConfig, ORDER_MODES, SITE_ORDER_MODE, sendsOrders } from "../src/config.js";

const options = buildLensOptions(IOL_MODELS);
const lens = (key) => findLensOption(options, key);
const yamada = { id: "o1", name: "山田", email: "y@orderer.jp" };
const sato = { id: "o2", name: "佐藤", email: "" };
const values = [
  { lens: lens("jj-dib00v"), power: "+20.0D", quantity: 1, surgeryDate: "2026-11-10", doctor: yamada },
  { lens: lens("jj-diwxxx-toric|DIW300"), power: "+18.5D", quantity: 2, surgeryDate: "2026-11-12", doctor: sato }   // 担当医が異なる明細
];

const pending = () => {
  const lines = toOrderLines(values);
  return {
    facilityId: "f1", clientRequestId: "req-0123456789abcdef", lines, totalQuantity: totalQuantity(lines),
    notes: "まとめ発注", facilityName: "A眼科", submittedAt: "x"
  };
};

test("サーバーへ送るのは識別子と選択値のみ。明細ごとに系列ID・正式型番・度数・枚数・手術日・担当医ID。氏名・メール・施設名・発注者の項目は送らない", () => {
  const req = buildCreateOrderRequest(pending());
  assert.deepEqual(req, {
    facilityId: "f1", requestId: "req-0123456789abcdef", notes: "まとめ発注",
    lines: [
      { modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: "2026-11-10", doctorId: "o1", dealerId: null },
      { modelId: "jj-diwxxx-toric", power: "+18.5D", quantity: 2, surgeryDate: "2026-11-12", doctorId: "o2", toricModel: "DIW300", dealerId: null }
    ]
  });
  assert.equal("ordererId" in req, false, "no order-level orderer");
  const json = JSON.stringify(req);
  for (const forbidden of ["y@orderer.jp", "山田", "佐藤", "A眼科", "J&J / DIB00V", "label", "createdBy", "orderedBy", "proxy"]) assert.ok(!json.includes(forbidden), forbidden);
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

test("server-dev は設定で明示したときだけ有効。それ以外は公開サイトの既定。旧経路(gas)は廃止され既定になり、GASのURLは持たない", () => {
  const dry = ORDER_MODES.DRYRUN;
  assert.deepEqual(resolveConfig({}, dry), { orderMode: "dryrun" });
  assert.deepEqual(resolveConfig({ orderMode: "bogus" }, dry), { orderMode: "dryrun" });
  assert.deepEqual(resolveConfig({ orderMode: "gas", orderApiUrl: "https://script.google.com/macros/s/X/exec" }, dry), { orderMode: "dryrun" });
  assert.deepEqual(resolveConfig({ orderMode: "gas" }), { orderMode: SITE_ORDER_MODE });
  assert.deepEqual(resolveConfig({ orderMode: "server-dev", orderApiUrl: "https://script.google.com/macros/s/X/exec" }), { orderMode: ORDER_MODES.SERVER_DEV });
  assert.equal("GAS" in ORDER_MODES, false);
});

test("本番(server): 公開サイトの既定(SITE_ORDER_MODE)は server(2026-10-26 本番の受付を開始)。不正な値は dryrun", () => {
  assert.equal(SITE_ORDER_MODE, ORDER_MODES.SERVER, "公開サイトは本番の受付");
  assert.deepEqual(resolveConfig({}, ORDER_MODES.SERVER), { orderMode: "server" });
  assert.deepEqual(resolveConfig({}, "bogus"), { orderMode: "dryrun" });
  assert.deepEqual(resolveConfig({ orderMode: "server-dev" }, ORDER_MODES.SERVER), { orderMode: "server-dev" }, "ローカルの設定が優先");
  assert.deepEqual([sendsOrders("dryrun"), sendsOrders("server-dev"), sendsOrders("server")], [false, true, true]);
});

test("ヘッダーのモード表示は、HTML の初期状態では非表示(本番で再読み込み時に「開発モード」が一瞬出ない)", async () => {
  const fs = await import("node:fs");
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<span class="system-badge" id="systemBadge" hidden><\/span>/);
});
