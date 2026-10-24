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
  { ...base, lineNo: 1, manufacturer: "ALCON", modelName: "CNA0T0", power: "+18.0D", quantity: 1, surgeryDate: "2099-02-12", doctor: "内田", doctorId: "o1" },
  { ...base, lineNo: 2, manufacturer: "J&J", modelName: "DIW300", isToric: true, power: "+18.5D", quantity: 2, surgeryDate: "2099-02-10", doctor: "佐藤太郎左衛門", doctorId: "o2" },
  { ...base, lineNo: 3, manufacturer: "HOYA", modelName: "XY1", power: "+19.5D", quantity: 1, surgeryDate: "2099-02-12", doctor: "山田", doctorId: "o3" },
  { ...base, lineNo: 4, manufacturer: "NIDEK", modelName: "NSP-2", power: "+5.5D", quantity: 1, surgeryDate: "2099-02-10", doctor: "内田", doctorId: "o1" },
  { ...base, lineNo: 5, manufacturer: "SANTEN", modelName: "NX-70S", power: "+20.0D", quantity: 1, surgeryDate: "2099-02-12", doctor: "内田", doctorId: "o1" }
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

      // 「手術日 + 担当医」ごとの見出し。手術日の早い順、同じ日は担当医の初出順。同じ手術日・同じ担当医は1つにまとまり、担当医が違えば分かれる。レンズ番号は元のまま
      const heads = await page.locator(".summary-date-head").allInnerTexts();
      assert.deepEqual(heads.map(h => h.replace(/\s+/g, " ")), [
        "手術日 2099年2月10日(火) Dr. 佐藤太郎左衛門", "手術日 2099年2月10日(火) Dr. 内田",
        "手術日 2099年2月12日(木) Dr. 内田", "手術日 2099年2月12日(木) Dr. 山田"]);
      assert.ok((await page.locator(".summary-date-head").first().textContent()).includes("　"), "手術日と担当医の間は全角スペース");
      const groups = await page.locator(".summary-date-group").evaluateAll(gs => gs.map(g => [...g.querySelectorAll(".lens-no-badge")].map(b => b.textContent)));
      assert.deepEqual(groups, [["レンズ2"], ["レンズ4"], ["レンズ1", "レンズ5"], ["レンズ3"]]);
      // 各レンズ: メーカー・モデル・度数・枚数だけ。Dr. と手術日は各レンズの行に出ない(見出しにまとめる)。「担当医」の文言は出ない
      const rows = await page.locator(".summary-line").evaluateAll(ls => ls.map(l => [...l.querySelector(".summary-line-main").children].map(c => c.textContent.trim()).join(" ")));
      assert.deepEqual(rows, [
        "レンズ2 J&J DIW300 +18.5D 2枚", "レンズ4 NIDEK NSP-2 +5.5D 1枚",
        "レンズ1 ALCON CNA0T0 +18.0D 1枚", "レンズ5 SANTEN NX-70S +20.0D 1枚", "レンズ3 HOYA XY1 +19.5D 1枚"]);
      assert.equal(await page.locator(".summary-line", { hasText: "Dr." }).count(), 0, "各レンズの行に Dr. は出ない");
      assert.equal(await page.locator(".summary-line .lens-badge").count(), 0, "「トーリック」「多焦点」のバッジは出ない");
      assert.equal(await page.locator(".summary-line", { hasText: /トーリック|多焦点/ }).count(), 0);
      assert.equal(await page.locator(".summary-line", { hasText: "手術日" }).count(), 0, "手術日は各レンズに繰り返さない");
      assert.equal(await page.locator("#summaryLines", { hasText: "担当医" }).count(), 0);
      // 見出しの担当医は控えめな色
      const colors = await page.evaluate(() => { const c = (s) => getComputedStyle(document.querySelector(s)).color.match(/\d+/g).map(Number); return { model: c(".summary-model"), doctor: c(".summary-date-head .summary-doctor") }; });
      assert.ok(colors.doctor.reduce((a, b) => a + b) > colors.model.reduce((a, b) => a + b), "Dr. は控えめな色(明るい)");
      // 元のデータは変更されない(表示のみ)
      assert.equal(await page.evaluate(() => JSON.stringify(window.__lines) === window.__before), true);

      // スマホ幅・狭い幅: 横にはみ出さない。レンズの要素が重ならない。長い見出し(長い担当医名)は折り返す
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
        const headOverflow = await page.locator(".summary-date-head").evaluateAll(hs => hs.some(h => h.scrollWidth > h.clientWidth + 1));
        assert.equal(headOverflow, false, `見出しがはみ出す ${w}`);
      }

      // 手術日が1日だけでも同じデザイン(見出し+その下にレンズ)。担当医が違えば見出しが分かれ、同じ担当医なら1つ。レンズ番号はそのまま
      await page.evaluate(() => window.__render(window.__lines.map(l => ({ ...l, surgeryDate: "2099-03-01" }))));
      assert.deepEqual((await page.locator(".summary-date-head").allInnerTexts()).map(h => h.replace(/\s+/g, " ")),
        ["手術日 2099年3月1日(日) Dr. 内田", "手術日 2099年3月1日(日) Dr. 佐藤太郎左衛門", "手術日 2099年3月1日(日) Dr. 山田"]);
      assert.deepEqual(await page.locator(".lens-no-badge").allInnerTexts(), ["レンズ1", "レンズ4", "レンズ5", "レンズ2", "レンズ3"], "担当医の初出順・同じ担当医内は入力順");
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
