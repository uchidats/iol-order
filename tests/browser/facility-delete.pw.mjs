// 回帰テスト(ブラウザ): 施設設定の施設の削除(施設名の入力で確認・サーバーの拒否理由を表示)。  npm run test:browser
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const page = (withRename) => `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<main class="main-content"></main>
<script type="module">
import { createFacilitySettings } from "/src/ui/facility-settings.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
window.__calls = []; window.__deleted = []; window.__next = { status: "renamed" };
const repository = { listOrderers: async () => [], listAdoptedIols: async () => [], listDealers: async () => [], listMembers: async () => [] };
const settingsApi = { saveOrderers: async () => {}, saveAdoptedIols: async () => {}, saveDealers: async () => {}, deleteDealer: async () => {}, deleteOrderer: async () => {} };
const inviteApi = { ${withRename ? `renameFacility: async () => ({ status: "unchanged" }), deleteFacility: async (a) => { window.__calls.push(a); if (window.__delay) await new Promise(r => setTimeout(r, window.__delay)); if (window.__fail) { const e = new Error(window.__fail); e.code = "functions/failed-precondition"; throw e; } return { status: "deleted" }; }` : ""} };
const s = createFacilitySettings({ mount: document.querySelector("main"), repository, settingsApi, masters: IOL_MODELS, inviteApi, onSaved: async () => {}, onClose() {}, onDeleted: (id) => window.__deleted.push(id) });
await s.open({ id: "f1", name: "テスト施設" });
window.__ready = true;
</script></body></html>`;

let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/" || url === "/norename") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(page(url === "/")); return; }
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
  test(`施設の削除: ダイアログで確定するまで削除しない・二重送信の防止・サーバーの拒否理由を表示・成功で通知: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const pg = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errors = [];
      pg.on("pageerror", e => errors.push(String(e)));
      await pg.goto(base);
      await pg.waitForFunction(() => window.__ready);
      const trash = pg.locator("#btnDeleteFacility"), pencil = pg.locator("#btnRenameFacility"), closeBtn = pg.locator("#btnSettingsClose"), box = pg.locator("#deleteFacilityDialog");
      const sec = box;
      const del = box.locator(".delete-confirm-btn");
      // 見出しは左から「編集(鉛筆)」「削除(ゴミ箱)」「注文画面に戻る」。「︙」メニューと、最下部の削除欄はない
      assert.equal(await pg.locator('[data-section="delete"]').count(), 0);
      assert.equal(await pg.locator("#btnSettingsMore").count(), 0);
      assert.equal(await box.isHidden(), true);
      const [pb, tb, cb] = [await pencil.boundingBox(), await trash.boundingBox(), await closeBtn.boundingBox()];
      assert.ok(Math.abs(pb.y - tb.y) < 3 && pb.x + pb.width <= tb.x && tb.x + tb.width <= cb.x + 1 || tb.y < cb.y, "鉛筆→ゴミ箱→戻る の順");
      assert.ok(Math.abs(pb.width - tb.width) < 1 && Math.abs(pb.height - tb.height) < 1, "鉛筆と同じ大きさ");
      const bgOf = (l) => l.evaluate(e => getComputedStyle(e).backgroundColor);
      assert.equal(await bgOf(trash), await bgOf(pencil), "背景色は鉛筆と同じ");
      assert.equal(await trash.locator("svg").count(), 1);
      assert.equal(await trash.getAttribute("aria-label"), "施設を削除");
      assert.equal(await trash.evaluate(e => getComputedStyle(e).color), "rgb(31, 41, 55)", "ゴミ箱は濃いグレー(赤くない)");
      // ゴミ箱を押しただけでは削除しない(ダイアログでの確定が必須)
      await trash.click();
      assert.equal(await box.isVisible(), true);
      assert.deepEqual(await pg.evaluate(() => window.__calls), []);
      assert.match(await box.innerText(), /注文履歴がある施設/);
      // 内容: 施設名の再入力欄はない。削除対象の施設名を示し、「この施設を削除する」「キャンセル」の2つのボタン
      assert.equal(await box.locator("input").count(), 0);
      assert.equal(await box.locator(".delete-target").innerText(), "削除する施設: テスト施設");
      assert.deepEqual(await box.locator("button").allInnerTexts(), ["この施設を削除する", "キャンセル"]);
      assert.equal(await del.isEnabled(), true);
      // 見た目: ダークモードでも背景は白・文字は濃いグレー。削除ボタンは赤ではなくグレー、キャンセルは従来のグレー
      const colors = () => pg.evaluate(() => { const q = s => getComputedStyle(document.querySelector(s)); const b = [...document.querySelectorAll("#deleteFacilityDialog button")]; return { bg: q("#deleteFacilityDialog").backgroundColor, fg: q("#deleteFacilityDialog").color, del: getComputedStyle(b[0]).backgroundColor, cancel: getComputedStyle(b[1]).backgroundColor }; });
      const light = await colors();
      await pg.emulateMedia({ colorScheme: "dark" });
      const dark = await colors();
      await pg.emulateMedia({ colorScheme: "light" });
      for (const c of [light, dark]) {
        assert.equal(c.bg, "rgb(255, 255, 255)"); assert.equal(c.fg, "rgb(31, 41, 55)");
        assert.equal(c.cancel, "rgb(241, 245, 249)", "キャンセルは従来のグレー");
        const m = c.del.match(/\d+/g).map(Number); assert.ok(Math.max(...m) - Math.min(...m) <= 25 && m[0] <= m[2], "削除ボタンはグレー(赤くない): " + c.del);
      }

      // サーバーが拒否(注文履歴・他の利用者)した場合は、理由を表示して画面に残る
      await pg.evaluate(() => { window.__fail = "注文履歴がある施設は削除できません"; });
      await del.click();
      await sec.getByText("注文履歴がある施設は削除できません", { exact: false }).last().waitFor();
      assert.deepEqual(await pg.evaluate(() => window.__calls), [{ facilityId: "f1" }], "施設IDだけを送る(施設名では特定しない)");
      assert.deepEqual(await pg.evaluate(() => window.__deleted), []);
      assert.equal(await del.isDisabled(), false, "再試行できる");

      // 成功: 通知する(画面側で所属を取得し直す)。処理中に何度押しても、送信は1回だけ(二重送信の防止)
      await pg.evaluate(() => { window.__fail = null; window.__delay = 400; });
      await del.click();
      assert.equal(await del.isDisabled(), true, "処理中は押せない");
      assert.equal(await box.getByRole("button", { name: "キャンセル" }).isDisabled(), true);
      await del.click({ force: true, noWaitAfter: true }).catch(() => {});
      await pg.keyboard.press("Escape");
      assert.equal(await box.isVisible(), true, "処理中は Esc でも閉じない");
      await pg.waitForFunction(() => window.__deleted.length === 1);
      assert.deepEqual(await pg.evaluate(() => window.__deleted), ["f1"]);
      assert.equal((await pg.evaluate(() => window.__calls)).length, 2, "失敗の1回+成功の1回(二重送信なし)");
      assert.equal(await box.isHidden(), true, "成功でダイアログは閉じる");

      // キャンセルで確認欄が閉じる
      await trash.click();
      await box.getByRole("button", { name: "キャンセル" }).click();
      assert.equal(await box.isHidden(), true);
      // PC幅でも同じ
      await pg.setViewportSize({ width: 1100, height: 900 });
      const [pb2, tb2, cb2] = [await pencil.boundingBox(), await trash.boundingBox(), await closeBtn.boundingBox()];
      assert.ok(Math.abs(pb2.y - tb2.y) < 3 && pb2.x + pb2.width <= tb2.x && tb2.x + tb2.width <= cb2.x + 1, "PC幅でも 鉛筆→ゴミ箱→戻る");
      assert.ok(Math.abs(pb2.width - tb2.width) < 1 && Math.abs(pb2.height - tb2.height) < 1);
      await pg.setViewportSize({ width: 390, height: 900 });
      assert.equal(await pg.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);

      // ⓘの説明(ツールチップ)も、ダークモードで白背景・濃い文字・薄いグレーの枠・控えめな影(ダイアログと同じ配色)
      await pg.emulateMedia({ colorScheme: "dark" });
      await pg.locator(".info-tip-btn").first().click();
      const tip = await pg.locator(".info-tip-pop").first().evaluate(e => { const s = getComputedStyle(e); return { bg: s.backgroundColor, fg: s.color, border: s.borderTopColor, shadow: s.boxShadow }; });
      await pg.emulateMedia({ colorScheme: "light" });
      assert.equal(tip.bg, "rgb(255, 255, 255)"); assert.equal(tip.fg, "rgb(31, 41, 55)");
      assert.equal(tip.border, "rgb(209, 213, 219)", "薄いグレーの枠");
      assert.match(tip.shadow, /0\.12\)/, "控えめな影");

      // 削除用の関数がなければ、ゴミ箱は出ない
      await pg.goto(base + "norename");
      await pg.waitForFunction(() => window.__ready);
      assert.equal(await pg.locator("#btnDeleteFacility").count(), 0);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
