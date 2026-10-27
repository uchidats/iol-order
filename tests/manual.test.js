import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseMarkdown, parseInline } from "../src/manual/markdown.js";
import { MANUAL_PAGES } from "../src/manual/manual-pages.js";
import { resolveManualLink, pageIdFromHash, manualHash, MANUAL_PAGE_ALIASES } from "../src/ui/manual-view.js";
import { buildManualModule, listManualFiles } from "../scripts/build-manual.mjs";

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

test("マニュアル: 表示データ(src/manual/manual-pages.js)は docs/manual の原稿と一致する(原稿を変えたら node scripts/build-manual.mjs)", () => {
  const actual = fs.readFileSync(new URL("../src/manual/manual-pages.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(actual, buildManualModule());
  assert.deepEqual(listManualFiles(), ["README.md", "01-first-time.md", "02-orderer.md", "03-managers.md"]);
  assert.deepEqual(MANUAL_PAGES.map(p => [p.id, p.label]), [
    ["index", "目次"], ["01-first-time", "1. 初めて利用する方へ"], ["02-orderer", "2. 注文者・代理入力者向け"],
    ["03-managers", "3. 副管理者・施設管理者向け"]]);
});

test("マニュアル: 原稿どうしのリンクはすべてページに解決でき、目次から全ページへ移動できる", () => {
  for (const p of MANUAL_PAGES) {
    // 原稿のリンク書式 [..](..) の数と、解決できたリンクの数が一致する(解決できないリンクがない)
    const written = (p.markdown.match(/\[[^\]]+\]\([^)\s]+\)/g) || []).length;
    const links = collect(parseMarkdown(p.markdown, { resolveLink: resolveManualLink }), "link");
    assert.ok(links.length >= written, `${p.file}: 書いたリンクはすべてリンクになる`);
    for (const l of links) {
      if (l.link.kind === "page") assert.ok(pageIdFromHash(l.link.href) && MANUAL_PAGES.some(x => manualHash(x.id) === l.link.href), `${p.file}: ${l.link.href}`);
      else assert.match(l.link.href, /^https:\/\//, `${p.file}: 外部リンクは https のみ`);
    }
    const pageLinks = links.filter(l => l.link.kind === "page").length;
    const mdLinks = (p.markdown.match(/\]\((?:\.\/)?[\w-]+\.md\)/g) || []).length;
    assert.equal(pageLinks, mdLinks, `${p.file}: 原稿どうしのリンクがすべて解決できる`);
  }
  const toc = collect(parseMarkdown(MANUAL_PAGES[0].markdown, { resolveLink: resolveManualLink }), "link").filter(l => l.link.kind === "page").map(l => l.link.href);
  assert.deepEqual([...new Set(toc)].sort(), MANUAL_PAGES.slice(1).map(p => manualHash(p.id)).sort(), "目次から全ページへ");
});

test("マニュアル: URL のハッシュとページ", () => {
  assert.equal(pageIdFromHash("#help"), "index");
  assert.equal(pageIdFromHash("#help/"), "index");
  assert.equal(pageIdFromHash("#help/02-orderer"), "02-orderer");
  assert.equal(pageIdFromHash("#help/unknown"), "index", "知らないページは目次");
  assert.equal(pageIdFromHash("#help/<script>"), null);
  assert.equal(pageIdFromHash(""), null);
  assert.equal(pageIdFromHash("#helpdesk"), null);
  assert.equal(manualHash("index"), "#help");
  assert.equal(manualHash("03-managers"), "#help/03-managers");
  assert.deepEqual(resolveManualLink("./03-managers.md"), { kind: "page", href: "#help/03-managers" });
  // 統合した旧ページの URL は、統合先へ(閲覧範囲の判定は表示のときに行う)
  assert.equal(pageIdFromHash("#help/03-subadmin"), "03-managers");
  assert.equal(pageIdFromHash("#help/04-admin"), "03-managers");
  assert.deepEqual(Object.values(MANUAL_PAGE_ALIASES).filter(id => !MANUAL_PAGES.some(p => p.id === id)), [], "統合先は存在するページ");
  assert.equal(resolveManualLink("./04-admin.md"), null, "原稿から旧ページへのリンクはない");
  assert.deepEqual(resolveManualLink("README.md"), { kind: "page", href: "#help" });
  assert.equal(resolveManualLink("./missing.md"), null);
});

test("マニュアル: 書式(見出し・段落・改行・入れ子の箇条書き・表・引用・コード・太字・リンク)", () => {
  const md = [
    "# 題名", "", "本文1行目  ", "2行目", "続き", "", "---", "",
    "1. **[ページ](./02-orderer.md)**", "   - 子A", "     - 孫", "   - 子B", "", "2. 次", "",
    "| 役割 | 可否 |", "| :--- | :---: |", "| **管理者** | ○ |", "",
    "> **重要**  ", "> - 引用の中の項目", "", "メニュー（**`≡`**）→ https://iol.medconf.jp/ を開く"
  ].join("\n");
  const b = parseMarkdown(md, { resolveLink: resolveManualLink });
  assert.deepEqual(b.map(x => x.type), ["heading", "paragraph", "hr", "list", "table", "blockquote", "paragraph"]);
  assert.deepEqual(b[1].children, [{ type: "text", text: "本文1行目" }, { type: "br" }, { type: "text", text: "2行目続き" }], "行末の空白2つは改行、日本語どうしは詰める");
  const list = b[3];
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 2, "空行をはさんでも同じ番号付きの箇条書き");
  assert.deepEqual(list.items[0].children.map(c => c.type), ["paragraph", "list"]);
  assert.equal(list.items[0].children[1].items.length, 2);
  assert.equal(list.items[0].children[1].items[0].children[1].type, "list", "孫の項目");
  assert.deepEqual(list.items[0].children[0].children[0].children[0].link, { kind: "page", href: "#help/02-orderer" });
  assert.deepEqual(b[4].align, ["left", "center"]);
  assert.equal(b[4].rows[0][0][0].type, "strong");
  assert.deepEqual(b[5].children.map(c => c.type), ["paragraph", "list"]);
  assert.deepEqual(b[6].children.map(c => c.type), ["text", "strong", "text", "link", "text"]);
  assert.deepEqual(b[6].children[3].link, { kind: "external", href: "https://iol.medconf.jp/" });
  assert.deepEqual(b[6].children[1].children, [{ type: "code", text: "≡" }]);
});

test("マニュアル: HTML・危険なリンクは文字として扱う(タグを作らない。javascript:・data: などはリンクにしない)", () => {
  const md = '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[押す](javascript:alert(1)) [画像](data:text/html,x) [相対](../secret) [外部](https://example.com/a?b=1)';
  const b = parseMarkdown(md, { resolveLink: resolveManualLink });
  assert.deepEqual(b[0].children, [{ type: "text", text: "<script>alert(1)</script>" }]);
  assert.deepEqual(b[1].children, [{ type: "text", text: '<img src=x onerror="alert(1)">' }]);
  const links = collect(b, "link");
  assert.deepEqual(links.map(l => l.link), [{ kind: "external", href: "https://example.com/a?b=1" }], "https の外部リンクだけ");
  assert.ok(collect(b, "text").some(t => t.text.includes("押す")), "リンクにできないものは文字だけ");
  // 既定(resolveLink なし)でも http(s) 以外はリンクにしない
  for (const src of ["[x](javascript:alert(1))", "[x](JaVaScRiPt:alert(1))", "[x](vbscript:x)", "[x](//evil.example/)"]) {
    const r = parseInline(src);
    assert.ok(r.every(n => n.type === "text") && r[0].text.startsWith("x"), src);
  }
});

test("マニュアル: 原稿の内容(新しい機能を反映し、運営者専用の操作手順は載せない)", () => {
  const all = MANUAL_PAGES.map(p => p.markdown).join("\n");
  for (const s of ["使い方・ヘルプ", "施設の最初の管理者として参加する場合", "「施設登録の申請が承認されました」", "「施設登録の申請の結果」",
    "「施設の管理者としての参加のご案内」", "はじめに：最初の管理者になったら", "注文の受付の開始については、運営者からご連絡します"]) {
    assert.ok(all.includes(s), s);
  }
  for (const s of ["施設を事前登録」", "施設登録の申請」", "platformAdmin", "却下理由を申請者へのメールに記載する"]) {
    assert.ok(!all.includes(s), `運営者専用の画面・操作は載せない: ${s}`);
  }
});

test("マニュアル: サービス名「IOL Order」とサイトの URL は載せない(当面の方針)。目次の題名と冒頭", () => {
  for (const p of MANUAL_PAGES) {
    assert.ok(!/IOL\s*Order/i.test(p.markdown), `${p.file}: サービス名`);
    assert.ok(!p.markdown.includes("iol.medconf.jp"), `${p.file}: URL`);
  }
  assert.equal(MANUAL_PAGES[0].title, "オンラインマニュアル");
  assert.ok(MANUAL_PAGES[0].markdown.includes("眼内レンズ発注システムの操作マニュアルです。"));
});

test("マニュアルの表示範囲: 未ログインは目次・1、注文者/代行入力者は〜2、副管理者・管理者・運営者は〜3。確認中は未ログインと同じ", async () => {
  const { manualAudience, visibleManualPages, canViewManualPage, MANUAL_PAGE_LEVEL } = await import("../src/domain/manual-access.js");
  const ids = (aud) => visibleManualPages(MANUAL_PAGES, aud).map(p => p.id);
  assert.deepEqual(Object.keys(MANUAL_PAGE_LEVEL).sort(), MANUAL_PAGES.map(p => p.id).sort(), "全ページの範囲が決まっている");
  assert.deepEqual(ids("guest"), ["index", "01-first-time"]);
  assert.deepEqual(ids(null), ["index", "01-first-time"], "確認中");
  assert.deepEqual(ids("orderer"), ["index", "01-first-time", "02-orderer"]);
  assert.deepEqual(ids("proxy"), ["index", "01-first-time", "02-orderer"]);
  assert.deepEqual(ids("subadmin"), MANUAL_PAGES.map(p => p.id));
  assert.deepEqual(ids("admin"), MANUAL_PAGES.map(p => p.id));
  assert.deepEqual(ids("platformAdmin"), MANUAL_PAGES.map(p => p.id));
  assert.equal(canViewManualPage("99-new", "subadmin"), false, "範囲が決まっていないページは管理者だけ");
  const base = { checked: true, user: { uid: "u" }, isPlatformAdmin: false, membershipsLoaded: true, grantedRole: "subadmin" };
  assert.equal(manualAudience({ ...base, checked: false }), null, "ログインの確認中");
  assert.equal(manualAudience({ ...base, membershipsLoaded: false }), null, "所属の確認中");
  assert.equal(manualAudience({ ...base, user: null }), "guest");
  assert.equal(manualAudience(base), "subadmin");
  assert.equal(manualAudience({ ...base, grantedRole: null }), "guest", "施設に入る前");
  assert.equal(manualAudience({ ...base, grantedRole: "unknown" }), "guest");
  assert.equal(manualAudience({ ...base, grantedRole: "orderer", isPlatformAdmin: true, membershipsLoaded: false }), "platformAdmin");
});

test("マニュアル: 廃止した招待コード方式・「招待」の表現を載せない(現在は 事前登録 → ログイン → 参加の承諾)", () => {
  const all = MANUAL_PAGES.map(p => p.markdown).join("\n");
  assert.ok(!/招待/.test(all), "招待");
  assert.ok(!/コードを(発行|入力)|招待コード/.test(all));
  const first = MANUAL_PAGES.find(p => p.id === "01-first-time").markdown;
  assert.ok(first.includes("## 3. 既存の施設に参加する") && first.includes("**参加を承諾**"));
  assert.ok(MANUAL_PAGES.find(p => p.id === "03-managers").markdown.includes("新しい施設そのものの登録（施設の登録申請、または運営者による施設の登録）とは別"), "利用者の事前登録と施設の登録を区別する");
});

test("マニュアル: 副管理者・施設管理者向けは1ページ。施設管理者のみの項目に印 {*} を付け、末尾に説明。テーマカラーなど共通の機能も載せる", () => {
  const md = MANUAL_PAGES.find(p => p.id === "03-managers").markdown;
  assert.ok(md.trimEnd().endsWith("{*} 施設管理者のみ操作できます。"), "末尾の説明");
  for (const s of ["## 9. 施設名を変更する {*}", "## 10. 施設を削除する {*}", "| 施設名の変更 {*} | × | ○ |", "| 施設の削除 {*} | × | ○ |", "副管理者の事前登録・削除 {*}"]) {
    assert.ok(md.includes(s), s);
  }
  for (const s of ["## 3. 担当医の設定", "## 4. 利用者管理", "## 5. 採用IOLの設定", "## 6. ディーラー（発注先）の設定", "## 7. 注文メールの設定", "## 8. テーマカラーの設定", "はじめに：最初の管理者になったら"]) {
    assert.ok(md.includes(s), `共通の項目: ${s}`);
  }
  // 共通の項目(担当医〜テーマカラー)の見出しには印を付けない
  for (const line of md.split("\n").filter(l => /^## [3-8]\./.test(l))) assert.ok(!line.includes("{*}"), line);
  // 同じ見出しを重複させない
  const heads = md.split("\n").filter(l => /^##+ /.test(l));
  assert.equal(new Set(heads).size, heads.length, "見出しの重複なし");
  // 印は表示用の構造になり、文字では * と読める
  const b = parseMarkdown("## 9. 施設名を変更する {*}");
  assert.deepEqual(b[0].children.map(n => n.type), ["text", "adminMark"]);
});
