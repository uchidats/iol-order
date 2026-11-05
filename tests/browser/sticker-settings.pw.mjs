// 回帰テスト(ブラウザ): 施設設定「IOLシール写真」。実際の facility-settings.js(管理者・副管理者)と sticker-settings-view.js(注文者・代理入力者)を偽の API で動かす(ログイン・Firebase は使わない)
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
<header class="app-header"><div class="header-inner"><span class="header-title">IOL</span></div></header>
<main class="main-content"></main>
<script type="module">
import { createFacilitySettings } from "/src/ui/facility-settings.js";
import { IOL_MODELS } from "/src/data/iol-models.js";
const q = new URLSearchParams(location.search);
const role = q.get("role") || "admin", mode = q.get("mode") || "on";
const repository = {
  listOrderers: async () => [], listAdoptedIols: async () => [], getIolOrder: async () => null,
  listDealers: async () => [{ id: "dA", name: "X商事 立川", sortOrder: 10, orderEmails: [] }], getMailSettings: async () => null, getHeaderTheme: async () => null,
  listMembers: async () => [{ uid: "me", role, displayName: "自分" }], listPendingMembers: async () => [], getMemberOrder: async () => null
};
const settingsApi = { saveOrderers: async () => {}, saveAdoptedIols: async () => {}, saveIolOrder: async () => {}, deleteOrderer: async () => {}, deleteDealer: async () => {},
  saveDealers: async () => {}, saveMailSettings: async () => {}, saveHeaderTheme: async () => {}, resetHeaderTheme: async () => {}, saveMemberOrder: async () => {} };
const inviteApi = { removeMember: async () => {}, addMember: async () => ({}), cancelPendingMember: async () => {}, changeMemberRole: async () => {} };
const state = { sheetNote: "1行目\\n2行目", entry: q.get("entry") !== "none", lock: q.get("lock") === "1", set: q.get("code") !== "unset", updatedAt: "2026-11-02T15:30:00.000Z", gen: 0,
  dealers: [
    { localDealerId: "dA", dealerName: "X商事 立川", linked: true, companyName: "X商事", shared: false, stale: false, sharedFrom: null },
    { localDealerId: "dB", dealerName: "Y医療", linked: true, companyName: "Y医療", shared: true, stale: q.get("stale") === "1", sharedFrom: "2026-11-01T00:00:00.000Z" },
    { localDealerId: "dC", dealerName: "未関連付け", linked: false, shared: false, stale: false }] };
if (q.get("dealers") === "none") state.dealers = [state.dealers[2]];
window.__calls = []; window.__portalCalls = [];
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const stickerPhotoCall = async (p) => {
  window.__calls.push(p);
  if (mode === "off") fail("functions/failed-precondition", "IOLシール写真は現在ご利用いただけません");
  if (mode === "outside") fail("functions/permission-denied", "この施設の写真を操作する権限がありません");
  if (mode === "error") fail("functions/internal", "boom");
  const manager = role === "admin" || role === "subadmin";
  // サーバーと同じ規則: 注文者・代理入力者の変更の操作は拒否し、表示には共有の状態を含めない
  if (!manager && ["setAccessCode", "setSheetNote", "rotateEntryQr", "setDealerShare", "delete"].includes(p.action)) fail("functions/permission-denied", "この施設の管理者・副管理者のみ操作できます");
  if (p.action === "getSettings" && window.__slowSettings) await new Promise(r => setTimeout(r, 1500));
  if (p.action === "setSheetNote") { if (window.__failNote) fail("functions/invalid-argument", "保存できませんでした"); state.sheetNote = p.note; return { ok: true, sheetNote: p.note }; }
  if (p.action === "getSettings") return { sheetNote: state.sheetNote, accessCodeSet: state.set, accessCodeUpdatedAt: state.set ? state.updatedAt : null, entryIssued: state.entry, verifyBlockedUntil: state.lock ? "2026-11-06T03:05:00.000Z" : null, canManage: manager && q.get("deny") !== "1", ...(manager && q.get("deny") !== "1" ? { dealers: state.dealers } : {}) };
  if (p.action === "setAccessCode") { if (window.__failCode) fail("functions/permission-denied", "この施設の管理者・副管理者のみ操作できます"); state.set = true; state.lock = false; state.updatedAt = "2026-11-05T01:00:00.000Z"; return { ok: true }; }
  if (p.action === "getEntryQr" && !state.entry && !manager) fail("functions/failed-precondition", "QRコードはまだ発行されていません。施設の管理者・副管理者に発行を依頼してください");
  if (p.action === "getEntryQr" || p.action === "rotateEntryQr") { state.entry = true; if (p.action === "rotateEntryQr") state.gen += 1; return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" data-gen="' + state.gen + '"><script>window.__evil = true</scr' + 'ipt><rect width="10" height="10"/></svg>', url: window.__badUrl ? "javascript:alert(1)" : "https://iol.medconf.jp/sticker.html#f=" + "abcdefghijklmnopqrstu" + state.gen }; }
  if (p.action === "setDealerShare") { if (window.__failShare) fail("functions/failed-precondition", "このディーラーは写真を共有できません"); state.dealers.find(d => d.localDealerId === p.localDealerId).shared = p.shared; return { ok: true, shared: p.shared }; }
  throw new Error("unknown " + p.action);
};
const portal = (name) => async (a) => { window.__portalCalls.push([name, a]); return name === "facilityStatus" ? { portalEnabled: true, dealers: q.get("portalDealer") ? [{ localDealerId: "p1", dealerName: "発注先P", link: { status: q.get("portalDealer") === "active" ? "active" : "proposed", companyActive: true, companyName: "P社", revision: 1, ...(q.get("portalDealer") === "active" ? { grant: { effectiveFrom: "2026-11-01T00:00:00.000Z" } } : {}) } }] : [] } : { ok: true }; };
const dealerPortalApi = q.get("portal") === "none" ? null : { facilityStatus: portal("facilityStatus"), grant: portal("grant"), revoke: portal("revoke") };
if (q.get("view") === "member") {
  // 注文者・代理入力者の「施設設定」(main.js と同じ組み立て)
  const { createStickerSettingsView } = await import("/src/ui/sticker-settings-view.js");
  const { createStickerSettingsApi } = await import("/src/data/sticker-settings-api.js");
  window.__closed = 0;
  window.__settings = createStickerSettingsView({ mount: document.querySelector("main"), api: createStickerSettingsApi(stickerPhotoCall),
    listDealers: async (id) => { window.__calls.push({ action: "listDealers", facilityId: id }); if (q.get("dealerList") === "fail") throw new Error("read"); return repository.listDealers(id); }, onClose() { window.__closed += 1; } });
} else {
window.__settings = createFacilitySettings({ mount: document.querySelector("main"), repository, settingsApi, inviteApi, masters: IOL_MODELS, dealerPortalApi, stickerPhotoApi: { settingsCall: stickerPhotoCall },
  stickerSettingsEnabled: q.get("flag") !== "off", currentUser: { uid: "me", displayName: "自分" }, actorRole: role, onSaved: async () => {}, onClose() {} });
}
await window.__settings.open({ id: "fA", name: "A眼科" });
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
test.after(() => server.close());

async function launch(type, name) {
  for (const opts of name === "chromium" ? [{}, { channel: "msedge" }, { channel: "chrome" }] : [{}]) {
    try { return await type.launch(opts); } catch { /* 次の候補へ */ }
  }
  return null;
}
const section = (page) => page.locator('[data-section="stickerPhotos"]');
async function openPage(browser, query = "", width = 390) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.errors = [];
  page.on("pageerror", e => page.errors.push(String(e)));
  await page.goto(`${base}${query}`);
  await page.waitForFunction(() => window.__ready);
  return page;
}
const ready = (page) => section(page).locator('[data-f="codeStatus"]:not(:empty)').waitFor();
const confirmDialog = async (page, act) => { await page.waitForSelector(".confirm-dialog"); await page.click(`.confirm-dialog [data-act="${act}"]`); };

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`IOLシール写真の設定: 管理者・副管理者が表示でき、コードの状態と共有できる発注先だけを出す: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      for (const [role, width] of [["admin", 390], ["subadmin", 1100]]) {
        const page = await openPage(browser, `?role=${role}`, width);
        await ready(page);
        assert.equal(await section(page).locator('[data-f="codeStatus"]').innerText(), "設定済み");
        assert.equal(await section(page).locator('[data-act="editCode"]').innerText(), "変更");
        assert.deepEqual(await section(page).locator("[data-share] label span:first-of-type").allInnerTexts(), ["X商事 立川", "Y医療"], "関連付けのない発注先は出さない");
        assert.deepEqual(await section(page).locator("[data-dealer]").evaluateAll(l => l.map(i => i.checked)), [false, true]);
        assert.ok(!(await section(page).innerText()).includes("許可中"));
        assert.deepEqual(page.errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "横にはみ出さない");
        await page.close();
      }
    } finally { await browser.close(); }
  });

  test(`IOLシール写真の設定: QR はモーダルに画像として出し、URL の文字列を出さない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      const page = await openPage(browser);
      await ready(page);
      await section(page).locator('[data-act="showQr"]').click();
      await page.waitForSelector(".sticker-qr-dialog");
      const box = await page.locator(".sticker-qr-dialog .modal-card").innerText();
      assert.ok(box.includes("IOLシール写真のQRコード") && !box.includes("A眼科"));
      assert.ok(!/https?:|sticker\.html/.test(box), "URL は文字で出さない");
      assert.ok((await page.locator(".sticker-qr-dialog img").getAttribute("src")).startsWith("data:image/svg+xml"));
      assert.equal(await page.evaluate(() => window.__evil === undefined), true, "SVG の中のスクリプトは動かない");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".sticker-qr-dialog").count(), 0);
      await page.close();
    } finally { await browser.close(); }
  });
}

test("アクセスコード: 変更は確認の後に保存し、入力欄を閉じて通常の表示に戻す。コードは画面に出さない", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await openPage(browser);
    await ready(page);
    const s = section(page);
    assert.equal(await s.locator('[data-f="codeForm"]').isVisible(), false);
    await s.locator('[data-act="editCode"]').click();
    assert.match(await s.locator('[data-f="codeNote"]').innerText(), /後から確認できません。控えてから保存してください/);
    await s.locator('[data-f="code"]').fill("12345");
    await s.locator('[data-act="saveCode"]').click();
    assert.match(await s.locator('[data-err="code"]').innerText(), /半角数字6〜12桁/);
    assert.equal((await page.evaluate(() => window.__calls)).some(c => c.action === "setAccessCode"), false, "形式違いは送らない");
    await s.locator('[data-f="code"]').fill("654321");
    await s.locator('[data-act="saveCode"]').click();
    await confirmDialog(page, "cancel");
    assert.equal((await page.evaluate(() => window.__calls)).some(c => c.action === "setAccessCode"), false, "確認で取り消せる");
    await s.locator('[data-act="saveCode"]').click();
    await confirmDialog(page, "ok");
    await page.waitForFunction(() => document.querySelector('[data-section="stickerPhotos"] [data-msg]').textContent === "アクセスコードを変更しました。");
    assert.equal(await s.locator('[data-f="codeForm"]').isVisible(), false);
    assert.equal(await s.locator('[data-act="editCode"]').isVisible(), true);
    assert.equal(await s.locator('[data-f="newCodeBox"], [data-f="newCode"], [data-act="hideNewCode"]').count(), 0, "コードの表示・案内・閉じるは出さない");
    assert.ok(!(await s.evaluate(el => el.outerHTML)).includes("654321"), "コードを画面に残さない");
    assert.equal(await s.locator('[data-f="code"]').inputValue(), "", "入力欄に残さない");
    assert.equal(await s.locator('[data-f="codeStatus"]').innerText(), "設定済み");
    assert.deepEqual(await page.evaluate(() => [localStorage.length ? JSON.stringify({ ...localStorage }).includes("654321") : false, sessionStorage.length]), [false, 0], "端末に保存しない");
    await s.locator('[data-act="editCode"]').click();
    assert.equal(await s.locator("[data-msg]").innerText(), "", "次の入力を始めたら通知を消す");
    await page.close();
  } finally { await browser.close(); }
});

test("アクセスコード: 未設定なら確認なしで設定でき、手入力だけ。失敗は理由を出す", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await openPage(browser, "?code=unset");
    await ready(page);
    const s = section(page);
    assert.equal(await s.locator('[data-f="codeStatus"]').innerText(), "未設定");
    assert.equal(await s.locator('[data-act="editCode"]').innerText(), "設定");
    await s.locator('[data-act="editCode"]').click();
    // 手入力だけ。残るボタンは「設定する」「キャンセル」で、補助ボタンの大きさのまま
    assert.equal(await s.locator('[data-act="generateCode"]').count(), 0);
    assert.deepEqual(await s.locator('[data-f="codeForm"] button').evaluateAll(l => l.map(b => [b.textContent, getComputedStyle(b).minHeight])), [["設定する", "36px"], ["キャンセル", "36px"]]);
    const gap = await s.evaluate((el) => el.querySelector('[data-f="code"]').getBoundingClientRect().top - el.querySelector(".sticker-code-row").getBoundingClientRect().bottom);
    assert.ok(gap > 7.9, `入力欄を上の行に接しない: ${gap}`);
    const code = "24681357";
    await s.locator('[data-f="code"]').fill(code);
    await page.evaluate(() => { window.__failCode = true; });
    await s.locator('[data-act="saveCode"]').click();
    await page.waitForFunction(() => document.querySelector('[data-err="code"]').textContent.includes("管理者"));
    assert.equal(await s.locator('[data-f="code"]').inputValue(), code, "失敗したら入力を残す");
    await page.evaluate(() => { window.__failCode = false; });
    await s.locator('[data-act="saveCode"]').click();
    await page.waitForFunction(() => document.querySelector('[data-section="stickerPhotos"] [data-msg]').textContent === "アクセスコードを設定しました。");
    assert.equal(await s.locator('[data-f="codeStatus"]').innerText(), "設定済み");
    assert.equal(await page.locator(".confirm-dialog").count(), 0);
    assert.deepEqual((await page.evaluate(() => window.__calls)).filter(c => c.action === "setAccessCode").at(-1), { action: "setAccessCode", facilityId: "fA", code });
    await page.evaluate(() => window.__settings.close());
    assert.equal(await page.evaluate(() => document.querySelector('[data-section="stickerPhotos"] [data-msg]').textContent), "", "画面を閉じると通知を消す");
    await page.close();
  } finally { await browser.close(); }
});

const openRotateTip = (s) => s.locator('[data-f="rotateTip"] .info-tip-btn').click();

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`QR: 作り直しは通常は出さず、ⓘの中から操作する。確認の後に行い、新しい QR を出す。取り消せる: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      for (const width of [320, 390, 1100]) {
        const page = await openPage(browser, "", width);
        await ready(page);
        const s = section(page);
        const rotate = s.locator('[data-act="rotateQr"]');
        // 通常の表示: 「表示」だけ。作り直しは ⓘ の中、印刷はモーダルの中
        assert.equal(await rotate.isVisible(), false, "通常は出さない");
        assert.equal(await s.locator('[data-act="showQr"]').innerText(), "表示");
        assert.equal(await s.locator('[data-act="showQr"]').getAttribute("aria-label"), "QRコードを表示");
        assert.equal(await s.locator('[data-act="printSheet"], [data-act="printQr"]').count(), 0, "施設設定の画面に印刷のボタンを出さない");

        const scrollWidth = () => page.evaluate(() => document.documentElement.scrollWidth);
        const closedWidth = await scrollWidth();
        await openRotateTip(s);
        assert.equal(await rotate.isVisible(), true, "ⓘ の中に出す");
        assert.match(await s.locator('[data-f="rotateTip"] .info-tip-pop').innerText(), /これまでのQRコードは使えなくなります/);
        const box = await rotate.boundingBox();
        assert.equal(await rotate.evaluate(e => getComputedStyle(e).minHeight), "36px", "ボタンの大きさは変えない");
        const pop = await s.locator('[data-f="rotateTip"] .info-tip-pop').boundingBox();
        assert.ok(box.x >= pop.x && box.x + box.width <= pop.x + pop.width, `${width}: ボタンは説明の枠の中`);
        assert.ok(box.x >= 0 && box.x + box.width <= width, `${width}: 画面の中に収まる`);
        assert.equal(await scrollWidth(), closedWidth, `${width}: ⓘ を開いても画面の幅は増えない`);

        await rotate.click();
        assert.equal(await rotate.isVisible(), false, "押すと ⓘ を閉じる");
        await confirmDialog(page, "cancel");
        assert.equal((await page.evaluate(() => window.__calls)).some(c => c.action === "rotateEntryQr"), false);
        await openRotateTip(s);
        await rotate.click();
        assert.match(await page.locator(".confirm-dialog-message").innerText(), /使えなくなります/);
        await confirmDialog(page, "ok");
        await page.waitForSelector(".sticker-qr-dialog");
        assert.ok(decodeURIComponent(await page.locator(".sticker-qr-dialog img").getAttribute("src")).includes('data-gen="1"'));
        await page.click('.sticker-qr-dialog [data-act="close"]');
        assert.deepEqual(page.errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}

test("QR: 見出しの行の高さはほかの見出しと同じ。マウスで ⓘ からボタンへ移っても閉じない。キーボードでも操作できる", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await openPage(browser, "", 1100);
    await ready(page);
    const s = section(page);
    const heights = await s.locator("h4").evaluateAll(l => l.map(e => e.getBoundingClientRect().height));
    assert.equal(new Set(heights).size, 1, `見出しの高さ: ${heights}`);

    // ホバーで開き、ⓘ からボタンへ動かす
    await s.locator('[data-f="rotateTip"] .info-tip-btn').hover();
    const rotate = s.locator('[data-act="rotateQr"]');
    await rotate.waitFor();
    const target = await rotate.boundingBox();
    await page.mouse.move(target.x + 20, target.y + 10, { steps: 15 });
    assert.equal(await rotate.isVisible(), true, "移動の途中で閉じない");
    await page.mouse.down();
    await page.mouse.up();
    await confirmDialog(page, "cancel");

    // キーボード: ⓘ を Enter で開き、Tab でボタンへ、Enter で押す
    await s.locator('[data-f="rotateTip"] .info-tip-btn').focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.dataset.act), "rotateQr");
    await page.keyboard.press("Enter");
    await confirmDialog(page, "cancel");
    assert.equal((await page.evaluate(() => window.__calls)).some(c => c.action === "rotateEntryQr"), false);
    await page.close();
  } finally { await browser.close(); }
});

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`アクセスコードの「変更」・QRコードの「表示」: 「許可する」と同じ見た目で右端をそろえ、見出し・内容・次の項目を詰めない。ほかのボタンは変えない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      for (const width of [320, 390, 1100]) {
        const page = await openPage(browser, "?portalDealer=1", width);
        await ready(page);
        const s = section(page);
        const code = s.locator('[data-act="editCode"]'), grant = page.locator('[data-section="dealerPortal"] [data-act="grant"]');
        await grant.waitFor();
        const style = (l) => l.evaluate((el) => {
          const c = getComputedStyle(el), r = el.getBoundingClientRect();
          return { background: c.backgroundColor, color: c.color, height: r.height, padding: c.padding, radius: c.borderRadius, border: c.border, fontSize: c.fontSize, fontWeight: c.fontWeight, fontFamily: c.fontFamily, lineHeight: c.lineHeight };
        });
        assert.deepEqual(await style(code), await style(grant), `${width}: 見た目が同じ`);
        assert.equal(await code.innerText(), "変更");

        const a = await code.boundingBox(), b = await grant.boundingBox(), st = await s.locator('[data-f="codeStatus"]').boundingBox();
        assert.ok(Math.abs((a.x + a.width) - (b.x + b.width)) < 0.5, `${width}: 右端が同じ`);
        const label = await s.locator(".sticker-code-row h4").first().boundingBox();
        assert.ok(st.x >= label.x + label.width && st.x - (label.x + label.width) <= 8, `${width}: バッジは見出しのすぐ右`);
        assert.ok(st.x + st.width <= a.x, `${width}: バッジはボタンの左`);
        assert.ok(st.y < a.y + a.height && a.y < st.y + st.height, `${width}: 同じ行`);
        // QRコード: 見出しと同じ行で、「変更」と同じ見た目・同じ右端
        const show = s.locator('[data-act="showQr"]');
        assert.deepEqual(await style(show), await style(code), `${width}: 「表示」は「変更」と同じ見た目`);
        const q = await show.boundingBox(), head = await s.locator(".sticker-qr-row h4").first().boundingBox();
        assert.ok(Math.abs((q.x + q.width) - (a.x + a.width)) < 0.5, `${width}: 「表示」と「変更」の右端が同じ`);
        assert.ok(head.y < q.y + q.height && q.y < head.y + head.height && head.x + head.width <= q.x, `${width}: 見出しと同じ行`);
        // 項目の間隔
        const heads = await s.evaluate((el) => {
          const box = (n) => n.getBoundingClientRect();
          const share = el.querySelector(":scope > h4"), row = el.querySelector(":scope > .sticker-code-row:not(.sticker-qr-row)"), qr = el.querySelector(".sticker-qr-row");
          return { contentToQr: box(qr).top - box(row).bottom, qrToShare: box(share).top - box(qr).bottom };
        });
        assert.ok(heads.contentToQr > 15.9 && heads.qrToShare > 15.9, `${width}: ${JSON.stringify(heads)}`);
        assert.equal(await s.locator('[data-f="rotateTip"] [data-act="rotateQr"]').evaluate(e => getComputedStyle(e).minHeight), "36px", "ほかの補助ボタンは変えない");

        await code.click();
        assert.equal(await s.locator('[data-f="codeForm"]').isVisible(), true, "機能はそのまま");
        assert.deepEqual(page.errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`QR のモーダル: 印刷の2つのボタンは同じ行で中央(幅が足りない 320px だけ2行で、それぞれ中央)。ボタンの大きさ・間隔は変えず、施設の画面の並びは左のまま: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      for (const width of [320, 340, 360, 390, 1100]) {
        const page = await openPage(browser, "", width);
        await ready(page);
        const s = section(page);
        assert.equal(await s.locator('[data-f="rotateTip"] .settings-actions').evaluate(e => getComputedStyle(e).justifyContent), "normal", "モーダルの外の並びは変えない");
        await s.locator('[data-act="showQr"]').click();
        await page.waitForSelector(".sticker-qr-dialog");
        const m = await page.evaluate(() => {
          const box = (el) => el.getBoundingClientRect();
          const d = document.querySelector(".sticker-qr-dialog");
          const a = d.querySelector('[data-act="printSheet"]'), b = d.querySelector('[data-act="printQr"]'), body = d.querySelector(".modal-body"), c = getComputedStyle(a);
          const cs = getComputedStyle(body);
          return { a: box(a), b: box(b), left: box(body).left + parseFloat(cs.paddingLeft), right: box(body).right - parseFloat(cs.paddingRight), labels: [a.textContent, b.textContent], gap: box(b).left - box(a).right,
            style: { minHeight: c.minHeight, background: c.backgroundColor, classes: a.className } };
        });
        assert.deepEqual(m.labels, ["台紙を印刷", "QRコードのみ印刷"]);
        const center = (m.left + m.right) / 2;
        if (width === 320) {
          // 2つで 286px 必要で、内側は 280px。大きさを変えないので2行のまま、それぞれ中央
          assert.ok(m.b.top > m.a.top, "2行");
          for (const box of [m.a, m.b]) assert.ok(Math.abs((box.left + box.right) / 2 - center) < 1, "それぞれ中央");
        } else {
          assert.equal(m.a.top, m.b.top, `${width}: 同じ行`);
          assert.ok(Math.abs((m.a.left + m.b.right) / 2 - center) < 1, `${width}: 中央`);
          assert.ok(Math.abs(m.gap - 8) < 0.01, `間隔は変えない: ${m.gap}`);
        }
        assert.deepEqual(m.style, { minHeight: "36px", background: "rgb(241, 245, 249)", classes: "btn btn-secondary btn-aux" }, "ボタンの見た目は変えない");
        await page.click('.sticker-qr-dialog [data-act="close"]');
        assert.deepEqual(page.errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}

test("QR のモーダル: 設定の読み直しの途中でも、印刷と QR のみの印刷を開ける(管理者・注文者)", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    for (const [query, act] of [["", "printSheet"], ["", "printQr"], ["?view=member&role=orderer", "printSheet"], ["?view=member&role=proxy", "printQr"]]) {
      const page = await openPage(browser, query);
      await ready(page);
      await page.evaluate(() => { window.__slowSettings = true; });
      await section(page).locator('[data-act="showQr"]').click();
      await page.click(`.sticker-qr-dialog [data-act="${act}"]`);
      await page.waitForSelector(".sticker-print-view");
      assert.equal(await page.locator(".sticker-qr-dialog").count(), 0, "モーダルは閉じる");
      assert.deepEqual(page.errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`アクセスコードの状態: 「設定済み」は「許可中」、「未設定」は「未許可」と同じバッジ。日付は出さない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      for (const width of [320, 1100]) {
        for (const [query, text, sample] of [["?portalDealer=active", "設定済み", "許可中"], ["?portalDealer=1&code=unset", "未設定", "未許可"]]) {
          const page = await openPage(browser, query, width);
          await ready(page);
          const s = section(page);
          const badge = s.locator('[data-f="codeStatus"]'), same = page.locator('[data-section="dealerPortal"] .dealer-portal-state');
          await same.waitFor();
          assert.equal(await same.innerText(), sample);
          const look = (l) => l.evaluate((el) => {
            const c = getComputedStyle(el);
            return { background: c.backgroundColor, color: c.color, border: c.border, height: Math.round(el.getBoundingClientRect().height * 10) / 10, padding: c.padding, radius: c.borderRadius, fontSize: c.fontSize, fontWeight: c.fontWeight, lineHeight: c.lineHeight };
          });
          assert.equal(await badge.innerText(), text);
          assert.deepEqual(await look(badge), await look(same), `${width}: ${text}`);
          assert.doesNotMatch(await s.innerText(), /\d{4}\/\d{2}\/\d{2}/, "日付を出さない");
          assert.deepEqual(page.errors, []);
          await page.close();
        }
      }
    } finally { await browser.close(); }
  });
}

test("アクセスコードの状態: 読み込みに失敗したときは、空のバッジを出さない", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await openPage(browser, "?mode=error");
    await page.waitForFunction(() => document.querySelector('[data-section="stickerPhotos"] [data-msg]')?.textContent);
    assert.equal(await section(page).locator('[data-f="codeStatus"]').isVisible(), false);
    await page.close();
  } finally { await browser.close(); }
});

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`QR のモーダル: 施設名の代わりに撮影ページを開くアイコンだけを中央に出す。URL は QR と同じ値で文字列は出さない。モーダルの大きさは変えない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      for (const [width, query] of [[320, ""], [390, ""], [1100, ""], [390, "?view=member&role=orderer"]]) {
        const page = await openPage(browser, query, width);
        await ready(page);
        await section(page).locator('[data-act="showQr"]').click();
        await page.waitForSelector(".sticker-qr-dialog");
        const d = page.locator(".sticker-qr-dialog"), link = d.locator('[data-act="openEntry"]');
        assert.deepEqual(await link.evaluate(a => [a.getAttribute("href"), a.target, a.rel, a.title, a.getAttribute("aria-label"), a.textContent]),
          ["https://iol.medconf.jp/sticker.html#f=abcdefghijklmnopqrstu0", "_blank", "noopener noreferrer", "撮影ページを開く", "撮影ページを開く", ""]);
        assert.equal(await link.locator("svg.ext-icon path").getAttribute("d"), "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3", "関連リンクと同じアイコン");
        const text = await d.innerText();
        assert.ok(!text.includes("sticker.html") && !text.includes("A眼科") && !text.includes("立川"), "URL の文字列と施設名を出さない");
        const m = await page.evaluate(() => {
          const row = document.querySelector(".sticker-qr-dialog .share-url"), a = row.querySelector("a").getBoundingClientRect(), box = document.querySelector(".sticker-qr-dialog .share-qr").getBoundingClientRect();
          const before = row.cloneNode(false); before.textContent = "立川病院"; row.after(before);
          const r = { row: row.getBoundingClientRect().height, before: before.getBoundingClientRect().height, center: (a.left + a.right) / 2, qrCenter: (box.left + box.right) / 2 };
          before.remove();
          return r;
        });
        assert.ok(Math.abs(m.center - m.qrCenter) < 1, `${width}: QR の中央`);
        assert.ok(Math.abs(m.row - m.before) < 0.5, `${width}: 行の高さは施設名のときと同じ ${m.row} / ${m.before}`);
        assert.deepEqual(page.errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}

test("QR のモーダル: 作り直すとリンクも新しい URL になる。想定外の URL ならリンクを出さない", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await openPage(browser);
    await ready(page);
    const s = section(page);
    await openRotateTip(s);
    await s.locator('[data-act="rotateQr"]').click();
    await confirmDialog(page, "ok");
    await page.waitForSelector(".sticker-qr-dialog");
    assert.equal(await page.getAttribute('.sticker-qr-dialog [data-act="openEntry"]', "href"), "https://iol.medconf.jp/sticker.html#f=abcdefghijklmnopqrstu1");
    await page.click('.sticker-qr-dialog [data-act="close"]');
    await page.evaluate(() => { window.__badUrl = true; });
    await s.locator('[data-act="showQr"]').click();
    await page.waitForSelector(".sticker-qr-dialog");
    assert.equal(await page.locator('.sticker-qr-dialog [data-act="openEntry"]').count(), 0);
    await page.close();
  } finally { await browser.close(); }
});

test("台紙の注意事項: 管理者が編集して保存できる。改行を保ち、空欄も保存でき、失敗は理由を出して入力を残す。取り消せる", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    for (const width of [390, 1100]) {
      const page = await openPage(browser, "", width);
      await ready(page);
      const s = section(page);
      const view = s.locator('[data-f="noteView"]'), input = s.locator('[data-f="note"]');
      const notice = () => page.evaluate(() => document.querySelector('[data-section="stickerPhotos"] [data-msg]').textContent);
      const saves = () => page.evaluate(() => window.__calls.filter(c => c.action === "setSheetNote"));
      assert.equal(await view.evaluate(e => e.textContent), "1行目\n2行目");
      assert.equal(await view.evaluate(e => getComputedStyle(e).whiteSpace), "pre-line", "改行を見せる");
      const code = await s.locator('[data-act="editCode"]').boundingBox(), edit = await s.locator('[data-act="editNote"]').boundingBox();
      assert.ok(Math.abs((code.x + code.width) - (edit.x + edit.width)) < 0.5 && code.height === edit.height, "ほかの「変更」と同じ大きさ・右端");

      await s.locator('[data-act="editNote"]').click();
      assert.equal(await input.inputValue(), "1行目\n2行目");
      assert.equal(await input.getAttribute("maxlength"), "150");
      assert.equal(await view.isVisible(), false);
      await input.fill("変更した");
      await s.locator('[data-act="cancelNote"]').click();
      assert.equal(await s.locator('[data-f="noteForm"]').isVisible(), false);
      assert.equal(await view.evaluate(e => e.textContent), "1行目\n2行目", "取り消すと変わらない");
      assert.deepEqual(await saves(), []);

      await s.locator('[data-act="editNote"]').click();
      await input.fill("新しい1行目\n新しい2行目\n\n");
      await page.evaluate(() => { window.__failNote = true; });
      await s.locator('[data-act="saveNote"]').click();
      await page.waitForFunction(() => document.querySelector('[data-err="note"]').textContent.includes("保存できませんでした"));
      assert.equal(await s.locator('[data-f="noteForm"]').isVisible(), true);
      assert.equal(await input.inputValue(), "新しい1行目\n新しい2行目\n\n", "失敗したら入力を残す");
      await page.evaluate(() => { window.__failNote = false; });
      await s.locator('[data-act="saveNote"]').click();
      await page.waitForFunction(() => document.querySelector('[data-section="stickerPhotos"] [data-msg]').textContent === "台紙の注意事項を保存しました。");
      assert.equal(await s.locator('[data-f="noteForm"]').isVisible(), false);
      assert.equal(await view.evaluate(e => e.textContent), "新しい1行目\n新しい2行目");
      assert.deepEqual((await saves()).at(-1), { action: "setSheetNote", facilityId: "fA", note: "新しい1行目\n新しい2行目" });

      await s.locator('[data-act="editNote"]').click();
      assert.equal(await notice(), "", "次の入力を始めたら通知を消す");
      await input.fill("");
      await s.locator('[data-act="saveNote"]').click();
      await page.waitForFunction(() => document.querySelector('[data-f="noteView"]').textContent === "なし");
      assert.equal((await saves()).at(-1).note, "", "空欄も保存できる");
      assert.deepEqual(page.errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test("写真の共有: チェックで自動保存し、受注閲覧の許可の処理を呼ばない。失敗はチェックを戻して理由を出す", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await openPage(browser);
    await ready(page);
    const s = section(page);
    await s.locator('[data-dealer="dA"]').check();
    await page.waitForFunction(() => window.__calls.some(c => c.action === "setDealerShare"));
    await page.waitForFunction(() => document.querySelector('[data-dealer="dA"]').checked && !document.querySelector('[data-dealer="dA"]').disabled);
    assert.deepEqual((await page.evaluate(() => window.__calls)).find(c => c.action === "setDealerShare"), { action: "setDealerShare", facilityId: "fA", localDealerId: "dA", shared: true });
    await s.locator('[data-dealer="dB"]').uncheck();
    await page.waitForFunction(() => window.__calls.filter(c => c.action === "setDealerShare").length === 2);
    assert.deepEqual((await page.evaluate(() => window.__portalCalls)).map(c => c[0]).filter(n => n !== "facilityStatus"), [], "受注閲覧の許可・取消を呼ばない");
    await page.evaluate(() => { window.__failShare = true; });
    await page.waitForFunction(() => !document.querySelector('[data-dealer="dB"]').disabled);
    await s.locator('[data-dealer="dB"]').click();
    await page.waitForFunction(() => document.querySelector('[data-section="stickerPhotos"] [data-msg]').textContent.includes("共有できません"));
    assert.equal(await s.locator('[data-dealer="dB"]').isChecked(), false, "保存できなければ元に戻す");
    assert.equal(await s.locator('[data-dealer="dB"]').isDisabled(), false);
    await page.close();
  } finally { await browser.close(); }
});

test("写真の共有: 発注先の変更で止まった許可には「停止中」を出す。関連付けがなければ案内だけ", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    let page = await openPage(browser, "?stale=1");
    await ready(page);
    assert.equal(await section(page).locator('[data-share="dB"] [data-state="stale"]').innerText(), "停止中");
    await page.close();
    page = await openPage(browser, "?dealers=none");
    await ready(page);
    assert.match(await section(page).locator('[data-f="dealers"]').innerText(), /共有できるディーラーはありません/);
    assert.equal(await section(page).locator("[data-dealer]").count(), 0);
    await page.close();
  } finally { await browser.close(); }
});

test("表示の条件: 公開の前・機能の停止・対象外の施設では項目を出さない(管理者用の施設設定は、注文者には欄を作らない)。ほかのエラーは理由を出し、施設設定は使える", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    for (const q of ["?flag=off", "?role=orderer"]) {
      const page = await openPage(browser, q);
      assert.equal(await section(page).count(), 0, q);
      assert.deepEqual(await page.evaluate(() => window.__calls), [], "呼び出しもしない");
      await page.close();
    }
    for (const q of ["?mode=off", "?mode=outside"]) {
      const page = await openPage(browser, q);
      await page.waitForFunction(() => window.__calls.length > 0);
      await page.waitForTimeout(50);
      assert.equal(await section(page).isVisible(), false, q);
      assert.deepEqual(page.errors, []);
      await page.close();
    }
    const page = await openPage(browser, "?mode=error");
    await page.waitForFunction(() => document.querySelector('[data-section="stickerPhotos"] [data-msg]')?.textContent !== "");
    assert.equal(await section(page).isVisible(), true);
    assert.equal(await page.locator('[data-section="dealers"]').isVisible(), true);
    await page.close();
  } finally { await browser.close(); }
});

test("独立: 受注閲覧の API がなくても写真の設定は動き、写真の API がなければ受注閲覧の項目だけが出る", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    // 受注閲覧の API なし → 写真の設定だけ
    const page = await openPage(browser, "?role=admin&portal=none");
    await ready(page);
    assert.equal(await page.locator('[data-section="dealerPortal"]').count(), 0);
    await section(page).locator('[data-dealer="dA"]').check();
    await page.waitForFunction(() => window.__calls.some(c => c.action === "setDealerShare"));
    assert.deepEqual(await page.evaluate(() => window.__portalCalls), [], "受注閲覧の処理は1回も呼ばない");
    assert.deepEqual(page.errors, []);
    await page.close();
  } finally { await browser.close(); }
});

test("コードの確認の停止: 停止中だけ案内を出し、コードを変更すると消える", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const normal = await openPage(browser, "?role=admin");
    await ready(normal);
    assert.equal(await section(normal).locator('[data-f="verifyLock"]').isHidden(), true);
    await normal.close();
    const page = await openPage(browser, "?role=subadmin&lock=1");
    await ready(page);
    const note = section(page).locator('[data-f="verifyLock"]');
    assert.equal(await note.isVisible(), true);
    assert.match(await note.innerText(), /11\/6 12:05 まで.*アクセスコードを変更すると、すぐに再開できます/s);
    await section(page).locator('[data-act="editCode"]').click();
    await section(page).locator('[data-f="code"]').fill("13579024");
    await section(page).locator('[data-act="saveCode"]').click();
    await confirmDialog(page, "ok");
    await page.waitForFunction(() => document.querySelector('[data-f="verifyLock"]').hidden);
    assert.deepEqual(page.errors, []);
    await page.close();
  } finally { await browser.close(); }
});

const SETTERS = ["setAccessCode", "setSheetNote", "rotateEntryQr", "setDealerShare", "delete"];
for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`役割ごとの表示: 注文者・代理入力者には欄を出し、コードの状態・QR の表示と印刷・台紙の印刷だけを出す(変更の操作・共有・ほかの設定項目は出さない): ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      for (const [role, width] of [["orderer", 390], ["proxy", 1100]]) {
        const page = await openPage(browser, `?view=member&role=${role}`, width);
        await ready(page);
        const s = section(page);
        assert.equal(await s.isVisible(), true, role);
        assert.equal(await s.locator('[data-f="codeStatus"]').innerText(), "設定済み");
        // 出すもの(印刷はモーダルの中)
        assert.equal(await s.locator('[data-act="showQr"]').isVisible(), true);
        assert.equal(await s.locator('[data-act="printSheet"], [data-act="printQr"]').count(), 0);
        // 出さないもの
        for (const sel of ['[data-act="editCode"]', '[data-f="rotateTip"]', '[data-act="rotateQr"]', '[data-f="codeForm"]', '[data-f="noteHead"]', '[data-f="noteView"]', '[data-f="noteForm"]', '[data-f="shareHead"]', '[data-f="dealers"]'])
          assert.equal(await s.locator(sel).isVisible(), false, sel);
        assert.equal(await s.locator("[data-dealer]").count(), 0);
        assert.ok(!(await s.innerText()).includes("ディーラーへの共有"));
        // ほかの設定項目(担当医・採用IOL・ディーラー・利用者管理など)は作らない
        assert.deepEqual(await page.locator(".settings-section").evaluateAll(l => l.map(e => e.getAttribute("data-section"))), ["stickerPhotos"]);
        assert.equal(await page.locator("#facilitySettings").count(), 0);
        assert.equal(await page.locator(".settings-head h2").innerText(), "施設設定");
        assert.equal(await page.locator(".settings-facility").innerText(), "A眼科");
        // QR の表示(モーダルの中の印刷も使える。作り直しはない)
        await s.locator('[data-act="showQr"]').click();
        await page.waitForSelector(".sticker-qr-dialog");
        assert.deepEqual(await page.locator(".sticker-qr-dialog [data-act]").evaluateAll(l => l.map(b => b.getAttribute("data-act"))), ["openEntry", "printSheet", "printQr", "close"]);
        await page.keyboard.press("Escape");
        const calls = await page.evaluate(() => window.__calls);
        assert.deepEqual(calls.filter(c => SETTERS.includes(c.action)), [], "変更の呼び出しをしない");
        assert.deepEqual([...new Set(calls.map(c => c.action))].sort(), ["getEntryQr", "getSettings", "listDealers"]);
        assert.deepEqual(page.errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "横にはみ出さない");
        // 戻る
        await page.locator("#btnSettingsClose").click();
        assert.deepEqual(await page.evaluate(() => [window.__settings.isOpen(), window.__closed, document.querySelector("#stickerSettingsView").hidden]), [false, 1, true]);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}

test("役割ごとの表示: 注文者も台紙を印刷できる(発注先は読むだけ。読めなくても印刷できる)。コードの確認の停止中は、管理者へ知らせる案内を出す", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    for (const q of ["?view=member&role=orderer", "?view=member&role=proxy&dealerList=fail"]) {
      const page = await openPage(browser, q);
      await ready(page);
      await section(page).locator('[data-act="showQr"]').click();
      await page.click('.sticker-qr-dialog [data-act="printSheet"]');
      await page.waitForSelector(".sticker-print-view");
      assert.equal((await page.evaluate(() => window.__calls)).some(c => c.action === "getEntryQr"), true);
      assert.equal(await section(page).locator("[data-msg]").innerText(), "", q);
      assert.deepEqual(page.errors, [], q);
      await page.close();
    }
    const page = await openPage(browser, "?view=member&role=orderer&lock=1");
    await ready(page);
    const note = section(page).locator('[data-f="verifyLock"]');
    assert.equal(await note.isVisible(), true);
    assert.match(await note.innerText(), /11\/6 12:05 まで.*管理者・副管理者にお知らせください/s);
    assert.ok(!(await note.innerText()).includes("変更すると"));
    await page.close();
  } finally { await browser.close(); }
});

test("役割ごとの表示: 注文者の画面で、機能の停止・対象外の施設のときは欄を出さず、利用できないことを伝える。サーバーが操作できると答えても、変更の操作は出さない", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    for (const q of ["?view=member&role=orderer&mode=off", "?view=member&role=orderer&mode=outside"]) {
      const page = await openPage(browser, q);
      assert.equal(await section(page).isVisible(), false, q);
      assert.match(await page.locator("#stickerSettingsView > .form-hint").innerText(), /現在ご利用いただけません/);
      assert.deepEqual(page.errors, []);
      await page.close();
    }
    // 画面の役割が注文者なら、サーバーの答えに関係なく変更の操作を出さない(view=member で役割だけ管理者にした場合)
    const page = await openPage(browser, "?view=member&role=admin");
    await ready(page);
    for (const sel of ['[data-act="editCode"]', '[data-f="rotateTip"]', '[data-act="rotateQr"]', '[data-f="shareHead"]']) assert.equal(await section(page).locator(sel).isVisible(), false, sel);
    await page.close();
  } finally { await browser.close(); }
});

test("役割ごとの表示: 管理者・副管理者の画面でも、サーバーが操作できないと答えたら変更の操作を隠す", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await openPage(browser, "?role=admin");
    await ready(page);
    const s = section(page);
    for (const sel of ['[data-act="editCode"]', '[data-f="rotateTip"]', '[data-f="shareHead"]', '[data-dealer="dA"]']) assert.equal(await s.locator(sel).isVisible(), true, sel);
    await page.close();
    const denied = await openPage(browser, "?role=admin&deny=1");
    await ready(denied);
    for (const sel of ['[data-act="editCode"]', '[data-f="rotateTip"]', '[data-act="rotateQr"]', '[data-f="shareHead"]', '[data-f="dealers"]']) assert.equal(await section(denied).locator(sel).isVisible(), false, sel);
    assert.equal(await section(denied).locator('[data-act="showQr"]').isVisible(), true);
    assert.deepEqual(denied.errors, []);
    await denied.close();
  } finally { await browser.close(); }
});

test("QR の初回の発行: 未発行なら、注文者・代理入力者には表示・印刷を出さず依頼の案内を出す。管理者・副管理者は発行できる", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    for (const role of ["orderer", "proxy"]) {
      const page = await openPage(browser, `?view=member&role=${role}&entry=none`);
      await ready(page);
      const s = section(page);
      assert.match(await s.locator('[data-f="qrNotIssued"]').innerText(), /管理者・副管理者に発行を依頼してください/);
      for (const act of ["showQr", "printSheet", "printQr", "rotateQr"]) assert.equal(await s.locator(`[data-act="${act}"]`).isVisible(), false, act);
      assert.equal((await page.evaluate(() => window.__calls)).some(c => c.action === "getEntryQr"), false, "発行の呼び出しをしない");
      assert.deepEqual(page.errors, []);
      await page.close();
    }
    // 発行済みなら案内は出さない
    const issued = await openPage(browser, "?view=member&role=orderer");
    await ready(issued);
    assert.equal(await section(issued).locator('[data-f="qrNotIssued"]').isVisible(), false);
    await issued.close();
    // 管理者・副管理者は、未発行でも案内を出さず、表示の操作で発行できる
    for (const role of ["admin", "subadmin"]) {
      const page = await openPage(browser, `?role=${role}&entry=none`);
      await ready(page);
      const s = section(page);
      assert.equal(await s.locator('[data-f="qrNotIssued"]').isVisible(), false, role);
      await s.locator('[data-act="showQr"]').click();
      await page.waitForSelector(".sticker-qr-dialog");
      assert.equal((await page.evaluate(() => window.__calls)).some(c => c.action === "getEntryQr"), true, role);
      await page.close();
    }
  } finally { await browser.close(); }
});
