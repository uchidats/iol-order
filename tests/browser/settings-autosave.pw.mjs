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
const load = () => JSON.parse(localStorage.getItem(KEY) || "null") || { orderers: [{ id: "d1", name: "山田", email: "y@example.jp", sortOrder: 10 }, { id: "d2", name: "佐藤", sortOrder: 20 }], adopted: [{ id: "alcon-cna0t0", catalogIolId: "alcon-cna0t0", enabled: true }], iolOrder: null, seq: 0,
  dealers: [{ id: "s1", name: "A商会", sortOrder: 10, orderEmails: ["a@example.jp"], usageReportEmails: [] }, { id: "s2", name: "B医療", sortOrder: 20, orderEmails: [], usageReportEmails: ["r@example.jp"] }] };
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
  listDealers: async () => load().dealers.slice().sort((a, b) => a.sortOrder - b.sortOrder).map(d => ({ ...d })), listMembers: async () => [],
  getIolOrder: async () => load().iolOrder
};
const settingsApi = {
  saveOrderers: (fid, writes) => guarded("orderers", () => { const db = load(); for (const w of writes) { const id = w.id || ("n" + (++db.seq)); const i = db.orderers.findIndex(o => o.id === id); const rec = { id, ...w.data }; if (i >= 0) db.orderers[i] = rec; else db.orderers.push(rec); } store(db); }),
  deleteOrderer: (fid, id) => guarded("delete", () => { const db = load(); db.orderers = db.orderers.filter(o => o.id !== id); store(db); }),
  saveAdoptedIols: (fid, writes) => guarded("adopted", () => { const db = load(); for (const w of writes) { const i = db.adopted.findIndex(a => a.id === w.id); const rec = { id: w.id, ...w.data }; if (i >= 0) db.adopted[i] = rec; else db.adopted.push(rec); } store(db); }),
  saveIolOrder: (fid, o) => guarded("iolOrder", () => { const db = load(); db.iolOrder = { makerOrder: o.makerOrder, modelOrder: o.modelOrder }; store(db); }),
  saveDealers: (fid, writes) => guarded("dealers", () => { const db = load(); for (const w of writes) { const id = w.id || ("dn" + (++db.seq)); const i = db.dealers.findIndex(o => o.id === id); const rec = { id, ...w.data }; if (i >= 0) db.dealers[i] = rec; else db.dealers.push(rec); } store(db); }),
  deleteDealer: (fid, id) => guarded("deleteDealer", () => { const db = load(); db.dealers = db.dealers.filter(o => o.id !== id); store(db); })
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

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`施設設定のディーラーの自動保存(保存ボタンなし・スマホは↑のみ・先頭の↑は非表示): ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 1200 } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      const open = async () => { await page.goto(base); await page.waitForFunction(() => window.__ready); };
      const db = () => page.evaluate(() => JSON.parse(localStorage.getItem("__settingsDb") || "null"));
      const idle = () => page.waitForFunction(() => window.__inflight === 0);
      const sec = page.locator('[data-section="dealers"]');
      const rows = sec.locator(".dealer-item");
      const names = () => rows.locator('[data-v="name"]').allInnerTexts();
      await open();

      // 保存ボタンは廃止。「↑」のみ(「↓」はない)。先頭の行の「↑」は見えない
      assert.equal(await sec.locator('[data-act="save"]').count(), 0);
      assert.ok(!(await sec.innerText()).includes("ディーラーを保存"));
      assert.equal(await rows.nth(0).locator('[data-act="up"]').isHidden(), true, "先頭の↑は非表示");
      assert.equal(await rows.nth(1).locator('[data-act="up"]').isVisible(), true);
      assert.equal(await sec.locator('[data-act="down"]').count(), 0, "「↓」はない");
      const btnBoxes = await rows.nth(1).locator(".orderer-actions button").evaluateAll(bs => bs.filter(b => b.offsetParent).map(b => { const r = b.getBoundingClientRect(); return [r.left, r.right, r.top, r.bottom]; }));
      for (let i = 0; i < btnBoxes.length; i++) for (let j = i + 1; j < btnBoxes.length; j++) assert.ok(btnBoxes[i][1] <= btnBoxes[j][0] + 0.5 || btnBoxes[j][1] <= btnBoxes[i][0] + 0.5, "ボタンが重ならない");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);

      // 並び替え(↑): 自動保存。保存中の連続操作でも、最終状態が保存される
      await page.evaluate(() => { window.__delay = 120; window.__calls = []; window.__maxInflight = 0; });
      await rows.nth(1).locator('[data-act="up"]').click();                        // [B, A]
      assert.deepEqual(await names(), ["B医療", "A商会"]);
      assert.equal(await rows.nth(0).locator('[data-act="up"]').isHidden(), true, "移動後も、先頭の↑は非表示");
      assert.equal(await rows.nth(1).locator('[data-act="up"]').isVisible(), true);
      await rows.nth(1).locator('[data-act="up"]').click();                        // [A, B]
      await rows.nth(1).locator('[data-act="up"]').click();                        // [B, A]
      await page.waitForTimeout(700); await idle();
      assert.equal(await page.evaluate(() => window.__maxInflight), 1, "保存は同時に1つだけ");
      await page.evaluate(() => { window.__delay = 0; });
      assert.deepEqual((await db()).dealers.sort((a, b) => a.sortOrder - b.sortOrder).map(d => d.name), await names(), "最終状態が保存される");
      assert.deepEqual((await db()).dealers.find(d => d.id === "s1").orderEmails, ["a@example.jp"], "既存のメール設定は維持");

      // 追加: 入力途中は保存されない。行の「保存」で確定した時点で1回保存。IDが付き、続けて並び替えても重複しない
      await page.evaluate(() => { window.__calls = []; });
      await sec.locator('[data-act="add"]').click();
      await sec.locator(".dealer-item.is-editing [data-f=name]").fill("C商会");
      await sec.locator(".dealer-item.is-editing [data-f=orderEmails]").fill("c@example.jp");
      await page.waitForTimeout(450);
      assert.deepEqual(await page.evaluate(() => window.__calls), [], "入力途中は保存しない");
      assert.equal((await db()).dealers.length, 2);
      await sec.locator(".dealer-item.is-editing [data-act=save-row]").click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("__settingsDb")).dealers.length === 3);
      await idle();
      assert.deepEqual((await db()).dealers.find(d => d.name === "C商会").orderEmails, ["c@example.jp"]);
      assert.notEqual(await rows.nth(2).getAttribute("data-id"), "", "追加したディーラーにIDが付く");
      await rows.nth(2).locator('[data-act="up"]').click();
      await page.waitForFunction(() => { const d = JSON.parse(localStorage.getItem("__settingsDb")).dealers; return d.find(x => x.name === "C商会").sortOrder < d.find(x => x.name === "A商会").sortOrder; });
      await idle();
      assert.equal((await db()).dealers.length, 3, "重複して作られない");

      // 設定変更(メール): 編集中は保存されず、確定で保存
      await rows.nth(0).locator('[data-act="edit"]').click();
      await rows.nth(0).locator('[data-f="orderEmails"]').fill("b1@example.jp\nb2@example.jp");
      await page.waitForTimeout(350);
      assert.deepEqual((await db()).dealers.find(d => d.id === "s2").orderEmails, [], "編集中は保存しない");
      await rows.nth(0).locator("[data-act=save-row]").click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("__settingsDb")).dealers.find(d => d.id === "s2").orderEmails.length === 2);
      await idle();

      // 削除: 保存と直列。削除したディーラーは復活しない
      await page.evaluate(() => { window.__delay = 100; });
      await rows.nth(1).locator('[data-act="up"]').click();
      page.once("dialog", d => d.accept());
      await rows.last().locator('[data-act="delete"]').click();
      await page.waitForTimeout(700); await idle();
      await page.evaluate(() => { window.__delay = 0; });
      assert.equal((await db()).dealers.length, 2);
      assert.equal(await page.evaluate(() => window.__maxInflight), 1);

      // リフレッシュしても保持される(並び順・メール)
      const saved = (await db()).dealers.sort((a, b) => a.sortOrder - b.sortOrder);
      await open();
      assert.deepEqual(await names(), saved.map(d => d.name));
      await rows.nth(0).locator('[data-act="edit"]').click();
      assert.equal(await rows.nth(0).locator('[data-f="orderEmails"]').inputValue(), saved[0].orderEmails.join("\n"));
      await rows.nth(0).locator("[data-act=cancel-row]").click();

      // 保存失敗: エラー+再試行(画面の並びは残る・保存されていない)。再試行で保存される
      await page.evaluate(() => { window.__fail = 1; });
      await rows.nth(1).locator('[data-act="up"]').click();
      await sec.locator('[data-act="retry-autosave"]').waitFor();
      assert.match(await sec.locator("[data-msg]").innerText(), /保存できませんでした.*保存されていません/);
      const shown = await names();
      assert.notDeepEqual((await db()).dealers.sort((a, b) => a.sortOrder - b.sortOrder).map(d => d.name), shown, "保存されていない");
      await sec.locator('[data-act="retry-autosave"]').click();
      await sec.locator('[data-act="retry-autosave"]').waitFor({ state: "detached" });
      assert.deepEqual((await db()).dealers.sort((a, b) => a.sortOrder - b.sortOrder).map(d => d.name), shown, "再試行で画面の並びが保存される");

      // PC幅でも同じ(「↑」のみ。先頭の↑は見えない)
      await page.setViewportSize({ width: 1100, height: 900 });
      await open();
      assert.equal(await rows.nth(0).locator('[data-act="up"]').isHidden(), true);
      assert.equal(await rows.nth(1).locator('[data-act="up"]').isVisible(), true);
      assert.equal(await sec.locator('[data-act="down"]').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
      assert.deepEqual(errors, []);
      await context.close();
    } finally { await browser.close(); }
  });
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`並び替えボタン(担当医・ディーラー・採用IOL): PC・スマホとも「↑」のみ・各リストの先頭の↑は見えない(場所は残り、ほかのボタンの位置は揃う)・自動保存は維持: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 1200 } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      const open = async () => { await page.goto(base); await page.waitForFunction(() => window.__ready); await page.locator("details.iol-maker").evaluateAll(ds => ds.forEach(d => { d.open = true; })); };
      const idle = () => page.waitForFunction(() => window.__inflight === 0);
      const db = () => page.evaluate(() => JSON.parse(localStorage.getItem("__settingsDb")));
      const iols = page.locator('[data-section="iols"]'), docs = page.locator('[data-section="orderers"]'), deals = page.locator('[data-section="dealers"]');
      // ボタンが見えるか(visibility:hidden も「見えない」)。位置(左端)
      const shown = (loc) => loc.evaluateAll(es => es.map(e => { const s = getComputedStyle(e); return s.visibility !== "hidden" && s.display !== "none" && e.getBoundingClientRect().width > 0; }));
      const lefts = (loc) => loc.evaluateAll(es => es.map(e => Math.round(e.getBoundingClientRect().left)));
      await open();

      for (const width of [390, 1100]) {
        await page.setViewportSize({ width, height: 1200 });
        await open();
        // 「↓」はどこにもない
        assert.equal(await page.locator('#facilitySettings [data-act$="down"]').count(), 0, `${width}: 「↓」は廃止`);
        // 担当医・ディーラー: 「↑」「編集」「削除」の順(左から)。先頭の↑だけ見えない
        for (const [sec, kind] of [[docs, ".orderer-item"], [deals, ".dealer-item"]]) {
          const rows = sec.locator(kind);
          const cnt = await rows.count();
          assert.ok(cnt >= 2);
          assert.deepEqual(await rows.first().locator(".orderer-actions button").evaluateAll(bs => bs.map(b => b.getAttribute("data-act"))), ["up", "edit", "delete"]);
          assert.deepEqual(await shown(rows.locator('[data-act="up"]')), Array.from({ length: cnt }, (_, i) => i > 0), `${width}: 先頭の↑だけ見えない`);
          // 先頭の↑が見えなくても、ほかのボタンの位置は、ほかの行と同じ(ずれない)
          for (const act of ["up", "edit", "delete"]) {
            const xs = await lefts(rows.locator(`[data-act="${act}"]`));
            assert.ok(xs.every(x => Math.abs(x - xs[0]) <= 1), `${width} ${act}: 位置がそろう ${xs}`);
          }
          // 名前は、ボタンの左に収まる(重ならない)
          const ov = await rows.evaluateAll(rs => rs.some(r => { const n = r.querySelector(".orderer-namebox").getBoundingClientRect(), b = r.querySelector(".orderer-actions").getBoundingClientRect(); return n.right > b.left + 0.5 && n.top < b.bottom - 0.5 && b.top < n.bottom - 0.5; }));
          assert.equal(ov, false, `${width}: 名前とボタンが重ならない`);
        }
        // 採用IOL: メーカー・メーカー内のIOLとも「↑」のみ。先頭の↑だけ見えない
        const makers = iols.locator("details.iol-maker");
        const n = await makers.count();
        assert.deepEqual(await shown(makers.locator('summary [data-act="maker-up"]')), Array.from({ length: n }, (_, i) => i > 0));
        const groups = await makers.evaluateAll(ds => ds.map(d => [...d.querySelectorAll(".iol-model-row")].map(r => { const b = r.querySelector('[data-act="model-up"]'), s = getComputedStyle(b); return { shown: s.visibility !== "hidden" && b.getBoundingClientRect().width > 0, left: Math.round(b.getBoundingClientRect().left), buttons: r.querySelectorAll(".iol-moves button").length }; })));
        for (const g of groups) g.forEach((r, i) => { assert.equal(r.shown, i > 0, "メーカー内の先頭だけ↑が見えない"); assert.equal(r.buttons, 1, "↑のみ"); });
        const flat = groups.flat();
        assert.ok(flat.every(r => Math.abs(r.left - flat[0].left) <= 1), "各行の↑の位置がそろう");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
      }

      // 並び替え(↑)後の自動保存は維持。移動後も、先頭だけ↑が見えない
      await page.setViewportSize({ width: 390, height: 1200 });
      await open();
      const makers = iols.locator("details.iol-maker");
      const secondMaker = await makers.nth(1).getAttribute("data-maker");
      await makers.nth(1).locator('summary [data-act="maker-up"]').click();
      await page.waitForFunction(() => window.__calls.some(c => c[0] === "iolOrder"));
      await idle();
      assert.equal((await db()).iolOrder.makerOrder[0], secondMaker, "メーカーの並び替えが自動保存された");
      assert.deepEqual((await shown(makers.locator('summary [data-act="maker-up"]'))).slice(0, 2), [false, true]);
      const multi = makers.filter({ has: page.locator(".iol-model-row >> nth=1") }).first();
      const mrows = multi.locator(".iol-model-row");
      const second = await mrows.nth(1).getAttribute("data-model");
      await page.evaluate(() => { window.__calls = []; });
      await mrows.nth(1).locator('[data-act="model-up"]').click();
      await page.waitForFunction(() => window.__calls.some(c => c[0] === "iolOrder"));
      await idle();
      assert.equal(await mrows.nth(0).getAttribute("data-model"), second);
      assert.deepEqual((await shown(mrows.locator('[data-act="model-up"]'))).slice(0, 2), [false, true], "移動後も先頭だけ↑が見えない");
      const before = await docs.locator('[data-v="name"]').allInnerTexts();
      await page.evaluate(() => { window.__calls = []; });
      await docs.locator(".orderer-item").nth(1).locator('[data-act="up"]').click();
      await page.waitForFunction(() => window.__calls.some(c => c[0] === "orderers"));
      await idle();
      assert.deepEqual((await db()).orderers.sort((a, b) => a.sortOrder - b.sortOrder).map(o => o.name), [before[1], before[0], ...before.slice(2)], "担当医の並び替えが自動保存された");
      assert.deepEqual((await shown(docs.locator('.orderer-item [data-act="up"]'))).slice(0, 2), [false, true]);
      assert.deepEqual(errors, []);
      await context.close();
    } finally { await browser.close(); }
  });
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`施設設定の見出し(施設名の大きさ・ⓘ)とディーラーのメール欄の補足説明: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 1200 }, hasTouch: true });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      const style = (sel) => page.locator(sel).first().evaluate(e => { const s = getComputedStyle(e); return { size: s.fontSize, weight: s.fontWeight, color: s.color }; });

      for (const width of [390, 1100]) {
        await page.setViewportSize({ width, height: 1200 });
        // 施設名の文字の大きさ・色(黒)は「施設設定」と同じ。太さは標準(「施設設定」は太字)。文字の縦位置もそろう
        const h2 = await style(".settings-head h2"), fac = await style(".settings-facility"), body = await style("body");
        assert.equal(fac.size, h2.size, `${width}: 施設名は「施設設定」と同じ大きさ`);
        assert.equal(fac.color, h2.color, "施設名は「施設設定」と同じ黒");
        assert.equal(fac.color, "rgb(15, 23, 42)");
        assert.equal(fac.weight, body.weight, "太さは標準");
        assert.equal(h2.weight, "700", "「施設設定」は太字");
        const mids = await page.evaluate(() => [".settings-head h2", ".settings-facility"].map(sel => { const r = document.createRange(); r.selectNodeContents(document.querySelector(sel)); const b = r.getBoundingClientRect(); return (b.top + b.bottom) / 2; }));
        assert.ok(Math.abs(mids[0] - mids[1]) < 0.5, `${width}: 「施設設定」と施設名の文字の縦位置がそろう ${mids}`);
        // 施設設定の「追加」ボタン(担当医・ディーラー・利用者管理)は、幅60px・高さ36pxで3か所とも同じ
        const adds = await page.locator('#facilitySettings .settings-actions > [data-act="add"]').evaluateAll(bs => bs.map(b => { const r = b.getBoundingClientRect(), s = getComputedStyle(b); return [Math.round(r.width), Math.round(r.height), s.fontSize, s.borderRadius, s.paddingTop]; }));
        assert.ok(adds.length >= 2, "追加ボタン");
        for (const a of adds) assert.deepEqual(a, adds[0], `${width}: 追加ボタンのデザインがそろう`);
        assert.deepEqual(adds[0].slice(0, 2), [60, 36], `${width}: 幅60px・高さ36px`);
        // 常時表示の説明文は削除。「施設設定」の右横にⓘ(各設定項目と同じ見た目)
        assert.ok(!(await page.locator("#facilitySettings").innerText()).includes("この画面は施設管理者のみ変更できます。") || (await page.locator(".settings-head .info-tip-pop").isHidden()), "説明文は常時表示しない");
        assert.equal(await page.locator("#facilitySettings > p.form-hint:not([role])").count(), 0);
        const tip = page.locator(".settings-head .info-tip-btn");
        assert.equal(await tip.count(), 1);
        const pos = await page.evaluate(() => { const h = document.querySelector(".settings-head h2").getBoundingClientRect(), b = document.querySelector(".settings-head .info-tip-btn").getBoundingClientRect(); return { right: b.left >= h.right - 0.5, sameRow: Math.abs((b.top + b.bottom) / 2 - (h.top + h.bottom) / 2) < 14 }; });
        assert.deepEqual(pos, { right: true, sameRow: true }, "「施設設定」の右横");
        // 各設定項目(担当医など)のⓘと、同じ見た目
        const a = await page.locator(".settings-head .info-tip-btn").evaluate(b => { const s = getComputedStyle(b); return [s.fontSize, s.color, s.backgroundColor, s.borderTopWidth, s.width, s.height]; });
        const b2 = await page.locator('[data-section="orderers"] .info-tip-btn').evaluate(b => { const s = getComputedStyle(b); return [s.fontSize, s.color, s.backgroundColor, s.borderTopWidth, s.width, s.height]; });
        assert.deepEqual(a, b2, "ⓘのサイズ・色が各設定項目と同じ");
        // タップ(PC はホバー)で同じ説明文のツールチップ。外側で閉じる
        const pop = page.locator(".settings-head .info-tip-pop");
        assert.equal(await pop.isHidden(), true);
        if (width === 1100) { await tip.hover(); } else { await tip.tap(); }
        await pop.waitFor();
        assert.equal(await pop.innerText(), "この画面は施設管理者のみ変更できます。");
        const inView = await pop.evaluate(p => { const r = p.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
        assert.equal(inView, true, "ツールチップが画面内");
        await page.keyboard.press("Escape");
        await page.mouse.click(5, 5);
        await pop.waitFor({ state: "hidden" });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
      }

      // ディーラーの編集: 補足説明は両方「（1行に1件・最大5件）」で、同じ大きさ・太さ・色(グレー)
      const sec = page.locator('[data-section="dealers"]');
      await sec.locator(".dealer-item").first().locator('[data-act="edit"]').click();
      const notes = sec.locator(".dealer-item.is-editing .field-note");
      assert.deepEqual(await notes.allInnerTexts(), ["（1行に1件・最大5件）", "（1行に1件・最大5件）"]);
      const labels = await sec.locator(".dealer-item.is-editing .form-label").evaluateAll(ls => ls.map(l => l.firstChild.textContent.trim()));
      assert.deepEqual(labels, ["発注用メールアドレス", "使用報告用メールアドレス"]);
      const ns = await notes.evaluateAll(es => es.map(e => { const s = getComputedStyle(e); return [s.fontSize, s.fontWeight, s.color]; }));
      assert.deepEqual(ns[0], ns[1], "2つの補足説明は同じ書式");
      assert.equal(ns[0][2], "rgb(107, 114, 128)", "グレー");
      assert.ok(!(await sec.innerText()).includes("発注用とは別に管理"));
      // 使用報告用も、実際に最大5件(6件目はエラーで保存されない)
      await sec.locator('.dealer-item.is-editing [data-f="usageEmails"]').fill(Array.from({ length: 6 }, (_, i) => `u${i}@example.jp`).join("\n"));
      await sec.locator(".dealer-item.is-editing [data-act=save-row]").click();
      assert.match(await sec.locator(".dealer-item.is-editing [data-err]").innerText(), /使用報告用.*5件/);
      assert.deepEqual(errors, []);
      await context.close();
    } finally { await browser.close(); }
  });
}
