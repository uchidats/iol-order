// 回帰テスト(ブラウザ): IOL シール写真の一覧・拡大。実際の styles.css と src/ui/sticker-photo-viewer.js を最小のページに読み込み、偽の読み出しで表示する
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
<div class="header-inner"></div><main class="main-content"></main>
<script type="module">
import { createStickerPhotoViewer } from "/src/ui/sticker-photo-viewer.js";
const NOW = Date.parse("2026-11-05T01:00:00Z");
const pixel = async () => { const c = document.createElement("canvas"); c.width = 30; c.height = 40; c.getContext("2d").fillRect(0, 0, 30, 40); return new Promise(r => c.toBlob(r, "image/jpeg")); };
const p = (id, sessionId, seq, takenAt, over = {}) => ({ photoId: id, sessionId, seq, takenAt, lastSurgeryDate: null, width: 30, height: 40, blurWarned: false, ...over });
const DATA = {
  fA: [p("a3", "s1", 3, "2026-11-04T01:35:00Z", { lastSurgeryDate: "2026-11-04" }), p("a2", "s1", 2, "2026-11-04T01:33:00Z", { lastSurgeryDate: "2026-11-04", blurWarned: true }), p("a1", "s1", 1, "2026-11-04T01:32:00Z", { lastSurgeryDate: "2026-11-04" }), p("a0", "s0", 1, "2026-11-03T05:05:00Z")],
  fB: [p("b1", "s9", 1, "2026-11-04T02:00:00Z")]
};
window.__calls = []; window.__reads = []; window.__closed = 0; window.__deleted = [];
window.__source = (kind) => ({
  loadFacilities: async () => (kind === "dealer" ? [{ facilityId: "fA", name: "A眼科" }, { facilityId: "fB", name: "B眼科" }] : kind === "none" ? [] : [{ facilityId: "fA", name: "A眼科" }]),
  listPage: async (id, q) => {
    window.__calls.push([id, q]);
    if (window.__failList) throw Object.assign(new Error("x"), { code: "functions/permission-denied", message: "この施設の写真を操作する権限がありません" });
    const list = DATA[id].filter(x => !window.__deleted.includes(x.photoId));
    const page = window.__page;
    if (!page) return { photos: list, nextCursor: null };
    const start = q.cursor ? list.findIndex(x => x.photoId === q.cursor) + 1 : 0;
    const part = list.slice(start, start + page);
    return { photos: part, nextCursor: start + page < list.length ? part[part.length - 1].photoId : null };
  },
  readImage: async (a) => { window.__reads.push(a); if (a.photoId === window.__hidden) return null; return pixel(); },
  deletePhoto: kind === "manager" ? async (id, photoId) => { if (window.__failDelete) throw Object.assign(new Error("x"), { code: "functions/permission-denied", message: "この施設の管理者・副管理者のみ操作できます" }); window.__deleted.push(photoId); return { ok: true }; } : null
});
window.__viewer = createStickerPhotoViewer({ mount: document.querySelector("main"), title: "IOLシール写真", info: "説明", backLabel: "注文画面に戻る", now: () => NOW,
  onClose: () => { window.__closed += 1; }, confirm: async () => window.__confirm !== false });
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
  base = `http://127.0.0.1:${server.address().port}/`;
});
test.after(() => server.close());

async function launch(type, name) {
  for (const opts of name === "chromium" ? [{}, { channel: "msedge" }, { channel: "chrome" }] : [{}]) {
    try { return await type.launch(opts); } catch { /* 次の候補へ */ }
  }
  return null;
}
async function openPage(browser, kind, width = 390, before = "") {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(base);
  await page.waitForFunction(() => window.__ready === true);
  if (before) await page.evaluate(before);
  await page.evaluate((k) => window.__viewer.open(window.__source(k)), kind);
  return page;
}
const texts = (page, sel) => page.locator(sel).allInnerTexts();

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`シール写真: 送信日・セッションごとの一覧とサムネイル: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      const page = await openPage(browser, "member");
      await page.waitForFunction(() => document.querySelectorAll(".sticker-thumb-img[src^='blob:']").length === 4);
      assert.deepEqual(await texts(page, ".sticker-day-head"), ["11/4(水)", "11/3(火)"]);
      assert.deepEqual(await texts(page, ".sticker-session-head"), ["10:32〜10:35 3枚 ・ 11/4の手術分まで", "14:05 1枚"]);
      assert.deepEqual(await texts(page, '[data-session="s1"] .sticker-thumb-no'), ["1", "2", "3"], "セッションの中は送信順");
      assert.equal(await page.locator(".sticker-thumb-warn").count(), 1, "ピンぼけの印");
      assert.equal(await page.locator(".sticker-facility-name").count(), 0, "施設が1つなら施設名を出さない");
      assert.equal(await page.locator('[data-facility]').count(), 0);
      const reads = await page.evaluate(() => window.__reads);
      assert.ok(reads.every(r => r.size === "thumb"), "一覧は原本を読まない");
      assert.deepEqual((await page.evaluate(() => JSON.parse(JSON.stringify(window.__calls))))[0], ["fA", { from: "2026-10-09", to: "2026-11-05" }], "既定は直近4週");
      await page.click('[data-act="back"]');
      assert.deepEqual(await page.evaluate(() => [window.__closed, document.getElementById("stickerPhotoViewer").hidden]), [1, true]);
      await page.close();
    } finally { await browser.close(); }
  });

  test(`シール写真: 拡大表示は同じセッションの中を移動し、回転でき、ダウンロードの操作がない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      const page = await openPage(browser, "member");
      await page.click('[data-photo="a2"]');
      await page.waitForFunction(() => document.querySelector(".sticker-lightbox-img")?.src.startsWith("blob:"));
      assert.equal(await page.innerText(".sticker-lightbox-position"), "2 / 3");
      assert.match(await page.innerText(".sticker-lightbox-meta"), /11\/4\(水\) 10:33 ・ ピンぼけの疑いで送信/);
      await page.click('[data-act="next"]');
      await page.waitForFunction(() => document.querySelector(".sticker-lightbox-position").textContent === "3 / 3");
      assert.equal(await page.isDisabled('[data-act="next"]'), true, "セッションの外へは移動しない");
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction(() => document.querySelector(".sticker-lightbox-position").textContent === "2 / 3");
      await page.click('[data-act="rotate"]');
      assert.equal(await page.locator(".sticker-lightbox-img").evaluate(i => i.style.transform), "rotate(90deg)");
      assert.ok((await page.evaluate(() => window.__reads)).some(r => r.size === "full" && r.photoId === "a2"), "拡大は原本");
      assert.equal(await page.locator('.sticker-lightbox a, .sticker-lightbox [data-act="delete"], .sticker-lightbox [download]').count(), 0, "閲覧者には削除・ダウンロードがない");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".sticker-lightbox").count(), 0);
      await page.close();
    } finally { await browser.close(); }
  });
}

test("シール写真: 管理者は削除でき、確認で取り消せる。失敗は理由を表示し、一覧から消さない", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await openPage(browser, "manager");
    await page.click('[data-photo="a1"]');
    await page.waitForSelector('[data-act="delete"]');
    await page.evaluate(() => { window.__confirm = false; });
    await page.click('[data-act="delete"]');
    assert.deepEqual(await page.evaluate(() => window.__deleted), [], "取り消せる");
    await page.evaluate(() => { window.__confirm = true; window.__failDelete = true; });
    await page.click('[data-act="delete"]');
    await page.waitForFunction(() => document.querySelector(".sticker-lightbox [role=status]").textContent.includes("管理者"));
    assert.equal(await page.locator('[data-session="s1"] .sticker-thumb').count(), 3);
    await page.evaluate(() => { window.__failDelete = false; });
    await page.click('[data-act="delete"]');
    await page.waitForFunction(() => document.querySelector(".sticker-lightbox-position")?.textContent === "1 / 2");
    assert.equal(await page.locator('[data-session="s1"] .sticker-thumb').count(), 2);
    assert.deepEqual(await page.evaluate(() => window.__deleted), ["a1"]);
    await page.close();
  } finally { await browser.close(); }
});

test("シール写真: ディーラーは施設を選べ、2施設以上なら施設名を出す。選択と期間で読み直し、削除はない", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await openPage(browser, "dealer");
    await page.waitForFunction(() => document.querySelectorAll(".sticker-thumb").length === 5);
    assert.deepEqual([...new Set(await texts(page, ".sticker-facility-name"))].sort(), ["A眼科", "B眼科"]);
    await page.click('[data-photo="b1"]');
    await page.waitForSelector(".sticker-lightbox");
    assert.equal(await page.locator('[data-act="delete"]').count(), 0);
    await page.keyboard.press("Escape");
    await page.uncheck('[data-facility="fA"]');
    await page.fill('[data-f="from"]', "2026-11-01");
    await page.click('[data-act="search"]');
    await page.waitForFunction(() => document.querySelectorAll(".sticker-thumb").length === 1);
    assert.equal(await page.locator(".sticker-facility-name").count(), 0);
    const last = (await page.evaluate(() => JSON.parse(JSON.stringify(window.__calls)))).at(-1);
    assert.deepEqual(last, ["fB", { from: "2026-11-01", to: "2026-11-05" }]);
    await page.close();
  } finally { await browser.close(); }
});

test("シール写真: もっと見るで続きを足す。見えない画像・権限エラー・共有なしの案内", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    let page = await openPage(browser, "member", 390, "window.__page = 2; window.__hidden = 'a3';");
    await page.waitForSelector('[data-act="more"]');
    assert.equal(await page.locator(".sticker-thumb").count(), 2);
    await page.waitForFunction(() => document.querySelector('[data-photo="a3"]').classList.contains("is-missing"));
    await page.click('[data-act="more"]');
    await page.waitForFunction(() => document.querySelectorAll(".sticker-thumb").length === 4);
    assert.equal(await page.locator('[data-act="more"]').count(), 0);
    assert.equal((await page.evaluate(() => window.__calls)).at(-1)[1].cursor, "a2");
    await page.close();
    page = await openPage(browser, "member", 390, "window.__failList = true;");
    await page.waitForFunction(() => document.querySelector("#stickerPhotoViewer [role=status]").textContent.includes("権限"));
    assert.equal(await page.locator(".sticker-thumb").count(), 0);
    await page.close();
    page = await openPage(browser, "none");
    await page.waitForFunction(() => document.querySelector("#stickerPhotoViewer [role=status]").textContent === "共有されている写真はありません。");
    await page.close();
  } finally { await browser.close(); }
});

test("シール写真: 閉じると Blob の URL を解放し、閉じた後に届いた結果を表示しない。狭い画面で横にはみ出さない", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await openPage(browser, "member", 320);
    await page.waitForFunction(() => document.querySelectorAll(".sticker-thumb-img[src^='blob:']").length === 4);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const src = await page.locator(".sticker-thumb-img").first().getAttribute("src");
    await page.evaluate(() => window.__viewer.close());
    const alive = await page.evaluate((u) => fetch(u).then(() => true, () => false), src);
    assert.equal(alive, false, "解放した URL は読めない");
    await page.evaluate(() => { const v = window.__viewer; const s = window.__source("member"); const list = s.listPage; s.listPage = async (...a) => { const r = await list(...a); v.close(); return r; }; return v.open(s); });
    assert.equal(await page.locator(".sticker-thumb").count(), 0);
    await page.close();
  } finally { await browser.close(); }
});

test("シール写真: 医療機関は関連リンクの中に、利用できるときだけ出す(☰メニューには出さない)。ディーラーはメニューに、指定があるときだけ出す", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    let page = await browser.newPage();
    await page.goto(base);
    await page.waitForFunction(() => window.__ready === true);
    const facility = await page.evaluate(async () => {
      const { createHeaderMenu } = await import("/src/ui/header-menu.js");
      const { createRelatedLinksView } = await import("/src/ui/related-links.js");
      // ☰メニューには出さない(以前の指定を渡しても出ない)
      const menu = createHeaderMenu({});
      menu.update({ user: { email: "a@x.jp" }, facilityName: "A", canStickerPhotos: true, canSettings: true });
      const inMenu = document.getElementById("menuStickerPhotos") !== null;
      // 関連リンク
      const root = document.createElement("details");
      root.className = "ref-links-accordion"; root.hidden = true;
      root.innerHTML = '<summary class="ref-links-summary">関連リンク</summary><ul class="ref-links-list"></ul>';
      document.body.append(root);
      const names = () => [...root.querySelectorAll(".ref-links-list a")].map(a => a.textContent);
      const noStandard = ["std-tecnis", "std-alcon", "std-teleon", "std-santen", "std-escrs"].map(id => ({ id, enabled: false }));   // 標準のリンクを非表示にした施設
      const docs = [...noStandard, { id: "l1", name: "資料", url: "https://example.jp/a", enabled: true, sortOrder: 10 }];
      let opened = 0, resolve;
      const view = createRelatedLinksView(root);
      const out = {};
      // 読み込みの途中: 利用できると分かる前は何も出さない
      const loading = view.load("fA", { listRelatedLinks: () => new Promise(r => { resolve = r; }) });
      out.beforeAnswer = [root.hidden, names()];
      view.setStickerPhotos(() => { opened += 1; });
      out.stickerOnly = [root.hidden, names()];   // 登録したリンクがなくても出る
      resolve(docs); await loading;
      out.both = names();                         // 登録したリンクの後ろ
      const a = root.querySelector("#refLinkStickerPhotos");
      const other = root.querySelector(".ref-links-list a");
      out.sameLook = [a.className === other.className, a.querySelector("svg.ext-icon") !== null, a.querySelector("svg").outerHTML === other.querySelector("svg").outerHTML,
        getComputedStyle(a).fontSize === getComputedStyle(other).fontSize, a.target === ""];
      const hash = location.hash;
      a.click();
      out.clicked = [opened, location.hash === hash];
      view.saved("fA", noStandard);
      out.afterSaveEmpty = [root.hidden, names()];
      view.setStickerPhotos(null);                // 対象外・停止
      out.off = [root.hidden, names()];
      view.setStickerPhotos(() => {});
      view.clear();                               // 施設を出る
      out.cleared = [root.hidden, names()];
      await view.load("fB", { listRelatedLinks: async () => docs });
      out.nextFacility = names();                 // 次の施設へ持ち越さない
      root.remove();
      return { inMenu, ...out };
    });
    assert.deepEqual(facility, { inMenu: false, beforeAnswer: [true, []], stickerOnly: [false, ["IOLシール写真"]], both: ["資料", "IOLシール写真"],
      sameLook: [true, true, true, true, true], clicked: [1, true], afterSaveEmpty: [false, ["IOLシール写真"]], off: [true, []], cleared: [true, []], nextFacility: ["資料"] });
    await page.close();
    page = await browser.newPage();
    await page.goto(base);
    await page.waitForFunction(() => window.__ready === true);
    const dealer = await page.evaluate(async () => {
      const { createDealerHeaderMenu } = await import("/src/dealer/dealer-header-menu.js");
      let opened = 0;
      const noop = () => {};
      const menu = createDealerHeaderMenu({ onSignOut: noop, onSwitchCompany: noop, onOpenSettings: noop, onOpenHelp: noop, onOpenStickerPhotos: () => { opened += 1; } });
      menu.update({ name: "担当", companyName: "X商事", canStickerPhotos: false });
      const hidden = document.getElementById("menuStickerPhotos") === null;
      menu.update({ name: "担当", companyName: "X商事", canStickerPhotos: true });
      document.getElementById("menuStickerPhotos").click();
      return { hidden, opened };
    });
    assert.deepEqual(dealer, { hidden: true, opened: 1 });
    await page.close();
  } finally { await browser.close(); }
});
