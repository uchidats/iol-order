// IOLマスター・度数フィルタ・発注メールの生成を、Cloud Functions 用に functions/src/ へ複製する。
//   npm run sync:catalog
// Cloud Functions のデプロイには functions/ 配下しか含まれないため、クライアント(src/)と同じ定義を複製して使う。
// 複製が元と食い違っていないことは tests/functions-catalog-sync.test.js が検査する。
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const HEADER = (from) =>
  `// 【自動複製】${from} の複製。直接編集しない。\n` +
  "// 元ファイルを変更したら `npm run sync:catalog` で更新する(tests/functions-catalog-sync.test.js が不一致を検出する)。\n";

const copies = [
  ["src/data/iol-models.js", "functions/src/iol-catalog.js", (s) => s],
  ["src/domain/power-filter.js", "functions/src/power-filter.js", (s) => s.replace('"../data/iol-models.js"', '"./iol-catalog.js"')],
  // 発注メールの件名・本文の生成(画面のプレビュー・管理スクリプトと、Cloud Functions の実送信で同じものを使う)。相対パスはそのまま
  ...["order-mail.js", "order-mail-profiles.js", "order-history.js", "order-validation.js", "lens-labels.js"]
    .map(f => [`src/domain/${f}`, `functions/src/shared/${f}`, (s) => s])
];

export function renderCopies() {
  return copies.map(([from, to, transform]) => ({
    to,
    content: HEADER(from) + transform(fs.readFileSync(new URL(from, root), "utf8").replace(/\r\n/g, "\n"))
  }));
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  for (const { to, content } of renderCopies()) fs.writeFileSync(new URL(to, root), content);
  console.log("synced:", copies.map(c => c[1]).join(", "));
}
