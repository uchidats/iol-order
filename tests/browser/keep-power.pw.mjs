// 回帰テスト(ブラウザ): IOLモデルを変えたとき、変更前の度数が変更後のモデルにもあれば維持し、なければ「選択」に戻す。  npm run test:browser
// トーリック・多焦点の絞り込みでモデルが変わる場合も同じ原則。実際の styles.css と src/ui/lens-lines.js を最小のページで確認する。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<main class="main-content"><form id="iolOrderForm" class="order-form" novalidate><div class="order-fields">
<div id="lensLines" class="lens-lines"></div>
<div class="lens-lines-actions"><button type="button" class="btn btn-secondary" id="btnAddLine">＋ レンズを追加</button></div>
</div></form></main>
<script type="module">
import { createLensLines } from "/src/ui/lens-lines.js";
import { buildLensOptions } from "/src/domain/lens-options.js";
import { filterPowersByModel } from "/src/domain/power-filter.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
const options = buildLensOptions(IOL_MODELS);
const powersOf = (o) => filterPowersByModel(o.model);
// 度数 P を持つ/持たないモデルの組(非トーリック・単焦点)を、マスターから探す
const plain = options.filter(o => !o.isToric && !o.isMultifocal);
const P = "+20.0D";
window.__has = plain.filter(o => powersOf(o).includes(P)).map(o => o.key);
window.__lacks = plain.filter(o => !powersOf(o).includes(P)).map(o => o.key);
window.__toricHas = options.filter(o => o.isToric && !o.isMultifocal && powersOf(o).includes(P)).map(o => o.key);
window.__toricLacks = options.filter(o => o.isToric && !powersOf(o).includes(P)).map(o => o.key);
window.__P = P;
// トーリックの検証用: 一部のトーリックモデルにだけ無い度数 Q(単焦点のモデルにはある)を探す
import { GOOGLE_FORM_ALL_POWERS } from "/src/data/iol-models.js";
const Q = GOOGLE_FORM_ALL_POWERS.find(q => plain.some(o => powersOf(o).includes(q)) && options.some(o => o.isToric && powersOf(o).includes(q)) && options.some(o => o.isToric && !powersOf(o).includes(q)));
window.__Q = Q;
window.__plainHasQ = plain.filter(o => powersOf(o).includes(Q)).map(o => o.key);
window.__toricHasQ = options.filter(o => o.isToric && powersOf(o).includes(Q)).map(o => o.key);
window.__toricLacksQ = options.filter(o => o.isToric && !powersOf(o).includes(Q)).map(o => o.key);
window.__lines = createLensLines({
  container: document.getElementById("lensLines"), addButton: document.getElementById("btnAddLine"),
  getOptions: () => options, getDoctors: () => [{ id: "o1", name: "山田" }], minDate: () => "2020-01-01"
});
window.__ready = true;
</script></body></html>`;

let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE); return; }
    const p = path.join(ROOT, url);
    if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(p, (e, b) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": (TYPES[path.extname(p)] || "application/octet-stream") + "; charset=utf-8" });
      res.end(b);
    });
  }).listen(0);
  await new Promise(r => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/`;
});
test.after(() => { server.close(); });

async function launch(type, name) {
  for (const opts of name === "chromium" ? [{}, { channel: "msedge" }, { channel: "chrome" }] : [{}]) {
    try { return await type.launch(opts); } catch { /* 次の候補へ */ }
  }
  return null;
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`モデル変更時の度数: 変更後にも存在すれば維持・なければ「選択」・未選択は未選択のまま: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      const line = page.locator(".lens-line").first();
      const model = line.locator("[data-f=model]"), power = line.locator("[data-f=power]"), toric = line.locator("[data-f=toric]"), mf = line.locator("[data-f=multifocal]");
      const P = await page.evaluate(() => window.__P);
      const keys = await page.evaluate(() => ({ has: window.__has, lacks: window.__lacks, Q: window.__Q, pHasQ: window.__plainHasQ, tHas: window.__toricHasQ, tLacks: window.__toricLacksQ }));
      assert.ok(keys.has.length >= 2 && keys.lacks.length >= 1 && keys.Q && keys.pHasQ.length >= 1 && keys.tHas.length >= 1 && keys.tLacks.length >= 1, "テストデータ: " + JSON.stringify(keys).slice(0, 300));

      // 変更前が未選択なら、モデルを変えても未選択のまま
      await model.selectOption(keys.has[0]);
      assert.equal(await power.inputValue(), "");
      await model.selectOption(keys.has[1]);
      assert.equal(await power.inputValue(), "", "未選択のまま");

      // 変更後のモデルにも同じ度数があれば維持
      await power.selectOption(P);
      await model.selectOption(keys.has[0]);
      assert.equal(await power.inputValue(), P, "維持");
      // 変更後のモデルにその度数がなければ「選択」に戻る(度数の選択肢は新しいモデルのもの)
      await model.selectOption(keys.lacks[0]);
      assert.equal(await power.inputValue(), "");
      assert.equal(await power.locator("option", { hasText: P }).count(), 0, "新しいモデルの選択肢に無い度数");
      // 戻したあと、別のモデルに替えても自動では復活しない(未選択のまま)
      await model.selectOption(keys.has[0]);
      assert.equal(await power.inputValue(), "");

      // トーリック・多焦点の切り替えでモデルが変わる場合: モデルは外れるが、度数は(新しい選択肢にあるので)維持。そのあと選んだモデルにも度数があれば維持、なければ未選択
      await model.selectOption(keys.pHasQ[0]);
      await power.selectOption(keys.Q);
      await toric.check();
      assert.equal(await model.inputValue(), "", "絞り込みでモデルは外れる");
      assert.equal(await power.inputValue(), keys.Q, "度数は維持");
      await model.selectOption(keys.tHas[0]);
      assert.equal(await power.inputValue(), keys.Q, "トーリックのモデルにも度数があれば維持");
      await model.selectOption(keys.tLacks[0]);
      assert.equal(await power.inputValue(), "", "度数がなければ未選択");
      await toric.uncheck();
      await mf.check(); await mf.uncheck();
      assert.equal(await power.inputValue(), "", "未選択のまま");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
