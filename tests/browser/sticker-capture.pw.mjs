// 回帰テスト(ブラウザ): 看護師の撮影画面(sticker.html)。仮想カメラで撮り、Functions の応答は偽物に差し替える
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const FN = "https://asia-northeast1-medconf-iol-dev.cloudfunctions.net/";

let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
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

const LAUNCH = {
  chromium: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  firefox: { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true, "permissions.default.camera": 1 } }
};
async function launch(type, name) {
  for (const opts of name === "chromium" ? [{}, { channel: "msedge" }, { channel: "chrome" }] : [{}]) {
    try { return await type.launch({ ...LAUNCH[name], ...opts }); } catch { /* 次の候補へ */ }
  }
  return null;
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };

/** 偽の Functions。server.uploads に受け取ったヘッダーを残す */
async function fakeFunctions(page, over = {}) {
  const s = { verifies: [], uploads: [], uploadReplies: over.uploadReplies || [], verifyReplies: over.verifyReplies || [], last: over.last || { lastSentAt: null, lastSurgeryDate: null } };
  const json = (route, status, body) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });
  await page.route(`${FN}**`, async (route) => {
    const r = route.request();
    if (r.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (r.url().endsWith("/stickerEntryApi")) {
      s.verifies.push(JSON.parse(r.postData()).data);
      const next = s.verifyReplies.shift();
      if (next) return json(route, next.status, next.body);
      return json(route, 200, { result: { ticket: `ticket-${s.verifies.length}`, expiresAt: Date.now() + 1800000, facilityName: "立川病院", ...s.last } });
    }
    s.uploads.push({ headers: r.headers(), size: (r.postDataBuffer() || Buffer.alloc(0)).length, bytes: r.postDataBuffer() });
    const next = s.uploadReplies.shift();
    if (next) return json(route, next.status, next.body);
    return json(route, 200, { photoId: "p", created: true, seq: s.uploads.length, takenAt: new Date().toISOString(), lastSurgeryDate: r.headers()["x-last-surgery-date"] || null });
  });
  return s;
}
async function openPage(browser, name, over, hash = `#f=${TOKEN}`) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...(name === "chromium" ? { permissions: ["camera"] } : {}) });
  const page = await context.newPage();
  page.errors = []; page.urls = [];
  page.on("pageerror", e => page.errors.push(String(e)));
  page.on("request", r => page.urls.push(r.url()));
  const fake = await fakeFunctions(page, over);
  await page.goto(`${base}sticker.html${hash}`);
  return { page, context, fake };
}
const screen = (page, name) => page.locator(`[data-screen="${name}"]`);
async function enterCode(page, code = "123456") {
  await page.fill('[data-f="code"]', code);
  await page.click('[data-act="verify"]');
}
async function shoot(page) {
  await page.waitForFunction(() => { const v = document.querySelector('[data-f="video"]'); return v && v.videoWidth > 0; });
  await page.click('[data-act="shutter"]');
  await screen(page, "review").waitFor();
  await page.waitForFunction(() => document.querySelector('[data-f="preview"]').naturalWidth > 0);
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox]]) {
  test(`撮影画面: コード → 撮影 → プレビュー → 送信 → 続けて撮影 → 終了: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      const { page, fake } = await openPage(browser, name, { last: { lastSentAt: "2026-11-04T01:35:00.000Z", lastSurgeryDate: "2026-11-04" } });
      await screen(page, "code").waitFor();
      assert.equal(await page.locator('[data-f="facility"]').isVisible(), false, "確認の前は施設名を出さない");
      assert.equal(await page.locator('[data-f="lastSent"]').isVisible(), false);
      await enterCode(page);
      await screen(page, "camera").waitFor();
      assert.deepEqual(fake.verifies, [{ token: TOKEN, code: "123456" }]);
      assert.equal(await page.innerText('[data-f="facility"]'), "立川病院");
      assert.match(await page.innerText('[data-f="lastSent"]'), /最終送信 11\/4\(水\) 10:35 ・ 11月4日の手術分まで/);
      await shoot(page);
      assert.equal(await page.isVisible('[data-f="dateRow"]'), true);
      assert.equal(await page.inputValue('[data-f="surgeryDate"]'), "", "既定は空");
      await page.fill('[data-f="surgeryDate"]', "2026-11-04");
      await page.click('[data-act="send"]');
      await screen(page, "done").waitFor();
      assert.match(await page.innerText('[data-f="doneDetail"]'), /この回 1枚目/);
      const up = fake.uploads[0];
      assert.equal(up.headers["x-sticker-ticket"], "ticket-1");
      assert.match(up.headers["x-upload-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.match(up.headers["x-content-sha256"], /^[0-9a-f]{64}$/);
      assert.equal(up.headers["x-last-surgery-date"], "2026-11-04");
      assert.deepEqual([up.bytes[0], up.bytes[1]], [0xff, 0xd8], "JPEG");
      await page.click('[data-act="again"]');
      await shoot(page);
      assert.equal(await page.isVisible('[data-f="dateRow"]'), false, "2枚目以降は変更できない");
      assert.match(await page.innerText('[data-f="dateFixed"]'), /今回の最終手術日 11\/4/);
      await page.click('[data-act="send"]');
      await page.waitForFunction(() => /この回 2枚目/.test(document.querySelector('[data-f="doneDetail"]').textContent));
      assert.equal(fake.verifies.length, 1, "コードを再入力しない");
      assert.notEqual(fake.uploads[0].headers["x-upload-id"], fake.uploads[1].headers["x-upload-id"]);
      await page.click('[data-act="finish"]');
      await screen(page, "code").waitFor();
      assert.equal(await page.locator('[data-f="facility"]').isVisible(), false);
      assert.equal(await page.evaluate(() => { const v = document.querySelector('[data-f="video"]'); return v.srcObject; }), null, "カメラを止める");
      assert.deepEqual(page.errors, []);
      await page.context().close();
    } finally { await browser.close(); }
  });
}

test("撮影画面: QR なしでは案内だけを出す。形式の違うトークンも同じ", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    for (const hash of ["", "#f=short"]) {
      const { page, fake } = await openPage(browser, "chromium", {}, hash);
      await screen(page, "no-token").waitFor();
      assert.match(await screen(page, "no-token").innerText(), /台紙のQRコードを読み取って開いてください/);
      assert.equal(await screen(page, "code").isVisible(), false);
      assert.equal(fake.verifies.length, 0);
      await page.context().close();
    }
  } finally { await browser.close(); }
});

test("撮影画面: Firebase SDK を読み込まず、コード・チケット・写真を端末に保存しない", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const { page, context } = await openPage(browser, "chromium");
    await enterCode(page, "246810");
    await screen(page, "camera").waitFor();
    await shoot(page);
    await page.click('[data-act="send"]');
    await screen(page, "done").waitFor();
    assert.equal(page.urls.filter(u => /gstatic|firebaseio|googleapis/.test(u)).length, 0, "Firebase SDK を読まない");
    const stored = await page.evaluate(async () => ({
      local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie,
      idb: indexedDB.databases ? (await indexedDB.databases()).length : 0, caches: (await caches.keys()).length
    }));
    assert.deepEqual(stored, { local: {}, session: {}, cookie: "", idb: 0, caches: 0 });
    assert.equal(await page.inputValue('[data-f="code"]'), "", "入力欄に残さない");
    assert.equal(page.url().includes("246810"), false);
    await context.close();
  } finally { await browser.close(); }
});

test("撮影画面: コードの誤り・停止の案内。回数の超過を区別する", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const { page, context } = await openPage(browser, "chromium", { verifyReplies: [
      { status: 403, body: { error: { status: "PERMISSION_DENIED", message: "x" } } },
      { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED", message: "x" } } }] });
    await enterCode(page, "999999");
    await page.waitForFunction(() => document.querySelector('[data-f="error"]').textContent === "コードが違います");
    await enterCode(page, "999999");
    await page.waitForFunction(() => document.querySelector('[data-f="error"]').textContent === "しばらくしてからお試しください。続くときは、施設の管理者にお知らせください");
    assert.equal(await screen(page, "code").isVisible(), true);
    await context.close();
  } finally { await browser.close(); }
});

test("撮影画面: 撮り直すと新しいアップロードID。401 は写真を残してコード入力へ戻り、同じIDで自動で再送する", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const { page, context, fake } = await openPage(browser, "chromium", { uploadReplies: [{ status: 401, body: { error: "ticket" } }] });
    await enterCode(page);
    await shoot(page);
    await page.click('[data-act="retake"]');
    await screen(page, "camera").waitFor();
    await shoot(page);
    await page.fill('[data-f="surgeryDate"]', "2026-11-03");
    await page.click('[data-act="send"]');
    await screen(page, "code").waitFor();
    assert.match(await page.innerText('[data-f="notice"]'), /もう一度コードを入力してください/);
    await enterCode(page);
    await screen(page, "done").waitFor();
    assert.equal(fake.uploads.length, 2);
    assert.equal(fake.uploads[0].headers["x-upload-id"], fake.uploads[1].headers["x-upload-id"]);
    assert.deepEqual(fake.uploads.map(u => u.headers["x-sticker-ticket"]), ["ticket-1", "ticket-2"]);
    assert.equal(fake.uploads[1].headers["x-last-surgery-date"], "2026-11-03");
    await context.close();
  } finally { await browser.close(); }
});

test("撮影画面: 送信の失敗は写真を残して [再送信] を出し、同じIDで送れる。上限は理由を出す", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const down = { status: 503, body: { error: "unavailable" } };
    const { page, context, fake } = await openPage(browser, "chromium", { uploadReplies: [down, down, down, down, { status: 429, body: { error: "limit", message: "送信の上限に達しました。時間をおいてお試しください" } }] });
    await enterCode(page);
    await shoot(page);
    await page.click('[data-act="send"]');
    assert.equal(await page.innerText('[data-act="send"]'), "送信中…");
    await page.waitForFunction(() => document.querySelector('[data-act="send"]').textContent === "再送信", null, { timeout: 15000 });
    assert.equal(fake.uploads.length, 4, "自動で3回再送する");
    assert.match(await page.innerText('[data-f="error"]'), /送信できませんでした/);
    assert.equal(await page.isVisible('[data-f="preview"]'), true);
    await page.click('[data-act="send"]');
    await page.waitForFunction(() => document.querySelector('[data-f="error"]').textContent.includes("上限"));
    assert.equal(new Set(fake.uploads.map(u => u.headers["x-upload-id"])).size, 1);
    await context.close();
  } finally { await browser.close(); }
});

test("撮影画面: 未来の日付は送らない。ピンぼけの疑いの印を送る(単色の画像)。カメラが使えないときはファイル選択に切り替える", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const { page, context, fake } = await openPage(browser, "chromium");
    await enterCode(page);
    await shoot(page);
    await page.evaluate(() => { const i = document.querySelector('[data-f="surgeryDate"]'); i.value = "2099-01-01"; i.dispatchEvent(new Event("change")); });
    await page.click('[data-act="send"]');
    await page.waitForFunction(() => document.querySelector('[data-f="error"]').textContent === "未来の日付は選べません");
    assert.equal(fake.uploads.length, 0);
    assert.equal(await page.getAttribute('[data-f="surgeryDate"]', "max"), await page.evaluate(() => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)));
    await context.close();

    const noCam = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p2 = await noCam.newPage();
    await p2.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new Error("denied"); }; });
    const fake2 = await fakeFunctions(p2);
    await p2.goto(`${base}sticker.html#f=${TOKEN}`);
    await enterCode(p2);
    await p2.waitForFunction(() => document.querySelector('[data-f="cameraNote"]').textContent === "カメラを起動できません");
    assert.equal(await p2.isVisible('[data-act="file"]'), true);
    assert.equal(await p2.isVisible('[data-act="shutter"]'), false);
    // 単色の PNG をファイル選択で渡す: 描き直して JPEG にし、鮮鋭度が低いので警告が出る
    const png = await p2.evaluate(async () => { const c = document.createElement("canvas"); c.width = 400; c.height = 300; const g = c.getContext("2d"); g.fillStyle = "#888"; g.fillRect(0, 0, 400, 300); const b = await new Promise(r => c.toBlob(r, "image/png")); return [...new Uint8Array(await b.arrayBuffer())]; });
    await p2.setInputFiles('[data-f="file"]', { name: "a.png", mimeType: "image/png", buffer: Buffer.from(png) });
    await screen(p2, "review").waitFor();
    assert.equal(await p2.isVisible('[data-f="warnBlur"]'), true);
    assert.equal(await p2.isVisible('[data-f="warnLow"]'), true, "解像度が低い注意");
    await p2.click('[data-act="send"]');
    await screen(p2, "done").waitFor();
    assert.equal(fake2.uploads[0].headers["x-blur-warned"], "1");
    assert.deepEqual([fake2.uploads[0].bytes[0], fake2.uploads[0].bytes[1]], [0xff, 0xd8], "JPEG に描き直す");
    await noCam.close();
  } finally { await browser.close(); }
});

test("sticker.html: 検索エンジンに載せず、参照元を送らない", () => {
  const html = fs.readFileSync(path.join(ROOT, "sticker.html"), "utf8");
  assert.match(html, /name="robots" content="noindex, nofollow"/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.ok(!/firebase|gstatic/i.test(html.replace(/<script type="importmap">[\s\S]*?<\/script>/, "").replace(/<!--[\s\S]*?-->/g, "")));
});
