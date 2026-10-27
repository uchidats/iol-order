// 回帰テスト(ブラウザ): 施設設定の「ディーラー画面での閲覧」(管理者・副管理者の許可・取消)と、運営者の「ディーラー画面の管理」。
// 実際の facility-settings.js・dealer-portal-operator.js を、偽の API で動かす(ログイン・Firebase は使わない)。  npm run test:browser
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const SETTINGS_PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<header class="app-header"><div class="header-inner"><span class="header-title">IOL</span></div></header>
<main class="main-content"></main>
<script type="module">
import { createFacilitySettings } from "/src/ui/facility-settings.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
const q = new URLSearchParams(location.search);
const repository = {
  listOrderers: async () => [], listAdoptedIols: async () => [], getIolOrder: async () => null,
  listDealers: async () => [{ id: "dA1", name: "エックス商事A窓口", sortOrder: 10, orderEmails: [] }, { id: "dA2", name: "ワイ医療", sortOrder: 20, orderEmails: [] }],
  getMailSettings: async () => null, getHeaderTheme: async () => null,
  listMembers: async () => [{ uid: "me", role: q.get("role") || "admin", displayName: "自分" }], listPendingMembers: async () => [], getMemberOrder: async () => null
};
const settingsApi = {
  saveOrderers: async () => {}, saveAdoptedIols: async () => {}, saveIolOrder: async () => {}, deleteOrderer: async () => {}, deleteDealer: async () => {},
  saveDealers: async () => {}, saveMailSettings: async () => {}, saveHeaderTheme: async () => {}, resetHeaderTheme: async () => {}, saveMemberOrder: async () => {}
};
const inviteApi = { removeMember: async () => {}, addMember: async () => ({}), cancelPendingMember: async () => {}, changeMemberRole: async () => {} };
const state = { dA1: q.get("stale") ? { status: "active", revision: 3, grant: { effectiveFrom: "2026-10-27T03:00:00.000Z", grantedByRole: "admin", stale: true } } : { status: "proposed", revision: 1, grant: null } };
window.__calls = [];
const mode = q.get("portal") || "on";
const dealerPortalApi = mode === "none" ? null : {
  facilityStatus: async (a) => {
    window.__calls.push(["status", a]);
    if (mode === "off") throw Object.assign(new Error("ディーラー画面は現在ご利用いただけません"), { code: "functions/failed-precondition" });
    return { dealers: [
      { localDealerId: "dA1", dealerName: "エックス商事A窓口", link: { companyName: "エックス商事", companyActive: true, ...state.dA1 } },
      { localDealerId: "dA2", dealerName: "ワイ医療", link: null }] };
  },
  grant: async (a) => { window.__calls.push(["grant", a]); state.dA1 = { status: "active", revision: a.revision + 1, grant: { effectiveFrom: "2026-10-27T03:00:00.000Z", grantedByRole: "admin" } }; return { ok: true }; },
  revoke: async (a) => { window.__calls.push(["revoke", a]); state.dA1 = { status: "revoked", revision: a.revision + 1, grant: null }; return { ok: true }; }
};
const s = createFacilitySettings({ mount: document.querySelector("main"), repository, settingsApi, inviteApi, masters: IOL_MODELS, dealerPortalApi,
  currentUser: { uid: "me", displayName: "自分" }, actorRole: q.get("role") || "admin", onSaved: async () => {}, onClose() {} });
await s.open({ id: "fA", name: "A眼科" });
window.__ready = true;
</script></body></html>`;

const OPERATOR_PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<main class="main-content"></main>
<script type="module">
import { createDealerPortalOperator } from "/src/ui/dealer-portal-operator.js";
window.__calls = [];
const companies = [{ companyId: "dco-x", name: "エックス商事", status: "active", branches: [], staff: [{ uid: "x1", name: "担当x1", email: "x1@corp.example.jp", role: "reader", status: "active", branchId: null, facilityIds: [] }], invitations: [], grants: [{ facilityId: "fA", localDealerId: "dA1", effectiveFrom: "2026-10-27T03:00:00.000Z" }] }];
const facilities = [{ facilityId: "fA", name: "A眼科", dealers: [{ localDealerId: "dA1", name: "エックス商事A窓口", link: { companyId: "dco-x", status: "active" } }, { localDealerId: "dA2", name: "<b>ワイ</b>医療", link: null }] }];
const rec = (name) => async (a) => { window.__calls.push([name, a]); return { ok: true }; };
const api = { overview: async () => ({ companies, facilities }), createCompany: rec("createCompany"), updateCompany: rec("updateCompany"), upsertBranch: rec("upsertBranch"),
  inviteStaff: rec("inviteStaff"), cancelInvitation: rec("cancelInvitation"), updateStaff: rec("updateStaff"), proposeLink: rec("proposeLink") };
const v = createDealerPortalOperator({ mount: document.querySelector("main"), api, onClose() {} });
await v.open();
window.__ready = true;
</script></body></html>`;

let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/" || url === "/operator") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(url === "/" ? SETTINGS_PAGE : OPERATOR_PAGE); return; }
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
const section = (page) => page.locator('[data-section="dealerPortal"]');

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`施設設定: 管理者・副管理者が閲覧を許可・取消(説明を確認してから)。関連付けのない発注先は出さない。スマートフォン/PC: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const [role, width] of [["admin", 390], ["subadmin", 1100]]) {
        const page = await browser.newPage({ viewport: { width, height: 1200 } });
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await page.goto(`${base}?role=${role}`);
        await page.waitForFunction(() => window.__ready);
        await section(page).locator(".dealer-portal-item").first().waitFor();
        assert.equal(await section(page).isVisible(), true);
        assert.match(await section(page).locator(".dealer-portal-notice").innerText(), /有効な全担当者が、許可後の新規注文のうち、自社宛ての明細を閲覧できます/);
        assert.deepEqual(await section(page).locator(".dealer-portal-name").allInnerTexts(), ["エックス商事A窓口"], "関連付けのない発注先(ワイ医療)は出さない");
        assert.match(await section(page).locator(".dealer-portal-meta").innerText(), /エックス商事.*未許可/);
        // 許可: 確認ダイアログに共有範囲の説明。キャンセルなら何もしない
        await section(page).locator('[data-act="grant"]').click();
        const dlg = page.locator(".confirm-dialog");
        await dlg.waitFor();
        assert.match(await dlg.locator(".confirm-dialog-message").innerText(), /有効な全担当者[\s\S]*許可より前の注文は表示されません/);
        await dlg.locator('[data-act="cancel"]').click();
        assert.deepEqual(await page.evaluate(() => window.__calls.filter(c => c[0] !== "status")), []);
        await section(page).locator('[data-act="grant"]').click();
        await page.locator('.confirm-dialog [data-act="ok"]').click();
        await section(page).locator(".dealer-portal-state.is-active").waitFor();
        assert.deepEqual(await page.evaluate(() => window.__calls.filter(c => c[0] === "grant").map(c => c[1])), [{ facilityId: "fA", localDealerId: "dA1", revision: 1 }]);
        assert.match(await section(page).locator(".dealer-portal-meta").innerText(), /許可中\(2026\/10\/27 12:00 以降の新規注文\)/);
        // 取消
        await section(page).locator('[data-act="revoke"]').click();
        await page.locator('.confirm-dialog [data-act="ok"]').click();
        await page.waitForFunction(() => window.__calls.some(c => c[0] === "revoke"));
        await section(page).locator('[data-act="grant"]').waitFor();
        assert.deepEqual(await page.evaluate(() => window.__calls.filter(c => c[0] === "revoke").map(c => c[1])), [{ facilityId: "fA", localDealerId: "dA1", revision: 2 }]);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 横にはみ出さない`);
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}

test("施設設定: 許可の後に発注先の名称・宛先が変わったら「停止中」と表示し、取消・再許可を案内する(chromium)", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 1200 } });
    await page.goto(`${base}?stale=1`);
    await page.waitForFunction(() => window.__ready);
    const st = section(page).locator(".dealer-portal-state");
    await st.waitFor();
    assert.equal(await st.getAttribute("data-state"), "stale");
    assert.match(await st.innerText(), /停止中.*発注先の名称・宛先が変更された.*取り消してから、改めて許可してください/);
    assert.equal(await section(page).locator('[data-act="revoke"]').count(), 1, "取消できる");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.close();
  } finally { await browser.close(); }
});

test("施設設定: 機能が止まっている・未配備・API なしのときは項目を出さず、他の設定はそのまま(chromium)", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    for (const mode of ["off", "none"]) {
      const page = await browser.newPage({ viewport: { width: 800, height: 1200 } });
      await page.goto(`${base}?portal=${mode}`);
      await page.waitForFunction(() => window.__ready);
      await page.waitForTimeout(200);
      assert.equal(await section(page).count() ? await section(page).isVisible() : false, false, mode);
      for (const k of ["orderers", "iols", "dealers", "mail", "theme"]) assert.equal(await page.locator(`[data-section="${k}"]`).isVisible(), true, `${mode}: ${k}`);
      await page.close();
    }
  } finally { await browser.close(); }
});

test("運営者の管理画面: 会社の登録・担当者の招待・支店・関連付け(関連付けだけでは閲覧は始まらない旨)。名称は文字として表示(chromium)", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    for (const width of [390, 1100]) {
      const page = await browser.newPage({ viewport: { width, height: 1400 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(`${base}operator`);
      await page.waitForFunction(() => window.__ready);
      await page.fill('[data-f="companyName"]', "ゼット商会");
      await page.click('[data-act="createCompany"]');
      await page.waitForFunction(() => window.__calls.some(c => c[0] === "createCompany"));
      const cc = await page.evaluate(() => window.__calls.find(c => c[0] === "createCompany")[1]);
      assert.equal(cc.name, "ゼット商会");
      assert.match(cc.requestId, /^[A-Za-z0-9-]{16,64}$/);
      await page.fill('[data-f="staffEmail"]', "x2@corp.example.jp");
      await page.fill('[data-f="staffName"]', "担当x2");
      await page.click('[data-act="invite"]');
      await page.waitForFunction(() => window.__calls.some(c => c[0] === "inviteStaff"));
      assert.deepEqual(await page.evaluate(() => window.__calls.find(c => c[0] === "inviteStaff")[1]), { companyId: "dco-x", email: "x2@corp.example.jp", name: "担当x2", role: "reader" });
      // 担当施設(代行): 許可済みの施設だけが候補
      assert.deepEqual(await page.locator(".dealer-operator-assign input").evaluateAll(cs => cs.map(c => c.value)), ["fA"]);
      // 関連付け: 施設 → 発注先 → 会社
      await page.selectOption('[data-f="linkFacility"]', "fA");
      await page.selectOption('[data-f="linkDealer"]', "dA2");
      await page.selectOption('[data-f="linkCompany"]', "dco-x");
      await page.click('[data-act="proposeLink"]');
      await page.waitForFunction(() => window.__calls.some(c => c[0] === "proposeLink"));
      assert.deepEqual(await page.evaluate(() => window.__calls.find(c => c[0] === "proposeLink")[1]), { facilityId: "fA", localDealerId: "dA2", companyId: "dco-x" });
      assert.match(await page.locator(".dealer-operator").innerText(), /関連付けだけでは閲覧は始まりません/);
      assert.equal(await page.locator(".dealer-operator b").count(), 0, "名称の HTML は要素にしない");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 横にはみ出さない`);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
