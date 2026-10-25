// 回帰テスト(ブラウザ): 施設設定の施設の削除(施設名の入力で確認・サーバーの拒否理由を表示)。  npm run test:browser
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const page = (withRename) => `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<main class="main-content"></main>
<script type="module">
import { createFacilitySettings } from "/src/ui/facility-settings.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
window.__calls = []; window.__deleted = []; window.__next = { status: "renamed" };
const repository = { listOrderers: async () => [], listAdoptedIols: async () => [], listDealers: async () => [], listMembers: async () => [] };
const settingsApi = { saveOrderers: async () => {}, saveAdoptedIols: async () => {}, saveDealers: async () => {}, deleteDealer: async () => {}, deleteOrderer: async () => {} };
const inviteApi = { createInvite: async () => ({}), ${withRename ? `deleteFacility: async (a) => { window.__calls.push(a); if (window.__fail) { const e = new Error(window.__fail); e.code = "functions/failed-precondition"; throw e; } return { status: "deleted" }; }` : ""} };
const s = createFacilitySettings({ mount: document.querySelector("main"), repository, settingsApi, masters: IOL_MODELS, inviteApi, onSaved: async () => {}, onClose() {}, onDeleted: (id) => window.__deleted.push(id) });
await s.open({ id: "f1", name: "テスト施設" });
window.__ready = true;
</script></body></html>`;

let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/" || url === "/norename") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(page(url === "/")); return; }
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
  test(`施設の削除: 施設名を入力するまで削除できない・サーバーの拒否理由を表示・成功で通知: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const pg = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errors = [];
      pg.on("pageerror", e => errors.push(String(e)));
      await pg.goto(base);
      await pg.waitForFunction(() => window.__ready);
      const more = pg.locator("#btnSettingsMore"), menuItem = pg.locator("#btnDeleteFacility"), box = pg.locator("#deleteFacilityDialog"), input = box.locator("input");
      const sec = box;
      const del = box.getByRole("button", { name: "この施設を削除する" });
      // 画面の最下部に削除の欄はない。見出し右端の「︙」→「施設を削除」(赤いゴミ箱)→ダイアログ
      assert.equal(await pg.locator('[data-section="delete"]').count(), 0);
      assert.equal(await box.isHidden(), true);
      assert.equal(await menuItem.isHidden(), true);
      const headBox = await pg.locator(".settings-head").boundingBox(), moreBox = await more.boundingBox();
      assert.ok(moreBox.x + moreBox.width > headBox.x + headBox.width - 40, "見出しの右端にある");
      assert.ok(moreBox.y < headBox.y + headBox.height + 1);
      await more.click();
      assert.equal(await menuItem.isVisible(), true);
      assert.equal(await menuItem.locator("svg").count(), 1);
      assert.equal(await menuItem.evaluate(e => getComputedStyle(e).color), "rgb(220, 38, 38)", "赤");
      assert.equal(await menuItem.innerText(), "施設を削除");
      await pg.keyboard.press("Escape");   // Escで閉じる
      assert.equal(await menuItem.isHidden(), true);
      await more.click();
      await pg.mouse.click(5, 600);       // 外側のクリックで閉じる
      assert.equal(await menuItem.isHidden(), true);
      await more.click();
      await menuItem.click();
      assert.equal(await box.isVisible(), true);
      assert.match(await box.innerText(), /注文履歴がある施設/);
      assert.equal(await menuItem.isHidden(), true, "メニューは閉じる");
      assert.equal(await del.isDisabled(), true);
      await input.fill("違う名前");
      assert.equal(await del.isDisabled(), true, "施設名が違えば押せない");
      await input.fill("テスト");
      assert.equal(await del.isDisabled(), true);
      await input.fill(" テスト施設 ");
      assert.equal(await del.isDisabled(), false);

      // サーバーが拒否(注文履歴・他の利用者)した場合は、理由を表示して画面に残る
      await pg.evaluate(() => { window.__fail = "注文履歴がある施設は削除できません"; });
      await del.click();
      await sec.getByText("注文履歴がある施設は削除できません", { exact: false }).last().waitFor();
      assert.deepEqual(await pg.evaluate(() => window.__calls), [{ facilityId: "f1", confirmName: " テスト施設 " }]);
      assert.deepEqual(await pg.evaluate(() => window.__deleted), []);
      assert.equal(await del.isDisabled(), false, "再試行できる");

      // 成功: 通知する(画面側で所属を取得し直す)
      await pg.evaluate(() => { window.__fail = null; });
      await del.click();
      await pg.waitForFunction(() => window.__deleted.length === 1);
      assert.deepEqual(await pg.evaluate(() => window.__deleted), ["f1"]);
      assert.equal(await box.isHidden(), true, "成功でダイアログは閉じる");

      // キャンセルで確認欄が閉じる
      await more.click(); await menuItem.click();
      assert.equal(await input.inputValue(), "", "開き直すと入力は空");
      await box.getByRole("button", { name: "キャンセル" }).click();
      assert.equal(await box.isHidden(), true);
      // PC幅でも同じ
      await pg.setViewportSize({ width: 1100, height: 900 });
      await more.click();
      assert.equal(await menuItem.isVisible(), true);
      const mb = await pg.locator(".more-menu").boundingBox();
      assert.ok(mb.x >= 0 && mb.x + mb.width <= 1100);
      await pg.keyboard.press("Escape");
      await pg.setViewportSize({ width: 390, height: 900 });
      assert.equal(await pg.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);

      // 削除用の関数がなければ、「︙」は出ない
      await pg.goto(base + "norename");
      await pg.waitForFunction(() => window.__ready);
      assert.equal(await pg.locator("#btnSettingsMore").count(), 0);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
