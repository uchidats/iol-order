// 回帰テスト(ブラウザ): 注文確認画面の「発注元 | 発注先」カード(施設とディーラーを1枚に)。  npm run test:browser
// 実際の styles.css と src/ui/confirm-lines.js を、確認画面と同じ構造のページに読み込んで確認する(ログイン・Firebase は使わない)。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

// index.html の確認画面と同じ構造(発注元・発注先のカード)
const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<div class="modal-overlay" id="confirmModal"><div class="modal-card"><div class="modal-body"><dl class="summary-list">
<div class="summary-item" id="summaryPartiesRow">
  <dt class="summary-label sr-only">発注元・発注先</dt>
  <dd class="summary-value summary-parties">
    <div class="summary-party" id="summaryFacilityBox"><span class="summary-party-label">発注元：</span><span class="summary-party-body" id="summaryFacility"></span></div>
    <div class="summary-party summary-party-dealers"><span class="summary-party-label">発注先：</span><div class="summary-party-body" id="summaryDealers"></div></div>
  </dd>
</div>
<div class="summary-item"><dt class="summary-label">備考（フリーコメント）</dt><dd class="summary-value">（なし）</dd></div>
</dl></div></div></div>
<script type="module">
import { renderDealersCard } from "/src/ui/confirm-lines.js";
const A = { dealerId: "dA", dealerName: "栗原医療器械店", dealerOrderEmails: ["a@example.jp"] };
const B = { dealerId: "dB", dealerName: "B医療機器販売株式会社", dealerOrderEmails: [] };
window.__show = (facility, lines) => {
  document.getElementById("summaryFacility").textContent = facility || "";
  document.getElementById("summaryFacilityBox").hidden = !facility;
  document.getElementById("summaryPartiesRow").classList.toggle("is-dealer-only", !facility);
  renderDealersCard(document.getElementById("summaryDealers"), lines);
};
window.__A = A; window.__B = B;
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

const text = (loc) => loc.evaluate(e => e.innerText.replace(/\s+/g, " ").trim());

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`確認画面: 発注元|発注先の1枚カード(1社・複数社・未設定・警告・スマホ幅): ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      const show = (facility, spec) => page.evaluate(([f, s]) => window.__show(f, s.map(([n, d]) => ({ lineNo: n, ...(d === "A" ? window.__A : d === "B" ? window.__B : { dealerId: "", dealerName: "", dealerOrderEmails: [] }) }))), [facility, spec]);
      const parties = page.locator(".summary-parties");

      // 1社: 左「発注元：立川病院」/右「発注先：ディーラー名」(名称は1回)。区切りの縦線。施設名とディーラー名は同じ文字サイズ・太さ
      await show("立川病院", [[1, "A"], [2, "A"]]);
      assert.equal(await text(parties), "発注元： 立川病院 発注先： 栗原医療器械店");
      assert.equal(await page.locator(".summary-party-dealers .summary-dealer").count(), 1);
      const style = await page.evaluate(() => { const f = getComputedStyle(document.getElementById("summaryFacility")), d = getComputedStyle(document.querySelector(".summary-dealer-name")); return { fs: [f.fontSize, d.fontSize], fw: [f.fontWeight, d.fontWeight] }; });
      assert.equal(style.fs[0], style.fs[1], "文字サイズが同じ");
      assert.equal(style.fw[0], style.fw[1], "太さが同じ");
      const divider = await page.locator(".summary-party-dealers").evaluate(e => { const s = getComputedStyle(e); return { w: s.borderLeftWidth, st: s.borderLeftStyle }; });
      assert.deepEqual(divider, { w: "1px", st: "solid" }, "細い縦の区切り線");
      const left = await page.locator("#summaryFacilityBox").boundingBox(), right = await page.locator(".summary-party-dealers").boundingBox();
      assert.ok(left.x < right.x && Math.abs(left.y - right.y) < 2, "左が発注元・右が発注先");
      // 独立した発注先カードは無い。カードは備考より上
      assert.equal(await page.locator("#summaryDealersRow").count(), 0);
      const order = await page.evaluate(() => [...document.querySelectorAll(".summary-item")].map(e => e.id || e.textContent.trim().slice(0, 4)));
      assert.deepEqual(order, ["summaryPartiesRow", "備考（フ"]);

      // 発注用メール未登録: 右側のディーラー名の下に小さめの警告
      await show("立川病院", [[1, "B"]]);
      const warn = await page.evaluate(() => { const n = document.querySelector(".summary-dealer-name").getBoundingClientRect(), w = document.querySelector(".summary-dealer-warning"); return { below: w.getBoundingClientRect().top >= n.bottom - 1, size: parseFloat(getComputedStyle(w).fontSize), nameSize: parseFloat(getComputedStyle(document.querySelector(".summary-dealer-name")).fontSize), text: w.textContent }; });
      assert.ok(warn.below && warn.size < warn.nameSize, JSON.stringify(warn));
      assert.equal(warn.text, "発注用メール未登録のため自動送信不可");

      // 複数社: 右側に各ディーラー名と対象レンズ番号
      await show("立川病院", [[1, "A"], [2, "B"], [3, "A"]]);
      const items = await page.locator(".summary-dealer").evaluateAll(es => es.map(e => e.innerText.replace(/\s+/g, " ").trim()));
      assert.deepEqual(items, ["栗原医療器械店 レンズ1・レンズ3", "B医療機器販売株式会社 レンズ2 発注用メール未登録のため自動送信不可"]);
      // 未設定
      await show("立川病院", [[1, ""], [2, ""]]);
      assert.equal(await text(parties), "発注元： 立川病院 発注先： 未設定");
      // 施設名なし: 右側(発注先)だけ・区切り線なし
      await show("", [[1, "A"]]);
      assert.equal(await page.locator("#summaryFacilityBox").isHidden(), true);
      assert.equal(await text(parties), "発注先： 栗原医療器械店");

      // スマホ幅(長い名前でも): 左右が重ならず、横スクロールなし
      await show("国家公務員共済組合連合会立川病院附属眼科診療所", [[1, "A"], [2, "B"], [3, "B"]]);
      for (const w of [390, 360, 320]) {
        await page.setViewportSize({ width: w, height: 1000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `横スクロール ${w}`);
        const r = await page.evaluate(() => {
          const rect = (e) => e.getBoundingClientRect();
          const ps = [...document.querySelectorAll(".summary-party")].filter(p => !p.hidden).map(rect);
          const box = rect(document.querySelector(".summary-parties"));
          const ov = ps.length === 2 && ps[0].left < ps[1].right - 0.5 && ps[1].left < ps[0].right - 0.5 && ps[0].top < ps[1].bottom - 0.5 && ps[1].top < ps[0].bottom - 0.5;
          return { ov, out: ps.some(p => p.right > box.right + 0.5 || p.left < box.left - 0.5) };
        });
        assert.deepEqual(r, { ov: false, out: false }, `重なり/はみ出し ${w}`);
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
