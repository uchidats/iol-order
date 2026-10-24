// 回帰テスト(ブラウザ): 施設設定「ディーラー」が「担当医」と同じ見た目・操作であること。  npm run test:browser
// 実際の styles.css と src/ui/facility-settings.js を最小のページに読み込み、偽のリポジトリ・保存APIで確認する(Firebase は使わない)。
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
import { createFacilitySettings } from "/src/ui/facility-settings.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
const dealers = [
  { id: "d1", name: "A商会", sortOrder: 10, orderEmails: ["a1@example.jp", "a2@example.jp"], usageReportEmails: ["ar@example.jp"] },
  { id: "d2", name: "B医療", sortOrder: 20, orderEmails: [], usageReportEmails: [] },
  { id: "d3", name: "C商会", sortOrder: 30, orderEmails: ["c@example.jp"], usageReportEmails: [] }
];
const orderers = [{ id: "o1", name: "山田", email: "y@example.jp", sortOrder: 10 }, { id: "o2", name: "佐藤", sortOrder: 20 }];
window.__saved = []; window.__deleted = []; window.__changed = 0;
const repository = { listOrderers: async () => orderers.map(o => ({ ...o })), listAdoptedIols: async () => [], listDealers: async () => dealers.map(d => ({ ...d })), listMembers: async () => [] };
const settingsApi = {
  saveOrderers: async () => {}, saveAdoptedIols: async () => {},
  saveDealers: async (fid, writes) => {
    window.__saved.push(JSON.parse(JSON.stringify(writes)));
    for (const w of writes) { const d = dealers.find(x => x.id === w.id); if (d) Object.assign(d, w.data); else dealers.push({ id: "new" + dealers.length, ...w.data }); }   // 保存の結果を、次の読み込みに反映する
    dealers.sort((x, y) => (x.sortOrder ?? 1e9) - (y.sortOrder ?? 1e9));
  },
  // (削除も反映)
  deleteDealer: async (fid, id) => { window.__deleted.push(id); const i = dealers.findIndex(x => x.id === id); if (i >= 0) dealers.splice(i, 1); }, deleteOrderer: async () => {}
};
const s = createFacilitySettings({ mount: document.querySelector("main"), repository, settingsApi, masters: IOL_MODELS, onSaved: async () => { window.__changed++; }, onClose() {} });
await s.open({ id: "f1", name: "テスト施設" });
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

const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`施設設定のディーラー: 担当医と同じデザイン・操作(表示→編集→保存・並び替え・削除): ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      const sec = page.locator('[data-section="dealers"]');
      const rows = sec.locator(".dealer-item");

      // 1) 保存済みは入力欄(枠)なしの通常テキスト。メールの件数が分かる。右側に 編集・↑・↓・削除 の4ボタン
      assert.deepEqual(await rows.locator('[data-v="name"]').allInnerTexts(), ["A商会", "B医療", "C商会"]);
      assert.equal(await sec.locator("input:visible, textarea:visible").count(), 0, "保存済みの行に入力欄は出ない");
      assert.match(await rows.nth(0).locator('[data-v="info"]').innerText(), /発注用メール 2件 ・ 使用報告用 1件/);
      assert.match(await rows.nth(1).locator('[data-v="info"]').innerText(), /発注用メール未登録.*自動送信不可/);
      assert.deepEqual(await rows.nth(0).locator(".orderer-actions button").evaluateAll(bs => bs.map(b => b.getAttribute("data-act"))), ["edit", "up", "down", "delete"]);

      // 2) 担当医と同じサイズ・スタイル・配置のボタン
      const geom = (loc) => loc.locator(".orderer-actions button").evaluateAll(bs => bs.map(b => { const r = b.getBoundingClientRect(); const s = getComputedStyle(b); return { w: Math.round(r.width), h: Math.round(r.height), cls: b.className, radius: s.borderRadius, bg: s.backgroundColor, right: Math.round(window.innerWidth - r.right) }; }));
      const gDealer = await geom(rows.nth(0)), gDoctor = await geom(page.locator('[data-section="orderers"] .orderer-item').nth(0));
      assert.deepEqual(gDealer.map(g => [g.w, g.h, g.cls, g.radius, g.bg]), gDoctor.map(g => [g.w, g.h, g.cls, g.radius, g.bg]), "ボタンのサイズ・スタイルが担当医と同じ");
      assert.equal(gDealer[3].right, gDoctor[3].right, "右端の位置が担当医と同じ");
      const addBtns = async (sel) => page.locator(`${sel} .settings-actions button`).evaluateAll(bs => bs.map(b => [b.className, b.textContent.trim()]));
      assert.deepEqual((await addBtns('[data-section="dealers"]')).map(x => x[0]), (await addBtns('[data-section="orderers"]')).map(x => x[0]), "追加・保存ボタンのデザインが担当医と同じ");
      assert.deepEqual((await addBtns('[data-section="dealers"]')).map(x => x[1]), ["ディーラーを追加", "ディーラーを保存"]);

      // 3) 編集ボタンを押した行だけ入力欄になる。発注用・使用報告用メールは編集時に確認・変更できる
      await rows.nth(0).locator('[data-act="edit"]').click();
      assert.equal(await sec.locator("input:visible").count(), 1);
      assert.equal(await rows.nth(0).locator('[data-f="orderEmails"]').inputValue(), "a1@example.jp\na2@example.jp");
      assert.equal(await rows.nth(0).locator('[data-f="usageEmails"]').inputValue(), "ar@example.jp");
      await rows.nth(0).locator('[data-f="name"]').fill("A商会(新)");
      await rows.nth(0).locator('[data-f="orderEmails"]').fill("a1@example.jp\nnew@example.jp");
      // 編集中に「ディーラーを保存」を押しても保存されない(担当医と同じ)
      await sec.locator('[data-act="save"]').click();
      assert.equal(await page.evaluate(() => window.__saved.length), 0);
      assert.match(await sec.locator("[data-msg]").innerText(), /編集中の行/);
      // 行の「保存」: 検証 → 保存。sortOrder は表示順(10刻み)。メールは変更が反映され、使用報告用は維持
      await rows.nth(0).locator('[data-act="save-row"]').click();
      await page.waitForFunction(() => window.__saved.length === 1);
      const w1 = await page.evaluate(() => window.__saved[0]);
      assert.equal(w1.length, 1, "変更のあった行だけ保存");
      assert.deepEqual([w1[0].id, w1[0].data.name, w1[0].data.sortOrder, w1[0].data.orderEmails, w1[0].data.usageReportEmails], ["d1", "A商会(新)", 10, ["a1@example.jp", "new@example.jp"], ["ar@example.jp"]]);

      // 4) 入力不正(重複した名前・不正なメール)は保存されず、編集中のまま入力を残す
      await rows.nth(1).locator('[data-act="edit"]').click();
      await rows.nth(1).locator('[data-f="name"]').fill("C商会");
      await rows.nth(1).locator('[data-f="orderEmails"]').fill("not-an-email");
      await rows.nth(1).locator('[data-act="save-row"]').click();
      assert.match(await rows.nth(1).locator("[data-err]").innerText(), /重複|形式|メール/);
      assert.equal(await rows.nth(1).locator('[data-f="orderEmails"]').inputValue(), "not-an-email", "入力は残る");
      assert.equal(await page.evaluate(() => window.__saved.length), 1, "不正な入力は保存されない");
      await rows.nth(1).locator('[data-act="cancel-row"]').click();
      assert.equal(await rows.nth(1).locator('[data-v="name"]').innerText(), "B医療", "キャンセルで元に戻る");

      // 5) ↑↓で並び替え → 保存すると sortOrder が入れ替わる(発注先の判定には使わない。表示順だけ)
      await rows.nth(2).locator('[data-act="up"]').click();
      assert.deepEqual(await rows.locator('[data-v="name"]').allInnerTexts(), ["A商会(新)", "C商会", "B医療"]);
      await sec.locator('[data-act="save"]').click();
      await page.waitForFunction(() => window.__saved.length === 2);
      const w2 = await page.evaluate(() => window.__saved[1]);
      assert.deepEqual(w2.map(x => [x.id, x.data.sortOrder]).sort(), [["d2", 30], ["d3", 20]].sort());
      assert.ok(w2.every(x => "orderEmails" in x.data && "usageReportEmails" in x.data), "メール設定は維持される");

      // 6) 追加 → 編集状態で表示。キャンセルで消える。削除は確認ダイアログ
      await sec.locator('[data-act="add"]').click();
      assert.equal(await sec.locator(".dealer-item.is-editing").count(), 1);
      await sec.locator(".dealer-item.is-editing").locator('[data-act="cancel-row"]').click();
      assert.equal(await sec.locator(".dealer-item").count(), 3);
      page.once("dialog", d => d.dismiss());
      await rows.nth(0).locator('[data-act="delete"]').click();
      assert.deepEqual(await page.evaluate(() => window.__deleted), [], "キャンセルなら削除しない");
      page.once("dialog", d => d.accept());
      await rows.nth(0).locator('[data-act="delete"]').click();
      await page.waitForFunction(() => window.__deleted.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__deleted), ["d1"]);

      // 7) スマホ幅: ボタンが重ならず、横にはみ出さない(通常表示・編集表示とも)
      for (const w of [390, 320]) {
        await page.setViewportSize({ width: w, height: 1000 });
        for (const editing of [false, true]) {
          if (editing) await rows.first().locator('[data-act="edit"]').click();
          const info = await rows.first().evaluate(r => ({
            btns: [...r.querySelectorAll(".orderer-actions button")].filter(b => b.offsetParent).map(b => { const x = b.getBoundingClientRect(); return { left: x.left, right: x.right, top: x.top, bottom: x.bottom }; }),
            name: (() => { const x = r.querySelector('[data-v="name"]').getBoundingClientRect(); return { left: x.left, right: x.right, top: x.top, bottom: x.bottom, w: x.width }; })(),
            over: document.documentElement.scrollWidth > document.documentElement.clientWidth
          }));
          assert.equal(info.over, false, `横スクロール ${w} ${editing}`);
          if (!editing) {
            for (let i = 0; i < info.btns.length; i++) for (let j = i + 1; j < info.btns.length; j++) assert.equal(overlap(info.btns[i], info.btns[j]), false, `ボタンが重なる ${w}`);
            info.btns.forEach(b => assert.equal(overlap(b, info.name), false, `名前とボタンが重なる ${w}`));
          }
          if (editing) await rows.first().locator('[data-act="cancel-row"]').click();
        }
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
