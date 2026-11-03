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

/**
 * 偽のサーバー(dealerPortalApi)。scenario: "staff"(確認済み)/ "unverified"(この認証主体は未確認)/ "pendingInvite"(確認済み+新しい参加の案内)/
 * "multi"(2社)/ "single"(閲覧可能な施設が1件)/ "none"(未招待)/ "disabled"(機能の停止中)。確認コードは偽: 12345678(確認すると端末の値 "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" を返す)
 */
function installFakeServer(page, scenario) {
  return page.addInitScript((scenario) => {
    const deny = (msg) => Object.assign(new Error(msg), { code: "functions/permission-denied" });
    const facilities = [{ id: "fB", name: "B眼科", assigned: true }, { id: "fA", name: "<img src=x onerror=\"window.__xss=1\">A眼科", assigned: false }];
    const receipts = [
      { receiptId: "rcp-a", facilityId: "fA", facilityName: facilities[1].name, orderNumber: "IOL-20261027-01", orderedAt: "2026-10-27T01:00:00.000Z", lineCount: 2, totalQuantity: 3, doctorNames: ["山田", "<b>佐藤</b>"],
        lines: [{ no: 1, surgeryDate: "2026-11-06", model: "DIB00V", toricModel: "", power: "+21.0D", quantity: 2, doctorName: "山田" },
          { no: 2, surgeryDate: "2026-11-06", model: "DIWxxx (トーリック)", toricModel: "DIW300", power: "+18.5D", quantity: 1, doctorName: "<b>佐藤</b>" }] },
      { receiptId: "rcp-b", facilityId: "fB", facilityName: "B眼科", orderNumber: "IOL-20261027-02", orderedAt: "2026-10-27T02:00:00.000Z", lineCount: 1, totalQuantity: 1,
        lines: [{ no: 1, surgeryDate: "2026-11-09", model: "DIB00V", toricModel: "", power: "+20.0D", quantity: 1, doctorName: "とても長い名前の担当医の先生" }] }
    ];
    let verified = !["unverified", "none"].includes(scenario);
    // 役割: "companyAdmin" / "branchAdmin" のシナリオは、確認済みの会社管理者・支店管理者(ほかは閲覧者)
    const myRole = ["companyAdmin", "branchAdmin"].includes(scenario) ? scenario : scenario === "testMode" ? "companyAdmin" : "reader";   // testMode: 運営者の試験モード(会社管理者)
    const manageDb = {
      branches: [{ branchId: "b-tokyo", name: "東京支店", status: "active" }, { branchId: "b-osaka", name: "大阪支店", status: "active" }],
      staff: [
        { staffId: "s-me", name: "担当x1", email: "x1@corp.example.jp", role: myRole, branchId: "b-tokyo", status: "active", verified: true },
        { staffId: "s-adm2", name: "大阪の会社管理者", email: "adm2@corp.example.jp", role: "companyAdmin", branchId: "b-osaka", status: "active", verified: true },
        { staffId: "s-badm", name: "大阪の支店管理者", email: "badm@corp.example.jp", role: "branchAdmin", branchId: "b-osaka", status: "active", verified: true },
        { staffId: "s-r1", name: "東京の閲覧者", email: "r1@corp.example.jp", role: "reader", branchId: "b-tokyo", status: "active", verified: false, facilityIds: ["fB"] },
        { staffId: "s-r2", name: "", email: "r2-very-long-address-for-wrapping@corp.example.jp", role: "reader", branchId: null, status: "disabled", verified: false },
        { staffId: "s-inv", name: "招待中", email: "inv@corp.example.jp", role: "reader", branchId: "b-tokyo", status: "invited", inviteExpiresAt: "2026-11-30T00:00:00.000Z", verified: false }],
      // 担当施設の候補(会社に関連付けられ許可された施設)。名称は textContent で表示する
      facilities: [{ facilityId: "fB", name: "B眼科" }, { facilityId: "fA", name: facilities[1].name }]
    };
    // 実際のサーバーと同じく、支店管理者には自分の支店(東京)の担当者と自分、自分の支店だけを返す
    const manageView = () => {
      const v = JSON.parse(JSON.stringify({ me: { staffId: "s-me", role: myRole, branchId: "b-tokyo" }, ...manageDb }));
      if (myRole === "branchAdmin") {
        v.staff = v.staff.filter(x => x.staffId === "s-me" || x.branchId === "b-tokyo");
        v.branches = v.branches.filter(b => b.branchId === "b-tokyo");
      }
      return v;
    };
    const needDevice = scenario === "unverified";   // 確認した後は、実際のサーバーと同じく端末の値がないと閲覧できない(紛失を検出する)
    let pending = scenario === "pendingInvite";
    window.__fakeCallables = {
      dealerPortalApi: async (d) => {
        if (scenario === "disabled") throw Object.assign(new Error("ディーラー画面は現在ご利用いただけません"), { code: "functions/failed-precondition" });   // 機能の停止中: すべての取得を拒否
        // 本人確認: 送り先はサーバーが決める(画面からは送らない)。未招待には送らないが、応答は同じ
        if (d.action === "sendCode") return { ok: true, expiresInMinutes: 10 };
        if (d.action === "verifyCode") {
          if (d.code !== "12345678" || scenario === "none") throw Object.assign(new Error("確認コードが違います。メールに届いたコードを入力してください"), { code: "functions/failed-precondition" });
          verified = true; pending = false;
          return { ok: true, companies: 1, joined: 1, deviceToken: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" };
        }
        if (!verified || (needDevice && d.deviceToken !== "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD")) throw Object.assign(new Error("本人確認が必要です"), { code: "functions/permission-denied", details: { reason: "verification-required" } });
        // 有効な所属だけ(multi は2社)と、未確認の参加の案内があるか
        if (d.action === "companies") return { companies: [{ companyId: "dco-x", name: "エックス商事" }, ...(scenario === "multi" ? [{ companyId: "dco-y", name: "ワイ医療" }] : [])], pendingInvitation: pending };
        if (d.action === "list" && window.__listOverride) return window.__listOverride(d);
        if (d.action.startsWith("manage")) {
          if (myRole === "reader") throw deny("会社管理者・支店管理者のみ操作できます");
          if (d.action === "manageInvite") manageDb.staff.push({ staffId: "s-new", name: d.name, email: d.email, role: d.role, branchId: d.branchId || null, status: "invited", inviteExpiresAt: "2026-11-30T00:00:00.000Z", verified: false });
          if (d.action === "manageUpdateStaff") Object.assign(manageDb.staff.find(x => x.staffId === d.staffId), Object.fromEntries(Object.entries(d).filter(([k]) => ["name", "role", "branchId", "status", "facilityIds"].includes(k))));
          if (d.action === "manageCancelInvite") manageDb.staff = manageDb.staff.filter(x => x.staffId !== d.staffId);
          if (d.action === "manageBranch") {
            const b = manageDb.branches.find(x => x.branchId === d.branchId);
            if (b) Object.assign(b, { name: d.name, ...(d.status ? { status: d.status } : {}) }); else manageDb.branches.push({ branchId: "b-" + d.name, name: d.name, status: "active" });
          }
          return d.action === "manage" ? manageView() : { ok: true };
        }
        if (d.action === "week") {
          const day = (n) => new Date(Date.parse(d.weekStart + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
          const sel = new Set(d.facilityFilter.facilityIds);
          const L = (no, model, power, quantity, toricModel = "", doctorName = "山田") => ({ no, manufacturer: "J&J", model, toricModel, power, quantity, doctorName });
          // 予定のある週を変えるとき(window.__weekData = { 月曜: true })。指定がなければ、どの週も同じ予定(日付だけずらす)
          const withData = !window.__weekData || window.__weekData[d.weekStart] === true;
          const byDate = {
            [day(1)]: [{ receiptId: "rcp-a", facilityId: "fA", facilityName: facilities[1].name, orderNumber: "IOL-20261027-01", orderedAt: "2026-10-27T01:00:00.000Z", ownLineCount: 3, otherDates: [day(8)],
              lines: [L(1, "DIB00V", "+21.0D", 2), L(3, "DIWxxx (トーリック)", "+18.5D", 1, "DIW300", "<b>佐藤</b>")] },
              { receiptId: "rcp-c", facilityId: "fB", facilityName: "B眼科", orderNumber: "IOL-20261027-03", orderedAt: "2026-10-27T03:00:00.000Z", ownLineCount: 1, otherDates: [],
                lines: [L(1, "DIB00V", "+21.0D", 2, "", "内田")] }],
            [day(3)]: [{ receiptId: "rcp-b", facilityId: "fB", facilityName: "B眼科とても長い名前の医療法人社団眼科クリニック", orderNumber: "IOL-20261027-02", orderedAt: "2026-10-27T02:00:00.000Z", ownLineCount: 1, otherDates: [],
              lines: [L(1, "DIB00V", "+20.0D", 1)] }]
          };
          return { weekStart: day(0), weekEnd: day(6), truncated: Boolean(window.__weekTruncated && window.__weekTruncated[d.weekStart]),
            days: Array.from({ length: 7 }, (_, i) => ({ date: day(i), orders: withData ? (byDate[day(i)] || []).filter(o => sel.has(o.facilityId)) : [] })) };
        }
        // 会社のテーマカラー(偽: 端末をまたいで共通の保存先の代わりに localStorage。会社管理者でなければ拒否)
        const themeStore = () => { try { return JSON.parse(localStorage.getItem("__fakeCompanyTheme") || "null"); } catch { return null; } };
        if (d.action === "setTheme" || d.action === "resetTheme") {
          if (myRole !== "companyAdmin") throw deny("テーマカラーの変更は、会社管理者のみ行えます");
          if (window.__themeFail) throw Object.assign(new Error("保存できません"), { code: "functions/unavailable" });
          const t = d.action === "setTheme" ? { color: d.color, gradient: d.gradient, darkText: d.darkText } : null;
          localStorage.setItem("__fakeCompanyTheme", JSON.stringify(t));
          return { ok: true, headerTheme: t };
        }
        if (d.action === "context") return {
          ...(scenario === "testMode" ? { testMode: true } : {}),
          headerTheme: themeStore(),
          company: d.companyId === "dco-y" ? { id: "dco-y", name: "ワイ医療" } : { id: "dco-x", name: "エックス商事" }, me: { name: "担当x1", role: myRole, branch: { id: "br-1", name: "東京支店" } },
          facilities: scenario === "single" ? facilities.slice(0, 1) : facilities, assignedFacilityIds: ["fB"], selectedFacilityIds: ["fB"], selection: "assigned",
          defaultRange: { from: "2026-09-28", to: "2026-10-27" }, limits: { rangeDaysMax: 366, pageMax: 100 }
        };
        if (d.action === "list") {
          const sel = new Set(d.facilityFilter.facilityIds);
          return { items: receipts.filter(r => sel.has(r.facilityId) && (!d.orderNumber || r.orderNumber === d.orderNumber)).sort((a, b) => b.orderedAt.localeCompare(a.orderedAt)), nextCursor: null, complete: true };
        }
        if (d.action === "get") return {
          receiptId: d.receiptId, facilityId: "fA", facilityName: facilities[1].name, orderNumber: "IOL-20261027-01", orderedAt: "2026-10-27T01:00:00.000Z",
          lineCount: 2, totalQuantity: 3, mail: window.__mailOverride || { status: "accepted", label: "送信済み(配信サービスが受付)", at: "2026-10-27T01:01:00.000Z", delivery: null },
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
/** 端末の値の保存(キーは UID・ログイン方法・主体ごと。iolDealerDevice.{uid}.…) */
const deviceStored = (page, uid = "x1") => page.evaluate((u) => Object.keys(localStorage).filter(k => k.startsWith(`iolDealerDevice.${u}.`)).map(k => [k.split(".").length, localStorage.getItem(k)]), uid);
/** 初期表示(手術日順)を待ってから「注文日順」に切り替え、一覧を待つ(注文日の検索は常に表示) */
async function openOrdered(page) {
  await page.waitForFunction(() => (window.__calls || []).some(([n, d]) => n === "dealerPortalApi" && d.action === "week") && document.querySelector('[data-view="ordered"]'));
  await page.click('[data-view="ordered"]');
  await page.locator(".dealer-card").first().waitFor();
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
        await openOrdered(page);
        assert.equal(await page.locator("#dealerCompany").innerText(), "エックス商事");
        // ヘッダーの「☰」メニュー(医療機関の画面と同じ部品の見た目): 氏名・所属会社・ログアウト。受注一覧の中のログアウト・会社名と氏名の行はない
        assert.equal(await page.locator(".app-header .header-inner .header-menu .header-menu-btn").isVisible(), true);
        assert.equal(await page.locator("#headerMenuPanel").isHidden(), true);
        assert.equal(await page.locator('#dealerPanel [data-act="signout"], #dealerPanel [data-act="switchCompany"], #dealerPanel .feature-desc').count(), 0);
        assert.ok(!(await page.locator("#dealerPanel").innerText()).includes("担当x1"), "氏名は受注一覧に重ねて出さない");
        await page.click("#btnHeaderMenu");
        assert.equal(await page.locator("#btnHeaderMenu").getAttribute("aria-expanded"), "true");
        assert.deepEqual(await page.locator("#headerMenuPanel .header-menu-label").allInnerTexts(), ["ログイン中", "所属会社"]);
        assert.deepEqual([await page.locator('[data-f="menuName"]').innerText(), await page.locator('[data-f="menuCompany"]').innerText()], ["担当x1", "エックス商事 東京支店"]);
        assert.deepEqual(await page.locator("#headerMenuPanel .header-menu-item").allInnerTexts(), ["使い方・ヘルプ", "ログアウト"], "閲覧者: ディーラー設定はない。1社だけなら会社の切り替えは出さない");
        assert.equal(await page.locator(".app-header .header-title").innerText(), "受注一覧", "受注一覧では「(ディーラー用)」を外す");
        const menuBox = await page.locator("#headerMenuPanel").boundingBox();
        assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= width, `${width}: メニューが画面内`);
        await page.locator(".header-title").click();   // 外側のクリックで閉じる(ⓘのない場所)
        assert.equal(await page.locator("#headerMenuPanel").isHidden(), true);
        await page.click("#btnHeaderMenu");
        await page.keyboard.press("Escape");   // Esc で閉じる
        assert.equal(await page.locator("#headerMenuPanel").isHidden(), true);
        // 初期表示: 担当施設(B)だけを選択して検索
        assert.deepEqual((await calls(page, "list"))[0].facilityFilter, { mode: "selected", facilityIds: ["fB"] });
        assert.deepEqual(await page.locator(".dealer-facility input").evaluateAll(cs => cs.map(c => [c.value, c.checked])), [["fB", true], ["fA", false]], "担当施設を先頭に");
        assert.equal(await page.locator(".dealer-scope").count(), 0, "「検索範囲: …」の行は出さない");
        assert.ok(!(await page.locator("#dealerPanel").innerText()).includes("検索範囲"));
        assert.deepEqual(await page.locator(".dealer-card").evaluateAll(rs => rs.map(r => r.dataset.receipt)), ["rcp-b"]);
        // チェックしている施設が1つ(閲覧できる施設は2つ): 注文番号の横の医療機関名は出さない。注文番号・明細・担当医名はそのまま
        assert.equal(await page.locator(".dealer-card-facility").count(), 0, "1施設の選択では医療機関名を出さない");
        assert.deepEqual([await page.locator(".dealer-card-no").innerText(), await page.locator(".dealer-card .history-lens-doctor").innerText()], ["IOL-20261027-02", "とても長い名前の担当医の先生Dr"]);
        // すべて選択 → 検索(複数施設)
        await page.click('[data-select="all"]');
        assert.deepEqual(await page.locator(".dealer-facility input").evaluateAll(cs => cs.map(c => c.checked)), [true, true], "すべて選択(検索範囲の文言はなし)");
        await page.click("#btnDealerSearch");
        await page.waitForFunction(() => document.querySelectorAll(".dealer-card").length === 2);
        assert.deepEqual((await calls(page, "list")).at(-1).facilityFilter.facilityIds.sort(), ["fA", "fB"]);
        assert.deepEqual(await page.locator(".dealer-card-facility").allInnerTexts(), ["B眼科", "<img src=x onerror=\"window.__xss=1\">A眼科"], "2施設以上なら注文番号の横に医療機関名");
        // 1施設に戻して表示し直すと、医療機関名は出ない
        await page.click('[data-select="assigned"]');
        await page.click("#btnDealerSearch");
        await page.waitForFunction(() => document.querySelectorAll(".dealer-card").length === 1);
        assert.equal(await page.locator(".dealer-card-facility").count(), 0, "1施設に戻すと省略");
        await page.click('[data-select="all"]');
        await page.click("#btnDealerSearch");
        await page.waitForFunction(() => document.querySelectorAll(".dealer-card").length === 2);
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
        // 「← 一覧へ戻る」は医療機関側の注文履歴と同じ高さ 36px・文字 0.9rem
        assert.deepEqual(await page.locator('.dealer-detail > [data-act="back"]').evaluate(e => [e.getBoundingClientRect().height, Math.round(parseFloat(getComputedStyle(e).fontSize) * 10) / 10]), [36, 14.4], `${width}: ← 一覧へ戻る の高さ`);
        await page.click('[data-act="back"]');
        await page.mouse.move(0, 0);   // 戻った後の位置にⓘがあると、マウスのホバーで説明が開くため離す
        // 選択を解除 → 0件(自動で全選択に戻さない)
        await page.click('[data-select="none"]');
        await page.click("#btnDealerSearch");
        await page.waitForFunction(() => document.querySelector("#dealerListMsg").textContent.includes("該当する注文はありません"));
        assert.deepEqual((await calls(page, "list")).at(-1).facilityFilter.facilityIds, []);
        // チェックは端末に自動で記憶する(ログインユーザー × 会社ごと。施設 ID だけ)。すべて解除も「選択なし」のまま保持
        assert.equal(await page.locator('[data-act="saveAssigned"]').count(), 0, "担当施設の保存ボタンはない");
        const viewStored = () => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("iolDealerFacilityView.")).map(k => [k, JSON.parse(localStorage.getItem(k))]));
        assert.deepEqual(await viewStored(), [["iolDealerFacilityView.x1.dco-x", []]]);
        await page.reload();
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "week"));
        assert.deepEqual(await page.locator(".dealer-facility input").evaluateAll(cs => cs.map(c => c.checked)), [false, false], "選択なしを復元(担当施設に戻さない)");
        assert.deepEqual((await calls(page, "week"))[0].facilityFilter.facilityIds, []);
        // 1施設だけ(担当でない施設)→ 次回も同じ
        await page.locator('.dealer-facility input[value="fA"]').check();
        assert.deepEqual(await viewStored(), [["iolDealerFacilityView.x1.dco-x", ["fA"]]]);
        await page.reload();
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "week"));
        assert.deepEqual(await page.locator(".dealer-facility input").evaluateAll(cs => cs.map(c => [c.value, c.checked])), [["fB", false], ["fA", true]]);
        assert.match(await page.locator(".dealer-facility-box").innerText(), /担当/, "担当の印は残す");
        // 今は閲覧できない施設の ID は復元しない(残りがなければ従来の初期選択)
        await page.evaluate(() => localStorage.setItem("iolDealerFacilityView.x1.dco-x", JSON.stringify(["gone"])));
        await page.reload();
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "week"));
        assert.deepEqual(await page.locator(".dealer-facility input").evaluateAll(cs => cs.map(c => [c.value, c.checked])), [["fB", true], ["fA", false]]);
        // チェックの操作では担当施設の登録(setAssignments)を呼ばない
        await page.click('[data-select="all"]');
        await page.click('[data-select="assigned"]');
        assert.deepEqual(await calls(page, "setAssignments"), []);
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
  test(`ディーラー画面の受注一覧の並び: 医療機関 → 表示の切り替え → 絞り込み(一覧表示だけ)→ 受注。説明はⓘ(タップで開く)。施設1件なら一括の選択ボタンを出さない。一覧の行に担当医: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [320, 390, 1100]) {
        const context = await newFakeContext(browser, base, width, STAFF);
        const page = await context.newPage();
        await installFakeServer(page, "staff");
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await page.goto(`${base}dealer.html`);
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "week") && document.querySelector('#dealerSurgery [data-act="more"]:not([disabled])'));   // 週表示を読み終えた(該当ありのときは案内の文は空)
        // 並び(画面の上から): 医療機関の枠 → 表示の切り替え → 週 / 一覧
        const order = await page.evaluate(() => {
          const els = [".dealer-facility-box", ".dealer-view", "#dealerSurgeryArea", "#dealerOrderedArea"].map(q => document.querySelector(q));
          return els.every(Boolean) && els.every((el, i) => i === 0 || (els[i - 1].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
        });
        assert.ok(order, "医療機関 → 切り替え → 受注");
        assert.equal(await page.locator(".dealer-facility-box .dealer-view").count(), 0, "切り替えは医療機関の枠の外");
        assert.equal(await page.locator("#dealerOrderedArea #dealerDateSearch").count(), 1, "注文日の検索は注文日順の中だけ");
        assert.equal(await page.locator("#dealerDateSearch").isVisible(), false, "手術日順では注文日の検索を出さない");
        assert.equal(await page.locator("#dealerListFilter, #dealerOrderNumber, #btnDealerClear").count(), 0, "折りたたみ・注文番号の欄・条件をクリアはない");
        assert.deepEqual(await page.locator(".dealer-view [data-view]").allInnerTexts(), ["注文日順", "手術日順"]);
        assert.equal(await page.locator(".dealer-view.history-sort .history-sort-btn").count(), 2, "既存の切り替えボタンのデザイン");
        // 切り替えの外枠はボタン2つ分の幅だけ(右の余白まで広げない)。選択中は青、未選択は白
        const bar = await page.locator(".dealer-view").evaluate(el => {
          const [a, b] = [...el.querySelectorAll(".history-sort-btn")];
          const r = el.getBoundingClientRect(), p = el.parentElement.getBoundingClientRect();
          const bg = x => getComputedStyle(x).backgroundColor;
          return { width: r.width, buttons: a.getBoundingClientRect().width + b.getBoundingClientRect().width, parent: p.width, right: r.right, vw: document.documentElement.clientWidth, pressed: bg(el.querySelector('[aria-pressed="true"]')), other: bg(el.querySelector('[aria-pressed="false"]')) };
        });
        assert.ok(bar.width <= bar.buttons + 4 && bar.width < bar.parent - 40, `${width}: 切り替えはボタン2つ分の幅 ${JSON.stringify(bar)}`);
        assert.ok(bar.right <= bar.vw, `${width}: 切り替えが画面内`);
        assert.notEqual(bar.pressed, bar.other);
        assert.equal(bar.other, "rgb(255, 255, 255)");
        // 説明文は常時表示しない(見出しの右のⓘ)。医療機関名・「担当」の印は表示したまま。「検索範囲: …」の行は出さない
        const text = await page.locator("#dealerPanel").innerText();
        assert.ok(!text.includes("自社宛ての明細だけを表示"), "説明文は常時表示しない");
        assert.ok(text.includes("B眼科") && text.includes("担当") && !text.includes("検索範囲"));
        const titleTip = page.locator(".dealer-title-row .info-tip-btn");
        assert.equal(await titleTip.count(), 1, "「受注一覧」の見出しの右にⓘ");
        await titleTip.click();
        assert.match(await page.locator(".dealer-title-row .info-tip-pop").innerText(), /自社宛ての明細だけを表示します/);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".dealer-title-row .info-tip-pop").isHidden(), true);
        assert.equal(await page.locator(".dealer-facility-box .info-tip-btn").count(), 1, "医療機関の説明はⓘ(担当施設の保存の説明はない)");
        // 医療機関の選択(施設2件): 担当施設のみ / すべて選択 / すべて解除。担当施設の保存ボタン・説明はない(登録の変更は「担当者・支店」)
        assert.deepEqual(await page.locator(".dealer-facility-box [data-select]").allInnerTexts(), ["担当施設のみ", "すべて選択", "すべて解除"]);
        assert.equal(await page.locator('[data-act="saveAssigned"], .dealer-assign-row').count(), 0);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 横にはみ出さない`);
        // 注文日順: 注文日の検索(開始日 〜 終了日 [検索])を常に表示。既定は期間なし(全期間)
        await page.click('[data-view="ordered"]');
        await page.locator(".dealer-card").first().waitFor();
        assert.equal(await page.locator("#dealerDateSearch").isVisible(), true, "注文日の検索は常に表示");
        assert.equal(await page.locator("#btnDealerSearch").innerText(), "検索");
        assert.equal(await page.locator("#dealerFrom").inputValue(), "", "期間は指定しない");
        await page.click('[data-select="all"]');
        await page.click("#btnDealerSearch");
        await page.waitForFunction(() => document.querySelectorAll(".dealer-card").length === 2);
        assert.deepEqual(await page.locator(".dealer-card").evaluateAll(rs => rs.map(r => r.dataset.receipt)), ["rcp-b", "rcp-a"], "新しい順");
        assert.deepEqual(await page.locator(".dealer-card-no").allInnerTexts(), ["IOL-20261027-02", "IOL-20261027-01"], "カードの先頭に注文番号");
        assert.ok(!/2026[/]10[/]27/.test(await page.locator("#dealerResults").innerText()), "注文日時は一覧に出さない");
        assert.deepEqual(await page.locator("#dealerResults .history-lens-doctor").allInnerTexts(), ["とても長い名前の担当医の先生Dr", "山田Dr", "<b>佐藤</b>Dr"], "担当医は各レンズ行の右");
        assert.equal(await page.locator(".dealer-results b").count(), 0);
        // 検索時点の日時は常時表示しない。件数は一覧の直前に控えめに。期間の指定と検索時点の説明は「注文日」のⓘ
        const orderedText = await page.locator("#dealerOrderedArea").innerText();
        assert.ok(!orderedText.includes("検索時点") && !orderedText.includes("注文メールとは別に"), "検索時点・補足は常時表示しない");
        assert.equal(await page.locator(".dealer-fetched").count(), 0);
        assert.equal(await page.locator("#dealerListMsg").innerText(), "2件");
        assert.ok(await page.evaluate(() => document.querySelector("#dealerListMsg").nextElementSibling === document.querySelector("#dealerResults")), "件数は一覧の直前");
        assert.equal(await page.locator("#dealerOrderedArea .info-tip-btn").count(), 1, "注文日順のⓘは「注文日」の1つだけ");
        await page.locator(".dealer-date-head .info-tip-btn").click();
        const filterHelp = await page.locator(".dealer-date-head .info-tip-pop").innerText();
        assert.ok(/開始日だけならその日以降/.test(filterHelp) && /終了日だけならその日まで/.test(filterHelp) && /両方を空/.test(filterHelp) && /検索時点/.test(filterHelp) && /注文メールとは別に/.test(filterHelp), filterHelp);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".dealer-date-head .info-tip-pop").isHidden(), true);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 一覧が横にはみ出さない`);
        // 受注詳細: 通常の注文メール(送信済み)は出さない。説明と詳しい状況は見出しのⓘ。下部の説明文はない
        await page.locator('[data-receipt="rcp-a"]').click();
        await page.locator(".dealer-lines tbody tr").first().waitFor();
        const detailText = await page.locator(".dealer-detail").innerText();
        assert.ok(!detailText.includes("注文メール") && !detailText.includes("自社宛ての明細だけ"), "通常の状態・説明文は常時表示しない");
        assert.equal(await page.locator(".dealer-detail-title .info-tip-btn").count(), 1);
        await page.locator(".dealer-detail-title .info-tip-btn").click();
        const help = await page.locator(".dealer-detail-title .info-tip-pop").innerText();
        assert.deepEqual(help.split("\n").map(x => x.trim()), ["この画面には自社宛ての明細だけを表示しています。", "注文メール: 送信済み(配信サービスが受付)(2026/10/27 10:01)", "注文メールの状態は送信・配信の状況で、受注の確定を示すものではありません。"]);
        await page.keyboard.press("Escape");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 詳細が横にはみ出さない`);
        await page.click('[data-act="back"]');
        // 注意が必要な状態(送信できなかった・配信できなかった)は常時表示
        for (const [mail, expected] of [
          [{ status: "failed", label: "送信できませんでした", at: null, delivery: null }, "送信できませんでした"],
          [{ status: "accepted", label: "送信済み(配信サービスが受付)", at: null, delivery: { status: "bounced", label: "配信できませんでした", at: null } }, "送信済み(配信サービスが受付) ・ 配信できませんでした"]]) {
          await page.evaluate((m) => { window.__mailOverride = m; }, mail);
          await page.locator('[data-receipt="rcp-a"]').click();
          await page.locator(".dealer-mail-attention").waitFor();
          assert.equal(await page.locator(".dealer-mail-attention").innerText(), expected);
          await page.click('[data-act="back"]');
        }
        await page.evaluate(() => { window.__mailOverride = null; });
        assert.deepEqual(errors, []);
        await context.close();
      }
      // 閲覧可能な施設が1件: 一括の選択ボタンは出さない(チェックボックス・担当施設の保存は残す)
      const context = await newFakeContext(browser, base, 390, STAFF);
      const page = await context.newPage();
      await installFakeServer(page, "single");
      await page.goto(`${base}dealer.html`);
      await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "week") && document.querySelector('#dealerSurgery [data-act="more"]:not([disabled])'));   // 週表示を読み終えた(該当ありのときは案内の文は空)
      assert.equal(await page.locator("[data-select]").count(), 0);
      assert.equal(await page.locator(".dealer-facility input").count(), 1);
      assert.equal(await page.locator('[data-act="saveAssigned"]').count(), 0);
      await context.close();
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
      await openOrdered(page);
      // 注文日の検索の並び: 「注文日」ⓘ / 開始日 〜 終了日 [検索](1行に収まらなければ「検索」だけ次の行)。日付の欄は横並びで枠の中。
      // 入力欄の高さは PC と同じ。「検索」は補助ボタンの大きさ(高さ36px・文字0.9rem)で青
      await page.fill("#dealerFrom", "2026-10-01"); await page.fill("#dealerTo", "2026-12-31");
      const fbox = async () => page.evaluate(() => {
        const r = (q) => { const b = document.querySelector(q).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, h: b.height }; };
        const e = document.querySelector("#btnDealerSearch"), c = getComputedStyle(e), b = e.getBoundingClientRect();
        return { row: r(".dealer-date-row"), head: r(".dealer-date-head"), from: r("#dealerFrom"), to: r("#dealerTo"), tilde: r(".dealer-date-tilde"),
          btn: { l: b.left, r: b.right, t: b.top, h: Math.round(b.height), fs: Math.round(parseFloat(c.fontSize) * 10) / 10, bg: c.backgroundColor.match(/\d+/g).map(Number), one: e.scrollWidth <= e.clientWidth + 1 },
          over: document.documentElement.scrollWidth > innerWidth };
      });
      await page.setViewportSize({ width: 1100, height: 900 });
      await page.waitForTimeout(250);   // ボタンの transition(0.15s)が終わってから測る
      const pc = await fbox();
      for (const w of [320, 360, 390, 430, 1100]) {
        await page.setViewportSize({ width: w, height: 900 });
        await page.waitForTimeout(250);
        const x = await fbox();
        assert.equal(x.over, false, `${w}: 横にはみ出さない`);
        assert.ok(x.head.b <= x.from.t + 0.5, `${w}: 「注文日」は入力欄の上`);
        assert.ok(Math.abs(x.from.t - x.to.t) < 1 && x.from.r <= x.tilde.l + 0.5 && x.tilde.r <= x.to.l + 0.5 && x.to.r <= x.row.r + 0.5, `${w}: 開始日 〜 終了日 が横並びで枠の中`);
        assert.ok(Math.abs(x.from.h - pc.from.h) < 1 && Math.abs(x.to.h - pc.to.h) < 1, `${w}: 入力欄の高さは PC と同じ`);
        assert.deepEqual([x.btn.h, x.btn.fs, x.btn.one], [36, 14.4, true], `${w}: 「検索」は高さ36px・0.9rem・1行`);
        assert.ok(x.btn.bg[2] > 150 && x.btn.bg[2] - x.btn.bg[0] > 80, `${w}: 「検索」は青`);
        assert.ok(x.btn.r <= x.row.r + 0.5, `${w}: 「検索」は枠の中`);
        const sameLine = x.btn.t < x.to.b && x.btn.t + x.btn.h > x.to.t;
        if (sameLine) assert.ok(x.to.r <= x.btn.l, `${w}: 同じ行なら終了日の右`);
        else assert.ok(x.btn.t >= x.to.b - 0.5, `${w}: 収まらなければ「検索」だけ次の行`);
        if (w >= 430) assert.ok(sameLine, `${w}: 1行に収まる`);
      }
      await page.setViewportSize({ width: 390, height: 900 });
      // 検索の動作: 日付を入力しただけでは検索しない。開始日だけ・終了日だけ・両方・なし(全期間)をそのまま送る。開始日 > 終了日 はエラーで検索しない
      let k = (await calls(page, "list")).length;
      assert.equal(k, (await calls(page, "list")).length, "入力だけでは検索しない");
      const searchWith = async (fromV, toV) => {
        await page.fill("#dealerFrom", fromV); await page.fill("#dealerTo", toV);
        const before = (await calls(page, "list")).length;
        await page.waitForTimeout(100);
        assert.equal((await calls(page, "list")).length, before, "入力だけでは検索しない");
        await page.click("#btnDealerSearch");
        await page.waitForFunction((n) => (window.__calls || []).filter(([, d]) => d.action === "list").length > n, before);
        const d = (await calls(page, "list")).at(-1);
        return [d.from ?? null, d.to ?? null, "orderNumber" in d];
      };
      assert.deepEqual(await searchWith("2026-10-01", ""), ["2026-10-01", null, false], "開始日だけ");
      assert.deepEqual(await searchWith("", "2026-10-31"), [null, "2026-10-31", false], "終了日だけ");
      assert.deepEqual(await searchWith("2026-10-01", "2026-10-31"), ["2026-10-01", "2026-10-31", false], "両方");
      assert.deepEqual(await searchWith("2026-10-31", "2026-10-31"), ["2026-10-31", "2026-10-31", false], "同じ日");
      assert.deepEqual(await searchWith("", ""), [null, null, false], "両方空 = 全期間");
      await page.fill("#dealerFrom", "2026-11-02"); await page.fill("#dealerTo", "2026-11-01");
      k = (await calls(page, "list")).length;
      await page.click("#btnDealerSearch");
      assert.match(await page.locator("#dealerListMsg").innerText(), /開始日は終了日より前/);
      assert.equal((await calls(page, "list")).length, k, "開始日 > 終了日 は検索しない");
      await page.fill("#dealerFrom", ""); await page.fill("#dealerTo", "");
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
      const rows = () => page.locator(".dealer-card").evaluateAll(rs => rs.map(r => r.dataset.receipt.replace(/^r-/, "")));
      // 施設Aだけで検索 → 続きあり
      await page.click('[data-select="none"]');
      await page.locator('[data-facility="fA"]').check();
      await page.click("#btnDealerSearch");
      await page.waitForFunction(() => document.querySelectorAll(".dealer-card").length === 1 && !document.querySelector("#btnDealerMore").hidden);
      // 注文日順の「もっと見る」も補助ボタンの大きさ(高さ36px・文字0.9rem・上下6px)
      assert.deepEqual(await page.locator("#btnDealerMore").evaluate((e) => { const c = getComputedStyle(e), b = e.getBoundingClientRect(); return [Math.round(b.height), Math.round(parseFloat(c.fontSize) * 10) / 10, c.paddingTop, c.paddingBottom, b.left >= 0 && b.right <= innerWidth, e.scrollWidth <= e.clientWidth + 1]; }), [36, 14.4, "6px", "6px", true, true]);
      // 施設を B に替える → 結果と続きを破棄。「さらに表示」は出ない(古い A の続きを読まない)
      await page.locator('[data-facility="fA"]').uncheck();
      await page.locator('[data-facility="fB"]').check();
      assert.equal(await page.locator("#btnDealerMore").isHidden(), true);
      assert.deepEqual(await rows(), []);
      assert.match(await page.locator("#dealerListMsg").innerText(), /条件を変更しました/);
      const n = (await listCalls()).length;
      await page.click("#btnDealerSearch");
      await page.waitForFunction((k) => (window.__calls || []).filter(([, d]) => d.action === "list").length === k + 1, n);
      await page.waitForFunction(() => document.querySelectorAll(".dealer-card").length === 1);
      const last = (await listCalls()).at(-1);
      assert.deepEqual([last.facilityFilter.facilityIds, "cursor" in last], [["fB"], false], "新しい条件で先頭から");
      assert.deepEqual(await rows(), ["fB-1"]);
      // 続き: 同じ条件のカーソルで
      await page.click("#btnDealerMore");
      await page.waitForFunction(() => document.querySelectorAll(".dealer-card").length === 2);
      assert.equal((await listCalls()).at(-1).cursor, "cur-fB");
      // 日付を入力しただけでは一覧も続きもそのまま(「検索」で反映)
      await page.fill("#dealerFrom", "2026-10-01");
      assert.equal(await page.locator("#btnDealerMore").isHidden(), true, "続きは読み終えている(表示はそのまま)");
      assert.deepEqual(await rows(), ["fB-1", "fB-2"], "日付の入力だけでは一覧を消さない");
      await page.fill("#dealerFrom", "");
      // 選択ボタンの変更では破棄
      for (const change of [
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
      await page.waitForFunction(() => /先頭から表示し直してください/.test(document.querySelector("#dealerListMsg").textContent));
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
    await openOrdered(page);
    assert.equal(await page.locator("#dealerCompany").innerText(), "ワイ医療");
    assert.deepEqual((await calls(page, "context"))[0], { action: "context", companyId: "dco-y" });
    assert.equal((await calls(page, "list"))[0].companyId, "dco-y");
    // 会社の切り替えはヘッダーの「☰」メニューから(2社以上のときだけ)
    await page.click("#btnHeaderMenu");
    assert.deepEqual(await page.locator("#headerMenuPanel .header-menu-item").allInnerTexts(), ["会社を切り替える", "使い方・ヘルプ", "ログアウト"]);
    assert.equal(await page.locator('[data-f="menuCompany"]').innerText(), "ワイ医療 東京支店");
    await page.click("#menuSwitchCompany");
    await page.getByText("会社の選択", { exact: true }).waitFor();
    await page.click("#btnHeaderMenu");
    assert.deepEqual(await page.locator("#headerMenuPanel .header-menu-item").allInnerTexts(), ["使い方・ヘルプ"], "会社の選択の画面: メニューは使い方・ヘルプだけ(ログアウトはカードのボタン)");
    assert.equal(await page.locator("#headerMenuPanel .header-menu-info").count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".dealer-card").count(), 0, "切り替えでは前の会社の表示を残さない");
    await context.close();
  } finally { await browser.close(); }
});

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`ディーラー画面のログイン: 上段に「Googleでログイン」(推奨・毎回アカウントを選択)、下段にメールリンク(代替)。キャンセル・ブロックの案内。スマートフォン/PC: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [320, 390, 1100]) {
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
        // 説明は見出し・各ログイン方法の見出しの右のⓘ(常時は表示しない)。ⓘを押すと同じ文言を表示し、外側を押すと閉じる
        const panelText = await page.locator("#dealerPanel").innerText();
        for (const t of ["医療機関から閲覧を許可された", "Google アカウント(Google Workspace など)", "ログイン用のリンクが届きます"]) assert.ok(!panelText.includes(t), `${width}: 「${t}」は常時表示しない`);
        assert.equal(await page.locator("#dealerPanel .feature-desc, #dealerPanel .dealer-login-block .form-hint").count(), 0, "見出しの下の説明文はない");
        await page.click("#btnHeaderMenu");
        assert.deepEqual(await page.locator("#headerMenuPanel .header-menu-item").allInnerTexts(), ["使い方・ヘルプ"], "ログイン前: メニューは使い方・ヘルプだけ");
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".app-header .header-title").innerText(), "受注一覧(ディーラー用)", "ログイン前の見出しはそのまま");
        assert.equal(await page.locator("#dealerCompany").isHidden(), true);
        const tips = [["#dealerPanel .feature-title-row", /医療機関から閲覧を許可された、自社宛ての注文を確認する画面です。招待された勤務先メールアドレスのアカウントでログインしてください。/],
          ['[data-login="accounts"] .dealer-login-head', /招待されたメールアドレスの Google アカウント.*確認コードで本人確認をします。/s],
          ['[data-login="email"] .dealer-login-head', /招待された勤務先メールアドレスを入力すると、ログイン用のリンクが届きます。/]];
        for (const [where, re] of tips) {
          const btn = page.locator(`${where} .info-tip-btn`);
          assert.equal(await btn.count(), 1, `${where}: ⓘ`);
          await btn.click();
          const pop = page.locator(`${where} .info-tip-pop`);
          assert.equal(await pop.isVisible(), true);
          assert.match(await pop.innerText(), re);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 説明を開いても横にはみ出さない`);
          await page.locator("#dealerPanel .feature-title").click();   // 外側で閉じる
          assert.equal(await pop.isVisible(), false);
        }
        // メールの見出しは入力欄のラベルのまま(押すと入力欄へ)。ⓘを押しても入力欄には移らない
        await page.locator('label[for="dealerEmail"]').click();
        assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "dealerEmail");
        await page.locator('[data-login="email"] .info-tip-btn').click();
        assert.notEqual(await page.evaluate(() => document.activeElement && document.activeElement.id), "dealerEmail");
        await page.keyboard.press("Escape");
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

test("ディーラー画面: 未ログインはメールリンクのログイン(戻り先は dealer.html。保存は医療機関の画面と別のキー・別の名前のアプリ)。本人確認の画面(参加・初めてのログイン方法・新しい端末で共通)。未招待・停止中は会社名・施設名を出さない(chromium)", async (t) => {
  const browser = await launch(chromium, "chromium");
  if (!browser) return t.skip("chromium を起動できません");
  try {
    // 未ログイン: メールリンク。医療機関の画面と別の名前の Firebase アプリ・別の保存キー(ログイン状態を分ける)
    let context = await newFakeContext(browser, base, 390, null);
    let page = await context.newPage();
    await installFakeServer(page, "staff");
    await page.goto(`${base}dealer.html`);
    await page.locator("#dealerEmail").waitFor();
    assert.deepEqual(await page.evaluate(() => window.__appNames), ["dealer-portal"]);
    await page.fill("#dealerEmail", "x1@corp.example.jp");
    await page.click("#btnDealerSendLink");
    await page.waitForFunction(() => (window.__linkSent || []).length === 1);
    assert.deepEqual(await page.evaluate(() => window.__linkSent[0]), ["x1@corp.example.jp", `${base.replace(/\/$/, "")}/dealer.html`]);
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem("iol_dealer_emaillink_pending"), localStorage.getItem("iol_order_emaillink_pending")]), ["x1@corp.example.jp", null]);
    assert.deepEqual(await calls(page, "context"), [], "ログイン前はサーバーに問い合わせない");
    await context.close();

    // 本人確認(未確認の認証主体): 会社の情報を出さない → 送り先はサーバーが決める → 違うコードは拒否 → コードで確認 → 受注一覧。端末の値を保存して以後の呼び出しに付ける
    context = await newFakeContext(browser, base, 390, STAFF);
    page = await context.newPage();
    await installFakeServer(page, "unverified");
    await page.goto(`${base}dealer.html`);
    await page.getByText("本人確認", { exact: true }).waitFor();
    assert.ok(!/エックス商事|B眼科|A眼科|IOL-2026/.test(await page.locator("main").innerText()), "確認するまで会社名・施設名を出さない");
    assert.equal(await page.locator('[data-act="signout"]').count(), 1);
    await page.click("#btnHeaderMenu");
    assert.deepEqual(await page.locator("#headerMenuPanel .header-menu-item").allInnerTexts(), ["使い方・ヘルプ"], "本人確認の間: メニューは使い方・ヘルプだけ(会社名も出さない)");
    assert.equal(await page.locator("#headerMenuPanel .header-menu-info").count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator('[data-act="later"]').count(), 0);
    assert.equal(await page.locator('[data-f="code"]').isVisible(), false, "コード欄は送るまで出さない");
    await page.click('[data-act="sendCode"]');
    await page.getByText(/確認コードを送りました\(10分間有効\)/).waitFor();
    assert.deepEqual(await calls(page, "sendCode"), [{ action: "sendCode" }], "送り先は画面から送らない");
    await page.fill('[data-f="code"]', "00000000");
    await page.click('[data-act="verifyCode"]');
    await page.getByText(/確認コードが違います/).waitFor();
    assert.deepEqual(await calls(page, "context"), []);
    await page.fill('[data-f="code"]', "1234 5678");
    await page.click('[data-act="verifyCode"]');
    await openOrdered(page);
    assert.deepEqual((await calls(page, "verifyCode")).at(-1), { action: "verifyCode", code: "12345678" });
    assert.deepEqual(await deviceStored(page), [[4, "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"]], "UID だけでなく、ログイン方法・主体ごとのキーに保存");
    assert.equal(await page.evaluate(() => localStorage.getItem("iolDealerDevice.x1")), null, "UID だけのキーは使わない");
    assert.equal((await calls(page, "list")).at(-1).deviceToken, "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", "以後の呼び出しに端末の値を付ける");
    // 連携・解除の画面はない
    for (const sel of ['[data-act="linkMicrosoft"]', '[data-act="unlinkMicrosoft"]', ".dealer-ms-link"]) assert.equal(await page.locator(sel).count(), 0, sel);
    await context.close();

    // 新しい参加の案内(確認済みの会社がある): 参加の確認を出す。「あとで」で受注一覧へ
    context = await newFakeContext(browser, base, 390, STAFF);
    page = await context.newPage();
    await installFakeServer(page, "pendingInvite");
    await page.goto(`${base}dealer.html`);
    await page.getByText("参加の確認", { exact: true }).waitFor();
    await page.click('[data-act="later"]');
    await openOrdered(page);
    await context.close();

    // AB-04: 端末の値を保存できないブラウザでも、確認の直後から(この画面の間は)使える。保存できなかったことを伝える
    context = await newFakeContext(browser, base, 390, STAFF);
    page = await context.newPage();
    await page.addInitScript(() => { const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith("iolDealerDevice.")) throw new Error("QuotaExceededError"); return orig.call(this, k, v); }; });
    await installFakeServer(page, "unverified");
    await page.goto(`${base}dealer.html`);
    await page.getByText("本人確認", { exact: true }).waitFor();
    await page.click('[data-act="sendCode"]');
    await page.fill('[data-f="code"]', "12345678");
    await page.click('[data-act="verifyCode"]');
    await openOrdered(page);
    assert.equal((await calls(page, "list")).at(-1).deviceToken, "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", "メモリに持った値を付ける");
    assert.deepEqual(await deviceStored(page), []);
    assert.equal(await page.locator('[data-notice="device-not-saved"]').count(), 1);
    await context.close();

    // 「この端末を記憶する」を外す(共用のパソコン): 確認の後もこの画面の間だけ使い、端末には保存しない。保存できなかった旨の案内も出さない
    context = await newFakeContext(browser, base, 390, STAFF);
    page = await context.newPage();
    await installFakeServer(page, "unverified");
    await page.goto(`${base}dealer.html`);
    await page.getByText("本人確認", { exact: true }).waitFor();
    await page.click('[data-act="sendCode"]');
    assert.equal(await page.locator('[data-f="remember"]').isChecked(), true, "既定は記憶する");
    await page.uncheck('[data-f="remember"]');
    await page.fill('[data-f="code"]', "12345678");
    await page.click('[data-act="verifyCode"]');
    await openOrdered(page);
    assert.equal((await calls(page, "list")).at(-1).deviceToken, "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD");
    assert.deepEqual(await deviceStored(page), [], "記憶しない");
    assert.equal(await page.locator('[data-notice="device-not-saved"]').count(), 0);
    await context.close();

    // AB-04: localStorage の取得そのものが拒否される(SecurityError)ブラウザでも起動し、本人確認から受注一覧まで進める
    context = await newFakeContext(browser, base, 390, STAFF);
    page = await context.newPage();
    await page.addInitScript(() => { Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } }); });
    const bootErrors = [];
    page.on("pageerror", e => bootErrors.push(String(e)));
    await installFakeServer(page, "unverified");
    await page.goto(`${base}dealer.html`);
    await page.getByText("本人確認", { exact: true }).waitFor();
    await page.click('[data-act="sendCode"]');
    await page.fill('[data-f="code"]', "12345678");
    await page.click('[data-act="verifyCode"]');
    await openOrdered(page);
    assert.equal((await calls(page, "list")).at(-1).deviceToken, "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", "メモリの値で使える");
    assert.equal(await page.locator('[data-notice="device-not-saved"]').count(), 1);
    assert.deepEqual(bootErrors, []);
    await context.close();

    // 未招待(承認済みのメールでないアカウントを含む): 応答は同じ(届かない場合の案内)で、確認できず、会社の情報は出さない
    context = await newFakeContext(browser, base, 390, STAFF);
    page = await context.newPage();
    await installFakeServer(page, "none");
    await page.goto(`${base}dealer.html`);
    await page.getByText("本人確認", { exact: true }).waitFor();
    await page.click('[data-act="sendCode"]');
    await page.getByText(/確認コードを送りました/).waitFor();
    // 届かない場合の案内は見出しのⓘ(未招待でも同じ応答)
    await page.locator(".dealer-verify-title .info-tip-btn").click();
    await page.getByText(/届かない場合は、招待されたメールアドレスのアカウントでログインしているか確かめてください/).waitFor();
    await page.keyboard.press("Escape");
    await page.fill('[data-f="code"]', "12345678");
    await page.click('[data-act="verifyCode"]');
    await page.getByText(/確認コードが違います/).waitFor();
    assert.ok(!/エックス商事|B眼科|A眼科|IOL-2026/.test(await page.locator("main").innerText()));
    assert.equal(await page.locator(".dealer-card").count(), 0);
    await context.close();

    // 機能の停止中: Google などでログインできても(認証はスイッチで止まらない)、サーバーがすべて拒否し、会社・施設・注文は何も出ない
    context = await newFakeContext(browser, base, 390, STAFF);
    page = await context.newPage();
    await installFakeServer(page, "disabled");
    await page.goto(`${base}dealer.html`);
    await page.getByText("ディーラー画面は現在ご利用いただけません").waitFor();
    assert.ok(!/エックス商事|B眼科|A眼科|IOL-2026/.test(await page.locator("main").innerText()));
    assert.equal(await page.locator(".dealer-card").count(), 0);
    assert.equal(await page.locator('[data-act="signout"]').count(), 1);
    await context.close();
  } finally { await browser.close(); }
});

import { mondayOf, jstDate as jstDateOfDealer, weekSpanLabel, weekStartLabel, addDays as addDaysOf } from "../../src/domain/dealer-portal.js";
for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`ディーラー画面の手術日順: 今週から手術日の昇順に連続(週の区切り → 手術日 → 医療機関 → レンズ行)。上下に週を追加(予定のない週は最大4週まで探し、さらに続きも探せる)、上に足しても位置を保つ、一部だけの週を明示、行から受注詳細(戻ると位置を保つ)。注文日順のカード。320/390/430/PC: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const context = await newFakeContext(browser, base, 390, STAFF);
      const page = await context.newPage();
      await installFakeServer(page, "staff");
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(`${base}dealer.html`);
      await page.locator("#dealerSurgery .history-lens-btn").first().waitFor();
      const thisWeek = mondayOf(jstDateOfDealer(Date.now()));
      const day = (ws, n) => addDaysOf(ws, n);
      const rowKeys = () => page.locator("#dealerSurgery .history-lens-btn").evaluateAll(bs => bs.map(b => `${b.dataset.receipt}@${b.dataset.date}#${b.dataset.line}`));
      const weekCalls = async () => (await calls(page, "week")).map(d => d.weekStart);
      // 初期表示: 手術日順・今週・翌週・翌々週の3週(担当施設 B だけ。並行して読み、手術日の昇順に連続)。週の切替ボタン(前週・翌週・今週)はない
      assert.deepEqual(await page.locator("[data-view]").evaluateAll(bs => bs.map(b => [b.textContent, b.getAttribute("aria-pressed")])), [["注文日順", "false"], ["手術日順", "true"]]);
      assert.equal(await page.locator("[data-week='next'], [data-week='prev'], [data-week='this'], #dealerWeekLabel").count(), 0, "週単位の切替はない");
      const first3 = (await calls(page, "week")).slice(0, 3);
      assert.deepEqual(first3.map(d => d.weekStart).sort(), [0, 7, 14].map(k => day(thisWeek, k)), "初期表示は今週から3週");
      assert.equal((await calls(page, "week")).length, 3, "初期表示で読むのは3週だけ");
      assert.ok(first3.every(d => JSON.stringify(d.facilityFilter) === JSON.stringify({ mode: "selected", facilityIds: ["fB"] })), "担当施設");
      assert.deepEqual(await page.locator(".dealer-week-head").evaluateAll(hs => hs.map(h => h.dataset.week)), [0, 7, 14].map(k => day(thisWeek, k)), "週の区切りは3つ(早い順)");
      assert.equal((await page.locator(".dealer-week-head").first().innerText()).trim(), weekStartLabel(thisWeek), "週の区切りは開始日(月曜)だけ「11月9日の週」");
      assert.match((await page.locator(".dealer-week-head > span").first().innerText()).trim(), /^(\d{4}年)?\d{1,2}月\d{1,2}日の週$/, "期間(〜)は出さない");
      assert.deepEqual(await rowKeys(), [0, 7, 14].flatMap(k => [`rcp-c@${day(thisWeek, k + 1)}#1`, `rcp-b@${day(thisWeek, k + 3)}#1`]), "担当施設(B)の注文だけ・手術日の昇順");
      // チェックしている施設が1つ(閲覧できる施設は2つ): 手術日の下の医療機関名は省略。手術日・明細・担当医・週の区切りはそのまま
      assert.equal(await page.locator("#dealerSurgery .dealer-day-facility-name").count(), 0, "1施設の選択では医療機関名を出さない");
      assert.ok(await page.locator("#dealerSurgery .history-day .history-card-head").count() > 0 && await page.locator("#dealerSurgery .history-lens-doctor").count() === 6);
      // すべての施設: 各週の火曜(A の2行・B の1行)・木曜(B)。手術日 → 医療機関 → レンズ行(左にモデル・度数・枚数、右に担当医名。メーカー名は出さない)
      await page.click('[data-select="all"]');
      await page.waitForFunction(() => document.querySelectorAll("#dealerSurgery .history-lens-btn").length === 12);
      assert.deepEqual(await page.locator("#dealerSurgery .history-day").evaluateAll(ds => ds.map(d => d.dataset.day)), [0, 7, 14].flatMap(k => [day(thisWeek, k + 1), day(thisWeek, k + 3)]), "手術日の昇順");
      const tue = page.locator(`#dealerSurgery .history-day[data-day="${day(thisWeek, 1)}"]`);
      assert.deepEqual(await tue.locator(".dealer-day-facility-name").allInnerTexts(), ['<img src=x onerror="window.__xss=1">A眼科', "B眼科"], "同じ手術日の中は医療機関ごと(施設名の HTML は文字のまま)");
      assert.deepEqual((await tue.locator(".history-lens-btn").allInnerTexts()).map(x => x.replace(/\s+/g, " ").trim()),
        ["DIB00V +21.0D 2枚 山田Dr", "DIW300 +18.5D 1枚 <b>佐藤</b>Dr", "DIB00V +21.0D 2枚 内田Dr"], "トーリックはトーリック型番。別の注文の同じレンズは合算しない");
      // 選択を1施設に戻すと、医療機関名の小見出しも自動で消える。再び2施設にすると出る
      await page.click('[data-select="assigned"]');
      await page.waitForFunction(() => document.querySelectorAll("#dealerSurgery .history-lens-btn").length === 6);
      assert.equal(await page.locator("#dealerSurgery .dealer-day-facility-name").count(), 0, "1施設に戻すと省略");
      await page.click('[data-select="all"]');
      await page.waitForFunction(() => document.querySelectorAll("#dealerSurgery .history-lens-btn").length === 12 && document.querySelector("#dealerSurgery .dealer-day-facility-name"));
      assert.equal(await page.locator("#dealerSurgery .summary-maker, #dealerSurgery img, #dealerSurgery b").count(), 0, "メーカー名を出さない・HTML を解釈しない");
      // 下の「もっと見る」: 4週目(3週の次)を読んで下に足す
      await page.click('#dealerSurgery [data-act="more"]');
      await page.waitForFunction(() => document.querySelectorAll("#dealerSurgery .dealer-week-head").length === 4);
      assert.deepEqual((await weekCalls()).slice(-1), [day(thisWeek, 21)]);
      assert.deepEqual(await page.locator(".dealer-week-head").evaluateAll(hs => hs.map(h => h.dataset.week)), [0, 7, 14, 21].map(k => day(thisWeek, k)));
      // 予定のない週: 1回で最大4週まで探し、見つからなければ案内(区切りは1行にまとめる)。もう一度押すとさらに先を探せる
      await page.evaluate((w) => { window.__weekData = { [w]: true }; }, day(thisWeek, 56));
      let n = (await weekCalls()).length;
      await page.click('#dealerSurgery [data-act="more"]');
      await page.locator('.dealer-surgery-note[data-note="down"]').waitFor();
      assert.deepEqual((await weekCalls()).slice(n), [28, 35, 42, 49].map(k => day(thisWeek, k)), "4週まで探す");
      assert.match(await page.locator('.dealer-surgery-note[data-note="down"]').innerText(), /に手術予定の受注はありません。「もっと見る」で、さらに先を探せます。$/);
      assert.equal(await page.locator(".dealer-week-empty").count(), 1, "予定のない4週は1行にまとめる");
      n = (await weekCalls()).length;
      await page.click('#dealerSurgery [data-act="more"]');
      await page.waitForFunction((w) => document.querySelector(`.dealer-week-head[data-week="${w}"]`), day(thisWeek, 56));
      assert.deepEqual((await weekCalls()).slice(n), [day(thisWeek, 56)], "見つかったら止める");
      assert.equal(await page.locator('.dealer-surgery-note[data-note="down"]').count(), 0);
      // 初期表示の3週に予定のない週が含まれる: 予定のない週はそのまま1行で示し、予定のある週は区切りと明細(読むのは3週だけ)
      const reopen = async () => {
        await page.click('[data-view="ordered"]');
        await page.locator(".dealer-card").first().waitFor();
        const k = (await weekCalls()).length;
        await page.click('[data-view="surgery"]');
        await page.waitForFunction((k) => (window.__calls || []).filter(([, d]) => d.action === "week").length >= k + 3 && document.querySelector('#dealerSurgery [data-act="more"]:not([disabled])'), k);
        return k;
      };
      await page.evaluate((w) => { window.__weekData = { [w]: true }; }, day(thisWeek, 7));
      n = await reopen();
      assert.deepEqual((await weekCalls()).slice(n).sort(), [0, 7, 14].map(k => day(thisWeek, k)));
      assert.deepEqual(await page.locator("#dealerSurgery .dealer-surgery-list > li").evaluateAll(ls => ls.map(l => [l.className, l.dataset.week || l.dataset.day || ""])).then(x => x.filter(([c]) => c !== "history-day")),
        [["dealer-week-empty", day(thisWeek, 0)], ["dealer-week-head", day(thisWeek, 7)], ["dealer-week-empty", day(thisWeek, 14)]], "今週・翌々週は予定なしの1行、翌週は区切りと明細");
      assert.equal(await page.locator(".dealer-week-empty").first().innerText(), `${weekSpanLabel(thisWeek)}: 手術予定の受注はありません`, "予定のない週の案内は期間を明示したまま");
      assert.equal(await page.locator('.dealer-surgery-note[data-note="down"]').count(), 0, "予定のある週があれば案内は出さない");
      // 3週とも予定なし: 1行にまとめて案内し、「もっと見る」で先を探せる
      await page.evaluate(() => { window.__weekData = {}; });
      n = await reopen();
      assert.equal((await weekCalls()).length - n, 3, "初期表示は3週だけ読む(予定がなくても先を自動で探さない)");
      assert.equal(await page.locator(".dealer-week-empty").count(), 1);
      assert.match(await page.locator('.dealer-surgery-note[data-note="down"]').innerText(), /に手術予定の受注はありません。「もっと見る」で、さらに先を探せます。$/);
      assert.equal(await page.locator('#dealerSurgery [data-act="more"]').isEnabled(), true);
      // 元の予定に戻して読み直す(以下の確認のため)
      await page.evaluate(() => { window.__weekData = null; });
      await reopen();
      // 上の「過去の注文をもっと見る」: 前の週を上に足しても、見ているカードの位置を保つ。件数の多い週は一部だけと明示
      await page.evaluate((w) => { window.__weekData = null; window.__weekTruncated = { [w]: true }; window.scrollTo(0, 0); }, day(thisWeek, -7));
      const first = page.locator("#dealerSurgery .history-lens-btn").first();
      const key = await first.evaluate(b => [b.dataset.receipt, b.dataset.date, b.dataset.line]);
      const before = await first.evaluate(b => b.getBoundingClientRect().top);
      await page.click('#dealerSurgery [data-act="more-past"]');
      await page.waitForFunction((w) => document.querySelector(`.dealer-week-head[data-week="${w}"]`), day(thisWeek, -7));
      const after = await page.locator(`#dealerSurgery .history-lens-btn[data-receipt="${key[0]}"][data-date="${key[1]}"][data-line="${key[2]}"]`).evaluate(b => b.getBoundingClientRect().top);
      assert.ok(Math.abs(after - before) <= 2, `上に足しても位置を保つ: ${before} → ${after}`);
      assert.match(await page.locator(`.dealer-week-head[data-week="${day(thisWeek, -7)}"] .dealer-week-truncated`).innerText(), /一部だけを表示しています/, "1週の上限に達した週は明示する");
      const days = await page.locator("#dealerSurgery .history-day").evaluateAll(ds => ds.map(d => d.dataset.day));
      assert.deepEqual([...days].sort(), days, "上下に足しても手術日の昇順");
      assert.equal(new Set(await rowKeys()).size, (await rowKeys()).length, "重複なし");
      // 行から受注詳細 → 戻ると、読み込み済みの一覧とスクロール位置を保つ
      await page.evaluate(() => window.scrollTo(0, 400));
      const y = await page.evaluate(() => window.scrollY);
      const count = (await rowKeys()).length;
      await page.locator(`#dealerSurgery .history-lens-btn[data-receipt="rcp-c"]`).first().click();
      await page.locator(".dealer-lines tbody tr").first().waitFor();
      assert.equal(await page.locator(".dealer-lines").innerText().then(t => t.includes("J&J")), true, "詳細はメーカー名を表示");
      await page.click('[data-act="back"]');
      assert.equal((await rowKeys()).length, count);
      assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - y) <= 2, "スクロール位置を保つ");
      // 320/390/430/PC: レンズ行の明細と担当医名が重ならず、横にはみ出さない
      for (const w of [320, 390, 430, 1100]) {
        await page.setViewportSize({ width: w, height: 900 });
        const lay = await page.locator("#dealerSurgery .history-lens-row").evaluateAll(rs => rs.map(r => { const m = r.querySelector(".history-lens-main").getBoundingClientRect(), d = r.querySelector(".history-lens-side").getBoundingClientRect(); return [d.left - m.right, d.right - r.getBoundingClientRect().right]; }));
        assert.ok(lay.every(([gap, out]) => gap >= 0 && out <= 0.5), `${w}: ${JSON.stringify(lay.slice(0, 3))}`);
        // 「過去の注文をもっと見る」「もっと見る」: 補助ボタンの大きさ(高さ36px・文字0.9rem・上下6px。幅は文字に合わせ、はみ出さない)。スマホ・PCで同じ
        for (const act of ["more-past", "more"]) assert.deepEqual(await page.locator(`#dealerSurgery [data-act="${act}"]`).evaluate((e) => { const c = getComputedStyle(e), b = e.getBoundingClientRect(); return [Math.round(b.height), Math.round(parseFloat(c.fontSize) * 10) / 10, c.paddingTop, c.paddingBottom, b.left >= 0 && b.right <= innerWidth, e.scrollWidth <= e.clientWidth + 1]; }), [36, 14.4, "6px", "6px", true, true], `${w}: ${act}`);
        assert.ok(await page.locator('#dealerSurgery [data-act="more"]').evaluate(e => e.getBoundingClientRect().width < innerWidth * 0.8), `${w}: 幅は文字に合わせる`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${w}: 横にはみ出さない`);
      }
      await page.setViewportSize({ width: 390, height: 900 });
      // 注文日順: 1注文1カード(先頭に注文番号・医療機関名、その下に手術日ごとのレンズ行)。カードから受注詳細
      await page.click('[data-view="ordered"]');
      await page.locator(".dealer-card").first().waitFor();
      assert.equal(await page.locator("#dealerSurgeryArea").isHidden(), true);
      assert.deepEqual((await page.locator(".dealer-card").allInnerTexts()).map(x => x.replace(/\s+/g, " ").trim()), [
        "IOL-20261027-02 B眼科 11/9(月) DIB00V +20.0D 1枚 とても長い名前の担当医の先生Dr",
        'IOL-20261027-01 <img src=x onerror="window.__xss=1">A眼科 11/6(金) DIB00V +21.0D 2枚 山田Dr DIW300 +18.5D 1枚 <b>佐藤</b>Dr']);
      assert.equal(await page.locator("#dealerResults .summary-maker, #dealerResults img, #dealerResults b").count(), 0);
      for (const w of [320, 430]) {
        await page.setViewportSize({ width: w, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${w}: 注文日順も横にはみ出さない`);
      }
      // 手術日順へ戻すと、今週から読み直す
      n = (await weekCalls()).length;
      await page.click('[data-view="surgery"]');
      await page.waitForFunction((k) => (window.__calls || []).filter(([, d]) => d.action === "week").length > k, n);
      assert.equal((await weekCalls())[n], thisWeek);
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      assert.deepEqual(errors, []);
      await context.close();
    } finally { await browser.close(); }
  });
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`ディーラー画面の「担当者・支店」: ☰メニューの「ディーラー設定」(会社管理者・支店管理者だけ)から開き、受注一覧に戻ると状態が残る。支店の絞り込み・役割に合わせた操作・招待・編集・支店の追加/名称変更/無効化。ⓘで説明。320/390/PCで重ならない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      // 閲覧者: 「ディーラー設定」を出さない(切り替えのタブもない)。管理の API も呼ばない
      let context = await newFakeContext(browser, base, 390, STAFF);
      let page = await context.newPage();
      await installFakeServer(page, "staff");
      await page.goto(`${base}dealer.html`);
      await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "week") && document.querySelector('#dealerSurgery [data-act="more"]:not([disabled])'));   // 週表示を読み終えた(該当ありのときは案内の文は空)
      await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "week"));
      assert.equal(await page.locator("[data-tab], .dealer-tabs, #dealerSettings").count(), 0, "閲覧者には管理の画面を出さない");
      await page.click("#btnHeaderMenu");
      assert.deepEqual(await page.locator("#headerMenuPanel .header-menu-item").allInnerTexts(), ["使い方・ヘルプ", "ログアウト"]);
      assert.deepEqual(await calls(page, "manage"), []);
      await context.close();

      for (const width of [320, 390, 1100]) {
        context = await newFakeContext(browser, base, width, STAFF);
        page = await context.newPage();
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        page.on("dialog", d => d.accept());
        await installFakeServer(page, "companyAdmin");
        await page.goto(`${base}dealer.html`);
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "week"));
        assert.equal(await page.locator("[data-tab], .dealer-tabs").count(), 0, "「受注一覧／担当者・支店」の切り替えはない");
        assert.equal(await page.locator(".dealer-view [data-view]").count(), 2, "「手術週／一覧表示」は残す");
        // 一覧表示に切り替えてから設定を開き、戻ったときに残っているか確かめる
        await page.click('[data-view="ordered"]');
        await page.locator(".dealer-card").first().waitFor();
        await page.mouse.move(0, 0);
        // ☰メニューの「ディーラー設定」(会社管理者): 施設設定と同じ見出しの行(見出し・ⓘ・受注一覧に戻る)
        await page.click("#btnHeaderMenu");
        assert.deepEqual(await page.locator("#headerMenuPanel .header-menu-item").allInnerTexts(), ["ディーラー設定", "使い方・ヘルプ", "ログアウト"]);
        await page.click("#menuDealerSettings");
        await page.locator(".dealer-manage-staff").first().waitFor();
        assert.equal(await page.locator("#dealerPanel").isVisible(), false, "受注一覧は隠す");
        assert.equal(await page.locator("#dealerSettings .settings-head h2").innerText(), "ディーラー設定");
        assert.equal(await page.locator("#dealerSettings .settings-head .info-tip-btn").count(), 1);
        assert.equal(await page.locator("#btnDealerSettingsClose").innerText(), "受注一覧に戻る");
        assert.deepEqual(await page.locator("#btnDealerSettingsClose").evaluate(e => [e.getBoundingClientRect().height, Math.round(parseFloat(getComputedStyle(e).fontSize) * 10) / 10]), [36, 14.4], "受注一覧に戻る の高さ");
        assert.equal(await page.locator(".app-header .header-title").innerText(), "受注一覧");
        assert.equal(await page.locator("#dealerCompany").innerText(), "エックス商事", "ヘッダーは「受注一覧」と会社名");
        const names = () => page.locator(".dealer-manage-staff .dealer-manage-name").allInnerTexts();
        const filter = page.locator('[data-f="branchFilter"]');
        assert.deepEqual(await filter.locator("option").allInnerTexts(), ["すべての支店", "支店未設定", "東京支店", "大阪支店"]);
        assert.equal(await filter.inputValue(), "all");
        assert.equal((await names()).length, 6);
        await filter.selectOption("b-osaka");
        assert.deepEqual(await names(), ["大阪の会社管理者", "大阪の支店管理者"]);
        await filter.selectOption("none");
        assert.deepEqual(await names(), ["r2-very-long-address-for-wrapping@corp.example.jp"]);
        await filter.selectOption("all");
        // 説明はⓘ(常時は表示しない)
        assert.equal(await page.locator('.dealer-manage [data-section="staff"] .settings-heading .info-tip-btn').count(), 1);
        assert.ok(!(await page.locator(".dealer-manage").innerText()).includes("注文を閲覧できる範囲は会社単位"), "説明は常時表示しない");
        // 会社管理者の操作: 自分は編集だけ(役割・無効化なし)。他の支店管理者は無効化・役割の変更(会社管理者を含む)ができる
        const row = (id) => page.locator(`.dealer-manage-staff[data-staff="${id}"]`);
        assert.ok(!(await page.locator(".dealer-manage").innerText()).includes("active"), "有効の状態は表示しない");
        assert.deepEqual(await row("s-me").locator("button").allInnerTexts(), ["編集"]);
        assert.deepEqual(await row("s-badm").locator("button").allInnerTexts(), ["編集", "無効にする"]);
        assert.deepEqual(await row("s-inv").locator("button").allInnerTexts(), ["招待を取り消す"]);
        await row("s-badm").locator('[data-act="edit"]').click();
        assert.deepEqual(await row("s-badm").locator('[data-f="editRole"] option').allInnerTexts(), ["閲覧者", "支店管理者", "会社管理者"]);
        await row("s-badm").locator('[data-act="cancelEdit"]').click();
        await row("s-me").locator('[data-act="edit"]').click();
        assert.equal(await row("s-me").locator('[data-f="editRole"]').count(), 0, "自分の役割は変えられない");
        await row("s-me").locator('[data-act="cancelEdit"]').click();
        // 所属支店の変更(閲覧者を大阪へ)
        await row("s-r1").locator('[data-act="edit"]').click();
        await row("s-r1").locator('[data-f="editBranch"]').selectOption("b-osaka");
        await row("s-r1").locator('[data-act="saveStaff"]').click();
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "manageUpdateStaff"));
        const upd = (await calls(page, "manageUpdateStaff")).at(-1);
        assert.deepEqual([upd.staffId, upd.branchId, upd.role, upd.facilityIds, upd.companyId], ["s-r1", "b-osaka", undefined, undefined, "dco-x"]);
        // 担当施設(許可された施設だけが候補。名称は文字として表示)
        await row("s-r1").locator('[data-f="assigned"]').waitFor();
        assert.equal(await row("s-r1").locator('[data-f="assigned"]').innerText(), "担当施設: B眼科");
        await row("s-r1").locator('[data-act="edit"]').click();
        assert.deepEqual(await row("s-r1").locator('[data-f="editFacility"]').evaluateAll(cs => cs.map(c => [c.value, c.checked])), [["fB", true], ["fA", false]]);
        await row("s-r1").locator('[data-f="editFacility"][value="fA"]').check();
        await row("s-r1").locator('[data-act="saveStaff"]').click();
        await page.waitForFunction(() => (window.__calls || []).filter(([, d]) => d.action === "manageUpdateStaff").length >= 2);
        const asg = (await calls(page, "manageUpdateStaff")).at(-1);
        assert.deepEqual([asg.staffId, asg.facilityIds, asg.branchId, asg.name], ["s-r1", ["fB", "fA"], undefined, undefined]);
        assert.equal(await page.evaluate(() => window.__xss), undefined, "施設名を HTML として解釈しない");
        // 招待(支店管理者・大阪支店)
        await page.locator(".dealer-manage-invite summary").click();
        await page.fill('[data-f="inviteEmail"]', "new@corp.example.jp");
        await page.selectOption('[data-f="inviteRole"]', "branchAdmin");
        await page.selectOption('[data-f="inviteBranch"]', "b-osaka");
        await page.click('[data-act="invite"]');
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "manageInvite"));
        const inv = (await calls(page, "manageInvite")).at(-1);
        assert.deepEqual([inv.email, inv.role, inv.branchId], ["new@corp.example.jp", "branchAdmin", "b-osaka"]);
        // 支店: 追加・名称変更・無効化
        await page.fill('[data-f="newBranch"]', "名古屋支店");
        await page.click('[data-act="addBranch"]');
        await page.locator('.dealer-manage-branch[data-branch="b-名古屋支店"]').waitFor();
        await page.locator('.dealer-manage-branch[data-branch="b-osaka"] [data-act="renameBranch"]').click();
        await page.fill('.dealer-manage-branch[data-branch="b-osaka"] [data-f="branchName"]', "大阪支社");
        await page.click('.dealer-manage-branch[data-branch="b-osaka"] [data-act="saveBranch"]');
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "manageBranch" && d.name === "大阪支社"));
        await page.locator('.dealer-manage-branch[data-branch="b-名古屋支店"] [data-act="toggleBranch"]').click();
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "manageBranch" && d.status === "inactive"));
        // 重ならない・はみ出さない
        const overlap = await page.locator(".dealer-manage-staff").evaluateAll(rs => rs.some(r => {
          const els = [...r.querySelectorAll(".dealer-manage-head > *, .dealer-manage-sub, .dealer-manage-actions > *")].map(e => e.getBoundingClientRect());
          return els.some((a, i) => els.some((b, j) => j > i && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5));
        }));
        assert.equal(overlap, false, `${width}: 文字が重ならない`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 横にはみ出さない`);
        // 受注一覧に戻る(一覧表示のまま。もう一度開いても読み直さない)
        await page.click("#btnDealerSettingsClose");
        assert.equal(await page.locator("#dealerSettings").isVisible(), false);
        assert.equal(await page.locator("#dealerOrderedArea").isVisible(), true, "戻ると一覧表示のまま");
        assert.equal(await page.locator('[data-view="ordered"]').getAttribute("aria-pressed"), "true");
        assert.ok(await page.locator(".dealer-card").count() > 0);
        const manageCalls = (await calls(page, "manage")).length;
        await page.click("#btnHeaderMenu");
        await page.click("#menuDealerSettings");
        assert.equal(await page.locator("#dealerSettings").isVisible(), true);
        assert.equal((await calls(page, "manage")).length, manageCalls, "開き直しでは読み直さない");
        await page.click("#btnDealerSettingsClose");
        assert.deepEqual(errors, []);
        await context.close();
      }

      // 支店管理者: タブは「担当者」。自分の支店(東京)の担当者だけ、支店の管理・絞り込みなし。閲覧者は氏名・担当施設・無効化(役割・支店は変えない)。
      // 招待は東京支店の閲覧者に固定(役割・支店を選ばない)
      for (const width of [320, 390]) {
        context = await newFakeContext(browser, base, width, STAFF);
        page = await context.newPage();
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await installFakeServer(page, "branchAdmin");
        await page.goto(`${base}dealer.html`);
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "week"));
        await page.click("#btnHeaderMenu");
        assert.deepEqual(await page.locator("#headerMenuPanel .header-menu-item").allInnerTexts(), ["ディーラー設定", "使い方・ヘルプ", "ログアウト"], "支店管理者も「ディーラー設定」");
        await page.click("#menuDealerSettings");
        await page.locator(".dealer-manage-staff").first().waitFor();
        const row = (id) => page.locator(`.dealer-manage-staff[data-staff="${id}"]`);
        assert.deepEqual(await page.locator(".dealer-manage-staff").evaluateAll(rs => rs.map(r => r.dataset.staff).sort()), ["s-inv", "s-me", "s-r1"]);
        assert.equal(await page.locator('[data-f="branchFilter"]').count(), 0);
        assert.equal(await page.locator('[data-section="branches"], [data-act="addBranch"], [data-act="renameBranch"]').count(), 0, "支店の管理は会社管理者だけ");
        assert.ok((await page.locator('.dealer-manage [data-section="staff"] .settings-heading').innerText()).includes("東京支店"));
        assert.deepEqual(await row("s-me").locator("button").allInnerTexts(), ["編集"]);
        assert.deepEqual(await row("s-r1").locator("button").allInnerTexts(), ["編集", "無効にする"]);
        assert.deepEqual(await row("s-inv").locator("button").allInnerTexts(), ["招待を取り消す"]);
        await row("s-r1").locator('[data-act="edit"]').click();
        assert.equal(await row("s-r1").locator('[data-f="editRole"], [data-f="editBranch"]').count(), 0, "役割・所属支店は変えない");
        await row("s-r1").locator('[data-f="editFacility"][value="fB"]').uncheck();
        await row("s-r1").locator('[data-act="saveStaff"]').click();
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "manageUpdateStaff"));
        const upd = (await calls(page, "manageUpdateStaff")).at(-1);
        assert.deepEqual([upd.staffId, upd.facilityIds, upd.branchId, upd.role], ["s-r1", [], undefined, undefined]);
        await page.locator(".dealer-manage-invite summary").click();
        assert.equal(await page.locator('[data-f="inviteRole"], [data-f="inviteBranch"]').count(), 0);
        assert.ok((await page.locator(".dealer-manage-invite").innerText()).includes("東京支店 の閲覧者として招待します。"));
        await page.fill('[data-f="inviteEmail"]', "new@corp.example.jp");
        await page.click('[data-act="invite"]');
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "manageInvite"));
        const inv = (await calls(page, "manageInvite")).at(-1);
        assert.deepEqual([inv.email, inv.role, inv.branchId], ["new@corp.example.jp", "reader", "b-tokyo"]);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 横にはみ出さない`);
        assert.deepEqual(errors, []);
        await context.close();
      }
    } finally { await browser.close(); }
  });
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`ディーラー画面の運営者の試験モード: 受注一覧を出さず(週表示も読まない)、案内と担当者の管理だけを表示。390pxで横にはみ出さない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const context = await newFakeContext(browser, base, 390, STAFF);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await installFakeServer(page, "testMode");
      await page.goto(`${base}dealer.html`);
      await page.locator('[data-notice="test-mode"]').waitFor();
      await page.locator(".dealer-manage-staff").first().waitFor();
      assert.equal(await page.locator(".dealer-panel .feature-title").innerText(), "試験モード");
      assert.equal(await page.locator("[data-tab], #dealerSurgeryArea, .dealer-facility-list").count(), 0, "受注一覧・医療機関の選択は出さない");
      assert.deepEqual(await page.evaluate(() => (window.__calls || []).map(([, d]) => d.action).filter(a => ["week", "list", "get", "setAssignments"].includes(a))), [], "注文の取得はしない");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      await context.close();
    } finally { await browser.close(); }
  });
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`本人確認の「この端末(ブラウザ)を記憶する」: スマホ/PCで横にはみ出さず、チェックは左・文は右で折り返す。文のタップで切り替わり、確認はそのまま進む: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [320, 390, 430, 1100]) {
        const context = await newFakeContext(browser, base, width, STAFF);
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await installFakeServer(page, "unverified");
        await page.goto(`${base}dealer.html`);
        await page.getByText("本人確認", { exact: true }).waitFor();
        // 説明は見出しのⓘ(2段落)。常時表示の説明文はない
        assert.equal(await page.locator("#dealerPanel .feature-desc").count(), 0, "見出しの下の長い説明は出さない");
        assert.equal(await page.locator(".dealer-verify-title .info-tip-btn").count(), 1);
        await page.locator(".dealer-verify-title .info-tip-btn").click();
        const help = (await page.locator(".dealer-verify-title .info-tip-pop").innerText()).split("\n").map(x => x.trim()).filter(Boolean);
        assert.equal(help.length, 2);
        assert.match(help[0], /^本人の確認のため/);
        assert.match(help[1], /届かない場合は、招待されたメールアドレスのアカウントでログインしているか確かめてください/);
        await page.keyboard.press("Escape");
        await page.click('[data-act="sendCode"]');
        const row = page.locator("label.dealer-remember");
        await row.waitFor();
        // 縦積みの並びと間隔: 送る → 入力欄 → 確認する → 端末の記憶 →(送信の結果の短い状態)→ ログアウト。重ならず、間隔は 8〜24px
        const stack = await page.evaluate(() => {
          const els = ['[data-act="sendCode"]', '[data-f="code"]', '[data-act="verifyCode"]', "label.dealer-remember", '#dealerPanel [role="status"]', '[data-act="signout"]'].map(q => document.querySelector(q).getBoundingClientRect());
          const gaps = els.slice(1).map((r, i) => Math.round(r.top - els[i].bottom));
          return { gaps, lefts: els.map(r => Math.round(r.left)), rights: els.map(r => Math.round(r.right)), scroll: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth };
        });
        assert.ok(stack.gaps.every(g => g >= 8 && g <= 24), `${width}: 縦の間隔 ${JSON.stringify(stack.gaps)}`);
        assert.ok(stack.scroll <= stack.vw, `${width}: 横にはみ出さない`);
        assert.ok(stack.rights.every(r => r <= stack.vw), `${width}: 画面内に収まる`);
        assert.ok(stack.lefts.slice(0, 4).every(l => l === stack.lefts[0]), `${width}: 左端がそろう ${JSON.stringify(stack.lefts)}`);
        assert.ok(!(await page.locator("#dealerPanel").innerText()).includes("届かない場合は"), "届かない場合の案内は常時表示しない");
        const m = await row.evaluate(l => {
          const cb = l.querySelector('input[type="checkbox"]'), tx = l.querySelector(".dealer-remember-text");
          const [L, C, T] = [l, cb, tx].map(e => e.getBoundingClientRect());
          const lh = parseFloat(getComputedStyle(tx).lineHeight);
          return { right: L.right, vw: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, cbLeftOfText: C.right <= T.left + 0.5,
            cbTopGap: C.top - T.top, lineHeight: lh, lines: Math.round(T.height / lh), clipped: tx.scrollWidth > tx.clientWidth + 1 || l.scrollWidth > l.clientWidth + 1,
            textInside: T.right <= L.right + 0.5 && T.left >= L.left - 0.5, white: getComputedStyle(l).whiteSpace };
        });
        assert.ok(m.scroll <= m.vw && m.right <= m.vw + 0.5, `${width}: 横にはみ出さない ${JSON.stringify(m)}`);
        assert.equal(m.clipped, false, `${width}: 文が切れない`);
        assert.ok(m.cbLeftOfText && m.textInside, `${width}: チェックは左・文は右`);
        assert.ok(m.cbTopGap >= -1 && m.cbTopGap < m.lineHeight, `${width}: チェックは1行目の高さ(上揃え) ${m.cbTopGap}`);
        assert.notEqual(m.white, "nowrap");
        if (width < 560) assert.ok(m.lines >= 2, `${width}: 文は折り返す(${m.lines}行)`);
        t.diagnostic(`${width}px: ${m.lines}行`);
        // 文のタップで切り替わる(既定は記憶する)
        const box = page.locator('[data-f="remember"]');
        assert.equal(await box.isChecked(), true);
        await page.locator(".dealer-remember-text").click();
        assert.equal(await box.isChecked(), false, `${width}: 文のタップで外れる`);
        await page.locator(".dealer-remember-text").click();
        assert.equal(await box.isChecked(), true, `${width}: もう一度で付く`);
        // 確認はそのまま進む
        await page.fill('[data-f="code"]', "12345678");
        await page.click('[data-act="verifyCode"]');
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "week") && document.querySelector('#dealerSurgery [data-act="more"]:not([disabled])'));   // 週表示を読み終えた(該当ありのときは案内の文は空)
        assert.deepEqual(errors, []);
        await context.close();
      }
    } finally { await browser.close(); }
  });
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`ディーラー画面の「使い方・ヘルプ」: ☰メニューから開く(ログイン前も)。ディーラー用のマニュアル(医療機関用とは別)。ページの移動・戻る・会社管理者のみの印。320/390/1100px で横にはみ出さない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      for (const width of [320, 390, 1100]) {
        // ログイン前: メニューは「使い方・ヘルプ」だけ。戻るとログイン画面
        let context = await newFakeContext(browser, base, width, null);
        let page = await context.newPage();
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await installFakeServer(page, "staff");
        await page.goto(`${base}dealer.html`);
        await page.locator("#btnDealerGoogle").waitFor();
        await page.click("#btnHeaderMenu");
        await page.click("#menuHelp");
        await page.locator("#manualView .manual-body h1").waitFor();
        assert.equal(await page.evaluate(() => location.hash), "#help");
        assert.equal(await page.locator("#manualView .manual-body h1").innerText(), "ディーラー用マニュアル");
        assert.equal(await page.locator("#dealerPanel").isVisible(), false, "ヘルプの間はログイン画面を隠す");
        assert.deepEqual(await page.locator(".manual-nav-link").allInnerTexts(), ["目次", "1. ログインと本人確認", "2. 受注一覧", "3. ディーラー設定", "4. よくある質問"], "全ページを表示(担当者は全員が読める)");
        const body = await page.locator("#manualView").innerText();
        assert.ok(!/IOL\s*Order|注文フォーム|施設設定|代行入力者/.test(body), "医療機関用の内容を含まない");
        assert.equal(await page.locator(".manual-back").first().innerText(), "ログイン画面に戻る");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 目次が横にはみ出さない`);
        // ページの移動(目次のリンク)。3. は会社管理者のみの印(赤い *)と、その説明
        await page.locator('.manual-body a[href="#help/03-settings"]').click();
        await page.waitForFunction(() => location.hash === "#help/03-settings");
        assert.match(await page.locator(".manual-body h1").innerText(), /^3\. ディーラー設定/);
        assert.ok(await page.locator(".manual-body .manual-admin-mark").count() > 0);
        assert.equal(await page.locator(".manual-body .manual-admin-mark").first().getAttribute("title"), "会社管理者のみ");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 3. が横にはみ出さない`);
        await page.locator(".manual-back").first().click();
        await page.locator("#btnDealerGoogle").waitFor();
        assert.equal(await page.evaluate(() => location.hash), "");
        assert.equal(await page.locator("#manualView").isHidden(), true);
        assert.deepEqual(errors, []);
        await context.close();

        // 受注一覧から(閲覧者): 開いて戻ると、表示はそのまま(一覧表示)
        context = await newFakeContext(browser, base, width, STAFF);
        page = await context.newPage();
        await installFakeServer(page, "staff");
        await page.goto(`${base}dealer.html`);
        await openOrdered(page);
        await page.click("#btnHeaderMenu");
        await page.click("#menuHelp");
        await page.locator("#manualView .manual-body h1").waitFor();
        assert.equal(await page.locator(".manual-back").first().innerText(), "受注一覧に戻る");
        assert.equal(await page.locator(".app-header .header-title").innerText(), "受注一覧");
        await page.locator(".manual-back").first().click();
        assert.equal(await page.locator("#dealerOrderedArea").isVisible(), true, "戻ると一覧表示のまま");
        await context.close();
      }
      // ディーラー設定から開いたら、戻るとディーラー設定。URL(#help/…)で直接開ける
      const context = await newFakeContext(browser, base, 390, STAFF);
      const page = await context.newPage();
      await installFakeServer(page, "companyAdmin");
      await page.goto(`${base}dealer.html#help/04-faq`);
      await page.locator("#manualView .manual-body h1").waitFor();
      assert.equal(await page.locator("#manualView .manual-body h1").innerText(), "4. よくある質問");
      await page.locator(".manual-back").first().click();
      await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "week"));
      await page.click("#btnHeaderMenu");
      await page.click("#menuDealerSettings");
      await page.locator("#dealerSettings").waitFor();
      await page.click("#btnHeaderMenu");
      await page.click("#menuHelp");
      await page.locator("#manualView .manual-body h1").waitFor();
      assert.equal(await page.locator(".manual-back").first().innerText(), "ディーラー設定に戻る");
      await page.locator(".manual-back").first().click();
      assert.equal(await page.locator("#dealerSettings").isVisible(), true);
      await context.close();
    } finally { await browser.close(); }
  });
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`ディーラー設定のテーマカラー(会社で共通): 会社管理者だけに欄を出す。選ぶとすぐヘッダーに反映して自動保存。初期設定に戻す・保存の失敗の表示。閲覧者にも会社の色。ログイン前・本人確認中は標準の青。320/390/1100px: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    const headerBg = (page) => page.evaluate(() => { const hd = document.querySelector(".app-header"); return { inline: hd.style.background, dark: hd.classList.contains("is-dark-text"), image: getComputedStyle(hd).backgroundImage, color: getComputedStyle(hd).backgroundColor }; });
    const openSettings = async (page) => {
      await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "week"));
      await page.click("#btnHeaderMenu");
      await page.click("#menuDealerSettings");
      await page.locator("#dealerSettings").waitFor();
    };
    try {
      for (const width of [320, 390, 1100]) {
        const context = await newFakeContext(browser, base, width, STAFF);
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        await installFakeServer(page, "companyAdmin");
        await page.goto(`${base}dealer.html`);
        await openSettings(page);
        const sec = page.locator('#dealerSettings [data-section="theme"]');
        await sec.waitFor();
        assert.equal(await sec.locator(".theme-swatch").count(), 20, "色見本20色(施設設定と同じ)");
        assert.equal((await headerBg(page)).inline, "", "未設定は標準の青");
        assert.equal(await sec.locator('[data-act="theme-reset"]').isDisabled(), true);
        // 色見本(白文字向けのティール)→ すぐヘッダーに反映し、自動保存
        await sec.locator('.theme-swatch[data-color="#0f766e"]').click();
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "setTheme"));
        assert.deepEqual((await calls(page, "setTheme")).at(-1), { action: "setTheme", companyId: "dco-x", color: "#0f766e", gradient: true, darkText: false });
        // 「初期設定に戻す」は施設設定の「追加」と同じ寸法(高さ36px・0.9rem・左右14px・小さい角丸)。ディーラー画面のボタンの寸法の指定より優先。1行に収まる
        assert.deepEqual(await sec.locator('[data-act="theme-reset"]').evaluate(e => { const c = getComputedStyle(e); return [e.getBoundingClientRect().height, Math.round(parseFloat(c.fontSize) * 10) / 10, c.padding, c.borderRadius, e.scrollWidth <= e.clientWidth]; }),
          [36, 14.4, "0px 14px", "6px", true], `${width}: 初期設定に戻す`);
        let bg = await headerBg(page);
        assert.ok(/15, 118, 110|#0f766e/i.test(bg.image + bg.inline), `${width}: ヘッダーに反映 ${JSON.stringify(bg)}`);
        assert.equal(bg.dark, false);
        // グラデーションなし・フォントを黒(黒文字向けの色見本)
        await sec.locator('[data-f="themeGradient"]').uncheck();
        await sec.locator('.theme-swatch[data-color="#fdba74"]').click();
        await page.waitForFunction(() => (window.__calls || []).filter(([, d]) => d.action === "setTheme").some(([, d]) => d.color === "#fdba74"));
        assert.deepEqual((await calls(page, "setTheme")).at(-1), { action: "setTheme", companyId: "dco-x", color: "#fdba74", gradient: false, darkText: true });
        bg = await headerBg(page);
        assert.equal(bg.color, "rgb(253, 186, 116)");
        assert.equal(bg.dark, true, "フォントを黒にする");
        assert.equal(await sec.locator('[data-f="themeDarkText"]').isChecked(), true);
        // 自由な色(HEX)。形式違いは反映も保存もしない
        const before = (await calls(page, "setTheme")).length;
        await sec.locator('[data-f="themeHex"]').fill("blue");
        await sec.locator('[data-f="themeHex"]').press("Enter");
        await sec.locator('[data-f="themeHex"]').blur();
        await sec.locator("[data-msg].error-message").waitFor();
        assert.equal((await calls(page, "setTheme")).length, before);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 横にはみ出さない`);
        // 受注一覧に戻っても色はそのまま。再読み込みしても(サーバーの値で)同じ色
        await page.click("#btnDealerSettingsClose");
        assert.equal((await headerBg(page)).color, "rgb(253, 186, 116)");
        await page.reload();
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "week"));
        assert.equal((await headerBg(page)).color, "rgb(253, 186, 116)", "再読み込み後も会社の色");
        // 初期設定に戻す(標準の青・白い文字)
        await openSettings(page);
        await page.locator('#dealerSettings [data-act="theme-reset"]').click();
        await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "resetTheme"));
        bg = await headerBg(page);
        assert.deepEqual([bg.inline, bg.dark], ["", false], "初期設定に戻す");
        // 保存の失敗: エラーと「再試行」を表示し、画面の変更は消さない
        await page.evaluate(() => { window.__themeFail = true; });
        await page.locator('#dealerSettings .theme-swatch[data-color="#7e22ce"]').click();
        await page.locator('#dealerSettings [data-section="theme"] [data-act="retry-autosave"]').waitFor();
        assert.match(await page.locator('#dealerSettings [data-section="theme"] [data-msg]').innerText(), /保存できませんでした/);
        await page.evaluate(() => { window.__themeFail = false; });
        await page.locator('#dealerSettings [data-section="theme"] [data-act="retry-autosave"]').click();
        await page.waitForFunction(() => !document.querySelector('#dealerSettings [data-section="theme"] [data-act="retry-autosave"]'));
        assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("__fakeCompanyTheme"))).color, "#7e22ce");
        assert.deepEqual(errors, []);
        await context.close();
      }

      // 支店管理者: ディーラー設定はあるが、テーマカラーの欄はない。会社の色は表示する
      let context = await newFakeContext(browser, base, 390, STAFF);
      let page = await context.newPage();
      await page.addInitScript(() => localStorage.setItem("__fakeCompanyTheme", JSON.stringify({ color: "#15803d", gradient: false, darkText: false })));
      await installFakeServer(page, "branchAdmin");
      await page.goto(`${base}dealer.html`);
      await openSettings(page);
      await page.locator(".dealer-manage-staff").first().waitFor();
      assert.equal(await page.locator('[data-section="theme"]').count(), 0, "支店管理者には出さない");
      assert.equal((await headerBg(page)).color, "rgb(21, 128, 61)", "会社の色は表示する");
      await context.close();

      // 閲覧者: ディーラー設定はない。会社の色で表示する
      context = await newFakeContext(browser, base, 390, STAFF);
      page = await context.newPage();
      await page.addInitScript(() => localStorage.setItem("__fakeCompanyTheme", JSON.stringify({ color: "#15803d", gradient: false, darkText: false })));
      await installFakeServer(page, "staff");
      await page.goto(`${base}dealer.html`);
      await page.waitForFunction(() => (window.__calls || []).some(([, d]) => d.action === "week"));
      assert.equal((await headerBg(page)).color, "rgb(21, 128, 61)", "閲覧者にも会社の色");
      assert.equal(await page.locator('[data-section="theme"], #dealerSettings').count(), 0);
      await context.close();

      // ログイン前・本人確認中は標準の青(会社の色を出さない)
      for (const [user, scenario] of [[null, "staff"], [STAFF, "unverified"]]) {
        context = await newFakeContext(browser, base, 390, user);
        page = await context.newPage();
        await page.addInitScript(() => localStorage.setItem("__fakeCompanyTheme", JSON.stringify({ color: "#15803d", gradient: false, darkText: true })));
        await installFakeServer(page, scenario);
        await page.goto(`${base}dealer.html`);
        await page.locator(user ? '[data-act="sendCode"]' : "#btnDealerGoogle").waitFor();
        const b = await headerBg(page);
        assert.deepEqual([b.inline, b.dark], ["", false], `${scenario}: 標準の青`);
        await context.close();
      }
    } finally { await browser.close(); }
  });
}
