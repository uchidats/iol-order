// 回帰テスト(ブラウザ): Alcon Toric Calculator の小さなテキストリンク(外部リンクアイコン付き)。  npm run test:browser
// ALCONのトーリックIOLを選んだ明細だけ、「トーリック」「多焦点」チェックボックスの右に表示する。別タブで開く。
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
  test(`Alcon Toric Calculator: 小さなテキストリンク+外部リンクアイコン(ALCONのトーリック選択時だけ): ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
      await context.route(/myalcon-toriccalc\.com/, r => r.fulfill({ contentType: "text/html", body: "<title>calc</title>" })); // 外部サイトには接続しない
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      const link = (i) => page.locator(".lens-line").nth(i).locator(".alcon-calc-link");
      const select = async (i, key) => {
        const line = page.locator(".lens-line").nth(i);
        await line.locator("[data-f=toric]").setChecked(key.includes("|"));   // トーリックの選択肢は、「トーリック」で絞り込んだときに出る
        await line.locator("[data-f=model]").selectOption(key);
      };

      // 大きな緑の案内カード(連携準備中)は無い
      assert.equal(await page.locator("#alconCalcArea, .alcon-calc-card").count(), 0);
      assert.equal(await page.getByText("連携準備中").count(), 0);

      // 表示条件: ALCONのトーリックを選んだ明細だけ。未選択・ALCONの非トーリック・他社のトーリックでは出ない
      assert.equal(await link(0).isHidden(), true);
      await select(0, await page.evaluate(() => window.__alconPlainKey));
      assert.equal(await link(0).isHidden(), true);
      await select(0, await page.evaluate(() => window.__otherToricKey));
      assert.equal(await link(0).isHidden(), true);
      await select(0, await page.evaluate(() => window.__alconKey));
      assert.equal(await link(0).isVisible(), true);

      // 小さなテキストリンク + 外部リンクアイコン(SVG)。矢印文字「↗」は使わない。リンク先は従来どおり・別タブ
      assert.equal((await link(0).innerText()).trim(), "Alcon Online Toric IOL Calculator");
      assert.ok(!(await link(0).textContent()).includes("↗"));
      assert.equal(await link(0).locator("svg").count(), 1);
      assert.equal(await link(0).getAttribute("href"), CALC_URL);
      assert.equal(await link(0).getAttribute("target"), "_blank");
      assert.match(await link(0).getAttribute("rel"), /noopener/);
      const fs1 = await link(0).evaluate(a => parseFloat(getComputedStyle(a).fontSize));
      assert.ok(fs1 <= 14.5, `小さなリンク: ${fs1}px`);

      // 「トーリック」「多焦点」チェックボックスの右(同じ行)
      const pos = await page.locator(".lens-line").first().evaluate(l => {
        const r = (e) => e.getBoundingClientRect();
        return { toric: r(l.querySelector('[data-f="toric"]')), mf: r(l.querySelector('[data-f="multifocal"]')), link: r(l.querySelector(".alcon-calc-link")) };
      });
      assert.ok(pos.link.left > pos.mf.right && Math.abs((pos.link.top + pos.link.bottom) / 2 - (pos.mf.top + pos.mf.bottom) / 2) < 12, JSON.stringify(pos));

      // テキストとアイコン全体がクリック可能: アイコンをクリックしても別タブで開く(元のページは動かない)
      const [popup] = await Promise.all([context.waitForEvent("page"), link(0).locator("svg").click()]);
      assert.match(popup.url(), /myalcon-toriccalc\.com/);
      await popup.close();
      assert.equal(page.url(), base);
      const [popup2] = await Promise.all([context.waitForEvent("page"), link(0).getByText("Alcon Online Toric IOL Calculator").click()]);
      await popup2.close();

      // 明細ごとに独立(2つ目のレンズがALCONのトーリックでなければ、そのレンズには出ない)
      await page.click("#btnAddLine");
      assert.equal(await link(1).isHidden(), true);
      await select(1, await page.evaluate(() => window.__alconKey));
      assert.equal(await link(1).isVisible(), true);
      await select(0, await page.evaluate(() => window.__otherToricKey));
      assert.equal(await link(0).isHidden(), true);
      assert.equal(await link(1).isVisible(), true);
      // 内部の連携用の処理(ALCONトーリックのURL)は維持
      assert.equal(await page.evaluate(() => window.__lines.alconCalculator()), CALC_URL);

      // スマホ幅: 自然に折り返し、はみ出さない・重ならない
      for (const w of [390, 320]) {
        await page.setViewportSize({ width: w, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `横スクロール ${w}`);
        const ok = await link(1).evaluate(a => { const r = a.getBoundingClientRect(), c = a.closest(".lens-filter").getBoundingClientRect(); return r.right <= c.right + 0.5 && r.left >= c.left - 0.5; });
        assert.equal(ok, true, `リンクが枠内 ${w}`);
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
