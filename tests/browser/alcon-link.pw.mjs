// 回帰テスト(ブラウザ): レンズの明細には、メーカー別の Calculator リンク(以前の Alcon Toric Calculator)を出さない。  npm run test:browser
// Calculator のリンクは、下部の「各社Calculator 関連リンク」にまとめる(tests/browser/ref-links.pw.mjs)。
// 実際の styles.css と src/ui/lens-lines.js を、最小のページに読み込んで確認する(ログイン・Firebase は使わない)。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const CALC_URL = "https://www.myalcon-toriccalc.com";

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<main class="main-content"><form id="iolOrderForm" class="order-form" novalidate><div class="order-fields">
<div id="lensLines" class="lens-lines"></div>
<div class="lens-lines-actions"><button type="button" class="btn btn-secondary" id="btnAddLine">＋ レンズを追加</button></div>
</div></form></main>
<script type="module">
import { createLensLines } from "/src/ui/lens-lines.js";
import { buildLensOptions } from "/src/domain/lens-options.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
const options = buildLensOptions(IOL_MODELS);
window.__alconKey = options.find(o => o.manufacturer === "ALCON" && o.isToric).key;
window.__alconPlainKey = options.find(o => o.manufacturer === "ALCON" && !o.isToric).key;
window.__otherToricKey = options.find(o => o.manufacturer !== "ALCON" && o.isToric).key;
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
  test(`メーカー別の Calculator リンクは出さない(トーリック・ALCON を選んでも)。「トーリック」「多焦点」チェックボックスはそのまま: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      const select = async (i, key) => {
        const line = page.locator(".lens-line").nth(i);
        await line.locator("[data-f=toric]").setChecked(key.includes("|"));   // トーリックの選択肢は、「トーリック」で絞り込んだときに出る
        await line.locator("[data-f=model]").selectOption(key);
      };
      for (const key of ["__alconKey", "__otherToricKey", "__alconPlainKey"]) {
        await select(0, await page.evaluate((k) => window[k], key));
        const line = page.locator(".lens-line").first();
        assert.equal(await line.locator("a").count(), 0, `${key}: レンズの明細にリンクはない`);
        assert.equal(await line.getByText(/Calculator/).count(), 0, key);
        assert.deepEqual(await line.locator(".lens-filter-check").allInnerTexts(), ["トーリック", "多焦点"]);
      }
      // 内部の連携用の処理(ALCONトーリックのURL)は維持
      await select(0, await page.evaluate(() => window.__alconKey));
      assert.equal(await page.evaluate(() => window.__lines.alconCalculator()), CALC_URL);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
