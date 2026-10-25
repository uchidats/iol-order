// 回帰テスト(ブラウザ): 施設登録の画面で、施設名の入力中に重複候補を知らせる(登録は止めない。他施設の情報は表示しない)。  npm run test:browser
// 実際の styles.css と src/ui/auth-ui.js を、最小のページで確認する(ログイン・Firebase は使わない)。
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
<main class="main-content"></main>
<script type="module">
import { createAuthUi } from "/src/ui/auth-ui.js";
window.__checks = []; window.__registers = []; window.__resp = { exact: false, similarCount: 0 }; window.__delays = {}; window.__throw = false;
const ui = createAuthUi({
  onGoogle() {}, onEmailLink() {}, onSelectFacility() {}, onLocate() {}, onSignOut() {}, onJoin() {}, onOnboardingClose() {},
  onRegisterCancel() {},
  onRegister: (a) => window.__registers.push(a),
  onCheckName: async (name) => { window.__checks.push(name); await new Promise(r => setTimeout(r, window.__delays[name] || 0)); if (window.__throw) throw new Error("not deployed"); return typeof window.__resp === "function" ? window.__resp(name) : window.__resp; }
});
ui.render({ access: { state: "no-membership", memberships: [] }, user: { displayName: "テスト", email: "t@example.jp", emailVerified: true }, notice: "", error: "", facilities: [], busy: false, registration: { busy: false, duplicate: null } });
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
test.after(() => { server.close(); });

async function launch(type, name) {
  for (const opts of name === "chromium" ? [{}, { channel: "msedge" }, { channel: "chrome" }] : [{}]) {
    try { return await type.launch(opts); } catch { /* 次の候補へ */ }
  }
  return null;
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`施設登録: 名前の入力中に重複候補を知らせる(登録は止めない・件数以外の情報は出さない): ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      // 初期選択は「既存施設に参加する」。縦並びのラジオで、選んだ方の入力欄だけを表示。入力済みの内容は切り替えても保持
      assert.equal(await page.locator("#modeJoin").isChecked(), true);
      assert.equal(await page.locator("#modeRegister").isChecked(), false);
      assert.equal(await page.locator("#joinToken").isVisible(), true);
      assert.equal(await page.locator("#regFacilityName").count(), 0);
      const r1 = await page.locator("#modeRegister").boundingBox(), r2 = await page.locator("#modeJoin").boundingBox();
      assert.ok(r2.y > r1.y + 10 && Math.abs(r1.x - r2.x) < 2, "縦並び");
      await page.fill("#joinToken", "TOKEN-123");
      await page.check("#modeRegister");
      assert.equal(await page.locator("#joinToken").count(), 0);
      await page.fill("#regFacilityName", "保持テスト施設");
      await page.check("#modeJoin");
      assert.equal(await page.locator("#joinToken").inputValue(), "TOKEN-123", "招待コードを保持");
      await page.check("#modeRegister");
      assert.equal(await page.locator("#regFacilityName").inputValue(), "保持テスト施設", "施設名を保持");
      await page.evaluate(() => { window.__checks.length = 0; });
      await page.fill("#regFacilityName", "");
      const input = page.locator("#regFacilityName"), hint = page.locator("#regNameHint");
      assert.equal(await hint.isHidden(), true);

      // 短い入力では照会しない。連続入力は、入力が止まってから1回だけ照会する
      await input.pressSequentially("さ");
      await page.waitForTimeout(900);
      assert.deepEqual(await page.evaluate(() => window.__checks), []);
      await page.evaluate(() => { window.__resp = { exact: false, similarCount: 2, candidates: ["さくら眼科クリニック", "<b>さくら</b>眼科", "a", "b", "c"] }; });
      await input.fill("");
      await input.pressSequentially("医療法人社団 さくら眼科", { delay: 20 });
      await hint.waitFor();
      assert.deepEqual(await page.evaluate(() => window.__checks), ["医療法人社団 さくら眼科"], "入力が止まってから1回");

      // 重複の可能性: 招待コードによる参加を案内。他施設の名前・件数などは出さない
      const txt = await hint.innerText();
      assert.match(txt, /既に登録されている可能性があります/);
      assert.match(txt, /招待コード/);
      assert.match(txt, /既存施設に参加する/);
      assert.ok(!/さくら|\d+件/.test(txt), "案内文に件数などは出さない: " + txt);
      // 候補は施設名のみ(最大5件・HTMLとして解釈しない)
      const items = page.locator("#regNameCandidates .candidate-item");
      assert.deepEqual(await items.allInnerTexts(), ["さくら眼科クリニック", "<b>さくら</b>眼科", "a", "b", "c"]);
      assert.equal(await page.locator("#regNameCandidates b").count(), 0);
      assert.equal(await page.locator("#regCandidateGuide").isHidden(), true);
      // ダークモードでも、候補の一覧は白背景・濃い文字(他のポップアップ・プルダウンと同じ配色)
      await page.emulateMedia({ colorScheme: "dark" });
      const cand = await items.nth(0).evaluate(e => { const s = getComputedStyle(e); return [s.backgroundColor, s.color, s.borderTopColor]; });
      await page.emulateMedia({ colorScheme: "light" });
      assert.deepEqual(cand, ["rgb(255, 255, 255)", "rgb(31, 41, 55)", "rgb(209, 213, 219)"]);
      // 候補を選ぶと、招待コードによる参加を案内(入力した施設名は書き換えない)。登録も引き続きできる
      await items.nth(0).click();
      const guide = await page.locator("#regCandidateGuide").innerText();
      assert.match(guide, /さくら眼科クリニック/);
      assert.match(guide, /招待コード/);
      assert.equal(await input.inputValue(), "医療法人社団 さくら眼科");
      // 登録は止めない(別の施設の場合は、そのまま登録できる)。ボタンは有効で、押すと通常の登録の操作が行われる
      assert.equal(await page.locator("#btnRegSubmit").isEnabled(), true);
      await page.click("#btnRegSubmit");
      assert.deepEqual(await page.evaluate(() => window.__registers), [{ name: "医療法人社団 さくら眼科", confirmDuplicate: false }]);

      // 候補がなくなれば、案内は消える
      await page.evaluate(() => { window.__resp = { exact: false, similarCount: 0 }; });
      await input.fill("まったく別の名前のクリニック");
      await page.waitForFunction(() => window.__checks.length >= 2);
      await page.waitForTimeout(200);
      assert.equal(await hint.isHidden(), true);
      assert.equal(await page.locator("#regNameCandidates").isHidden(), true);

      // 古い応答は使わない(遅れて届いた、前の入力への結果で表示しない)
      await page.evaluate(() => { window.__delays = { "遅い応答のテスト": 800 }; window.__resp = (n) => (n === "遅い応答のテスト" ? { exact: true, similarCount: 1 } : { exact: false, similarCount: 0 }); });
      await input.fill("遅い応答のテスト");
      await page.waitForFunction(() => window.__checks.includes("遅い応答のテスト"));
      await input.fill("別の名前に変えた");
      await page.waitForTimeout(1800);
      assert.equal(await hint.isHidden(), true, "前の入力への結果は表示しない");

      // 確認できなくても(未配備・通信エラー)、案内を出さず、登録の操作は妨げない
      await page.evaluate(() => { window.__throw = true; });
      await input.fill("確認できない場合のテスト");
      await page.waitForFunction(() => window.__checks.includes("確認できない場合のテスト"));
      await page.waitForTimeout(200);
      assert.equal(await hint.isHidden(), true);
      assert.equal(await page.locator("#btnRegSubmit").isEnabled(), true);

      // ボタン配置: 主なボタン(登録する/参加する)は左、「ログアウト」(所属済みなら「注文画面に戻る」)は同じ行の右。説明文との間に16〜20px。登録画面・参加画面とも、PC・スマホで同じ
      for (const width of [390, 1100]) {
        await page.setViewportSize({ width, height: 900 });
        for (const [mode, primary, hintSel] of [["#modeJoin", "#btnJoinSubmit", "#joinToken ~ .form-hint"], ["#modeRegister", "#btnRegSubmit", "#regFacilityName ~ .form-hint"]]) {
          await page.check(mode);
          const p = await page.locator(primary).boundingBox(), s = await page.locator("#btnAuthSignOut").boundingBox();
          const hint = await page.locator(hintSel).first().boundingBox();
          assert.ok(Math.abs(p.y - s.y) < 6, `${width} ${primary}: 同じ行`);
          assert.ok(p.x + p.width <= s.x, `${width} ${primary}: 左に主なボタン、右にログアウト`);
          assert.ok(s.x + s.width > width - 60, `${width}: 右端に寄る`);
          const lastHintBottom = await page.evaluate(([sel, pr]) => { const f = document.querySelector(sel).closest(".form-group"); return f.getBoundingClientRect().bottom; }, [primary === "#btnJoinSubmit" ? "#joinToken" : "#regFacilityName", primary]);
          const gap = p.y - lastHintBottom;
          assert.ok(gap >= 16 && gap <= 20, `${width} ${primary}: 説明文とボタンの間 ${gap}px`);
        }
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
