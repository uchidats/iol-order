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
const state = { lock: q.get("lock") === "1", set: q.get("code") !== "unset", updatedAt: "2026-11-02T15:30:00.000Z", gen: 0,
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
  if (!manager && ["setAccessCode", "rotateEntryQr", "setDealerShare", "delete"].includes(p.action)) fail("functions/permission-denied", "この施設の管理者・副管理者のみ操作できます");
  if (p.action === "getSettings") return { accessCodeSet: state.set, accessCodeUpdatedAt: state.set ? state.updatedAt : null, entryIssued: true, verifyBlockedUntil: state.lock ? "2026-11-06T03:05:00.000Z" : null, canManage: manager && q.get("deny") !== "1", ...(manager && q.get("deny") !== "1" ? { dealers: state.dealers } : {}) };
  if (p.action === "setAccessCode") { if (window.__failCode) fail("functions/permission-denied", "この施設の管理者・副管理者のみ操作できます"); state.set = true; state.lock = false; state.updatedAt = "2026-11-05T01:00:00.000Z"; return { ok: true }; }
  if (p.action === "getEntryQr" || p.action === "rotateEntryQr") { if (p.action === "rotateEntryQr") state.gen += 1; return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" data-gen="' + state.gen + '"><script>window.__evil = true</scr' + 'ipt><rect width="10" height="10"/></svg>' }; }
  if (p.action === "setDealerShare") { if (window.__failShare) fail("functions/failed-precondition", "このディーラーは写真を共有できません"); state.dealers.find(d => d.localDealerId === p.localDealerId).shared = p.shared; return { ok: true, shared: p.shared }; }
  throw new Error("unknown " + p.action);
};
const portal = (name) => async (a) => { window.__portalCalls.push([name, a]); return name === "facilityStatus" ? { portalEnabled: true, dealers: [] } : { ok: true }; };
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
        assert.equal(await section(page).locator('[data-f="codeStatus"]').innerText(), "設定済み(2026/11/03 変更)");
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
      assert.ok(box.includes("IOLシール写真のQRコード") && box.includes("A眼科"));
      assert.ok(!/https?:|sticker\.html/.test(box), "URL は文字で出さない");
      assert.ok((await page.locator(".sticker-qr-dialog img").getAttribute("src")).startsWith("data:image/svg+xml"));
      assert.equal(await page.evaluate(() => window.__evil === undefined), true, "SVG の中のスクリプトは動かない");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".sticker-qr-dialog").count(), 0);
      await page.close();
    } finally { await browser.close(); }
  });
}

test("アクセスコード: 変更は確認の後に保存し、新しいコードを1回だけ出す。閉じると消える", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await openPage(browser);
    await ready(page);
    const s = section(page);
    assert.equal(await s.locator('[data-f="codeForm"]').isVisible(), false);
    await s.locator('[data-act="editCode"]').click();
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
    await s.locator('[data-f="newCodeBox"]').waitFor();
    assert.equal(await s.locator('[data-f="newCode"]').innerText(), "654321");
    assert.equal(await s.locator('[data-f="codeForm"]').isVisible(), false);
    assert.equal(await s.locator('[data-f="code"]').inputValue(), "", "入力欄に残さない");
    assert.equal(await s.locator('[data-f="codeStatus"]').innerText(), "設定済み(2026/11/05 変更)");
    assert.deepEqual(await page.evaluate(() => [localStorage.length ? JSON.stringify({ ...localStorage }).includes("654321") : false, sessionStorage.length]), [false, 0], "端末に保存しない");
    await s.locator('[data-act="hideNewCode"]').click();
    assert.equal(await s.locator('[data-f="newCode"]').innerText({ timeout: 1000 }).catch(() => ""), "");
    await page.close();
  } finally { await browser.close(); }
});

test("アクセスコード: 未設定なら確認なしで設定でき、自動で作れる。失敗は理由を出す。画面を閉じると新しいコードは消える", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await openPage(browser, "?code=unset");
    await ready(page);
    const s = section(page);
    assert.equal(await s.locator('[data-f="codeStatus"]').innerText(), "未設定");
    assert.equal(await s.locator('[data-act="editCode"]').innerText(), "設定");
    await s.locator('[data-act="editCode"]').click();
    await s.locator('[data-act="generateCode"]').click();
    const code = await s.locator('[data-f="code"]').inputValue();
    assert.match(code, /^\d{8}$/);
    await page.evaluate(() => { window.__failCode = true; });
    await s.locator('[data-act="saveCode"]').click();
    await page.waitForFunction(() => document.querySelector('[data-err="code"]').textContent.includes("管理者"));
    assert.equal(await s.locator('[data-f="code"]').inputValue(), code, "失敗したら入力を残す");
    await page.evaluate(() => { window.__failCode = false; });
    await s.locator('[data-act="saveCode"]').click();
    await s.locator('[data-f="newCodeBox"]').waitFor();
    assert.equal(await page.locator(".confirm-dialog").count(), 0);
    assert.deepEqual((await page.evaluate(() => window.__calls)).filter(c => c.action === "setAccessCode").at(-1), { action: "setAccessCode", facilityId: "fA", code });
    await page.evaluate(() => window.__settings.close());
    assert.equal(await page.evaluate(() => document.querySelector('[data-f="newCode"]').textContent), "");
    await page.close();
  } finally { await browser.close(); }
});

test("QR: 作り直しは確認の後に行い、新しい QR を出す。取り消せる", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const page = await openPage(browser);
    await ready(page);
    const s = section(page);
    await s.locator('[data-act="rotateQr"]').click();
    await confirmDialog(page, "cancel");
    assert.equal((await page.evaluate(() => window.__calls)).some(c => c.action === "rotateEntryQr"), false);
    await s.locator('[data-act="rotateQr"]').click();
    assert.match(await page.locator(".confirm-dialog-message").innerText(), /使えなくなります/);
    await confirmDialog(page, "ok");
    await page.waitForSelector(".sticker-qr-dialog");
    assert.ok(decodeURIComponent(await page.locator(".sticker-qr-dialog img").getAttribute("src")).includes('data-gen="1"'));
    await page.click('.sticker-qr-dialog [data-act="close"]');
    await page.close();
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

const SETTERS = ["setAccessCode", "rotateEntryQr", "setDealerShare", "delete"];
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
        assert.equal(await s.locator('[data-f="codeStatus"]').innerText(), "設定済み(2026/11/03 変更)");
        // 出すもの
        for (const act of ["showQr", "printSheet", "printQr"]) assert.equal(await s.locator(`[data-act="${act}"]`).isVisible(), true, act);
        // 出さないもの
        for (const sel of ['[data-act="editCode"]', '[data-act="rotateQr"]', '[data-f="codeForm"]', '[data-f="newCodeBox"]', '[data-f="shareHead"]', '[data-f="dealers"]'])
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
        assert.deepEqual(await page.locator(".sticker-qr-dialog [data-act]").evaluateAll(l => l.map(b => b.getAttribute("data-act"))), ["printSheet", "printQr", "close"]);
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
      await section(page).locator('[data-act="printSheet"]').click();
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
    for (const sel of ['[data-act="editCode"]', '[data-act="rotateQr"]', '[data-f="shareHead"]']) assert.equal(await section(page).locator(sel).isVisible(), false, sel);
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
    for (const sel of ['[data-act="editCode"]', '[data-act="rotateQr"]', '[data-f="shareHead"]', '[data-dealer="dA"]']) assert.equal(await s.locator(sel).isVisible(), true, sel);
    await page.close();
    const denied = await openPage(browser, "?role=admin&deny=1");
    await ready(denied);
    for (const sel of ['[data-act="editCode"]', '[data-act="rotateQr"]', '[data-f="shareHead"]', '[data-f="dealers"]']) assert.equal(await section(denied).locator(sel).isVisible(), false, sel);
    assert.equal(await section(denied).locator('[data-act="showQr"]').isVisible(), true);
    assert.deepEqual(denied.errors, []);
    await denied.close();
  } finally { await browser.close(); }
});
