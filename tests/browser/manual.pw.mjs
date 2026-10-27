// 回帰テスト(ブラウザ): 使い方・ヘルプ(オンラインマニュアル。原稿は docs/manual)。
// 実際の index.html・main.js を、偽の Firebase SDK(ログイン前/ログイン後・施設1件)で動かす。外部への通信はしない。
// メニューから開く・目次から全ページへ移動・目次/注文画面(ログイン画面)へ戻る・ブラウザの戻る・#help 付きの URL・
// 安全な表示(HTML を解釈しない)・スマートフォン/PC で横にはみ出さない。  npm run test:browser
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";
import { MANUAL_PAGES } from "../../src/manual/manual-pages.js";
import { newFakeContext } from "./fake-firebase.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const LOGGED_IN = {
  user: { uid: "u1", email: "u1@example.jp", emailVerified: true, displayName: "テスト 太郎" },
  db: { "facilities/f1": { name: "テスト眼科", status: "active" }, "facilities/f1/members/u1": { uid: "u1", role: "orderer", name: "テスト 太郎" } }
};

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

const newContext = (browser, width, session) => newFakeContext(browser, base, width, session);

const visible = (page, sel) => page.locator(sel).evaluate(el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)).catch(() => false);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
/** 本文中のマニュアルのページへのリンク */
const helpLinks = (page) => page.locator('.manual-body a[href^="#help"]').evaluateAll(as => [...new Set(as.map(a => a.getAttribute("href")))]);
/** 表示されたページの題名を記録する(範囲外のページが一時的にも表示されないことの確認) */
const watchTitles = (page) => page.addInitScript((titles) => {
  window.__firstSeen = {};
  new MutationObserver(() => {
    const t = document.querySelector("#manualView .manual-body h1")?.textContent;
    for (const [id, title] of Object.entries(titles)) if (t === title && !(id in window.__firstSeen)) window.__firstSeen[id] = performance.now();
  }).observe(document, { subtree: true, childList: true, characterData: true });
}, Object.fromEntries(MANUAL_PAGES.map(p => [p.id, p.title])));
const seenTitles = (page, id) => page.evaluate((id) => (window.__firstSeen && id in window.__firstSeen ? [id] : []), id);
/** 役割ごとのログイン(施設1件) */
const withRole = (role, claims, authDelay = 0) => ({
  user: { uid: "u1", email: "u1@example.jp", emailVerified: true, displayName: "テスト 太郎" }, claims, authDelay,
  db: { "facilities/f1": { name: "テスト眼科", status: "active" }, "facilities/f1/members/u1": { uid: "u1", role, name: "テスト 太郎" } }
});

async function openHelpFromMenu(page) {
  await page.click("#btnHeaderMenu");
  await page.click("#menuHelp");
  await page.locator("#manualView:not([hidden]) .manual-body h1").waitFor();
}

test("ヘルプ: メニューの項目とハッシュの処理は、他の画面へ移るときにヘルプを閉じる", () => {
  const main = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");
  for (const k of ["onOpenHistory", "onOpenSettings", "onOpenApplications", "onOpenPreregistrations", "onRegisterFacility", "onSignOut"]) {
    assert.match(main, new RegExp(`${k}: \\(\\) => \\{ leaveOverlay\\(\\);`), k);
  }
  assert.match(main, /onSwitchFacility: async \(\) => \{\s*leaveOverlay\(\);/);
  for (const f of ["src/ui/manual-view.js", "src/ui/markdown-view.js", "src/ui/about-view.js"]) {
    const view = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(view), `${f}: Markdown の表示は HTML として解釈しない`);
  }
});

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`ヘルプ(ログイン前): 目次と「1. 初めて利用する方へ」だけ。リンク・戻る・#help の URL(範囲外は目次へ)。スマートフォン/PC: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const context = await newContext(browser, width, null);
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await page.goto(base);
        await page.getByText("ログインが必要です", { exact: true }).waitFor();
        await page.click("#btnHeaderMenu");
        assert.deepEqual(await page.locator("#headerMenuPanel button").allInnerTexts(), ["使い方・ヘルプ", "サイトを共有"]);
        await page.click("#menuHelp");
        await page.locator("#manualView:not([hidden]) .manual-body h1").waitFor();
        assert.equal(new URL(page.url()).hash, "#help");
        assert.equal(await page.locator(".manual-body h1").innerText(), "オンラインマニュアル");
        assert.equal(await page.getByText("ログインが必要です", { exact: true }).isVisible(), false, "ログイン画面は隠れる");
        assert.deepEqual(await page.locator(".manual-nav a").allInnerTexts(), ["目次", "1. 初めて利用する方へ"], "上部のページ一覧は閲覧できるページだけ");
        assert.deepEqual(await helpLinks(page), ["#help/01-first-time"], "目次の本文も閲覧できるページだけ");
        assert.deepEqual(await page.locator(".manual-pager a").allInnerTexts(), ["1. 初めて利用する方へ →"]);
        assert.deepEqual(await page.locator(".manual-back").allInnerTexts(), ["ログイン画面に戻る", "ログイン画面に戻る"]);
        assert.ok(await noOverflow(page), `${width}: 目次が横にはみ出さない`);

        // 目次から「1.」へ。範囲外のページへのリンクは文字だけ。前後のページは目次だけ
        await page.locator('.manual-body a[href="#help/01-first-time"]').first().click();
        await page.waitForFunction((title) => document.querySelector(".manual-body h1")?.textContent === title, MANUAL_PAGES[1].title);
        assert.deepEqual(await helpLinks(page), [], "2〜4 へのリンクは出さない");
        assert.ok((await page.locator(".manual-body").innerText()).includes("注文者・代理入力者向けマニュアル"), "文は残す(リンクだけ外す)");
        assert.deepEqual(await page.locator(".manual-pager a").allInnerTexts(), ["← 目次"]);
        assert.ok(await noOverflow(page), `${width}: 1. が横にはみ出さない`);
        const hrefs = await page.locator(".manual-body a").evaluateAll(as => as.map(a => [a.getAttribute("href"), a.target, a.rel]));
        for (const [href, target, rel] of hrefs) assert.deepEqual([/^https:\/\//.test(href), target, rel], [true, "_blank", "noopener noreferrer"], href);
        // 目次へ戻る・ブラウザの戻る
        await page.locator(".manual-toc").click();
        await page.waitForFunction(() => location.hash === "#help" && document.querySelector(".manual-body h1"));
        await page.goBack();
        await page.waitForFunction(() => location.hash === "#help/01-first-time");
        assert.equal(await page.locator(".manual-body h1").innerText(), MANUAL_PAGES[1].title);
        // ログイン画面に戻る
        await page.locator(".manual-foot .manual-back").click();
        await page.getByText("ログインが必要です", { exact: true }).waitFor();
        assert.equal(await visible(page, "#manualView"), false);
        assert.equal(new URL(page.url()).hash, "");
        assert.deepEqual(errors, []);
        await context.close();

        // #help/… の URL: 範囲内はそのページ、範囲外(2・3、統合前の旧ページを含む)は目次へ戻す(一時的にも本文を表示しない)
        for (const id of ["02-orderer", "03-managers", "03-subadmin", "04-admin"]) {
          const c2 = await newContext(browser, width, null);
          const p2 = await c2.newPage();
          await watchTitles(p2);
          await p2.goto(`${base}#help/${id}`);
          await p2.waitForFunction(() => location.hash === "#help" && document.querySelector(".manual-body h1")?.textContent === "オンラインマニュアル");
          assert.deepEqual([...await seenTitles(p2, "02-orderer"), ...await seenTitles(p2, "03-managers")], [], `${id} は表示しない`);
          await c2.close();
        }
      }
    } finally { await browser.close(); }
  });

  test(`ヘルプ(役割ごと): 注文者・代行入力者は1〜2、副管理者・管理者・運営者は1〜3。旧ページの URL は統合ページへ(範囲外は目次へ)。確認中は上位のページを出さない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const labels = MANUAL_PAGES.map(p => p.label);
      for (const [role, claims, count] of [["orderer", {}, 3], ["proxy", {}, 3], ["subadmin", {}, 4], ["admin", {}, 4], ["orderer", { platformAdmin: true }, 4]]) {
        const who = `${role}${claims.platformAdmin ? "(運営者)" : ""}`;
        const context = await newContext(browser, 390, withRole(role, claims, 600));
        const page = await context.newPage();
        // 確認中(ログイン状態が分かる前)に旧ページ(4. 施設管理者向け)の URL を開く: 本文は出さず、分かってから統合ページ(3.)または目次へ
        await watchTitles(page);
        await page.goto(`${base}#help/04-admin`);
        if (count === 4) {
          await page.waitForFunction((title) => location.hash === "#help/03-managers" && document.querySelector(".manual-body h1")?.textContent === title, MANUAL_PAGES[3].title);
          const [first, authAt] = await page.evaluate(() => [window.__firstSeen["03-managers"], window.__authAt]);
          assert.ok(first >= authAt, `${who}: ログインの確認の前には表示しない`);
        } else {
          await page.waitForFunction(() => location.hash === "#help" && document.querySelector(".manual-body h1")?.textContent === "オンラインマニュアル");
          assert.deepEqual(await seenTitles(page, "03-managers"), [], `${who}: 3. を一時的にも表示しない`);
        }
        assert.deepEqual(await page.locator(".manual-nav a").allInnerTexts(), labels.slice(0, count), who);
        await page.evaluate(() => { location.hash = "#help"; });
        await page.waitForFunction(() => location.hash === "#help" && document.querySelector(".manual-body h1")?.textContent === "オンラインマニュアル");
        assert.deepEqual(await helpLinks(page), MANUAL_PAGES.slice(1, count).map(p => `#help/${p.id}`), `${who}: 目次の本文`);
        // 最後に閲覧できるページには「次へ」がない
        await page.evaluate((id) => { location.hash = `#help/${id}`; }, MANUAL_PAGES[count - 1].id);
        await page.waitForFunction((title) => document.querySelector(".manual-body h1")?.textContent === title, MANUAL_PAGES[count - 1].title);
        assert.equal(await page.locator(".manual-pager .is-next").count(), 0, `${who}: 次へなし`);
        await context.close();
      }
    } finally { await browser.close(); }
  });

  test(`ヘルプ(副管理者・施設管理者向け): 施設管理者のみの項目に赤い * 。旧ページ(3. 副管理者向け)の URL も統合ページへ: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const context = await newContext(browser, 390, withRole("subadmin", {}));
      const page = await context.newPage();
      await page.goto(`${base}#help/03-subadmin`);
      await page.waitForFunction((title) => location.hash === "#help/03-managers" && document.querySelector(".manual-body h1")?.textContent === title, MANUAL_PAGES[3].title);
      const marks = page.locator(".manual-body .manual-admin-mark");
      assert.ok(await marks.count() >= 6, "印の数");
      assert.equal(await marks.first().evaluate(e => getComputedStyle(e).color), "rgb(220, 38, 38)", "赤");
      assert.equal(await marks.first().innerText(), "*");
      assert.ok(!(await page.locator(".manual-body").innerText()).includes("{*}"), "原稿の印の書き方は表示しない");
      assert.match(await page.locator(".manual-body > p").last().innerText(), /^\*\s*施設管理者のみ操作できます。$/);
      assert.ok(await noOverflow(page), "横にはみ出さない(表を含む)");
      await context.close();
    } finally { await browser.close(); }
  });

  test(`ヘルプ(ログイン後): 注文画面の入力を保ったまま開き、注文画面に戻る。他の画面へ移るとヘルプを閉じる。スマートフォン/PC: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const context = await newContext(browser, width, LOGGED_IN);
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await page.goto(base);
        await page.locator("#iolOrderForm:not(.hidden) #lensLines .lens-line").waitFor();   // 注文画面の準備(ログインの確認・初期化)が済んでから入力する
        await page.fill("#notesInput", "入力途中の備考");
        const formBox = await page.locator("#iolOrderForm").boundingBox();
        await page.click("#btnHeaderMenu");
        const items = await page.locator("#headerMenuPanel button").allInnerTexts();
        assert.deepEqual(items, ["注文履歴", "新しい施設を登録", "使い方・ヘルプ", "サイトを共有", "ログアウト"]);
        await page.click("#menuHelp");
        await page.locator("#manualView:not([hidden]) .manual-body h1").waitFor();
        assert.equal(await visible(page, "#iolOrderForm"), false, "注文画面は隠れる");
        assert.deepEqual(await page.locator(".manual-back").allInnerTexts(), ["注文画面に戻る", "注文画面に戻る"]);
        assert.ok(await noOverflow(page), `${width}: 横にはみ出さない`);
        // 注文画面に戻る: 入力はそのまま・レイアウトも同じ
        await page.locator(".settings-head .manual-back").click();
        await page.locator("#iolOrderForm").waitFor({ state: "visible" });
        assert.equal(await page.inputValue("#notesInput"), "入力途中の備考");
        assert.equal(new URL(page.url()).hash, "");
        const after = await page.locator("#iolOrderForm").boundingBox();
        assert.deepEqual([after.x, after.width], [formBox.x, formBox.width], "注文画面のレイアウトは変わらない");
        // ヘルプから「注文履歴」へ移ると、ヘルプは閉じる
        await openHelpFromMenu(page);
        await page.click("#btnHeaderMenu");
        await page.click("#menuOrderHistory");
        await page.locator("#orderHistory:not([hidden])").waitFor();
        assert.equal(await visible(page, "#manualView"), false);
        assert.equal(await visible(page, "#orderHistory"), true);
        assert.equal(new URL(page.url()).hash, "");
        // 注文履歴の表示中に開いて「注文画面に戻る」→ 注文画面
        await openHelpFromMenu(page);
        await page.locator(".manual-foot .manual-back").click();
        await page.locator("#iolOrderForm").waitFor({ state: "visible" });
        assert.equal(await visible(page, "#orderHistory"), false);
        assert.deepEqual(errors, []);
        await context.close();
      }
    } finally { await browser.close(); }
  });
}

test("ヘルプ: Markdown の HTML・危険なリンクは要素にならない(chromium)", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const context = await newContext(browser, 800, null);
    const page = await context.newPage();
    await page.goto(base);
    await page.getByText("ログインが必要です", { exact: true }).waitFor();
    const r = await page.evaluate(async () => {
      const { renderManualMarkdown } = await import("/src/ui/manual-view.js");
      window.__xss = 0;
      const box = document.createElement("div");
      box.appendChild(renderManualMarkdown([
        "<script>window.__xss++</script>", "", '<img src=x onerror="window.__xss++">', "",
        "**<b onclick=\"window.__xss++\">太字</b>** `<i>コード</i>`", "",
        "| a |", "| --- |", "| <svg onload=\"window.__xss++\"> |", "",
        "[押す](javascript:window.__xss++) [外部](https://example.com/) [ページ](./02-orderer.md)"].join("\n")));
      document.body.appendChild(box);
      await new Promise(r => setTimeout(r, 50));
      return {
        xss: window.__xss,
        tags: [...box.querySelectorAll("*")].map(e => e.tagName.toLowerCase()).filter(t => !["p", "strong", "code", "a", "div", "table", "thead", "tbody", "tr", "th", "td"].includes(t)),
        onAttrs: [...box.querySelectorAll("*")].flatMap(e => [...e.attributes].map(a => a.name)).filter(n => n.startsWith("on")),
        links: [...box.querySelectorAll("a")].map(a => a.getAttribute("href")),
        text: box.textContent
      };
    });
    assert.deepEqual([r.xss, r.tags, r.onAttrs], [0, [], []]);
    assert.deepEqual(r.links, ["https://example.com/", "#help/02-orderer"]);
    assert.ok(r.text.includes("<script>window.__xss++</script>") && r.text.includes("<i>コード</i>"), "HTML は文字として表示");
    await context.close();
  } finally { await browser.close(); }
});
