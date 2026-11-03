// 回帰テスト(ブラウザ): 注文フォームのレンズの単一行の入力・選択欄(IOLモデル・IOLパワー・枚数・手術日・担当医・発注先)の高さが 40px にそろうこと。
// スマホ(独自の選択ボックス)・PC(ネイティブの select)とも。Chromium / Firefox / WebKit で確認する。
//   npm run test:browser
// 準備(初回のみ): npx playwright-core install chromium firefox webkit(起動できないブラウザは skip)
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
const WIDTHS = [320, 360, 390, 430, 600, 1100];
const FIELD_H = 40;

// 発注先を選ぶ欄が出るように、登録ディーラーは2社
const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/styles.css"></head><body>
<main class="main-content"><form id="iolOrderForm" class="order-form" novalidate><div class="order-fields">
<div id="lensLines" class="lens-lines"></div>
<div class="lens-lines-actions"><button type="button" class="btn btn-secondary" id="btnAddLine">＋ レンズを追加</button></div>
<div class="form-group" id="groupNotes"><label for="notesInput" class="form-label">備考</label><textarea id="notesInput" class="form-control textarea-field" rows="3"></textarea></div>
</div></form></main>
<script type="module">
import { createLensLines } from "/src/ui/lens-lines.js";
import { buildLensOptions } from "/src/domain/lens-options.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
const options = buildLensOptions(IOL_MODELS);
window.__ready = createLensLines({
  container: document.getElementById("lensLines"), addButton: document.getElementById("btnAddLine"),
  getOptions: () => options, getDoctors: () => [{ id: "o1", name: "山田" }, { id: "o2", name: "佐藤" }],
  getDealers: () => [{ id: "d1", name: "ディーラーA" }, { id: "d2", name: "ディーラーB" }], minDate: () => "2020-01-01"
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

/** 各項目の、画面に見えている入力・選択欄の高さ・幅・文字サイズ(スマホは独自の選択ボックス、PC はネイティブの select) */
const measureScript = () => {
  const line = document.querySelector(".lens-line");
  const shown = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden" && getComputedStyle(e).opacity !== "0";
  const ctl = (g) => {
    const grp = line.querySelector(`[data-group="${g}"]`);
    if (g === "quantity") return [...grp.querySelectorAll(".quantity-btn")];
    if (g === "date") return [grp.querySelector('input[type="date"]')];
    const trig = grp.querySelector(".cs-trigger");
    return [shown(trig) ? trig : grp.querySelector("select")];
  };
  const out = {};
  for (const g of ["model", "power", "quantity", "date", "doctor", "dealer"]) {
    out[g] = ctl(g).map(e => { const r = e.getBoundingClientRect(), c = getComputedStyle(e); return { h: Math.round(r.height * 10) / 10, w: Math.round(r.width), fs: c.fontSize, tag: e.tagName.toLowerCase() + (e.classList.contains("cs-trigger") ? ".cs" : "") }; });
  }
  // 項目の縦の間隔(次の項目の上端 − この項目の下端。同じ行は除く)
  const groups = [...line.querySelectorAll(".lens-row > .form-group, .lens-line-body > .form-group, [data-group]")].filter((g, i, a) => g.dataset.group && a.indexOf(g) === i && shown(g));
  out.gaps = [];
  for (let i = 0; i + 1 < groups.length; i++) {
    const a = groups[i].getBoundingClientRect(), b = groups[i + 1].getBoundingClientRect();
    if (b.top >= a.bottom - 0.5) out.gaps.push(`${groups[i].dataset.group}>${groups[i + 1].dataset.group}:${Math.round(b.top - a.bottom)}`);
  }
  out.notesH = Math.round(document.getElementById("notesInput").getBoundingClientRect().height);
  // 「＋ レンズを追加」: 高さ・幅・見た目(背景・枠線・角丸・文字サイズ)と、文字の縦の中央
  const add = document.getElementById("btnAddLine"), ar = add.getBoundingClientRect(), ac = getComputedStyle(add);
  const rg = document.createRange(); rg.selectNodeContents(add); const tr = rg.getBoundingClientRect();
  out.add = { h: Math.round(ar.height * 10) / 10, w: Math.round(ar.width * 10) / 10, fs: ac.fontSize, bg: ac.backgroundColor, bd: ac.borderTopWidth + " " + ac.borderTopColor, rad: ac.borderTopLeftRadius,
    center: Math.round(((tr.top + tr.bottom) / 2 - (ar.top + ar.bottom) / 2) * 10) / 10, oneLine: tr.height < 30 };
  out.overflowX = document.documentElement.scrollWidth > document.documentElement.clientWidth;
  return out;
};

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`注文フォームの単一行の入力・選択欄は高さ40px(スマホ・PC): ${name}`, async (t) => {
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
        await page.waitForTimeout(250);   // transition(0.15s)が終わってから測る
        const r = await page.evaluate(measureScript);
        if (process.env.MEASURE) console.log(name, w, JSON.stringify(r));
        const ctx = `${name} ${w}px ${JSON.stringify(r)}`;
        for (const g of ["model", "power", "quantity", "date", "doctor", "dealer"]) {
          assert.ok(r[g].length > 0 && r[g].every(x => Math.abs(x.h - FIELD_H) < 0.6), `${g} の高さは ${FIELD_H}px: ` + ctx);
        }
        assert.ok(r.notesH > FIELD_H + 20, "備考(複数行)は対象外のまま: " + ctx);
        assert.equal(r.add.h, FIELD_H, "「＋ レンズを追加」は高さ40px: " + ctx);
        assert.ok(r.add.w >= 157 && r.add.w <= 158, "「＋ レンズを追加」の幅は従来のまま(約157px): " + ctx);
        assert.ok(Math.abs(r.add.center) <= 1 && r.add.oneLine, "「＋ レンズを追加」の文字は1行で縦の中央: " + ctx);
        assert.deepEqual([r.add.fs, r.add.rad, r.add.bg], ["16px", "10px", "rgb(241, 245, 249)"], "背景・角丸・文字サイズは従来のまま: " + ctx);
        assert.equal(r.overflowX, false, "横スクロールが出ない: " + ctx);
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
