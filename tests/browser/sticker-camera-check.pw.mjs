// 回帰テスト(ブラウザ): R09 の実機検証のページ(sticker-camera-check.html)。仮想カメラで撮影し、解像度・JPEG の大きさ・鮮鋭度・拡大表示・
// 写真ライブラリの記録・まとめが出ること。画像を送信しない(このページは自分の静的ファイルを GET するだけ)。  npm run test:browser
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
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

// 仮想カメラ: Chromium は起動の引数、Firefox は設定。WebKit は仮想カメラがないため、ファイル選択の方式だけを確かめる
const LAUNCH = {
  chromium: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  firefox: { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true, "permissions.default.camera": 1 } },
  webkit: {}
};
async function launch(type, name) {
  for (const opts of name === "chromium" ? [{}, { channel: "msedge" }, { channel: "chrome" }] : [{}]) {
    try { return await type.launch({ ...LAUNCH[name], ...opts }); } catch { /* 次の候補へ */ }
  }
  return null;
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`撮影品質の確認ページ: 撮影 → 解像度・大きさ・鮮鋭度・拡大・ライブラリの記録・まとめ。送信しない。スマホ/PC: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 900 }, ...(name === "chromium" ? { permissions: ["camera"] } : {}) });
      const page = await context.newPage();
      const errors = [], requests = [];
      page.on("pageerror", e => errors.push(String(e)));
      page.on("request", r => requests.push([r.method(), r.url()]));
      await page.goto(`${base}sticker-camera-check.html`);
      await page.locator("#ccSummary").waitFor();
      assert.match(await page.inputValue("#ccSummary"), /^端末: /);

      // 1) ブラウザのカメラ(Chromium・Firefox の仮想カメラ)
      if (name !== "webkit") {
        await page.click("#ccStart");
        await page.waitForFunction(() => !document.getElementById("ccShot").disabled || /起動できません/.test(document.getElementById("ccCamMsg").textContent), null, { timeout: 15000 });
        const started = await page.locator("#ccShot").isEnabled();
        if (started) {
          assert.match(await page.locator("#ccCamInfo").innerText(), /映像の解像度\s+\d+×\d+/);
          await page.click("#ccShot");
          await page.locator('[data-result="1"]').waitFor({ timeout: 15000 });
          const card = page.locator('[data-result="1"]');
          assert.match(await card.innerText(), /ブラウザのカメラ\(映像の1コマ\)/);
          assert.match(await card.innerText(), /解像度\s+\d+×\d+/);
          assert.match(await card.innerText(), /JPEG の大きさ\s+\d+\.\d\d MB/);
          assert.match(await card.innerText(), /鮮鋭度\s+[\d.]+\((ピンぼけの疑い|問題なし)\)/);   // 仮想カメラの映像は単純な絵柄なので、どちらにもなりうる
          assert.equal(await card.locator("img").evaluate(i => i.src.startsWith("blob:")), true, "画像はページのメモリ(blob:)だけ");
          await card.locator('[data-zoom-mode="100"]').click();
          assert.equal(await card.locator(".cc-zoom").getAttribute("data-zoom"), "100");
          await card.locator('input[value="残っていない"]').check();
          assert.match(await page.inputValue("#ccSummary"), /#1 ブラウザのカメラ\(映像の1コマ\): \d+×\d+.* ライブラリ: 残っていない/);
          await page.click("#ccStop");
          assert.equal(await page.locator("#ccShot").isDisabled(), true);
        } else {
          t.diagnostic(`${name}: 仮想カメラを起動できない環境(ファイル選択の方式だけを確認)`);
        }
      }

      // 2) ファイル選択の方式(全ブラウザ): ページの中で作った JPEG を選ぶ
      const jpeg = await page.evaluate(async () => {
        const c = document.createElement("canvas"); c.width = 640; c.height = 480;
        const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 640, 480); g.fillStyle = "#000"; g.font = "28px sans-serif";
        for (let i = 0; i < 10; i++) g.fillText("DIB00V +21.0D SN 1234567890", 20, 40 + i * 44);
        const b = await new Promise(r => c.toBlob(r, "image/jpeg", 0.92));
        return Array.from(new Uint8Array(await b.arrayBuffer()));
      });
      await page.setInputFiles("#ccFileInput", { name: "sticker.jpg", mimeType: "image/jpeg", buffer: Buffer.from(jpeg) });
      const fileCard = page.locator(".cc-card[data-result]").first();
      await page.waitForFunction(() => /ファイル選択/.test(document.querySelector(".cc-card[data-result]")?.innerText || ""));
      assert.match(await fileCard.innerText(), /解像度\s+640×480/);
      assert.match(await fileCard.innerText(), /鮮鋭度\s+[\d.]+\(問題なし\)/, "文字の画像はくっきり");
      assert.match(await page.inputValue("#ccSummary"), /ファイル選択\(image\/jpeg\): 640×480/);

      // 結果を消す
      await page.click("#ccClear");
      assert.equal(await page.locator(".cc-card[data-result]").count(), 0);
      assert.ok(!/#\d+ /.test(await page.inputValue("#ccSummary")));
      // PC 幅でもはみ出さない
      await page.setViewportSize({ width: 1100, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

      // 送信しない: 自分の静的ファイルの GET だけ(blob: は数えない)
      const sent = requests.filter(([m, u]) => !u.startsWith("blob:") && !u.startsWith("data:") && (m !== "GET" || !u.startsWith(base)));
      assert.deepEqual(sent, [], "外部への通信・POST はない");
      assert.deepEqual(errors, []);
      await context.close();
    } finally { await browser.close(); }
  });
}
