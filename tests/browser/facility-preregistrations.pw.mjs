// 回帰テスト(ブラウザ): 施設の事前登録(運営者のみ。権限・重複・状態の確認はサーバー)と、初期管理者の参加確認の表示。
// 実際の src/ui/facility-preregistrations.js・header-menu.js・auth-ui.js を、偽の API で動かす(ログイン・Firebase は使わない)。  npm run test:browser
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
<header class="app-header"><div class="header-inner"><div class="header-text"><h1 class="header-title">IOL 注文フォーム</h1></div></div></header>
<main class="main-content"></main>
<script type="module">
import { createFacilityPreregistrations } from "/src/ui/facility-preregistrations.js";
import { createHeaderMenu } from "/src/ui/header-menu.js";
let list = [{ facilityId: "fac-aaaaaaaaaaaaaaaaaaaaaaaa", name: "入力ミス眼科", adminEmail: "wrong@example.jp", adminName: "院長", state: "pending", expiresAt: Date.parse("2026-11-26T00:00:00Z"), createdAt: 1 }];
window.__calls = [];
const api = {
  listFacilityPreregistrations: async () => ({ preregistrations: list.map(x => ({ ...x })) }),
  preregisterFacility: async (req) => {
    window.__calls.push(["preregister", req]);
    if (req.name.includes("立川") && !req.confirmDuplicate) return { status: "duplicate-candidate", exact: true, similarCount: 1, candidates: ["立川病院"] };
    list.push({ facilityId: "fac-bbbbbbbbbbbbbbbbbbbbbbbb", name: req.name, adminEmail: req.adminEmail.toLowerCase(), adminName: req.adminName || "", state: "pending", expiresAt: Date.parse("2026-11-26T00:00:00Z"), createdAt: 2 });
    return { status: "created", facilityId: "fac-bbbbbbbbbbbbbbbbbbbbbbbb" };
  },
  updateFacilityPreregistration: async (req) => {
    window.__calls.push(["update", req]);
    const x = list.find(p => p.facilityId === req.facilityId); Object.assign(x, { name: req.name, adminEmail: req.adminEmail, adminName: req.adminName });
    return { status: "updated", facilityId: req.facilityId };
  },
  cancelFacilityPreregistration: async (req) => { window.__calls.push(["cancel", req]); list = list.filter(p => p.facilityId !== req.facilityId); return { status: "cancelled", facilityId: req.facilityId }; }
};
window.__view = createFacilityPreregistrations({ mount: document.querySelector("main"), api, onClose: () => { window.__closed = true; } });
const noop = () => {};
window.__menu = createHeaderMenu({ onOpenHistory: noop, onSwitchFacility: noop, onOpenSettings: noop, onRegisterFacility: noop, onSignOut: noop, onOpenApplications: noop, onOpenPreregistrations: () => window.__view.open() });
window.__ready = true;
</script></body></html>`;

const PENDING_PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<main class="main-content"></main>
<script type="module">
import { createAuthUi } from "/src/ui/auth-ui.js";
window.__responses = [];
const ui = createAuthUi({ onGoogle() {}, onEmailLink() {}, onSelectFacility() {}, onLocate() {}, onSignOut() {}, onOnboardingClose() {}, onRegister() {}, onRegisterCancel() {}, onCheckName: async () => ({}),
  onRespondPending: (a) => window.__responses.push(a) });
ui.render({ access: { state: "no-membership", memberships: [] }, user: { displayName: "院長", email: "boss@example.jp", emailVerified: true }, notice: "", error: "", facilities: [], busy: false, registration: null,
  pendingInvites: [
    { pendingId: "fac-x_1", facilityId: "fac-x", facilityName: "事前登録の眼科", role: "admin", roleLabel: "管理者", invitedByName: "IOL Order 運営者", expiresAt: "2026-11-26T00:00:00Z", initialAdmin: true },
    { pendingId: "fB_2", facilityId: "fB", facilityName: "B病院", role: "orderer", roleLabel: "注文者", invitedByName: null, expiresAt: "2026-11-26T00:00:00Z" }] });
window.__ready = true;
</script></body></html>`;

let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/" || url === "/pending") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(url === "/" ? PAGE : PENDING_PAGE); return; }
    const p = path.join(ROOT, url);
    if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(p, (e, b) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": (TYPES[path.extname(p)] || "application/octet-stream") + "; charset=utf-8" });
      res.end(b);
    });
  }).listen(0);
  await new Promise(r => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); });

async function launch(type, name) {
  for (const opts of name === "chromium" ? [{}, { channel: "msedge" }, { channel: "chrome" }] : [{}]) {
    try { return await type.launch(opts); } catch { /* 次の候補へ */ }
  }
  return null;
}
const info = (over = {}) => ({ user: { displayName: "運営者" }, facilityName: "せんじゅ眼科", canSwitch: false, canSettings: true, ...over });
const ok = (page) => page.locator('.confirm-dialog [data-act="ok"]').click();

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`施設の事前登録: 運営者だけメニューに出る。登録(重複の確認)・一覧・編集・取り消し。スマートフォン幅: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 1200 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base + "/");
      await page.waitForFunction(() => window.__ready);
      await page.evaluate((i) => window.__menu.update(i), info());
      await page.click("#btnHeaderMenu");
      assert.equal(await page.locator("#menuPreregistrations").count(), 0, "運営者でなければ出ない(表示だけ。権限はサーバー)");
      await page.keyboard.press("Escape");
      await page.evaluate((i) => window.__menu.update(i), info({ canPreregister: true }));
      await page.click("#btnHeaderMenu");
      await page.click("#menuPreregistrations");
      await page.waitForSelector(".prereg-item");
      assert.match(await page.locator(".prereg-item").first().innerText(), /入力ミス眼科[\s\S]*承諾待ち[\s\S]*初期管理者: 院長 ・ wrong@example\.jp ・ 期限 2026\/11\/26/);

      // 必須の入力
      await page.click('[data-act="preregister"]');
      assert.match(await page.locator('[data-err="form"]').innerText(), /施設名を入力してください/);
      // 重複の確認(キャンセル → 登録しない。確認 → 登録)
      await page.fill('[data-f="name"]', "立川病院");
      await page.fill('[data-f="adminEmail"]', "Boss@Example.jp");
      await page.click('[data-act="preregister"]');
      assert.match(await page.locator(".confirm-dialog-message").innerText(), /同じ名前の施設・事前登録・審査中の申請があります\(立川病院\)/);
      await page.locator('.confirm-dialog [data-act="cancel"]').click();
      assert.equal(await page.locator(".prereg-item").count(), 1);
      await page.click('[data-act="preregister"]');
      await ok(page);
      await page.waitForFunction(() => document.querySelectorAll(".prereg-item").length === 2);
      const calls = await page.evaluate(() => window.__calls);
      assert.equal(calls.length, 3);
      assert.equal(calls[2][1].confirmDuplicate, true);
      assert.equal(calls[1][1].requestId, calls[2][1].requestId, "確認後の送り直しは同じ要求(二重登録にならない)");
      assert.equal(await page.locator('[data-f="name"]').inputValue(), "", "登録後は入力欄を空にする");

      // 編集(施設名・初期管理者の入力ミスを直す)
      const first = page.locator('.prereg-item[data-facility="fac-aaaaaaaaaaaaaaaaaaaaaaaa"]');
      await first.locator('[data-act="edit"]').click();
      assert.equal(await first.locator('[data-f="editEmail"]').inputValue(), "wrong@example.jp");
      await first.locator('[data-f="editName"]').fill("正しい眼科");
      await first.locator('[data-f="editEmail"]').fill("boss@example.jp");
      await first.locator('[data-act="save"]').click();
      await page.waitForFunction(() => document.querySelector('.prereg-item[data-facility="fac-aaaaaaaaaaaaaaaaaaaaaaaa"] .application-name').textContent === "正しい眼科");
      assert.deepEqual((await page.evaluate(() => window.__calls)).at(-1), ["update", { facilityId: "fac-aaaaaaaaaaaaaaaaaaaaaaaa", name: "正しい眼科", adminEmail: "boss@example.jp", adminName: "院長" }]);

      // 取り消し(確認ダイアログ)
      await first.locator('[data-act="cancel"]').click();
      assert.match(await page.locator(".confirm-dialog-message").innerText(), /「正しい眼科」の事前登録を取り消しますか？/);
      await ok(page);
      await page.waitForFunction(() => document.querySelectorAll(".prereg-item").length === 1);
      assert.deepEqual((await page.evaluate(() => window.__calls)).at(-1), ["cancel", { facilityId: "fac-aaaaaaaaaaaaaaaaaaaaaaaa" }]);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, "スマートフォン幅ではみ出さない");
      await page.click("#btnPreregClose");
      assert.equal(await page.evaluate(() => window.__closed), true);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test(`初期管理者の参加確認: 施設名と「管理者になる」ことを明示し、「参加する」で承諾する: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      await page.goto(base + "/pending");
      await page.waitForFunction(() => window.__ready);
      const items = page.locator(".pending-invite");
      assert.match(await items.nth(0).innerText(), /事前登録の眼科[\s\S]*管理者[\s\S]*参加すると、この施設の管理者になります[\s\S]*参加するまで、管理者の権限は付きません/);
      assert.equal(await items.nth(1).locator(".pending-invite-admin").count(), 0, "通常の参加(注文者)には出さない");
      await items.nth(0).locator('[data-act="accept"]').click();
      assert.deepEqual(await page.evaluate(() => window.__responses), [{ pendingId: "fac-x_1", accept: true }]);
    } finally { await browser.close(); }
  });
}
