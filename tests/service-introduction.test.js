import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { parseMarkdown, inlineText } from "../src/manual/markdown.js";
import { INTRODUCTION_PUBLIC_RELEASE, canViewIntroduction, INTRODUCTION_HASH } from "../src/domain/service-introduction.js";
import { buildIntroductionPayload } from "../scripts/publish-introduction.mjs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const WEB_DRAFT = new URL("../docs/introduction/service-introduction-web.md", import.meta.url);

test("紹介ページ: 当面は platformAdmin だけ(画面の判定と Rules の一般公開の設定が一致し、どちらも公開しない)", () => {
  assert.equal(INTRODUCTION_PUBLIC_RELEASE, false);
  assert.ok(read("firestore.rules").includes("function introductionPublic() { return false; }"), "Rules も一般公開しない");
  assert.equal(canViewIntroduction({ isPlatformAdmin: true }), true);
  assert.equal(canViewIntroduction({ isPlatformAdmin: false }), false);
  assert.equal(canViewIntroduction({ isPlatformAdmin: "true" }), false);
  assert.equal(canViewIntroduction(), false);
  assert.equal(INTRODUCTION_HASH, "#about");
});

test("紹介ページ: 本文は公開サイトのファイル(git 管理のファイル)に含めない。画面は Firestore から読む", () => {
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8", cwd: new URL("..", import.meta.url) }).split("\n");
  assert.deepEqual(tracked.filter(f => f.startsWith("docs/introduction/")), [], "原稿は git に入れない(公開サイトから読めてしまう)");
  // 原稿に特有の文言が、配信されるファイル(index.html・src・styles.css)にない
  const srcFiles = fs.readdirSync(new URL("../src/", import.meta.url), { recursive: true }).map(f => `src/${String(f).replace(/\\/g, "/")}`).filter(f => f.endsWith(".js"));
  const served = [read("index.html"), read("styles.css"), ...srcFiles.map(read)].join("\n");
  for (const s of ["医療機関とディーラーのやり取りを支える", "医療機関とディーラーのメリット", "安全性への取り組み", "利用開始までの流れ"]) {
    assert.ok(!served.includes(s), `配信されるファイルに紹介の本文がない: ${s}`);
  }
  assert.match(read("src/data/firestore-repository.js"), /fs\.doc\(db, "platformContent", "serviceIntroduction"\)/);
});

test("折りたたみ: 決まった形の <details>/<summary> だけを折りたたみにし、見出しは文字として扱う", () => {
  const b = parseMarkdown(["<details>", "<summary>仕様 <b>概要</b></summary>", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "", "</details>", "", "本文"].join("\n"));
  assert.deepEqual(b.map(x => x.type), ["details", "paragraph"]);
  assert.equal(inlineText(b[0].summary), "仕様 <b>概要</b>", "見出しの HTML は文字のまま");
  assert.deepEqual(b[0].children.map(x => x.type), ["table"]);
  // 見出しがない・閉じがない・属性つき は折りたたみにしない(文字のまま)
  assert.equal(parseMarkdown("<details>\n本文\n</details>")[0].type, "paragraph");
  assert.equal(parseMarkdown("<details>\n<summary>x</summary>\n本文")[0].type, "paragraph");
  assert.equal(parseMarkdown('<details open ontoggle="alert(1)">\n<summary>x</summary>\n</details>')[0].type, "paragraph");
  // 入れ子
  const n = parseMarkdown("<details>\n<summary>外</summary>\n<details>\n<summary>内</summary>\nA\n</details>\n</details>");
  assert.equal(n.length, 1);
  assert.equal(n[0].children[0].type, "details");
});

test("登録スクリプト: 原稿の検証(空・大きすぎる原稿は登録しない)。章と折りたたみを数える", () => {
  assert.deepEqual(buildIntroductionPayload("").errors, ["原稿が空です"]);
  assert.ok(buildIntroductionPayload("a".repeat(300 * 1024)).errors.length);
  const p = buildIntroductionPayload("# 題\r\n\r\n## 1. A\r\n\r\n<details>\r\n<summary>S</summary>\r\n\r\nx\r\n\r\n</details>\r\n\r\n## 2. B\r\n");
  assert.deepEqual([p.title, p.chapters, p.details, p.errors], ["題", ["1. A", "2. B"], 1, []]);
  assert.ok(!p.data.markdown.includes("\r"), "改行は LF にそろえる");
  assert.match(p.data.sha256, /^[0-9a-f]{64}$/);
});

test("Web掲載用原稿(手元にある場合): 6章構成・詳しい仕様の折りたたみ・未実装の機能を実装済みとしない", (t) => {
  if (!fs.existsSync(WEB_DRAFT)) return t.skip("docs/introduction/service-introduction-web.md がない(git 管理外)");
  const p = buildIntroductionPayload(fs.readFileSync(WEB_DRAFT, "utf8"));
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.chapters, ["1. IOL Orderとは", "2. 主な特徴", "3. 医療機関とディーラーのメリット", "4. 安全性への取り組み", "5. 詳しい機能・仕様", "6. 利用開始までの流れ"]);
  assert.equal(p.details, 3);
  assert.ok(!p.data.markdown.includes("すべての役割の利用者管理（招待"), "管理者は管理者を招待できない(現行の実装)");
});
