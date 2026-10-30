// 回帰テスト(ブラウザ): レンズ明細の「枚数」と「手術日」が重ならないこと。Chromium / Firefox / WebKit で確認する。
//   npm run test:browser
// 通常の `npm test`(unit)には含めない。必要なときだけ実行する。
//
// 背景: 枚数ボタンの幅を flex-basis で指定していたため、Firefox / Safari では枚数の欄が78pxに潰れ、
//       80pxのボタンが欄の外へはみ出して手術日に重なった(Chromium では起きない)。
// 準備(初回のみ): npx playwright-core install chromium firefox webkit
//   起動できないブラウザのテストは「skip」にする(Chromium が無い環境では、Edge / Chrome を代わりに使う)。
// 実際の styles.css と src/ui/lens-lines.js を、最小のページに読み込んで測る(ログイン・Firebase は使わない)。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const WIDTHS = [320, 390, 600, 1100];

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/styles.css"></head><body>
<main class="main-content"><form id="iolOrderForm" class="order-form" novalidate><div class="order-fields">
<div id="lensLines" class="lens-lines"></div>
<div class="lens-lines-actions"><button type="button" class="btn btn-secondary" id="btnAddLine">＋ レンズを追加</button></div>
</div></form></main>
<script type="module">
import { createLensLines } from "/src/ui/lens-lines.js";
import { buildLensOptions } from "/src/domain/lens-options.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
const options = buildLensOptions(IOL_MODELS);
window.__ready = createLensLines({
  container: document.getElementById("lensLines"), addButton: document.getElementById("btnAddLine"),
  getOptions: () => options, getDoctors: () => [{ id: "o1", name: "山田" }], minDate: () => "2020-01-01"
});
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
  const attempts = name === "chromium" ? [{}, { channel: "msedge" }, { channel: "chrome" }] : [{}];
  for (const opts of attempts) {
    try { return await type.launch(opts); } catch { /* 次の候補へ */ }
  }
  return null;
}

/** 2つの項目(子要素を含む)の領域が、少しでも重なっているか */
const overlapScript = () => {
  const line = document.querySelector(".lens-line");
  const boxes = (g) => [g, ...g.querySelectorAll("*")]
    .map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
  const q = line.querySelector('[data-group="quantity"]'), d = line.querySelector('[data-group="date"]');
  const hit = [];
  for (const a of boxes(q)) for (const b of boxes(d)) {
    if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) hit.push([Math.round(a.left), Math.round(a.right), Math.round(b.left), Math.round(b.right)]);
  }
  const btns = [...q.querySelectorAll(".quantity-btn")].map(e => e.getBoundingClientRect());
  const qr = q.getBoundingClientRect(), dr = d.getBoundingClientRect();
  return {
    hit, qWidth: qr.width, btnWidths: btns.map(b => Math.round(b.width)), btnHeights: btns.map(b => Math.round(b.height)),
    btnGap: Math.round(btns[1].left - btns[0].right), sameRow: Math.abs(qr.top - dr.top) < 2, rowGap: Math.round(dr.left - qr.right),
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    btnsInsideGroup: btns.every(b => b.left >= qr.left - 0.5 && b.right <= qr.right + 0.5),
    // 項目名を左・ボタンを右(縦の中央揃え)になっているか
    labelBeside: (() => { const l = q.querySelector(".form-label").getBoundingClientRect(); return l.right <= btns[0].left && Math.abs((l.top + l.bottom) / 2 - (btns[0].top + btns[0].bottom) / 2) < 3; })()
  };
};

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`枚数と手術日が重ならない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: WIDTHS[0], height: 900 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForSelector(".lens-line");
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w, height: 900 });
        const r = await page.evaluate(overlapScript);
        const ctx = `${name} ${w}px ${JSON.stringify(r)}`;
        assert.deepEqual(r.hit, [], "要素領域が重なっている: " + ctx);
        assert.deepEqual(r.btnWidths, [80, 80], "枚数ボタンの幅は80px: " + ctx);
        assert.deepEqual(r.btnHeights, [48, 48], "枚数ボタンの高さは48px: " + ctx);
        assert.equal(r.btnGap, 10, "ボタン間隔は10px: " + ctx);
        assert.ok(r.btnsInsideGroup, "ボタンが枚数の欄からはみ出している: " + ctx);
        assert.equal(r.overflowX, false, "横スクロールが出ている: " + ctx);
        if (r.sameRow) assert.equal(r.rowGap, 20, "同じ行のときの間隔は20px: " + ctx);
        // 項目名を左・入力欄を右の配置(スマホ 360px 以上・PC): 枚数の項目名とボタンが同じ行。枚数と手術日は別の行
        if (w >= 360) assert.ok(r.labelBeside && !r.sameRow, "項目名の右にボタン(手術日は次の行): " + ctx);
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
