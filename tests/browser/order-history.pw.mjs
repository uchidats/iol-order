// 回帰テスト(ブラウザ): 注文履歴の一覧(注文日順・手術日順・20件ずつ)・詳細(新旧データ・確認画面と同じまとめ方)・削除(管理者・副管理者)。Chromium / Firefox / WebKit。  npm run test:browser
// 実際の styles.css と src/ui/order-history.js を最小のページに読み込み、偽のリポジトリで表示する(ログイン・Firebase は使わない)。
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
import { createOrderHistory } from "/src/ui/order-history.js";
const item = (o = {}) => ({ manufacturer: "J&J", model: "DIB00V", displayName: "J&J / DIB00V", isToric: false, isMultifocal: false, toricModel: "", power: "+20.0D", quantity: 1, ...o });
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });
const orders = [
  { id: "old", orderNumber: "IOL-20260801-0001", createdAt: ts("2026-08-01T00:00:00Z"), item: item(), surgeryDate: "2026-09-01", orderer: { id: "o9", name: "最古注文者" } },
  { id: "new", schemaVersion: 3, orderNumber: "IOL-20261025-0001", createdAt: ts("2026-10-25T05:30:00Z"), testOrder: true, status: "notification_failed", notifications: [{ kind: "dealer", dealerName: "A商会", status: "accepted", delivery: "delivered", deliveryAt: "2026-10-25T05:31:00Z" }, { kind: "dealer", dealerName: "（発注先未設定）", status: "not_sent", reason: "dealer-unset" }, { kind: "copy", dealerName: "注文控え", status: "failed", error: "HTTP 422" }], notes: "午前の手術分\\n2行目",
    createdBy: { email: "login@example.jp", displayName: "ログイン太郎" },
    lines: [
      { lineNo: 1, item: item(), surgeryDate: "2026-11-10", doctor: { id: "o1", name: "山田" }, dealer: { id: "d1", name: "A商会" } },
      { lineNo: 2, item: item({ model: "DIWxxx (トーリック)", displayName: "J&J / DIWxxx (トーリック)", isToric: true, toricModel: "DIW300", power: "+18.5D", quantity: 2 }),
        surgeryDate: "2026-11-12", doctor: { id: "o2", name: "佐藤" }, dealer: null } ] },
  { id: "mid", orderNumber: "IOL-20260901-0002", createdAt: ts("2026-09-01T00:00:00Z"), orderer: { id: "o9", name: "旧注文者" }, createdBy: { email: "x@example.jp" },
    lines: [{ lineNo: 1, item: item({ quantity: 2 }), surgeryDate: "2026-10-01", dealer: null }] }
];
window.__closed = 0;
window.__asked = [];
window.__deleted = [];
window.__data = { f1: orders };
const dataOf = async (fid) => (window.__defer && window.__defer[fid] ? await window.__defer[fid] : (window.__data[fid] || orders));
const surgeryEntries = (list) => list.flatMap(o => {
  const ls = Array.isArray(o.lines) ? o.lines : (o.item ? [{ lineNo: 1, surgeryDate: o.surgeryDate }] : []);
  const by = new Map();
  ls.forEach((l, i) => { const d = l.surgeryDate || ""; if (!by.has(d)) by.set(d, []); by.get(d).push(l.lineNo || i + 1); });
  return [...by].map(([surgeryDate, lineNos]) => ({ id: o.id + "_" + (surgeryDate || "nodate"), orderId: o.id, surgeryDate, lineNos, ms: o.createdAt.toMillis(), deleted: o.deleted === true }));
}).filter(e => !e.deleted).sort((a, b) => b.surgeryDate.localeCompare(a.surgeryDate) || b.ms - a.ms);
const pageOf = (list, limit, cursor) => { const start = cursor ?? 0; const page = list.slice(start, start + limit); return { page, cursor: start + page.length, hasMore: page.length === limit }; };
window.__h = createOrderHistory({ mount: document.querySelector("main"), onClose: () => { window.__closed++; },
  deleteOrder: async (fid, oid) => { window.__deleted.push([fid, oid]); if (window.__deleteFail) throw Object.assign(new Error(window.__deleteMsg || "denied"), { code: window.__deleteFail }); return { orderId: oid, deleted: true, cancelledMails: window.__cancelled || 0 }; },
  repository: {
    listOrdersPage: async (fid, { limit, cursor }) => {
      window.__asked.push(["orders", fid, limit, cursor ?? null]);
      const r = pageOf([...await dataOf(fid)].sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis()), limit, cursor);
      return { orders: r.page, cursor: r.cursor, hasMore: r.hasMore };
    },
    listSurgeryIndexPage: async (fid, { limit, cursor }) => {
      window.__asked.push(["surgery", fid, limit, cursor ?? null]);
      const r = pageOf(surgeryEntries(await dataOf(fid)), limit, cursor);
      return { entries: r.page, cursor: r.cursor, hasMore: r.hasMore };
    },
    getOrder: async (fid, id) => { window.__asked.push(["get", fid, id]); return (await dataOf(fid)).find(o => o.id === id) || null; }
  } });
await window.__h.open({ id: "f1", name: "テスト施設" });
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

const lateOrder = { id: "late", orderNumber: "IOL-LATE-0001", createdAt: { seconds: 1, nanoseconds: 0 }, item: { manufacturer: "X", model: "LATE", displayName: "X / LATE", power: "+1.0D", quantity: 1 }, surgeryDate: "2026-12-01" };

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`注文履歴: 一覧(新しい順)と詳細(新旧データ): ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      assert.deepEqual(await page.evaluate(() => window.__asked), [["orders", "f1", 20, null]], "選択中の施設の注文だけを、20件ずつ問い合わせる");
      assert.equal(await page.locator('[data-act="more"]').count(), 0, "20件未満なら「もっと見る」は出さない");
      assert.equal(await page.locator('.history-sort-btn[aria-pressed="true"]').innerText(), "注文日順");
      const rows = await page.locator(".history-row").evaluateAll(rs => rs.map(r => r.innerText.replace(/\s+/g, " ").trim()));
      assert.equal(rows.length, 3);
      // カード: 明細(「手術日(短い表記) + 担当医」ごと・メーカー/モデル/度数/枚数)、下に注文日時・発注者・件数。発注先名は出さない
      assert.deepEqual(rows, [
        "11/10(火) 山田Dr テスト J&J DIB00V +20.0D 1枚 11/12(木) 佐藤Dr J&J DIW300 +18.5D 2枚 注文 2026/10/25 14:30 ログイン太郎 2件・合計3枚",
        "10/1(木) 旧注文者Dr J&J DIB00V +20.0D 2枚 注文 2026/09/01 09:00 x@example.jp 1件・合計2枚",
        "9/1(火) 最古注文者Dr J&J DIB00V +20.0D 1枚 注文 2026/08/01 09:00 （不明） 1件・合計1枚"]);
      assert.equal(await page.locator(".history-row").evaluateAll(rs => rs.some(r => r.innerText.includes("A商会"))), false, "発注先名は一覧に出さない");
      // 強調: モデル・度数・枚数は太字、補足(注文日時・発注者・件数)は小さい文字
      const look = await page.locator('[data-order="new"]').evaluate(b => { const q = (s) => getComputedStyle(b.querySelector(s));
        return { model: Number(q(".summary-model").fontWeight), power: Number(q(".summary-power").fontWeight), qty: Number(q(".summary-qty").fontWeight), meta: parseFloat(q(".history-meta").fontSize), line: parseFloat(q(".summary-model").fontSize) }; });
      assert.ok(look.model >= 700 && look.power >= 700 && look.qty >= 700 && look.meta < look.line, JSON.stringify(look));
      for (const w of [320, 390, 1100]) {
        await page.setViewportSize({ width: w, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `横スクロール ${w}`);
        // 見出しは「注文履歴」と右端の「注文画面に戻る」だけ(施設名はヘッダーに出ているため見出しには出さない)
        assert.equal((await page.locator("#orderHistory .settings-head").innerText()).replace(/\s+/g, " ").trim(), "注文履歴 注文画面に戻る", `見出しに施設名を出さない ${w}`);
        assert.ok(await page.evaluate(() => { const h = document.querySelector("#orderHistory .settings-head").getBoundingClientRect(), b = document.querySelector("#btnHistoryClose").getBoundingClientRect(), t = document.querySelector("#orderHistory .settings-head h2").getBoundingClientRect();
          return Math.abs(b.right - h.right) < 1 && Math.abs((b.top + b.bottom) / 2 - (t.top + t.bottom) / 2) < 2; }), `「注文画面に戻る」は見出しと同じ行の右端 ${w}`);
        const overlap = await page.locator(".history-row").evaluateAll(rs => rs.some(r => {
          const b = ["history-date", "history-count", "history-by"].map(c => r.querySelector("." + c).getBoundingClientRect());
          const hit = (x, y) => x.left < y.right - 0.5 && y.left < x.right - 0.5 && x.top < y.bottom - 0.5 && y.top < x.bottom - 0.5;
          return hit(b[0], b[1]) || hit(b[0], b[2]) || hit(b[1], b[2]);
        }));
        assert.equal(overlap, false, `注文日順の行の文字が重ならない ${w}`);
      }
      // 詳細(現行形式・発注先が2社): 確認画面と同じく、ディーラーごとのまとまり。手術日・担当医は見出しにまとめ、レンズの行は「IOL名・度数・枚数」だけ
      await page.locator('[data-order="new"]').click();
      const lines = await page.locator(".history-line").evaluateAll(ls => ls.map(l => l.innerText.replace(/\s+/g, " ").trim()));
      assert.deepEqual(lines, ["J&J DIB00V +20.0D 1枚", "J&J DIW300 +18.5D 2枚"], "レンズ番号・トーリック/多焦点のバッジは出さない");
      assert.equal(await page.locator(".history-line .lens-no-badge, .history-line .lens-badge").count(), 0);
      // スマホ幅(320・390)でも、各レンズは1行に収まる
      for (const w of [320, 390]) {
        await page.setViewportSize({ width: w, height: 900 });
        const rows = await page.locator(".history-line .summary-line-main").evaluateAll(ms => ms.map(m => { const t = [...m.children].map(c => c.getBoundingClientRect().top); return Math.max(...t) - Math.min(...t); }));
        assert.ok(rows.every(d => d < 4), `${w}: 1行に収まる ${rows}`);
      }
      await page.setViewportSize({ width: 390, height: 900 });
      const blocks = await page.locator(".history-dealer-block").evaluateAll(bs => bs.map(b => ({
        dealer: b.querySelector(".history-dealer").innerText, heads: [...b.querySelectorAll(".summary-date-head")].map(x => x.innerText.replace(/\s+/g, " ").trim()),
        subtotal: b.querySelector(".history-subtotal").innerText })));
      assert.deepEqual(blocks, [
        { dealer: "A商会", heads: ["手術日 2026年11月10日(火) 山田Dr"], subtotal: "1件・合計1枚" },
        { dealer: "未設定", heads: ["手術日 2026年11月12日(木) 佐藤Dr"], subtotal: "1件・合計2枚" }]);
      assert.equal(await page.locator(".history-total").innerText(), "2件・合計3枚", "注文全体の合計は1回");
      assert.equal(await page.locator(".history-notes").count(), 1, "備考は1回");
      for (const w of [320, 1100]) {
        await page.setViewportSize({ width: w, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `詳細の横スクロール ${w}`);
        // 右上の「注文画面に戻る」は「← 一覧へ戻る」と同じ高さ 36px・文字 0.9rem・上下の余白。色・角丸・左右の余白は従来(.btn-secondary)のまま、文字は1行
        const look = (q) => page.evaluate((s) => { const e = document.querySelector(s), c = getComputedStyle(e);
          return { h: e.getBoundingClientRect().height, pt: c.paddingTop, pb: c.paddingBottom, fs: c.fontSize, bg: c.backgroundColor, radius: c.borderRadius, pl: c.paddingLeft, oneLine: e.scrollWidth <= e.clientWidth }; }, q);
        assert.equal((await page.locator("#orderHistory .settings-head").innerText()).replace(/\s+/g, " ").trim(), "注文履歴 注文画面に戻る", `詳細でも見出しに施設名を出さない ${w}`);
        const [top, back] = [await look("#btnHistoryClose"), await look('[data-act="back"]')];
        assert.deepEqual([top.h, top.pt, top.pb, top.fs, top.bg, top.radius], [back.h, back.pt, back.pb, back.fs, back.bg, back.radius], `${w}px: 「← 一覧へ戻る」と同じ高さ・文字`);
        assert.deepEqual([top.h, top.pl, top.oneLine], [36, "20px", true], `${w}px: 高さ36px・左右の余白は従来どおり`);
      }
      await page.setViewportSize({ width: 390, height: 900 });
      assert.equal(await page.locator(".history-status").innerText(), "状態 テスト注文（ディーラー未通知）", "テスト注文はディーラーへの送信状態を注文の状態として出さない");
      assert.equal(await page.locator(".history-notes").innerText(), "午前の手術分\n2行目", "保存済みの備考(改行を保持)");
      // メールの送信状態: 発注先ごと・注文控え。受付と配信の結果を区別し、失敗は理由とともに表示
      assert.deepEqual(await page.locator(".history-notifications li").allInnerTexts(), [
        "A商会: 配信済み（2026/10/25 14:31）", "（発注先未設定）: 送信対象外（発注先未設定）", "注文控え: 送信失敗（届いていません） HTTP 422"]);
      // 詳細(旧形式): orderer が担当医として見出しに出る。発注先1社(未設定)は通常のまとまり
      await page.click('[data-act="back"]');
      await page.locator('[data-order="mid"]').click();
      assert.match(await page.locator(".summary-date-head").innerText(), /手術日 2026年10月1日\(木\)\s+旧注文者Dr/);
      assert.equal(await page.locator(".history-dealer-block").count(), 0);
      assert.equal(await page.locator(".history-dealer").innerText(), "未設定");
      assert.equal(await page.locator(".history-notes").innerText(), "（なし）");
      assert.equal(await page.locator(".history-notifications").count(), 0, "メール送信の記録がない注文には出さない");
      await page.click('[data-act="back"]');
      await page.locator('[data-order="old"]').click();
      assert.match(await page.locator(".summary-date-head").innerText(), /最古注文者Dr/);
      // 削除の権限がない(注文者・代行入力者)と、編集・削除・再注文の操作は無い。戻るボタンで onClose
      const actions = await page.locator("#orderHistory button").allInnerTexts();
      assert.ok(!actions.some(a => /削除|編集|再注文|キャンセル/.test(a)), actions.join("|"));
      await page.click("#btnHistoryClose");
      assert.equal(await page.evaluate(() => window.__closed), 1);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`注文履歴: 読み込み中に施設を切り替えても・閉じても、古い施設の結果を表示しない: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      // 施設f-oldの読み込みが遅れている間に、別の施設f-newを開く → 遅れて届いたf-oldの結果は捨てる
      await page.evaluate(async (late) => {
        let release; window.__defer = { "f-old": new Promise(r => { release = r; }) };
        const first = window.__h.open({ id: "f-old", name: "古い施設" });
        await window.__h.open({ id: "f-new", name: "新しい施設" });
        release([late]);
        await first;
      }, lateOrder);
      assert.equal(await page.locator("#orderHistory .settings-head").innerText().then(t => t.includes("施設")), false, "見出しに施設名を出さない(施設名はヘッダー)");
      assert.equal(await page.locator(".history-row").count(), 3, "新しい施設の注文だけ");
      assert.equal(await page.locator('[data-order="late"]').count(), 0, "古い施設の注文は出ない");
      // 読み込み中に画面を閉じる → 遅れて届いた結果で再描画しない(閉じたまま)
      await page.evaluate(async (late) => {
        let release; window.__defer = { "f-slow": new Promise(r => { release = r; }) };
        const p = window.__h.open({ id: "f-slow", name: "遅い施設" });
        window.__h.close();
        release([late]);
        await p;
      }, lateOrder);
      assert.equal(await page.locator("#orderHistory").isHidden(), true);
      assert.equal(await page.locator('[data-order="late"]').count(), 0);
    } finally { await browser.close(); }
  });
}

// 発注先1社で、手術日・担当医が同じレンズと違うレンズが混在する注文。論理削除した注文
const ts2 = (iso) => ({ toMillis: () => Date.parse(iso) });
const it2 = (o = {}) => ({ manufacturer: "J&J", model: "DIB00V", displayName: "J&J / DIB00V", power: "+20.0D", quantity: 1, ...o });
const sameDealer = { id: "s3", schemaVersion: 3, orderNumber: "IOL-20261026-01", createdAt: ts2("2026-10-26T01:00:00Z"), status: "accepted", notes: "",
  createdBy: { displayName: "管理花子", role: "admin" },
  lines: [
    { lineNo: 1, item: it2(), surgeryDate: "2026-11-10", doctor: { id: "o1", name: "山田" }, dealer: { id: "d1", name: "A商会" } },
    { lineNo: 2, item: it2({ power: "+21.0D", quantity: 2 }), surgeryDate: "2026-11-20", doctor: { id: "o1", name: "山田" }, dealer: { id: "d1", name: "A商会" } },
    { lineNo: 3, item: it2({ power: "+19.5D" }), surgeryDate: "2026-11-10", doctor: { id: "o1", name: "山田" }, dealer: { id: "d1", name: "A商会" } }] };
const gone = { id: "gone", orderNumber: "IOL-GONE-01", createdAt: ts2("2026-10-27T01:00:00Z"), deleted: true, item: it2(), surgeryDate: "2026-11-01" };

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`注文履歴: 同じ手術日・担当医・発注先はまとめて1回。論理削除した注文は出さない。管理者・副管理者だけ削除(確認ダイアログ・失敗の表示): ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      const openF2 = (canDelete) => page.evaluate(async ([orders, canDelete]) => {
        const ts = (o) => ({ ...o, createdAt: { toMillis: () => o.createdAt.ms } });
        window.__defer = { f2: orders.map(ts) };
        await window.__h.open({ id: "f2", name: "削除テスト施設", canDelete });
      }, [[sameDealer, gone].map(o => ({ ...o, createdAt: { ms: o.createdAt.toMillis() } })), canDelete]);
      await openF2(true);
      assert.deepEqual(await page.locator(".history-row").evaluateAll(rs => rs.map(r => r.dataset.order)), ["s3"], "論理削除した注文は一覧に出さない");
      await page.locator('[data-order="s3"]').click();
      // 発注先1社: 発注先は1回。手術日・担当医の見出しは2つ(11/10 にレンズ1・3、11/20 にレンズ2)
      assert.deepEqual(await page.locator(".history-dealer").allInnerTexts(), ["A商会"]);
      const groups = await page.locator(".summary-date-group").evaluateAll(gs => gs.map(g => [g.querySelector(".summary-date-head").innerText.replace(/\s+/g, " ").trim(), [...g.querySelectorAll(".history-line")].map(b => b.dataset.line)]));
      assert.deepEqual(groups, [["手術日 2026年11月10日(火) 山田Dr", ["1", "3"]], ["手術日 2026年11月20日(金) 山田Dr", ["2"]]]);
      assert.equal(await page.locator(".history-total").innerText(), "3件・合計4枚");
      for (const w of [320, 1100]) {
        await page.setViewportSize({ width: w, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `横スクロール ${w}`);
      }
      await page.setViewportSize({ width: 390, height: 900 });
      // 削除: 確認ダイアログでキャンセル → 何もしない
      const del = page.locator('[data-act="deleteOrder"]');
      assert.equal(await del.innerText(), "この注文を削除");
      await del.click();
      await page.locator(".confirm-dialog").waitFor();
      assert.match(await page.locator(".confirm-dialog-message").innerText(), /IOL-20261026-01 を削除しますか？[\s\S]*削除では取り消されません[\s\S]*記録は保存されます/);
      await page.click('.confirm-dialog [data-act="cancel"]');
      assert.deepEqual(await page.evaluate(() => window.__deleted), []);
      // 失敗(権限なし): 注文は残り、理由を表示。ボタンは再び押せる
      await page.evaluate(() => { window.__deleteFail = "functions/permission-denied"; });
      await del.click();
      await page.click('.confirm-dialog [data-act="ok"]');
      await page.waitForFunction(() => document.querySelector(".history-delete-msg").textContent.includes("管理者・副管理者のみ"));
      assert.equal(await del.isEnabled(), true);
      assert.equal(await page.locator(".history-line").count(), 3);
      // 送信処理中(サーバーが拒否): サーバーの理由をそのまま表示し、注文は残る
      await page.evaluate(() => { window.__deleteFail = "functions/failed-precondition"; window.__deleteMsg = "メールの送信処理中のため、今は削除できません。数分後にもう一度お試しください"; });
      await del.click();
      await page.click('.confirm-dialog [data-act="ok"]');
      await page.waitForFunction(() => document.querySelector(".history-delete-msg").textContent.includes("送信処理中"));
      assert.equal(await page.locator(".history-line").count(), 3);
      // 成功: 一覧から消え、削除したことを表示
      await page.evaluate(() => { window.__deleteFail = null; window.__deleted = []; window.__cancelled = 2; });
      await del.click();
      await page.click('.confirm-dialog [data-act="ok"]');
      await page.locator(".history-list, .history-body > .form-hint").first().waitFor();
      assert.deepEqual(await page.evaluate(() => window.__deleted), [["f2", "s3"]]);
      assert.equal(await page.locator(".history-row").count(), 0);
      assert.match(await page.locator("#orderHistory [role=status]").innerText(), /注文 IOL-20261026-01 を削除しました。未送信のメール2件の送信を中止しました。/);
      await page.evaluate(() => { window.__cancelled = 0; });
      // 削除の権限がない(注文者・代行入力者): ボタンを出さない
      await openF2(false);
      await page.locator('[data-order="s3"]').click();
      assert.equal(await page.locator('[data-act="deleteOrder"]').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

// 送信済み1通・未送信2通の注文(確認ダイアログに件数)
const withMails = { ...sameDealer, id: "m3", orderNumber: "IOL-20261026-02", notifications: [
  { id: "d_d1", kind: "dealer", dealerName: "A商会", status: "accepted" }, { id: "d_d2", kind: "dealer", dealerName: "B医療", status: "retry" }, { id: "copy", kind: "copy", dealerName: "注文控え", status: "waiting" }] };
/** 45件(注文日の新しい順に o00…o44)。o01・o03…o19 の10件は論理削除。o02 は手術日が2つ(11/28 と 11/02) */
function manyOrders() {
  const list = [];
  for (let i = 0; i < 45; i++) {
    const day = String(30 - (i % 28)).padStart(2, "0");
    const lines = [{ lineNo: 1, item: it2({ power: `+${(15 + i * 0.5).toFixed(1)}D` }), surgeryDate: `2026-11-${day}`, doctor: { id: "o1", name: "山田" }, dealer: { id: "d1", name: "A商会" } }];
    if (i === 2) lines.push({ lineNo: 2, item: it2(), surgeryDate: "2026-11-02", doctor: { id: "o2", name: "佐藤" }, dealer: { id: "d1", name: "A商会" } });
    list.push({ id: `o${String(i).padStart(2, "0")}`, orderNumber: `IOL-X-${i}`, createdAt: { ms: Date.parse("2026-10-28T00:00:00Z") - i * 3600e3 }, status: "accepted", lines,
      createdBy: { displayName: "発注者" }, deleted: i % 2 === 1 && i < 20 });
  }
  return list;
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`注文履歴: 初めは20件、「もっと見る」で20件ずつ(論理削除で枠が埋まらない)。手術日順は手術日ごと(複数の手術日の注文は日ごとに出る)。削除の確認に送信済み・未送信の件数: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      await page.evaluate(async (list) => {
        window.__data.f3 = list.map(o => ({ ...o, createdAt: { toMillis: () => o.createdAt.ms } }));
        window.__asked = [];
        await window.__h.open({ id: "f3", name: "多数の施設", canDelete: true });
      }, manyOrders());
      const ids = () => page.locator(".history-row").evaluateAll(rs => rs.map(r => r.dataset.order + (r.dataset.surgery ? "@" + r.dataset.surgery : "")));
      // 注文日順: 削除済みを飛ばして20件(読み足して埋める)
      let shown = await ids();
      assert.equal(shown.length, 20);
      assert.ok(shown.every(id => { const n = Number(id.slice(1)); return !(n % 2 === 1 && n < 20); }), "削除済みは出さない: " + shown.join(","));
      assert.deepEqual(shown.slice(0, 3), ["o00", "o02", "o04"]);
      assert.match(await page.locator("#orderHistory [role=status]").innerText(), /20件を表示しています（「もっと見る」で過去の注文をさかのぼれます）/);
      await page.click('[data-act="more"]');
      await page.waitForFunction(() => document.querySelectorAll(".history-row").length === 35);
      assert.equal(await page.locator('[data-act="more"]').count(), 0, "最後まで読んだら出さない");
      shown = await ids();
      assert.equal(new Set(shown).size, 35, "重複なし");
      assert.equal(shown.at(-1), "o44", "最も古い注文までさかのぼれる");
      const asked = await page.evaluate(() => window.__asked.filter(a => a[0] === "orders").map(a => a[3]));
      assert.ok(asked.length <= 5, "一度に全件は読まない: " + JSON.stringify(asked));
      // 手術日順: 手術日の新しい順。o02 は 11/28 と 11/02 の2行。削除済みは出さない
      await page.click('[data-sort="surgery"]');
      await page.waitForFunction(() => document.querySelector('.history-sort-btn[aria-pressed="true"]').dataset.sort === "surgery" && document.querySelectorAll(".history-row").length === 20);
      shown = await ids();
      assert.deepEqual(shown.slice(0, 3), ["o00@2026-11-30", "o28@2026-11-30", "o29@2026-11-29"], "同じ手術日は注文日の新しい順");
      const dates = shown.map(id => id.split("@")[1]);
      assert.deepEqual([...dates].sort().reverse(), dates, "手術日の新しい順");
      // 手術日順のカードは、その手術日のレンズだけ(o02 の 11/2 のレンズは 11/28 のカードに出さない)
      const o02 = (await page.locator('[data-order="o02"][data-surgery="2026-11-28"]').innerText()).replace(/\s+/g, " ").trim();
      assert.match(o02, /^11\/28\(土\) \S+Dr .*1枚 注文 .* この日 1件・合計1枚（注文全体 2件）$/, o02);
      assert.equal(await page.locator('[data-order="o02"][data-surgery="2026-11-28"] .history-line').count(), 1);
      assert.ok(!o02.includes("11/2("), "ほかの手術日のレンズは出さない");
      // スマホ(320〜430)・PC: 明細・補足の文字が重ならず、横にはみ出さない
      const boxes = () => page.locator(".history-row").evaluateAll(rs => rs.map(r => [".history-card-head", ".history-card-lines", ".history-date", ".history-count", ".history-by"].map(c => { const b = r.querySelector(c).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; })));
      const hit = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
      for (const w of [320, 390, 430, 1100]) {
        await page.setViewportSize({ width: w, height: 900 });
        for (const bs of await boxes()) {
          const pairs = bs.flatMap((a, i) => bs.slice(i + 1).map(b => [a, b]));
          assert.ok(pairs.every(([a, b]) => !hit(a, b)), `${w}: 重なりなし ${JSON.stringify(bs)}`);
          assert.ok(bs[0].b <= bs[1].t + 0.5 && bs[1].b <= Math.min(bs[2].t, bs[3].t, bs[4].t) + 0.5, `${w}: 見出し → 明細 → 補足の順`);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `横スクロール ${w}`);
      }
      await page.setViewportSize({ width: 390, height: 900 });
      for (let i = 0; i < 3 && await page.locator('[data-act="more"]').count(); i++) {
        const n = (await ids()).length;
        await page.click('[data-act="more"]');
        await page.waitForFunction((n) => document.querySelectorAll(".history-row").length > n || !document.querySelector('[data-act="more"]'), n);
      }
      shown = await ids();
      assert.equal(shown.length, 36, "35件の注文 + 手術日が2つの注文の2行目");
      assert.ok(shown.includes("o02@2026-11-02") && shown.includes("o02@2026-11-28"), "手術日が複数の注文は、それぞれの手術日に出る");
      assert.equal(new Set(shown).size, 36);
      // 手術日順の行から詳細 → 一覧へ戻ると、並び順と読み込んだ行を保つ
      await page.locator('[data-order="o02"][data-surgery="2026-11-02"]').click();
      assert.equal(await page.locator(".summary-date-group").count(), 2, "詳細は注文全体(手術日2つ)");
      await page.click('[data-act="back"]');
      assert.equal((await ids()).length, 36);
      assert.equal(await page.locator('.history-sort-btn[aria-pressed="true"]').innerText(), "手術日順");
      // 削除すると、その注文の行(手術日ごと)はすべて消える
      await page.locator('[data-order="o02"][data-surgery="2026-11-28"]').click();
      await page.click('[data-act="deleteOrder"]');
      await page.click('.confirm-dialog [data-act="ok"]');
      await page.waitForFunction(() => document.querySelectorAll(".history-row").length === 34);
      assert.equal(await page.locator('[data-order="o02"]').count(), 0);
      // 送信済み・未送信のメールがある注文: 件数を示して、送信済みは取り消せないことを明示
      await page.evaluate(async (o) => { window.__data.f4 = [{ ...o, createdAt: { toMillis: () => o.createdAt.ms } }]; await window.__h.open({ id: "f4", name: "メールの施設", canDelete: true }); }, { ...withMails, createdAt: { ms: withMails.createdAt.toMillis() } });
      await page.locator('[data-order="m3"]').click();
      assert.deepEqual(await page.locator(".history-notifications li").allInnerTexts(), ["A商会: 送信受付済み（配信の確認待ち）", "B医療: 再送信待ち（一時的なエラー）", "注文控え: 送信待ち（ディーラーへの送信の後）"]);
      await page.click('[data-act="deleteOrder"]');
      const msg = await page.locator(".confirm-dialog-message").innerText();
      assert.match(msg, /送信済みのメール（1件）は取り消せません。ディーラーへの発注を取り消す場合は、電話などで直接ご連絡ください。/);
      assert.match(msg, /未送信のメール（2件）は送信を中止します（以後、自動で送信・再送信されません）。/);
      await page.click('.confirm-dialog [data-act="cancel"]');
      for (const w of [320, 1100]) {
        await page.setViewportSize({ width: w, height: 900 });
        await page.click('[data-act="back"]');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `横スクロール ${w}`);
        await page.locator('[data-order="m3"]').click();
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

// 取消済みの注文(明細7件・手術日2日)と、通常の注文
function cardOrders() {
  const it = (power) => ({ manufacturer: "HOYA", model: "XY1", displayName: "HOYA / XY1", isToric: false, isMultifocal: false, toricModel: "", power, quantity: 1 });
  const line = (lineNo, surgeryDate, power) => ({ lineNo, item: it(power), surgeryDate, doctor: { id: "o1", name: "山田" }, dealer: { id: "d1", name: "A商会" } });
  return [
    { id: "c1", schemaVersion: 3, orderNumber: "IOL-C-1", createdAt: { ms: Date.parse("2026-10-30T00:00:00Z") }, status: "cancelled", cancelled: true, createdBy: { displayName: "発注者" },
      lines: [line(1, "2026-11-20", "+20.0D"), line(2, "2026-11-20", "+20.5D"), line(3, "2026-11-20", "+21.0D"), line(4, "2026-11-20", "+21.5D"),
        line(5, "2026-11-21", "+22.0D"), line(6, "2026-11-21", "+22.5D"), line(7, "2026-11-21", "+23.0D")] },
    { id: "c2", schemaVersion: 3, orderNumber: "IOL-C-2", createdAt: { ms: Date.parse("2026-10-29T00:00:00Z") }, status: "accepted", createdBy: { displayName: "発注者" }, lines: [line(1, "2026-11-22", "+19.0D")] }];
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`注文履歴の一覧カード: 明細は最大5行で「ほかN件」、取消済みはグレーのバッジ、押すと詳細。手術日順はその手術日のレンズだけ: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      await page.evaluate(async (list) => {
        window.__data.f5 = list.map(o => ({ ...o, createdAt: { toMillis: () => o.createdAt.ms } }));
        await window.__h.open({ id: "f5", name: "カードの施設" });
      }, cardOrders());
      const card = page.locator('[data-order="c1"]');
      assert.equal(await card.locator(".history-line").count(), 5, "明細は5行まで");
      assert.equal(await card.locator(".history-card-more").innerText(), "ほか2件");
      assert.deepEqual(await card.locator(".history-card-head").evaluateAll(hs => hs.map(h => h.innerText.replace(/\s+/g, " ").trim())), ["11/20(金) 山田Dr 取消済み", "11/21(土) 山田Dr"]);
      assert.equal(await page.locator('[data-order="c2"] .history-cancelled-badge').count(), 0, "通常の注文には付けない");
      assert.equal(await page.locator('[data-order="c2"] .history-card-more').count(), 0);
      // 取消済み: グレー(赤くない)・見出しの右端
      const badge = await card.locator(".history-cancelled-badge").evaluate(e => { const c = getComputedStyle(e), b = e.getBoundingClientRect(), p = e.closest(".history-card-head").getBoundingClientRect();
        return { color: c.color.match(/\d+/g).map(Number), bg: c.backgroundColor.match(/\d+/g).map(Number), right: p.right - b.right }; });
      assert.ok([badge.color, badge.bg].every(c => Math.max(...c.slice(0, 3)) - Math.min(...c.slice(0, 3)) <= 40), "グレー(青みのある灰色。赤・緑などの色ではない): " + JSON.stringify(badge));
      assert.ok(badge.right < 1, "見出しの右端");
      for (const w of [320, 390, 430]) {
        await page.setViewportSize({ width: w, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `横スクロール ${w}`);
      }
      // 押すと既存の詳細(全7件・状態は取消済み)
      await card.click();
      assert.equal(await page.locator(".history-line").count(), 7);
      assert.match(await page.locator(".history-status").innerText(), /取消済み/);
      await page.click('[data-act="back"]');
      // 手術日順: 取消済みの注文も手術日ごとのカード(バッジ付き)。その手術日のレンズだけ
      await page.click('[data-sort="surgery"]');
      await page.waitForFunction(() => document.querySelectorAll('.history-row[data-surgery]').length === 3);
      assert.equal(await page.locator('[data-order="c1"][data-surgery="2026-11-21"] .history-line').count(), 3);
      assert.equal(await page.locator('[data-order="c1"][data-surgery="2026-11-20"] .history-line').count(), 4);
      assert.equal(await page.locator('[data-order="c1"][data-surgery="2026-11-21"] .history-cancelled-badge').count(), 1);
      assert.match(await page.locator('[data-order="c1"][data-surgery="2026-11-21"] .history-count').innerText(), /この日 3件・合計3枚（注文全体 7件）/);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
