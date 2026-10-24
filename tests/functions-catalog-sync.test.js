// Cloud Functions 側のIOLマスター・度数フィルタの複製が、クライアントの定義と一致していること
// (クライアントとサーバーでモデル・度数の定義が食い違うと、正しい注文が拒否される/不正な注文が通るため)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { IOL_MODELS, GOOGLE_FORM_ALL_POWERS } from "../src/data/iol-models.js";
import { filterPowersByModel } from "../src/domain/power-filter.js";
import * as serverCatalog from "../functions/src/iol-catalog.js";
import { filterPowersByModel as serverFilter } from "../functions/src/power-filter.js";
import { renderCopies } from "../scripts/sync-catalog.mjs";

test("複製ファイルは `npm run sync:catalog` の出力と一致する(手編集・更新漏れの検出)", () => {
  for (const { to, content } of renderCopies()) {
    const actual = fs.readFileSync(new URL(`../${to}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    assert.equal(actual, content, `${to} is out of sync: run npm run sync:catalog`);
  }
});

test("IOLモデルと全度数の定義がクライアントと同一", () => {
  assert.deepEqual(serverCatalog.IOL_MODELS, IOL_MODELS);
  assert.deepEqual(serverCatalog.GOOGLE_FORM_ALL_POWERS, GOOGLE_FORM_ALL_POWERS);
});

test("全モデルで、サーバーの許容度数がクライアントの選択肢と完全に一致する", () => {
  for (const m of IOL_MODELS) {
    const sm = serverCatalog.IOL_MODELS.find(x => x.id === m.id);
    assert.deepEqual(serverFilter(sm), filterPowersByModel(m), m.id);
    assert.ok(filterPowersByModel(m).length > 0, `${m.id} has powers`);
  }
});

test("モデルIDは一意で、トーリックの型番定義が整合している", () => {
  assert.equal(new Set(IOL_MODELS.map(m => m.id)).size, IOL_MODELS.length);
  for (const m of IOL_MODELS) assert.equal(m.isToric, m.toricModels.length > 0, m.id);
});
