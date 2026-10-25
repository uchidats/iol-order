// 回帰テスト(ブラウザ): 利用者管理(参加済み・参加待ち・期限切れ・辞退の一覧、「追加」、役割変更、削除、取り消し、再登録)の
// 権限による出し分け(管理者・副管理者)と、参加確認画面。  npm run test:browser
// 実際の styles.css と src/ui/facility-settings.js・src/ui/auth-ui.js を、最小のページで確認する(ログイン・Firebase は使わない)。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const SETTINGS = (role) => `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<main class="main-content"></main>
<script type="module">
import { createFacilitySettings } from "/src/ui/facility-settings.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
const DAY = 864e5, now = Date.now();
const members = [
  { uid: "me", role: "${role}", displayName: "自分", email: "me@example.jp" },
  ...(${JSON.stringify(role)} === "admin" ? [] : [{ uid: "adminA", role: "admin", displayName: "管理者A", email: "a@example.jp" }]),
  { uid: "subX", role: "subadmin", displayName: "副管理者X", email: "s@example.jp" },
  { uid: "ordA", role: "orderer", displayName: "注文者A", email: "o@example.jp" },
  { uid: "proxyA", role: "proxy", displayName: "代行A", email: "p@example.jp" }
];
const pending = [
  { id: "f1_" + "a".repeat(64), facilityId: "f1", name: "新人P", email: "new@example.jp", role: "orderer", status: "pending", expiresAt: new Date(now + 10 * DAY).toISOString() },
  { id: "f1_" + "b".repeat(64), facilityId: "f1", name: "期限切れE", email: "exp@example.jp", role: "proxy", status: "pending", expiresAt: new Date(now - DAY).toISOString() },
  { id: "f1_" + "c".repeat(64), facilityId: "f1", name: "辞退D", email: "dec@example.jp", role: "orderer", status: "declined", expiresAt: new Date(now + DAY).toISOString() },
  { id: "f1_" + "d".repeat(64), facilityId: "f1", name: "副候補S", email: "sub2@example.jp", role: "subadmin", status: "pending", expiresAt: new Date(now + DAY).toISOString() }
];
window.__calls = [];
const rec = (name) => async (a) => { window.__calls.push([name, a]); if (window.__fail) { const e = new Error(window.__fail); e.code = "functions/permission-denied"; throw e; } return {}; };
const repository = { listOrderers: async () => [], listAdoptedIols: async () => [], listDealers: async () => [],
  listMembers: async () => members.map(m => ({ ...m })), listPendingMembers: async () => pending.map(p => ({ ...p })) };
const settingsApi = { saveOrderers: async () => {}, saveAdoptedIols: async () => {}, saveDealers: async () => {}, deleteDealer: async () => {}, deleteOrderer: async () => {} };
const inviteApi = {
  createInvite: rec("createInvite"), renameFacility: rec("renameFacility"), deleteFacility: rec("deleteFacility"),
  removeMember: rec("removeMember"), changeMemberRole: rec("changeMemberRole"), cancelPendingMember: rec("cancelPendingMember"), renewPendingMember: rec("renewPendingMember"),
  addMember: async (a) => { window.__calls.push(["addMember", a]); if (window.__fail) { const e = new Error(window.__fail); e.code = "functions/already-exists"; throw e; }
    pending.push({ id: "f1_" + "e".repeat(64), facilityId: "f1", ...a, status: "pending", expiresAt: new Date(now + 30 * DAY).toISOString() });
    return { ...a, pendingId: "x", status: "pending", expiresAt: new Date(now + 30 * DAY).toISOString() }; }
};
const s = createFacilitySettings({ mount: document.querySelector("main"), repository, settingsApi, masters: IOL_MODELS, inviteApi,
  currentUser: { uid: "me", displayName: "自分" }, actorRole: "${role}", onSaved: async () => {}, onClose() {} });
await s.open({ id: "f1", name: "テスト施設" });
window.__ready = true;
</script></body></html>`;

const CONFIRM = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/styles.css"></head><body>
<main class="main-content"><div id="iolOrderForm">注文画面</div></main>
<script type="module">
import { createAuthUi } from "/src/ui/auth-ui.js";
window.__responses = [];
const ui = createAuthUi({ onGoogle() {}, onEmailLink() {}, onSelectFacility() {}, onLocate() {}, onSignOut() {}, onJoin() {}, onOnboardingClose() {}, onRegisterCancel() {}, onRegister() {},
  onRespondPending: (a) => window.__responses.push(a) });
const invites = [
  { pendingId: "fA_1", facilityId: "fA", facilityName: "<b>A</b>眼科", role: "proxy", roleLabel: "代行入力者", invitedByName: "管理者A", expiresAt: "2026-11-24T00:00:00Z" },
  { pendingId: "fB_2", facilityId: "fB", facilityName: "B病院", role: "orderer", roleLabel: "注文者", invitedByName: null, expiresAt: "2026-11-24T00:00:00Z" }
];
window.__render = (state, list) => ui.render({ access: { state, memberships: [], facilityId: "fZ", role: "orderer" }, user: { displayName: "本人", email: "me@example.jp", emailVerified: true }, notice: "", error: "", facilities: [], busy: false, registration: { busy: false, duplicate: null }, pendingInvites: list === undefined ? invites : list });
window.__render("no-membership");
window.__ready = true;
</script></body></html>`;

let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    const pages = { "/admin": SETTINGS("admin"), "/subadmin": SETTINGS("subadmin"), "/confirm": CONFIRM };
    if (pages[url]) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(pages[url]); return; }
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
const rowOf = (page, name) => page.locator(".settings-row-member", { has: page.locator('[data-f="name"]', { hasText: new RegExp(`^${name}$`) }) });
const acts = (row) => row.locator(".settings-member-action button").evaluateAll(bs => bs.map(b => b.getAttribute("data-act")));

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`利用者管理(管理者): 一覧・追加・役割変更・削除・取り消し・再登録。招待コードの発行画面はない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const page = await browser.newPage({ viewport: { width, height: 1200 } });
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        page.on("dialog", d => d.accept());
        await page.goto(base + "/admin");
        await page.waitForFunction(() => window.__ready);
        const sec = page.locator('[data-section="members"]');
        assert.equal(await page.locator('[data-section="invites"]').count(), 0, "「メンバーの招待」カードは廃止");
        assert.equal(await page.getByText("招待コードを発行").count(), 0);
        assert.match(await sec.locator("h3").first().innerText(), /利用者管理/);
        // 一覧: 参加済み(役割順) → 参加待ち → 期限切れ → 辞退。役割・状態はバッジ
        const names = await sec.locator('.settings-row-member [data-f="name"]').allInnerTexts();
        assert.deepEqual(names, ["自分", "副管理者X", "注文者A", "代行A", "新人P", "副候補S", "期限切れE", "辞退D"]);
        assert.deepEqual(await sec.locator('.settings-row-member [data-f="role"]').allInnerTexts(), ["管理者", "副管理者", "注文者", "代行入力者", "注文者", "副管理者", "代行入力者", "注文者"]);
        assert.deepEqual(await sec.locator('[data-f="state"]').allInnerTexts(), ["参加待ち", "参加待ち", "期限切れ", "辞退"]);
        // 操作: 自分(最後の管理者)は変更・削除なし。他は鉛筆・ゴミ箱。参加待ちはゴミ箱(取り消し)、期限切れ・辞退は再登録も
        assert.deepEqual(await acts(rowOf(page, "自分")), []);
        assert.deepEqual(await acts(rowOf(page, "副管理者X")), ["edit-role", "remove-member"]);
        assert.deepEqual(await acts(rowOf(page, "注文者A")), ["edit-role", "remove-member"]);
        assert.deepEqual(await acts(rowOf(page, "新人P")), ["cancel-pending"]);
        assert.deepEqual(await acts(rowOf(page, "期限切れE")), ["renew", "cancel-pending"]);
        assert.deepEqual(await acts(rowOf(page, "辞退D")), ["renew", "cancel-pending"]);
        // 鉛筆・ゴミ箱は既存のアイコン(SVG)
        assert.equal(await rowOf(page, "注文者A").locator('[data-act="edit-role"] svg').count(), 1);
        assert.equal(await rowOf(page, "注文者A").locator('[data-act="remove-member"] svg').count(), 1);
        // 見出しの施設名の編集・施設削除は管理者に表示
        assert.equal(await page.locator("#btnRenameFacility").count(), 1);
        assert.equal(await page.locator("#btnDeleteFacility").count(), 1);

        // 追加: 名前・メール・役割(副管理者・注文者・代行入力者。初期は注文者)。押すまで入力欄は出さない
        assert.equal(await sec.locator(".member-add-form").isHidden(), true);
        await sec.locator('[data-act="add"]').click();
        assert.equal(await sec.locator(".member-add-form").isVisible(), true);
        assert.deepEqual(await sec.locator('[data-f="addRole"] option').allInnerTexts(), ["副管理者", "注文者", "代行入力者"]);
        assert.equal(await sec.locator('[data-f="addRole"]').inputValue(), "orderer");
        await sec.locator('[data-f="addName"]').fill("追加 太郎");
        await sec.locator('[data-f="addEmail"]').fill("bad");
        await sec.locator('[data-act="add-submit"]').click();
        assert.match(await sec.locator("[data-msg]").innerText(), /メールアドレスの形式/);
        await sec.locator('[data-f="addEmail"]').fill("add@example.jp");
        await sec.locator('[data-f="addRole"]').selectOption("proxy");
        await sec.locator('[data-act="add-submit"]').click();
        await rowOf(page, "追加 太郎").waitFor();
        assert.deepEqual((await page.evaluate(() => window.__calls)).at(-1), ["addMember", { facilityId: "f1", name: "追加 太郎", email: "add@example.jp", role: "proxy" }]);
        assert.match(await sec.locator("[data-msg]").innerText(), /代行入力者として登録しました/);
        assert.equal(await sec.locator(".member-add-form").isHidden(), true);

        // 役割の変更(鉛筆 → 選択 → 変更)
        await rowOf(page, "注文者A").locator('[data-act="edit-role"]').click();
        const sel = rowOf(page, "注文者A").locator(".member-role-edit select");
        assert.deepEqual(await sel.locator("option").allInnerTexts(), ["管理者", "副管理者", "注文者", "代行入力者"]);
        await sel.selectOption("proxy");
        await rowOf(page, "注文者A").locator('[data-act="role-save"]').click();
        await page.waitForFunction(() => window.__calls.some(c => c[0] === "changeMemberRole"));
        assert.deepEqual((await page.evaluate(() => window.__calls)).find(c => c[0] === "changeMemberRole"), ["changeMemberRole", { facilityId: "f1", uid: "ordA", role: "proxy" }]);
        // 削除・取り消し・再登録
        await rowOf(page, "代行A").locator('[data-act="remove-member"]').click();
        await rowOf(page, "新人P").locator('[data-act="cancel-pending"]').click();
        await rowOf(page, "期限切れE").locator('[data-act="renew"]').click();
        await page.waitForFunction(() => ["removeMember", "cancelPendingMember", "renewPendingMember"].every(n => window.__calls.some(c => c[0] === n)));
        const calls = await page.evaluate(() => window.__calls);
        assert.deepEqual(calls.find(c => c[0] === "removeMember")[1], { facilityId: "f1", uid: "proxyA" });
        assert.deepEqual(calls.find(c => c[0] === "cancelPendingMember")[1], { facilityId: "f1", pendingId: "f1_" + "a".repeat(64) });
        assert.deepEqual(calls.find(c => c[0] === "renewPendingMember")[1], { facilityId: "f1", pendingId: "f1_" + "b".repeat(64) });
        assert.equal(calls.some(c => c[0] === "createInvite"), false);
        // サーバーが拒否した場合は理由を表示
        await page.evaluate(() => { window.__fail = "この施設の管理者・副管理者のみ操作できます"; });
        await rowOf(page, "副管理者X").locator('[data-act="remove-member"]').click();
        await sec.locator("[data-msg].error-message").waitFor();
        assert.match(await sec.locator("[data-msg]").innerText(), /管理者・副管理者のみ/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `${width}: 横スクロールなし`);
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  });

  test(`利用者管理(副管理者): 注文者・代行入力者だけを操作でき、管理者・副管理者の変更・削除や施設名の編集・施設削除は表示しない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 1200 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      page.on("dialog", d => d.accept());
      await page.goto(base + "/subadmin");
      await page.waitForFunction(() => window.__ready);
      const sec = page.locator('[data-section="members"]');
      assert.equal(await page.locator("#btnRenameFacility").count(), 0, "施設名の編集は管理者のみ");
      assert.equal(await page.locator("#btnDeleteFacility").count(), 0, "施設削除は管理者のみ");
      for (const who of ["自分", "管理者A", "副管理者X"]) assert.deepEqual(await acts(rowOf(page, who)), [], who);
      assert.deepEqual(await acts(rowOf(page, "注文者A")), ["edit-role", "remove-member"]);
      assert.deepEqual(await acts(rowOf(page, "代行A")), ["edit-role", "remove-member"]);
      assert.deepEqual(await acts(rowOf(page, "副候補S")), [], "副管理者宛ての参加待ちは操作できない");
      assert.deepEqual(await acts(rowOf(page, "期限切れE")), ["renew", "cancel-pending"]);
      await rowOf(page, "注文者A").locator('[data-act="edit-role"]').click();
      assert.deepEqual(await rowOf(page, "注文者A").locator(".member-role-edit select option").allInnerTexts(), ["注文者", "代行入力者"]);
      await sec.locator('[data-act="add"]').click();
      assert.deepEqual(await sec.locator('[data-f="addRole"] option').allInnerTexts(), ["注文者", "代行入力者"]);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test(`参加確認: 施設名と役割を示し、施設ごとに「参加する」「参加しない」を選べる。注文画面は隠す: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        let dialogs = 0;
        page.on("dialog", d => { dialogs++; d.accept(); });
        await page.goto(base + "/confirm");
        await page.waitForFunction(() => window.__ready);
        const panel = page.locator("#authPanel");
        assert.match(await panel.innerText(), /施設への参加の確認/);
        const items = panel.locator(".pending-invite");
        assert.equal(await items.count(), 2, "複数施設");
        assert.deepEqual(await items.locator(".pending-invite-facility").allInnerTexts(), ["<b>A</b>眼科", "B病院"], "施設名は文字として表示");
        assert.equal(await panel.locator(".pending-invite-facility b").count(), 0);
        assert.deepEqual(await items.locator(".member-role-badge").allInnerTexts(), ["代行入力者", "注文者"]);
        assert.match(await items.nth(0).innerText(), /登録者 管理者A/);
        assert.deepEqual(await items.nth(0).locator("button").allInnerTexts(), ["参加する", "参加しない"]);
        // 参加する(左)・参加しない(右)は同じ行
        const [a, d] = [await items.nth(0).locator('[data-act="accept"]').boundingBox(), await items.nth(0).locator('[data-act="decline"]').boundingBox()];
        assert.ok(Math.abs(a.y - d.y) < 4 && a.x < d.x);
        await items.nth(0).locator('[data-act="accept"]').click();
        await items.nth(1).locator('[data-act="decline"]').click();
        assert.equal(dialogs, 1, "参加しないときだけ確認");
        assert.deepEqual(await page.evaluate(() => window.__responses), [{ pendingId: "fA_1", accept: true }, { pendingId: "fB_2", accept: false }]);
        // 所属済み(注文画面の表示中)でも、参加待ちがあれば確認画面を先に表示し、注文画面を隠す
        await page.evaluate(() => window.__render("granted"));
        assert.equal(await page.locator("#iolOrderForm").evaluate(e => e.classList.contains("hidden")), true);
        assert.equal(await panel.locator(".pending-invite").count(), 2);
        // 参加待ちがなくなれば、通常の画面に戻る
        await page.evaluate(() => window.__render("granted", []));
        assert.equal(await page.locator("#iolOrderForm").evaluate(e => e.classList.contains("hidden")), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}
