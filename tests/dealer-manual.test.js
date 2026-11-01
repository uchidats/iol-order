import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseMarkdown } from "../src/manual/markdown.js";
import { DEALER_MANUAL_PAGES } from "../src/manual/dealer-manual-pages.js";
import { MANUAL_PAGES } from "../src/manual/manual-pages.js";
import { resolveManualLink, pageIdFromHash, manualHash } from "../src/ui/manual-view.js";
import { buildManualModule, listManualFiles, MANUALS } from "../scripts/build-manual.mjs";

// ディーラー画面(dealer.html)の「使い方・ヘルプ」。原稿は docs/dealer-manual/(医療機関用 docs/manual とは独立)

/** 構造の中の、指定した種類のノードをすべて集める */
function collect(nodes, type, out = []) {
  for (const n of nodes || []) {
    if (!n || typeof n !== "object") continue;
    if (n.type === type) out.push(n);
    for (const k of ["children", "items", "head"]) if (Array.isArray(n[k])) collect(n[k].flat(), type, out);
    if (Array.isArray(n.rows)) collect(n.rows.flat(2), type, out);
  }
  return out;
}
const resolve = (url) => resolveManualLink(url, DEALER_MANUAL_PAGES);

test("ディーラー用マニュアル: 表示データ(src/manual/dealer-manual-pages.js)は docs/dealer-manual の原稿と一致する(原稿を変えたら node scripts/build-manual.mjs)", () => {
  const actual = fs.readFileSync(new URL("../src/manual/dealer-manual-pages.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(actual, buildManualModule(MANUALS.dealer));
  assert.deepEqual(listManualFiles(MANUALS.dealer.dir), ["README.md", "01-login.md", "02-orders.md", "03-settings.md", "04-faq.md"]);
  assert.deepEqual(DEALER_MANUAL_PAGES.map(p => [p.id, p.label]), [
    ["index", "目次"], ["01-login", "1. ログインと本人確認"], ["02-orders", "2. 受注一覧"], ["03-settings", "3. ディーラー設定"], ["04-faq", "4. よくある質問"]]);
  // 医療機関用の表示データは別(共通化しても混ざらない)
  assert.ok(!MANUAL_PAGES.some(p => DEALER_MANUAL_PAGES.some(d => d.markdown === p.markdown)));
});

test("ディーラー用マニュアル: 原稿どうしのリンクはすべてディーラー用のページに解決でき、目次から全ページへ移動できる", () => {
  for (const p of DEALER_MANUAL_PAGES) {
    const links = collect(parseMarkdown(p.markdown, { resolveLink: resolve }), "link");
    for (const l of links) {
      if (l.link.kind === "page") assert.ok(pageIdFromHash(l.link.href, DEALER_MANUAL_PAGES) && DEALER_MANUAL_PAGES.some(x => manualHash(x.id) === l.link.href), `${p.file}: ${l.link.href}`);
      else assert.match(l.link.href, /^https:\/\//, `${p.file}: 外部リンクは https のみ`);
    }
    const pageLinks = links.filter(l => l.link.kind === "page").length;
    const mdLinks = (p.markdown.match(/\]\((?:\.\/)?[\w-]+\.md\)/g) || []).length;
    assert.equal(pageLinks, mdLinks, `${p.file}: 原稿どうしのリンクがすべて解決できる(医療機関用のページへはリンクしない)`);
  }
  const toc = collect(parseMarkdown(DEALER_MANUAL_PAGES[0].markdown, { resolveLink: resolve }), "link").filter(l => l.link.kind === "page").map(l => l.link.href);
  assert.deepEqual([...new Set(toc)].sort(), DEALER_MANUAL_PAGES.slice(1).map(p => manualHash(p.id)).sort(), "目次から全ページへ");
  // ハッシュはディーラー用のページで判定する(医療機関用の旧ページの読み替えは使わない)
  assert.equal(pageIdFromHash("#help/03-settings", DEALER_MANUAL_PAGES), "03-settings");
  assert.equal(pageIdFromHash("#help/03-managers", DEALER_MANUAL_PAGES), "index");
  assert.equal(pageIdFromHash("#help/04-admin", DEALER_MANUAL_PAGES), "index");
  assert.equal(pageIdFromHash("#help/04-admin"), "03-managers", "医療機関用は従来どおり");
});

test("ディーラー用マニュアル: 扱う内容(受注一覧・週表示・一覧表示・医療機関の選択・本人確認・担当者・支店の管理・よくある質問)", () => {
  const all = DEALER_MANUAL_PAGES.map(p => p.markdown).join("\n");
  for (const s of ["受注一覧", "手術日（週）", "一覧表示", "医療機関の選択", "本人確認", "確認コード", "この端末（ブラウザ）を記憶する", "担当者を招待する",
    "支店を管理する", "担当施設", "「ディーラー設定」", "「使い方・ヘルプ」", "よくある質問", "自社宛ての明細だけ", "会社単位",
    "## 5. テーマカラーを設定する {*}", "会社で共通", "すべての担当者"]) {
    assert.ok(all.includes(s), s);
  }
});

test("ディーラー用マニュアル: 医療機関用に依存しない。サービス名「IOL Order」・サイトの URL・運営者専用の操作は載せない", () => {
  for (const p of DEALER_MANUAL_PAGES) {
    assert.ok(!/IOL\s*Order/i.test(p.markdown), `${p.file}: サービス名`);
    assert.ok(!p.markdown.includes("iol.medconf.jp"), `${p.file}: URL`);
    assert.ok(!/\.\.\/manual\/|01-first-time|02-orderer|03-managers/.test(p.markdown), `${p.file}: 医療機関用のマニュアルへのリンク`);
    for (const s of ["platformAdmin", "運営者の画面", "ディーラー管理", "試験モード", "関連付け"]) assert.ok(!p.markdown.includes(s), `${p.file}: 運営者専用 ${s}`);
  }
  assert.equal(DEALER_MANUAL_PAGES[0].title, "ディーラー用マニュアル");
});

test("ディーラー用マニュアル: ディーラー設定は1ページ。会社管理者のみの項目に印 {*} を付け、末尾に説明。権限の違いを表で示す", () => {
  const md = DEALER_MANUAL_PAGES.find(p => p.id === "03-settings").markdown;
  assert.ok(md.trimEnd().endsWith("{*} 会社管理者のみ操作できます。"), "末尾の説明");
  assert.ok(md.includes("## 4. 支店を管理する {*}"));
  for (const s of ["| **会社管理者** |", "| **支店管理者** |", "| **閲覧者** |", "閲覧者には「ディーラー設定」は表示されません"]) assert.ok(md.includes(s), s);
  const heads = md.split("\n").filter(l => /^##+ /.test(l));
  assert.equal(new Set(heads).size, heads.length, "見出しの重複なし");
});
