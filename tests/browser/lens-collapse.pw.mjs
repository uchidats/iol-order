// 回帰テスト(ブラウザ): レンズ入力欄の折りたたみ。実際の styles.css と src/ui/lens-lines.js を最小のページで確認する。  npm run test:browser
// 入力が揃って正しいレンズだけ折りたためる・「レンズを追加」で入力済みを自動で折りたたむ・要約は確認画面と同じ2行(バッジは最上部に1回だけ)・
// タップで展開して再編集・未入力/不備は折りたたまない・折りたたみ中はゴミ箱を出さない・削除/元に戻す/下書き/検証への影響なし・スマートフォン/PC。
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
import { IOL_MODELS } from "/src/data/iol-models.js";
const options = buildLensOptions(IOL_MODELS);
window.__min = "2020-01-01";
window.__removed = [];
window.__lines = createLensLines({
  container: document.getElementById("lensLines"), addButton: document.getElementById("btnAddLine"),
  getOptions: () => options, getDoctors: () => [{ id: "o1", name: "内田" }, { id: "o2", name: "高橋" }],
  getDealers: () => [{ id: "dA", name: "A商会", orderEmails: ["a@example.jp"] }, { id: "dB", name: "B医療", orderEmails: ["b@example.jp"] }],
  minDate: () => window.__min, onLineRemoved: (info) => window.__removed.push(info)
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

const card = (page, i) => page.locator(".lens-line").nth(i);
/** 1枚のレンズを入力する(モデル・度数・手術日・担当医・発注先) */
async function fill(c, { toric = false, model, power, date = "2026-10-29", doctor = "o1", dealer = "dA" }) {
  if (toric) await c.locator("[data-f=toric]").check();
  await c.locator("[data-f=model]").selectOption(model);
  await c.locator("[data-f=power]").selectOption(power);
  await c.locator("[data-f=date]").fill(date);
  await c.locator("[data-f=date]").evaluate(el => el.blur());   // WebKit は日付の change をフォーカスが外れたときに出す(エラー表示が消えて位置がずれる前に確定させる)
  await c.locator("[data-f=doctor]").selectOption(doctor);
  await c.locator("[data-f=dealer]").selectOption(dealer);
}
const box = (loc) => loc.boundingBox();

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`レンズの折りたたみ: 追加で自動・要約は2行・バッジ位置は不変・タップで再編集・不備は折りたたまない・削除と元に戻す・検証・下書き: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await page.goto(base);
        await page.waitForFunction(() => window.__ready);
        const c1 = card(page, 0);
        // 入力前: 折りたためない(矢印を押すと不備を表示し、展開のまま)
        await c1.locator('[data-act="toggle"]').click();
        assert.equal(await c1.getAttribute("class"), "lens-line");
        assert.match(await c1.locator('[data-err="model"]').innerText(), /IOLモデルを選択/);
        await fill(c1, { model: "alcon-cna0t0", power: "+7.5D" });
        const badgeBefore = await box(c1.locator(".lens-line-title"));
        const cardBefore = await box(c1);
        // 矢印はバッジのすぐ右、ゴミ箱は右端(押し間違えないよう離す)
        const tg = await box(c1.locator('[data-act="toggle"]')), tr = await box(c1.locator('[data-act="remove"]'));
        assert.ok(tg.x - (badgeBefore.x + badgeBefore.width) < 12, `${width}: 矢印はバッジのすぐ右`);
        assert.ok(cardBefore.x + cardBefore.width - (tr.x + tr.width) < 16, `${width}: ゴミ箱は右端`);
        assert.ok(tr.x - (tg.x + tg.width) >= 120, `${width}: 矢印とゴミ箱は十分に離れる(${tr.x - (tg.x + tg.width)}px)`);
        assert.ok(Math.abs((tg.y + tg.height / 2) - (badgeBefore.y + badgeBefore.height / 2)) < 3, "矢印はバッジと同じ高さ");
        // 「レンズを追加」: 入力済みのレンズ1は自動で折りたたみ、レンズ2は展開して追加
        await page.click("#btnAddLine");
        assert.deepEqual(await page.evaluate(() => window.__lines.collapsedLineNos()), [1]);
        assert.match(await c1.getAttribute("class"), /is-collapsed/);
        const summary = c1.locator(".lens-line-summary");
        assert.equal(await summary.locator(".summary-date-head").innerText(), "手術日 2026年10月29日(木)　内田Dr");
        assert.deepEqual(await summary.locator(".summary-line-main > span").allInnerTexts(), ["ALCON", "CNA0T0", "+7.5D", "1枚"]);
        assert.ok(!(await summary.innerText()).includes("レンズ"), "要約にレンズ番号を重ねて出さない");
        assert.equal(await c1.locator(".lens-line-title").innerText(), "レンズ1");
        assert.equal(await c1.locator(".lens-no-badge, .lens-line-title").count(), 1, "バッジは最上部に1回だけ");
        // バッジの位置(カードの左上からの位置)は折りたたみ前と同じ
        const badgeAfter = await box(c1.locator(".lens-line-title"));
        const cardAfter = await box(c1);
        assert.ok(Math.abs((badgeAfter.x - cardAfter.x) - (badgeBefore.x - cardBefore.x)) < 1 && Math.abs((badgeAfter.y - cardAfter.y) - (badgeBefore.y - cardBefore.y)) < 1, "バッジの位置が変わらない");
        assert.ok(cardAfter.height < cardBefore.height / 2, `折りたたみで縦が短くなる(${cardBefore.height}→${cardAfter.height})`);
        const tgAfter = await box(c1.locator('[data-act="toggle"]'));
        assert.ok(Math.abs((tgAfter.x - cardAfter.x) - (tg.x - cardBefore.x)) < 1 && Math.abs((tgAfter.y - cardAfter.y) - (tg.y - cardBefore.y)) < 1, "折りたたみ中も矢印の位置は同じ");
        // 折りたたみ中: ゴミ箱は出さず、右端は矢印だけ。入力欄は隠れる
        assert.equal(await c1.locator('[data-act="remove"]').isVisible(), false);
        assert.equal(await c1.locator('[data-act="toggle"]').isVisible(), true);
        assert.equal(await c1.locator('[data-act="toggle"]').getAttribute("aria-expanded"), "false");
        assert.equal(await c1.locator("[data-f=power]").isVisible(), false);
        // レンズ2: 展開・手術日/担当医/発注先は引き継ぎ、モデルは未選択
        const c2 = card(page, 1);
        assert.equal(await c2.locator("[data-f=model]").inputValue(), "");
        assert.equal(await c2.locator("[data-f=date]").inputValue(), "2026-10-29");
        // 未入力のレンズ2は「レンズを追加」でも折りたたまない
        await page.click("#btnAddLine");
        assert.deepEqual(await page.evaluate(() => window.__lines.collapsedLineNos()), [1]);
        const c3 = card(page, 2);
        // トーリック(正式型番で表示)・2枚・別の担当医/発注先
        await fill(c2, { toric: true, model: "alcon-cna0tx-cnw0tx-toric|CNA0T3", power: "+20.0D", doctor: "o2", dealer: "dB" });
        await c2.locator('.quantity-option:has([value="2"])').click();
        await c2.locator('[data-act="toggle"]').click();
        assert.equal(await c2.locator(".summary-date-head").innerText(), "手術日 2026年10月29日(木)　高橋Dr");
        assert.deepEqual(await c2.locator(".summary-line-main > span").allInnerTexts(), ["ALCON", "CNA0T3", "+20.0D", "2枚"]);
        // 要約のタップで展開して再編集 → 折りたたむと要約が更新される
        await summary.click();
        assert.equal(await c1.locator("[data-f=power]").isVisible(), true);
        assert.equal(await c1.locator('[data-act="remove"]').isVisible(), true, "展開後はゴミ箱を従来どおり表示");
        await c1.locator("[data-f=power]").selectOption("+8.0D");
        await c1.locator('[data-act="toggle"]').click();
        assert.deepEqual(await c1.locator(".summary-line-main > span").allInnerTexts(), ["ALCON", "CNA0T0", "+8.0D", "1枚"]);
        // 下書き・注文の値は従来どおり(折りたたみの状態を含まない)
        const snap = await page.evaluate(() => window.__lines.snapshot());
        assert.deepEqual(snap.map(s => Object.keys(s).sort()), Array(3).fill(["date", "dealerId", "doctorId", "modelKey", "multifocal", "power", "quantity", "quantityManual", "toric"]));
        assert.deepEqual(snap.map(s => [s.modelKey, s.power, s.quantity]), [["alcon-cna0t0", "+8.0D", 1], ["alcon-cna0tx-cnw0tx-toric|CNA0T3", "+20.0D", 2], ["", "", 1]]);
        // 削除: 展開中のレンズ3を削除 → 折りたたみ中のレンズ1・2はそのまま。元に戻すと展開して戻る
        await c3.locator('[data-act="remove"]').click();
        assert.equal(await page.locator(".lens-line").count(), 2);
        assert.deepEqual(await page.evaluate(() => window.__lines.collapsedLineNos()), [1, 2]);
        await page.evaluate(() => window.__removed.at(-1).undo());
        assert.equal(await page.locator(".lens-line").count(), 3);
        assert.deepEqual(await page.evaluate(() => window.__lines.collapsedLineNos()), [1, 2]);
        // 折りたたみ中のレンズ1を削除するには、展開してからゴミ箱(番号は振り直し、折りたたみの表示も追従)
        await summary.click();
        await c1.locator('[data-act="remove"]').click();
        assert.deepEqual(await page.locator(".lens-line-title").allInnerTexts(), ["レンズ1", "レンズ2"]);
        assert.equal(await card(page, 0).locator('[data-act="toggle"]').getAttribute("aria-label"), "レンズ1を展開して編集");
        assert.deepEqual(await card(page, 0).locator(".summary-line-main > span").allInnerTexts(), ["ALCON", "CNA0T3", "+20.0D", "2枚"]);
        // 検証: 折りたたみ中のレンズに不備が生じたら(手術日が過去になった)、展開して表示する
        await page.evaluate(() => { window.__min = "2030-01-01"; });
        const r = await page.evaluate(() => window.__lines.validate().ok);
        assert.equal(r, false);
        assert.deepEqual(await page.evaluate(() => window.__lines.collapsedLineNos()), []);
        assert.match(await card(page, 0).locator('[data-err="date"]').innerText(), /本日以降/);
        await page.evaluate(() => { window.__min = "2020-01-01"; });
        // 下書きの復元: すべて展開で復元(折りたたみの状態は保存しない)
        await page.evaluate((s) => window.__lines.restore(s), snap);
        assert.deepEqual(await page.evaluate(() => window.__lines.collapsedLineNos()), []);
        assert.equal(await page.locator(".lens-line").count(), 3);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 横にはみ出さない`);
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}

test("レンズの折りたたみ: キーボードで折りたたみ・展開できる(読み上げのラベル付き)(chromium)", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(base);
    await page.waitForFunction(() => window.__ready);
    const c1 = card(page, 0);
    await fill(c1, { model: "alcon-cna0t0", power: "+7.5D" });
    const toggle = c1.locator('[data-act="toggle"]');
    assert.equal(await toggle.getAttribute("aria-label"), "レンズ1を折りたたむ");
    await toggle.focus();
    await page.keyboard.press("Enter");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await c1.locator(".lens-line-summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.act), "toggle", "展開後は矢印にフォーカス");
  } finally { await browser.close(); }
});

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`レンズの折りたたみ(簡潔な表示): 直前のレンズと手術日・担当医が同じなら見出し行を省く。先頭は必ず表示。追加・編集・削除・復元で判定し直す。スマートフォン/PC: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await page.goto(base);
        await page.waitForFunction(() => window.__ready);
        const heads = () => page.locator(".lens-line").evaluateAll(ls => ls.map(l => {
          const h = l.querySelector(".lens-line-summary .summary-date-head");
          return l.classList.contains("is-collapsed") ? (h && !h.hidden && getComputedStyle(h).display !== "none" ? "head" : "main-only") : "open";
        }));
        const add = () => page.click("#btnAddLine");
        // レンズ1(10/29・内田) → レンズ2(同じ手術日・担当医) → レンズ3(担当医が違う) → レンズ4(レンズ3と同じ)
        await fill(card(page, 0), { model: "alcon-cna0t0", power: "+7.5D" });
        await add();
        await fill(card(page, 1), { model: "alcon-cna0t0", power: "+8.0D" });
        await add();
        await fill(card(page, 2), { model: "alcon-cna0t0", power: "+9.0D", doctor: "o2" });
        await add();
        await fill(card(page, 3), { model: "alcon-cna0t0", power: "+10.0D", doctor: "o2" });
        await card(page, 3).locator('[data-act="toggle"]').click();
        assert.deepEqual(await heads(), ["head", "main-only", "head", "main-only"]);
        // 省いたカードも、バッジ・矢印・IOL名・度数・枚数はそのまま
        const c2 = card(page, 1);
        assert.equal(await c2.locator(".lens-line-title").innerText(), "レンズ2");
        assert.equal(await c2.locator('[data-act="toggle"]').isVisible(), true);
        assert.deepEqual(await c2.locator(".summary-line-main > span").allInnerTexts(), ["ALCON", "CNA0T0", "+8.0D", "1枚"]);
        assert.ok(!(await c2.locator(".lens-line-summary").innerText()).includes("手術日"));
        // 編集: レンズ2の手術日を変えると、レンズ2は見出しを出す(レンズ1と違う)
        await c2.locator(".lens-line-summary").click();
        await card(page, 1).locator("[data-f=date]").fill("2026-10-30");
        await card(page, 1).locator("[data-f=date]").evaluate(el => el.blur());
        await card(page, 1).locator('[data-act="toggle"]').click();
        assert.deepEqual(await heads(), ["head", "head", "head", "main-only"]);
        // 展開中の直前のレンズを編集しても、次の折りたたみの表示を判定し直す(レンズ3の担当医をレンズ4と違うものに)
        await card(page, 2).locator(".lens-line-summary").click();
        await card(page, 2).locator("[data-f=doctor]").selectOption("o1");
        assert.deepEqual(await heads(), ["head", "head", "open", "head"]);
        await card(page, 2).locator('[data-act="toggle"]').click();
        // 削除: レンズ1を削除すると、新しい先頭(元のレンズ2)は必ず見出しを出す
        await card(page, 0).locator(".lens-line-summary").click();
        await card(page, 0).locator('[data-act="remove"]').click();
        assert.equal((await heads())[0], "head");
        // 復元(すべて展開)→ 折りたたむと判定し直す
        const snap = await page.evaluate(() => window.__lines.snapshot());
        await page.evaluate((s) => window.__lines.restore(s), snap);
        for (let i = 0; i < 3; i++) await card(page, i).locator('[data-act="toggle"]').click();
        const h = await heads();
        assert.equal(h[0], "head");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 横にはみ出さない`);
        // 注文データ(値)は変わらない
        assert.equal((await page.evaluate(() => window.__lines.values())).length, 3);
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`レンズの折りたたみ(簡潔な表示): 直前のレンズが折りたたまれているときだけ省く。直前が開いていれば必ず表示し、折りたたむと再び省く(3枚以上も直前のレンズで判定): ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      const heads = () => page.locator(".lens-line").evaluateAll(ls => ls.map(l => {
        const h = l.querySelector(".lens-line-summary .summary-date-head");
        return l.classList.contains("is-collapsed") ? (h && !h.hidden && getComputedStyle(h).display !== "none" ? "head" : "main-only") : "open";
      }));
      // 3枚とも同じ手術日・担当医
      for (let i = 0; i < 3; i++) {
        if (i) await page.click("#btnAddLine");
        await fill(card(page, i), { model: "alcon-cna0t0", power: `+${7 + i}.0D` });
      }
      await card(page, 2).locator('[data-act="toggle"]').click();
      assert.deepEqual(await heads(), ["head", "main-only", "main-only"]);
      // レンズ1を開く → 折りたたまれたレンズ2は見出しを出す(レンズ3は直前のレンズ2が折りたたまれているので省いたまま)
      await card(page, 0).locator(".lens-line-summary").click();
      assert.deepEqual(await heads(), ["open", "head", "main-only"]);
      // レンズ1を折りたたむ → レンズ2は再び省く
      await card(page, 0).locator('[data-act="toggle"]').click();
      assert.deepEqual(await heads(), ["head", "main-only", "main-only"]);
      // 真ん中(レンズ2)を開く → レンズ3は見出しを出す。閉じると戻る
      await card(page, 1).locator(".lens-line-summary").click();
      assert.deepEqual(await heads(), ["head", "open", "head"]);
      await card(page, 1).locator('[data-act="toggle"]').click();
      assert.deepEqual(await heads(), ["head", "main-only", "main-only"]);
      await page.close();
    } finally { await browser.close(); }
  });
}
