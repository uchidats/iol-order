// 回帰テスト(ブラウザ): 注文確認画面の「発注するレンズ」の手術日別グループ表示と、担当医(Dr.)の表記。  npm run test:browser
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

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<div class="modal-overlay" id="confirmModal"><div class="modal-card"><div class="modal-body"><dl class="summary-list">
<div class="summary-item summary-item-lines"><dt class="summary-label">発注するレンズ(手術日別)</dt><dd class="summary-value"><ol class="summary-lines" id="summaryLines"></ol></dd></div>
</dl></div></div></div>
<script type="module">
import { renderConfirmLines } from "/src/ui/confirm-lines.js";
const base = { isToric: false, isMultifocal: false };
window.__lines = [
  { ...base, lineNo: 1, manufacturer: "ALCON", modelName: "CNA0T0", power: "+18.0D", quantity: 1, surgeryDate: "2099-02-12", doctor: "内田" },
  { ...base, lineNo: 2, manufacturer: "J&J", modelName: "DIW300", isToric: true, power: "+18.5D", quantity: 2, surgeryDate: "2099-02-10", doctor: "佐藤太郎左衛門" },
  { ...base, lineNo: 3, manufacturer: "HOYA", modelName: "XY1", power: "+19.5D", quantity: 1, surgeryDate: "2099-02-12", doctor: "山田" },
  { ...base, lineNo: 4, manufacturer: "NIDEK", modelName: "NSP-2", power: "+5.5D", quantity: 1, surgeryDate: "2099-02-10", doctor: "内田" }
];
window.__before = JSON.stringify(window.__lines);
window.__render = (lines) => renderConfirmLines(document.getElementById("summaryLines"), lines);
window.__render(window.__lines);
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
  test(`確認画面: 手術日別グループ・元のレンズ番号・Dr. 表記・スマホ幅: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);

      // 複数の手術日: 手術日の早い順に見出し。同じ日は入力順。レンズ番号は元のまま(振り直さない)
      const heads = await page.locator(".summary-date-head").allInnerTexts();
      assert.deepEqual(heads, ["手術日 2099年2月10日(火)", "手術日 2099年2月12日(木)"]);
      const groups = await page.locator(".summary-date-group").evaluateAll(gs => gs.map(g => [...g.querySelectorAll(".lens-no-badge")].map(b => b.textContent)));
      assert.deepEqual(groups, [["レンズ2", "レンズ4"], ["レンズ1", "レンズ3"]]);
      // 各レンズ: メーカー・モデル・度数・枚数・担当医(Dr.)が同じ行。手術日は各レンズに繰り返さない。「担当医」の文言は出ない
      const rows = await page.locator(".summary-line").evaluateAll(ls => ls.map(l => [...l.querySelector(".summary-line-main").children].map(c => c.textContent.trim()).join(" ")));
      assert.deepEqual(rows, [
        "レンズ2 J&J DIW300 トーリック +18.5D 2枚 Dr. 佐藤太郎左衛門", "レンズ4 NIDEK NSP-2 +5.5D 1枚 Dr. 内田",
        "レンズ1 ALCON CNA0T0 +18.0D 1枚 Dr. 内田", "レンズ3 HOYA XY1 +19.5D 1枚 Dr. 山田"]);
      assert.equal(await page.locator(".summary-line", { hasText: "手術日" }).count(), 0, "手術日は各レンズに繰り返さない");
      assert.equal(await page.locator("#summaryLines", { hasText: "担当医" }).count(), 0);
      // 担当医の文字色はレンズ情報より控えめ
      const colors = await page.evaluate(() => { const c = (s) => getComputedStyle(document.querySelector(s)).color.match(/\d+/g).map(Number); return { model: c(".summary-model"), doctor: c(".summary-doctor") }; });
      assert.ok(colors.doctor.reduce((a, b) => a + b) > colors.model.reduce((a, b) => a + b), "Dr. は控えめな色(明るい)");
      // 元のデータは変更されない(表示のみ)
      assert.equal(await page.evaluate(() => JSON.stringify(window.__lines) === window.__before), true);

      // スマホ幅・狭い幅: 横にはみ出さない。レンズの要素が重ならない。Dr. は同じ行か、収まらなければ次行
      for (const w of [390, 360, 320]) {
        await page.setViewportSize({ width: w, height: 1000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `横スクロール ${w}`);
        const bad = await page.locator(".summary-line-main").evaluateAll(mains => mains.flatMap(m => {
          const rs = [...m.children].map(c => c.getBoundingClientRect());
          const out = [];
          for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
            const a = rs[i], b = rs[j];
            if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) out.push([i, j]);
          }
          const box = m.getBoundingClientRect();
          if (rs.some(r => r.right > box.right + 0.5)) out.push("はみ出し");
          return out;
        }));
        assert.deepEqual(bad, [], `重なり/はみ出し ${w}`);
      }
      // 広い幅では、Dr. がレンズ情報と同じ行に並ぶ(短い名前の行)
      await page.setViewportSize({ width: 1100, height: 900 });
      const sameRow = await page.locator(".summary-line-main").nth(1).evaluate(m => { const q = m.querySelector(".summary-qty").getBoundingClientRect(), d = m.querySelector(".summary-doctor").getBoundingClientRect(); return Math.abs(q.top - d.top) < 3; });
      assert.equal(sameRow, true);

      // 手術日が1日だけでも同じデザイン(見出し+その下にレンズ)。レンズ番号はそのまま
      await page.evaluate(() => window.__render(window.__lines.map(l => ({ ...l, surgeryDate: "2099-03-01" }))));
      assert.deepEqual(await page.locator(".summary-date-head").allInnerTexts(), ["手術日 2099年3月1日(日)"]);
      assert.deepEqual(await page.locator(".lens-no-badge").allInnerTexts(), ["レンズ1", "レンズ2", "レンズ3", "レンズ4"], "入力順を維持");
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
