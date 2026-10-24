// 回帰テスト(ブラウザ): 「各社 Calculator 関連リンク」。常時の下線なし・右に外部リンクアイコン・青色・ホバー/フォーカスの視覚効果・スマホ幅。  npm run test:browser
// index.html の実際のマークアップ(関連リンクの部分)と styles.css を、最小のページに読み込んで確認する。
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
const START = INDEX.indexOf('<details class="ref-links-accordion">');
const REF = INDEX.slice(START, INDEX.indexOf("</details>", START) + "</details>".length).replace('<details class="ref-links-accordion">', '<details class="ref-links-accordion" open>');
const EXPECTED = [
  ["TECNIS Eyhance Toric Calculator", "https://tecnistoriccalc.com"],
  ["Alcon Online Toric IOL Calculator", "https://www.myalcon-toriccalc.com"],
  ["LENTIS Toric Lens Configulator", "https://www.teleon-toric.com"],
  ["レンティス コンフォート トーリック カリキュレーター", "https://www.santen-iol.jp/SantenSite/"],
  ["ESCRS IOL calculator", "https://iolcalculator.escrs.org"]
];

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<main class="main-content"><form class="order-form"><div class="order-fields"><div class="form-group" id="groupNotes">
<textarea class="form-control" rows="2"></textarea>
${REF}
</div></div></form></main></body></html>`;

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

test("index.html: 旧名称「Alcon Online Toric Calculator」は残っていない。リンク先・別タブの指定は従来どおり", () => {
  assert.ok(!INDEX.includes("Alcon Online Toric Calculator"), "旧名称");
  assert.ok(!fs.readFileSync(path.join(ROOT, "src/ui/lens-lines.js"), "utf8").includes("Alcon Toric Calculator"), "短い名称");
  const links = [...REF.matchAll(/<a href="([^"]+)" target="_blank" rel="noopener" class="ref-link">([^<]*)</g)].map(m => [m[2], m[1]]);
  assert.deepEqual(links, EXPECTED);
});

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`関連リンク: 下線なし・右に外部リンクアイコン・青色・ホバー/フォーカスで下線・スマホ幅: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
      await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.fulfill({ contentType: "text/html", body: "<title>ext</title>" })); // 外部サイトには接続しない
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      const links = page.locator(".ref-links-list a");
      assert.equal(await links.count(), 5);
      assert.deepEqual(await links.evaluateAll(as => as.map(a => [a.textContent.trim(), a.href])), EXPECTED.map(([n, u]) => [n, new URL(u).href]));

      const primary = await page.evaluate(() => { const d = document.createElement("span"); d.style.color = "var(--primary)"; document.body.appendChild(d); return getComputedStyle(d).color; });
      for (let i = 0; i < 5; i++) {
        const a = links.nth(i);
        const st = await a.evaluate(e => { const s = getComputedStyle(e); return { deco: s.textDecorationLine, color: s.color }; });
        assert.equal(st.deco, "none", `常時の下線なし: ${EXPECTED[i][0]}`);
        assert.equal(st.color, primary, "青色(既存の色)を維持");
        assert.equal(await a.locator("svg.ext-icon").count(), 1, "外部リンクアイコン");
        // アイコンはテキストの右(同じ行の末尾)。矢印文字は使わない。別タブ
        const pos = await a.evaluate(e => { const r = document.createRange(); const tn = [...e.childNodes].find(n => n.nodeType === 3); r.selectNodeContents(tn); const tr = r.getBoundingClientRect(), ir = e.querySelector("svg").getBoundingClientRect(); return { iconLeft: ir.left, textRight: tr.right, textLastLineTop: tr.bottom }; });
        assert.ok(pos.iconLeft >= pos.textRight - 1, `アイコンはテキストの右: ${JSON.stringify(pos)}`);
        assert.ok(!(await a.textContent()).includes("↗"));
        assert.equal(await a.getAttribute("target"), "_blank");
        assert.match(await a.getAttribute("rel"), /noopener/);
      }
      // ホバー: 下線(リンクと判別できる)
      await links.nth(1).hover();
      assert.equal(await links.nth(1).evaluate(e => getComputedStyle(e).textDecorationLine), "underline", "ホバーで下線");
      await page.mouse.move(0, 0);
      // キーボードフォーカス: 下線 + フォーカスの枠
      await page.locator(".ref-links-list").evaluate(() => document.activeElement && document.activeElement.blur());
      await page.keyboard.press("Tab");   // キーボード操作にする
      if (name === "webkit") await links.first().focus();   // Safari(WebKit)は、Tab だけではリンクにフォーカスしない設定が既定のため、キーボード操作のあとにフォーカスを当てる
      else { await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); }   // テキストエリア → 見出し(summary) → 最初のリンク
      assert.equal(await page.evaluate(() => document.activeElement.className), "ref-link");
      const fo = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { deco: s.textDecorationLine, outline: s.outlineStyle, w: parseFloat(s.outlineWidth) }; });
      assert.equal(fo.deco, "underline");
      assert.ok(fo.outline !== "none" && fo.w > 0, "フォーカスの枠: " + JSON.stringify(fo));
      // テキストでもアイコンでも、クリックで別タブ
      const [popup] = await Promise.all([context.waitForEvent("page"), links.nth(1).locator("svg").click()]);
      assert.match(popup.url(), /myalcon-toriccalc\.com/);
      await popup.close();
      const [popup2] = await Promise.all([context.waitForEvent("page"), links.nth(4).getByText("ESCRS IOL calculator").click()]);
      assert.match(popup2.url(), /iolcalculator\.escrs\.org/);
      await popup2.close();

      // スマホ幅: 自然に折り返し、横スクロールなし。リンクが枠内
      for (const w of [390, 320]) {
        await page.setViewportSize({ width: w, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `横スクロール ${w}`);
        const out = await links.evaluateAll(as => { const box = document.querySelector(".ref-links-list").getBoundingClientRect(); return as.filter(a => { const r = a.getBoundingClientRect(); return r.right > box.right + 0.5 || r.left < box.left - 0.5; }).length; });
        assert.equal(out, 0, `枠からはみ出す ${w}`);
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
