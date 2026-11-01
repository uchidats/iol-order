// オンラインマニュアル(画面の「使い方・ヘルプ」)の表示データを、docs/manual/*.md から作る。
//   node scripts/build-manual.mjs   ← 原稿を変えたら実行する(node scripts/stamp-assets.mjs も先にこれを実行する)
//
// 原稿の管理元は docs/manual/ の Markdown。画面は src/manual/manual-pages.js(このスクリプトの出力)を表示する。
// 公開サイトは Markdown を直接配信しない(ビルド環境がないため、JS のモジュールとして配信し、バージョン付与の対象にする)。
// 原稿と出力の食い違いは tests/manual.test.js が検出する。
// ディーラー画面(dealer.html)の「使い方・ヘルプ」は、医療機関用とは独立した原稿 docs/dealer-manual/ から
// src/manual/dealer-manual-pages.js を作る(同じ仕組み。食い違いは tests/dealer-manual.test.js が検出する)。
import fs from "node:fs";
import { parseInline, inlineText } from "../src/manual/markdown.js";

const root = new URL("../", import.meta.url);
const MANUAL_DIR = new URL("docs/manual/", root);

/** 原稿のフォルダ・出力先・書き出す名前(医療機関用・ディーラー用) */
export const MANUALS = Object.freeze({
  facility: Object.freeze({ dir: MANUAL_DIR, out: new URL("src/manual/manual-pages.js", root), name: "MANUAL_PAGES", src: "docs/manual", outPath: "src/manual/manual-pages.js" }),
  dealer: Object.freeze({ dir: new URL("docs/dealer-manual/", root), out: new URL("src/manual/dealer-manual-pages.js", root), name: "DEALER_MANUAL_PAGES", src: "docs/dealer-manual", outPath: "src/manual/dealer-manual-pages.js" })
});

/** 原稿の一覧: README.md(目次)を先頭に、残りはファイル名の順 */
export function listManualFiles(dir = MANUAL_DIR) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".md")).sort();
  return ["README.md", ...files.filter(f => f !== "README.md")].filter(f => files.includes(f));
}

export const pageIdOf = (file) => (file === "README.md" ? "index" : file.replace(/\.md$/, ""));

/** 1ページ分: 見出し(最初の #)を題名に、ナビゲーションには「（」より前の短い名前を使う */
export function buildPage(file, markdown) {
  const text = String(markdown).replace(/\r\n?/g, "\n");
  const h1 = (text.match(/^#\s+(.+)$/m) || [])[1] || file;
  const title = inlineText(parseInline(h1)).trim();
  const id = pageIdOf(file);
  const label = id === "index" ? "目次" : title.split("（")[0].trim();
  return { id, file, title, label, markdown: text };
}

export function buildManualModule(m = MANUALS.facility) {
  const pages = listManualFiles(m.dir).map(f => buildPage(f, fs.readFileSync(new URL(f, m.dir), "utf8")));
  const body = pages.map(p => `  ${JSON.stringify(p)}`).join(",\n");
  return [
    `// 自動生成(直接編集しない): ${m.src}/*.md の内容。原稿を変えたら node scripts/build-manual.mjs で作り直す`,
    `export const ${m.name} = Object.freeze([`,
    body,
    "]);",
    ""
  ].join("\n");
}

/** 出力を更新する。変わったら true */
export function writeManualModule(m = MANUALS.facility) {
  const next = buildManualModule(m);
  const prev = fs.existsSync(m.out) ? fs.readFileSync(m.out, "utf8").replace(/\r\n/g, "\n") : "";
  if (prev === next) return false;
  fs.writeFileSync(m.out, next);
  return true;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  for (const m of Object.values(MANUALS)) console.log(writeManualModule(m) ? `${m.outPath} を更新しました` : `${m.outPath} は最新です`);
}
