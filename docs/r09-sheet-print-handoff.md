# R09 台紙・QR の印刷の統合メモ(一時的な文書)

ブランチ `feature/r09-sheet-print`(基点 `feature/r09-facility-settings` の `1e6facf`)。施設設定の画面にボタンを置くので、施設設定の上に積んでいる。統合が終わったら、この文書は削除してよい。

## 含むもの
- 新規: `src/domain/sticker-print.js`(様式。行数は `SHEET.rows` の1か所)、`src/ui/sticker-print-view.js`(印刷の画面)、`src/ui/sticker-print.css`(印刷専用)、`tests/sticker-print.test.js`、`tests/browser/sticker-print.pw.mjs`
- 変更: `src/ui/sticker-settings-section.js`(ボタン)、`src/ui/facility-settings.js`(`getDealers` の1か所)

## 保留したもの(統合のときに行う)
1. `node scripts/stamp-assets.mjs` を実行し、`index.html`・`dealer.html` を更新する。それまで `tests/asset-stamp.test.js` の2件は失敗する。
2. `src/ui/sticker-print.css` は `styles.css` へ移さない。`@page` の余白 0 はページ全体に効くので、印刷の画面を開いている間だけ読む今の形を残す。
3. `docs/iol-sticker-photo-design.md` の §4-2(余白の記述)・§9-2、`docs/ROADMAP.md`、`docs/CLAUDE_REPORT.md` を更新する。
4. 試し刷りの結果で行数が変わったら、`SHEET.rows`・`SHEET.rowHeight` と、テストの期待値を直す。
5. マニュアルは、機能を公開するときに更新する(医療機関用 3)。

## 統合の順序
撮影画面 → `feature/r09-photo-viewer` → `feature/r09-sheet-print`(施設設定を含む)の順に `git merge --no-ff` で統合し、最後に上の 1・3 を行う。
