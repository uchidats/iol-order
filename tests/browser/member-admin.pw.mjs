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
window.__calls = []; window.__order = null; window.__orderSaves = []; window.__failOrder = false; window.__inflight = 0;
const rec = (name) => async (a) => { window.__calls.push([name, a]); if (window.__fail) { const e = new Error(window.__fail); e.code = "functions/permission-denied"; throw e; } return {}; };
const repository = { listOrderers: async () => [], listAdoptedIols: async () => [], listDealers: async () => [],
  listMembers: async () => members.map(m => ({ ...m })), listPendingMembers: async () => pending.map(p => ({ ...p })),
  getMemberOrder: async () => window.__order };
const settingsApi = { saveOrderers: async () => {}, saveAdoptedIols: async () => {}, saveDealers: async () => {}, deleteDealer: async () => {}, deleteOrderer: async () => {},
  // 表示順の保存: 遅延つき。同時に2つ走ったら記録する(保存の順序の競合の検出)
  saveMemberOrder: async (fid, order) => {
    window.__inflight++; if (window.__inflight > 1) window.__overlap = true;
    await new Promise(r => setTimeout(r, 150));
    window.__inflight--;
    window.__orderSaves.push([...order]);
    if (window.__failOrder) throw new Error("network");
    window.__order = [...order];
  } };
const inviteApi = {
  renameFacility: rec("renameFacility"), deleteFacility: rec("deleteFacility"),
  removeMember: rec("removeMember"), changeMemberRole: rec("changeMemberRole"), cancelPendingMember: rec("cancelPendingMember"), renewPendingMember: rec("renewPendingMember"),
  updateMemberName: async (a) => { window.__calls.push(["updateMemberName", a]); if (window.__fail) { const e = new Error(window.__fail); e.code = "functions/permission-denied"; throw e; } const m = members.find(x => x.uid === a.uid); if (m) m.displayName = a.name; return { changed: true, name: a.name }; },
  updatePendingMember: async (a) => { window.__calls.push(["updatePendingMember", a]); const p = pending.find(x => x.id === a.pendingId); Object.assign(p, { name: a.name, email: a.email, role: a.role }); return { pendingId: p.id }; },
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
const rowOf = (page, name) => page.locator(".member-item", { has: page.locator('[data-f="name"]', { hasText: new RegExp(`^${name}$`) }) });
// 見えている操作ボタン(先頭の↑・使えない操作は、場所だけ残して見えない)
const acts = (row) => row.locator(".orderer-actions button").evaluateAll(bs => bs.filter(b => getComputedStyle(b).visibility !== "hidden").map(b => b.getAttribute("data-act")));
const allActs = (row) => row.locator(".orderer-actions button").evaluateAll(bs => bs.map(b => b.getAttribute("data-act")));
const names = (page) => page.locator('[data-section="members"] .member-item [data-f="name"]').allInnerTexts();

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`利用者管理(管理者): ↑・編集・削除の並び、役割はバッジから、氏名・参加待ちの編集、並び替えの自動保存、削除・取り消し・再登録: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const page = await browser.newPage({ viewport: { width, height: 1400 } });
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        page.on("dialog", d => d.accept());
        await page.goto(base + "/admin");
        await page.waitForFunction(() => window.__ready);
        const sec = page.locator('[data-section="members"]');
        assert.equal(await page.locator('[data-section="invites"]').count(), 0, "「メンバーの招待」カードは廃止");
        // 施設設定の並び: 担当医 → 利用者管理 → 採用IOL → ディーラー
        assert.deepEqual((await page.locator("[data-section]").evaluateAll(es => es.map(e => e.getAttribute("data-section")))).filter(x => ["orderers", "members", "iols", "dealers"].includes(x)), ["orderers", "members", "iols", "dealers"]);
        // 一覧(表示順の保存がない間は 参加済み(役割順) → 参加待ち → 期限切れ → 辞退)
        assert.deepEqual(await names(page), ["自分", "副管理者X", "注文者A", "代行A", "新人P", "副候補S", "期限切れE", "辞退D"]);
        assert.deepEqual(await sec.locator('[data-f="state"]').allInnerTexts(), ["参加待ち", "参加待ち", "期限切れ", "辞退"]);
        // ボタンは全行とも 左から ↑・編集・削除。先頭の↑と使えない操作は見えない(場所は残る)
        for (const n of await names(page)) assert.deepEqual(await allActs(rowOf(page, n)), ["up", "edit", "delete"], n);
        assert.deepEqual(await acts(rowOf(page, "自分")), ["edit"], "自分: 先頭の↑なし・氏名は編集できる・削除なし");
        assert.deepEqual(await acts(rowOf(page, "副管理者X")), ["up", "edit", "delete"]);
        assert.deepEqual(await acts(rowOf(page, "新人P")), ["up", "edit", "delete"]);
        for (const act of ["up", "edit", "delete"]) {
          const xs = await sec.locator(`.member-item [data-act="${act}"]`).evaluateAll(bs => bs.map(b => Math.round(b.getBoundingClientRect().left)));
          assert.ok(xs.every(x => Math.abs(x - xs[0]) <= 1), `${width} ${act}: 位置がそろう ${xs}`);
        }
        // 担当医・ディーラーと同じボタン(同じ大きさ・クラス)
        const sz = await rowOf(page, "注文者A").locator('[data-act="edit"]').evaluate(b => [b.className.includes("btn-outline-sm"), b.className.includes("orderer-icon"), Math.round(b.getBoundingClientRect().height)]);
        assert.deepEqual(sz.slice(0, 2), [true, true]);
        // 役割: 自分のバッジは押せない(誤操作防止)。他の人のバッジから変更
        assert.equal(await rowOf(page, "自分").locator('button[data-act="role"]').count(), 0);
        await rowOf(page, "注文者A").locator('[data-act="role"]').click();
        const sel = rowOf(page, "注文者A").locator(".member-role-edit select");
        assert.deepEqual(await sel.locator("option").allInnerTexts(), ["管理者", "副管理者", "注文者", "代行入力者"]);
        await sel.selectOption("proxy");
        await rowOf(page, "注文者A").locator('[data-act="role-save"]').click();
        await page.waitForFunction(() => window.__calls.some(c => c[0] === "changeMemberRole"));
        assert.deepEqual((await page.evaluate(() => window.__calls)).find(c => c[0] === "changeMemberRole")[1], { facilityId: "f1", uid: "ordA", role: "proxy" });

        // 参加済みの氏名の編集: 氏名だけ(メールは変更できない)。管理者自身も
        await rowOf(page, "自分").locator('[data-act="edit"]').click();
        const meEdit = rowOf(page, "自分").locator(".member-edit");
        assert.equal(await meEdit.locator('[data-f="editEmail"]').count(), 0, "メールアドレスは変更できない");
        assert.match(await meEdit.innerText(), /me@example\.jp（変更できません）/);
        await meEdit.locator('[data-f="editName"]').fill("自分 改");
        await meEdit.locator('[data-act="save-row"]').click();
        await rowOf(page, "自分 改").waitFor();
        assert.deepEqual((await page.evaluate(() => window.__calls)).find(c => c[0] === "updateMemberName")[1], { facilityId: "f1", uid: "me", name: "自分 改" });

        // 参加待ちの編集: 氏名・メール・役割
        await rowOf(page, "新人P").locator('[data-act="edit"]').click();
        const pe = rowOf(page, "新人P").locator(".member-edit");
        assert.deepEqual(await pe.locator('[data-f="editRole"] option').allInnerTexts(), ["副管理者", "注文者", "代行入力者"]);
        await pe.locator('[data-f="editEmail"]').fill("bad");
        await pe.locator('[data-act="save-row"]').click();
        assert.match(await rowOf(page, "新人P").locator("[data-err]").innerText(), /形式/);
        await pe.locator('[data-f="editName"]').fill("新人Q");
        await pe.locator('[data-f="editEmail"]').fill("q@example.jp");
        await pe.locator('[data-f="editRole"]').selectOption("proxy");
        await pe.locator('[data-act="save-row"]').click();
        await rowOf(page, "新人Q").waitFor();
        assert.deepEqual((await page.evaluate(() => window.__calls)).find(c => c[0] === "updatePendingMember")[1], { facilityId: "f1", pendingId: "f1_" + "a".repeat(64), name: "新人Q", email: "q@example.jp", role: "proxy" });

        // 並び替え(↑)は自動保存。連続して押しても保存は1つずつ順に行い、最後の並びが保存される
        await rowOf(page, "注文者A").locator('[data-act="up"]').click();
        await rowOf(page, "注文者A").locator('[data-act="up"]').click();
        await rowOf(page, "辞退D").locator('[data-act="up"]').click();
        const expected = ["注文者A", "自分 改", "副管理者X", "代行A", "新人Q", "副候補S", "辞退D", "期限切れE"];
        assert.deepEqual(await names(page), expected);
        await page.waitForFunction(() => window.__inflight === 0 && window.__order && window.__order[6] && window.__order[6].startsWith("p:f1_c"));
        assert.equal(await page.evaluate(() => window.__overlap || false), false, "保存が重ならない");
        assert.deepEqual(await page.evaluate(() => window.__order), ["m:ordA", "m:me", "m:subX", "m:proxyA", "p:f1_" + "a".repeat(64), "p:f1_" + "d".repeat(64), "p:f1_" + "c".repeat(64), "p:f1_" + "b".repeat(64)]);
        // 先頭が変わると、先頭の↑だけ見えない
        assert.deepEqual(await acts(rowOf(page, "注文者A")), ["edit", "delete"]);
        assert.deepEqual(await acts(rowOf(page, "自分 改")), ["up", "edit"]);
        // 保存の失敗: 理由を表示し、再試行で保存
        await page.evaluate(() => { window.__failOrder = true; });
        await rowOf(page, "代行A").locator('[data-act="up"]').click();
        await sec.locator('[data-act="retry-autosave"]').waitFor();
        assert.match(await sec.locator("[data-msg]").innerText(), /保存できませんでした/);
        await page.evaluate(() => { window.__failOrder = false; });
        await sec.locator('[data-act="retry-autosave"]').click();
        await page.waitForFunction(() => window.__order && window.__order[2] === "m:proxyA");
        await sec.locator('[data-act="retry-autosave"]').waitFor({ state: "detached" });

        // 削除・取り消し・再登録
        await rowOf(page, "代行A").locator('[data-act="delete"]').click();
        await rowOf(page, "新人Q").locator('[data-act="delete"]').click();
        await rowOf(page, "期限切れE").locator('[data-act="renew"]').click();
        await page.waitForFunction(() => ["removeMember", "cancelPendingMember", "renewPendingMember"].every(n => window.__calls.some(c => c[0] === n)));
        const calls = await page.evaluate(() => window.__calls);
        assert.deepEqual(calls.find(c => c[0] === "removeMember")[1], { facilityId: "f1", uid: "proxyA" });
        assert.deepEqual(calls.find(c => c[0] === "cancelPendingMember")[1], { facilityId: "f1", pendingId: "f1_" + "a".repeat(64) });
        assert.deepEqual(calls.find(c => c[0] === "renewPendingMember")[1], { facilityId: "f1", pendingId: "f1_" + "b".repeat(64) });
        // サーバーが拒否した場合は理由を表示し、編集内容を残す(もう一度「保存」で再試行)
        await page.evaluate(() => { window.__fail = "この施設の管理者・副管理者のみ操作できます"; });
        await rowOf(page, "副管理者X").locator('[data-act="edit"]').click();
        await rowOf(page, "副管理者X").locator('[data-f="editName"]').fill("失敗する名前");
        await rowOf(page, "副管理者X").locator('[data-act="save-row"]').click();
        await sec.locator("[data-msg].error-message").waitFor();
        assert.match(await sec.locator("[data-msg]").innerText(), /管理者・副管理者のみ/);
        assert.equal(await rowOf(page, "副管理者X").locator('[data-f="editName"]').inputValue(), "失敗する名前");
        assert.match(await rowOf(page, "副管理者X").locator("[data-err]").innerText(), /もう一度/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `${width}: 横スクロールなし`);
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  });

  test(`利用者管理(副管理者): 注文者・代行入力者だけを編集・削除・役割変更でき、自分の氏名は編集できる。施設名の編集・施設削除は表示しない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const page = await browser.newPage({ viewport: { width, height: 1200 } });
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await page.goto(base + "/subadmin");
        await page.waitForFunction(() => window.__ready);
        const sec = page.locator('[data-section="members"]');
        assert.equal(await page.locator("#btnRenameFacility").count(), 0);
        assert.equal(await page.locator("#btnDeleteFacility").count(), 0);
        assert.deepEqual(await names(page), ["管理者A", "自分", "副管理者X", "注文者A", "代行A", "新人P", "副候補S", "期限切れE", "辞退D"]);
        assert.deepEqual(await acts(rowOf(page, "管理者A")), [], "先頭の↑なし・管理者は操作なし");
        assert.deepEqual(await acts(rowOf(page, "自分")), ["up", "edit"], "自分の氏名は編集できる");
        assert.deepEqual(await acts(rowOf(page, "副管理者X")), ["up"]);
        assert.deepEqual(await acts(rowOf(page, "注文者A")), ["up", "edit", "delete"]);
        assert.deepEqual(await acts(rowOf(page, "副候補S")), ["up"], "副管理者宛ての参加待ちは操作できない");
        assert.deepEqual(await acts(rowOf(page, "期限切れE")), ["up", "edit", "delete"]);
        for (const n of ["管理者A", "自分", "副管理者X", "副候補S"]) assert.equal(await rowOf(page, n).locator('button[data-act="role"]').count(), 0, n);
        await rowOf(page, "注文者A").locator('[data-act="role"]').click();
        assert.deepEqual(await rowOf(page, "注文者A").locator(".member-role-edit select option").allInnerTexts(), ["注文者", "代行入力者"]);
        await rowOf(page, "期限切れE").locator('[data-act="edit"]').click();
        assert.deepEqual(await rowOf(page, "期限切れE").locator('[data-f="editRole"] option').allInnerTexts(), ["注文者", "代行入力者"]);
        await sec.locator('[data-act="add"]').click();
        assert.deepEqual(await sec.locator('[data-f="addRole"] option').allInnerTexts(), ["注文者", "代行入力者"]);
        // 副管理者も並び替えできる(表示順だけ。権限は変わらない)
        await rowOf(page, "注文者A").locator('[data-act="up"]').click();
        await page.waitForFunction(() => window.__order && window.__order[2] === "m:ordA");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
        assert.deepEqual(errors, []);
        await page.close();
      }
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
