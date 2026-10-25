// 回帰テスト(ブラウザ): 注文履歴の一覧・詳細(新旧データ)。Chromium / Firefox / WebKit。  npm run test:browser
// 実際の styles.css と src/ui/order-history.js を最小のページに読み込み、偽のリポジトリで表示する(ログイン・Firebase は使わない)。
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
<main class="main-content"></main>
<script type="module">
import { createOrderHistory } from "/src/ui/order-history.js";
const item = (o = {}) => ({ manufacturer: "J&J", model: "DIB00V", displayName: "J&J / DIB00V", isToric: false, isMultifocal: false, toricModel: "", power: "+20.0D", quantity: 1, ...o });
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });
const orders = [
  { id: "old", orderNumber: "IOL-20260801-0001", createdAt: ts("2026-08-01T00:00:00Z"), item: item(), surgeryDate: "2026-09-01", orderer: { id: "o9", name: "最古注文者" } },
  { id: "new", schemaVersion: 3, orderNumber: "IOL-20261025-0001", createdAt: ts("2026-10-25T05:30:00Z"), testOrder: true, status: "accepted", notes: "午前の手術分\\n2行目",
    createdBy: { email: "login@example.jp", displayName: "ログイン太郎" },
    lines: [
      { lineNo: 1, item: item(), surgeryDate: "2026-11-10", doctor: { id: "o1", name: "山田" }, dealer: { id: "d1", name: "A商会" } },
      { lineNo: 2, item: item({ model: "DIWxxx (トーリック)", displayName: "J&J / DIWxxx (トーリック)", isToric: true, toricModel: "DIW300", power: "+18.5D", quantity: 2 }),
        surgeryDate: "2026-11-12", doctor: { id: "o2", name: "佐藤" }, dealer: null } ] },
  { id: "mid", orderNumber: "IOL-20260901-0002", createdAt: ts("2026-09-01T00:00:00Z"), orderer: { id: "o9", name: "旧注文者" }, createdBy: { email: "x@example.jp" },
    lines: [{ lineNo: 1, item: item({ quantity: 2 }), surgeryDate: "2026-10-01", dealer: null }] }
];
window.__closed = 0;
window.__asked = [];
window.__h = createOrderHistory({ mount: document.querySelector("main"), onClose: () => { window.__closed++; },
  repository: { listOrders: async (fid, limit) => { window.__asked.push([fid, limit]); if (window.__defer && window.__defer[fid]) return window.__defer[fid]; return orders; } } });
await window.__h.open({ id: "f1", name: "テスト施設" });
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

const lateOrder = { id: "late", orderNumber: "IOL-LATE-0001", createdAt: { seconds: 1, nanoseconds: 0 }, item: { manufacturer: "X", model: "LATE", displayName: "X / LATE", power: "+1.0D", quantity: 1 }, surgeryDate: "2026-12-01" };

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`注文履歴: 一覧(新しい順)と詳細(新旧データ): ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      assert.deepEqual(await page.evaluate(() => window.__asked), [["f1", 50]], "選択中の施設の注文だけを問い合わせる");
      const rows = await page.locator(".history-row").evaluateAll(rs => rs.map(r => r.innerText.replace(/\s+/g, " ").trim()));
      assert.equal(rows.length, 3);
      assert.match(rows[0], /2026\/10\/25 14:30.*ログイン太郎.*2件・合計3枚.*テスト/);
      assert.match(rows[1], /2026\/09\/01 09:00.*x@example\.jp.*1件・合計2枚/);
      assert.match(rows[2], /2026\/08\/01 09:00.*（不明）.*1件・合計1枚/);
      for (const w of [320, 390, 1100]) {
        await page.setViewportSize({ width: w, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `横スクロール ${w}`);
      }
      // 詳細(現行形式): 明細ごとに担当医・発注先が異なる
      await page.locator('[data-order="new"]').click();
      const lines = await page.locator(".history-line").evaluateAll(ls => ls.map(l => l.innerText.replace(/\s+/g, " ").trim()));
      assert.equal(lines.length, 2);
      assert.match(lines[0], /レンズ1 J&J DIB00V \+20\.0D 1枚.*手術日 2026年11月10日.*担当医 山田 ・ 発注先 A商会/);
      assert.match(lines[1], /レンズ2 J&J DIW300 トーリック \+18\.5D 2枚.*手術日 2026年11月12日.*担当医 佐藤 ・ 発注先未設定/);
      assert.match(await page.locator(".history-total").innerText(), /2件・合計3枚/);
      assert.equal(await page.locator(".history-status").innerText(), "状態 受付済み（ディーラー未通知）");
      assert.equal(await page.locator(".history-notes p").innerText(), "午前の手術分\n2行目", "保存済みの備考(改行を保持)");
      assert.equal(await page.locator(".history-notifications").count(), 0, "メール送信の記録がない注文には出さない");
      // 詳細(旧形式): orderer が担当医として出る
      await page.click('[data-act="back"]');
      await page.locator('[data-order="mid"]').click();
      assert.match(await page.locator(".history-line").first().innerText(), /担当医 旧注文者 ・ 発注先未設定/);
      assert.equal(await page.locator(".history-notes p").innerText(), "（なし）");
      await page.click('[data-act="back"]');
      await page.locator('[data-order="old"]').click();
      assert.match(await page.locator(".history-line").first().innerText(), /担当医 最古注文者/);
      // 閲覧のみ: 編集・削除・再注文の操作は無い。戻るボタンで onClose
      const actions = await page.locator("#orderHistory button").allInnerTexts();
      assert.ok(!actions.some(a => /削除|編集|再注文|キャンセル/.test(a)), actions.join("|"));
      await page.click("#btnHistoryClose");
      assert.equal(await page.evaluate(() => window.__closed), 1);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`注文履歴: 読み込み中に施設を切り替えても・閉じても、古い施設の結果を表示しない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      // 施設f-oldの読み込みが遅れている間に、別の施設f-newを開く → 遅れて届いたf-oldの結果は捨てる
      await page.evaluate(async (late) => {
        let release; window.__defer = { "f-old": new Promise(r => { release = r; }) };
        const first = window.__h.open({ id: "f-old", name: "古い施設" });
        await window.__h.open({ id: "f-new", name: "新しい施設" });
        release([late]);
        await first;
      }, lateOrder);
      assert.equal(await page.locator(".settings-facility").innerText(), "新しい施設");
      assert.equal(await page.locator(".history-row").count(), 3, "新しい施設の注文だけ");
      assert.equal(await page.locator('[data-order="late"]').count(), 0, "古い施設の注文は出ない");
      // 読み込み中に画面を閉じる → 遅れて届いた結果で再描画しない(閉じたまま)
      await page.evaluate(async (late) => {
        let release; window.__defer = { "f-slow": new Promise(r => { release = r; }) };
        const p = window.__h.open({ id: "f-slow", name: "遅い施設" });
        window.__h.close();
        release([late]);
        await p;
      }, lateOrder);
      assert.equal(await page.locator("#orderHistory").isHidden(), true);
      assert.equal(await page.locator('[data-order="late"]').count(), 0);
    } finally { await browser.close(); }
  });
}
