// 回帰テスト(ブラウザ): IOL シール写真の印刷(台紙・QR のみ)。実際の styles.css と施設設定の項目を、偽の API で動かす
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<main class="main-content"><p id="behind">後ろの画面</p></main>
<script type="module">
import { createStickerSettingsSection } from "/src/ui/sticker-settings-section.js";
const q = new URLSearchParams(location.search);
const dealers = { one: [{ id: "dA", name: "栗原 立川", mailName: "栗原医療器械店　立川支店" }], two: [{ id: "dA", name: "A商会" }, { id: "dB", name: "B医療", mailName: "B医療株式会社" }], none: [] }[q.get("dealers") || "one"];
window.__calls = []; window.__printed = 0; window.__qrGen = 0;
window.print = () => { window.__printed += 1; };
const svg = () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" data-gen="' + window.__qrGen + '"><rect width="10" height="10"/></svg>';
const api = {
  getSettings: async (f) => { window.__calls.push(["getSettings", f]); return { accessCodeSet: true, accessCodeUpdatedAt: "2026-11-02T15:30:00.000Z", entryIssued: true, dealers: [] }; },
  setAccessCode: async () => { window.__calls.push(["setAccessCode"]); return { ok: true }; },
  getEntryQr: async (f) => { window.__calls.push(["getEntryQr", f]); if (window.__failQr) throw Object.assign(new Error("この施設の写真を操作する権限がありません"), { code: "functions/permission-denied" }); return { svg: svg() }; },
  rotateEntryQr: async (f) => { window.__calls.push(["rotateEntryQr", f]); window.__qrGen += 1; return { svg: svg() }; },
  setDealerShare: async () => { window.__calls.push(["setDealerShare"]); return { ok: true }; }
};
const section = createStickerSettingsSection({ api, getDealers: () => dealers, confirm: async () => true });
document.querySelector("main").append(section);
await section._render("fA", q.get("name") || "立川病院　眼科");
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
test.after(() => server.close());

async function launch(type, name) {
  for (const opts of name === "chromium" ? [{}, { channel: "msedge" }, { channel: "chrome" }] : [{}]) {
    try { return await type.launch(opts); } catch { /* 次の候補へ */ }
  }
  return null;
}
async function openPage(browser, query = "", width = 390) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${base}${query}`);
  await page.waitForFunction(() => window.__ready);
  return page;
}
/** 印刷は QR のモーダルから開く */
const openPrint = async (page, act) => {
  await page.click('[data-act="showQr"]');
  await page.click(`.sticker-qr-dialog [data-act="${act}"]`);
  await page.waitForSelector('.sticker-print-view [data-act="print"]:not([disabled])');
};
const headerLines = (page) => page.locator('[data-f="header"]').allTextContents();
const MM = 96 / 25.4;

/** 印刷の出力を PDF にして、ページ数と用紙の大きさ(pt)を読む */
async function pdfInfo(page) {
  const file = path.join(os.tmpdir(), `sticker-print-${process.pid}-${Date.now()}.pdf`);
  await page.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
  const raw = fs.readFileSync(file).toString("latin1");
  fs.unlinkSync(file);
  const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(raw);
  return { pages: (raw.match(/\/Type\s*\/Page[^s]/g) || []).length, width: Number(box[1]), height: Number(box[2]) };
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`台紙を印刷: 見本に上部の表示・QR・10枠を出し、印刷できる: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      const page = await openPage(browser);
      await openPrint(page, "printSheet");
      assert.deepEqual(await headerLines(page), ["立川病院　眼科　→　栗原医療器械店　立川支店"]);
      assert.equal(await page.locator(".sticker-print-svg image").count(), 1);
      assert.equal(await page.locator(".sticker-print-svg text", { hasText: "／" }).count(), 10);
      assert.equal(await page.locator('[data-f="sheetDealer"]').count(), 0, "1社なら選択を出さない");
      await page.click('[data-act="print"]');
      assert.equal(await page.evaluate(() => window.__printed), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "見本は画面の幅に収まる");
      await page.close();
    } finally { await browser.close(); }
  });

  test(`QRコードのみ印刷: 8枚と切り取り線を出し、台紙とは別の操作: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      const page = await openPage(browser);
      await openPrint(page, "printQr");
      assert.equal(await page.locator(".sticker-print-svg image").count(), 8);
      assert.equal(await page.locator('.sticker-print-svg line[stroke-dasharray]').count(), 4);
      assert.equal(await page.locator('[data-f="sheetHeader"]').count(), 0, "編集欄は台紙だけ");
      assert.equal(await page.locator(".sticker-print-svg text", { hasText: "／" }).count(), 0);
      const text = await page.locator(".sticker-print-svg").textContent();
      assert.ok(text.includes("立川病院") && text.includes("IOLシール写真"));
      assert.ok(!/https?:|sticker\.html|コード/.test(text), "URL・アクセスコードを載せない");
      await page.close();
    } finally { await browser.close(); }
  });
}

test("印刷の出力: 台紙も QR のみも A4 の1ページで、実寸(210×297mm)で出る", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    for (const act of ["printSheet", "printQr"]) {
      const page = await openPage(browser);
      await openPrint(page, act);
      const info = await pdfInfo(page);
      assert.equal(info.pages, 1, act);
      assert.ok(Math.abs(info.width - 595.28) < 1 && Math.abs(info.height - 841.89) < 1, JSON.stringify(info));
      await page.emulateMedia({ media: "print" });
      const size = await page.locator(".sticker-print-svg").evaluate(e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
      assert.ok(Math.abs(size[0]) < 0.5 && Math.abs(size[1]) < 0.5, "用紙の左上から");
      assert.ok(Math.abs(size[2] - 210 * MM) < 1 && Math.abs(size[3] - 297 * MM) < 1, `実寸: ${size}`);
      assert.equal(await page.locator("#behind").isVisible(), false, "後ろの画面は印刷しない");
      assert.equal(await page.locator(".sticker-print-toolbar").isVisible(), false, "操作は印刷しない");
      await page.close();
    }
  } finally { await browser.close(); }
});

test("印刷の出力: 貼付枠の実寸は 76×46mm で、線は薄いグレー", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await openPage(browser);
    await openPrint(page, "printSheet");
    await page.emulateMedia({ media: "print" });
    const r = await page.locator(".sticker-print-svg").evaluate((svg) => {
      const lines = [...svg.querySelectorAll('line[stroke="#999999"]')];
      const px = svg.getBoundingClientRect().width / 210;
      const xs = [...new Set(lines.filter(l => l.getAttribute("x1") === l.getAttribute("x2")).map(l => Number(l.getAttribute("x1"))))].sort((a, b) => a - b);
      const ys = [...new Set(lines.filter(l => l.getAttribute("y1") === l.getAttribute("y2")).map(l => Number(l.getAttribute("y1"))))].sort((a, b) => a - b);
      return { px, xs, ys, widths: [...new Set(lines.map(l => l.getAttribute("stroke-width")))] };
    });
    assert.ok(Math.abs(r.px - MM) < 0.01);
    assert.deepEqual(r.xs, [12, 26, 102, 108, 122, 198]);
    assert.deepEqual(r.ys, [44, 90, 136, 182, 228, 274]);
    assert.deepEqual(r.widths, ["0.2"]);
    await page.close();
  } finally { await browser.close(); }
});

test("上部の表示: 編集しても保存の呼び出しをせず、閉じると初期値に戻る。@page の CSS も外す", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await openPage(browser);
    await openPrint(page, "printSheet");
    await page.fill('[data-f="sheetHeader"]', '<img src=x onerror="window.__evil=1">眼科');
    assert.deepEqual(await headerLines(page), ['<img src=x onerror="window.__evil=1">眼科'], "文字として表示する");
    assert.equal(await page.evaluate(() => window.__evil), undefined);
    await page.click('[data-act="closePrint"]');
    assert.deepEqual(await page.evaluate(() => [!!document.querySelector(".sticker-print-view"), !!document.querySelector("[data-sticker-print]"), document.body.classList.contains("sticker-print-open")]), [false, false, false]);
    const calls = (await page.evaluate(() => window.__calls)).map(c => c[0]);
    assert.ok(!calls.includes("setAccessCode") && !calls.includes("setDealerShare"), "設定に書き戻さない");
    await openPrint(page, "printSheet");
    assert.deepEqual(await headerLines(page), ["立川病院　眼科　→　栗原医療器械店　立川支店"]);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".sticker-print-view").count(), 0);
    await page.close();
  } finally { await browser.close(); }
});

test("発注先: 2社以上は選択できる(既定は表示なし)。0社は施設名だけ。長い表示は折り返す", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    let page = await openPage(browser, "?dealers=two");
    await openPrint(page, "printSheet");
    assert.deepEqual(await headerLines(page), ["立川病院　眼科"]);
    await page.selectOption('[data-f="sheetDealer"]', "dB");
    assert.deepEqual(await headerLines(page), ["立川病院　眼科　→　B医療株式会社"]);
    assert.deepEqual(await page.locator('[data-f="sheetDealer"] option').allInnerTexts(), ["発注先を表示しない", "A商会", "B医療株式会社"]);
    await page.fill('[data-f="sheetHeader"]', "長".repeat(100));
    assert.equal((await headerLines(page)).length, 3);
    assert.equal((await pdfInfo(page)).pages, 1);
    await page.close();
    page = await openPage(browser, "?dealers=none");
    await openPrint(page, "printSheet");
    assert.deepEqual(await headerLines(page), ["立川病院　眼科"]);
    await page.close();
  } finally { await browser.close(); }
});

test("QR: 印刷のたびに有効な入口を受け取り、作り直した後は新しい QR を使う。モーダルからも開け、失敗は理由を出す", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await openPage(browser);
    const qrHref = () => page.locator(".sticker-print-svg image").first().getAttribute("href").then(decodeURIComponent);
    await openPrint(page, "printSheet");
    assert.ok((await qrHref()).includes('data-gen="0"'));
    await page.click('[data-act="closePrint"]');
    await page.click('[data-f="rotateTip"] .info-tip-btn');
    await page.click('[data-act="rotateQr"]');
    await page.waitForSelector(".sticker-qr-dialog");
    await page.click('.sticker-qr-dialog [data-act="printQr"]');
    await page.waitForSelector('.sticker-print-view [data-act="print"]:not([disabled])');
    assert.equal(await page.locator(".sticker-qr-dialog").count(), 0, "モーダルは閉じる");
    assert.ok((await qrHref()).includes('data-gen="1"'));
    await page.click('[data-act="closePrint"]');
    const gets = (await page.evaluate(() => window.__calls)).filter(c => c[0] === "getEntryQr");
    assert.deepEqual(gets, [["getEntryQr", "fA"], ["getEntryQr", "fA"], ["getEntryQr", "fA"]], "モーダルの表示と、印刷のたびの取得");
    await page.click('[data-act="showQr"]');
    await page.waitForSelector(".sticker-qr-dialog");
    await page.evaluate(() => { window.__failQr = true; });
    await page.click('.sticker-qr-dialog [data-act="printSheet"]');
    await page.waitForFunction(() => document.querySelector("[data-msg]").textContent.includes("権限"));
    assert.equal(await page.locator(".sticker-print-view").count(), 0);
    await page.close();
  } finally { await browser.close(); }
});
