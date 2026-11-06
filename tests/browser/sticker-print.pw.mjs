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
  getSettings: async (f) => { window.__calls.push(["getSettings", f]); return { accessCodeSet: true, accessCodeUpdatedAt: "2026-11-02T15:30:00.000Z", entryIssued: true, dealers: [], sheetNote: q.get("note") ?? "1行目の注意\\n2行目の注意" }; },
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
  test(`台紙を印刷: 見本に題名・上部の表示・QR・見出し行・12枠を出し、斜線は出さない。印刷できる: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      const page = await openPage(browser);
      await openPrint(page, "printSheet");
      assert.deepEqual(await headerLines(page), ["立川病院　眼科　→　栗原医療器械店　立川支店"]);
      const sheetText = await page.locator(".sticker-print-svg").textContent();
      assert.deepEqual(await page.locator('.sticker-print-svg [data-f="sheetNote"]').allTextContents(), ["1行目の注意", "2行目の注意"], "施設の注意事項を改行どおり印刷");
      assert.ok(!/実寸確認|50mm|挿入できなかった|患者氏名/.test(sheetText), "以前の文言を出さない");
      assert.equal(await page.locator('[data-f="noteTruncated"]').isVisible(), false);
      assert.equal(await page.locator('.sticker-print-svg line[stroke="#000000"]').count(), 0, "確認線を出さない");
      assert.equal(await page.locator(".sticker-print-svg image").count(), 1);
      assert.equal(await page.locator(".sticker-print-svg text", { hasText: "／" }).count(), 0, "日付欄に斜線を出さない");
      assert.equal(await page.locator(".sticker-print-svg text").first().textContent(), "眼内レンズ使用報告");
      assert.deepEqual(await page.locator('.sticker-print-svg [data-f="sheetHeading"]').allTextContents(), ["日付", "使用レンズ", "日付", "使用レンズ"]);
      // 見出しの文字は、それぞれの欄の中央(横・縦)。欄は 12〜26mm・26〜102mm、見出し行は 40〜45mm
      const centers = await page.locator(".sticker-print-svg").evaluate((svg) => {
        const b = svg.getBoundingClientRect(), mm = b.width / 210;
        return [...svg.querySelectorAll('[data-f="sheetHeading"]')].map(t => { const r = t.getBoundingClientRect(); return [((r.left + r.right) / 2 - b.left) / mm, ((r.top + r.bottom) / 2 - b.top) / mm]; });
      });
      [19, 64, 115, 160].forEach((x, i) => {
        assert.ok(Math.abs(centers[i][0] - x) < 0.5, `見出し ${i} の横の中央: ${centers[i][0]}`);
        assert.ok(Math.abs(centers[i][1] - 42.5) < 0.7, `見出し ${i} の縦の中央: ${centers[i][1]}`);
      });
      // 台紙の文字はすべて BIZ UDP明朝 Medium(ない端末は明朝体へ)。太さは題名だけ太字で、ほかは Medium
      const fonts = await page.locator(".sticker-print-svg text").evaluateAll(all => all.map(t => [t.getAttribute("font-family"), t.getAttribute("font-weight")]));
      assert.ok(fonts.length >= 6);
      for (const [family] of fonts) assert.match(family, /^'BIZ UDP明朝 Medium', 'BIZ UDPMincho Medium',.*'Yu Mincho'.*serif$/);
      assert.deepEqual(fonts.map(f => f[1]), ["700", ...fonts.slice(1).map(() => "500")]);
      assert.equal(await page.locator('[data-f="sheetDealer"]').count(), 0, "1社なら選択を出さない");
      // 説明は初期状態では出さず、題名の右のⓘを押したときだけ出す
      const tipBtn = page.locator('.sticker-print-title [aria-label="台紙を印刷の説明"]'), tipPop = page.locator(".sticker-print-title .info-tip-pop");
      assert.equal(await tipPop.isVisible(), false);
      assert.equal(await page.locator(".sticker-print-toolbar > .form-hint:not([role])").count(), 0, "説明を常に出さない");
      await tipBtn.click();
      assert.equal(await tipPop.isVisible(), true);
      const tipBox = await tipPop.boundingBox(), titleBox = await page.locator(".sticker-print-title").boundingBox(), screenSize = page.viewportSize();
      assert.ok(tipBox.x >= 0 && tipBox.x + tipBox.width <= screenSize.width && tipBox.y >= titleBox.y + titleBox.height && tipBox.y + tipBox.height <= screenSize.height, `説明は見出しのすぐ下の画面の中: ${JSON.stringify(tipBox)}`);
      assert.equal(await tipPop.evaluate((e) => { const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }), true, "ほかの要素に隠れない");
      const tipText = await tipPop.innerText();
      assert.ok(tipText.startsWith("印刷の倍率は100%(実際のサイズ)にしてください。") && tipText.endsWith("(設定は変わりません)。"), tipText);
      await tipBtn.click();
      await page.mouse.move(0, 0);
      assert.equal(await tipPop.isVisible(), false);
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
      assert.match(await page.locator(".sticker-print-toolbar > .form-hint").first().innerText(), /^印刷の倍率は100%/, "QR のみの画面の説明は変えない");
      assert.equal(await page.locator(".sticker-print-title .info-tip").count(), 0);
      assert.equal(await page.locator(".sticker-print-svg text", { hasText: "／" }).count(), 0);
      const text = await page.locator(".sticker-print-svg").textContent();
      assert.ok(text.includes("立川病院") && text.includes("IOLシール写真"));
      assert.ok(!/https?:|sticker\.html|コード/.test(text), "URL・アクセスコードを載せない");
      const qrFonts = await page.locator(".sticker-print-svg text").evaluateAll(all => [...new Set(all.map(t => t.getAttribute("font-family")))]);
      assert.deepEqual(qrFonts, ["'Yu Gothic', 'Meiryo', 'Hiragino Sans', 'Noto Sans CJK JP', sans-serif"], "QR のみの印刷のフォントは変えない");
      assert.equal(await page.locator(".sticker-print-svg text[font-weight]").count(), 0);
      await page.close();
    } finally { await browser.close(); }
  });
}

test("台紙の注意事項: 長文でも QR・貼付枠に重ならず、入らないときは知らせる。空欄なら出さない。QR のみの印刷には出さない", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const overlaps = (page) => page.evaluate(() => {
      const svg = document.querySelector(".sticker-print-svg"), box = (e) => e.getBoundingClientRect();
      const notes = [...svg.querySelectorAll('[data-f="sheetNote"]')].map(box), qr = box(svg.querySelector("image"));
      const frameTop = Math.min(...[...svg.querySelectorAll('line[stroke="#999999"]')].map(l => box(l).top));
      const title = box(svg.querySelector("text")), header = [...svg.querySelectorAll('[data-f="header"]')].map(box);
      return { count: notes.length, qr: notes.some(n => n.right > qr.left && n.bottom > qr.top && n.top < qr.bottom), frame: notes.some(n => n.bottom > frameTop + 0.5),
        header: notes.some(n => header.some(h => n.top < h.bottom - 1 && n.bottom > h.top + 1)), title: notes.some(n => n.top < title.bottom - 1) };
    });
    for (const [note, truncated] of [["あ".repeat(150), false], [Array.from({ length: 12 }, () => "長い注意事項の行").join("\n"), true]]) {
      const page = await openPage(browser, `?note=${encodeURIComponent(note)}`);
      await openPrint(page, "printSheet");
      const m = await overlaps(page);
      assert.ok(m.count > 0);
      assert.deepEqual([m.qr, m.frame, m.header, m.title], [false, false, false, false], JSON.stringify(m));
      assert.equal(await page.locator('[data-f="noteTruncated"]').isVisible(), truncated);
      // 上部の表示を長くしても重ならない
      await page.fill('[data-f="sheetHeader"]', "長い表示".repeat(25));
      const longHeader = await overlaps(page);
      assert.deepEqual([longHeader.qr, longHeader.frame, longHeader.header], [false, false, false], JSON.stringify(longHeader));
      await page.close();
    }
    const empty = await openPage(browser, "?note=");
    await openPrint(empty, "printSheet");
    assert.equal(await empty.locator('.sticker-print-svg [data-f="sheetNote"]').count(), 0);
    await empty.close();
    const qrOnly = await openPage(browser);
    await openPrint(qrOnly, "printQr");
    assert.equal(await qrOnly.locator('.sticker-print-svg [data-f="sheetNote"]').count(), 0);
    assert.ok(!(await qrOnly.locator(".sticker-print-svg").textContent()).includes("1行目の注意"));
    await qrOnly.close();
  } finally { await browser.close(); }
});

test("台紙の文字の幅: 英大文字が続く表示・注意事項も QR に重ならず、用紙の外へ出ない。かな・漢字も見切れない", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const note = "JOHNSON & JOHNSON VISION CARE MEDICAL ".repeat(4).trim();
    const page = await openPage(browser, `?note=${encodeURIComponent(note)}`, 1100);
    await openPrint(page, "printSheet");
    const check = () => page.evaluate(() => {
      const svg = document.querySelector(".sticker-print-svg"), b = svg.getBoundingClientRect(), mm = b.width / 210, qr = svg.querySelector("image").getBoundingClientRect();
      const texts = [...svg.querySelectorAll('[data-f="header"], [data-f="sheetNote"]')];
      return { qrLeft: (qr.left - b.left) / mm, right: Math.max(...texts.map(e => (e.getBoundingClientRect().right - b.left) / mm)), lines: svg.querySelectorAll('[data-f="header"]').length, shown: svg.querySelectorAll('[data-f="header"]').length ? [...svg.querySelectorAll('[data-f="header"]')].map(e => e.textContent).join("") : "" };
    });
    for (const text of ["W".repeat(100), "JOHNSON & JOHNSON VISION CARE MEDICAL ALCON ".repeat(3).slice(0, 100).trim(), "あ".repeat(100), "アイウエオカキクケコ".repeat(10)]) {
      await page.fill('[data-f="sheetHeader"]', text);
      const m = await check();
      assert.ok(m.right < m.qrLeft, `QR に重ならない: ${JSON.stringify(m)}`);
      assert.ok(m.lines <= 3);
      assert.equal(m.shown, text, "100文字の表示は欠けない");
    }
    await page.close();
  } finally { await browser.close(); }
});

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

test("印刷の出力: 貼付枠の実寸は 76×41mm(12枠)で、線は薄いグレー。枠と文字は A4 の中に収まる", async (t) => {
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
    assert.deepEqual(r.ys, [40, 45, 86, 127, 168, 209, 250, 291]);
    assert.deepEqual(r.widths, ["0.2"]);
    // 印刷のページ(210×297mm)から欠けるものがない(線・文字・QR)
    const out = await page.locator(".sticker-print-svg").evaluate((svg) => {
      const b = svg.getBoundingClientRect();
      return [...svg.querySelectorAll("line, text, image")].filter(e => { const r = e.getBoundingClientRect(); return r.left < b.left - 0.5 || r.top < b.top - 0.5 || r.right > b.right + 0.5 || r.bottom > b.bottom + 0.5; }).length;
    });
    assert.equal(out, 0, "ページの外に出る要素がない");
    const pageBox = await page.locator(".sticker-print-page").evaluate(e => { const r = e.getBoundingClientRect(); return r.height / (r.width / 210); });
    assert.ok(291 + 0.2 <= pageBox, `最下段の線(291mm)が印刷のページ(${pageBox}mm)の中`);
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
