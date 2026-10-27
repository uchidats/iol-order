// 回帰テスト(ブラウザ): 採用IOLごとの既定ディーラー(発注先)。  npm run test:browser
// 施設設定「採用IOL」での設定(自動保存・2社以上のときだけ・削除したディーラーは外す)と、注文画面での自動選択(モデル変更・手動変更・下書き復元・ディーラー削除)を、
// 実際の styles.css と src/ui/facility-settings.js・src/ui/lens-lines.js を最小のページに読み込んで確認する(Firebase は使わない)。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const SETTINGS = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<main class="main-content"></main>
<script type="module">
import { createFacilitySettings } from "/src/ui/facility-settings.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
const n = Number(new URLSearchParams(location.search).get("dealers") || 3);
const dealers = [
  { id: "d1", name: "A商会", sortOrder: 10, orderEmails: ["a@example.jp"] },
  { id: "d2", name: "B医療", sortOrder: 20, orderEmails: ["b@example.jp"] },
  { id: "d3", name: "C商会", sortOrder: 30, orderEmails: ["c@example.jp"] }
].slice(0, n);
const adopted = [
  { id: "jj-dib00v", catalogIolId: "jj-dib00v", facilityId: "f1", enabled: true, dealerId: "d2" },
  { id: "jj-diwxxx-toric", catalogIolId: "jj-diwxxx-toric", facilityId: "f1", enabled: false }
];
window.__adoptedWrites = [];
const repository = { listOrderers: async () => [], listAdoptedIols: async () => adopted.map(a => ({ ...a })), listDealers: async () => dealers.map(d => ({ ...d })), listMembers: async () => [] };
const settingsApi = {
  saveOrderers: async () => {}, saveDealers: async () => {}, deleteOrderer: async () => {},
  saveAdoptedIols: async (fid, writes) => {
    window.__adoptedWrites.push(JSON.parse(JSON.stringify(writes)));
    for (const w of writes) { const i = adopted.findIndex(a => a.id === w.id); const doc = { id: w.id, ...w.data }; if (i >= 0) adopted[i] = doc; else adopted.push(doc); }   // 全体の上書き(既定なしは dealerId が消える)
  },
  deleteDealer: async (fid, id) => { const i = dealers.findIndex(x => x.id === id); if (i >= 0) dealers.splice(i, 1); }
};
const s = createFacilitySettings({ mount: document.querySelector("main"), repository, settingsApi, masters: IOL_MODELS, onSaved: async () => {}, onClose() {} });
await s.open({ id: "f1", name: "テスト施設" });
window.__adopted = adopted;
window.__ready = true;
</script></body></html>`;

const ORDER = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<main class="main-content"><form id="iolOrderForm" class="order-form" novalidate><div class="order-fields">
<div id="lensLines" class="lens-lines"></div>
<div class="lens-lines-actions"><button type="button" class="btn btn-secondary" id="btnAddLine">＋ レンズを追加</button></div>
</div></form></main>
<script type="module">
import { createLensLines } from "/src/ui/lens-lines.js";
import { buildLensOptions } from "/src/domain/lens-options.js";
import { resolveAdoptedModels } from "/src/data/static-repository.js";
const n = Number(new URLSearchParams(location.search).get("dealers") || 3);
// 既定ディーラー: DIB00V → dA、DIWxxx(トーリック)→ dB、CNA0T0 → なし、XY1 → 削除済みのディーラー
const adopted = [
  { catalogIolId: "jj-dib00v", enabled: true, dealerId: "dA" },
  { catalogIolId: "jj-diwxxx-toric", enabled: true, dealerId: "dB" },
  { catalogIolId: "alcon-cna0t0", enabled: true },
  { catalogIolId: "hoya-xy1", enabled: true, dealerId: "dGone" }
];
const options = buildLensOptions(resolveAdoptedModels(adopted));
window.__dealers = [{ id: "dA", name: "A商会", orderEmails: ["a@example.jp"] }, { id: "dB", name: "B医療", orderEmails: ["b@example.jp"] }, { id: "dC", name: "C商会", orderEmails: ["c@example.jp"] }].slice(0, n);
window.__lines = createLensLines({
  container: document.getElementById("lensLines"), addButton: document.getElementById("btnAddLine"),
  getOptions: () => options, getDoctors: () => [{ id: "o1", name: "山田" }], getDealers: () => window.__dealers, minDate: () => "2020-01-01"
});
window.__ready = true;
</script></body></html>`;

let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/settings" || url === "/order") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(url === "/settings" ? SETTINGS : ORDER); return; }
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
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`施設設定: 採用IOLごとの既定ディーラー(2社以上・採用中だけ表示、自動保存、既定なしへ戻す、削除したディーラーは外す)。スマートフォン/PC: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        page.on("dialog", d => d.accept());
        await page.goto(`${base}settings`);
        await page.waitForFunction(() => window.__ready);
        const iols = page.locator('[data-section="iols"]');
        await iols.locator('details[data-maker="J&J"] summary').click();
        const row = (id) => iols.locator(`.iol-model-row[data-model="${id}"]`);
        const sel = (id) => row(id).locator('[data-f="defaultDealer"]');
        const writes = () => page.evaluate(() => window.__adoptedWrites.flat());
        // 採用中(DIB00V): 保存済みの既定(B医療)。選択肢は既定なし+登録ディーラー。未採用(DIWxxx)は表示しない
        assert.equal(await sel("jj-dib00v").isVisible(), true);
        assert.equal(await sel("jj-dib00v").inputValue(), "d2");
        assert.deepEqual(await sel("jj-dib00v").locator("option").allInnerTexts(), ["既定なし（注文時に選択）", "A商会", "B医療", "C商会"]);
        assert.equal(await sel("jj-diwxxx-toric").isVisible(), false);
        // 変更で自動保存(保存ボタンなし)
        assert.equal(await iols.locator("button", { hasText: "保存" }).count(), 0);
        await sel("jj-dib00v").selectOption("d3");
        await page.waitForFunction(() => window.__adoptedWrites.flat().some(w => w.id === "jj-dib00v" && w.data.dealerId === "d3"));
        // 既定なしに戻す: dealerId を書かない
        await sel("jj-dib00v").selectOption("");
        await page.waitForFunction(() => { const w = window.__adoptedWrites.flat().filter(x => x.id === "jj-dib00v").at(-1); return w && !("dealerId" in w.data); });
        // 採用すると欄が出て、既定を選べる
        await row("jj-diwxxx-toric").locator('input[type="checkbox"]').check();
        assert.equal(await sel("jj-diwxxx-toric").isVisible(), true);
        await sel("jj-diwxxx-toric").selectOption("d1");
        await page.waitForFunction(() => window.__adopted.find(a => a.id === "jj-diwxxx-toric").dealerId === "d1");
        assert.equal((await writes()).filter(w => w.id === "jj-diwxxx-toric").at(-1).data.enabled, true);
        // スマートフォン幅では、モデル名の下に折り返す(横にはみ出さない)
        if (width === 390) {
          const [nameBox, selBox] = [await row("jj-diwxxx-toric").locator(".iol-name").boundingBox(), await sel("jj-diwxxx-toric").boundingBox()];
          assert.ok(selBox.y > nameBox.y + nameBox.height - 2, "スマホ幅は名前の下");
        }
        assert.ok(await noOverflow(page), `${width}: 横にはみ出さない`);
        // ディーラー(A商会)を削除: 既定にしていた採用IOLは「既定なし」に戻して保存する
        const dealerRow = page.locator('[data-section="dealers"] .dealer-item[data-id="d1"]');
        await dealerRow.locator('[data-act="delete"]').click();
        await page.waitForFunction(() => !("dealerId" in window.__adopted.find(a => a.id === "jj-diwxxx-toric")));
        assert.equal(await sel("jj-diwxxx-toric").inputValue(), "");
        assert.deepEqual(await sel("jj-diwxxx-toric").locator("option").allInnerTexts(), ["既定なし（注文時に選択）", "B医療", "C商会"]);
        assert.deepEqual(errors, []);
        await page.close();
      }
      // 登録ディーラーが1社: 既定ディーラーの欄は出さない(従来どおり自動で選ばれる)
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      await page.goto(`${base}settings?dealers=1`);
      await page.waitForFunction(() => window.__ready);
      await page.locator('[data-section="iols"] details[data-maker="J&J"] summary').click();
      assert.equal(await page.locator('[data-section="iols"] [data-f="defaultDealer"]:visible').count(), 0);
      await page.close();
    } finally { await browser.close(); }
  });

  test(`注文画面: 既定ディーラーの自動選択(モデル変更で新しい既定を優先・未設定は未選択・度数などでは維持・手動変更・追加・下書き復元・削除・1社): ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(`${base}order`);
      await page.waitForFunction(() => window.__ready);
      const L = (i) => page.locator(".lens-line").nth(i);
      const f = (i, k) => L(i).locator(`[data-f="${k}"]`);
      const dealer = (i) => f(i, "dealer").inputValue();
      // モデルを選ぶと既定ディーラー
      await f(0, "model").selectOption("jj-dib00v");
      assert.equal(await dealer(0), "dA");
      // 手動で変更でき、度数・枚数・手術日の変更では維持
      await f(0, "dealer").selectOption("dC");
      await f(0, "power").selectOption("+20.0D");
      await L(0).locator('.quantity-option:has([value="2"])').click();
      await f(0, "date").fill("2099-01-10");
      await f(0, "date").evaluate(el => el.blur());
      assert.equal(await dealer(0), "dC");
      // 別のモデル(既定なし)に変えると、未選択に戻す
      await f(0, "model").selectOption("alcon-cna0t0");
      assert.equal(await dealer(0), "");
      // 手動で選んでから、既定のあるモデルへ変えると、新しいモデルの既定を優先
      await f(0, "dealer").selectOption("dC");
      await f(0, "toric").check();
      assert.equal(await f(0, "model").inputValue(), "", "トーリックの絞り込みでモデルは外れる");
      assert.equal(await dealer(0), "dC", "モデルが外れただけでは発注先を変えない");
      await f(0, "model").selectOption("jj-diwxxx-toric|DIW150");
      assert.equal(await dealer(0), "dB");
      // 同じ系列の型番の変更では、手動の発注先を維持
      await f(0, "dealer").selectOption("dC");
      await f(0, "model").selectOption("jj-diwxxx-toric|DIW225");
      assert.equal(await dealer(0), "dC");
      // 既定が削除済みのディーラーのモデル: 既定なしとして扱う(未選択)
      await f(0, "toric").uncheck();
      await f(0, "model").selectOption("hoya-xy1");
      assert.equal(await dealer(0), "");
      // 「レンズを追加」: 発注先を引き継ぎ、初めて選ぶモデルに既定がなければそのまま、既定があれば既定
      await f(0, "dealer").selectOption("dC");
      await page.click("#btnAddLine");
      assert.equal(await dealer(1), "dC", "引き継ぎ");
      await f(1, "model").selectOption("alcon-cna0t0");
      assert.equal(await dealer(1), "dC", "初めて選ぶモデルに既定がなければ引き継いだまま");
      await f(1, "model").selectOption("jj-dib00v");
      assert.equal(await dealer(1), "dA");
      // 下書きの復元: 保存された発注先を維持(既定で上書きしない)。削除済みのディーラーは未選択
      const snap = await page.evaluate(() => window.__lines.snapshot());
      snap[1].dealerId = "dC";
      snap.push({ ...snap[1], dealerId: "dGone" });
      await page.evaluate((s) => window.__lines.restore(s), snap);
      assert.deepEqual([await dealer(0), await dealer(1), await dealer(2)], ["dC", "dC", ""]);
      await f(1, "power").selectOption("+21.0D");
      assert.equal(await dealer(1), "dC", "復元後の度数の変更でも維持");
      await f(1, "model").selectOption("alcon-cna0t0");
      assert.equal(await dealer(1), "", "復元後に別のモデルへ変えると、新しいモデルの規則");
      // ディーラーの削除(設定の再読み込み): 削除されたディーラーは選択されたままにしない
      await page.evaluate(() => { window.__dealers = window.__dealers.filter(d => d.id !== "dC"); window.__lines.refresh(); });
      assert.equal(await dealer(0), "");
      const v = await page.evaluate(() => window.__lines.validate().ok);
      assert.equal(v, false, "未選択は送信前に必須エラー");
      assert.ok(await noOverflow(page));
      assert.deepEqual(errors, []);
      await page.close();

      // 登録ディーラーが1社: 従来どおりその1社(入力欄は出さない。既定の設定にかかわらず)
      const p1 = await browser.newPage({ viewport: { width: 1100, height: 900 } });
      await p1.goto(`${base}order?dealers=1`);
      await p1.waitForFunction(() => window.__ready);
      await p1.locator('.lens-line [data-f="model"]').first().selectOption("jj-dib00v");
      assert.equal(await p1.locator('.lens-line [data-group="dealer"]').first().isVisible(), false);
      assert.equal(await p1.evaluate(() => window.__lines.values()[0].dealer.id), "dA");
      await p1.close();
    } finally { await browser.close(); }
  });
}
