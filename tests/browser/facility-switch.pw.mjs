// 回帰テスト(ブラウザ): 「施設を切り替える」と施設の選択画面。実際の注文画面(index.html・main.js)を偽の Firebase で動かす。
//   所属1施設: メニューに項目なし / 2施設: 選択画面を出さずにもう一方へ直接(施設を選ぶ前は選択画面)/ 3施設以上: 選択画面。
//   入力中の内容は確認のうえ破棄し、別の施設に引き継がない。選択画面の説明は見出しの右のⓘ。  npm run test:browser
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";
import { newFakeContext } from "./fake-firebase.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/app") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(path.join(ROOT, "index.html"))); return; }
    const p = path.resolve(ROOT, "." + url);
    if (!p.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(p, (e, b) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": (TYPES[path.extname(p)] || "text/plain") + "; charset=utf-8" });
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

/** 所属 n 施設のログイン中の利用者(u1) */
const session = (names) => {
  const db = {};
  names.forEach((name, i) => {
    const id = `f${i + 1}`;
    db[`facilities/${id}`] = { name, status: "active" };
    db[`facilities/${id}/members/u1`] = { uid: "u1", role: "orderer" };
    db[`facilities/${id}/orderers/o1`] = { facilityId: id, name: "山田" };
  });
  return { user: { uid: "u1", email: "u1@example.jp", emailVerified: true, displayName: "利用者" }, db };
};
const headerName = (page) => page.locator("#headerFacility").innerText();
const openMenu = async (page) => { await page.click("#btnHeaderMenu"); };

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`施設の切り替え: 1施設は項目なし・2施設は直接(選ぶ前は選択画面)・3施設は選択画面。入力は引き継がない。選択画面の説明はⓘ: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      // ---- 2施設 ----
      let context = await newFakeContext(browser, base, 390, session(["施設A", "施設B"]));
      let page = await context.newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(`${base}app`);
      // 施設をまだ選んでいない(ログイン直後): 2施設でも選択画面。説明は常時表示せず、見出しの右のⓘ
      const list = page.locator(".facility-select-list [data-facility-id]");
      await list.first().waitFor();
      assert.equal(await list.count(), 2);
      const title = page.locator(".facility-select-title");
      assert.equal((await title.locator(".feature-title").innerText()).trim(), "施設を選択してください");
      assert.equal(await title.locator(".info-tip-btn").count(), 1, "見出しの右にⓘ");
      assert.ok(!(await page.locator("#authPanel").innerText()).includes("複数の施設に所属しています"), "説明文は常時表示しない");
      await title.locator(".info-tip-btn").click();
      await page.getByText("複数の施設に所属しています。注文する施設を選んでください。").waitFor();
      await page.keyboard.press("Escape");
      // 施設ボタンの大きさは従来どおり(.btn の最小の高さ 48px)
      assert.ok((await list.first().evaluate(b => b.getBoundingClientRect().height)) >= 48);
      await list.filter({ hasText: "施設A" }).click();
      await page.waitForFunction(() => document.getElementById("headerFacility").textContent.includes("施設A"));
      // 入力してから切り替え: 確認(キャンセルならそのまま)→ 切り替えると選択画面を出さずに施設B。入力は施設Bに引き継がない
      await page.locator("#notesInput").fill("施設Aの備考");
      await openMenu(page);
      await page.click("#menuSwitchFacility");
      await page.getByText("入力中の内容は破棄されます。「施設B」に切り替えますか？").waitFor();
      await page.getByRole("button", { name: "キャンセル" }).click();
      assert.equal(await page.locator("#notesInput").inputValue(), "施設Aの備考");
      assert.match(await headerName(page), /施設A/);
      await openMenu(page);
      await page.click("#menuSwitchFacility");
      await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "切り替える" }).click()]);
      await page.waitForFunction(() => document.getElementById("headerFacility").textContent.includes("施設B"));
      assert.equal(await page.locator(".facility-select-list").count(), 0, "選択画面は出さない");
      await page.locator("#notesInput").waitFor();
      assert.equal(await page.locator("#notesInput").inputValue(), "", "施設Aの入力は施設Bに引き継がない");
      // 入力がなければ確認なしで、もう一方(施設A)へ戻る
      await openMenu(page);
      await Promise.all([page.waitForEvent("load"), page.click("#menuSwitchFacility")]);
      await page.waitForFunction(() => document.getElementById("headerFacility").textContent.includes("施設A"));
      assert.equal(await page.locator(".facility-select-list").count(), 0);
      assert.deepEqual(errors, []);
      await context.close();

      // ---- 3施設: 従来どおり選択画面 ----
      context = await newFakeContext(browser, base, 390, session(["施設A", "施設B", "施設C"]));
      page = await context.newPage();
      await page.goto(`${base}app`);
      await page.locator(".facility-select-list [data-facility-id]").first().waitFor();
      await page.locator(".facility-select-list [data-facility-id]").filter({ hasText: "施設B" }).click();
      await page.waitForFunction(() => document.getElementById("headerFacility").textContent.includes("施設B"));
      await openMenu(page);
      await Promise.all([page.waitForEvent("load"), page.click("#menuSwitchFacility")]);
      await page.locator(".facility-select-list [data-facility-id]").first().waitFor();
      assert.equal(await page.locator(".facility-select-list [data-facility-id]").count(), 3, "3施設以上は選択画面");
      await context.close();

      // ---- 1施設: 切り替えの項目なし ----
      context = await newFakeContext(browser, base, 390, session(["施設A"]));
      page = await context.newPage();
      await page.goto(`${base}app`);
      await page.waitForFunction(() => document.getElementById("headerFacility").textContent.includes("施設A"));
      await openMenu(page);
      await page.locator("#headerMenu, .header-menu").first().waitFor().catch(() => {});
      assert.equal(await page.locator("#menuSwitchFacility").count(), 0);
      await context.close();
    } finally { await browser.close(); }
  });
}
