// 回帰テスト(ブラウザ): 過去の注文との重複確認の警告画面(重複したレンズだけ・2行構成・青いバッジ・確認は1回・スマホ幅)。  npm run test:browser
// index.html の実際のマークアップ(重複確認のモーダル)と styles.css・src/ui/duplicate-warning.js を最小のページで確認する。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const INDEX = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").replace(/\r\n/g, "\n");
const S = INDEX.indexOf('<div class="modal-overlay hidden" id="duplicateModal"');
const MODAL = INDEX.slice(S, INDEX.indexOf("<!-- 確認画面モーダル -->", S)).replace('modal-overlay hidden"', 'modal-overlay"');

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<span class="lens-line-title" id="ref">レンズ1</span>
${MODAL}
<script type="module">
import { renderDuplicateWarning } from "/src/ui/duplicate-warning.js";
window.__show = (dups) => renderDuplicateWarning({ title: document.getElementById("duplicateTitle"), list: document.getElementById("duplicateList") }, dups);
window.__show([
  { lineNo: 1, modelName: "DIB00V", power: "+20.0D", dates: ["2026/10/23", "2026/10/01"] },
  { lineNo: 3, modelName: "国家公務員共済組合専用の長い名前のモデルXYZ-12345", power: "-5.0D", dates: ["2026/09/30"] }
]);
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
  test(`重複確認の警告: 見出し・2行構成・バッジ・複数の注文日・確認は1回・スマホ幅: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);

      assert.equal(await page.locator("#duplicateTitle").innerText(), "過去の注文と一致するレンズが2件あります");
      const lines = page.locator(".dup-line");
      assert.equal(await lines.count(), 2, "重複したレンズだけ");
      // 各レンズは2行: 1行目 [レンズN]バッジ + モデル + 度数(「／」なし) / 2行目 過去の注文日
      assert.deepEqual(await lines.first().locator(".dup-line-main > *").allInnerTexts(), ["レンズ1", "DIB00V", "+20.0D"]);
      assert.equal(await lines.first().locator(".dup-line-date").innerText(), "過去の注文日：2026/10/23、2026/10/01", "複数の過去の注文日");
      assert.equal(await lines.nth(1).locator(".dup-line-main .lens-no-badge").innerText(), "レンズ3", "元のレンズ番号");
      assert.equal(await lines.nth(1).locator(".dup-line-date").innerText(), "過去の注文日：2026/09/30");
      assert.ok(!(await page.locator("#duplicateList").innerText()).includes("／"));
      // バッジは通常の注文フォームと同じデザイン(同じ見た目)。モデルと度数の間は余白
      const look = (sel) => page.locator(sel).first().evaluate(e => { const s = getComputedStyle(e); return [s.backgroundColor, s.color, s.borderRadius, s.fontSize, s.fontWeight, s.borderTopColor]; });
      assert.deepEqual(await look(".dup-line .lens-no-badge"), await look("#ref"), "通常の注文フォームのバッジと同じ");
      const gap = await lines.first().evaluate(l => { const m = l.querySelector(".dup-model").getBoundingClientRect(), p = l.querySelector(".dup-power").getBoundingClientRect(); return p.left - m.right; });
      assert.ok(gap >= 8, `モデルと度数の間の余白 ${gap}`);
      // 最後に確認の問いかけと2つのボタン(確認は1回: 重複が複数でもボタンは1組)
      assert.equal(await page.locator(".dup-question").innerText(), "今回の注文に間違いありませんか？");
      assert.deepEqual(await page.locator("#duplicateModal .modal-footer button").allInnerTexts(), ["注文内容を修正", "確認して続行"]);
      assert.equal(await page.locator("#duplicateModal button").count(), 2);
      const qy = (await page.locator(".dup-question").boundingBox()).y, ly = (await lines.nth(1).boundingBox()).y;
      assert.ok(qy > ly, "問いかけは一覧の後");

      // スマホ幅・狭い幅: モーダルが画面内・横スクロールなし・長いモデル名でも崩れない・ボタンが重ならない
      for (const w of [390, 360, 320]) {
        await page.setViewportSize({ width: w, height: 700 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `横スクロール ${w}`);
        const r = await page.evaluate(() => {
          const rc = (e) => e.getBoundingClientRect(), card = rc(document.querySelector("#duplicateModal .modal-card"));
          const bs = [...document.querySelectorAll("#duplicateModal .modal-footer button")].map(rc);
          const ov = bs[0].left < bs[1].right - 0.5 && bs[1].left < bs[0].right - 0.5 && bs[0].top < bs[1].bottom - 0.5 && bs[1].top < bs[0].bottom - 0.5;
          const mains = [...document.querySelectorAll(".dup-line-main")].map(m => { const b = rc(m); return [...m.children].some(c => rc(c).right > b.right + 0.5); });
          return { inside: card.left >= 0 && card.right <= innerWidth && card.bottom <= innerHeight + 1, ov, mainOut: mains.some(Boolean) };
        });
        assert.deepEqual(r, { inside: true, ov: false, mainOut: false }, `${w}: ${JSON.stringify(r)}`);
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
