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
// Firestore の手術日順のクエリと同じ: fromDate = その日以降を早い順(同じ日は索引のID順)、before = その日より前を新しい順(同じ日はIDの逆順)、
// どちらもなし = 手術日のある全件を早い順。論理削除の索引も返す(画面が除く)
const surgeryEntries = (list, { fromDate, before } = {}) => list.flatMap(o => {
  const ls = Array.isArray(o.lines) ? o.lines : (o.item ? [{ lineNo: 1, surgeryDate: o.surgeryDate }] : []);
  const by = new Map();
  ls.forEach((l, i) => { const d = l.surgeryDate || ""; if (!by.has(d)) by.set(d, []); by.get(d).push(l.lineNo || i + 1); });
  return [...by].map(([surgeryDate, lineNos]) => ({ id: o.id + "_" + (surgeryDate || "nodate"), orderId: o.id, surgeryDate, lineNos, ms: o.createdAt.toMillis(), deleted: o.deleted === true }));
}).filter(e => before ? e.surgeryDate < before && e.surgeryDate > "" : fromDate ? e.surgeryDate >= fromDate : e.surgeryDate > "")
  .sort((a, b) => (before ? -1 : 1) * (a.surgeryDate.localeCompare(b.surgeryDate) || a.id.localeCompare(b.id)));
const pageOf = (list, limit, cursor) => { const start = cursor ?? 0; const page = list.slice(start, start + limit); return { page, cursor: start + page.length, hasMore: page.length === limit }; };
window.__h = createOrderHistory({ mount: document.querySelector("main"), onClose: () => { window.__closed++; }, today: () => window.__today || "2026-11-03",
  deleteOrder: async (fid, oid) => { window.__deleted.push([fid, oid]); if (window.__deleteFail) throw Object.assign(new Error(window.__deleteMsg || "denied"), { code: window.__deleteFail }); return { orderId: oid, deleted: true, cancelledMails: window.__cancelled || 0 }; },
  repository: {
    listOrdersPage: async (fid, { limit, cursor }) => {
      window.__asked.push(["orders", fid, limit, cursor ?? null]);
      const r = pageOf([...await dataOf(fid)].sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis()), limit, cursor);
      return { orders: r.page, cursor: r.cursor, hasMore: r.hasMore };
    },
    listSurgeryIndexPage: async (fid, { limit, cursor, fromDate, before }) => {
      window.__asked.push(["surgery", fid, limit, cursor ?? null, fromDate ?? null, before ?? null]);
      const r = pageOf(surgeryEntries(await dataOf(fid), { fromDate, before }), limit, cursor);
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
      // カード(注文日順): 最上部に注文番号、その下に手術日(短い表記)の見出しとバッジ(テスト・取消済み)、レンズ行(左にモデル・度数・枚数、右に担当医名。メーカー名は出さない)。
      // 注文日時・発注者・件数・合計枚数・発注先名は出さない(詳細で確認する)
      assert.deepEqual(rows, [
        "IOL-20261025-0001 11/10(火) テスト DIB00V +20.0D 1枚 山田Dr 11/12(木) DIW300 +18.5D 2枚 佐藤Dr",
        "IOL-20260901-0002 10/1(木) DIB00V +20.0D 2枚 旧注文者Dr",
        "IOL-20260801-0001 9/1(火) DIB00V +20.0D 1枚 最古注文者Dr"]);
      assert.equal(await page.locator("#orderHistory .history-list .summary-maker").count(), 0, "一覧ではメーカー名を出さない");
      // 注文番号: カードの最上部・明細より小さいグレーの文字(太字にしない)。明細との間は詰めすぎない
      const no = await page.locator('[data-order="new"]').evaluate(b => { const n = b.querySelector(".history-card-no"), g = b.querySelector(".history-card-group"), c = getComputedStyle(n), m = getComputedStyle(b.querySelector(".summary-model"));
        return { first: b.firstElementChild === n, fs: parseFloat(c.fontSize), line: parseFloat(m.fontSize), fw: Number(c.fontWeight), color: c.color.match(/\d+/g).map(Number), gap: g.getBoundingClientRect().top - n.getBoundingClientRect().bottom }; });
      assert.ok(no.first && no.fs < no.line && no.fw < 700, JSON.stringify(no));
      assert.ok(Math.max(...no.color) - Math.min(...no.color) <= 40 && Math.max(...no.color) >= 90, "グレー: " + no.color);
      assert.ok(no.gap >= 4 && no.gap <= 12, "注文番号と明細の間隔: " + no.gap);
      assert.equal(await page.locator(".history-row").evaluateAll(rs => rs.some(r => /A商会|ログイン太郎|x@example|2026\/|合計|件/.test(r.innerText))), false, "注文日時・発注者・件数・発注先名は一覧に出さない");
      assert.equal(await page.locator("#orderHistory .history-meta, #orderHistory .history-row .history-date, #orderHistory .history-row .history-by, #orderHistory .history-row .history-count").count(), 0);
      // 強調: モデル・度数・枚数は太字
      const look = await page.locator('[data-order="new"]').evaluate(b => { const q = (s) => getComputedStyle(b.querySelector(s));
        return { model: Number(q(".summary-model").fontWeight), power: Number(q(".summary-power").fontWeight), qty: Number(q(".summary-qty").fontWeight) }; });
      assert.ok(look.model >= 700 && look.power >= 700 && look.qty >= 700, JSON.stringify(look));
      for (const w of [320, 390, 1100]) {
        await page.setViewportSize({ width: w, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `横スクロール ${w}`);
        // 見出しは「注文履歴」と右端の「注文画面に戻る」だけ(施設名はヘッダーに出ているため見出しには出さない)
        assert.equal((await page.locator("#orderHistory .settings-head").innerText()).replace(/\s+/g, " ").trim(), "注文履歴 注文画面に戻る", `見出しに施設名を出さない ${w}`);
        assert.ok(await page.evaluate(() => { const h = document.querySelector("#orderHistory .settings-head").getBoundingClientRect(), b = document.querySelector("#btnHistoryClose").getBoundingClientRect(), t = document.querySelector("#orderHistory .settings-head h2").getBoundingClientRect();
          return Math.abs(b.right - h.right) < 1 && Math.abs((b.top + b.bottom) / 2 - (t.top + t.bottom) / 2) < 2; }), `「注文画面に戻る」は見出しと同じ行の右端 ${w}`);
        // カードの最後は明細(補足の行がなく、下に余分な余白が残らない)
        const gap = await page.locator(".history-row").evaluateAll(rs => rs.map(r => { const g = r.querySelectorAll(".history-card-group"); return r.getBoundingClientRect().bottom - g[g.length - 1].getBoundingClientRect().bottom; }));
        assert.ok(gap.every(g => g >= 0 && g <= 12), `カードの下の余白 ${w}: ${gap}`);
      }
      // 詳細(現行形式・発注先が2社): 確認画面と同じく、ディーラーごとのまとまり。手術日・担当医は見出しにまとめ、レンズの行は「IOL名・度数・枚数」だけ
      await page.locator('[data-order="new"]').click();
      const lines = await page.locator(".history-line").evaluateAll(ls => ls.map(l => l.innerText.replace(/\s+/g, " ").trim()));
      assert.deepEqual(lines, ["J&J DIB00V +20.0D 1枚", "J&J DIW300 +18.5D 2枚"], "詳細はメーカー名を従来どおり表示。レンズ番号・トーリック/多焦点のバッジは出さない");
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
      // 注文日順には「過去分」を出さない
      assert.equal(await page.locator('[data-filter="past"]').count(), 0);
      // 手術日順: 手術日の早い順。初めは「過去分」OFF = 日本時間の今日(テストでは 2026-11-03)以降だけ。削除済みは出さない
      await page.evaluate(() => { window.__asked = []; });
      await page.click('[data-sort="surgery"]');
      await page.waitForFunction(() => document.querySelector('.history-sort-btn[aria-pressed="true"]').dataset.sort === "surgery" && document.querySelectorAll(".history-row").length === 20);
      assert.equal(await page.locator('[data-filter="past"]').getAttribute("aria-pressed"), "false", "初期はOFF");
      assert.equal(await page.locator('[data-filter="past"]').innerText(), "過去分");
      assert.equal(await page.locator('input[type="checkbox"]').count(), 0, "チェックボックスではなく選択式のボタン");
      shown = await ids();
      assert.deepEqual(shown.slice(0, 3), ["o27@2026-11-03", "o26@2026-11-04", "o25@2026-11-05"], "今日から手術日の早い順");
      let dates = shown.map(id => id.split("@")[1]);
      assert.deepEqual([...dates].sort(), dates, "手術日の早い順");
      assert.ok(shown.every(id => { const n = Number(id.slice(1, 3)); return !(n % 2 === 1 && n < 20); }), "論理削除の索引は出さない: " + shown.join(","));
      assert.ok((await page.evaluate(() => window.__asked.filter(a => a[0] === "surgery"))).every(a => a[4] === "2026-11-03"), "今日以降の条件で読む");
      // 手術日ごとの見出しは1つ(同じ日付の注文が複数でも)
      assert.ok(await page.evaluate(() => { const d = [...document.querySelectorAll(".history-day")].map(e => e.dataset.day); return d.length === new Set(d).size && d.length === new Set([...document.querySelectorAll(".history-row")].map(r => r.dataset.surgery)).size; }), "同じ日付の見出しは1つ");
      // スマホ(320〜430)・PC: レンズ行の左(明細)と右(担当医名)が重ならず、横にはみ出さない
      const boxes = () => page.locator(".history-row").evaluateAll(rs => rs.map(r => [".history-lens-main", ".history-lens-side"].map(c => { const b = r.querySelector(c).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; })));
      const hit = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
      for (const w of [320, 390, 430, 1100]) {
        await page.setViewportSize({ width: w, height: 900 });
        for (const bs of await boxes()) {
          const pairs = bs.flatMap((a, i) => bs.slice(i + 1).map(b => [a, b]));
          assert.ok(pairs.every(([a, b]) => !hit(a, b)), `${w}: 重なりなし ${JSON.stringify(bs)}`);
          assert.ok(bs[0].r <= bs[1].l + 0.5, `${w}: 左に明細、右に担当医名`);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `横スクロール ${w}`);
      }
      await page.setViewportSize({ width: 390, height: 900 });
      const loadAll = async () => {
        for (let i = 0; i < 4 && await page.locator('[data-act="more"]').count(); i++) {
          const n = (await ids()).length;
          await page.click('[data-act="more"]');
          await page.waitForFunction((n) => document.querySelectorAll(".history-row").length > n || !document.querySelector('[data-act="more"]'), n);
        }
        return ids();
      };
      // 「もっと見る」でも今日以降の条件を保つ(o02 の 11/2 は出さない)
      shown = await loadAll();
      assert.equal(shown.length, 35, "今日以降: 35件の注文(o02 の 11/2 の行は過去)");
      assert.ok(!shown.includes("o02@2026-11-02") && shown.includes("o02@2026-11-28"));
      assert.equal(new Set(shown).size, 35, "重複なし");
      dates = shown.map(id => id.split("@")[1]);
      assert.deepEqual([...dates].sort(), dates, "追加の読み込みでも手術日の早い順");
      assert.ok((await page.evaluate(() => window.__asked.filter(a => a[0] === "surgery"))).every(a => a[4] === "2026-11-03"), "続きも同じ条件");
      // 手術日順のカードは、その手術日のレンズだけ(o02 の 11/2 のレンズは 11/28 のカードに出さない)
      const o02 = (await page.locator('[data-order="o02"][data-surgery="2026-11-28"]').innerText()).replace(/\s+/g, " ").trim();
      assert.match(o02, /^\S+ [+-]\d+\.\dD 1枚 \S+Dr$/, o02);   // レンズ行: モデル・度数・枚数と担当医名だけ(メーカー名・注文日時・件数は出さない。日付は見出し)
      assert.equal(await page.locator("#orderHistory .history-list .summary-maker").count(), 0, "手術日順でもメーカー名を出さない");
      assert.equal(await page.locator("#orderHistory .history-card-no").count(), 0, "手術日順には注文番号を出さない");
      assert.equal(await page.locator('[data-order="o02"][data-surgery="2026-11-28"] .history-line').count(), 1);
      // 「過去分」ON: 先頭から読み直し、今日以降(早い順)と直近の過去分(新しい順に読み、早い順で上へ)を別々に読む。続きも同じ条件
      await page.evaluate(() => { window.__asked = []; });
      await page.click('[data-filter="past"]');
      await page.waitForFunction(() => document.querySelector('.history-row[data-surgery]') && document.querySelectorAll(".history-row").length === 21);
      assert.equal(await page.locator('[data-filter="past"]').getAttribute("aria-pressed"), "true");
      // 選択中は青地・白文字で、OFFと明確に区別できる
      const pastBg = await page.locator('[data-filter="past"]').evaluate(e => getComputedStyle(e).backgroundColor.match(/\d+/g).map(Number));
      assert.ok(pastBg[2] > 150 && pastBg[2] - pastBg[0] > 80, "ONは青: " + pastBg);
      shown = await loadAll();
      assert.equal(shown[0], "o02@2026-11-02", "過去の手術日から早い順");
      assert.equal(shown.length, 36, "35件の注文 + 手術日が2つの注文の2行目");
      assert.ok(shown.includes("o02@2026-11-02") && shown.includes("o02@2026-11-28"), "手術日が複数の注文は、それぞれの手術日に出る");
      assert.equal(new Set(shown).size, 36);
      dates = shown.map(id => id.split("@")[1]);
      assert.deepEqual([...dates].sort(), dates);
      const askedPast = await page.evaluate(() => window.__asked.filter(a => a[0] === "surgery"));
      assert.ok(askedPast.every(a => (a[4] === "2026-11-03") !== (a[5] === "2026-11-03")), "今日以降(fromDate)と今日より前(before)のどちらかの条件で読む: " + JSON.stringify(askedPast));
      assert.deepEqual([askedPast.find(a => a[5])[3], askedPast.find(a => a[4])[3]], [null, null], "切り替えたら過去・未来とも先頭から読み直す");
      assert.equal(await page.locator(".history-list .history-today").innerText(), "今日（11/3(火)）以降");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, "横スクロール");
      // 手術日順の行から詳細 → 一覧へ戻ると、並び順と読み込んだ行を保つ
      await page.locator('[data-order="o02"][data-surgery="2026-11-02"]').click();
      assert.equal(await page.locator(".summary-date-group").count(), 2, "詳細は注文全体(手術日2つ)");
      await page.click('[data-act="back"]');
      assert.equal((await ids()).length, 36);
      assert.equal(await page.locator('.history-sort-btn[aria-pressed="true"]').innerText(), "手術日順");
      assert.equal(await page.locator('[data-filter="past"]').getAttribute("aria-pressed"), "true", "詳細から戻っても「過去分」を保つ");
      // 並び順を切り替えても選択状態を保つ(注文日順では「過去分」を出さない)。戻すと同じ条件で読み直す
      await page.click('[data-sort="created"]');
      await page.waitForFunction(() => document.querySelector('.history-sort-btn[aria-pressed="true"]').dataset.sort === "created" && document.querySelectorAll(".history-row").length === 20);
      assert.equal(await page.locator('[data-filter="past"]').count(), 0);
      await page.evaluate(() => { window.__asked = []; });
      await page.click('[data-sort="surgery"]');
      await page.waitForFunction(() => document.querySelector('.history-sort-btn[aria-pressed="true"]').dataset.sort === "surgery" && document.querySelectorAll(".history-row").length === 21);
      assert.equal(await page.locator('[data-filter="past"]').getAttribute("aria-pressed"), "true", "並び順を切り替えても「過去分」を保つ");
      assert.ok(await page.evaluate(() => window.__asked.some(a => a[0] === "surgery" && a[5] === "2026-11-03")), "過去分も読み直す");
      shown = await loadAll();
      assert.equal(shown.length, 36);
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
    { id: "c2", schemaVersion: 3, orderNumber: "IOL-C-2", createdAt: { ms: Date.parse("2026-10-29T00:00:00Z") }, status: "accepted", createdBy: { displayName: "発注者" }, lines: [line(1, "2026-11-22", "+19.0D")] },
    { id: "c3", schemaVersion: 3, orderNumber: "IOL-C-3", createdAt: { ms: Date.parse("2026-10-28T00:00:00Z") }, status: "accepted", createdBy: { displayName: "発注者" },
      lines: [{ ...line(1, "2026-11-25", "+18.0D"), doctor: { id: "o2", name: "内田" } }, { ...line(2, "2026-11-25", "+18.0D"), doctor: { id: "o3", name: "長谷川 とても長い名前の担当医" } }] }];
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
      // 「取消済み」は初期OFF: 取消済みの注文(c1)は出さない。ONで通常の注文に追加して出す
      await page.locator('[data-order="c2"]').waitFor();
      assert.equal(await page.locator('[data-filter="cancelled"]').getAttribute("aria-pressed"), "false");
      assert.equal(await page.locator('[data-order="c1"]').count(), 0, "取消済みは初期では出さない");
      await page.click('[data-filter="cancelled"]');
      await page.locator('[data-order="c1"]').waitFor();
      assert.deepEqual(await page.locator(".history-row").evaluateAll(rs => rs.map(r => r.dataset.order)), ["c1", "c2", "c3"], "通常の注文に取消済みを加える(注文日順のまま)");
      // 注文日順: 同じ手術日で担当医が2人でも日付の見出しは1回。各行の右に担当医名(長い名前も右の列の中で自然に折り返す)
      const c3 = page.locator('[data-order="c3"]');
      assert.deepEqual(await c3.locator(".history-card-head").allInnerTexts(), ["11/25(水)"]);
      assert.deepEqual(await c3.locator(".history-lens-doctor").allInnerTexts(), ["内田Dr", "長谷川 とても長い名前の担当医Dr"]);
      const card = page.locator('[data-order="c1"]');
      assert.equal(await card.locator(".history-line").count(), 5, "明細は5行まで");
      assert.equal(await card.locator(".history-card-more").innerText(), "ほか2件");
      assert.deepEqual(await card.locator(".history-card-head").evaluateAll(hs => hs.map(h => h.innerText.replace(/\s+/g, " ").trim())), ["11/20(金) 取消済み", "11/21(土)"]);
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
      // 手術日順: 「取消済み」ONは並び順を切り替えても保つ。取消済みの注文も手術日ごとのカード(バッジ付き)。その手術日のレンズだけ
      await page.click('[data-sort="surgery"]');
      await page.waitForFunction(() => document.querySelectorAll('.history-row[data-surgery]').length === 10);
      assert.equal(await page.locator('[data-filter="cancelled"]').getAttribute("aria-pressed"), "true");
      // 手術日順: 同じ手術日は見出し1つ(注文・担当医が違っても)。1行 = 1レンズ(同じモデル・度数でも合算しない)
      assert.deepEqual(await page.locator(".history-day .history-card-head").allInnerTexts(), ["11/20(金)", "11/21(土)", "11/22(日)", "11/25(水)"]);
      assert.deepEqual(await page.locator('.history-day[data-day="2026-11-25"] .history-lens-doctor').allInnerTexts(), ["内田Dr", "長谷川 とても長い名前の担当医Dr"]);
      // スマホ(320〜430)・PC: 長い担当医名でも、明細と重ならず、横にはみ出さず、1文字ずつ縦に並ばない
      for (const w of [320, 360, 390, 430, 1100]) {
        await page.setViewportSize({ width: w, height: 900 });
        const lay = await page.locator(".history-lens-row").evaluateAll(rs => rs.map(r => { const m = r.querySelector(".history-lens-main").getBoundingClientRect(), d = r.querySelector(".history-lens-side").getBoundingClientRect(), doc = r.querySelector(".history-lens-doctor");
          const fs = parseFloat(getComputedStyle(doc).fontSize); const db = doc.getBoundingClientRect(); return { gap: d.left - m.right, out: d.right - r.getBoundingClientRect().right, w: db.width, lines: Math.round(db.height / (fs * 1.45)), fs }; }));
        assert.ok(lay.every(x => x.gap >= 0 && x.out <= 0.5 && (x.lines <= 1 || x.w >= x.fs * 4)), `${w}: ${JSON.stringify(lay)}`);   // 折り返すときは右の列が4文字分以上(1文字ずつ縦に並ばない)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `横スクロール ${w}`);
      }
      await page.setViewportSize({ width: 320, height: 900 });
      // レンズ行を押すと、そのレンズを含む元の注文の詳細
      await page.locator('.history-row[data-order="c3"][data-line="2"]').click();
      assert.match(await page.locator(".history-detail-head").innerText(), /IOL-C-3/);
      await page.click('[data-act="back"]');
      assert.equal(await page.locator('[data-order="c1"][data-surgery="2026-11-21"] .history-line').count(), 3);
      assert.equal(await page.locator('[data-order="c1"][data-surgery="2026-11-20"] .history-line').count(), 4);
      assert.equal(await page.locator('[data-order="c1"][data-surgery="2026-11-21"] .history-cancelled-badge').count(), 3, "取消済みのバッジは該当する各レンズ行に");
      assert.equal(await page.locator('[data-order="c3"] .history-cancelled-badge').count(), 0);
      assert.equal(await page.locator('[data-order="c1"][data-surgery="2026-11-21"] .history-count').count(), 0, "件数は一覧に出さない(詳細で確認)");
      // 詳細では従来どおり、注文日時・発注者・注文全体の合計を確認できる
      await page.locator('[data-order="c1"][data-surgery="2026-11-21"]').first().click();
      assert.match(await page.locator(".history-detail-head").innerText(), /注文日時 2026\/10\/30 09:00 ・ 発注者 発注者/);
      assert.equal(await page.locator(".history-total").innerText(), "7件・合計7枚");
      // 今日以降に手術予定がない(すべて過去): OFFでは案内だけ。ONにすると過去分を表示する。施設を開き直すとOFF・注文日順に戻る
      await page.evaluate(async () => { window.__today = "2027-01-01"; await window.__h.open({ id: "f5", name: "カードの施設" }); });
      assert.equal(await page.locator('[data-filter="cancelled"]').getAttribute("aria-pressed"), "false", "開き直すと「取消済み」もOFF");
      await page.click('[data-filter="cancelled"]');
      await page.click('[data-sort="surgery"]');
      await page.getByText("今日以降に手術予定の注文はありません（「過去分」を選ぶと過去の手術日も表示できます）。").waitFor();
      assert.equal(await page.locator(".history-row").count(), 0);
      await page.click('[data-filter="past"]');
      await page.waitForFunction(() => document.querySelectorAll('.history-row[data-surgery]').length === 10);
      await page.evaluate(async () => { window.__today = null; await window.__h.open({ id: "f5", name: "カードの施設" }); });
      assert.equal(await page.locator('.history-sort-btn[aria-pressed="true"]').innerText(), "注文日順");
      await page.click('[data-sort="surgery"]');
      assert.equal(await page.locator('[data-filter="past"]').getAttribute("aria-pressed"), "false", "開き直すとOFF");
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

/**
 * 過去・未来のページ送りと取消済みの大量混在(今日は 2026-11-03 に固定):
 * p00…p49 = 過去(11/2 から1日ずつさかのぼる。p10/p11 は同じ日)、f00…f29 = 今日以降(11/4 から。f05/f06 は同じ日)、
 * x00…x69 = 取消済み(注文日は最も新しい。手術日は 11/4 と 10/30 に集中)。q00…q04 = 論理削除(過去)
 */
function pagingOrders() {
  const it = (power) => ({ manufacturer: "HOYA", model: "XY1", displayName: "HOYA / XY1", isToric: false, isMultifocal: false, toricModel: "", power, quantity: 1 });
  const day = (base, n) => new Date(Date.parse(base + "T00:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
  const list = [];
  let t = Date.parse("2026-10-31T00:00:00Z");
  const add = (id, surgeryDate, extra = {}) => list.push({ id, schemaVersion: 3, orderNumber: `IOL-${id}`, createdAt: { ms: t-- }, status: extra.cancelled ? "cancelled" : "accepted", createdBy: { displayName: "発注者" },
    lines: [{ lineNo: 1, item: it("+20.0D"), surgeryDate, doctor: { id: "o1", name: "山田" }, dealer: { id: "d1", name: "A商会" } }], ...extra });
  for (let i = 0; i < 70; i++) add(`x${String(i).padStart(2, "0")}`, i % 2 ? "2026-11-04" : "2026-10-30", { cancelled: true });   // 注文日が最も新しい70件はすべて取消済み
  for (let i = 0; i < 30; i++) add(`f${String(i).padStart(2, "0")}`, day("2026-11-04", i > 19 ? i - 2 : i > 5 ? i - 1 : i));
  for (let i = 0; i < 50; i++) add(`p${String(i).padStart(2, "0")}`, day("2026-11-02", -(i > 19 ? i - 2 : i > 10 ? i - 1 : i)));
  for (let i = 0; i < 5; i++) add(`q${String(i).padStart(2, "0")}`, day("2026-11-01", -i), { deleted: true });
  return list;
}

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  test(`注文履歴の過去分・取消済み: 過去と未来を別のカーソルで20件ずつ(境目で重複・欠落なし)、上に足しても位置を保つ、取消済みの大量混在でも20件、未来0件、詳細から戻る: ${name}`, async (t) => {
    const browser = await launch(type, name);
    if (!browser) return t.skip(`${name} を起動できません(npx playwright-core install ${name})`);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__ready);
      const data = pagingOrders();
      await page.evaluate(async (list) => {
        window.__data.f6 = list.map(o => ({ ...o, createdAt: { toMillis: () => o.createdAt.ms } }));
        window.__asked = [];
        await window.__h.open({ id: "f6", name: "ページ送りの施設" });
      }, data);
      const ids = () => page.locator(".history-row").evaluateAll(rs => rs.map(r => r.dataset.order + (r.dataset.surgery ? "@" + r.dataset.surgery : "")));
      const count = () => page.locator(".history-row").count();
      const clickMore = async (act) => {
        const n = await count();
        await page.click(`[data-act="${act}"]`);
        await page.waitForFunction(([n, a]) => document.querySelectorAll(".history-row").length > n || !document.querySelector(`[data-act="${a}"]`), [n, act]);
      };
      const loadAll = async (act) => { for (let i = 0; i < 10 && await page.locator(`[data-act="${act}"]`).count(); i++) await clickMore(act); return ids(); };
      const live = data.filter(o => !o.deleted && !o.cancelled);
      const entry = (o) => `${o.id}@${o.lines[0].surgeryDate}`;
      const bySurgery = (a, b) => a.split("@")[1].localeCompare(b.split("@")[1]) || a.localeCompare(b);

      // 注文日順・取消済みOFF: 最も新しい70件が取消済みでも、読み足して最初から20件(取消済みは出さない)
      let shown = await ids();
      assert.equal(shown.length, 20, "取消済みを飛ばして20件");
      assert.ok(shown.every(id => !id.startsWith("x")), shown.join(","));
      assert.deepEqual(shown.slice(0, 2), ["f00", "f01"]);
      shown = await loadAll("more");
      assert.deepEqual(shown, live.map(o => o.id), "注文日順(新しい順)で、取消済み・論理削除を除いた全件。重複・欠落なし");
      // 取消済みON(注文日順): 通常の注文に取消済みを加える
      await page.click('[data-filter="cancelled"]');
      await page.waitForFunction(() => document.querySelectorAll(".history-row").length === 20 && document.querySelector('[data-order="x00"]'));
      assert.ok((await ids()).every(id => id.startsWith("x")), "注文日の新しい取消済みから");
      await page.click('[data-filter="cancelled"]');   // OFFに戻す
      await page.waitForFunction(() => document.querySelectorAll(".history-row").length === 20 && !document.querySelector('[data-order^="x"]'));

      // 手術日順・過去分OFF: 今日以降を早い順。取消済み(11/4 に集中)を飛ばして20件
      await page.click('[data-sort="surgery"]');
      await page.waitForFunction(() => document.querySelector('.history-sort-btn[aria-pressed="true"]').dataset.sort === "surgery" && document.querySelectorAll(".history-row").length === 20);
      const future = live.filter(o => o.lines[0].surgeryDate >= "2026-11-03").map(entry).sort(bySurgery);
      const pastAll = live.filter(o => o.lines[0].surgeryDate < "2026-11-03").map(entry).sort(bySurgery);
      assert.deepEqual(await ids(), future.slice(0, 20));
      assert.equal(await page.locator('[data-act="more-past"]').count(), 0, "過去分OFFでは上のボタンを出さない");

      // 過去分ON: 今日以降20件と直近の過去20件を別々に読み、早い順に並べ、今日付近(境目)が上に見える位置へ
      await page.evaluate(() => { window.__asked = []; });
      await page.click('[data-filter="past"]');
      await page.waitForFunction(() => document.querySelectorAll(".history-row").length === 40);
      assert.deepEqual(await ids(), [...pastAll.slice(-20), ...future.slice(0, 20)], "直近の過去20件(早い順) + 今日以降20件");
      const asked = await page.evaluate(() => window.__asked.filter(a => a[0] === "surgery"));
      assert.ok(asked.some(a => a[5] === "2026-11-03" && a[3] === null) && asked.some(a => a[4] === "2026-11-03" && a[3] === null), "過去・未来を別々のクエリで先頭から: " + JSON.stringify(asked));
      await page.waitForFunction(() => Math.abs(document.querySelector(".history-today").getBoundingClientRect().top - 8) <= 4);   // 境目が画面の上
      assert.equal(await page.locator('[data-act="more-past"]').innerText(), "過去の注文をもっと見る");

      // 上の「過去の注文をもっと見る」: 20件ずつ上に足しても、見ているカードの位置を保つ
      for (const n of [40, 50]) {
        await page.evaluate(() => window.scrollTo(0, 0));
        const first = page.locator(".history-row").first();
        const key = await first.evaluate(e => [e.dataset.order, e.dataset.surgery]);
        const before = await first.evaluate(e => e.getBoundingClientRect().top);
        await clickMore("more-past");
        const after = await page.locator(`.history-row[data-order="${key[0]}"][data-surgery="${key[1]}"]`).evaluate(e => e.getBoundingClientRect().top);
        assert.ok(Math.abs(after - before) <= 2, `上に足しても位置を保つ: ${before} → ${after}`);
        const p = (await ids()).filter(id => id.split("@")[1] < "2026-11-03");
        assert.deepEqual(p, pastAll.slice(-n), `過去分 ${n}件(早い順・重複なし)`);
      }
      assert.equal(await page.locator('[data-act="more-past"]').count(), 0, "過去を最後まで読んだら上のボタンを出さない");
      // 下の「もっと見る」: 今日以降の続き。境目で重複・欠落なし
      shown = await loadAll("more");
      assert.deepEqual(shown, [...pastAll, ...future], "過去・未来を合わせて、手術日の早い順に全件(重複・欠落なし)");
      // ページの境目をまたぐ同じ手術日(f19/f20・p19/p20)も、見出しは1つにまとまる
      const dayHeads = await page.locator(".history-day").evaluateAll(ds => ds.map(d => [d.dataset.day, d.querySelectorAll(".history-row").length]));
      assert.equal(dayHeads.length, new Set(dayHeads.map(d => d[0])).size, "同じ日付の見出しは1つ: " + JSON.stringify(dayHeads));
      for (const id of ["f19", "p19"]) {
        const date = data.find(o => o.id === id).lines[0].surgeryDate;
        assert.equal(dayHeads.find(d => d[0] === date)[1], 2, `${id} とその次の注文は同じ見出しの下: ${date}`);
      }
      assert.equal(await page.locator(".history-list .history-today").count(), 1);
      for (const w of [320, 430]) {
        await page.setViewportSize({ width: w, height: 700 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `横スクロール ${w}`);
      }
      await page.setViewportSize({ width: 390, height: 700 });

      // 詳細から戻ると、読み込み済みの一覧とスクロール位置を保つ
      await page.locator(".history-today").scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, 300));
      const y = await page.evaluate(() => window.scrollY);
      await page.locator(".history-row").nth(52).click();
      await page.locator('[data-act="back"]').click();
      assert.equal(await count(), 80);
      assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - y) <= 2, "スクロール位置を保つ");
      assert.deepEqual(await page.locator("[data-filter]").evaluateAll(bs => bs.map(b => [b.dataset.filter, b.getAttribute("aria-pressed")])), [["past", "true"], ["cancelled", "false"]]);

      // 過去分ONのまま取消済みON: 過去・未来とも取消済みを加えて読み直す(「過去分」とは別に切り替わる)
      await page.click('[data-filter="cancelled"]');
      await page.waitForFunction(() => document.querySelector('.history-row[data-order^="x"]') && document.querySelector(".history-today"));
      assert.deepEqual(await page.locator("[data-filter]").evaluateAll(bs => bs.map(b => b.getAttribute("aria-pressed"))), ["true", "true"]);
      const both = await ids();
      assert.ok(both.some(id => id.startsWith("x") && id.endsWith("10-30")) && both.some(id => id.startsWith("x") && id.endsWith("11-04")), "過去・未来の両方に取消済み");
      assert.equal(await page.locator('.history-row[data-order^="x"] .history-cancelled-badge').count(), both.filter(id => id.startsWith("x")).length, "取消済みにはバッジ");

      // 未来が0件: 直近の過去分が画面に見える(境目を画面の下側に)
      await page.evaluate(async () => { window.__today = "2027-01-01"; await window.__h.open({ id: "f6", name: "ページ送りの施設" }); });
      await page.click('[data-sort="surgery"]');
      await page.getByText("今日以降に手術予定の注文はありません（「過去分」を選ぶと過去の手術日も表示できます）。").waitFor();
      await page.click('[data-filter="past"]');
      await page.waitForFunction(() => document.querySelectorAll(".history-row").length === 20 && document.querySelector(".history-empty"));
      assert.equal(await page.locator(".history-empty").innerText(), "今日以降に手術予定の注文はありません。");
      await page.waitForFunction(() => { const e = [...document.querySelectorAll(".history-row")].at(-1).getBoundingClientRect(); return e.top >= 0 && e.bottom <= innerHeight; });   // 直近の過去分(一番下)が画面に見える
      const lastFuture = data.filter(o => o.id.startsWith("f")).at(-1);
      assert.equal((await ids()).at(-1), entry(lastFuture), "最も今日に近い(新しい)手術日が一番下");
      await page.evaluate(() => { window.__today = null; });
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
