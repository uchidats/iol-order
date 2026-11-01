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
import { renderRelatedLinks } from "./src/ui/related-links.js";
renderRelatedLinks([]);
import { initOrderForm } from "./src/ui/order-form.js";
import { deriveOrderId } from "./src/domain/pending-order.js";
import { IOL_MODELS } from "./src/data/iol-models.js";
const srv = () => JSON.parse(localStorage.getItem("__srv") || '{"orders":{},"calls":[],"mode":"ok"}');
const put = (s) => localStorage.setItem("__srv", JSON.stringify(s));
const repository = {
  listAdoptedIols: async () => IOL_MODELS.map(m => ({ id: m.id, catalogIolId: m.id, enabled: true })),
  // multi: 担当医・発注先を2つずつ(複数レンズの復元の確認用。既定は従来どおり1つずつ)
  listOrderers: async () => [{ id: "o1", name: "山田" }, ...(srv().multi ? [{ id: "o2", name: "佐藤" }] : [])],
  listDealers: async () => [{ id: "d1", name: "A商会", orderEmails: ["a@example.jp"] }, ...(srv().multi ? [{ id: "d2", name: "B医療", orderEmails: ["b@example.jp"] }] : [])],
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
  // 取消可能な時間(サーバーが返す期限と現在時刻)。cancelWindowMs を指定したときだけ返す(既定は従来どおり返さない)
  const t = Date.now();
  return { orderId: id, orderNumber: s.orders[id].orderNumber, status: "accepted", replayed, ...(s.cancelWindowMs ? { cancelUntilMs: t + s.cancelWindowMs, serverNowMs: t } : {}) };
},
async cancelOrder(req) {
  const s = srv();
  (s.cancels = s.cancels || []).push(req);
  put(s);
  if (s.cancelMode === "late") throw Object.assign(new Error("取り消せる時間を過ぎたため、取り消せませんでした"), { code: "functions/failed-precondition", details: { reason: "too-late" } });
  if (s.cancelMode === "network") throw Object.assign(new Error("timeout"), { code: "functions/deadline-exceeded" });
  s.orders[req.orderId] = { ...s.orders[req.orderId], status: "cancelled", cancelled: true };
  put(s);
  return { orderId: req.orderId, cancelled: true, alreadyCancelled: false };
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
        assert.equal(edges[3][1] - edges[3][0], Math.min(200, edges[0][1] - edges[0][0]), `${name} ${width}px: ボタンの幅は200px(狭い画面では画面幅まで)`);
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
      // WebKit/Firefox のネイティブ日付入力は、フォーカス移動時の change で前のエラーを消す。
      // submit より先に blur/change を完了させ、検証後のエラーを遅い change が消す競合を避ける
      const setDate = async (d) => { await date.fill(d); await date.blur(); await page.waitForFunction((v) => document.querySelector(".lens-line [data-f=date]").value === v && document.querySelector('.lens-line [data-err="date"]').textContent === "", d); };
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

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`注文完了画面の「取り消す」: 取消可能な間だけ表示して自動で消える(カウントダウンなし)。成功で「注文を取り消しました」、期限後・通信の失敗は明確に表示。再送の受付済みには出さない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      const setSrv = (page, patch) => page.evaluate((p) => { const s = JSON.parse(localStorage.getItem("__srv") || '{"orders":{},"calls":[]}'); Object.assign(s, p); localStorage.setItem("__srv", JSON.stringify(s)); }, patch);
      const submit = async (page, notes, power) => {
        await fillOrder(page, notes);
        await page.locator(".lens-line").first().locator("[data-f=power]").selectOption(power);   // 過去の注文との重複にしない
        await page.click("#btnConfirm");
        await page.waitForFunction(() => !document.getElementById("confirmModal").classList.contains("hidden"));
        await page.click("#btnModalSubmit");
        await page.waitForFunction(() => !document.getElementById("completeModal").classList.contains("hidden"));
      };
      const { page, errors } = await open(browser);
      // 1) 取消可能な時間(短く 1.5 秒)を過ぎると、ボタンは自動で消える。カウントダウン・残り秒数は出さない
      await setSrv(page, { mode: "ok", cancelWindowMs: 1500, real: true });
      await submit(page, "自動で消える", "+20.0D");
      const btn = page.locator("#completeModal #btnCancelOrder");
      assert.equal(await btn.innerText(), "取り消す");
      assert.ok(!/d+s*秒|残り/.test(await page.locator("#completeModal").innerText()), "残り秒数を出さない");
      assert.equal(await page.locator("#completeModal progress, #completeModal [role=progressbar]").count(), 0, "プログレスバーを出さない");
      assert.equal(await page.locator("#completeModal #btnNewOrder").isVisible(), true, "既存のボタンはそのまま");
      await btn.waitFor({ state: "detached", timeout: 5000 });
      assert.equal(await page.locator("#completeTitle").innerText(), "注文を受け付けました");
      await page.click("#btnNewOrder");
      // 2) 取消可能な間に押す: 取り消せたら「注文を取り消しました」と知らせ、送信した内容のまま注文入力画面へ戻る(完了画面は閉じる)
      await setSrv(page, { cancelWindowMs: 10000 });
      await submit(page, "取り消す", "+20.5D");
      await btn.click();
      await page.waitForFunction(() => document.getElementById("completeModal").classList.contains("hidden"));
      await page.getByText("注文を取り消しました。内容を修正して、もう一度送信できます").waitFor();
      assert.deepEqual([await page.locator("#notesInput").inputValue(), await page.locator(".lens-line [data-f=power]").first().inputValue()], ["取り消す", "+20.5D"]);
      const s1 = await srv(page);
      assert.deepEqual(Object.keys(s1.cancels.at(-1)).sort(), ["facilityId", "orderId"]);
      assert.equal(s1.cancels.at(-1).facilityId, "f1");
      // 3) 期限の後に届いた(サーバーが拒否): 取り消せなかったことを明確に表示。完了の表示はそのまま
      await setSrv(page, { cancelMode: "late" });
      await submit(page, "期限の後", "+21.0D");
      await btn.click();
      await page.locator("#completeCancelMsg").waitFor();
      assert.match(await page.locator("#completeCancelMsg").innerText(), /^取り消せませんでした。取り消せる時間を過ぎたため、注文は受け付けられ、ディーラーへ送信されます。/);
      assert.equal(await page.locator("#completeTitle").innerText(), "注文を受け付けました");
      assert.equal(await btn.count(), 0);
      await page.click("#btnNewOrder");
      // 4) 通信の失敗: 取り消せたか分からないことを表示し、注文履歴での確認を案内
      await setSrv(page, { cancelMode: "network" });
      await submit(page, "通信の失敗", "+21.5D");
      await btn.click();
      await page.locator("#completeCancelMsg").waitFor();
      assert.match(await page.locator("#completeCancelMsg").innerText(), /取り消せたか確認できませんでした/);
      await page.click("#btnNewOrder");
      assert.equal(await page.locator("#completeCancelMsg").count(), 0, "次の注文には前の表示を残さない");
      // 5) 期限を返さない(旧いサーバー・再送の受付済み)ときは出さない
      await setSrv(page, { cancelWindowMs: 0, cancelMode: null });
      await submit(page, "期限なし", "+22.0D");
      assert.equal(await btn.count(), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`取り消し後の再注文: 複数レンズ(モデル・度数・枚数・手術日・担当医・発注先)と備考を送信時のまま復元し、一部を直して新しい受付番号で再注文。元の注文は取消済みで残る。取り消せなければ戻さない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません`);
    try {
      const { page, errors } = await open(browser);
      await page.evaluate(() => localStorage.setItem("__srv", JSON.stringify({ orders: {}, calls: [], mode: "ok", multi: true, real: true, cancelWindowMs: 10000 })));
      await page.reload();
      await page.waitForFunction(() => window.__ready);
      const day = (n) => new Date(Date.now() + (9 * 3600 + n * 86400) * 1000).toISOString().slice(0, 10);
      // 2本のレンズ(条件をすべて変える)と備考
      const want = [
        { model: "jj-dib00v", toric: false, power: "+20.0D", quantity: "1", date: day(20), doctor: "o1", dealer: "d1" },
        { model: "jj-dib00v", toric: false, power: "+22.5D", quantity: "2", date: day(27), doctor: "o2", dealer: "d2" }];
      for (const [i, w] of want.entries()) {
        while (await page.locator(".lens-line").count() <= i) await page.click("#btnAddLine");
        const l = page.locator(".lens-line").nth(i);
        await l.locator("[data-f=model]").selectOption(w.model);
        await l.locator("[data-f=power]").selectOption(w.power);
        await l.locator(".quantity-option", { hasText: `${w.quantity} 枚` }).click();
        await l.locator("[data-f=date]").fill(w.date);
        await l.locator("[data-f=doctor]").selectOption(w.doctor);
        await l.locator("[data-f=dealer]").selectOption(w.dealer);
      }
      await page.fill("#notesInput", "元の備考\n2行目");
      const read = () => page.evaluate(() => ({ notes: document.getElementById("notesInput").value, lines: [...document.querySelectorAll(".lens-line")].map(l => ({
        model: l.querySelector("[data-f=model]").value, toric: l.querySelector("[data-f=toric]").checked, power: l.querySelector("[data-f=power]").value,
        quantity: (l.querySelector("[data-f=quantity]:checked") || {}).value, date: l.querySelector("[data-f=date]").value,
        doctor: l.querySelector("[data-f=doctor]").value, dealer: l.querySelector("[data-f=dealer]").value })) }));
      const before = await read();
      assert.deepEqual(before, { notes: "元の備考\n2行目", lines: want });
      const send = async () => {
        await page.click("#btnConfirm");
        await page.waitForFunction(() => !document.getElementById("confirmModal").classList.contains("hidden"));
        await page.click("#btnModalSubmit");
        await page.waitForFunction(() => !document.getElementById("completeModal").classList.contains("hidden"));
      };
      await send();
      const first = (await srv(page)).calls.at(-1);
      // 取り消し(成功) → 送信時のまま入力画面へ
      await page.locator("#btnCancelOrder").click();
      await page.waitForFunction(() => document.getElementById("completeModal").classList.contains("hidden"));
      assert.deepEqual(await read(), before, "全明細・備考を送信時のまま復元");
      // 必要な箇所だけ直して、通常どおり再注文(確認画面を通る)
      await page.locator(".lens-line").nth(1).locator("[data-f=power]").selectOption("+23.0D");
      await send();
      const s = await srv(page);
      const second = s.calls.at(-1);
      assert.notEqual(second.requestId, first.requestId, "新しい注文として送る(同じ識別子で取消済みの注文を返さない)");
      assert.deepEqual(second.lines.map(l => [l.power, l.quantity, l.surgeryDate, l.doctorId, l.dealerId]),
        [["+20.0D", 1, want[0].date, "o1", "d1"], ["+23.0D", 2, want[1].date, "o2", "d2"]]);
      assert.equal(second.notes, "元の備考\n2行目");
      const list = Object.values(s.orders);
      assert.equal(list.length, 2);
      assert.deepEqual(list.map(o => o.status).sort(), ["accepted", "cancelled"], "元の注文は取消済みで残り、新しい注文が受け付けられる");
      assert.notEqual(list[0].orderNumber, list[1].orderNumber, "新しい受付番号");
      // 取り消せなかった: 完了画面のまま(入力画面へ戻さない)
      await page.evaluate(() => { const v = JSON.parse(localStorage.getItem("__srv")); v.cancelMode = "late"; localStorage.setItem("__srv", JSON.stringify(v)); });
      await page.locator("#btnCancelOrder").click();
      await page.locator("#completeCancelMsg").waitFor();
      assert.equal(await page.locator("#completeModal").evaluate(e => e.classList.contains("hidden")), false, "完了画面のまま");
      // 取り消さずに「新しい注文を入力する」: 従来どおり新規入力(1明細・空)
      await page.click("#btnNewOrder");
      const fresh = await read();
      assert.deepEqual([fresh.notes, fresh.lines.length, fresh.lines[0].power], ["", 1, ""]);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
