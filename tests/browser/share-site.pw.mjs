// 回帰テスト(ブラウザ): ヘッダーのメニュー「サイトを共有」。ログインの前(施設に入る前)からも使える。
// 白い背景のモーダルに、https://iol.medconf.jp/ のQRコード・URL・「URLをコピー」。PC・スマートフォン。  npm run test:browser
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
<header class="app-header"><div class="header-inner"><div class="header-text"><h1 class="header-title">IOL 注文フォーム</h1></div></div></header>
<script type="module">
import { createHeaderMenu } from "/src/ui/header-menu.js";
const noop = () => {};
window.__menu = createHeaderMenu({ onOpenHistory: noop, onSwitchFacility: noop, onOpenSettings: noop, onRegisterFacility: noop, onSignOut: noop });
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

test("QRコードは https://iol.medconf.jp/ だけを表す(施設ID・招待コード・個人情報を含めない。外部への通信なし)", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ui/share-site.js"), "utf8");
  assert.match(src, /export const SITE_URL = "https:\/\/iol\.medconf\.jp\/";/);
  assert.ok(!/fac-|facilityId|invite|@|token/i.test(src.split("const QR_SVG")[1].split(";\n")[0]), "QRコードのデータに施設ID・招待・メールなどを含めない");
  assert.ok(!/https?:\/\/(?!iol\.medconf\.jp|www\.w3\.org)/.test(src), "外部のURLを読み込まない");
});

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`サイトを共有: ログインの前もメニューから開ける。QRコード・URL・URLをコピー。白い背景。PC・スマートフォン: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: "dark" });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await page.goto(base);
        await page.waitForFunction(() => window.__ready);
        // ログインの前: メニューは「使い方・ヘルプ」「サイトを共有」だけ
        await page.click("#btnHeaderMenu");
        assert.deepEqual(await page.locator("#headerMenuPanel button").allInnerTexts(), ["使い方・ヘルプ", "サイトを共有"]);
        await page.click("#menuShareSite");
        const dlg = page.locator(".share-dialog");
        await dlg.waitFor();
        assert.equal(await dlg.locator(".modal-title").innerText(), "サイトを共有");
        assert.equal(await dlg.locator(".share-url").innerText(), "https://iol.medconf.jp/");
        assert.deepEqual(await dlg.locator(".modal-footer button").allInnerTexts(), ["閉じる", "URLをコピー"]);
        const qr = await dlg.locator("svg.share-qr").boundingBox();
        assert.deepEqual([Math.round(qr.width), Math.round(qr.height)], [200, 200], `${width}: QRコード 200px`);
        assert.ok(qr.x >= 0 && qr.x + qr.width <= width, `${width}: 画面内`);
        const look = await dlg.evaluate(o => ({ bg: getComputedStyle(o.querySelector(".modal-card")).backgroundColor, scheme: getComputedStyle(o).colorScheme }));
        assert.deepEqual(look, { bg: "rgb(255, 255, 255)", scheme: "light" }, "ダークモードでも白い背景");
        // URLをコピー(結果を表示する。コピーできない環境では選択してコピーする案内)
        await dlg.locator('[data-act="copy"]').click();
        await page.waitForFunction(() => document.querySelector(".share-status").textContent !== "", null, { timeout: 5000 });
        assert.match(await dlg.locator(".share-status").innerText(), /URLをコピーしました|コピーできませんでした/);
        // 閉じる・Escape
        await dlg.locator('[data-act="close"]').click();
        assert.equal(await page.locator(".share-dialog").count(), 0);
        await page.click("#btnHeaderMenu");
        await page.click("#menuShareSite");
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".share-dialog").count(), 0);
        // ログイン後のメニューにも「使い方・ヘルプ」「サイトを共有」(ログアウトの前)
        await page.evaluate(() => window.__menu.update({ user: { displayName: "テスト" }, facilityName: "テスト眼科", canSwitch: false, canSettings: true }));
        await page.click("#btnHeaderMenu");
        const items = await page.locator("#headerMenuPanel button").allInnerTexts();
        assert.deepEqual(items.slice(-3), ["使い方・ヘルプ", "サイトを共有", "ログアウト"]);
        assert.deepEqual(errors, []);
        await context.close();
      }
    } finally { await browser.close(); }
  });
}
