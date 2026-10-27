// オンラインマニュアル(画面の「使い方・ヘルプ」)の表示データを、docs/manual/*.md から作る。
//   node scripts/build-manual.mjs   ← 原稿を変えたら実行する(node scripts/stamp-assets.mjs も先にこれを実行する)
//
// 原稿の管理元は docs/manual/ の Markdown。画面は src/manual/manual-pages.js(このスクリプトの出力)を表示する。
// 公開サイトは Markdown を直接配信しない(ビルド環境がないため、JS のモジュールとして配信し、バージョン付与の対象にする)。
// 原稿と出力の食い違いは tests/manual.test.js が検出する。
import fs from "node:fs";
import { parseInline, inlineText } from "../src/manual/markdown.js";

const root = new URL("../", import.meta.url);
const MANUAL_DIR = new URL("docs/manual/", root);
const OUT_FILE = new URL("src/manual/manual-pages.js", root);

/** 原稿の一覧: README.md(目次)を先頭に、残りはファイル名の順 */
export function listManualFiles() {
  const files = fs.readdirSync(MANUAL_DIR).filter(f => f.endsWith(".md")).sort();
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

export function buildManualModule() {
  const pages = listManualFiles().map(f => buildPage(f, fs.readFileSync(new URL(f, MANUAL_DIR), "utf8")));
  const body = pages.map(p => `  ${JSON.stringify(p)}`).join(",\n");
  return [
    "// 自動生成(直接編集しない): docs/manual/*.md の内容。原稿を変えたら node scripts/build-manual.mjs で作り直す",
    "export const MANUAL_PAGES = Object.freeze([",
    body,
    "]);",
    ""
  ].join("\n");
}

/** 出力を更新する。変わったら true */
export function writeManualModule() {
  const next = buildManualModule();
  const prev = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf8").replace(/\r\n/g, "\n") : "";
  if (prev === next) return false;
  fs.writeFileSync(OUT_FILE, next);
  return true;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  console.log(writeManualModule() ? "src/manual/manual-pages.js を更新しました" : "src/manual/manual-pages.js は最新です");
}
