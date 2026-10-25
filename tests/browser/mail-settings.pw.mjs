// 回帰テスト(ブラウザ): 施設設定の「注文メール」(注文控えメール ON/OFF・送信先1件・署名)と、ディーラーの「注文メールの宛名」。
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
<main class="main-content"></main>
<script type="module">
import { createFacilitySettings } from "/src/ui/facility-settings.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
window.__saves = []; window.__dealerWrites = [];
let mail = null;
let dealers = [{ id: "s1", name: "栗原医療機械店", sortOrder: 10, orderEmails: ["o@example.jp"], usageReportEmails: [] }];
const repository = {
  listOrderers: async () => [], listAdoptedIols: async () => [], listMembers: async () => [], getIolOrder: async () => null,
  listDealers: async () => dealers.map(d => ({ ...d })),
  getMailSettings: async () => (mail ? { ...mail } : null)
};
const settingsApi = {
  saveOrderers: async () => {}, saveAdoptedIols: async () => {}, saveIolOrder: async () => {}, deleteOrderer: async () => {}, deleteDealer: async () => {},
  saveDealers: async (fid, writes) => { window.__dealerWrites.push(writes); for (const w of writes) { const i = dealers.findIndex(d => d.id === w.id); dealers[i] = { id: w.id, ...w.data }; } },
  saveMailSettings: async (fid, data) => { window.__saves.push(data); mail = { ...data }; }
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

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`注文メールの設定: 控えは初期OFF、ONで送信先1件を入力して自動保存。署名・ディーラーの宛名も保存: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 1400 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      const saves = () => page.evaluate(() => window.__saves);
      const sec = page.locator('[data-section="mail"]');
      assert.deepEqual(await page.locator("[data-section]").evaluateAll(es => es.map(e => e.getAttribute("data-section"))).then(xs => xs.filter(x => ["orderers", "iols", "dealers", "mail"].includes(x))), ["orderers", "iols", "dealers", "mail"], "注文メールはディーラーの後");
      const chk = sec.locator('[data-f="copyEnabled"]'), email = sec.locator('[data-f="copyEmail"]'), sig = sec.locator('[data-f="signature"]');
      assert.equal(await chk.isChecked(), false, "初期はOFF");
      assert.equal(await email.isVisible(), false, "OFFのときは送信先を出さない");

      // ON: 送信先が入るまで保存しない
      await chk.check();
      assert.equal(await email.isVisible(), true);
      await page.waitForTimeout(200);
      assert.deepEqual(await saves(), []);
      assert.match(await sec.locator("[data-msg]").innerText(), /入力すると保存されます/);
      // 形式が誤っている → 保存しない(エラー表示・入力は残す)
      await email.fill("info@senju");
      await email.dispatchEvent("change");
      await page.waitForFunction(() => /形式が正しくありません/.test(document.querySelector('[data-section="mail"] [data-msg]').textContent));
      assert.deepEqual(await saves(), []);
      // 正しい送信先 → 保存
      await email.fill("Info@Senju-Eye-Clinic.jp");
      await email.dispatchEvent("change");
      await page.waitForFunction(() => window.__saves.length === 1);
      assert.deepEqual((await saves())[0], { copyEnabled: true, copyEmail: "info@senju-eye-clinic.jp", signature: "" });
      // 署名
      await sig.fill("〒100-0001 東京都千代田区1-1\nテスト眼科");
      await sig.dispatchEvent("change");
      await page.waitForFunction(() => window.__saves.length === 2);
      assert.equal((await saves())[1].signature, "〒100-0001 東京都千代田区1-1\nテスト眼科");
      // OFF: 送信先は残す(次にONにしたときに使う)
      await chk.uncheck();
      await page.waitForFunction(() => window.__saves.length === 3);
      assert.deepEqual((await saves())[2], { copyEnabled: false, copyEmail: "info@senju-eye-clinic.jp", signature: "〒100-0001 東京都千代田区1-1\nテスト眼科" });
      assert.equal(await email.isVisible(), false);
      // 開き直しても保存内容が表示される
      await page.evaluate(() => window.__reopen());
      assert.equal(await chk.isChecked(), false);
      assert.equal(await sig.inputValue(), "〒100-0001 東京都千代田区1-1\nテスト眼科");

      // ディーラーの「注文メールの宛名」(正式表記)
      const row = page.locator('[data-section="dealers"] .dealer-item').first();
      await row.locator('[data-act="edit"]').click();
      await row.locator('[data-f="mailName"]').fill("栗原医療器械店");
      await row.locator('[data-act="save-row"]').click();
      await page.waitForFunction(() => window.__dealerWrites.length === 1);
      const w = (await page.evaluate(() => window.__dealerWrites))[0][0];
      assert.deepEqual([w.data.name, w.data.mailName, w.data.orderEmails], ["栗原医療機械店", "栗原医療器械店", ["o@example.jp"]], "登録名は変えず、宛名だけを保存");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, "横スクロールなし");
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
