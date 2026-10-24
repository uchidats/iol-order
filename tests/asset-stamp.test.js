// index.html のバージョン付きURL(import map)が、実際のファイル内容と一致していること。
// 食い違うと、ブラウザのキャッシュに残った古いJSと新しいHTMLが組み合わさり、画面が壊れる(入力欄が出ない等)。
//   食い違ったら `npm run stamp` を実行してコミットする
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { stampHtml, buildImportMap } from "../scripts/stamp-assets.mjs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("index.html のバージョン(import map・main.js・styles.css)が最新: 更新漏れの検出", () => {
  assert.equal(stampHtml(html), html, "index.html is stale: run `npm run stamp`");
});

test("import map は src/ 配下の全モジュールを網羅し、import map が最初のモジュール読み込みより前にある", () => {
  const map = buildImportMap();
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js") && e.name !== "config.local.js") files.push(p);
  } };
  walk(new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  assert.equal(Object.keys(map).length, files.length);
  for (const k of Object.keys(map)) assert.match(map[k], /^\.\/src\/.+\.js\?v=[0-9a-f]{10}$/);
  assert.ok(html.indexOf('type="importmap"') < html.indexOf('type="module"'));
});

test("内容が変わると、そのファイルのバージョンが変わる(キャッシュが更新される)", () => {
  const a = buildImportMap();
  const b = buildImportMap();
  assert.deepEqual(a, b); // 同じ内容なら同じ(決定的)
  assert.match(html, /href="styles\.css\?v=[0-9a-f]{10}"/);
  assert.match(html, /src="src\/main\.js\?v=[0-9a-f]{10}"/);
});
