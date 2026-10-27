// 回帰テスト(ブラウザ): 注文確認画面の、発注先が2社以上のときのディーラーごとの表示。  npm run test:browser
// 実際の index.html の確認画面(モーダル)をそのまま切り出し、実際の styles.css と src/ui/confirm-lines.js で表示する(ログイン・Firebase は使わない)。
// 1社なら従来の表示のまま / 2社以上はディーラーごとに同じ構成のまとまりを縦に並べ、最後に注文全体の合計を1回。表示のみで、注文データは変えない。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

/** index.html の確認画面の部分(「確認画面モーダル」から次のモーダルの手前まで)。表示した状態にする */
function confirmModalHtml() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const from = html.indexOf("<!-- 確認画面モーダル -->"), to = html.indexOf("<!-- 生体計測結果", from);
  assert.ok(from > 0 && to > from, "index.html の確認画面を切り出せる");
  return html.slice(from, to).replace('class="modal-overlay hidden" id="confirmModal"', 'class="modal-overlay" id="confirmModal"');
}

const PAGE = () => `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
${confirmModalHtml()}
<script type="module">
import { renderConfirmLines, renderDealersCard, renderDealerSections } from "/src/ui/confirm-lines.js";
const $ = (id) => document.getElementById(id);
// order-form.js の showConfirmModal と同じ手順(通常の確認内容を埋めてから、発注先の数で表示を切り替える)
window.__show = (data) => {
  $("summaryFacilityBox").hidden = !data.facilityName;
  $("summaryFacility").textContent = data.facilityName || "";
  $("summaryPartiesRow").classList.toggle("is-dealer-only", !data.facilityName);
  renderConfirmLines($("summaryLines"), data.lines);
  $("summaryTotal").textContent = data.lines.length + "件・合計" + data.totalQuantity + "枚";
  $("summaryNotes").textContent = data.notes || "（なし）";
  renderDealersCard($("summaryDealers"), data.lines);
  return renderDealerSections($("summarySingle"), $("summaryByDealer"), data);
};
window.__ready = true;
</script></body></html>`;

const A = { dealerId: "dA", dealerName: "A商会", dealerOrderEmails: ["a@example.jp"] };
const B = { dealerId: "dB", dealerName: "B医療機器販売株式会社", dealerOrderEmails: [] };   // 発注用メール未登録
const L = (lineNo, dealer, over = {}) => ({ lineNo, manufacturer: "ALCON", modelName: "CNA0T0", power: "+20.0D", quantity: 1, surgeryDate: "2026-10-29", doctor: "内田", isToric: false, isMultifocal: false, ...dealer, ...over });
const data = (lines, over = {}) => ({ facilityName: "A眼科", notes: "右眼から手術", lines, totalQuantity: lines.reduce((s, l) => s + l.quantity, 0), ...over });

let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE()); return; }
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
const text = (loc) => loc.evaluate(e => e.innerText.replace(/\s+/g, " ").trim());
const texts = (loc) => loc.evaluateAll(es => es.map(e => e.innerText.replace(/\s+/g, " ").trim()));

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`確認画面: 1社は従来どおり。2社以上はディーラーごとに同じ構成のまとまりを縦に(番号は入力時のまま・警告はそのまとまりに・合計は最後に1回)。スマートフォン/PC: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await page.goto(base);
        await page.waitForFunction(() => window.__ready);
        const single = page.locator("#summarySingle"), byDealer = page.locator("#summaryByDealer");

        // ---- 1社: 従来の表示のまま(ディーラーごとのまとまりは作らない) ----
        const one = [L(1, A), L(2, A, { doctor: "高橋" }), L(3, A, { surgeryDate: "2026-11-01", quantity: 2 })];
        assert.equal(await page.evaluate((d) => window.__show(d), data(one)), false);
        assert.equal(await single.isVisible(), true);
        assert.equal(await byDealer.isVisible(), false);
        assert.equal(await byDealer.locator("*").count(), 0);
        assert.equal(await text(page.locator("#summaryTotal")), "3件・合計4枚");
        assert.equal(await text(page.locator("#summaryDealers")), "A商会", "1社は名称を1回だけ(レンズ番号なし)");
        assert.deepEqual(await texts(page.locator("#summaryLines .lens-no-badge")), ["レンズ1", "レンズ2", "レンズ3"]);

        // ---- 2社(+同じ手術日・別の担当医、複数レンズ、発注用メール未登録の警告) ----
        const two = [L(1, A), L(2, B, { power: "+21.0D" }), L(3, A, { doctor: "高橋", quantity: 2 }), L(4, B, { surgeryDate: "2026-11-01", power: "+22.0D" })];
        assert.equal(await page.evaluate((d) => window.__show(d), data(two)), true);
        assert.equal(await single.isVisible(), false, "通常の確認内容は隠す");
        const blocks = byDealer.locator(".summary-dealer-block");
        assert.equal(await blocks.count(), 2);
        assert.deepEqual(await blocks.evaluateAll(bs => bs.map(b => b.dataset.dealer)), ["dA", "dB"], "最初に登場した順");
        const [bA, bB] = [blocks.nth(0), blocks.nth(1)];
        // 各まとまり: 従来と同じ順番(明細 → 件数・合計 → 備考 → 発注元・発注先)・同じ部品
        for (const b of [bA, bB]) {
          assert.deepEqual(await b.locator(":scope > .summary-item").evaluateAll(items => items.map(i => i.dataset.part || i.querySelector("[data-part]").dataset.part)), ["lines", "total", "notes", "parties"]);
          assert.equal(await text(b.locator('[data-part="notes"]')), "右眼から手術", "共通備考は各まとまりに同じ内容");
          assert.equal(await text(b.locator('[data-part="facility"]')), "A眼科");
        }
        assert.deepEqual(await texts(bA.locator(".lens-no-badge")), ["レンズ1", "レンズ3"], "番号は入力時のまま");
        assert.deepEqual(await texts(bA.locator(".summary-date-head")), ["手術日 2026年10月29日(木) 内田Dr", "手術日 2026年10月29日(木) 高橋Dr"], "同じ手術日でも担当医ごとに分ける");
        assert.equal(await text(bA.locator('[data-part="total"]')), "2件・合計3枚");
        assert.equal(await text(bA.locator('[data-part="dealers"]')), "A商会");
        assert.deepEqual(await texts(bB.locator(".lens-no-badge")), ["レンズ2", "レンズ4"]);
        assert.deepEqual(await texts(bB.locator(".summary-date-head")), ["手術日 2026年10月29日(木) 内田Dr", "手術日 2026年11月1日(日) 内田Dr"]);
        assert.equal(await text(bB.locator('[data-part="total"]')), "2件・合計2枚");
        assert.equal(await text(bB.locator(".summary-dealer-name")), "B医療機器販売株式会社");
        assert.equal(await text(bB.locator(".summary-dealer-warning")), "発注用メール未登録のため自動送信不可", "警告はそのディーラーのまとまりの中");
        assert.equal(await bA.locator(".summary-dealer-warning").count(), 0);
        assert.equal(await byDealer.locator(".summary-dealer-lenses").count(), 0, "「レンズ1・レンズ3」のような対応表は出さない");
        // 注文全体の件数・合計は最後に1回だけ。タイトル・ボタンは全体で1組
        assert.equal(await text(byDealer.locator(".summary-grand-total")), "注文全体 4件・合計5枚");
        assert.equal(await byDealer.locator(":scope > :last-child").getAttribute("class"), "summary-grand-total");
        assert.equal(await page.locator(".modal-title").count(), 1);
        assert.equal(await text(page.locator(".modal-title")), "注文内容の確認");
        assert.deepEqual([await page.locator("#btnModalBack:visible").count(), await page.locator("#btnModalSubmit:visible").count()], [1, 1]);
        // ID は重複しない(まとまりは ID を持たない複製)
        assert.equal(await page.evaluate(() => { const ids = [...document.querySelectorAll("[id]")].map(e => e.id); return ids.length === new Set(ids).size; }), true);
        // 縦に並ぶ(スマホも横スクロールなし)
        const [r1, r2] = [await bA.boundingBox(), await bB.boundingBox()];
        assert.ok(r2.y >= r1.y + r1.height, `${width}: ディーラーのまとまりは縦に並ぶ`);
        assert.ok(await page.evaluate(() => { const m = document.querySelector(".modal-body"); return m.scrollWidth <= m.clientWidth && document.documentElement.scrollWidth <= innerWidth; }), `${width}: 横にはみ出さない`);

        // ---- 備考なし・発注元なし・発注先未設定の明細が混在 ----
        const mixed = [L(1, B), L(2, { dealerId: "", dealerName: "", dealerOrderEmails: [] }, { power: "+18.0D" }), L(3, A)];
        await page.evaluate((d) => window.__show(d), data(mixed, { notes: "", facilityName: "" }));
        assert.deepEqual(await blocks.evaluateAll(bs => bs.map(b => b.dataset.dealer)), ["dB", "", "dA"]);
        assert.deepEqual(await texts(byDealer.locator('[data-part="notes"]')), ["（なし）", "（なし）", "（なし）"]);
        assert.equal(await text(blocks.nth(1).locator(".summary-dealer-name")), "未設定");
        assert.equal(await blocks.nth(1).locator(".summary-dealer-warning").count(), 0, "未設定は名前の欄に「未設定」と出す(従来の表示と同じ)");
        assert.equal(await blocks.nth(0).locator('[data-part="facilityBox"]').isVisible(), false, "発注元がなければ出さない");
        assert.equal(await text(byDealer.locator(".summary-grand-total")), "注文全体 3件・合計3枚");

        // ---- 2社 → 1社に戻すと、従来の表示に戻る ----
        await page.evaluate((d) => window.__show(d), data(one));
        assert.equal(await single.isVisible(), true);
        assert.equal(await byDealer.isVisible(), false);
        assert.equal(await byDealer.locator("*").count(), 0);
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}
