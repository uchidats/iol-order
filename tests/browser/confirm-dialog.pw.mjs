// 回帰テスト(ブラウザ): 確認ダイアログ(confirm-dialog.js。施設の切り替えで使う。ブラウザ標準の confirm は使わない)。
// 既存のモーダルと同じ見た目。ダークモードでも白い背景・黒系の文字。キャンセル・Escape・背景クリックは false、「切り替える」は true。  npm run test:browser
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const MESSAGE = "入力中の内容は破棄されます。施設を切り替えますか？";

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<button type="button" id="opener">施設を切り替える</button>
<script type="module">
import { confirmDialog } from "/src/ui/confirm-dialog.js";
window.__results = [];
window.__open = () => confirmDialog({ message: ${JSON.stringify(MESSAGE)}, okLabel: "切り替える", cancelLabel: "キャンセル" }).then(r => window.__results.push(r));
document.getElementById("opener").addEventListener("click", () => window.__open());
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

test("施設の切り替えでは、ブラウザ標準の confirm を使わない", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");
  assert.ok(!src.includes(`window.confirm(${JSON.stringify(MESSAGE)})`));
  assert.match(src, /confirmDialog\(\{ message: "入力中の内容は破棄されます。施設を切り替えますか？", okLabel: "切り替える", cancelLabel: "キャンセル" \}\)/);
});

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`確認ダイアログ: 文言・ボタン・ダークモードでも白背景・キャンセル/Escape/背景は false・切り替えるは true: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const page = await browser.newPage({ viewport: { width, height: 800 }, colorScheme: "dark" });
        const errors = [], dialogs = [];
        page.on("pageerror", e => errors.push(String(e)));
        page.on("dialog", d => { dialogs.push(d.type()); d.dismiss(); });
        await page.goto(base);
        await page.waitForFunction(() => window.__ready);
        const open = async () => { await page.click("#opener"); await page.waitForSelector(".confirm-dialog"); };

        await open();
        const dlg = page.locator(".confirm-dialog");
        assert.equal(await dlg.locator(".confirm-dialog-message").innerText(), MESSAGE);
        assert.deepEqual(await dlg.locator(".modal-footer button").allInnerTexts(), ["キャンセル", "切り替える"]);
        assert.deepEqual(await dlg.locator(".modal-footer button").evaluateAll(bs => bs.map(b => b.className)), ["btn btn-secondary", "btn btn-primary"], "既存のモーダルと同じボタン");
        const look = await dlg.evaluate(o => { const c = o.querySelector(".modal-card"), m = o.querySelector(".confirm-dialog-message"); return { bg: getComputedStyle(c).backgroundColor, text: getComputedStyle(m).color, scheme: getComputedStyle(o).colorScheme }; });
        assert.deepEqual(look, { bg: "rgb(255, 255, 255)", text: "rgb(31, 41, 55)", scheme: "light" }, `${width}: ダークモードでも白背景・黒系の文字`);
        assert.equal(await page.evaluate(() => document.activeElement.dataset.act), "cancel", "最初のフォーカスはキャンセル");
        const box = await dlg.locator(".modal-card").boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width, `${width}: 画面内に収まる`);

        await dlg.locator('[data-act="cancel"]').click();
        await open();
        await page.keyboard.press("Escape");
        await open();
        await page.mouse.click(5, 5);   // 背景
        await open();
        await page.locator('.confirm-dialog [data-act="ok"]').click();
        assert.deepEqual(await page.evaluate(() => window.__results), [false, false, false, true]);
        assert.equal(await page.locator(".confirm-dialog").count(), 0, "閉じたら残らない");
        assert.equal(await page.evaluate(() => document.body.style.overflow), "", "背景のスクロールを戻す");
        assert.deepEqual(dialogs, [], "ブラウザ標準のダイアログは出ない");
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}
