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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

// 偽の Firebase SDK(main.js が読み込む4つのモジュール)。データは window.__fakeUser・window.__fakeDb
const FAKE_SDK = {
  "firebase-app.js": "export const initializeApp = (c) => ({ c });",
  "firebase-auth.js": `
    export const getAuth = () => ({ get currentUser() { return window.__fakeUser || null; } });
    export function onAuthStateChanged(auth, cb) { setTimeout(() => cb(window.__fakeUser || null), 0); return () => {}; }
    export class GoogleAuthProvider {}
    export const signInWithPopup = async () => { throw Object.assign(new Error("closed"), { code: "auth/popup-closed-by-user" }); };
    export const sendSignInLinkToEmail = async () => {};
    export const isSignInWithEmailLink = () => false;
    export const signInWithEmailLink = async () => ({});
    export const signOut = async () => {};`,
  "firebase-firestore.js": `
    const store = () => window.__fakeDb || {};
    const snap = (p, d) => ({ id: p.split("/").pop(), exists: () => d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))),
      ref: { path: p, parent: { parent: { id: p.split("/").slice(-3)[0] } } } });
    export const getFirestore = () => ({});
    export const doc = (db, ...s) => ({ kind: "doc", path: s.join("/") });
    export const collection = (db, ...s) => ({ kind: "col", path: s.join("/") });
    export const collectionGroup = (db, id) => ({ kind: "group", id });
    export const where = (f, op, v) => ({ t: "where", f, v });
    export const orderBy = () => ({ t: "orderBy" });
    export const limit = () => ({ t: "limit" });
    export const query = (ref, ...cs) => ({ ...ref, cs });
    export const serverTimestamp = () => ({});
    export async function getDoc(ref) { return snap(ref.path, store()[ref.path]); }
    export async function getDocs(q) {
      const docs = [];
      for (const [p, d] of Object.entries(store())) {
        const s = p.split("/");
        if (q.kind === "col" && !(p.startsWith(q.path + "/") && s.length === q.path.split("/").length + 1)) continue;
        if (q.kind === "group" && s[s.length - 2] !== q.id) continue;
        if ((q.cs || []).some(c => c.t === "where" && d[c.f] !== c.v)) continue;
        docs.push(snap(p, d));
      }
      return { docs, empty: !docs.length, size: docs.length, forEach: (fn) => docs.forEach(fn) };
    }`,
  "firebase-functions.js": `
    export const getFunctions = () => ({});
    export const httpsCallable = (fns, name) => async () => ({ data: name === "listMyPendingMemberships" ? { memberships: [] } : {} });`
};

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

/** 偽の SDK を返し、ローカル以外への通信は止める */
async function newContext(browser, width, session) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  await context.route(/^https?:\/\//, (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    const m = url.match(/^https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/(firebase-[a-z]+\.js)$/);
    if (m && FAKE_SDK[m[1]]) return route.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_SDK[m[1]] });
    return route.abort();
  });
  await context.addInitScript((s) => {
    window.__fakeUser = s ? { ...s.user, getIdTokenResult: async () => ({ claims: {} }) } : null;
    window.__fakeDb = s ? s.db : {};
  }, session);
  return context;
}

const visible = (page, sel) => page.locator(sel).evaluate(el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)).catch(() => false);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function openHelpFromMenu(page) {
  await page.click("#btnHeaderMenu");
  await page.click("#menuHelp");
  await page.locator("#manualView:not([hidden]) .manual-body h1").waitFor();
}

test("ヘルプ: メニューの項目とハッシュの処理は、他の画面へ移るときにヘルプを閉じる", () => {
  const main = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");
  for (const k of ["onOpenHistory", "onOpenSettings", "onOpenApplications", "onOpenPreregistrations", "onRegisterFacility", "onSignOut"]) {
    assert.match(main, new RegExp(`${k}: \\(\\) => \\{ leaveHelp\\(\\);`), k);
  }
  assert.match(main, /onSwitchFacility: async \(\) => \{\s*leaveHelp\(\);/);
  const view = fs.readFileSync(path.join(ROOT, "src/ui/manual-view.js"), "utf8");
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(view), "マニュアルの表示は HTML として解釈しない");
});

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`ヘルプ(ログイン前): メニューから目次・全ページ・リンク・戻る・#help の URL。スマートフォン/PC: ${name}`, async (t) => {
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
        assert.equal(await page.locator(".manual-body h1").innerText(), MANUAL_PAGES[0].title);
        assert.equal(await page.getByText("ログインが必要です", { exact: true }).isVisible(), false, "ログイン画面は隠れる");
        assert.deepEqual(await page.locator(".manual-nav a").allInnerTexts(), MANUAL_PAGES.map(p => p.label));
        assert.deepEqual(await page.locator(".manual-back").allInnerTexts(), ["ログイン画面に戻る", "ログイン画面に戻る"]);
        assert.ok(await noOverflow(page), `${width}: 目次が横にはみ出さない`);

        // 目次から各ページへ(本文のリンク)。全ページが表示でき、横にはみ出さない
        for (const p of MANUAL_PAGES.slice(1)) {
          await page.goto(`${base}#help`);
          await page.locator(`.manual-body a[href="#help/${p.id}"]`).first().click();
          await page.waitForFunction((title) => document.querySelector(".manual-body h1")?.textContent === title, p.title);
          assert.equal(new URL(page.url()).hash, `#help/${p.id}`);
          assert.equal(await page.locator(".manual-nav a[aria-current=page]").innerText(), p.label);
          assert.ok(await noOverflow(page), `${width}: ${p.id} が横にはみ出さない`);
          // 本文のリンク: ページ内は #help/…、外部は別タブ(noopener)。それ以外のリンクはない
          const hrefs = await page.locator(".manual-body a").evaluateAll(as => as.map(a => [a.getAttribute("href"), a.target, a.rel]));
          for (const [href, target, rel] of hrefs) {
            if (href.startsWith("#help")) assert.ok(MANUAL_PAGES.some(x => href === (x.id === "index" ? "#help" : `#help/${x.id}`)), href);
            else assert.deepEqual([/^https:\/\//.test(href), target, rel], [true, "_blank", "noopener noreferrer"], href);
          }
        }
        // ページ間のリンク(本文中の別ページへのリンク)・目次へ戻る・ブラウザの戻る
        await page.goto(`${base}#help/02-orderer`);
        await page.locator(".manual-body a[href='#help/01-first-time']").first().click();
        await page.waitForFunction(() => location.hash === "#help/01-first-time");
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

        // #help/… 付きの URL で開くと、ログイン前でもそのページを表示する
        const c2 = await newContext(browser, width, null);
        const p2 = await c2.newPage();
        await p2.goto(`${base}#help/04-admin`);
        await p2.waitForFunction((title) => document.querySelector("#manualView:not([hidden]) .manual-body h1")?.textContent === title, MANUAL_PAGES[4].title);
        await c2.close();
      }
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
        await page.locator("#iolOrderForm:not(.hidden) #notesInput").waitFor();
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
