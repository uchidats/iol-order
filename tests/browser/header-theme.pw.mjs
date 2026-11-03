// 回帰テスト(ブラウザ): 施設設定の「テーマカラー」。色見本・自由な色(HEX)・グラデーション・フォントを黒にする・読みやすさの案内・初期設定に戻す。ヘッダーへの即時反映と自動保存。
// 実際の施設設定の画面(facility-settings.js)を、偽のリポジトリ・保存APIで動かす(ログイン・Firebase は使わない)。  npm run test:browser
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
<header class="app-header"><div class="header-inner"><span class="header-title">IOL Order</span></div></header>
<main class="main-content"></main>
<script type="module">
import { createFacilitySettings } from "/src/ui/facility-settings.js";
import { loadSubTheme } from "/src/ui/sub-theme.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
window.__calls = [];
let theme = null;
window.__subByFacility = {};   // サブテーマカラーの保存先(施設ごと)
const repository = {
  listOrderers: async () => [], listAdoptedIols: async () => [], listMembers: async () => [], getIolOrder: async () => null,
  listDealers: async () => [], getMailSettings: async () => null, getHeaderTheme: async () => (theme ? { ...theme } : null),
  getSubTheme: async (fid) => (window.__subByFacility[fid] ? { ...window.__subByFacility[fid] } : null)
};
const settingsApi = {
  saveOrderers: async () => {}, saveAdoptedIols: async () => {}, saveIolOrder: async () => {}, deleteOrderer: async () => {}, deleteDealer: async () => {},
  saveDealers: async () => {}, saveMailSettings: async () => {},
  saveHeaderTheme: async (fid, t) => { window.__calls.push(["save", t]); theme = { ...t }; },
  resetHeaderTheme: async () => { window.__calls.push(["reset"]); theme = null; },
  saveSubTheme: async (fid, t) => { window.__calls.push(["saveSub", fid, t]); window.__subByFacility[fid] = { ...t }; },
  resetSubTheme: async (fid) => { window.__calls.push(["resetSub", fid]); delete window.__subByFacility[fid]; }
};
const s = createFacilitySettings({ mount: document.querySelector("main"), repository, settingsApi, masters: IOL_MODELS, onSaved: async () => {}, onClose() {} });
await s.open({ id: "f1", name: "テスト施設" });
window.__reopen = (id = "f1") => s.open({ id, name: id === "f1" ? "テスト施設" : "別の施設" });
// 注文画面の主要な部品(サブテーマカラーの対象)と、意味のある色(対象外)の見本
document.body.insertAdjacentHTML("beforeend", '<div id="probe"><button class="btn btn-primary" id="pBtn">注文内容を確認</button>'
  + '<label class="quantity-option"><input type="radio" checked><span class="quantity-btn" id="pQty">1 枚</span></label>'
  + '<div class="history-sort"><button class="history-sort-btn" aria-pressed="true" id="pSort">注文日順</button></div>'
  + '<span class="lens-no-badge" id="pBadge">レンズ1</span><a class="manual-body" href="#"><span id="pLinkWrap"></span></a>'
  + '<p class="error-message" id="pErr">エラー</p><span class="badge-warning" id="pWarn">警告</span></div>');
window.__loadSub = (fid) => loadSubTheme(fid, repository);
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

const headerBg = (page) => page.evaluate(() => { const e = document.querySelector(".app-header"); return { inline: e.style.background, image: getComputedStyle(e).backgroundImage, color: getComputedStyle(e).backgroundColor, text: getComputedStyle(e.querySelector(".header-title")).color }; });
const calls = (page) => page.evaluate(() => window.__calls);
const settle = (page) => page.waitForTimeout(150);

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`テーマカラー: 色見本・グラデーション・HEX・初期設定に戻す。ヘッダーに即時反映して自動保存: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      const sec = page.locator('[data-section="theme"] [data-theme-pane="header"]');   // ヘッダーの設定(「ヘッダー」「サブテーマカラー」の切り替えの初期表示)
      assert.deepEqual((await page.locator("[data-section]").evaluateAll(es => es.map(e => e.getAttribute("data-section")))).slice(-2), ["mail", "theme"], "注文メールの後");
      // 未設定: 標準の青いグラデーション + 白い文字(インラインの指定なし)。グラデーションは初期値 ON、黒い文字は OFF、初期設定に戻すは押せない
      const initial = await headerBg(page);
      assert.equal(initial.inline, "");
      assert.match(initial.image, /linear-gradient/);
      assert.equal(initial.text, "rgb(255, 255, 255)");
      assert.equal(await sec.locator(".theme-swatch").count(), 20);
      assert.deepEqual(await sec.locator(".theme-row-label").allInnerTexts(), ["白文字向け", "黒文字向け"]);
      assert.deepEqual(await sec.locator(".theme-swatches").evaluateAll(rs => rs.map(r => r.querySelectorAll(".theme-swatch").length)), [10, 10]);
      assert.equal(await sec.locator('[data-f="themeGradient"]').isChecked(), true);
      assert.equal(await sec.locator('[data-f="themeDarkText"]').isChecked(), false);
      assert.equal(await sec.locator('[data-f="themeAdvice"]').isVisible(), false);
      assert.equal(await sec.locator('[data-act="theme-reset"]').isDisabled(), true);

      // 色見本を選ぶ → すぐにヘッダーに反映(グラデーション)・保存
      await sec.locator('.theme-swatch[data-color="#15803d"]').click();
      await settle(page);
      assert.equal((await headerBg(page)).inline, "linear-gradient(135deg, rgb(14, 83, 40) 0%, rgb(21, 128, 61) 100%)");
      assert.deepEqual(await calls(page), [["save", { color: "#15803d", gradient: true, darkText: false }]]);
      assert.equal(await sec.locator('.theme-swatch[data-color="#15803d"]').getAttribute("aria-pressed"), "true");
      // 「初期設定に戻す」「注文画面に戻る」は担当医の「追加」と同じ高さ・文字の大きさ・余白・角丸・色(幅は文字に合わせる)。PC・スマホ
      const btnLook = (sel) => page.evaluate((q) => { const e = document.querySelector(q), c = getComputedStyle(e), b = e.getBoundingClientRect();
        return { h: b.height, fs: c.fontSize, fw: c.fontWeight, pad: c.padding, radius: c.borderRadius, border: c.border, bg: c.backgroundColor, color: c.color, oneLine: e.scrollWidth <= e.clientWidth }; }, sel);
      for (const w of [1100, 390, 320]) {
        await page.setViewportSize({ width: w, height: 1200 });
        const add = await btnLook('.settings-actions [data-act="add"]');
        assert.deepEqual(await btnLook('[data-section="theme"] [data-act="theme-reset"]'), add, `${w}px: 初期設定に戻す`);
        assert.deepEqual(await btnLook("#btnSettingsClose"), add, `${w}px: 注文画面に戻る`);
        assert.equal(add.h, 36);
      }
      await page.setViewportSize({ width: 1100, height: 1200 });

      // 2行目(黒文字向け)の色見本を選ぶと、文字も黒に自動で設定。1行目に戻すと白に戻る。チェックボックスで手動でも変えられる
      await sec.locator('.theme-swatch[data-color="#fdba74"]').click();
      await settle(page);
      assert.deepEqual((await calls(page)).at(-1), ["save", { color: "#fdba74", gradient: true, darkText: true }]);
      assert.equal(await sec.locator('[data-f="themeDarkText"]').isChecked(), true);
      assert.equal((await headerBg(page)).text, "rgb(0, 0, 0)");
      assert.equal(await sec.locator('[data-f="themeAdvice"]').isVisible(), false);
      await sec.locator('[data-f="themeDarkText"]').uncheck();
      await settle(page);
      assert.deepEqual((await calls(page)).at(-1), ["save", { color: "#fdba74", gradient: true, darkText: false }]);
      assert.equal(await sec.locator('[data-f="themeAdvice"]').isVisible(), true, "手動で白にすると読みにくいので案内(保存はする)");
      await sec.locator('.theme-swatch[data-color="#15803d"]').click();
      await settle(page);
      assert.deepEqual((await calls(page)).at(-1), ["save", { color: "#15803d", gradient: true, darkText: false }]);
      assert.equal((await headerBg(page)).text, "rgb(255, 255, 255)");

      // グラデーションを OFF → 単色
      await sec.locator('[data-f="themeGradient"]').uncheck();
      await settle(page);
      const solid = await headerBg(page);
      assert.equal(solid.image, "none");
      assert.equal(solid.color, "rgb(21, 128, 61)");
      assert.deepEqual((await calls(page)).at(-1), ["save", { color: "#15803d", gradient: false, darkText: false }]);

      // 明るい色も選べる(反映・保存する)。白い文字では読みにくいので、控えめな案内を出す
      await sec.locator('[data-f="themeHex"]').fill("#fde047");
      await sec.locator('[data-f="themeHex"]').blur();
      await settle(page);
      assert.deepEqual((await calls(page)).at(-1), ["save", { color: "#fde047", gradient: false, darkText: false }]);
      assert.equal((await headerBg(page)).color, "rgb(253, 224, 71)");
      assert.equal(await sec.locator('[data-f="themeAdvice"]').isVisible(), true);
      assert.equal(await sec.locator('[data-f="themeAdvice"]').innerText(), "文字が読みやすい配色を推奨します");
      assert.equal(await sec.locator(".error-message").count(), 0, "エラーにはしない");

      // フォントを黒にする → ヘッダーの文字・アイコンが黒。読みやすいので案内は消える
      await sec.locator('[data-f="themeDarkText"]').check();
      await settle(page);
      assert.deepEqual((await calls(page)).at(-1), ["save", { color: "#fde047", gradient: false, darkText: true }]);
      assert.equal((await headerBg(page)).text, "rgb(0, 0, 0)");
      assert.equal(await sec.locator('[data-f="themeAdvice"]').isVisible(), false);

      // 自由な色(HEX)。濃い色に黒い文字は読みにくいので案内(保存はする)
      await sec.locator('[data-f="themeHex"]').fill("#7A1F5C");
      await sec.locator('[data-f="themeHex"]').blur();
      await settle(page);
      assert.deepEqual((await calls(page)).at(-1), ["save", { color: "#7a1f5c", gradient: false, darkText: true }]);
      assert.equal((await headerBg(page)).color, "rgb(122, 31, 92)");
      assert.equal(await sec.locator('[data-f="themeAdvice"]').isVisible(), true);
      assert.equal(await sec.locator(".theme-swatch[aria-pressed=true]").count(), 0);
      // 形式が違う値だけは、反映も保存もしない
      const n = (await calls(page)).length;
      await sec.locator('[data-f="themeHex"]').fill("blue");
      await sec.locator('[data-f="themeHex"]').blur();
      await settle(page);
      assert.match(await sec.locator(".error-message").innerText(), /#RRGGBB/);
      assert.equal((await calls(page)).length, n);

      // 開き直すと保存した内容を表示
      await page.evaluate(() => window.__reopen());
      assert.equal(await sec.locator('[data-f="themeHex"]').inputValue(), "#7a1f5c");
      assert.equal(await sec.locator('[data-f="themeGradient"]').isChecked(), false);
      assert.equal(await sec.locator('[data-f="themeDarkText"]').isChecked(), true);

      // 初期設定に戻す → 設定を削除し、標準の青いグラデーション + 白い文字に戻る(グラデーション ON・黒い文字 OFF)
      await sec.locator('[data-act="theme-reset"]').click();
      await settle(page);
      assert.deepEqual((await calls(page)).at(-1), ["reset"]);
      const back = await headerBg(page);
      assert.equal(back.inline, "");
      assert.equal(back.image, initial.image);
      assert.equal(back.text, "rgb(255, 255, 255)");
      assert.equal(await sec.locator('[data-f="themeGradient"]').isChecked(), true);
      assert.equal(await sec.locator('[data-f="themeDarkText"]').isChecked(), false);
      assert.equal(await sec.locator('[data-f="themeAdvice"]').isVisible(), false);
      assert.equal(await sec.locator('[data-act="theme-reset"]').isDisabled(), true);

      // スマートフォンの幅でも色見本が欄からはみ出さない
      await page.setViewportSize({ width: 360, height: 900 });
      const fits = await sec.evaluate(s => { const g = s.querySelector(".theme-swatches").getBoundingClientRect(), r = s.getBoundingClientRect(); return g.right <= r.right && document.documentElement.scrollWidth <= window.innerWidth; });
      assert.equal(fits, true);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

// ---- サブテーマカラー: 「テーマカラー」の見出しの直下に「ヘッダー」「サブテーマカラー」。サブテーマは同じ色見本と「その他の色」だけ。
//      保存は選んだ元の色、表示は読みやすさのために濃くする。主要ボタン・選択中の表示・バッジに反映し、エラー・警告・ヘッダーは変えない ----
import { readablePrimary, subThemeVars } from "../../src/domain/sub-theme.js";
import { contrastRatio } from "../../src/domain/header-theme.js";
const rgbToHex = (rgb) => "#" + rgb.match(/\d+/g).slice(0, 3).map(n => Number(n).toString(16).padStart(2, "0")).join("");
for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`サブテーマカラー: 切り替え・色見本と HEX・元の色を保存して表示は濃く・主要ボタン/選択中/バッジに反映・意味のある色とヘッダーは変えない・施設ごと: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 1200 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      const sec = page.locator('[data-section="theme"]');
      const headerPane = sec.locator('[data-theme-pane="header"]'), subPane = sec.locator('[data-theme-pane="sub"]');
      const tab = (v) => sec.locator(`[data-theme-target="${v}"]`);
      // ボタンの色は transition(0.15s)で変わるため、終わってから読む
      const look = async () => { await page.waitForTimeout(300); return page.evaluate(() => {
        const cs = (id) => getComputedStyle(document.getElementById(id));
        return { btnBg: cs("pBtn").backgroundColor, btnText: cs("pBtn").color, qtyBg: cs("pQty").backgroundColor, qtyText: cs("pQty").color, qtyBorder: cs("pQty").borderTopColor,
          sortBg: cs("pSort").backgroundColor, badgeText: cs("pBadge").color, badgeBg: cs("pBadge").backgroundColor, err: cs("pErr").color, warn: cs("pWarn").color,
          primary: getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(), header: document.querySelector(".app-header").style.background };
      }); };
      const before = await look();
      assert.deepEqual([before.btnBg, before.primary, before.header], ["rgb(29, 78, 216)", "#1d4ed8", ""], "未設定は従来の青・ヘッダーは標準");

      for (const w of [390, 1100]) {
        await page.setViewportSize({ width: w, height: 1200 });
        // 見出しの直下に切り替え。初期表示は「ヘッダー」(従来の設定のまま)
        const pos = await page.evaluate(() => {
          const s = document.querySelector('[data-section="theme"]'), r = (q) => s.querySelector(q).getBoundingClientRect();
          return { below: r(".theme-target").top >= r(".settings-heading").bottom - 0.5, aboveHeader: r(".theme-target").bottom <= r('[data-theme-pane="header"]').top + 0.5,
            noScroll: document.documentElement.scrollWidth <= innerWidth };
        });
        assert.deepEqual(pos, { below: true, aboveHeader: true, noScroll: true }, `${w}px: 切り替えは見出しの直下・はみ出さない`);
      }
      assert.deepEqual(await sec.locator("[data-theme-target]").evaluateAll(bs => bs.map(b => [b.textContent, b.getAttribute("aria-pressed")])), [["ヘッダー", "true"], ["サブテーマカラー", "false"]]);
      assert.deepEqual([await headerPane.isVisible(), await subPane.isVisible()], [true, false]);

      // サブテーマカラー: 同じ色見本(20色。行の見出しなし)と「その他の色」と「初期設定に戻す」だけ。グラデーション・黒い文字・案内・保存ボタンはない
      await tab("sub").click();
      assert.deepEqual([await headerPane.isVisible(), await subPane.isVisible()], [false, true]);
      assert.equal(await tab("sub").getAttribute("aria-pressed"), "true");
      assert.equal(await subPane.locator(".theme-swatch").count(), 20);
      assert.equal(await subPane.locator(".theme-row-label").count(), 0);
      assert.equal(await subPane.locator('input[type="checkbox"]').count(), 0, "グラデーション・フォントを黒にするはない");
      assert.equal(await subPane.locator(".theme-advice").count(), 0);
      assert.deepEqual(await subPane.locator("button:not(.theme-swatch)").allInnerTexts(), ["初期設定に戻す"], "保存ボタンはない(自動保存)");
      assert.equal(await subPane.locator('[data-f="subThemePicker"]').count(), 1);
      assert.equal(await subPane.locator('[data-act="sub-theme-reset"]').isDisabled(), true);

      // 明るい色を選ぶ: 保存するのは元の色(#93c5fd)、表示は白い文字が読める濃さ(色合いは同じ)に自動で濃くする
      await subPane.locator('.theme-swatch[data-color="#93c5fd"]').click();
      await settle(page);
      assert.deepEqual((await calls(page)).filter(c => c[0] === "saveSub"), [["saveSub", "f1", { color: "#93c5fd" }]], "保存は元の色だけ");
      const p = readablePrimary("#93c5fd"), v = subThemeVars({ color: "#93c5fd" });
      const a = await look();
      assert.equal(a.primary, p);
      assert.notEqual(p, "#93c5fd", "表示のときだけ濃くする");
      assert.equal(rgbToHex(a.btnBg), p, "主要ボタン");
      assert.equal(a.btnText, "rgb(255, 255, 255)");
      assert.ok(contrastRatio(rgbToHex(a.btnBg), rgbToHex(a.btnText)) >= 4.5, "ボタンの文字のコントラスト");
      assert.deepEqual([rgbToHex(a.qtyBg), rgbToHex(a.qtyText), rgbToHex(a.qtyBorder)], [v["--primary-light"], p, p], "選択中の枚数ボタン");
      assert.ok(contrastRatio(rgbToHex(a.qtyText), rgbToHex(a.qtyBg)) >= 4.5, "選択中の文字のコントラスト");
      assert.equal(rgbToHex(a.sortBg), p, "選択中の切り替えボタン");
      assert.deepEqual([rgbToHex(a.badgeText), rgbToHex(a.badgeBg)], [p, v["--primary-tint"]], "レンズのバッジ");
      assert.deepEqual([a.err, a.warn, a.header], [before.err, before.warn, ""], "エラー・警告の色とヘッダーは変えない");
      assert.equal(await subPane.locator('.theme-swatch[data-color="#93c5fd"]').getAttribute("aria-pressed"), "true");
      assert.equal(await subPane.locator('[data-act="sub-theme-reset"]').isDisabled(), false);

      // ヘッダーの色との組み合わせ: ヘッダーを緑にしても、サブテーマカラーはそのまま(別々の設定)
      await tab("header").click();
      await headerPane.locator('.theme-swatch[data-color="#15803d"]').click();
      await settle(page);
      const b = await look();
      assert.ok(b.header.includes("21, 128, 61") || b.header.includes("#15803d"), "ヘッダーは緑");
      assert.equal(b.primary, p, "サブテーマカラーは変わらない");
      assert.equal((await calls(page)).filter(c => c[0] === "save").length, 1, "ヘッダーの保存は従来どおり");

      // その他の色(HEX): 大文字でも #rrggbb にそろえて保存。形式違いは保存も反映もしない
      await tab("sub").click();
      await subPane.locator('[data-f="subThemeHex"]').fill("#BE185D");
      await subPane.locator('[data-f="subThemeHex"]').blur();
      await settle(page);
      assert.deepEqual((await calls(page)).filter(c => c[0] === "saveSub").at(-1), ["saveSub", "f1", { color: "#be185d" }]);
      assert.equal((await look()).primary, "#be185d", "十分に濃い色はそのまま");
      const n = (await calls(page)).length;
      await subPane.locator('[data-f="subThemeHex"]').fill("blue");
      await subPane.locator('[data-f="subThemeHex"]').blur();
      await settle(page);
      assert.match(await subPane.locator(".error-message").innerText(), /#RRGGBB/);
      assert.equal((await calls(page)).length, n);
      assert.equal((await look()).primary, "#be185d");

      // 開き直すと保存された元の色を表示(初期表示は「ヘッダー」)
      await page.evaluate(() => window.__reopen());
      assert.equal(await tab("header").getAttribute("aria-pressed"), "true");
      await tab("sub").click();
      assert.equal(await subPane.locator('[data-f="subThemeHex"]').inputValue(), "#be185d");

      // 初期設定に戻す: 保存を削除し、従来の青に戻す(ヘッダーの緑はそのまま)
      await subPane.locator('[data-act="sub-theme-reset"]').click();
      await settle(page);
      assert.deepEqual((await calls(page)).filter(c => c[0] === "resetSub"), [["resetSub", "f1"]]);
      const c = await look();
      assert.deepEqual([c.btnBg, c.primary], ["rgb(29, 78, 216)", "#1d4ed8"]);
      assert.ok(c.header.includes("21, 128, 61") || c.header.includes("#15803d"));

      // 施設ごと(注文画面で施設に入ったときの読み込み): 施設 f2 は濃いピンク、f1(未設定)は従来の青
      await page.evaluate(async () => { window.__subByFacility.f2 = { color: "#f9a8d4" }; await window.__loadSub("f2"); });
      assert.equal((await look()).primary, readablePrimary("#f9a8d4"));
      await page.evaluate(async () => { await window.__loadSub("f1"); });
      assert.equal((await look()).primary, "#1d4ed8");
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
