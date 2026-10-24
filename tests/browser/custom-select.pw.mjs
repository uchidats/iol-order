// 回帰テスト(ブラウザ): スマホ幅のカスタムドロップダウン(レンズのモデル・度数)。  npm run test:browser
// 幅 240〜280px・1項目 42px・白背景/濃いグレー(ダークモードでも固定)・選択中は青いチェック・メーカー別グループ・内部スクロール・画面外にはみ出さない位置。
// PC幅は従来のネイティブ select。実際の styles.css と src/ui/lens-lines.js を最小のページで確認する(ログイン・Firebase は使わない)。
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
<main class="main-content"><form id="iolOrderForm" class="order-form" novalidate><div class="order-fields">
<div id="lensLines" class="lens-lines"></div>
<div class="lens-lines-actions"><button type="button" class="btn btn-secondary" id="btnAddLine">＋ レンズを追加</button></div>
<div style="height:1400px" id="spacer"></div>
</div></form></main>
<script type="module">
import { createLensLines } from "/src/ui/lens-lines.js";
import { buildLensOptions } from "/src/domain/lens-options.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
const options = buildLensOptions(IOL_MODELS);
window.__changes = [];
window.__lines = createLensLines({
  container: document.getElementById("lensLines"), addButton: document.getElementById("btnAddLine"),
  getOptions: () => options, getDoctors: () => [{ id: "o1", name: "山田" }], minDate: () => "2020-01-01"
});
document.querySelector("[data-f=model]").addEventListener("change", e => window.__changes.push(["model", e.target.value]));
document.querySelector("[data-f=power]").addEventListener("change", e => window.__changes.push(["power", e.target.value]));
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

const rect = (loc) => loc.evaluate(e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; });

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`スマホ幅のカスタムドロップダウン(モデル・度数): ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      // ダークモードの端末(Android の暗いテーマ)でも、メニューは白背景・濃いグレーの文字
      const context = await browser.newContext({ viewport: { width: 390, height: 700 }, colorScheme: "dark", hasTouch: true });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      const line = page.locator(".lens-line").first();
      const modelTrigger = line.locator('[data-group="model"] .cs-trigger'), powerTrigger = line.locator('[data-group="power"] .cs-trigger');
      const modelSelect = line.locator("[data-f=model]"), powerSelect = line.locator("[data-f=power]");
      const panel = page.locator(".cs-panel");

      // スマホ幅: ボタンを表示。元の select は見えない(値の保持用)
      assert.equal(await modelTrigger.isVisible(), true);
      assert.equal(await modelSelect.evaluate(s => getComputedStyle(s).opacity), "0");
      assert.equal((await modelTrigger.innerText()).trim(), "選択");

      // メニューを開く: 幅 240〜280px・1項目 40〜44px・白背景・濃いグレー・メーカー別グループ・スクロール
      await modelTrigger.click();
      await panel.waitFor();
      const pr = await rect(panel);
      assert.ok(pr.width >= 240 && pr.width <= 280.5, `幅 ${pr.width}`);
      const st = await panel.evaluate(p => { const s = getComputedStyle(p), o = getComputedStyle(p.querySelector(".cs-option:not(.is-placeholder)")); return { bg: s.backgroundColor, color: o.color, optBg: o.backgroundColor, overflowY: s.overflowY, sh: p.scrollHeight, ch: p.clientHeight }; });
      assert.equal(st.bg, "rgb(255, 255, 255)", "白背景(ダークモードでも)");
      assert.equal(st.color, "rgb(31, 41, 55)", "濃いグレーの文字");
      assert.equal(st.optBg, "rgb(255, 255, 255)");
      const hs = await panel.locator(".cs-option").evaluateAll(os => os.map(o => o.getBoundingClientRect().height));
      assert.ok(hs.every(h => h >= 40 && h <= 44), `項目の高さ ${[...new Set(hs)]}`);
      // メーカー名の見出し・グループの区切りは出さない(型番だけを、従来の並び順のまま一覧表示)
      assert.equal(await panel.locator(".cs-group-label, .cs-group").count(), 0, "メーカー名の見出しなし");
      assert.equal(await modelSelect.locator("optgroup").count(), 0);
      const shown = await panel.locator(".cs-option:not(.is-placeholder) .cs-option-text").allInnerTexts();
      assert.deepEqual(shown, await modelSelect.locator("option:not([value=''])").allInnerTexts(), "型番の並びは元の select と同じ");
      assert.ok(shown.includes("DIB00V") && shown.includes("CNA0T0") && shown.length >= 6);
      assert.ok(!shown.some(s => /^(ALCON|J&J|HOYA|NIDEK|SANTEN)$/.test(s)), "メーカー名の行はない");
      assert.equal(await panel.locator(".cs-option").count(), await modelSelect.locator("option").count(), "選択肢は元の select と同じ");
      assert.equal(st.overflowY, "auto");
      assert.ok(pr.left >= 8 - 0.5 && pr.right <= 390 - 8 + 0.5 && pr.top >= 0 && pr.bottom <= 700, "画面内");
      // 選択肢が多いとき(トーリックの一覧)は、メニュー内でスクロールできる
      await page.keyboard.press("Escape");
      await line.locator("[data-f=toric]").check();
      await modelTrigger.click(); await panel.waitFor();
      const many = await panel.evaluate(p => ({ sh: p.scrollHeight, ch: p.clientHeight }));
      assert.ok(many.sh > many.ch, "多いときはメニュー内でスクロール: " + JSON.stringify(many));
      await panel.evaluate(p => { p.scrollTop = 99999; });
      assert.ok(await panel.evaluate(p => p.scrollTop > 0), "メニュー内でスクロールできる");
      await page.keyboard.press("Escape");
      await line.locator("[data-f=toric]").uncheck();
      await modelTrigger.click(); await panel.waitFor();

      // 選ぶ: select の値が変わり、change が発火し、ボタンの表示が変わり、メニューが閉じる(既存の処理・注文データは select の値のまま)
      const target = await modelSelect.evaluate(s => { const o = [...s.options].find(x => x.textContent === "DIB00V"); return { value: o.value, text: o.textContent }; });
      await panel.locator(`.cs-option[data-value="${target.value}"]`).scrollIntoViewIfNeeded();
      await panel.locator(`.cs-option[data-value="${target.value}"]`).click();
      assert.equal(await panel.count(), 0, "選ぶと閉じる");
      assert.equal(await modelSelect.inputValue(), target.value);
      assert.deepEqual(await page.evaluate(() => window.__changes), [["model", target.value]]);
      assert.equal((await modelTrigger.innerText()).trim(), "DIB00V");
      assert.equal(await page.evaluate(() => window.__lines.values()[0].lens.key), target.value);

      // 再び開くと、選択中の項目に青いチェックマーク(1つだけ)。選択中の項目が見える位置から開く
      await modelTrigger.click(); await panel.waitFor();
      assert.equal(await panel.locator(".cs-check").count(), 1);
      assert.equal(await panel.locator(".cs-option.is-selected .cs-check").count(), 1);
      assert.equal(await panel.locator(".cs-check").evaluate(c => getComputedStyle(c).color), "rgb(37, 99, 235)", "青いチェック");
      assert.equal(await panel.locator(".cs-option.is-selected").evaluate(o => { const r = o.getBoundingClientRect(), p = o.closest(".cs-panel").getBoundingClientRect(); return r.top >= p.top - 1 && r.bottom <= p.bottom + 1; }), true);
      await page.keyboard.press("Escape");
      assert.equal(await panel.count(), 0);

      // 度数(モデルに応じた選択肢)。選ぶと値・表示が変わる。別のモデルに変えても、同じ度数があれば維持(既存の処理)
      await powerTrigger.click(); await panel.waitFor();
      // IOLパワー: 選択ボックス(約2/3の幅=128px)と展開メニューの幅が同じ。IOLモデルのメニューは従来の幅
      const pw = await rect(panel), pt = await rect(powerTrigger);
      assert.ok(Math.abs(pt.width - 128) <= 1, `IOLパワーの幅 ${pt.width}`);
      assert.ok(Math.abs(pw.width - pt.width) <= 1 && Math.abs(pw.left - pt.left) <= 1, `メニューの幅・位置がボタンと同じ: ${JSON.stringify({ pw, pt })}`);
      assert.ok(pw.right <= 390 - 7.5);
      assert.ok(await panel.locator('.cs-option').first().evaluate(o => o.getBoundingClientRect().height >= 40 && o.getBoundingClientRect().height <= 44), "項目の高さは従来どおり");
      await panel.locator('.cs-option[data-value="+20.0D"]').scrollIntoViewIfNeeded();
      await panel.locator('.cs-option[data-value="+20.0D"]').click();
      assert.equal(await powerSelect.inputValue(), "+20.0D");
      assert.equal((await powerTrigger.innerText()).trim(), "+20.0D");
      await modelSelect.selectOption({ label: "CNA0T0" });            // プログラムからの変更(Playwright)も、ボタンの表示に反映される
      assert.equal((await modelTrigger.innerText()).trim(), "CNA0T0");
      assert.equal((await powerTrigger.innerText()).trim(), "+20.0D", "度数は維持");

      // キーボード: Enter で開く・↓で移動・Enter で選ぶ・Esc で閉じる。外側をタップすると閉じる
      await powerTrigger.focus();
      await page.keyboard.press("Enter"); await panel.waitFor();
      await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
      assert.equal(await powerSelect.inputValue(), "+20.5D");
      await powerTrigger.focus(); await page.keyboard.press("ArrowDown"); await panel.waitFor();
      await page.keyboard.press("Escape");
      assert.equal(await panel.count(), 0);
      await modelTrigger.click(); await panel.waitFor();
      await page.mouse.click(5, 5);
      assert.equal(await panel.count(), 0, "外側で閉じる");

      // 位置の自動調整: 画面の下端近くのボタンでは上に開き、画面内に収まる
      const tb = await rect(modelTrigger);
      await page.setViewportSize({ width: 390, height: Math.round(tb.bottom) + 24 });   // ボタンの下にほとんど余白がない画面
      await modelTrigger.click(); await panel.waitFor();
      const low = await rect(panel);
      assert.equal(await panel.getAttribute("data-placement"), "above");
      assert.ok(low.top >= 0 && low.bottom <= Math.round(tb.bottom) + 24 && low.bottom <= (await rect(modelTrigger)).top + 1, `上に開く ${JSON.stringify(low)}`);
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 390, height: 700 });
      // 狭い幅(320px)でも、左右にはみ出さない
      await page.setViewportSize({ width: 320, height: 700 });
      await modelTrigger.click(); await panel.waitFor();
      const narrow = await rect(panel);
      assert.ok(narrow.left >= 7.5 && narrow.right <= 320 - 7.5, `320px: ${JSON.stringify(narrow)}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
      await page.keyboard.press("Escape");

      // PC幅: ボタンは出ず、従来のネイティブ select
      await page.setViewportSize({ width: 1100, height: 800 });
      assert.equal(await modelTrigger.isHidden(), true);
      assert.equal(await modelSelect.evaluate(s => getComputedStyle(s).opacity), "1");
      // 幅: IOLパワーだけ約2/3(128px)。IOLモデル(220px)・担当医(200px)は変更なし
      const ws = await page.evaluate(() => Object.fromEntries(["model", "power", "doctor"].map(k => [k, Math.round(document.querySelector(`.lens-line [data-f=${k}]`).getBoundingClientRect().width)])));
      assert.deepEqual(ws, { model: 220, power: 128, doctor: 200 }, "PC幅の選択ボックスの幅");
      assert.deepEqual(errors, []);
      await context.close();
    } finally { await browser.close(); }
  });
}
