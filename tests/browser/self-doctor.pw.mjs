// 回帰テスト(ブラウザ): 担当医の初期値(ログインユーザー本人が担当医マスターにいる場合は本人)。  npm run test:browser
// 紐づけはメールアドレス(氏名だけでは判定しない)。本人が選ばれていても変更できる。「レンズを追加」は現在の担当医を引き継ぐ(既存仕様を優先)。
// 実際の styles.css と src/ui/lens-lines.js を最小のページで確認する(ログイン・Firebase は使わない)。
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
<main class="main-content"><form id="iolOrderForm" class="order-form" novalidate><div class="order-fields">
<div id="lensLines" class="lens-lines"></div>
<div class="lens-lines-actions"><button type="button" class="btn btn-secondary" id="btnAddLine">＋ レンズを追加</button></div>
</div></form></main>
<script type="module">
import { createLensLines } from "/src/ui/lens-lines.js";
import { buildLensOptions } from "/src/domain/lens-options.js";
import { findSelfDoctor } from "/src/domain/self-doctor.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
const q = new URLSearchParams(location.search);
const doctors = [{ id: "o1", name: "内田", email: "uchida@example.jp" }, { id: "o2", name: "佐藤", email: "sato@example.jp" }, { id: "o3", name: "山田" }];
const user = q.get("email") === null ? null : { uid: "u1", email: q.get("email"), displayName: q.get("name") || "", emailVerified: q.get("verified") !== "0" };
const options = buildLensOptions(IOL_MODELS);
window.__lines = createLensLines({
  container: document.getElementById("lensLines"), addButton: document.getElementById("btnAddLine"),
  getOptions: () => options, getDoctors: () => doctors, getDefaultDoctorId: () => findSelfDoctor(doctors, user), minDate: () => "2020-01-01"
});
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
  test(`担当医の初期値: 本人が担当医なら本人(変更可)・紐づかなければ従来どおり・追加は引き継ぎ: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      const open = async (qs) => { await page.goto(`${base}?${qs}`); await page.waitForFunction(() => window.__ready); };
      const doctor = (i) => page.locator(".lens-line").nth(i).locator("[data-f=doctor]");

      // 本人が担当医マスターにいる(メールアドレスで紐づく): 初期値は本人。選択肢は従来どおり全員 + 「選択」
      await open("email=UCHIDA@example.jp");
      assert.equal(await doctor(0).inputValue(), "o1");
      assert.deepEqual(await doctor(0).locator("option").allInnerTexts(), ["選択", "内田", "佐藤", "山田"]);
      // 別の医師に変更できる。変更後に「レンズを追加」すると、現在の担当医(変更後)を引き継ぐ(既存仕様を優先)
      await doctor(0).selectOption("o2");
      assert.equal(await doctor(0).inputValue(), "o2");
      await page.click("#btnAddLine");
      assert.equal(await doctor(1).inputValue(), "o2", "追加した明細は現在の担当医を引き継ぐ");
      await doctor(1).selectOption("o3");
      await page.click("#btnAddLine");
      assert.equal(await doctor(2).inputValue(), "o3");
      // 未選択に戻しても(選択)、追加した明細は本人に戻らない(現在の担当医=未選択を引き継ぐ)
      await doctor(2).selectOption("");
      await page.click("#btnAddLine");
      assert.equal(await doctor(3).inputValue(), "");
      // 入力を初期状態に戻す(新しい注文)と、初期値は本人
      await page.evaluate(() => window.__lines.reset());
      assert.equal(await page.locator(".lens-line").count(), 1);
      assert.equal(await doctor(0).inputValue(), "o1");
      // 注文者(ログインユーザー)と担当医は別情報: 他の担当医を選んだ内容も、そのまま values() に入る
      await doctor(0).selectOption("o2");
      assert.equal(await page.evaluate(() => window.__lines.values()[0].doctor.id), "o2");

      // 氏名だけでは判定しない: 氏名が「内田」でも、メールが違う/ない/未確認のユーザーは従来どおり(未選択)
      for (const qs of ["email=nurse@example.jp&name=内田", "name=内田", "email=&name=山田", "email=uchida@example.jp&verified=0", ""]) {
        await open(qs);
        assert.equal(await doctor(0).inputValue(), "", `未選択のまま: ${qs}`);
        await page.click("#btnAddLine");
        assert.equal(await doctor(1).inputValue(), "", `追加も未選択: ${qs}`);
      }
      // メール未登録の医師(山田)のアカウントを、氏名で紐づけない
      await open("email=yamada@example.jp&name=山田");
      assert.equal(await doctor(0).inputValue(), "");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
