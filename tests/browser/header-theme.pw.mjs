// 回帰テスト(ブラウザ): 施設設定の「テーマカラー」。色見本・自由な色(HEX)・グラデーション・フォントを黒にする・読みやすさの案内・初期設定に戻す。ヘッダーへの即時反映と自動保存。
// 実際の施設設定の画面(facility-settings.js)を、偽のリポジトリ・保存APIで動かす(ログイン・Firebase は使わない)。  npm run test:browser
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
<header class="app-header"><div class="header-inner"><span class="header-title">IOL Order</span></div></header>
<main class="main-content"></main>
<script type="module">
import { createFacilitySettings } from "/src/ui/facility-settings.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
window.__calls = [];
let theme = null;
const repository = {
  listOrderers: async () => [], listAdoptedIols: async () => [], listMembers: async () => [], getIolOrder: async () => null,
  listDealers: async () => [], getMailSettings: async () => null, getHeaderTheme: async () => (theme ? { ...theme } : null)
};
const settingsApi = {
  saveOrderers: async () => {}, saveAdoptedIols: async () => {}, saveIolOrder: async () => {}, deleteOrderer: async () => {}, deleteDealer: async () => {},
  saveDealers: async () => {}, saveMailSettings: async () => {},
  saveHeaderTheme: async (fid, t) => { window.__calls.push(["save", t]); theme = { ...t }; },
  resetHeaderTheme: async () => { window.__calls.push(["reset"]); theme = null; }
};
const s = createFacilitySettings({ mount: document.querySelector("main"), repository, settingsApi, masters: IOL_MODELS, onSaved: async () => {}, onClose() {} });
await s.open({ id: "f1", name: "テスト施設" });
window.__reopen = () => s.open({ id: "f1", name: "テスト施設" });
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

const headerBg = (page) => page.evaluate(() => { const e = document.querySelector(".app-header"); return { inline: e.style.background, image: getComputedStyle(e).backgroundImage, color: getComputedStyle(e).backgroundColor, text: getComputedStyle(e.querySelector(".header-title")).color }; });
const calls = (page) => page.evaluate(() => window.__calls);
const settle = (page) => page.waitForTimeout(150);

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`テーマカラー: 色見本・グラデーション・HEX・初期設定に戻す。ヘッダーに即時反映して自動保存: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      const sec = page.locator('[data-section="theme"]');
      assert.deepEqual((await page.locator("[data-section]").evaluateAll(es => es.map(e => e.getAttribute("data-section")))).slice(-2), ["mail", "theme"], "注文メールの後");
      // 未設定: 標準の青いグラデーション + 白い文字(インラインの指定なし)。グラデーションは初期値 ON、黒い文字は OFF、初期設定に戻すは押せない
      const initial = await headerBg(page);
      assert.equal(initial.inline, "");
      assert.match(initial.image, /linear-gradient/);
      assert.equal(initial.text, "rgb(255, 255, 255)");
      assert.equal(await sec.locator(".theme-swatch").count(), 30);
      assert.equal(await sec.locator('[data-f="themeGradient"]').isChecked(), true);
      assert.equal(await sec.locator('[data-f="themeDarkText"]').isChecked(), false);
      assert.equal(await sec.locator('[data-f="themeAdvice"]').isVisible(), false);
      assert.equal(await sec.locator('[data-act="theme-reset"]').isDisabled(), true);

      // 色見本を選ぶ → すぐにヘッダーに反映(グラデーション)・保存
      await sec.locator('.theme-swatch[data-color="#15803d"]').click();
      await settle(page);
      assert.equal((await headerBg(page)).inline, "linear-gradient(135deg, rgb(14, 83, 40) 0%, rgb(21, 128, 61) 100%)");
      assert.deepEqual(await calls(page), [["save", { color: "#15803d", gradient: true, darkText: false }]]);
      assert.equal(await sec.locator('.theme-swatch[data-color="#15803d"]').getAttribute("aria-pressed"), "true");

      // グラデーションを OFF → 単色
      await sec.locator('[data-f="themeGradient"]').uncheck();
      await settle(page);
      const solid = await headerBg(page);
      assert.equal(solid.image, "none");
      assert.equal(solid.color, "rgb(21, 128, 61)");
      assert.deepEqual((await calls(page)).at(-1), ["save", { color: "#15803d", gradient: false, darkText: false }]);

      // 明るい色も選べる(反映・保存する)。白い文字では読みにくいので、控えめな案内を出す
      await sec.locator('[data-f="themeHex"]').fill("#fde047");
      await sec.locator('[data-f="themeHex"]').blur();
      await settle(page);
      assert.deepEqual((await calls(page)).at(-1), ["save", { color: "#fde047", gradient: false, darkText: false }]);
      assert.equal((await headerBg(page)).color, "rgb(253, 224, 71)");
      assert.equal(await sec.locator('[data-f="themeAdvice"]').isVisible(), true);
      assert.equal(await sec.locator('[data-f="themeAdvice"]').innerText(), "文字が読みやすい配色を推奨します");
      assert.equal(await sec.locator(".error-message").count(), 0, "エラーにはしない");

      // フォントを黒にする → ヘッダーの文字・アイコンが黒。読みやすいので案内は消える
      await sec.locator('[data-f="themeDarkText"]').check();
      await settle(page);
      assert.deepEqual((await calls(page)).at(-1), ["save", { color: "#fde047", gradient: false, darkText: true }]);
      assert.equal((await headerBg(page)).text, "rgb(0, 0, 0)");
      assert.equal(await sec.locator('[data-f="themeAdvice"]').isVisible(), false);

      // 自由な色(HEX)。濃い色に黒い文字は読みにくいので案内(保存はする)
      await sec.locator('[data-f="themeHex"]').fill("#7A1F5C");
      await sec.locator('[data-f="themeHex"]').blur();
      await settle(page);
      assert.deepEqual((await calls(page)).at(-1), ["save", { color: "#7a1f5c", gradient: false, darkText: true }]);
      assert.equal((await headerBg(page)).color, "rgb(122, 31, 92)");
      assert.equal(await sec.locator('[data-f="themeAdvice"]').isVisible(), true);
      assert.equal(await sec.locator(".theme-swatch[aria-pressed=true]").count(), 0);
      // 形式が違う値だけは、反映も保存もしない
      const n = (await calls(page)).length;
      await sec.locator('[data-f="themeHex"]').fill("blue");
      await sec.locator('[data-f="themeHex"]').blur();
      await settle(page);
      assert.match(await sec.locator(".error-message").innerText(), /#RRGGBB/);
      assert.equal((await calls(page)).length, n);

      // 開き直すと保存した内容を表示
      await page.evaluate(() => window.__reopen());
      assert.equal(await sec.locator('[data-f="themeHex"]').inputValue(), "#7a1f5c");
      assert.equal(await sec.locator('[data-f="themeGradient"]').isChecked(), false);
      assert.equal(await sec.locator('[data-f="themeDarkText"]').isChecked(), true);

      // 初期設定に戻す → 設定を削除し、標準の青いグラデーション + 白い文字に戻る(グラデーション ON・黒い文字 OFF)
      await sec.locator('[data-act="theme-reset"]').click();
      await settle(page);
      assert.deepEqual((await calls(page)).at(-1), ["reset"]);
      const back = await headerBg(page);
      assert.equal(back.inline, "");
      assert.equal(back.image, initial.image);
      assert.equal(back.text, "rgb(255, 255, 255)");
      assert.equal(await sec.locator('[data-f="themeGradient"]').isChecked(), true);
      assert.equal(await sec.locator('[data-f="themeDarkText"]').isChecked(), false);
      assert.equal(await sec.locator('[data-f="themeAdvice"]').isVisible(), false);
      assert.equal(await sec.locator('[data-act="theme-reset"]').isDisabled(), true);

      // スマートフォンの幅でも色見本が欄からはみ出さない
      await page.setViewportSize({ width: 360, height: 900 });
      const fits = await sec.evaluate(s => { const g = s.querySelector(".theme-swatches").getBoundingClientRect(), r = s.getBoundingClientRect(); return g.right <= r.right && document.documentElement.scrollWidth <= window.innerWidth; });
      assert.equal(fits, true);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
