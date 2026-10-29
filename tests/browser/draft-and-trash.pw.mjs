// 回帰テスト(ブラウザ): 入力内容の自動保存・復元(localStorage の下書き)と、レンズカードのゴミ箱(削除と「元に戻す」)。  npm run test:browser
// 実際の styles.css・src/ui/lens-lines.js・src/ui/draft-store.js・src/ui/undo-toast.js を最小のページで確認する(ログイン・Firebase は使わない)。
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
<textarea id="notesInput" name="notes"></textarea>
</div></form></main>
<script type="module">
import { createLensLines } from "/src/ui/lens-lines.js";
import { buildLensOptions } from "/src/domain/lens-options.js";
import { createDraftStore } from "/src/ui/draft-store.js";
import { draftKey } from "/src/domain/order-draft.js";
import { showUndoToast } from "/src/ui/undo-toast.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
const q = new URLSearchParams(location.search);
const uid = q.get("uid") || "u1";
const options = buildLensOptions(IOL_MODELS);
const doctors = [{ id: "o1", name: "山田" }, { id: "o2", name: "佐藤" }];
let draft = null;
const lines = createLensLines({
  container: document.getElementById("lensLines"), addButton: document.getElementById("btnAddLine"),
  getOptions: () => options, getDoctors: () => doctors, minDate: () => "2020-01-01",
  onChange: () => { if (draft) draft.save(); },
  onLineRemoved: ({ lineNo, undo }) => showUndoToast("レンズ" + lineNo + "を削除しました", undo)
});
draft = createDraftStore({ key: draftKey(uid, "fac1"), form: document.getElementById("iolOrderForm"), lensLinesBox: document.getElementById("lensLines"),
  notesInput: document.getElementById("notesInput"), getLensLines: () => lines, onRestored: () => { window.__restored = true; } });
draft.restore();
window.__lines = lines; window.__draft = draft; window.__key = draftKey(uid, "fac1");
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
  test(`下書きの自動保存・復元と、レンズのゴミ箱(元に戻す): ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      page.on("dialog", d => { errors.push("確認ダイアログが出た: " + d.message()); d.dismiss(); });   // 確認ダイアログは不要
      const open = async (uid = "u1") => { await page.goto(`${base}?uid=${uid}`); await page.waitForFunction(() => window.__ready); };
      const L = (i) => page.locator(".lens-line").nth(i);
      const stored = (uid = "u1") => page.evaluate((k) => { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; }, `iol-order-draft:v1:${uid}:fac1`);
      const fill = async (i, { toric = false, model, power, qty, date, doctor }) => {
        await L(i).locator("[data-f=toric]").setChecked(toric);
        await L(i).locator("[data-f=model]").selectOption(model);
        await L(i).locator("[data-f=power]").selectOption(power);
        if (qty === 2) await L(i).locator(".quantity-btn").nth(1).click();
        await L(i).locator("[data-f=date]").fill(date);
        await L(i).locator("[data-f=doctor]").selectOption(doctor);
      };
      const read = (i) => page.locator(".lens-line").nth(i).evaluate(l => ({
        toric: l.querySelector("[data-f=toric]").checked, model: l.querySelector("[data-f=model]").value, power: l.querySelector("[data-f=power]").value,
        qty: (l.querySelector("[data-f=quantity]:checked") || {}).value, date: l.querySelector("[data-f=date]").value, doctor: l.querySelector("[data-f=doctor]").value, title: l.querySelector(".lens-line-title").textContent }));

      // ---- 自動保存と復元 ----
      await open();
      assert.equal(await stored(), null, "空の状態では下書きを作らない");
      await fill(0, { model: "jj-dib00v", power: "+20.0D", qty: 2, date: "2099-02-01", doctor: "o2" });
      await page.click("#btnAddLine");
      await fill(1, { toric: true, model: "jj-diwxxx-toric|DIW300", power: "+18.5D", date: "2099-02-09", doctor: "o1" });
      await page.fill("#notesInput", "右眼\n備考のテスト");
      await page.waitForFunction((k) => { const v = JSON.parse(localStorage.getItem(k) || "null"); return v && v.notes === "右眼\n備考のテスト" && v.lines.length === 2; }, "iol-order-draft:v1:u1:fac1");
      const d = await stored();
      assert.deepEqual(d.lines[0], { toric: false, multifocal: false, modelKey: "jj-dib00v", power: "+20.0D", quantity: 2, quantityManual: true, date: "2099-02-01", doctorId: "o2", dealerId: "" });
      assert.deepEqual([d.lines[1].quantity, d.lines[1].quantityManual], [2, false], "トーリックは初期値が2枚(利用者は変えていない)");
      assert.deepEqual(d.lines[1].modelKey, "jj-diwxxx-toric|DIW300");
      assert.ok(!/token|password|idToken|email|uid/i.test(JSON.stringify(d)), "認証情報・ユーザー情報は保存しない: " + JSON.stringify(d));

      // リフレッシュ(再読み込み)・ブラウザの再起動後も復元される(別のレンズ・備考も)。復元後も、選択肢の中から選ばれた値になっている
      await open();
      assert.equal(await page.evaluate(() => window.__restored), true);
      assert.equal(await page.locator(".lens-line").count(), 2);
      assert.deepEqual(await read(0), { toric: false, model: "jj-dib00v", power: "+20.0D", qty: "2", date: "2099-02-01", doctor: "o2", title: "レンズ1" });
      assert.deepEqual(await read(1), { toric: true, model: "jj-diwxxx-toric|DIW300", power: "+18.5D", qty: "2", date: "2099-02-09", doctor: "o1", title: "レンズ2" });
      assert.equal(await page.inputValue("#notesInput"), "右眼\n備考のテスト");
      assert.equal(await page.evaluate(() => window.__lines.values()[1].lens.toricModel), "DIW300", "復元後も、型番に対応するデータとして使われる");
      assert.equal(await page.evaluate(() => window.__lines.validate().ok), true);

      // ログインユーザー単位で分離: 別のユーザーには復元されない(下書きも別々に保存される)
      await open("u2");
      assert.equal(await page.locator(".lens-line").count(), 1);
      assert.equal((await read(0)).model, "");
      assert.equal(await page.inputValue("#notesInput"), "");
      await page.fill("#notesInput", "u2のメモ");
      await page.waitForFunction((k) => localStorage.getItem(k), "iol-order-draft:v1:u2:fac1");
      assert.equal((await stored("u1")).notes, "右眼\n備考のテスト", "u1の下書きは変わらない");

      // 選択肢にない値(モデルに対応しない度数・存在しない担当医・過去の手術日)は復元されず未選択。入力チェックで再入力を求める
      await page.evaluate((k) => { const d = JSON.parse(localStorage.getItem(k)); d.lines[0].power = "-5.0D"; d.lines[0].doctorId = "ghost"; d.lines[0].date = "2001-01-01"; d.lines[1].modelKey = "no-such-model"; localStorage.setItem(k, JSON.stringify(d)); }, "iol-order-draft:v1:u1:fac1");
      await open();
      assert.deepEqual([(await read(0)).power, (await read(0)).doctor, (await read(0)).date], ["", "", ""]);
      assert.equal((await read(1)).model, "");
      assert.equal(await page.evaluate(() => window.__lines.validate().ok), false, "復元後も入力チェックが働く");
      // 壊れた下書きは捨てて、通常どおり動く
      await page.evaluate((k) => { window.__draft.setReady(false); localStorage.setItem(k, "{broken"); }, "iol-order-draft:v1:u1:fac1");   // 古いページが離れるときに上書きしないように
      await open();
      assert.equal(await page.locator(".lens-line").count(), 1);
      assert.equal(await page.evaluate((k) => localStorage.getItem(k), "iol-order-draft:v1:u1:fac1"), null);

      // 発注が正常に完了したときだけ削除(draft.clear)。失敗時は何も呼ばないので残る
      await open("u3");
      await fill(0, { model: "jj-dib00v", power: "+20.0D", date: "2099-02-01", doctor: "o1" });
      await page.waitForFunction((k) => localStorage.getItem(k), "iol-order-draft:v1:u3:fac1");
      await open("u3");
      assert.equal(await page.evaluate(() => window.__restored), true, "送信失敗(clearしない)なら、下書きは残る");
      await page.evaluate(() => { window.__draft.clear(); window.__draft.setReady(false); });
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      assert.equal(await stored("u3"), null, "完了後は、画面を離れても、下書きを保存し直さない");
      await open("u3");
      assert.equal((await read(0)).model, "");

      // ---- ゴミ箱(削除・元に戻す) ----
      await open("u4");
      for (let i = 0; i < 3; i++) {
        if (i) await page.click("#btnAddLine");
        await fill(i, { model: ["jj-dib00v", "alcon-cna0t0", "hoya-xy1"][i], power: ["+20.0D", "+21.0D", "+22.0D"][i], date: `2099-02-0${i + 1}`, doctor: "o1" });
      }
      // 「レンズを追加」で入力済みのレンズ1・2は折りたたまれる(折りたたみ中はゴミ箱を出さない)。展開してから削除を確認する
      assert.equal(await page.locator(".lens-line.is-collapsed .lens-line-trash:visible").count(), 0);
      while (await page.locator(".lens-line.is-collapsed").count()) await page.locator(".lens-line.is-collapsed .lens-line-summary").first().click();
      assert.equal(await page.locator(".lens-line.is-collapsed").count(), 0);
      // 右上の控えめなゴミ箱アイコン(カードの中・右寄り・タップしやすい大きさ)
      for (const w of [390, 1100]) {
        await page.setViewportSize({ width: w, height: 900 });
        const geo = await L(0).evaluate(l => { const b = l.querySelector(".lens-line-trash").getBoundingClientRect(), c = l.getBoundingClientRect(), t = l.querySelector(".lens-line-title").getBoundingClientRect(); return { inside: b.right <= c.right + 0.5 && b.left >= c.left, right: c.right - b.right, w: b.width, h: b.height, afterTitle: b.left > t.right, top: b.top - c.top, svg: !!l.querySelector(".lens-line-trash svg") }; });
        assert.ok(geo.inside && geo.afterTitle && geo.svg && geo.w >= 36 && geo.h >= 36 && geo.right < 24 && geo.top < 24, `${w}: ${JSON.stringify(geo)}`);
      }
      await page.setViewportSize({ width: 390, height: 900 });
      assert.equal(await L(0).locator(".lens-line-trash").evaluate(b => b.textContent.trim()), "", "文字なし(アイコンのみ)");

      await L(1).locator(".lens-line-trash").click();
      assert.equal(await page.locator(".lens-line").count(), 2, "そのレンズだけ削除(確認ダイアログなし)");
      assert.deepEqual([(await read(0)).title, (await read(1)).title], ["レンズ1", "レンズ2"], "レンズ番号を振り直す");
      assert.equal((await read(1)).model, "hoya-xy1");
      const toast = page.locator(".undo-toast");
      assert.match(await toast.innerText(), /レンズ2を削除しました\s*元に戻す/);
      const tr = await toast.evaluate(e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom, vw: innerWidth, vh: innerHeight }; });
      assert.ok(tr.l >= 0 && tr.r <= tr.vw && tr.b <= tr.vh, "通知が画面内: " + JSON.stringify(tr));
      assert.equal((await stored("u4")).lines.length, 2, "削除は下書きに即時反映");
      // 元に戻す: 元の位置に、同じ内容で戻る。下書きにも即時反映
      await toast.getByRole("button", { name: "元に戻す" }).click();
      assert.equal(await page.locator(".lens-line").count(), 3);
      assert.deepEqual(await read(1), { toric: false, model: "alcon-cna0t0", power: "+21.0D", qty: "1", date: "2099-02-02", doctor: "o1", title: "レンズ2" });
      assert.deepEqual([(await read(0)).title, (await read(2)).title, (await read(2)).model], ["レンズ1", "レンズ3", "hoya-xy1"]);
      assert.equal(await toast.count(), 0);
      assert.equal((await stored("u4")).lines.length, 3);
      assert.equal((await stored("u4")).lines[1].modelKey, "alcon-cna0t0");

      // 先頭を削除 → 残りが繰り上がる。元に戻すと先頭に戻る
      await L(0).locator(".lens-line-trash").click();
      assert.deepEqual([(await read(0)).model, (await read(0)).title], ["alcon-cna0t0", "レンズ1"]);
      await page.locator(".undo-toast").getByRole("button", { name: "元に戻す" }).click();
      assert.deepEqual([(await read(0)).model, (await read(1)).model, (await read(2)).model], ["jj-dib00v", "alcon-cna0t0", "hoya-xy1"]);

      // 最後の1枚は削除せず、空の入力カードに戻す(元に戻せる)。下書きは(空になるので)消え、元に戻すと保存し直される
      await L(2).locator(".lens-line-trash").click(); await L(1).locator(".lens-line-trash").click();
      assert.equal(await page.locator(".lens-line").count(), 1);
      await L(0).locator(".lens-line-trash").click();
      assert.equal(await page.locator(".lens-line").count(), 1, "最後の1枚は残る");
      assert.deepEqual(await read(0), { toric: false, model: "", power: "", qty: "1", date: "", doctor: "", title: "レンズ1" });
      assert.match(await page.locator(".undo-toast").innerText(), /レンズ1を削除しました/);
      assert.equal(await stored("u4"), null, "空になったので下書きも空");
      await page.locator(".undo-toast").getByRole("button", { name: "元に戻す" }).click();
      assert.equal((await read(0)).model, "jj-dib00v");
      assert.equal((await stored("u4")).lines[0].modelKey, "jj-dib00v");

      // 通知は時間で消える(新しい通知が出たら古いものは置き換わる)
      await L(0).locator(".lens-line-trash").click();
      await page.waitForSelector(".undo-toast");
      assert.equal(await page.locator(".undo-toast").count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
      assert.deepEqual(errors, []);
      await context.close();
    } finally { await browser.close(); }
  });
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`枚数の初期値: トーリック・多焦点なら2枚、どちらもなければ1枚。利用者が変えた枚数は、チェック・再描画・復元で上書きしない(レンズごと): ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await (await browser.newContext({ viewport: { width: 390, height: 900 } })).newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      const open = async (uid) => { await page.goto(`${base}?uid=${uid}`); await page.waitForFunction(() => window.__ready); };
      const L = (i) => page.locator(".lens-line").nth(i);
      const qty = (i) => L(i).evaluate(l => (l.querySelector("[data-f=quantity]:checked") || {}).value);
      const check = (i, f, on) => L(i).locator(`[data-f=${f}]`).setChecked(on);
      const pick = (i, n) => L(i).locator(".quantity-btn").nth(n - 1).click();
      const key = (uid) => `iol-order-draft:v1:${uid}:fac1`;

      await open("q1");
      assert.equal(await qty(0), "1", "どちらも未選択なら1枚");
      await check(0, "toric", true); assert.equal(await qty(0), "2", "トーリック → 2枚");
      await check(0, "toric", false); assert.equal(await qty(0), "1", "外すと1枚");
      await check(0, "multifocal", true); assert.equal(await qty(0), "2", "多焦点 → 2枚");
      await check(0, "toric", true); await check(0, "multifocal", false); assert.equal(await qty(0), "2", "トーリックが残っていれば2枚");
      await check(0, "toric", false); assert.equal(await qty(0), "1");
      // レンズごとに独立
      await page.click("#btnAddLine");
      await check(1, "toric", true);
      assert.deepEqual([await qty(0), await qty(1)], ["1", "2"]);
      // 利用者が変えた後は、チェックの操作で変えない(そのレンズだけ)
      await pick(0, 2);
      await check(0, "toric", true); await check(0, "toric", false); await check(0, "multifocal", true);
      assert.equal(await qty(0), "2", "手動の2枚のまま");
      await pick(0, 1);
      await check(0, "toric", true);
      assert.equal(await qty(0), "1", "多焦点・トーリックでも、手動の1枚を優先");
      await check(1, "toric", false); assert.equal(await qty(1), "1", "レンズ2は自動のまま");
      await check(1, "multifocal", true); assert.equal(await qty(1), "2");
      // 再描画(選択肢の作り直し)でも変えない
      await page.evaluate(() => window.__lines.refresh());
      assert.deepEqual([await qty(0), await qty(1)], ["1", "2"]);
      // リフレッシュ後の復元: 手動の枚数は守り、自動の明細は引き続きチェックに合わせる
      await page.waitForFunction((k) => { const d = JSON.parse(localStorage.getItem(k) || "null"); return d && d.lines.length === 2 && d.lines[1].multifocal; }, key("q1"));
      await open("q1");
      assert.deepEqual([await qty(0), await qty(1)], ["1", "2"]);
      await check(0, "toric", false); await check(0, "toric", true);
      assert.equal(await qty(0), "1", "復元後も手動の枚数を優先");
      await check(1, "multifocal", false);
      assert.equal(await qty(1), "1", "復元後も自動の明細はチェックに合わせる");
      // 記録のない古い下書き: チェックの状態の初期値と違う枚数は、利用者の選択とみなす
      await page.evaluate((k) => {
        window.__draft.setReady(false);
        localStorage.setItem(k, JSON.stringify({ v: 1, savedAt: Date.now(), notes: "", lines: [
          { toric: true, multifocal: false, modelKey: "", power: "", quantity: 1, date: "", doctorId: "", dealerId: "" },
          { toric: true, multifocal: false, modelKey: "", power: "", quantity: 2, date: "", doctorId: "", dealerId: "" }] }));
      }, key("q2"));
      await open("q2");
      assert.deepEqual([await qty(0), await qty(1)], ["1", "2"]);
      await check(0, "toric", false); await check(0, "toric", true);
      await check(1, "toric", false);
      assert.deepEqual([await qty(0), await qty(1)], ["1", "1"], "古い下書き: トーリックで1枚は手動、2枚は自動として扱う");
      // 削除して元に戻しても、手動の記録を保つ
      await pick(1, 2);
      await L(1).locator(".lens-line-trash").click();
      await page.locator(".undo-toast").getByRole("button", { name: "元に戻す" }).click();
      await check(1, "toric", true); await check(1, "toric", false);
      assert.equal(await qty(1), "2");
      assert.equal(await page.evaluate(() => window.__lines.values()[1].quantity), 2, "注文の値も画面と同じ");
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
