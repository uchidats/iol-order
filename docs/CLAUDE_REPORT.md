# Claude Code 作業報告(最新)

> このファイルは作業完了ごとに上書きする最新1件。記録のルールは `CLAUDE.md`。実データ・認証情報・バックアップの中身は書かない。

- **日時**: 2026-11-04
- **作業**: ログイン画面の高さの修正(CSS のみ)。別の端末(Zenbook)の修正を push できなかったため、Lenovo で origin/main(`b384e8d`)を基準に同じ内容を再現。
- `styles.css`: `.auth-signin` に限定して「Googleでログイン」・メールアドレス欄・「ログインリンクを送信」の高さを 50px から 40px へ。上下の余白だけを詰めた。
- 横幅・文字サイズ・左右の余白・項目の間隔・配色は変更なし(変更前後の実測で確認)。ログイン画面の外の `.btn`・`.form-control` は変更なし。
- Functions・Rules の変更なし。既存の作業フォルダ・stash は変更していない(作業は一時的な clone で実施)。

## commit ID
- 本体: 本ファイルを含む commit(`git log -1`)。

## テスト結果
- ブラウザ: 新規 `tests/browser/login-height.pw.mjs`(3ブラウザ、スマホ幅 390px・PC幅 1100px)成功。
- unit: `tests/asset-stamp.test.js` 成功。
- 未実行(軽微な CSS のため関連分に限定): `npm test` 全体・ほかのブラウザテスト・Functions・Rules。

## push・公開
- main へ push し GitHub Pages で公開。Functions・Rules のデプロイはなし。

## 判断待ち事項
- NP-T の下限の取り込み(メーカーへの T5・T6 の確認、main への統合、Functions のデプロイ)。修正は `fix/np-t-power-limits` に保留中。
- 実機検証の結果の共有(Galaxy S24 Ultra → iPhone)と、それによる R09 の圧縮条件・15MB の上限・鮮鋭度のしきい値の確定。
- R09 第1段階の着手(バケットと IAM の付与の承認・実施方法、有効にする施設とコードの運用)。
- E2E の2件の環境の問題(エミュレータ用の秘密情報のダミー値)を直すか(前回から継続)。
- 使わなくなった降順用の複合インデックス(`orderSurgeryIndex`)を削除するか(前回から継続)。
- 実行サービスアカウントの `roles/firebaseauth.viewer` を外すか(前回から継続)。

## 残課題
- Zenbook 側の未 push の修正は、今回の main と内容が重なるため、取り込まずに破棄するか比較して整理する。
- 本体フォルダ(`feature/dealer-portal`)は `docs/introduction/` の除外を含まないため、main に切り替えるまでは未追跡のまま表示される。
- サブテーマカラー(施設・ディーラー)の実機での目視確認(運営者の端末で)。
- 共通連番での最初の実注文の後に `node scripts/admin/check-order-numbers.mjs` を実行して確認する(前回から継続)。
- ディーラーのログインを伴う実画面での確認(運営者の端末で。出力を含む)。
