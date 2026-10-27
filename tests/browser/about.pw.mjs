// 回帰テスト(ブラウザ): IOL Orderについて(サービス紹介。当面は platformAdmin だけ)。
// 実際の index.html・main.js を偽の Firebase SDK で動かす(fake-firebase.mjs。紹介の本文は Rules と同じく platformAdmin だけが読める)。
// 未ログイン・一般利用者: メニューに出ない、#about を直接開いても何も表示せず本文を読みに行かない。
// 運営者: メニューから開く・6章・章への移動・折りたたみ・注文画面に戻る(入力はそのまま)・安全な表示。スマートフォン/PC。  npm run test:browser
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";
import { newFakeContext } from "./fake-firebase.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

// 本文(テスト用。実際の原稿と同じ構成: 6章・詳しい仕様は折りたたみ)。危険な HTML・リンクも混ぜる
const MARKDOWN = [
  "# IOL Order サービス紹介", "", "紹介の導入文", "", "---", "",
  "## 1. IOL Orderとは", "", "本文1 <script>window.__xss=(window.__xss||0)+1</script>", "",
  "## 2. 主な特徴", "", "### 1. 特徴A", "本文2 [押す](javascript:window.__xss=1) [外部](https://example.com/)", "",
  "## 3. 医療機関とディーラーのメリット", "", "- 項目 <img src=x onerror=\"window.__xss=1\">", "",
  "## 4. 安全性への取り組み", "", "> 注意書き", "",
  "## 5. 詳しい機能・仕様", "",
  "<details>", "<summary>サービスの仕様概要</summary>", "", "| 項目 | 概要 |", "| --- | --- |", "| 注文の上限 | 1回につき最大20明細 |", "", "</details>", "",
  "<details>", "<summary>施設内の役割と権限</summary>", "", "役割の本文", "", "</details>", "",
  "## 6. 利用開始までの流れ", "", "1. **利用前の確認**", "2. 施設の登録", ""
].join("\n");
const CHAPTERS = ["1. IOL Orderとは", "2. 主な特徴", "3. 医療機関とディーラーのメリット", "4. 安全性への取り組み", "5. 詳しい機能・仕様", "6. 利用開始までの流れ"];

const FACILITY = { "facilities/f1": { name: "テスト眼科", status: "active" } };
const session = (uid, role, claims, withContent = true) => ({
  user: { uid, email: `${uid}@example.jp`, emailVerified: true, displayName: `テスト ${uid}` }, claims,
  db: { ...FACILITY, [`facilities/f1/members/${uid}`]: { uid, role, name: uid }, ...(withContent ? { "platformContent/serviceIntroduction": { markdown: MARKDOWN, sha256: "x" } } : {}) }
});
const OPERATOR = session("op", "admin", { platformAdmin: true });
const ADMIN = session("adm", "admin", {});   // 施設の管理者(運営者ではない)

let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    const p = path.join(ROOT, url === "/" ? "index.html" : url);
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

const menuItems = async (page) => {
  await page.click("#btnHeaderMenu");
  const items = await page.locator("#headerMenuPanel button").allInnerTexts();
  await page.keyboard.press("Escape");
  return items;
};
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const reads = (page) => page.evaluate(() => (window.__fakeReads || []).filter(p => p.startsWith("platformContent/")));

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`IOL Orderについて: 未ログイン・一般利用者には出さず、#about を直接開いても本文を読まない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      // 未ログイン
      let context = await newFakeContext(browser, base, 390, null);
      let page = await context.newPage();
      await page.goto(`${base}#about`);
      await page.getByText("ログインが必要です", { exact: true }).waitFor();
      await page.waitForFunction(() => location.hash === "");
      assert.equal(await page.locator("#aboutView").count(), 0, "紹介の画面を作らない");
      assert.deepEqual(await menuItems(page), ["使い方・ヘルプ", "サイトを共有"]);
      assert.deepEqual(await reads(page), [], "本文を読みに行かない");
      assert.ok(!(await page.content()).includes("IOL Orderについて"));
      await context.close();

      // ログインした一般利用者(施設の管理者を含む)
      for (const s of [ADMIN, session("ord", "orderer", {})]) {
        context = await newFakeContext(browser, base, 1100, s);
        page = await context.newPage();
        await page.goto(`${base}#about`);
        await page.locator("#iolOrderForm:not(.hidden) #lensLines .lens-line").waitFor();   // 注文画面の準備(ログインの確認・初期化)が済んでから入力する
        await page.waitForFunction(() => location.hash === "");
        assert.equal(await page.locator("#aboutView").count(), 0);
        assert.ok(!(await menuItems(page)).includes("IOL Orderについて"), `${s.user.uid}: メニューに出ない`);
        // 画面を操作して #about にしても開かない
        await page.evaluate(() => { location.hash = "#about"; });
        await page.waitForFunction(() => location.hash === "");
        assert.equal(await page.locator("#aboutView").count(), 0);
        assert.deepEqual(await reads(page), []);
        assert.equal(await page.locator("#iolOrderForm").isVisible(), true);
        await context.close();
      }
    } finally { await browser.close(); }
  });

  test(`IOL Orderについて(運営者): メニューから開く・6章・章へ移動・折りたたみ・注文画面に戻る(入力はそのまま)・安全な表示。スマートフォン/PC: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const context = await newFakeContext(browser, base, width, OPERATOR);
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await page.goto(base);
        await page.locator("#iolOrderForm:not(.hidden) #lensLines .lens-line").waitFor();   // 注文画面の準備(ログインの確認・初期化)が済んでから入力する
        await page.fill("#notesInput", "入力途中の備考");
        const items = await menuItems(page);
        assert.deepEqual(items.slice(-4), ["IOL Orderについて", "使い方・ヘルプ", "サイトを共有", "ログアウト"]);
        await page.click("#btnHeaderMenu");
        await page.click("#menuAbout");
        await page.locator("#aboutView .about-body h1").waitFor();
        assert.equal(new URL(page.url()).hash, "#about");
        assert.equal(await page.locator("#aboutHeading").innerText(), "IOL Orderについて");
        assert.equal(await page.locator("#iolOrderForm").isVisible(), false, "注文画面は隠れる");
        assert.deepEqual(await page.locator("#aboutView .manual-nav button").allInnerTexts(), CHAPTERS, "6章へ移動するボタン");
        assert.deepEqual(await page.locator(".about-body h2").allInnerTexts(), CHAPTERS);
        // 詳しい仕様は折りたたみ(最初は閉じている。開くと表が見える)
        const det = page.locator(".about-body details");
        assert.equal(await det.count(), 2);
        assert.deepEqual(await det.evaluateAll(ds => ds.map(d => d.open)), [false, false]);
        assert.equal(await page.getByText("1回につき最大20明細").isVisible(), false);
        await det.first().locator("summary").click();
        assert.equal(await page.getByText("1回につき最大20明細").isVisible(), true);
        // 章へ移動(6章の見出しが画面内に入る)
        await page.locator("#aboutView .manual-nav button").last().click();
        await page.waitForFunction(() => { const h = [...document.querySelectorAll(".about-body h2")].pop(); const r = h.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; });
        assert.ok(await noOverflow(page), `${width}: 横にはみ出さない`);
        // 安全な表示: HTML は文字のまま、危険なリンクはリンクにしない
        const safe = await page.evaluate(() => ({
          xss: window.__xss || 0,
          scripts: document.querySelectorAll(".about-body script, .about-body img").length,
          links: [...document.querySelectorAll(".about-body a")].map(a => [a.getAttribute("href"), a.target]),
          text: document.querySelector(".about-body").textContent
        }));
        assert.deepEqual([safe.xss, safe.scripts, safe.links], [0, 0, [["https://example.com/", "_blank"]]]);
        assert.ok(safe.text.includes("<script>"), "HTML は文字として表示");
        // 注文画面に戻る: 入力はそのまま、本文は画面に残さない
        await page.locator(".manual-foot .manual-back").click();
        await page.locator("#iolOrderForm").waitFor({ state: "visible" });
        assert.equal(await page.inputValue("#notesInput"), "入力途中の備考");
        assert.equal(new URL(page.url()).hash, "");
        assert.equal(await page.locator(".about-body").count(), 0);
        // #about の URL で開く(ログインの確認の後に表示)・ヘルプへ移ると閉じる
        await page.goto(`${base}#about`);
        await page.locator("#aboutView .about-body h1").waitFor();
        await page.click("#btnHeaderMenu");
        await page.click("#menuHelp");
        await page.locator("#manualView:not([hidden]) .manual-body h1").waitFor();
        assert.equal(await page.locator("#aboutView").isVisible(), false);
        assert.deepEqual(errors, []);
        await context.close();
      }
    } finally { await browser.close(); }
  });
}

test("IOL Orderについて(運営者・原稿の未登録): 案内だけを表示する(chromium)", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const context = await newFakeContext(browser, base, 800, session("op", "admin", { platformAdmin: true }, false));
    const page = await context.newPage();
    await page.goto(`${base}#about`);
    await page.getByText("紹介ページの原稿がまだ登録されていません。").waitFor();
    assert.equal(await page.locator(".about-body").count(), 0);
    await context.close();
  } finally { await browser.close(); }
});
