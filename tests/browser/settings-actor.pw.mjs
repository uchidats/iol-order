// 回帰テスト(ブラウザ): 施設設定の変更者の記録。実際の施設設定の画面(facility-settings.js)と、実際の書き込みAPI
// (createFirestoreSettingsApi。変更者の記録を有効にした状態)を、書き込みを記録する偽の Firestore で動かす。
// 追加・編集・並び替え(自動保存)・採用IOL・削除のすべてで updatedBy / 削除の記録が付き、従来の保存・並び替え・削除が動くことを確認する。
//   npm run test:browser
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
import { createFirestoreSettingsApi } from "/src/data/firestore-repository.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
const store = new Map(Object.entries({
  "facilities/f1/orderers/d1": { facilityId: "f1", name: "山田", sortOrder: 10 },
  "facilities/f1/orderers/d2": { facilityId: "f1", name: "佐藤", sortOrder: 20 },
  "facilities/f1/adoptedIols/alcon-cna0t0": { facilityId: "f1", catalogIolId: "alcon-cna0t0", enabled: true },
  "facilities/f1/facilityDealers/s1": { facilityId: "f1", name: "A商会", sortOrder: 10, orderEmails: ["a@example.jp"], usageReportEmails: [] },
  "facilities/f1/facilityDealers/s2": { facilityId: "f1", name: "B医療", sortOrder: 20, orderEmails: [], usageReportEmails: [] }
}));
window.__batches = [];
let seq = 0;
const fakeFs = {
  serverTimestamp: () => "SERVER_TS",
  collection: (db, ...p) => ({ coll: p.join("/") }),
  doc: (a, ...p) => (a && a.coll ? { path: a.coll + "/new" + (++seq) } : { path: p.join("/") }),
  writeBatch: () => { const ops = []; return { set: (r, d) => ops.push(["set", r.path, d]), delete: (r) => ops.push(["delete", r.path]),
    commit: async () => { await new Promise(r => setTimeout(r, 20)); for (const [k, p, d] of ops) { if (k === "set") store.set(p, d); else store.delete(p); } window.__batches.push(ops); } }; },
  deleteDoc: async (r) => { store.delete(r.path); window.__batches.push([["deleteDoc", r.path]]); },
  setDoc: async (r, d) => { store.set(r.path, d); window.__batches.push([["setDoc", r.path, d]]); }
};
const list = (sub) => [...store.entries()].filter(([p]) => p.startsWith("facilities/f1/" + sub + "/") && p.split("/").length === 4).map(([p, d]) => ({ id: p.split("/")[3], ...d }));
const by = (a, b) => (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9);
const repository = { listOrderers: async () => list("orderers").sort(by), listAdoptedIols: async () => list("adoptedIols"), listDealers: async () => list("facilityDealers").sort(by), listMembers: async () => [], getIolOrder: async () => null };
const settingsApi = createFirestoreSettingsApi({}, fakeFs, { getUid: () => "adminA", trackActor: true });
window.__store = () => Object.fromEntries(store);
const s = createFacilitySettings({ mount: document.querySelector("main"), repository, settingsApi, masters: IOL_MODELS, onSaved: async () => {}, onClose() {} });
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

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`施設設定の変更者の記録: 追加・編集・並び替え・採用IOL・削除のすべてに updatedBy / 削除の記録が付く: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 1400 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      page.on("dialog", d => d.accept());
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      const batches = () => page.evaluate(() => window.__batches);
      const waitBatches = (n) => page.waitForFunction((k) => window.__batches.length >= k, n);
      const docs = page.locator('[data-section="orderers"]'), deals = page.locator('[data-section="dealers"]'), iols = page.locator('[data-section="iols"]');

      // 担当医の追加(確定で保存)
      await docs.locator('[data-act="add"]').click();
      await docs.locator(".orderer-item.is-editing [data-f=name]").fill("田中");
      await docs.locator(".orderer-item.is-editing [data-act=save-row]").click();
      await waitBatches(1);
      // 並び替え(自動保存)
      await docs.locator(".orderer-item").nth(2).locator('[data-act="up"]').click();
      await waitBatches(2);
      // 採用IOL(チェックで自動保存)
      await iols.locator('details[data-maker="J&J"] summary').click();
      await iols.locator('input[value="jj-dib00v"]').check();
      await waitBatches(3);
      // ディーラーの発注用メールの変更
      await deals.locator(".dealer-item").first().locator('[data-act="edit"]').click();
      await deals.locator(".dealer-item").first().locator("[data-f=orderEmails]").fill("z@other.jp");
      await deals.locator(".dealer-item").first().locator("[data-act=save-row]").click();
      await waitBatches(4);
      const sets = (await batches()).flat().filter(o => o[0] === "set");
      assert.ok(sets.length >= 4);
      for (const [, p, d] of sets) {
        assert.equal(d.updatedBy, "adminA", p);
        assert.equal(d.updatedAt, "SERVER_TS", p);
      }
      const st = await page.evaluate(() => window.__store());
      assert.equal(Object.values(st).filter(d => d.name === "田中").length, 1, "追加は1件(重複しない)");
      assert.deepEqual(st["facilities/f1/facilityDealers/s1"].orderEmails, ["z@other.jp"]);
      assert.equal(st["facilities/f1/adoptedIols/jj-dib00v"].enabled, true);

      // 削除: 担当医・ディーラーとも、削除と削除の記録が同じ一括書き込み
      const before = (await batches()).length;
      await docs.locator(".orderer-item").last().locator('[data-act="delete"]').click();
      await waitBatches(before + 1);
      await deals.locator(".dealer-item").last().locator('[data-act="delete"]').click();
      await page.waitForFunction((k) => window.__batches.some((b, i) => i >= k && b.some(o => o[0] === "delete" && o[1].includes("facilityDealers"))), before);
      const dels = (await batches()).slice(before).filter(b => b.some(o => o[0] === "delete"));
      assert.equal(dels.length, 2);
      for (const b of dels) {
        const [, target] = b.find(o => o[0] === "delete");
        const [col, id] = target.split("/").slice(2);
        assert.deepEqual(b.find(o => o[0] === "set"), ["set", `facilities/f1/deletionMarks/${col}_${id}`, { collection: col, docId: id, deletedBy: "adminA", deletedAt: "SERVER_TS" }]);
      }
      assert.ok(!(await batches()).flat().some(o => o[0] === "deleteDoc"), "削除の記録のない単独の削除はしない");
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
