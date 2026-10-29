// 画面ファイル(JS・CSS)にバージョン(内容のハッシュ)を付け、ブラウザのキャッシュによる「古いJS×新しいHTML」の食い違いを防ぐ。
//   npm run stamp      ← src/ や styles.css を変更したら、コミット前に実行する(tests/asset-stamp.test.js が更新漏れを検出する)
//
// ビルド環境がなく ES Modules を直接配信しているため、各モジュールの URL にクエリ(?v=ハッシュ)を付ける。
// import 文は相対パスのまま、index.html の import map が「./src/…js → ./src/…js?v=ハッシュ」に対応づける。
// ファイルの内容が変わったときだけ URL が変わるので、変わっていないファイルはキャッシュされたまま使える。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = new URL("../", import.meta.url);
const rootPath = (p) => new URL(p, root);

const hashOf = (file) =>
  createHash("sha256").update(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")).digest("hex").slice(0, 10);

function listJs(dir, base = "src") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${base}/${e.name}`;
    if (e.isDirectory()) out.push(...listJs(new URL(`${e.name}/`, dir), rel));
    else if (e.name.endsWith(".js") && e.name !== "config.local.js") out.push(rel); // config.local.js は端末ごとの設定(Git管理外)
  }
  return out.sort();
}

export function buildImportMap() {
  const imports = {};
  for (const rel of listJs(rootPath("src/"))) imports[`./${rel}`] = `./${rel}?v=${hashOf(rootPath(rel))}`;
  return imports;
}

const BEGIN = "<!-- asset-stamp:begin -->";
const END = "<!-- asset-stamp:end -->";

/** index.html・dealer.html に、import map とバージョン付きの main.js(ディーラー用は src/dealer/main.js)/ styles.css を反映した文字列を返す */
export function stampHtml(html) {
  const map = buildImportMap();
  const block = `${BEGIN}\n  <script type="importmap">\n${JSON.stringify({ imports: map }, null, 2).replace(/^/gm, "  ")}\n  </script>\n  ${END}`;
  let out = html.replace(/\r\n/g, "\n");
  if (!out.includes(BEGIN)) out = out.replace("</head>", `  ${BEGIN}\n  ${END}\n</head>`);
  out = out.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), () => block);
  out = out.replace(/href="styles\.css(\?v=[0-9a-f]+)?"/, `href="styles.css?v=${hashOf(rootPath("styles.css"))}"`);
  out = out.replace(/src="src\/main\.js(\?v=[0-9a-f]+)?"/, `src="src/main.js?v=${hashOf(rootPath("src/main.js"))}"`);
  out = out.replace(/src="src\/dealer\/main\.js(\?v=[0-9a-f]+)?"/, `src="src/dealer/main.js?v=${hashOf(rootPath("src/dealer/main.js"))}"`);
  return out;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  // マニュアルの表示データ(src/manual/manual-pages.js)を先に作り直す(原稿 docs/manual の変更もバージョンに反映する)
  const { writeManualModule } = await import("./build-manual.mjs");
  if (writeManualModule()) console.log("src/manual/manual-pages.js を更新しました");
  for (const name of ["index.html", "dealer.html"]) {   // dealer.html: ディーラー専用画面の入口
    const file = rootPath(name);
    const html = fs.readFileSync(file, "utf8");
    const stamped = stampHtml(html);
    fs.writeFileSync(file, stamped);
    console.log(stamped === html.replace(/\r\n/g, "\n") ? `${name} は最新です` : `${name} を更新しました`);
  }
}
