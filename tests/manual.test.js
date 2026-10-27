import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseMarkdown, parseInline } from "../src/manual/markdown.js";
import { MANUAL_PAGES } from "../src/manual/manual-pages.js";
import { resolveManualLink, pageIdFromHash, manualHash } from "../src/ui/manual-view.js";
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
  assert.deepEqual(listManualFiles(), ["README.md", "01-first-time.md", "02-orderer.md", "03-subadmin.md", "04-admin.md"]);
  assert.deepEqual(MANUAL_PAGES.map(p => [p.id, p.label]), [
    ["index", "目次"], ["01-first-time", "1. 初めて利用する方へ"], ["02-orderer", "2. 注文者・代理入力者向け"],
    ["03-subadmin", "3. 副管理者向け"], ["04-admin", "4. 施設管理者向け"]]);
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
  assert.equal(manualHash("04-admin"), "#help/04-admin");
  assert.deepEqual(resolveManualLink("./03-subadmin.md"), { kind: "page", href: "#help/03-subadmin" });
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
  for (const s of ["使い方・ヘルプ", "施設の最初の管理者として参加する場合", "【IOL Order】施設登録の申請が承認されました", "【IOL Order】施設登録の申請の結果",
    "【IOL Order】施設の管理者としての参加のご案内", "はじめに：最初の管理者になったら", "注文の受付の開始については、IOL Order 運営者からご連絡します"]) {
    assert.ok(all.includes(s), s);
  }
  for (const s of ["施設を事前登録」", "施設登録の申請」", "platformAdmin", "却下理由を申請者へのメールに記載する"]) {
    assert.ok(!all.includes(s), `運営者専用の画面・操作は載せない: ${s}`);
  }
});
