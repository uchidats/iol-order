// 回帰テスト(ブラウザ): ディーラー専用画面(dealer.html)。実際の dealer.html・src/dealer を、偽の Firebase SDK と偽のサーバー応答で動かす。
// ログイン(メールリンク・戻り先は dealer.html)・参加の確認・所属なし・担当施設の初期選択・施設の複数選択と検索・詳細・
// 表示は文字として扱う(HTML を解釈しない)・注文のデータを端末に保存しない・スマートフォン/PC。  npm run test:browser
// 権限・明細の分離そのものは、サーバーのテスト(tests/functions/dealer-portal.test.js)で確認する。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";
import { newFakeContext } from "./fake-firebase.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
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

const STAFF = { user: { uid: "x1", email: "x1@corp.example.jp", emailVerified: true, displayName: "担当x1" }, db: {} };

/** 偽のサーバー(dealerPortalApi)。scenario: "staff" / "invited" / "none" */
function installFakeServer(page, scenario) {
  return page.addInitScript((scenario) => {
    const deny = (msg) => Object.assign(new Error(msg), { code: "functions/permission-denied" });
    const facilities = [{ id: "fB", name: "B眼科", assigned: true }, { id: "fA", name: "<img src=x onerror=\"window.__xss=1\">A眼科", assigned: false }];
    const receipts = [
      { receiptId: "rcp-a", facilityId: "fA", facilityName: facilities[1].name, orderNumber: "IOL-20261027-01", orderedAt: "2026-10-27T01:00:00.000Z", lineCount: 2, totalQuantity: 3 },
      { receiptId: "rcp-b", facilityId: "fB", facilityName: "B眼科", orderNumber: "IOL-20261027-02", orderedAt: "2026-10-27T02:00:00.000Z", lineCount: 1, totalQuantity: 1 }
    ];
    let joined = scenario !== "invited";
    let msRegistered = scenario !== "msNotRegistered";
    window.__fakeCallables = {
      dealerPortalApi: async (d) => {
        // Microsoft の登録(確認コードは偽: 12345678)。未登録の Microsoft が連携された間は、参加の確認・登録以外を拒否(理由付き)
        if (d.action === "sendMicrosoftCode") { if (window.__failMsSend) { window.__failMsSend = false; throw Object.assign(new Error("確認コードを送れませんでした。しばらくしてからもう一度お試しください"), { code: "functions/failed-precondition" }); } return { ok: true, expiresInMinutes: 10 }; }
        if (d.action === "trustMicrosoft") { if (d.code !== "12345678") throw Object.assign(new Error("確認コードが違います。メールに届いたコードを入力してください"), { code: "functions/failed-precondition" }); msRegistered = true; return { ok: true }; }
        if (!msRegistered && d.action !== "invitations") throw Object.assign(new Error("Microsoft アカウントの登録が完了していません"), { code: "functions/permission-denied", details: { reason: "microsoft-unregistered" } });
        if (scenario === "disabled") throw Object.assign(new Error("ディーラー画面は現在ご利用いただけません"), { code: "functions/failed-precondition" });   // 機能の停止中: すべての取得を拒否
        // 招待の一覧に会社名は出さない(会社名は確認コードのメールに書く)。参加は、送った確認コード(偽: 12345678)の入力が必要
        if (d.action === "invitations") return { invitations: joined || scenario === "none" ? [] : [{ invitationId: "dinv-1", role: "reader" }] };
        if (d.action === "sendCode") return { ok: true, expiresInMinutes: 10 };
        if (d.action === "respond" && d.accept && d.code !== "12345678") throw Object.assign(new Error("確認コードが違います。メールに届いたコードを入力してください"), { code: "functions/failed-precondition" });
        if (d.action === "respond") { joined = d.accept; return { ok: true, accepted: d.accept }; }
        // 有効な所属だけ(所属なしは空。multi は2社)
        if (d.action === "companies") return { companies: scenario === "none" || !joined ? [] : [{ companyId: "dco-x", name: "エックス商事" }, ...(scenario === "multi" ? [{ companyId: "dco-y", name: "ワイ医療" }] : [])] };
        if (scenario === "none" || !joined) throw deny("ディーラー画面の利用登録が確認できません。運営者にお問い合わせください");
        if (d.action === "list" && window.__listOverride) return window.__listOverride(d);
        if (d.action === "context") return {
          company: d.companyId === "dco-y" ? { id: "dco-y", name: "ワイ医療" } : { id: "dco-x", name: "エックス商事" }, me: { name: "担当x1", role: "reader", branch: { id: "br-1", name: "東京支店" } },
          facilities, assignedFacilityIds: ["fB"], selectedFacilityIds: ["fB"], selection: "assigned",
          defaultRange: { from: "2026-09-28", to: "2026-10-27" }, limits: { rangeDaysMax: 366, pageMax: 100 }
        };
        if (d.action === "list") {
          const sel = new Set(d.facilityFilter.facilityIds);
          return { items: receipts.filter(r => sel.has(r.facilityId) && (!d.orderNumber || r.orderNumber === d.orderNumber)).sort((a, b) => b.orderedAt.localeCompare(a.orderedAt)), nextCursor: null, complete: true };
        }
        if (d.action === "get") return {
          receiptId: d.receiptId, facilityId: "fA", facilityName: facilities[1].name, orderNumber: "IOL-20261027-01", orderedAt: "2026-10-27T01:00:00.000Z",
          lineCount: 2, totalQuantity: 3, mail: { status: "accepted", label: "送信済み(配信サービスが受付)", at: "2026-10-27T01:01:00.000Z", delivery: null },
          lines: [
            { no: 1, manufacturer: "J&J", model: "DIB00V", toricModel: "", isToric: false, isMultifocal: false, power: "+21.0D", quantity: 2, surgeryDate: "2026-11-06", doctorName: "<b>山田</b>" },
            { no: 2, manufacturer: "J&J", model: "DIB00V", toricModel: "", isToric: false, isMultifocal: false, power: "+22.0D", quantity: 1, surgeryDate: "2026-11-07", doctorName: "山田" }]
        };
        if (d.action === "setAssignments") return { ok: true, assignedFacilityIds: d.facilityIds };
        throw new Error("unexpected " + d.action);
      }
    };
  }, scenario);
}
const calls = (page, action) => page.evaluate((a) => (window.__calls || []).filter(([n, d]) => n === "dealerPortalApi" && d.action === a).map(([, d]) => d), action);

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`ディーラー画面: 担当施設の初期選択・複数選択と検索・詳細・HTML を解釈しない・端末に保存しない。スマートフォン/PC: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const context = await newFakeContext(browser, base, width, STAFF);
        const page = await context.newPage();
        await installFakeServer(page, "staff");
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await page.goto(`${base}dealer.html`);
        await page.locator(".dealer-row").first().waitFor();
        assert.equal(await page.locator("#dealerCompany").innerText(), "エックス商事");
        // 初期表示: 担当施設(B)だけを選択して検索
        assert.deepEqual((await calls(page, "list"))[0].facilityFilter, { mode: "selected", facilityIds: ["fB"] });
        assert.deepEqual(await page.locator(".dealer-facility input").evaluateAll(cs => cs.map(c => [c.value, c.checked])), [["fB", true], ["fA", false]], "担当施設を先頭に");
        assert.match(await page.locator(".dealer-scope").innerText(), /担当施設\(1施設\)/);
        assert.deepEqual(await page.locator(".dealer-row-number").allInnerTexts(), ["IOL-20261027-02"]);
        // すべて選択 → 検索(複数施設)
        await page.click('[data-select="all"]');
        assert.match(await page.locator(".dealer-scope").innerText(), /閲覧可能な全施設\(2施設\)/);
        await page.click("#btnDealerSearch");
        await page.waitForFunction(() => document.querySelectorAll(".dealer-row").length === 2);
        assert.deepEqual((await calls(page, "list")).at(-1).facilityFilter.facilityIds.sort(), ["fA", "fB"]);
        // 施設名の HTML は文字として表示(要素にならない)
        assert.equal(await page.locator(".dealer-results img").count(), 0);
        assert.ok((await page.locator(".dealer-results").innerText()).includes("<img src=x"));
        // 詳細
        await page.locator('[data-receipt="rcp-a"]').click();
        await page.locator(".dealer-lines tbody tr").first().waitFor();
        assert.equal(await page.locator(".dealer-lines tbody tr").count(), 2);
        assert.ok((await page.locator(".dealer-detail").innerText()).includes("<b>山田</b>"), "担当医名も文字のまま");
        assert.equal(await page.locator(".dealer-detail b, .dealer-detail img").count(), 0);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 詳細が横にはみ出さない`);
        await page.click('[data-act="back"]');
        // 選択を解除 → 0件(自動で全選択に戻さない)
        await page.click('[data-select="none"]');
        await page.click("#btnDealerSearch");
        await page.waitForFunction(() => document.querySelector("#dealerListMsg").textContent.includes("該当する注文はありません"));
        assert.deepEqual((await calls(page, "list")).at(-1).facilityFilter.facilityIds, []);
        // 担当施設の保存(表示用)
        await page.click('[data-select="all"]');
        await page.click('[data-act="saveAssigned"]');
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "setAssignments"));
        assert.deepEqual((await calls(page, "setAssignments"))[0].facilityIds.sort(), ["fA", "fB"]);
        // 注文のデータは端末に保存しない
        const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
        assert.ok(!/IOL-2026|rcp-|B眼科/.test(stored), "注文番号・施設名を保存しない");
        assert.equal(await page.evaluate(() => window.__xss), undefined);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 横にはみ出さない`);
        // 送るのは選択値だけ(役割・UID などは送らない)
        for (const d of await page.evaluate(() => (window.__calls || []).map(([, d]) => d))) {
          assert.ok(!["role", "uid", "email", "staff"].some(k => k in d), JSON.stringify(d));
        }
        assert.deepEqual(errors, []);
        await context.close();
      }
    } finally { await browser.close(); }
  });
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`ディーラー画面: 条件を変えたら続きを破棄(古い条件の「さらに表示」をしない・通信中の変更も)。走査途中の0件は「該当なし」としない。再検索の案内: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const context = await newFakeContext(browser, base, 390, STAFF);
      const page = await context.newPage();
      await installFakeServer(page, "staff");
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(`${base}dealer.html`);
      await page.locator(".dealer-row").first().waitFor();
      // 1ページ目: 選んだ施設の先頭の1件と続き。続き(cursor)では2件目
      await page.evaluate(() => {
        window.__listOverride = async (d) => {
          const ids = d.facilityFilter.facilityIds || [];
          const f = ids[0] || "none";
          const row = (n) => ({ receiptId: `r-${f}-${n}`, facilityId: f, facilityName: f, orderNumber: `${f}-${n}`, orderedAt: "2026-10-27T01:00:00.000Z", lineCount: 1, totalQuantity: 1 });
          if (window.__listDelay) await new Promise(r => setTimeout(r, window.__listDelay));
          return d.cursor ? { items: [row(2)], nextCursor: null, complete: true } : { items: [row(1)], nextCursor: `cur-${ids.join(",")}`, complete: false };
        };
      });
      const listCalls = () => calls(page, "list");
      const rows = () => page.locator(".dealer-row-number").allInnerTexts();
      // 施設Aだけで検索 → 続きあり
      await page.click('[data-select="none"]');
      await page.locator('[data-facility="fA"]').check();
      await page.click("#btnDealerSearch");
      await page.waitForFunction(() => document.querySelectorAll(".dealer-row").length === 1 && !document.querySelector("#btnDealerMore").hidden);
      // 施設を B に替える → 結果と続きを破棄。「さらに表示」は出ない(古い A の続きを読まない)
      await page.locator('[data-facility="fA"]').uncheck();
      await page.locator('[data-facility="fB"]').check();
      assert.equal(await page.locator("#btnDealerMore").isHidden(), true);
      assert.deepEqual(await rows(), []);
      assert.match(await page.locator("#dealerListMsg").innerText(), /条件を変更しました/);
      const n = (await listCalls()).length;
      await page.click("#btnDealerSearch");
      await page.waitForFunction((k) => (window.__calls || []).filter(([, d]) => d.action === "list").length === k + 1, n);
      await page.waitForFunction(() => document.querySelectorAll(".dealer-row").length === 1);
      const last = (await listCalls()).at(-1);
      assert.deepEqual([last.facilityFilter.facilityIds, "cursor" in last], [["fB"], false], "新しい条件で先頭から");
      assert.deepEqual(await rows(), ["fB-1"]);
      // 続き: 同じ条件のカーソルで
      await page.click("#btnDealerMore");
      await page.waitForFunction(() => document.querySelectorAll(".dealer-row").length === 2);
      assert.equal((await listCalls()).at(-1).cursor, "cur-fB");
      // 期間・注文番号・選択ボタンの変更でも破棄
      for (const change of [
        () => page.fill("#dealerOrderNumber", "X-1"),
        () => page.fill("#dealerFrom", "2026-10-01"),
        () => page.click('[data-select="all"]')
      ]) {
        await page.click("#btnDealerSearch");
        await page.waitForFunction(() => !document.querySelector("#btnDealerMore").hidden);
        await change();
        assert.equal(await page.locator("#btnDealerMore").isHidden(), true);
        assert.deepEqual(await rows(), []);
      }
      // 通信中に条件を変えた: 古い応答を表示しない
      await page.evaluate(() => { window.__listDelay = 400; });
      await page.click("#btnDealerSearch");
      await page.locator('[data-facility="fB"]').uncheck();
      await page.waitForFunction(() => !document.querySelector("#btnDealerSearch").disabled);
      assert.deepEqual(await rows(), []);
      assert.equal(await page.locator("#btnDealerMore").isHidden(), true);
      assert.match(await page.locator("#dealerListMsg").innerText(), /条件を変更しました/);
      await page.evaluate(() => { window.__listDelay = 0; });
      // 走査の途中で0件(続きあり): 「該当する注文はありません」としない
      await page.evaluate(() => { window.__listOverride = async (d) => (d.cursor ? { items: [], nextCursor: null, complete: false, restart: true } : { items: [], nextCursor: "c1", complete: false }); });
      await page.click("#btnDealerSearch");
      await page.waitForFunction(() => /続きを検索できます/.test(document.querySelector("#dealerListMsg").textContent));
      assert.ok(!/該当する注文はありません/.test(await page.locator("#dealerListMsg").innerText()));
      assert.equal(await page.locator("#btnDealerMore").isHidden(), false);
      // 検索の途中で索引が反映された: 先頭からの再検索を案内し、続きは出さない
      await page.click("#btnDealerMore");
      await page.waitForFunction(() => /先頭から検索し直してください/.test(document.querySelector("#dealerListMsg").textContent));
      assert.equal(await page.locator("#btnDealerMore").isHidden(), true);
      assert.deepEqual(errors, []);
      await context.close();
    } finally { await browser.close(); }
  });
}

test("ディーラー画面: 有効な所属が2社なら会社を選ぶ。選んだ会社で開き、切り替えられる(chromium)", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    const context = await newFakeContext(browser, base, 390, STAFF);
    const page = await context.newPage();
    await installFakeServer(page, "multi");
    await page.goto(`${base}dealer.html`);
    await page.getByText("会社の選択", { exact: true }).waitFor();
    assert.deepEqual(await page.locator(".pending-invite-facility").allInnerTexts(), ["エックス商事", "ワイ医療"]);
    assert.deepEqual(await calls(page, "context"), [], "選ぶまで会社の画面を開かない");
    await page.click('[data-company="dco-y"]');
    await page.locator(".dealer-row").first().waitFor();
    assert.equal(await page.locator("#dealerCompany").innerText(), "ワイ医療");
    assert.deepEqual((await calls(page, "context"))[0], { action: "context", companyId: "dco-y" });
    assert.equal((await calls(page, "list"))[0].companyId, "dco-y");
    await page.click('[data-act="switchCompany"]');
    await page.getByText("会社の選択", { exact: true }).waitFor();
    assert.equal(await page.locator(".dealer-row").count(), 0, "切り替えでは前の会社の表示を残さない");
    await context.close();
  } finally { await browser.close(); }
});

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`ディーラー画面のログイン: 上段に「Googleでログイン」(推奨・毎回アカウントを選択)、下段にメールリンク(代替)。キャンセル・ブロックの案内。スマートフォン/PC: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [390, 1100]) {
        const context = await newFakeContext(browser, base, width, null);
        const page = await context.newPage();
        await installFakeServer(page, "staff");
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await page.goto(`${base}dealer.html`);
        const google = page.locator("#btnDealerGoogle"), send = page.locator("#btnDealerSendLink");
        await google.waitFor();
        assert.equal(await google.innerText(), "Googleでログイン");
        const [g, m] = [await google.boundingBox(), await page.locator("#dealerEmail").boundingBox()];
        assert.ok(g.y < m.y, `${width}: Google が上段`);
        assert.match(await google.getAttribute("class"), /btn-primary/);
        assert.match(await send.getAttribute("class"), /btn-secondary/, "メールリンクは代替");
        assert.match(await page.locator('[data-login="accounts"]').innerText(), /推奨/);
        // Microsoft: Google と並べる(PC は横、スマホは縦)。メールのリンクより上
        const msb = page.locator("#btnDealerMicrosoft");
        assert.equal(await msb.innerText(), "Microsoftでログイン");
        const mb = await msb.boundingBox();
        assert.ok(mb.y < m.y, `${width}: Microsoft もメールより上`);
        if (width >= 1100) assert.ok(Math.abs(mb.y - g.y) < 2 && mb.x > g.x, "PC は横に並ぶ"); else assert.ok(mb.y > g.y, "スマホは縦に並ぶ");
        await msb.click();
        await page.getByText("ログインがキャンセルされました。").waitFor();
        assert.deepEqual(await page.evaluate(() => window.__microsoftCalls), [{ prompt: "select_account" }]);
        await page.evaluate(() => { window.__fakeMicrosoft = async () => { throw Object.assign(new Error("x"), { code: "auth/account-exists-with-different-credential" }); }; });
        await msb.click();
        await page.getByText(/別のログイン方法で登録されています/).waitFor();
        await page.evaluate(() => { window.__fakeMicrosoft = null; });
        // 押すとアカウントの選択画面を出す指定で呼ぶ。閉じた・ブロックされたときは案内(サーバーには問い合わせない)
        await google.click();
        await page.getByText("ログインがキャンセルされました。").waitFor();
        assert.deepEqual(await page.evaluate(() => window.__googleCalls), [{ prompt: "select_account" }]);
        await page.evaluate(() => { window.__fakeGoogle = async () => { throw Object.assign(new Error("blocked"), { code: "auth/popup-blocked" }); }; });
        await google.click();
        await page.getByText(/ポップアップがブロックされました/).waitFor();
        assert.equal(await google.isEnabled(), true, "失敗の後はもう一度押せる");
        // メールリンクも従来どおり(戻り先は dealer.html)
        await page.fill("#dealerEmail", "x1@corp.example.jp");
        await send.click();
        await page.waitForFunction(() => (window.__linkSent || []).length === 1);
        assert.deepEqual(await calls(page, "context"), [], "ログイン前はサーバーに問い合わせない");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 横にはみ出さない`);
        assert.deepEqual(errors, []);
        await context.close();
      }
    } finally { await browser.close(); }
  });
}

test("ディーラー画面: 未ログインはメールリンクのログイン(戻り先は dealer.html)。所属のない人には会社名・施設名を出さない。参加の確認(chromium)", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    // 未ログイン
    let context = await newFakeContext(browser, base, 390, null);
    let page = await context.newPage();
    await installFakeServer(page, "staff");
    await page.goto(`${base}dealer.html`);
    await page.locator("#dealerEmail").waitFor();
    await page.fill("#dealerEmail", "x1@corp.example.jp");
    await page.click("#btnDealerSendLink");
    await page.waitForFunction(() => (window.__linkSent || []).length === 1);
    assert.deepEqual(await page.evaluate(() => window.__linkSent[0]), ["x1@corp.example.jp", `${base.replace(/\/$/, "")}/dealer.html`]);
    assert.deepEqual(await calls(page, "context"), [], "ログイン前はサーバーに問い合わせない");
    await context.close();

    // 所属なし(未招待・退職など)
    context = await newFakeContext(browser, base, 390, STAFF);
    page = await context.newPage();
    await installFakeServer(page, "none");
    await page.goto(`${base}dealer.html`);
    await page.getByText("ディーラー画面の利用登録が確認できません").waitFor();
    const text = await page.locator("main").innerText();
    assert.ok(!/エックス商事|B眼科|A眼科|IOL-2026/.test(text));
    assert.equal(await page.locator(".dealer-row").count(), 0);
    await context.close();

    // 機能の停止中: Google などでログインできても(認証はスイッチで止まらない)、サーバーがすべて拒否し、会社・施設・注文は何も出ない
    context = await newFakeContext(browser, base, 390, STAFF);
    page = await context.newPage();
    await installFakeServer(page, "disabled");
    await page.goto(`${base}dealer.html`);
    await page.getByText("ディーラー画面は現在ご利用いただけません").waitFor();
    assert.ok(!/エックス商事|B眼科|A眼科|IOL-2026/.test(await page.locator("main").innerText()));
    assert.equal(await page.locator(".dealer-row").count(), 0);
    assert.equal(await page.locator('[data-act="signout"]').count(), 1);
    await context.close();

    // 連携済みで登録が終わっていない Microsoft(MS-03 の再開): 会社の情報は出さず、登録の画面。連携は省略し、確認コードで登録 → 受注一覧
    context = await newFakeContext(browser, base, 390, { ...STAFF, user: { ...STAFF.user, providerData: [{ providerId: "microsoft.com" }] } });
    page = await context.newPage();
    await installFakeServer(page, "msNotRegistered");
    await page.goto(`${base}dealer.html`);
    await page.getByText("Microsoftアカウントの登録", { exact: true }).waitFor();
    assert.ok(!/エックス商事|B眼科|A眼科|IOL-2026/.test(await page.locator("main").innerText()));
    assert.equal(await page.locator('[data-act="signout"]').count(), 1);
    assert.equal(await page.locator('[data-f="msCode"]').isVisible(), false, "コード欄は送るまで出さない");
    await page.click('[data-act="linkMicrosoft"]');
    await page.getByText(/確認コードを送りました/).waitFor();
    assert.equal(await page.evaluate(() => window.__linkCalls), undefined, "連携済みなら連携の画面を出さない");
    await page.fill('[data-f="msCode"]', "00000000");
    await page.click('[data-act="trustMicrosoft"]');
    await page.getByText(/確認コードが違います/).waitFor();
    await page.fill('[data-f="msCode"]', "1234 5678");
    await page.click('[data-act="trustMicrosoft"]');
    await page.locator(".dealer-row").first().waitFor();
    assert.deepEqual((await calls(page, "trustMicrosoft")).at(-1), { action: "trustMicrosoft", code: "12345678" });
    await context.close();

    // 受注一覧の「Microsoftアカウントを連携」: 連携(アカウントの選択画面)→ 確認コードを送る → コードで登録
    context = await newFakeContext(browser, base, 390, STAFF);
    page = await context.newPage();
    await installFakeServer(page, "staff");
    await page.goto(`${base}dealer.html`);
    await page.locator(".dealer-row").first().waitFor();
    await page.locator(".dealer-ms-link summary").click();
    // 別のアカウントに連携済みの Microsoft は、案内してコードを送らない
    await page.evaluate(() => { window.__fakeLink = async () => { throw Object.assign(new Error("x"), { code: "auth/credential-already-in-use" }); }; });
    await page.click('[data-act="linkMicrosoft"]');
    await page.getByText(/別のアカウントにすでに連携されています/).waitFor();
    assert.deepEqual(await calls(page, "sendMicrosoftCode"), [], "連携に失敗したときは送らない");
    // 連携は成功したが確認コードの送信が一時的に失敗 → もう一度押すと、連携を省略して送信からやり直せる(MS-03)
    await page.evaluate(() => { window.__fakeLink = null; window.__linkCalls = []; window.__failMsSend = true; });
    await page.click('[data-act="linkMicrosoft"]');
    await page.getByText(/確認コードを送れませんでした/).waitFor();
    await page.click('[data-act="linkMicrosoft"]');
    await page.getByText(/確認コードを送りました/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__linkCalls), [["microsoft.com", { prompt: "select_account" }]], "連携は1回だけ");
    assert.equal((await calls(page, "sendMicrosoftCode")).length, 2);
    await page.fill('[data-f="msCode"]', "12345678");
    await page.click('[data-act="trustMicrosoft"]');
    await page.getByText(/Microsoft アカウントを登録しました/).waitFor();
    await context.close();

    // 参加の確認: 会社名を出さない → コードなしでは送らない → 確認コードを送る → 違うコードは拒否 → メールのコードで参加 → 受注一覧
    context = await newFakeContext(browser, base, 390, STAFF);
    page = await context.newPage();
    await installFakeServer(page, "invited");
    await page.goto(`${base}dealer.html`);
    await page.getByText("ディーラー画面への参加の確認").waitFor();
    assert.equal(await page.locator(".pending-invite-facility").innerText(), "ディーラー画面への参加の案内");
    assert.ok(!/エックス商事|B眼科|A眼科|IOL-2026/.test(await page.locator("main").innerText()), "会社名は画面に出さない");
    await page.click('[data-act="accept"]');
    await page.getByText("メールに届いた8桁の確認コードを入力してください。").waitFor();
    assert.deepEqual(await calls(page, "respond"), [], "コードなしでは送らない");
    await page.click('[data-act="sendCode"]');
    await page.getByText(/確認コードを送りました/).waitFor();
    assert.deepEqual(await calls(page, "sendCode"), [{ action: "sendCode", invitationId: "dinv-1" }]);
    await page.fill('[data-f="joinCode"]', "00000000");
    await page.click('[data-act="accept"]');
    await page.getByText(/確認コードが違います/).waitFor();
    assert.deepEqual(await calls(page, "context"), []);
    await page.fill('[data-f="joinCode"]', "1234 5678");
    await page.click('[data-act="accept"]');
    await page.locator(".dealer-row").first().waitFor();
    assert.deepEqual((await calls(page, "respond")).at(-1), { action: "respond", invitationId: "dinv-1", accept: true, code: "12345678" });
    await context.close();
  } finally { await browser.close(); }
});
