# R09 撮影画面の統合メモ(一時的な文書)

ブランチ `feature/r09-capture-screen`(基点 `f1d14f6`)。Zenbook がオフラインになったため、Lenovo で §9-2 の4段目を実装した。統合が終わったら、この文書は削除してよい。

## 含むもの
- 新規: `sticker.html`、`sticker.css`、`src/sticker/main.js`、`src/sticker/sticker-app.js`(画面)、`src/sticker/capture-controller.js`(流れ。DOM なし)、`src/domain/sticker-capture.js`、`src/data/sticker-capture-api.js`、`tests/sticker-capture.test.js`、`tests/browser/sticker-capture.pw.mjs`、`tests/functions/sticker-capture-flow.test.js`
- 変更: `scripts/stamp-assets.mjs`(`sticker.html`・`sticker.css`・`src/sticker/main.js` を対象に追加)、`tests/asset-stamp.test.js`、`index.html`・`dealer.html`(スタンプの結果)

## 設計との差
- Firebase SDK は読み込まない。`stickerEntryApi` は callable の形式を `fetch` で呼ぶ。App Check を必須にするときは、確認の要求にトークンを足す。

## Zenbook の未コミットの作業があるとき
同じファイル名(`sticker.html`、`src/sticker/*`)になる可能性が高い。そのままマージせず、次の順で扱う。
1. Zenbook で `git status -sb` を確認する。
2. 変更があれば、別のブランチ(例 `wip/zenbook-capture`)に commit・push する。`feature/r09-sticker-photo` へは push しない。
3. `git diff origin/feature/r09-capture-screen origin/wip/zenbook-capture` で比べ、Zenbook 側にだけある良い部分を、このブランチへ手で取り込む。

## 統合のときに行うこと
1. このブランチ → `feature/r09-photo-viewer` → `feature/r09-sheet-print` の順に `feature/r09-sticker-photo` へ `git merge --no-ff` で統合する。
2. 全部のマージの後に `node scripts/stamp-assets.mjs` を1回実行する。
3. `docs/iol-sticker-photo-design.md` の §9-2、`docs/ROADMAP.md`、`docs/CLAUDE_REPORT.md` を更新する。
