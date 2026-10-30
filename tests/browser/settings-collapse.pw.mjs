// 回帰テスト(ブラウザ): 施設設定の折りたたみ(担当医・利用者管理・採用IOL・ディーラー・注文メール・テーマカラー)。
// 見出しで独立して開閉・複数同時に開ける・初回はすべて開く・施設ごとに localStorage に保存して再読み込みで戻す・「追加」とⓘでは開閉しない。
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
const repository = {
  listOrderers: async () => [{ id: "o1", name: "山田", sortOrder: 10 }], listAdoptedIols: async () => [], getIolOrder: async () => null,
  listDealers: async () => [{ id: "d1", name: "A商会", sortOrder: 10, orderEmails: [] }], getMailSettings: async () => null, getHeaderTheme: async () => null,
  listMembers: async () => [{ uid: "me", role: "admin", displayName: "自分" }], listPendingMembers: async () => [], getMemberOrder: async () => null
};
const settingsApi = {
  saveOrderers: async () => {}, saveAdoptedIols: async () => {}, saveIolOrder: async () => {}, deleteOrderer: async () => {}, deleteDealer: async () => {},
  saveDealers: async () => {}, saveMailSettings: async () => {}, saveHeaderTheme: async () => {}, resetHeaderTheme: async () => {}, saveMemberOrder: async () => {}
};
const inviteApi = { removeMember: async () => {}, addMember: async () => ({}), cancelPendingMember: async () => {}, changeMemberRole: async () => {} };
const s = createFacilitySettings({ mount: document.querySelector("main"), repository, settingsApi, inviteApi, masters: IOL_MODELS,
  currentUser: { uid: "me", displayName: "自分" }, actorRole: "admin", onSaved: async () => {}, onClose() {} });
const fid = new URLSearchParams(location.search).get("f") || "f1";
await s.open({ id: fid, name: "テスト施設" });
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

const KEYS = ["orderers", "members", "iols", "dealers", "mail", "theme"];
const state = (page) => page.evaluate((keys) => keys.map(k => { const s = document.querySelector(`[data-section="${k}"]`); return s.classList.contains("is-collapsed") ? "closed" : "open"; }), KEYS);
const sec = (page, k) => page.locator(`[data-section="${k}"]`);

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`施設設定の折りたたみ: 初回はすべて開く・見出しで独立して開閉・施設ごとに保存して再読み込みで戻す・「追加」とⓘでは開閉しない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const context = await browser.newContext({ viewport: { width, height: 1400 } });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        page.on("dialog", d => d.dismiss());
        await page.goto(base);
        await page.waitForFunction(() => window.__ready);
        // 初回: 6セクションすべて開く。見出しの右に開閉の矢印
        assert.deepEqual(await state(page), ["open", "open", "open", "open", "open", "open"]);
        for (const k of KEYS) assert.equal(await sec(page, k).locator(".settings-collapse-btn").getAttribute("aria-expanded"), "true", k);
        // 開閉は見出しの文字(独立した矢印はない)。見出しの中に ▲(開いている)/ ▼(閉じている)
        const iolBtn = sec(page, "iols").locator(".settings-heading h3 > .settings-collapse-btn");
        assert.equal(await iolBtn.innerText(), "採用IOL");
        assert.equal(await page.locator(".settings-heading svg").count(), 0, "見出しに矢印のアイコンはない");
        assert.equal(await iolBtn.evaluate(b => getComputedStyle(b, "::after").content), '"▲"');
        await iolBtn.click();
        assert.equal(await iolBtn.getAttribute("aria-expanded"), "false");
        assert.equal(await iolBtn.evaluate(b => getComputedStyle(b, "::after").content), '"▼"');
        await iolBtn.click();
        assert.equal(await iolBtn.getAttribute("aria-expanded"), "true");

        // 見出しのタップで閉じる(中身は隠れる)。他のセクションは開いたまま(複数同時に開ける)
        await sec(page, "dealers").locator(".settings-heading h3").click();
        assert.deepEqual(await state(page), ["open", "open", "open", "closed", "open", "open"]);
        assert.equal(await sec(page, "dealers").locator("[data-list]").isHidden(), true);
        assert.equal(await sec(page, "dealers").locator('[data-act="add"]').isHidden(), true, "閉じたら「追加」も隠す");
        assert.equal(await sec(page, "dealers").locator(".settings-collapse-btn").getAttribute("aria-expanded"), "false");
        // 矢印のボタンでも開閉できる
        await sec(page, "mail").locator(".settings-collapse-btn").click();
        assert.deepEqual(await state(page), ["open", "open", "open", "closed", "closed", "open"]);
        // 「追加」とⓘの操作では開閉しない
        const rows = await sec(page, "orderers").locator("[data-list] > *").count();
        await sec(page, "orderers").locator('[data-act="add"]').click();
        assert.equal(await sec(page, "orderers").locator("[data-list] > *").count(), rows + 1, "追加の行ができる");
        await sec(page, "theme").locator(".info-tip-btn").click();
        assert.deepEqual(await state(page), ["open", "open", "open", "closed", "closed", "open"]);
        // 開き直せる
        await sec(page, "dealers").locator(".settings-heading h3").click();
        assert.deepEqual(await state(page), ["open", "open", "open", "open", "closed", "open"]);

        // 施設ごとに保存し、再読み込みで戻す。別の施設は初回(すべて開く)
        assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("iol_settings_collapsed:f1"))), ["mail"]);
        await page.reload();
        await page.waitForFunction(() => window.__ready);
        assert.deepEqual(await state(page), ["open", "open", "open", "open", "closed", "open"]);
        await page.goto(base + "?f=f2");
        await page.waitForFunction(() => window.__ready);
        assert.deepEqual(await state(page), ["open", "open", "open", "open", "open", "open"]);

        // スマートフォン幅でも見出し・矢印・「追加」が1行に収まり、はみ出さない
        const heading = await sec(page, "orderers").locator(".settings-heading").evaluate(h => { const r = h.getBoundingClientRect(), b = h.querySelector(".settings-collapse-btn").getBoundingClientRect(), a = h.querySelector('[data-act="add"]').getBoundingClientRect(); return { oneLine: Math.abs((b.top + b.bottom) / 2 - (a.top + a.bottom) / 2) < 4, inside: a.right <= r.right + 0.5 }; });
        assert.deepEqual(heading, { oneLine: true, inside: true }, `${width}: 見出しの行`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
        assert.deepEqual(errors, []);
        await context.close();
      }
    } finally { await browser.close(); }
  });
}
