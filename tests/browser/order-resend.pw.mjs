// 回帰テスト(ブラウザ): 二重発注の防止(受付結果が未確定の注文の requestId を保存・照会・再利用)と、完了画面はサーバーが保存した内容で表示する。
// 実際の index.html・styles.css・src/ui/order-form.js を、偽のリポジトリと偽の受付(createOrder)で動かす(ログイン・Firebase は使わない)。  npm run test:browser
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

// 偽のサーバー: 状態は localStorage("__srv")に置き、再読み込みしても残す。
// mode: "ok" = 保存して応答 / "timeout" = 保存したが応答が届かない / "lost" = 保存されず応答も届かない
const SCRIPT = `<script type="module">
import { initOrderForm } from "./src/ui/order-form.js";
import { deriveOrderId } from "./src/domain/pending-order.js";
import { IOL_MODELS } from "./src/data/iol-models.js";
const srv = () => JSON.parse(localStorage.getItem("__srv") || '{"orders":{},"calls":[],"mode":"ok"}');
const put = (s) => localStorage.setItem("__srv", JSON.stringify(s));
const repository = {
  listAdoptedIols: async () => IOL_MODELS.map(m => ({ id: m.id, catalogIolId: m.id, enabled: true })),
  listOrderers: async () => [{ id: "o1", name: "山田" }],
  listDealers: async () => [{ id: "d1", name: "A商会", orderEmails: ["a@example.jp"] }],
  listOrders: async () => Object.values(srv().orders),
  getOrder: async (fid, id) => srv().orders[id] || null
};
const orderApi = { async createOrder(req) {
  const s = srv();
  s.calls.push(req);
  const id = await deriveOrderId("u1", req.requestId);
  const replayed = Boolean(s.orders[id]);
  if (!replayed && s.mode !== "lost") {
    s.orders[id] = { id, orderNumber: "IOL-20991231-000" + (Object.keys(s.orders).length + 1), status: "accepted", testOrder: s.real !== true, notes: req.notes || "", createdAt: Date.now(),
      lines: req.lines.map((l, i) => ({ lineNo: i + 1, surgeryDate: l.surgeryDate,
        item: { modelId: l.modelId, toricModel: l.toricModel || "", manufacturer: "J&J", model: "DIB00V", displayName: "J&J / DIB00V", power: l.power, quantity: l.quantity },
        doctor: { id: l.doctorId, name: "山田(保存値)" }, dealer: { id: l.dealerId, name: "A商会(保存値)" } })) };
  }
  put(s);
  if (s.mode !== "ok") throw Object.assign(new Error("timeout"), { code: "functions/deadline-exceeded" });
  return { orderId: id, orderNumber: s.orders[id].orderNumber, status: "accepted", replayed };
} };
await initOrderForm({ config: { orderMode: "server-dev" }, repository, facilityId: "f1", facility: { id: "f1", name: "テスト施設" }, orderApi,
  user: { uid: "u1", email: "u1@example.jp", emailVerified: true } });
window.__ready = true;
</script>`;
const PAGE = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
  .replace(/<script src="https:\/\/cdn[^"]*"><\/script>/, "")
  .replace(/<script type="module" src="src\/main\.js[^"]*"><\/script>/, SCRIPT);

let server, base;
test.before(async () => {
  assert.ok(PAGE.includes("initOrderForm"), "index.html の main.js を差し替えられること");
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

const srv = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("__srv") || '{"orders":{},"calls":[]}'));
const setMode = (page, mode) => page.evaluate((m) => { const s = JSON.parse(localStorage.getItem("__srv") || '{"orders":{},"calls":[]}'); s.mode = m; localStorage.setItem("__srv", JSON.stringify(s)); }, mode);

async function open(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(base);
  await page.waitForFunction(() => window.__ready);
  return { page, errors };
}

async function fillOrder(page, notes) {
  const line = page.locator(".lens-line").first();
  await line.locator("[data-f=model]").selectOption("jj-dib00v");
  await line.locator("[data-f=power]").selectOption("+20.0D");
  await line.locator("[data-f=date]").fill(new Date(Date.now() + (9 * 3600 + 30 * 86400) * 1000).toISOString().slice(0, 10));   // 日本時間の30日後(1年以内)
  await line.locator("[data-f=doctor]").selectOption("o1");
  await page.fill("#notesInput", notes);
}

const visible = (page, sel) => page.locator(sel).evaluate(e => !e.classList.contains("hidden"));

test("横幅: 備考の入力欄と各社Calculator関連リンクの外枠は、「レンズ1」の外枠と左右端がそろう。「注文内容を確認」は右端にそろう(PC・スマートフォン)", async (t) => {
  for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
    const browser = await launch(type, name);
    if (!browser) { t.diagnostic(`${name} を起動できません`); continue; }
    try {
      for (const width of [1280, 768, 390, 360]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.goto(base);
        await page.waitForFunction(() => window.__ready);
        const edges = await page.evaluate(() => ["#lensLines .lens-line", "#notesInput", "#groupNotes .ref-links-accordion", "#btnConfirm"].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left, r.right]; }));
        assert.deepEqual(edges[1], edges[0], `${name} ${width}px: 備考の入力欄`);
        assert.deepEqual(edges[2], edges[0], `${name} ${width}px: 各社Calculator関連リンク`);
        assert.equal(edges[3][1], edges[0][1], `${name} ${width}px: 「注文内容を確認」は右揃え(右端がそろう)`);
        assert.equal(edges[3][1] - edges[3][0], Math.min(240, edges[0][1] - edges[0][0]), `${name} ${width}px: ボタンの幅は変えない`);
        await page.close();
      }
    } finally { await browser.close(); }
  }
});

/** n 番目のレンズを入力する(同じ条件のレンズを複数入力するため) */
async function fillLine(page, n, quantity) {
  while (await page.locator(".lens-line").count() <= n) await page.click("#btnAddLine");
  const line = page.locator(".lens-line").nth(n);
  await line.locator("[data-f=model]").selectOption("jj-dib00v");
  await line.locator("[data-f=power]").selectOption("+20.0D");
  await line.locator("[data-f=date]").fill(new Date(Date.now() + (9 * 3600 + 30 * 86400) * 1000).toISOString().slice(0, 10));
  await line.locator("[data-f=doctor]").selectOption("o1");
  await line.locator(".quantity-option", { hasText: `${quantity} 枚` }).click();
}

test("同じ注文の中の重複: 入力の誤りにせず、確認画面で警告と「重複を確認しました」。チェックしないと送信できない。了承して注文でき、過去の注文との重複と同時でも扱える: chromium", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const { page, errors } = await open(browser);
    // 本番の注文として保存する(テスト注文は過去の注文との重複確認の対象外のため)
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem("__srv") || '{"orders":{},"calls":[]}'); s.mode = "ok"; s.real = true; localStorage.setItem("__srv", JSON.stringify(s)); });
    await fillLine(page, 0, 2);
    await fillLine(page, 1, 2);   // レンズ1が2枚、レンズ2も同じ条件で2枚(合計4枚)
    const confirm = async () => { await page.click("#btnConfirm"); await page.waitForFunction(() => !document.getElementById("confirmModal").classList.contains("hidden")); };
    await confirm();
    assert.equal(await page.locator(".lens-line .error-message:not(:empty)").count(), 0, "入力の誤りにしない");
    assert.equal(await page.locator("#dupAckBox").isVisible(), true);
    assert.match(await page.locator("#dupAckText").innerText(), /同じ手術日・担当医・IOLモデル・度数のレンズが複数あります（レンズ1・レンズ2）/);
    assert.equal(await page.locator("#dupAckCheck").isChecked(), false);
    assert.equal(await page.locator("#btnModalSubmit").isDisabled(), true, "チェックしないと送信できない");
    assert.match(await page.locator("#summaryTotal").innerText(), /2件・合計4枚/);
    // チェックせずに戻れる。チェックしてから戻って確認し直すと、もう一度チェックが必要
    await page.locator("#dupAckCheck").check();
    assert.equal(await page.locator("#btnModalSubmit").isDisabled(), false);
    await page.click("#btnModalBack");
    assert.equal(await page.locator("#confirmModal").evaluate(e => e.classList.contains("hidden")), true);
    await confirm();
    assert.deepEqual([await page.locator("#dupAckCheck").isChecked(), await page.locator("#btnModalSubmit").isDisabled()], [false, true]);
    // 了承して送信 → 了承を付けて、明細・枚数はそのまま送る
    await page.locator("#dupAckCheck").check();
    await page.click("#btnModalSubmit");
    await page.waitForFunction(() => !document.getElementById("completeModal").classList.contains("hidden"));
    let s = await srv(page);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].duplicateAcknowledged, true);
    assert.deepEqual(s.calls[0].lines.map(l => [l.modelId, l.power, l.quantity]), [["jj-dib00v", "+20.0D", 2], ["jj-dib00v", "+20.0D", 2]]);
    assert.match(await page.locator("#completeDetails").innerText(), /2件・合計4枚/);

    // 同じ内容でもう一度(追加注文): 過去の注文との重複の警告 → 確認して続行 → 同じ注文の中の重複も確認して送信できる
    await page.click("#btnNewOrder");
    await fillLine(page, 0, 2);
    await fillLine(page, 1, 2);
    await page.click("#btnConfirm");
    await page.waitForFunction(() => !document.getElementById("duplicateModal").classList.contains("hidden"));
    await page.click("#btnDupContinue");
    await page.waitForFunction(() => !document.getElementById("confirmModal").classList.contains("hidden"));
    assert.equal(await page.locator("#btnModalSubmit").isDisabled(), true);
    await page.locator("#dupAckCheck").check();
    await page.click("#btnModalSubmit");
    await page.waitForFunction(() => !document.getElementById("completeModal").classList.contains("hidden"));
    s = await srv(page);
    assert.equal(s.calls.length, 2);
    assert.equal(Object.keys(s.orders).length, 2, "確認すれば同じ条件の追加注文もできる");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("完了画面: 本番の注文(testOrder: false)は「開発用」と出さず、ディーラーへ送信することと注文履歴での確認を案内する: chromium", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const { page, errors } = await open(browser);
    assert.equal(await page.locator("#systemBadge").isVisible(), true, "開発用(server-dev)ではモード表示を出す");
    assert.equal(await page.locator("#systemBadge").innerText(), "開発用受付");
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem("__srv") || '{"orders":{},"calls":[]}'); s.mode = "ok"; s.real = true; localStorage.setItem("__srv", JSON.stringify(s)); });
    await fillOrder(page, "本番");
    await page.click("#btnConfirm");
    await page.waitForFunction(() => !document.getElementById("confirmModal").classList.contains("hidden"));
    // 「注文を送信」の紙飛行機アイコンは文字の右(「注文内容を確認 →」とそろえる)。送信後に戻したボタンも同じ
    const iconAfterText = () => page.locator("#btnModalSubmit").evaluate(b => { const t = [...b.childNodes].find(n => n.nodeType === 3 && n.textContent.trim()); const s = b.querySelector("svg"); return t.textContent.trim() === "注文を送信" && Boolean(t.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING); });
    assert.equal(await iconAfterText(), true);
    assert.equal(await page.locator("#dupAckBox").isVisible(), false, "重複がなければ確認のチェックは出さない");
    assert.equal(await page.locator("#btnModalSubmit").isDisabled(), false);
    await page.click("#btnModalSubmit");
    await page.waitForFunction(() => !document.getElementById("completeModal").classList.contains("hidden"));
    assert.equal(await iconAfterText(), true, "送信後に戻したボタン");
    assert.equal(await page.locator("#completeTitle").innerText(), "注文を受け付けました");
    assert.match(await page.locator("#completeSubtitle").innerText(), /ディーラーへ注文メールを送信します[\s\S]*注文履歴で確認/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`二重発注の防止: 受付後に応答が届かず、再読み込みして同じ内容で進む → 新しく送らず、保存済みの注文を完了画面に出す: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const { page, errors } = await open(browser);
      await setMode(page, "timeout");
      await fillOrder(page, "備考A");
      await page.click("#btnConfirm");
      await page.waitForFunction(() => !document.getElementById("confirmModal").classList.contains("hidden"));
      await page.click("#btnModalSubmit");
      await page.waitForFunction(() => !document.getElementById("modalSubmitError").classList.contains("hidden"));
      assert.match(await page.locator("#modalSubmitErrorText").innerText(), /受付結果を確認できませんでした.*同じ内容のまま再送信した場合は、同じ注文として扱われます/);
      let s = await srv(page);
      assert.equal(s.calls.length, 1);
      assert.equal(s.calls[0].lines[0].dealerId, "d1", "1社の自動選択でも、確認した発注先のIDを送る");
      assert.equal(Object.keys(s.orders).length, 1, "サーバーには保存されている");

      await page.waitForTimeout(600);   // 下書きの自動保存(400ms後)
      await page.reload();
      await page.waitForFunction(() => window.__ready);
      await setMode(page, "ok");
      await page.click("#btnConfirm");
      await page.waitForFunction(() => !document.getElementById("completeModal").classList.contains("hidden"));
      assert.equal(await page.locator("#completeTitle").innerText(), "この注文は受け付け済みです（開発用）");
      const details = await page.locator("#completeDetails").innerText();
      assert.match(details, /IOL-20991231-0001/);
      assert.match(details, /担当医 山田\(保存値\).*発注先 A商会\(保存値\)/s, "完了画面はサーバーが保存した内容");
      assert.match(details, /備考A/);
      s = await srv(page);
      assert.equal(s.calls.length, 1, "同じ注文を再送していない");
      assert.equal(Object.keys(s.orders).length, 1, "二重に登録されていない");
      assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("iol_order_pending:")).length), 0, "未確定の記録は消える");
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test(`手術日はサーバーと同じ範囲(日本時間の本日以降・1年以内)で確認する。OCR の画面は表示しない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const { page, errors } = await open(browser);
      assert.equal(await page.locator("#ocrFeatureCard").isVisible(), false, "OCR は一時停止中");
      assert.equal(await page.locator("#ocrPatientName").count(), 0, "患者名の入力欄はない");
      const jst = (days) => new Date(Date.now() + (9 * 3600 + days * 86400) * 1000).toISOString().slice(0, 10);
      const date = page.locator(".lens-line").first().locator("[data-f=date]");
      // WebKit では日付の入力の反映が遅れることがあるため、値が入ったのを確認してから押す
      const setDate = async (d) => { await date.fill(d); await page.waitForFunction((v) => document.querySelector(".lens-line [data-f=date]").value === v, d); };
      assert.deepEqual([await date.getAttribute("min"), await date.getAttribute("max")], [jst(0), jst(366)]);
      await fillOrder(page, "");
      for (const [d, msg] of [[jst(-1), /手術日は本日以降/], [jst(367), /手術日が先すぎます/]]) {
        await setDate(d);
        await page.click("#btnConfirm");
        await page.locator(".lens-line").first().getByText(msg).waitFor({ timeout: 5000 });   // 負荷が高いときの描画の遅れを待つ(WebKit)
        assert.equal(await visible(page, "#confirmModal"), false);
      }
      await setDate(jst(366));
      await page.click("#btnConfirm");
      await page.waitForFunction(() => !document.getElementById("confirmModal").classList.contains("hidden"));
      assert.equal((await srv(page)).calls.length, 0, "確認画面までは送信しない");
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test(`二重発注の防止: 保存されずに応答が届かず、戻って同じ内容で送り直す → 同じ requestId で送り、1件だけ登録される: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const { page, errors } = await open(browser);
      await setMode(page, "lost");
      await fillOrder(page, "備考B");
      await page.click("#btnConfirm");
      await page.waitForFunction(() => !document.getElementById("confirmModal").classList.contains("hidden"));
      await page.click("#btnModalSubmit");
      await page.waitForFunction(() => !document.getElementById("modalSubmitError").classList.contains("hidden"));
      await page.click("#btnModalBack");
      assert.equal(await visible(page, "#confirmModal"), false);
      await setMode(page, "ok");
      await page.click("#btnConfirm");   // 確認画面を開き直す(以前は新しい requestId になっていた)
      await page.waitForFunction(() => !document.getElementById("confirmModal").classList.contains("hidden"));
      await page.click("#btnModalSubmit");
      await page.waitForFunction(() => !document.getElementById("completeModal").classList.contains("hidden"));
      assert.equal(await page.locator("#completeTitle").innerText(), "注文を受け付けました（開発用）");
      const s = await srv(page);
      assert.equal(s.calls.length, 2);
      assert.equal(s.calls[1].requestId, s.calls[0].requestId, "同じ requestId で再送する");
      assert.equal(Object.keys(s.orders).length, 1);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test(`未確定の注文があり内容を変更した → 前回の受付結果を照会して知らせ、新しい requestId で進む: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const { page, errors } = await open(browser);
      await setMode(page, "timeout");
      await fillOrder(page, "備考C");
      await page.click("#btnConfirm");
      await page.waitForFunction(() => !document.getElementById("confirmModal").classList.contains("hidden"));
      await page.click("#btnModalSubmit");
      await page.waitForFunction(() => !document.getElementById("modalSubmitError").classList.contains("hidden"));
      await page.click("#btnModalBack");
      await setMode(page, "ok");
      await page.locator(".lens-line").first().locator("[data-f=power]").selectOption("+21.0D");
      await page.click("#btnConfirm");
      await page.waitForFunction(() => /受け付けられています/.test(document.getElementById("toastNotice").textContent));
      assert.match(await page.locator("#toastNotice").innerText(), /前回送信した注文（受付番号 IOL-20991231-0001）は受け付けられています/);
      await page.waitForFunction(() => !document.getElementById("confirmModal").classList.contains("hidden"));
      await page.click("#btnModalSubmit");
      await page.waitForFunction(() => !document.getElementById("completeModal").classList.contains("hidden"));
      const s = await srv(page);
      assert.notEqual(s.calls[1].requestId, s.calls[0].requestId, "内容が違う注文は新しい requestId");
      assert.equal(Object.keys(s.orders).length, 2);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
