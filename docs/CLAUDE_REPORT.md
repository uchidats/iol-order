# Claude Code 作業報告(最新)

> このファイルは作業完了ごとに上書きする最新1件。記録のルールは `CLAUDE.md`。実データ・認証情報・バックアップの中身は書かない。

- **日時**: 2026-10-26
- **作業**: 本番運用への切り替え(許可リストのまま。許可施設1件・許可ユーザー1名=運営者のみ。ほかの医師は従来の Google フォーム)
- 注文・メール送信のテストは実行していない(実際の注文は利用者が行う)。

## 事前確認(読み取りのみ)
- 許可施設のディーラー: 1件。発注用メールは実際の宛先に修正済み(前回の仮のアドレスではない)。署名・注文控え(ON・送信先1件)は前回確認のとおり。
- 送信待ちのメール: なし(既存は前回のテスト注文の送信済み1件のみ。切り替え後に過去分が送られることはない)。

## 設定(functions/.env.medconf-iol-dev)
- `ORDER_INTAKE_ENABLED=true`・`ORDER_INTAKE_UNRESTRICTED=false`・`ORDER_TEST_MODE=false`・`MAIL_SENDING_ENABLED=true`・`MAIL_TEST_ONLY=false`。許可施設・許可ユーザーは変更なし。コメントを現状に合わせて更新。

## デプロイ・反映
- Functions: `createOrder`・`sendOrderMail`・`retryOrderMails` を再デプロイ(成功)。デプロイ済みの環境変数を Cloud Functions API で確認し、上の値・許可リスト各1件・送信関数の Secret 参照を確認。
- 画面: `src/config.js` の `SITE_ORDER_MODE` を `ORDER_MODES.SERVER`(本番)に変更。push 後、`scripts/verify-deployed.mjs` で公開サイトの反映を確認。

## commit ID
- 本ファイルを含む最新 commit(`git log -1 -- docs/CLAUDE_REPORT.md`)。

## テスト結果
- unit 232 / ブラウザ回帰 96 成功。Functions・Rules のコードは前回(Functions 138・Rules 59・E2E 10 成功)から変更なし。

## 停止の方法
- 注文の受付を止める: `ORDER_INTAKE_ENABLED=false` で `createOrder` を再デプロイ。
- 送信だけ止める: `MAIL_SENDING_ENABLED=false` で `sendOrderMail`・`retryOrderMails` を再デプロイ(送信待ちは held になり、自動では送らない)。
- 画面を送信不可に戻す: `SITE_ORDER_MODE` を `ORDER_MODES.DRYRUN` にして push。

## 残課題
- 初回の本番注文の後、注文履歴の送信状態(受付・配信)とディーラー・注文控えの着信の確認(利用者)。
- 許可外の利用者が公開サイトで送信した場合はサーバーが拒否する(注文・メールは作られない)。
- 前回の残り: 失敗したメールの画面からの再送、`actorRequired()=true` への切り替え、CLI が自動付与した権限の扱い、App Check、`firebase-functions` の更新。
