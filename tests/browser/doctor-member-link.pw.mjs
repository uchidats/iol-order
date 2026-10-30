// 回帰テスト(ブラウザ): 担当医の追加・編集時の「利用者管理にも追加する（注文者）」。  npm run test:browser
// 事前登録(addMember)が成功してから担当医を保存する。失敗時は保存せず入力を保持。重複は登録せず担当医は保存。
// 担当医の保存だけ失敗した場合は再試行でき、事前登録は二重に送らない。
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
const DAY = 864e5, now = Date.now();
const orderers = [
  { id: "d1", facilityId: "f1", name: "山田医師", email: "", sortOrder: 10 },
  { id: "d2", facilityId: "f1", name: "佐藤医師", email: "o@example.jp", sortOrder: 20 }
];
const members = [{ uid: "me", role: "admin", displayName: "自分", email: "me@example.jp" }, { uid: "ordA", role: "orderer", displayName: "注文者A", email: "o@example.jp" }];
const pending = [{ id: "f1_" + "a".repeat(64), facilityId: "f1", name: "参加待ち", email: "wait@example.jp", role: "orderer", status: "pending", expiresAt: new Date(now + DAY).toISOString() }];
window.__calls = []; window.__failAdd = null; window.__failSave = false;
const repository = { listOrderers: async () => orderers.map(o => ({ ...o })), listAdoptedIols: async () => [], listDealers: async () => [],
  listMembers: async () => members.map(m => ({ ...m })), listPendingMembers: async () => pending.map(p => ({ ...p })) };
const settingsApi = {
  saveOrderers: async (fid, writes) => {
    window.__calls.push(["saveOrderers", JSON.parse(JSON.stringify(writes))]);
    if (window.__failSave) throw new Error("network");
    for (const w of writes) { const o = w.id && orderers.find(x => x.id === w.id); if (o) Object.assign(o, w.data); else orderers.push({ id: "n" + orderers.length, ...w.data }); }
  },
  saveAdoptedIols: async () => {}, saveDealers: async () => {}, deleteDealer: async () => {}, deleteOrderer: async () => {}
};
const inviteApi = {
  removeMember: async () => ({}), changeMemberRole: async () => ({}), cancelPendingMember: async () => ({}), renewPendingMember: async () => ({}),
  addMember: async (a) => {
    window.__calls.push(["addMember", a]);
    if (window.__failAdd) { const e = new Error(window.__failAdd.message); e.code = window.__failAdd.code; throw e; }
    pending.push({ id: "f1_" + "e".repeat(64), facilityId: "f1", ...a, status: "pending", expiresAt: new Date(now + 30 * DAY).toISOString() });
    return { ...a, pendingId: "x", status: "pending", expiresAt: new Date(now + 30 * DAY).toISOString() };
  }
};
const s = createFacilitySettings({ mount: document.querySelector("main"), repository, settingsApi, masters: IOL_MODELS, inviteApi,
  currentUser: { uid: "me", displayName: "自分" }, actorRole: "admin", onSaved: async () => {}, onClose() {} });
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
  test(`担当医 → 利用者管理(注文者)の事前登録: 表示条件・メール必須・登録の順番・失敗時・重複・再試行: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const page = await browser.newPage({ viewport: { width, height: 1400 } });
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await page.goto(base);
        await page.waitForFunction(() => window.__ready);
        const sec = page.locator('[data-section="orderers"]');
        const calls = () => page.evaluate(() => window.__calls);
        const idle = () => page.waitForFunction(() => !document.querySelector('[data-section="orderers"] [data-msg]').textContent.includes("保存しています"));

        // 既存の担当医の編集: メール未登録なら表示(初期はオフ)。所属済みのメールなら表示しない
        const d1 = sec.locator('.orderer-item[data-id="d1"]'), d2 = sec.locator('.orderer-item[data-id="d2"]');
        await d1.locator('[data-act="edit"]').click();
        const opt1 = d1.locator(".orderer-member-opt");
        assert.equal(await opt1.isVisible(), true);
        assert.match(await opt1.innerText(), /利用者管理にも追加する（注文者）/);
        assert.equal(await d1.locator('[data-f="addMember"]').isChecked(), false, "初期はオフ");
        await d1.locator('[data-act="cancel-row"]').click();
        await d2.locator('[data-act="edit"]').click();
        assert.equal(await d2.locator(".orderer-member-opt").isHidden(), true, "所属済みのメールでは表示しない");
        await d2.locator('[data-act="cancel-row"]').click();

        // 新規追加: 参加待ちのメールでは表示しない。新しいメールで表示。チェック時はメール必須
        await sec.locator('[data-act="add"]').click();
        const row = sec.locator(".orderer-item").last();
        const opt = row.locator(".orderer-member-opt"), check = row.locator('[data-f="addMember"]');
        await row.locator('[data-f="name"]').fill("新任 医師");
        await row.locator('[data-f="email"]').fill("WAIT@example.jp");
        assert.equal(await opt.isHidden(), true, "参加待ちのメールでは表示しない");
        await row.locator('[data-f="email"]').fill("");
        assert.equal(await opt.isVisible(), true);
        await check.check();
        assert.equal(await row.locator('[data-f="email"]').getAttribute("placeholder"), "メールアドレス（必須）");
        await row.locator('[data-act="save-row"]').click();
        assert.match(await row.locator("[data-err]").innerText(), /メールアドレスを入力/);
        assert.deepEqual(await calls(), [], "メールなしでは何も送らない");

        // 事前登録の失敗: 担当医は保存せず、入力・チェックを保持して理由を表示
        await row.locator('[data-f="email"]').fill("new.doc@example.jp");
        await page.evaluate(() => { window.__failAdd = { code: "functions/permission-denied", message: "この施設の管理者・副管理者のみ操作できます" }; });
        await row.locator('[data-act="save-row"]').click();
        await row.locator("[data-err]", { hasText: "管理者・副管理者のみ" }).waitFor();
        assert.deepEqual((await calls()).map(c => c[0]), ["addMember"], "担当医は保存しない");
        assert.equal(await row.locator('[data-f="name"]').inputValue(), "新任 医師");
        assert.equal(await row.locator('[data-f="email"]').inputValue(), "new.doc@example.jp");
        assert.equal(await check.isChecked(), true);
        assert.match(await sec.locator(":scope > [data-msg]").innerText(), /担当医は保存していません/);

        // 事前登録の成功 → 担当医の保存(ここでは保存が失敗) → 再試行で保存。事前登録は1回だけ
        await page.evaluate(() => { window.__failAdd = null; window.__failSave = true; });
        await row.locator('[data-act="save-row"]').click();
        await sec.locator('[data-act="retry-autosave"]').waitFor();
        let c = await calls();
        assert.deepEqual(c.filter(x => x[0] === "addMember").at(-1)[1], { facilityId: "f1", name: "新任 医師", email: "new.doc@example.jp", role: "orderer" });
        assert.ok(c.findIndex(x => x[0] === "saveOrderers") > c.map(x => x[0]).lastIndexOf("addMember"), "事前登録のあとに担当医を保存");
        await page.evaluate(() => { window.__failSave = false; });
        await sec.locator('[data-act="retry-autosave"]').click();
        await page.waitForFunction(() => window.__calls.filter(x => x[0] === "saveOrderers").length >= 2);
        await idle();
        c = await calls();
        assert.equal(c.filter(x => x[0] === "addMember").length, 2, "失敗した1回 + 成功した1回(再試行で二重に送らない)");
        assert.ok(c.filter(x => x[0] === "saveOrderers").at(-1)[1].some(w => w.data.name === "新任 医師" && w.data.email === "new.doc@example.jp"));
        // 利用者管理の一覧にも参加待ちとして出る
        await page.locator('[data-section="members"] [data-f="name"]', { hasText: "新任 医師" }).waitFor();
        // 登録後に同じ担当医を編集しても、参加待ちになったので表示しない
        await row.locator('[data-act="edit"]').click();
        assert.equal(await row.locator(".orderer-member-opt").isHidden(), true);
        await row.locator('[data-act="cancel-row"]').click();

        // 既に登録済み(サーバーが重複と判断): 重複登録せず、担当医は保存
        await page.evaluate(() => { window.__calls = []; window.__failAdd = { code: "functions/already-exists", message: "このメールアドレスは、既に参加待ちです" }; });
        await d1.locator('[data-act="edit"]').click();
        await d1.locator('[data-f="email"]').fill("other@example.jp");
        await d1.locator('[data-f="addMember"]').check();
        await d1.locator('[data-act="save-row"]').click();
        await page.waitForFunction(() => window.__calls.some(x => x[0] === "saveOrderers"));
        await idle();
        assert.match(await sec.locator(":scope > [data-msg]").innerText(), /重複して登録しませんでした/);
        assert.ok((await calls()).find(x => x[0] === "saveOrderers")[1].some(w => w.id === "d1" && w.data.email === "other@example.jp"));

        // チェックなし: 従来どおり担当医だけ
        await page.evaluate(() => { window.__calls = []; window.__failAdd = null; });
        await sec.locator('[data-act="add"]').click();
        const row2 = sec.locator(".orderer-item").last();
        await row2.locator('[data-f="name"]').fill("チェックなし医師");
        await row2.locator('[data-f="email"]').fill("plain@example.jp");
        await row2.locator('[data-act="save-row"]').click();
        await page.waitForFunction(() => window.__calls.some(x => x[0] === "saveOrderers"));
        await idle();
        assert.deepEqual((await calls()).map(x => x[0]), ["saveOrderers"], "事前登録しない");

        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `${width}: 横スクロールなし`);
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}
