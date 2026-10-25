// 回帰テスト(ブラウザ): 施設設定「採用IOL」「担当医」の自動保存(保存ボタンなし)。  npm run test:browser
// 実際の styles.css と src/ui/facility-settings.js を最小のページに読み込み、localStorage を保存先とする偽のリポジトリ・保存APIで確認する
// (Firebase は使わない)。保存の遅延・失敗・同時実行の数を、ページ側で制御・記録する。
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
const KEY = "__settingsDb";
const load = () => JSON.parse(localStorage.getItem(KEY) || "null") || { orderers: [{ id: "d1", name: "山田", email: "y@example.jp", sortOrder: 10 }, { id: "d2", name: "佐藤", sortOrder: 20 }], adopted: [{ id: "alcon-cna0t0", catalogIolId: "alcon-cna0t0", enabled: true }], iolOrder: null, seq: 0 };
const store = (db) => localStorage.setItem(KEY, JSON.stringify(db));
window.__delay = 0; window.__fail = 0; window.__calls = []; window.__inflight = 0; window.__maxInflight = 0; window.__changed = 0;
const guarded = async (kind, fn) => {
  window.__inflight++; window.__maxInflight = Math.max(window.__maxInflight, window.__inflight);
  try {
    await new Promise(r => setTimeout(r, window.__delay));
    if (window.__fail > 0) { window.__fail--; window.__calls.push([kind, "failed"]); throw new Error("network"); }
    fn(); window.__calls.push([kind, "ok"]);
  } finally { window.__inflight--; }
};
const repository = {
  listOrderers: async () => load().orderers.slice().sort((a, b) => a.sortOrder - b.sortOrder).map(o => ({ ...o })),
  listAdoptedIols: async () => load().adopted.map(a => ({ ...a })),
  listDealers: async () => [], listMembers: async () => [],
  getIolOrder: async () => load().iolOrder
};
const settingsApi = {
  saveOrderers: (fid, writes) => guarded("orderers", () => { const db = load(); for (const w of writes) { const id = w.id || ("n" + (++db.seq)); const i = db.orderers.findIndex(o => o.id === id); const rec = { id, ...w.data }; if (i >= 0) db.orderers[i] = rec; else db.orderers.push(rec); } store(db); }),
  deleteOrderer: (fid, id) => guarded("delete", () => { const db = load(); db.orderers = db.orderers.filter(o => o.id !== id); store(db); }),
  saveAdoptedIols: (fid, writes) => guarded("adopted", () => { const db = load(); for (const w of writes) { const i = db.adopted.findIndex(a => a.id === w.id); const rec = { id: w.id, ...w.data }; if (i >= 0) db.adopted[i] = rec; else db.adopted.push(rec); } store(db); }),
  saveIolOrder: (fid, o) => guarded("iolOrder", () => { const db = load(); db.iolOrder = { makerOrder: o.makerOrder, modelOrder: o.modelOrder }; store(db); }),
  saveDealers: async () => {}
};
const s = createFacilitySettings({ mount: document.querySelector("main"), repository, settingsApi, masters: IOL_MODELS, onSaved: async () => { window.__changed++; }, onClose() {} });
await s.open({ id: "f1", name: "テスト施設" });
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
  test(`施設設定の自動保存(採用IOL・担当医): ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 1200 } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      const open = async () => { await page.goto(base); await page.waitForFunction(() => window.__ready); };
      const db = () => page.evaluate(() => JSON.parse(localStorage.getItem("__settingsDb") || "null"));
      const calls = () => page.evaluate(() => window.__calls.filter(c => c[1] === "ok").map(c => c[0]));
      const idle = () => page.waitForFunction(() => window.__inflight === 0);
      const iols = page.locator('[data-section="iols"]'), docs = page.locator('[data-section="orderers"]');
      await open();

      // 保存ボタンは廃止
      assert.equal(await page.locator('[data-section="iols"] [data-act="save"], [data-section="orderers"] [data-act="save"]').count(), 0);
      assert.ok(!(await page.locator("#facilitySettings").innerText()).includes("担当医を保存"));
      assert.ok(!(await page.locator("#facilitySettings").innerText()).includes("採用IOLを保存"));

      // ---- 採用IOL: チェックで自動保存(成功の通知は出さない) ----
      await iols.locator('details[data-maker="J&J"] summary').click();
      await iols.locator('input[value="jj-dib00v"]').check();
      await page.waitForFunction(() => window.__calls.some(c => c[0] === "adopted" && c[1] === "ok"));
      await idle();
      assert.deepEqual((await db()).adopted.filter(a => a.enabled).map(a => a.id).sort(), ["alcon-cna0t0", "jj-dib00v"]);
      assert.equal(await iols.locator("[data-msg]").innerText(), "", "成功の通知なし");
      assert.equal(await iols.locator('[data-act="retry-autosave"]').count(), 0);
      await iols.locator('input[value="alcon-cna0t0"]').evaluate(c => { c.checked = true; });   // 他のメーカーを開かずに確認
      // メーカーの並び替え(↑↓)・メーカー内のIOLの並び替えで自動保存
      await iols.locator('details[data-maker="ALCON"] [data-act="maker-up"]').click();
      await page.waitForFunction(() => window.__calls.some(c => c[0] === "iolOrder"));
      await idle();
      const mo = (await db()).iolOrder.makerOrder;
      assert.equal(mo[0], "ALCON", "メーカーの順番が保存された: " + mo.join(","));
      const before = (await db()).iolOrder.modelOrder.slice();
      await iols.locator('details[data-maker="J&J"]').evaluate(d => { d.open = true; });
      await iols.locator('details[data-maker="J&J"] .iol-model-row').nth(1).locator('[data-act="model-up"]').click();
      await page.waitForFunction((b) => JSON.stringify(JSON.parse(localStorage.getItem("__settingsDb")).iolOrder.modelOrder) !== b, JSON.stringify(before));
      await idle();
      const afterModels = (await db()).iolOrder.modelOrder;
      assert.notDeepEqual(afterModels, before, "メーカー内のIOLの並び替えが保存された");
      assert.ok(afterModels.indexOf("jj-diwxxx-toric") < afterModels.indexOf("jj-dib00v"), "DIWxxx が DIB00V の前になった");

      // リフレッシュしても保持される(別の端末=別の読み込みでも同じ設定)
      await open();
      assert.deepEqual((await db()).adopted.filter(a => a.enabled).map(a => a.id).sort(), ["alcon-cna0t0", "jj-dib00v"]);
      assert.equal(await iols.locator('details[data-maker="ALCON"]').evaluate(d => d.previousElementSibling === null), true, "メーカーの並びが復元される");

      // 保存中の連続操作: 保存は同時に走らず(最大1)、最終状態が正しく保存される
      await page.evaluate(() => { window.__delay = 150; window.__calls = []; window.__maxInflight = 0; });
      await iols.locator('details[data-maker="HOYA"] summary').click();
      for (const id of ["hoya-xy1", "hoya-py-60ad"]) await iols.locator(`input[value="${id}"]`).check();
      await iols.locator('input[value="hoya-xy1"]').uncheck();
      await iols.locator('input[value="hoya-xy1"]').check();
      await iols.locator('input[value="hoya-py-60ad"]').uncheck();
      await page.waitForFunction(() => window.__inflight === 0 && window.__calls.length > 0);
      await page.waitForTimeout(600); await idle();
      assert.equal(await page.evaluate(() => window.__maxInflight), 1, "保存は同時に1つだけ");
      assert.deepEqual((await db()).adopted.filter(a => a.enabled).map(a => a.id).sort(), ["alcon-cna0t0", "hoya-xy1", "jj-dib00v"], "最終状態が保存される");
      await page.evaluate(() => { window.__delay = 0; });

      // 保存失敗: エラー+再試行。変更は画面に残り、保存されていないことが分かる。再試行で保存される
      await page.evaluate(() => { window.__fail = 1; });
      await iols.locator('input[value="hoya-py-60ad"]').check();
      await iols.locator('[data-act="retry-autosave"]').waitFor();
      assert.match(await iols.locator("[data-msg]").innerText(), /保存できませんでした.*保存されていません/);
      assert.equal(await iols.locator('input[value="hoya-py-60ad"]').isChecked(), true, "画面の変更は消えない");
      assert.equal((await db()).adopted.some(a => a.id === "hoya-py-60ad" && a.enabled), false, "保存されていない");
      page.once("dialog", d => d.dismiss());   // 失敗したまま閉じようとすると確認される
      await page.locator("#btnSettingsClose").click();
      assert.equal(await page.locator("#facilitySettings").isVisible(), true, "未保存のまま閉じない");
      await iols.locator('[data-act="retry-autosave"]').click();
      await page.waitForFunction(() => (JSON.parse(localStorage.getItem("__settingsDb")).adopted || []).some(a => a.id === "hoya-py-60ad" && a.enabled));
      await iols.locator('[data-act="retry-autosave"]').waitFor({ state: "detached" });
      assert.equal(await iols.locator("[data-msg]").innerText(), "", "成功後にエラーは消える");

      // ---- 担当医 ----
      // 追加: 入力途中は保存されない。行の「保存」で確定した時点で保存される(1回)。新しい行にも ID が付く
      await page.evaluate(() => { window.__calls = []; });
      await docs.locator('[data-act="add"]').click();
      await docs.locator(".orderer-item.is-editing [data-f=name]").fill("田中");
      await page.waitForTimeout(400);
      assert.deepEqual(await calls(), [], "入力途中は保存しない");
      assert.equal((await db()).orderers.length, 2);
      await docs.locator(".orderer-item.is-editing [data-act=save-row]").click();
      await page.waitForFunction(() => (JSON.parse(localStorage.getItem("__settingsDb")).orderers || []).length === 3);
      await idle();
      assert.deepEqual((await calls()), ["orderers"]);
      assert.deepEqual((await db()).orderers.map(o => o.name).sort(), ["佐藤", "山田", "田中"]);
      assert.notEqual(await docs.locator(".orderer-item").nth(2).getAttribute("data-id"), "", "追加した担当医にIDが付く");
      // 追加直後の並び替えで、重複して追加されない
      await docs.locator(".orderer-item").nth(2).locator('[data-act="up"]').click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("__settingsDb")).orderers.find(o => o.name === "田中").sortOrder < JSON.parse(localStorage.getItem("__settingsDb")).orderers.find(o => o.name === "佐藤").sortOrder);
      await idle();
      assert.equal((await db()).orderers.length, 3, "重複して作られない");
      assert.deepEqual((await db()).orderers.sort((a, b) => a.sortOrder - b.sortOrder).map(o => o.name), ["山田", "田中", "佐藤"], "並び替えが保存される");
      // 設定変更(名前・メール): 編集中は保存せず、確定で保存
      await docs.locator(".orderer-item").first().locator('[data-act="edit"]').click();
      await docs.locator(".orderer-item").first().locator("[data-f=name]").fill("山田太郎");
      await page.waitForTimeout(300);
      assert.equal((await db()).orderers.find(o => o.id === "d1").name, "山田", "編集中は保存しない");
      await docs.locator(".orderer-item").first().locator("[data-act=save-row]").click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("__settingsDb")).orderers.find(o => o.id === "d1").name === "山田太郎");
      await idle();
      // 削除: 保存と直列。削除した担当医が書き戻されない
      await page.evaluate(() => { window.__delay = 100; });
      await docs.locator(".orderer-item").nth(1).locator('[data-act="up"]').click();
      page.once("dialog", d => d.accept());
      await docs.locator(".orderer-item").last().locator('[data-act="delete"]').click();
      await page.waitForTimeout(700); await idle();
      await page.evaluate(() => { window.__delay = 0; });
      assert.deepEqual((await db()).orderers.map(o => o.name).sort(), ["山田太郎", "田中"], "削除した担当医は復活しない");
      assert.equal(await page.evaluate(() => window.__maxInflight), 1);

      // リフレッシュしても保持
      await open();
      assert.deepEqual(await docs.locator('[data-v="name"]').allInnerTexts(), (await db()).orderers.sort((a, b) => a.sortOrder - b.sortOrder).map(o => o.name));

      // 担当医の保存失敗: エラー+再試行(確定した変更は画面に残る)
      await page.evaluate(() => { window.__fail = 1; });
      await docs.locator(".orderer-item").last().locator('[data-act="up"]').click();
      await docs.locator('[data-act="retry-autosave"]').waitFor();
      assert.match(await docs.locator("[data-msg]").innerText(), /保存できませんでした/);
      await docs.locator('[data-act="retry-autosave"]').click();
      await docs.locator('[data-act="retry-autosave"]').waitFor({ state: "detached" });
      assert.deepEqual((await db()).orderers.sort((a, b) => a.sortOrder - b.sortOrder).map(o => o.name), await docs.locator('[data-v="name"]').allInnerTexts(), "再試行で、画面の並びが保存される");

      // PC幅でも同じ(同じ保存内容が、別の読み込みで反映される)
      await page.setViewportSize({ width: 1100, height: 900 });
      await open();
      assert.deepEqual(await docs.locator('[data-v="name"]').allInnerTexts(), (await db()).orderers.sort((a, b) => a.sortOrder - b.sortOrder).map(o => o.name));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
      assert.deepEqual(errors, []);
      await context.close();
    } finally { await browser.close(); }
  });
}
