# R09 施設設定の統合メモ(一時的な文書)

ブランチ `feature/r09-facility-settings`(基点 `f1d14f6`)。撮影画面(Zenbook)と閲覧画面(`feature/r09-photo-viewer`)の作業と競合しないよう、共通のファイルの変更を保留している。統合が終わったら、この文書は削除してよい。

## 含むもの
- 新規: `src/domain/sticker-settings.js`、`src/data/sticker-settings-api.js`、`src/ui/sticker-settings-section.js`、`tests/sticker-settings.test.js`、`tests/browser/sticker-settings.pw.mjs`
- 変更: `src/ui/facility-settings.js`(セクションの登録)、`src/data/dealer-portal-api.js`(`stickerPhotoCall` の1行)
- 項目は `STICKER_SETTINGS_ENABLED`(`src/domain/sticker-settings.js`。既定 false)で隠している

設計書 §9-2 の5段目のうち、アクセスコード・QR の表示と作り直し・ディーラーへの写真の共有。

## 実装していないもの
- **[台紙を印刷]・[QRコードのみ印刷](§4-2・§4-3)**: 今回の対象外。`@media print` の指定が `styles.css` に要るので、撮影画面の統合の後に行う。台紙の行数も試し刷りの結果を待つ。

## 保留したもの(統合のときに行う)
1. `node scripts/stamp-assets.mjs` を実行し、`index.html`・`dealer.html` を更新する。それまで `tests/asset-stamp.test.js` の2件は失敗する。
2. `src/main.js` は変更していない。`dealerPortalApi` に足した `stickerPhotoCall` で接続している。閲覧画面の統合の後は、`ctx.stickerPhotoApi` にまとめてもよい。
3. `docs/iol-sticker-photo-design.md` の §9-2、`docs/ROADMAP.md`、`docs/CLAUDE_REPORT.md` を更新する。
4. マニュアルは、機能を公開するときに更新する(医療機関用 3)。

## 統合の順序
1. 撮影画面を `feature/r09-sticker-photo` に入れる。
2. `feature/r09-photo-viewer`、続いて `feature/r09-facility-settings` を `git merge --no-ff` で統合する。
3. 閲覧画面の統合メモと、上の「保留したもの」を行う。スタンプは最後に1回だけ実行する。
4. `npm test`、`tests/browser/sticker-settings.pw.mjs`、`tests/browser/dealer-portal-settings.pw.mjs`、`tests/browser/settings-collapse.pw.mjs` を実行する。
