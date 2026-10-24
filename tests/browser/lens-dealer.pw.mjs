// 回帰テスト(ブラウザ): レンズ明細の発注先ディーラー(0社=なし / 1社=自動 / 2社以上=明細ごとに選択必須)。  npm run test:browser
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
const all = [{ id: "dA", name: "A商会", orderEmails: ["a@example.jp"] }, { id: "dB", name: "B医療", orderEmails: [] }];
const n = Number(new URLSearchParams(location.search).get("dealers") || 0);
window.__dealers = all.slice(0, n);
window.__lines = createLensLines({
  container: document.getElementById("lensLines"), addButton: document.getElementById("btnAddLine"),
  getOptions: () => options, getDoctors: () => [{ id: "o1", name: "山田" }], getDealers: () => window.__dealers, minDate: () => "2020-01-01"
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

/** 必須項目を埋める(発注先以外) */
async function fillLine(page, i) {
  const line = page.locator(".lens-line").nth(i);
  await line.locator("[data-f=model]").selectOption("jj-dib00v");
  await line.locator("[data-f=power]").selectOption("+20.0D");
  await line.locator("[data-f=date]").fill(`2099-02-0${i + 1}`);
  await line.locator("[data-f=doctor]").selectOption("o1");
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`発注先: 0社は欄なし・1社は自動・2社以上は選択必須(明細ごと・前の明細を引き継ぐ): ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      const open = async (n) => { await page.goto(`${base}?dealers=${n}`); await page.waitForFunction(() => window.__ready); };
      const dealerOf = () => page.evaluate(() => window.__lines.values().map(v => v.dealer && v.dealer.id));

      // 0社: 発注先の欄は出ない。必須ではなく、発注先なし(null)
      await open(0);
      assert.equal(await page.locator('[data-group="dealer"]').first().isHidden(), true);
      await fillLine(page, 0);
      assert.equal(await page.evaluate(() => window.__lines.validate().ok), true);
      assert.deepEqual(await dealerOf(), [null]);

      // 1社: 欄は出ない。自動で選ばれる
      await open(1);
      assert.equal(await page.locator('[data-group="dealer"]').first().isHidden(), true);
      await fillLine(page, 0);
      assert.equal(await page.evaluate(() => window.__lines.validate().ok), true);
      assert.deepEqual(await dealerOf(), ["dA"]);

      // 2社: 欄が出る(必須)。未選択ではエラー(勝手に決めない)
      await open(2);
      assert.equal(await page.locator('[data-group="dealer"]').first().isVisible(), true);
      assert.deepEqual(await page.locator("[data-f=dealer] option").allInnerTexts(), ["選択", "A商会", "B医療"]);
      await fillLine(page, 0);
      assert.deepEqual(await dealerOf(), [null], "未選択のまま自動で決まらない");
      assert.equal(await page.evaluate(() => window.__lines.validate().ok), false);
      assert.match(await page.locator('[data-err="dealer"]').first().innerText(), /発注先を選択してください/);
      await page.locator(".lens-line").first().locator("[data-f=dealer]").selectOption("dB");
      assert.equal(await page.locator('[data-err="dealer"]').first().innerText(), "", "選ぶとエラーが消える");
      assert.equal(await page.evaluate(() => window.__lines.validate().ok), true);
      // 明細を追加すると直前の発注先を引き継ぎ、明細ごとに変えられる(複数ディーラーの注文)
      await page.click("#btnAddLine");
      assert.equal(await page.locator(".lens-line").nth(1).locator("[data-f=dealer]").inputValue(), "dB");
      await fillLine(page, 1);
      await page.locator(".lens-line").nth(1).locator("[data-f=dealer]").selectOption("dA");
      assert.deepEqual(await dealerOf(), ["dB", "dA"]);
      assert.equal(await page.evaluate(() => window.__lines.validate().ok), true);
      // 発注先が違えば、同じレンズ・度数・手術日・担当医でも重複ではない
      await page.locator(".lens-line").nth(1).locator("[data-f=date]").fill("2099-02-01");
      assert.equal(await page.evaluate(() => window.__lines.validate().ok), true);
      await page.locator(".lens-line").nth(1).locator("[data-f=dealer]").selectOption("dB");
      assert.equal(await page.evaluate(() => window.__lines.validate().ok), false, "同じ発注先なら重複");
      // 発注先の登録が増減したとき(refresh): 残っていなければ未選択に戻る
      await page.evaluate(() => { window.__dealers = window.__dealers.filter(d => d.id === "dA"); window.__lines.refresh(); });
      assert.equal(await page.locator('[data-group="dealer"]').first().isHidden(), true, "1社になれば欄は隠れる");
      assert.deepEqual(await dealerOf(), ["dA", "dA"], "1社なら全明細が自動選択");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
