// 回帰テスト(ブラウザ): 施設登録の申請の一覧・承認・却下(承認権限のある運営者だけ。権限の判定はサーバー)。
// 実際の src/ui/facility-applications.js・header-menu.js を、偽の API で動かす(ログイン・Firebase は使わない)。  npm run test:browser
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
import { createFacilityApplications } from "/src/ui/facility-applications.js";
import { createHeaderMenu } from "/src/ui/header-menu.js";
const t0 = Date.parse("2026-10-27T01:00:00Z");
let pending = [
  { id: "fac-aaaaaaaaaaaaaaaaaaaaaaaa", name: "立川病院", status: "pending", applicant: { name: "申請 一郎", email: "ichiro@example.jp" }, createdAt: t0, notification: { status: "accepted" }, duplicates: { exact: true, similarCount: 1, candidates: ["立川病院"] } },
  { id: "fac-bbbbbbbbbbbbbbbbbbbbbbbb", name: "目黒眼科", status: "pending", applicant: { name: null, email: "meguro@example.jp" }, createdAt: t0 + 60000, notification: { status: "failed" }, duplicates: { exact: false, similarCount: 0, candidates: [] } },
  { id: "fac-cccccccccccccccccccccccc", name: "品川クリニック", status: "pending", applicant: { name: "申請 三郎", email: "saburo@example.jp" }, createdAt: t0 + 120000, notification: { status: "held" }, duplicates: { exact: false, similarCount: 0, candidates: [] } }
];
let recent = [];
window.__calls = [];
const api = {
  listFacilityApplications: async () => ({ pending: pending.map(p => ({ ...p })), recent: recent.map(r => ({ ...r })) }),
  decideFacilityApplication: async (req) => {
    window.__calls.push(req);
    const a = pending.find(p => p.id === req.applicationId);
    if (window.__fail) { const e = new Error("この申請は既に処理されています。一覧を更新してください"); e.code = "functions/failed-precondition"; throw e; }
    if (req.decision === "approve" && a.duplicates.exact && !req.confirmDuplicate) return { status: "duplicate-candidate", exact: true, candidates: ["立川病院"] };
    pending = pending.filter(p => p !== a);
    recent.unshift({ ...a, status: req.decision === "approve" ? "approved" : "rejected", decidedAt: t0 + 3600000, decidedBy: { name: "運営者", email: "ops@example.jp" }, reason: req.reason || "",
      firstAdmin: req.decision === "approve" ? (req.firstAdmin ? { type: "designated", ...req.firstAdmin } : { type: "applicant" }) : null });
    return { status: req.decision === "approve" ? "approved" : "rejected" };
  }
};
window.__view = createFacilityApplications({ mount: document.querySelector("main"), api, onClose: () => { window.__closed = true; } });
const noop = () => {};
window.__menu = createHeaderMenu({ onOpenHistory: noop, onSwitchFacility: noop, onOpenSettings: noop, onRegisterFacility: noop, onSignOut: noop, onOpenApplications: () => window.__view.open() });
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

const info = (over = {}) => ({ user: { displayName: "運営者" }, facilityName: "せんじゅ眼科", canSwitch: false, canSettings: true, ...over });
const item = (page, id) => page.locator(`.application-item[data-application="${id}"]`);
const ok = (page) => page.locator('.confirm-dialog [data-act="ok"]').click();

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`施設登録の申請: 承認権限のある人だけメニューに出る。一覧・承認(申請者/別の責任者)・却下・同名の確認・エラー表示: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 1200 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      // メニュー: 承認権限がなければ出ない(表示だけ。権限はサーバーが確認する)
      await page.evaluate((i) => window.__menu.update(i), info());
      await page.click("#btnHeaderMenu");
      assert.equal(await page.locator("#menuApplications").count(), 0);
      await page.keyboard.press("Escape");   // メニューを閉じる
      await page.evaluate((i) => window.__menu.update(i), info({ canApprove: true }));
      await page.click("#btnHeaderMenu");
      await page.click("#menuApplications");
      await page.waitForSelector(".application-item");

      // 一覧: 審査中は古い順。施設名・申請者名・メール・申請日時・通知・既存施設との重複
      assert.deepEqual(await page.locator(".application-item .application-name").allInnerTexts(), ["立川病院", "目黒眼科", "品川クリニック"]);
      const first = item(page, "fac-aaaaaaaaaaaaaaaaaaaaaaaa");
      assert.match(await first.innerText(), /申請者: 申請 一郎 ・ ichiro@example\.jp ・ 申請日時 2026\/10\/27 10:00/);
      assert.match(await first.locator(".application-dup").innerText(), /同じ名前の施設あり: 立川病院/);
      assert.match(await item(page, "fac-bbbbbbbbbbbbbbbbbbbbbbbb").innerText(), /申請者: （未入力）[\s\S]*通知: 通知に失敗/);
      assert.equal(await item(page, "fac-bbbbbbbbbbbbbbbbbbbbbbbb").locator(".application-dup").count(), 0);

      // 承認(申請者): 確認 → 同名の施設があるので再確認 → 承認
      await first.locator('[data-act="approve"]').click();
      assert.match(await page.locator(".confirm-dialog-message").innerText(), /「立川病院」を承認しますか？/);
      await ok(page);
      await page.waitForSelector(".confirm-dialog");
      assert.match(await page.locator(".confirm-dialog-message").innerText(), /同じ名前の施設が既にあります\(立川病院\)/);
      await ok(page);
      await page.waitForFunction(() => document.querySelectorAll(".application-item").length === 2);
      assert.deepEqual(await page.evaluate(() => window.__calls), [
        { applicationId: "fac-aaaaaaaaaaaaaaaaaaaaaaaa", decision: "approve" },
        { applicationId: "fac-aaaaaaaaaaaaaaaaaaaaaaaa", decision: "approve", confirmDuplicate: true }]);

      // 承認(別の責任者を指定)
      const meguro = item(page, "fac-bbbbbbbbbbbbbbbbbbbbbbbb");
      assert.equal(await meguro.locator(".application-other-admin").isHidden(), true);
      await meguro.locator('input[value="other"]').check();
      await meguro.locator('[data-f="adminName"]').fill("責任者 花子");
      await meguro.locator('[data-f="adminEmail"]').fill("boss@example.jp");
      await meguro.locator('[data-act="approve"]').click();
      assert.match(await page.locator(".confirm-dialog-message").innerText(), /指定した人が参加を承諾すると最初の管理者/);
      await ok(page);
      await page.waitForFunction(() => document.querySelectorAll(".application-item").length === 1);
      assert.deepEqual((await page.evaluate(() => window.__calls)).at(-1), { applicationId: "fac-bbbbbbbbbbbbbbbbbbbbbbbb", decision: "approve", firstAdmin: { name: "責任者 花子", email: "boss@example.jp" } });

      // キャンセルでは送らない。サーバーの拒否はそのまま表示する
      const sh = item(page, "fac-cccccccccccccccccccccccc");
      await sh.locator('[data-act="reject"]').click();
      await page.locator('.confirm-dialog [data-act="cancel"]').click();
      assert.equal((await page.evaluate(() => window.__calls)).length, 3);
      await page.evaluate(() => { window.__fail = true; });
      await sh.locator('[data-act="reject"]').click();
      await ok(page);
      await page.waitForFunction(() => document.querySelector('.application-item [data-err]').textContent !== "");
      assert.match(await sh.locator("[data-err]").innerText(), /既に処理されています/);
      // 却下(理由つき)
      await page.evaluate(() => { window.__fail = false; });
      await sh.locator('[data-f="reason"]').fill("施設を確認できませんでした");
      await sh.locator('[data-act="reject"]').click();
      await ok(page);
      await page.waitForFunction(() => document.querySelectorAll(".application-item").length === 0);
      assert.deepEqual((await page.evaluate(() => window.__calls)).at(-1), { applicationId: "fac-cccccccccccccccccccccccc", decision: "reject", reason: "施設を確認できませんでした" });

      // 最近の承認・却下(新しい順)。処理した人・最初の管理者・理由
      const recent = await page.locator(".application-recent").allInnerTexts();
      assert.equal(recent.length, 3);
      assert.match(recent[0], /却下[\s\S]*品川クリニック[\s\S]*運営者[\s\S]*理由: 施設を確認できませんでした/);
      assert.match(recent[1], /承認[\s\S]*目黒眼科[\s\S]*最初の管理者: 責任者 花子\(boss@example\.jp/);
      assert.match(recent[2], /承認[\s\S]*立川病院[\s\S]*最初の管理者: 申請者/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, "スマートフォン幅ではみ出さない");
      // 注文画面に戻る
      await page.click("#btnApplicationsClose");
      assert.equal(await page.evaluate(() => window.__closed), true);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
