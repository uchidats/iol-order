// 回帰テスト(ブラウザ): ログイン画面の「Googleでログイン」・メールアドレス欄・「ログインリンクを送信」は高さ 40px。
//   高さだけの変更で、横幅・文字サイズ・左右の余白・項目の間隔はそのまま。ログイン画面の外の .btn・.form-control には影響しない。
//   実際の注文画面(index.html・main.js)を偽の Firebase で、未ログインの状態で動かす。スマホ幅・PC幅。  npm run test:browser
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";
import { newFakeContext } from "./fake-firebase.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/app") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(path.join(ROOT, "index.html"))); return; }
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

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`ログイン画面: ボタン・入力欄の高さは 40px。横幅・文字・余白・間隔は変えず、ほかの画面に影響しない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      for (const [width, inputWidth] of [[390, 324], [1100, 574]]) {   // 左の色の線(4px)を 1px の枠にした分、3px 広い
        const context = await newFakeContext(browser, base, width, null);
        const page = await context.newPage();
        await page.goto(`${base}app`);
        await page.locator("#btnAuthGoogle").waitFor();
        await page.click("#btnAuthEmailToggle");
        const m = await page.evaluate(() => {
          const el = id => document.getElementById(id);
          const box = e => e.getBoundingClientRect();
          const info = e => { const c = getComputedStyle(e); return { h: box(e).height, w: box(e).width, font: c.fontSize, pad: [c.paddingLeft, c.paddingRight] }; };
          const google = el("btnAuthGoogle"), input = el("authEmailInput"), send = el("btnAuthEmailLink");
          const label = document.getElementById("btnAuthEmailToggle"), desc = document.querySelector(".auth-signin .feature-desc");
          // ログイン画面の外の部品は従来の大きさのまま
          const outside = document.createElement("div");
          outside.innerHTML = '<button type="button" class="btn btn-secondary">他</button><input class="form-control">';
          document.body.append(outside);
          const r = {
            google: info(google), input: info(input), send: info(send),
            gaps: [box(google).top - box(desc).bottom, box(label).top - box(google).bottom, box(input).top - box(label).bottom, box(send).top - box(input).bottom],
            outside: [...outside.children].map(e => box(e).height)
          };
          outside.remove();
          return r;
        });
        for (const k of ["google", "input", "send"]) {
          assert.equal(m[k].h, 40, `${k} の高さ(幅 ${width})`);
          assert.equal(m[k].font, "16px", `${k} の文字サイズ`);
        }
        assert.deepEqual(m.google.pad, ["20px", "20px"]);
        assert.deepEqual(m.send.pad, ["20px", "20px"]);
        assert.deepEqual(m.input.pad, ["14px", "14px"]);
        assert.equal(m.input.w, inputWidth, "入力欄の横幅(カードの左の線の変更の分だけ広い)");
        assert.ok(Math.abs(m.google.w - 177.4) < 3 && Math.abs(m.send.w - 202) < 3, "ボタンの横幅は変えない");
        [14, 24, 8, 12].forEach((gap, i) => assert.ok(Math.abs(m.gaps[i] - gap) < 0.1, `項目の間隔 ${i}: ${m.gaps[i]}`));
        m.outside.forEach(h => assert.ok(h >= 48, `ログイン画面の外の部品は従来の高さ: ${h}`));
        // 入力できること(高さを詰めても文字が隠れない)
        await page.locator("#authEmailInput").fill("user@example.jp");
        assert.equal(await page.locator("#authEmailInput").inputValue(), "user@example.jp");
        await context.close();
      }
    } finally { await browser.close(); }
  });
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`ログイン画面: 左の色の線はなく、「メールでログイン」は初期は閉じる。見出しで開閉し、Google は常に出す: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      for (const width of [390, 1100]) {
        const context = await newFakeContext(browser, base, width, null);
        const page = await context.newPage();
        await page.goto(`${base}app`);
        await page.locator("#btnAuthGoogle").waitFor();
        const toggle = page.locator("#btnAuthEmailToggle"), input = page.locator("#authEmailInput"), send = page.locator("#btnAuthEmailLink");
        const card = await page.locator("#authPanel").evaluate(e => { const c = getComputedStyle(e); return [c.borderLeftWidth, c.borderLeftColor === c.borderTopColor, c.borderTopWidth, c.borderRadius, c.backgroundColor]; });
        assert.deepEqual(card.slice(0, 3), ["1px", true, "1px"], `${width}: 左の色の線なし`);
        assert.notEqual(card[3], "0px", "角丸はそのまま");
        assert.equal(card[4], "rgb(255, 255, 255)", "背景はそのまま");
        assert.equal(await toggle.innerText(), "メールでログイン");
        assert.ok(!(await page.locator("#authPanel").innerText()).includes("パスワード不要"));
        assert.equal(await toggle.evaluate(e => getComputedStyle(e, "::after").content), '"∨"');
        assert.deepEqual([await toggle.getAttribute("aria-expanded"), await input.isVisible(), await send.isVisible(), await page.isVisible("#btnAuthGoogle")], ["false", false, false, true], "初期は閉じる");
        const box = await toggle.boundingBox(), panel = await page.locator(".auth-signin").boundingBox();
        assert.ok(Math.abs(box.width - panel.width) < 1, "見出し全体が開閉のボタン");
        await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);   // 見出しの右端でも開く
        assert.deepEqual([await toggle.getAttribute("aria-expanded"), await input.isVisible(), await send.isVisible()], ["true", true, true]);
        assert.equal(await toggle.evaluate(e => getComputedStyle(e, "::after").content), '"∧"');
        await toggle.click();
        assert.deepEqual([await toggle.getAttribute("aria-expanded"), await input.isVisible(), await page.isVisible("#btnAuthGoogle")], ["false", false, true]);
        await context.close();
      }
    } finally { await browser.close(); }
  });
}
