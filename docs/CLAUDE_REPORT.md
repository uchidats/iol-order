# Claude Code 作業報告(最新)

> このファイルは作業完了ごとに上書きする最新1件。記録のルールは `CLAUDE.md`。実データ・認証情報・バックアップの中身は書かない。

- **日時**: 2026-10-26
- **作業**: 本番運用(許可リストのまま・運営者1名のみ)への切り替え準備。切り替え自体は最終承認待ち。
- 現在の設定は変更なし: `ORDER_INTAKE_ENABLED=false`・`ORDER_INTAKE_UNRESTRICTED=false`・`MAIL_SENDING_ENABLED=true`・`MAIL_TEST_ONLY=true`。公開サイトは dryrun のまま。デプロイなし。

## 見つかった問題と修正
1. **許可リストの注文は常にテスト注文になっていた**(`testOrder: restricted`)。テスト注文は `MAIL_TEST_ONLY` に関係なくテスト用の宛先にしか送らないため、予定の設定ではディーラーに届かない。→ `ORDER_TEST_MODE`(既定 true)を追加。false で、許可リストのまま本番の注文(`testOrder: false`)として保存。`.env` には `ORDER_TEST_MODE=true` を明記。
2. **公開サイトは常に dryrun**(送信できるのはローカル専用の server-dev だけ。完了画面は「ディーラー未通知」固定)。→ 本番の注文モード `server` を追加し、公開サイトの既定を `src/config.js` の `SITE_ORDER_MODE` に集約(現在 dryrun。切り替え時に server)。完了画面は保存された注文で判断し、本番の注文は「ディーラーへ注文メールを送信します・注文履歴で確認」、テスト注文は従来の「開発用受付・ディーラー未通知」。本番ではヘッダーの「開発モード」表示を出さない。
- `docs/order-mail.md` に本番の受付の手順(設定値・再デプロイ・画面の切り替え・停止方法)を追記。

## 施設設定の確認(読み取りのみ。許可施設)
- 署名: 設定済み(3行)。注文控え: ON・送信先1件。
- **ディーラー: 1件のみ。発注用メールが仮のアドレス(example ドメイン)。実際の宛先への修正が必要**(施設設定の画面から。実データは変更していない)。宛名は登録名と同じ。

## 宛先の確認(テスト)
- 本番の注文(テスト注文でない・`MAIL_TEST_ONLY=false`): テスト用の宛先が設定されていても、ディーラーの発注用メールと注文控えの宛先に送り、件名に【テスト】は付かない(Functions のテストを追加)。
- テスト注文: 従来どおりテスト用の宛先だけ。

## commit ID
- 本ファイルを含む最新 commit(`git log -1 -- docs/CLAUDE_REPORT.md`)。

## テスト結果
- unit 232 / Rules 59 / Functions 138 / Functions E2E 10 / ブラウザ回帰 96 すべて成功(本番の完了画面のテストを追加。開発用の完了画面のテストの偽データに `testOrder: true` を明記)。

## 最終承認後の手順
1. ディーラーの発注用メールを実際の宛先に修正(利用者)。
2. `.env`: `ORDER_INTAKE_ENABLED=true`・`ORDER_TEST_MODE=false`・`MAIL_TEST_ONLY=false`(他は維持)→ `createOrder`・`sendOrderMail`・`retryOrderMails` を再デプロイ。
3. `SITE_ORDER_MODE` を server にして push → `scripts/verify-deployed.mjs` で反映を確認。

## 判断待ち
- 本番の受付の最終承認。公開サイトを server にすると、許可外の利用者が開いた場合も注文画面は送信できる表示になり、送信時にサーバーが拒否する(注文・メールは作られない)。
