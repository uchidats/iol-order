// 回帰テスト(ブラウザ): チェックボックスのチェック済みの色は、すべてサブテーマカラー(--primary)。styles.css の共通の指定1か所で決める。
//   ラジオボタンには影響しない。個別の指定で打ち消さない。大きさ・配置は従来のまま。  npm run test:browser
//   実際の styles.css と src/ui/sub-theme.js を最小のページで動かす(実画面の確認は header-theme・dealer-portal のテスト)。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";
import { readablePrimary } from "../../src/domain/sub-theme.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".js": "text/javascript", ".css": "text/css" };

// 画面ごとのチェックボックスの置かれ方(ラベルの class)。ラジオボタンは比較用
const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head><body>
<label class="dup-ack-check"><input type="checkbox" checked></label>
<label class="orderer-member-opt"><input type="checkbox" checked></label>
<label class="lens-filter-check"><input type="checkbox" checked></label>
<label class="settings-check"><input type="checkbox" checked></label>
<div class="iol-model-row"><label class="settings-check"><input type="checkbox" checked></label></div>
<label class="dealer-remember"><input type="checkbox" checked></label>
<label class="application-notify-reason"><input type="checkbox" checked></label>
<input type="checkbox" checked>
<input type="radio" id="plainRadio" checked>
<label class="quantity-option"><input type="radio" id="qtyRadio" checked></label>
<script type="module">import { applySubTheme } from "/src/ui/sub-theme.js"; window.applySubTheme = applySubTheme; window.__ready = true;</script>
</body></html>`;

let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE); return; }
    const p = path.resolve(ROOT, "." + url);
    if (!p.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(p, (e, b) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": (TYPES[path.extname(p)] || "text/plain") + "; charset=utf-8" });
      res.end(b);
    });
  }).listen(0);
  await new Promise(r => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/`;
});
test.after(() => server.close());

async function launch(type, name) {
  for (const opts of name === "chromium" ? [{}, { channel: "msedge" }, { channel: "chrome" }] : [{}]) {
    try { return await type.launch(opts); } catch { /* 次の候補へ */ }
  }
  return null;
}

const hex = (rgb) => "#" + rgb.match(/\d+/g).slice(0, 3).map(n => Number(n).toString(16).padStart(2, "0")).join("");

test("チェックボックスの色の指定は共通の1か所だけ(色の固定値を使わず、個別に指定しない)", () => {
  const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  assert.deepEqual(css.match(/[^\r\n]*accent-color[^\r\n]*/g), ['input[type="checkbox"] { accent-color: var(--primary); }']);
});

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`チェックボックス: どの画面の部品もサブテーマカラー。未設定は標準の青。ラジオボタンは変えない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      const page = await browser.newPage();
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      const look = () => page.evaluate(() => ({
        checks: [...document.querySelectorAll('input[type="checkbox"]')].map(e => getComputedStyle(e).accentColor),
        radios: [...document.querySelectorAll('input[type="radio"]')].map(e => getComputedStyle(e).accentColor),
        dupSize: (({ width, height }) => [width, height])(document.querySelector(".dup-ack-check input").getBoundingClientRect()),
        memberSize: (({ width, height }) => [width, height])(document.querySelector(".orderer-member-opt input").getBoundingClientRect())
      }));
      for (const [color, expected] of [[null, "#1d4ed8"], ["#be185d", "#be185d"], ["#fff176", readablePrimary("#fff176")]]) {
        await page.evaluate(c => window.applySubTheme(c ? { color: c } : null), color);
        const m = await look();
        assert.equal(m.checks.length, 8);
        m.checks.forEach((c, i) => assert.equal(hex(c), expected, `チェックボックス ${i}(テーマ ${color})`));
        assert.deepEqual(m.radios, ["auto", "auto"], "ラジオボタンは変えない");
        assert.deepEqual(m.dupSize, [18, 18]);
        assert.deepEqual(m.memberSize, [18, 18]);
      }
    } finally { await browser.close(); }
  });
}
