# R09 写真閲覧画面の統合メモ(一時的な文書)

ブランチ `feature/r09-photo-viewer`(基点 `f1d14f6`)。Zenbook の撮影画面の作業と同時に進めたため、同じファイルの変更を保留している。統合が終わったら、この文書は削除してよい。

## 含むもの
- 新規: `src/data/sticker-photo-api.js`、`src/domain/sticker-photo-view.js`、`src/ui/sticker-photo-viewer.js`、`src/ui/sticker-photo-viewer.css`、`tests/sticker-photo-view.test.js`、`tests/browser/sticker-photo-viewer.pw.mjs`
- 変更(組み込み): `src/main.js`、`src/ui/header-menu.js`、`src/dealer/main.js`、`src/dealer/dealer-app.js`、`src/dealer/dealer-header-menu.js`
- メニューは `STICKER_VIEWER_ENABLED`(`src/domain/sticker-photo-view.js`。既定 false)で隠している

設計書 §9-2 の6段目(医療機関用の一覧・拡大)と7段目(ディーラー用の一覧・拡大)にあたる。5段目(施設設定)は含まない。

## 保留したもの(統合のときに行う)
1. `node scripts/stamp-assets.mjs` を実行し、`index.html`・`dealer.html` を更新する。それまで `tests/asset-stamp.test.js` の2件は失敗する。
2. `src/ui/sticker-photo-viewer.css` の内容を `styles.css` へ移し、`src/ui/sticker-photo-viewer.js` の `ensureStyles` とその呼び出しを消す。
3. `docs/iol-sticker-photo-design.md` の §9-2、`docs/ROADMAP.md`、`docs/CLAUDE_REPORT.md` を更新する。
4. マニュアルは、機能を公開するときに更新する(医療機関用 2、ディーラー用 02)。

## 統合の手順
1. Zenbook の撮影画面の作業を commit・push する。
2. 撮影画面が `feature/r09-sticker-photo` に入ったら、`git merge --no-ff origin/feature/r09-photo-viewer` を行う。
3. 上の「保留したもの」の 1〜3 を行う。
4. `npm test`、`tests/browser/sticker-photo-viewer.pw.mjs`、`tests/browser/dealer-portal.pw.mjs`、`tests/browser/facility-switch.pw.mjs`、`tests/browser/order-history.pw.mjs` を実行する。
