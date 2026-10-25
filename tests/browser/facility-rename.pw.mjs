// 回帰テスト(ブラウザ): 施設設定の施設名の変更(鉛筆アイコン)。重複候補は確認、変更後はヘッダー側へ通知。  npm run test:browser
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
window.__calls = []; window.__renamed = []; window.__next = { status: "renamed" };
const repository = { listOrderers: async () => [], listAdoptedIols: async () => [], listDealers: async () => [], listMembers: async () => [] };
const settingsApi = { saveOrderers: async () => {}, saveAdoptedIols: async () => {}, saveDealers: async () => {}, deleteDealer: async () => {}, deleteOrderer: async () => {} };
const inviteApi = { createInvite: async () => ({}), ${withRename ? `renameFacility: async (a) => { window.__calls.push(a); if (window.__fail) { const e = new Error("権限がありません"); e.code = "functions/permission-denied"; throw e; } const n = window.__next; return n.status === "renamed" ? { status: "renamed", name: a.name } : n; }` : ""} };
const s = createFacilitySettings({ mount: document.querySelector("main"), repository, settingsApi, masters: IOL_MODELS, inviteApi, onSaved: async () => {}, onClose() {}, onRenamed: (id, n) => window.__renamed.push([id, n]) });
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
  test(`施設名の変更: 鉛筆で編集・重複候補は確認してから変更・変更を通知: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const pg = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errors = [];
      pg.on("pageerror", e => errors.push(String(e)));
      await pg.goto(base);
      await pg.waitForFunction(() => window.__ready);
      const btn = pg.locator("#btnRenameFacility"), box = pg.locator(".facility-rename"), input = box.locator("input");
      assert.equal(await btn.count(), 1);
      assert.equal(await box.isHidden(), true);
      await btn.click();
      assert.equal(await input.inputValue(), "テスト施設");

      // 空欄は送らない
      await input.fill("  ");
      await box.getByText("変更する", { exact: true }).click();
      assert.deepEqual(await pg.evaluate(() => window.__calls), []);

      // 重複候補: 変更せず、候補名を示し、「別の施設として変更する」で確認して変更
      await pg.evaluate(() => { window.__next = { status: "duplicate-candidate", exact: false, similarCount: 1, candidates: ["似た施設クリニック"] }; });
      await input.fill("新しい 施設名");
      await box.getByText("変更する", { exact: true }).click();
      await box.getByText("別の施設として変更する").waitFor();
      assert.match(await box.innerText(), /似た施設クリニック/);
      assert.deepEqual(await pg.evaluate(() => window.__calls), [{ facilityId: "f1", name: "新しい 施設名", confirmDuplicate: false }]);
      assert.deepEqual(await pg.evaluate(() => window.__renamed), []);
      await pg.evaluate(() => { window.__next = { status: "renamed" }; });
      await box.getByText("別の施設として変更する").click();
      await box.waitFor({ state: "hidden" });
      assert.deepEqual((await pg.evaluate(() => window.__calls))[1], { facilityId: "f1", name: "新しい 施設名", confirmDuplicate: true });
      assert.equal(await pg.locator(".settings-facility").innerText(), "新しい 施設名");
      assert.deepEqual(await pg.evaluate(() => window.__renamed), [["f1", "新しい 施設名"]]);

      // 失敗(権限など)は、メッセージを出して画面に残る
      await pg.evaluate(() => { window.__fail = true; });
      await btn.click();
      await input.fill("失敗する名前");
      await box.getByText("変更する", { exact: true }).click();
      await box.getByText("権限がありません").waitFor();
      assert.equal(await pg.locator(".settings-facility").innerText(), "新しい 施設名");
      // 連続する空白は1つにまとめるが、文字(sなど)は変えない
      await input.fill("  Sunrise   Eye  Clinic ");
      await box.getByText("変更する", { exact: true }).click();
      await pg.waitForFunction(() => window.__calls.at(-1).name === "Sunrise Eye Clinic");
      // キャンセル
      await box.getByText("キャンセル").click();
      assert.equal(await box.isHidden(), true);
      assert.equal(await pg.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);

      // 変更用の関数がなければ鉛筆は出ない
      await pg.goto(base + "norename");
      await pg.waitForFunction(() => window.__ready);
      assert.equal(await pg.locator("#btnRenameFacility").count(), 0);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
