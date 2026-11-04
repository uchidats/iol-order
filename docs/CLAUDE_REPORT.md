# Claude Code 作業報告(最新)

> このファイルは作業完了ごとに上書きする最新1件。記録のルールは `CLAUDE.md`。実データ・認証情報・バックアップの中身は書かない。

- **日時**: 2026-11-04
- **作業**: R09 の設計書を改訂(改訂8)。`docs/iol-sticker-photo-design.md`・`docs/ROADMAP.md`・本ファイルのみ。アプリのコードの変更なし。
- 重複防止: 撮影ごとに固定のアップロードID。`photoId` は施設とIDだけから決め、再認証の後の再送でも二重に保存しない。
- 上限の管理: `stickerSessions`・`stickerUsage` を写真の登録と同じトランザクションで確認。既存の `rateLimits` は変更しない(回数制限は専用の `stickerRateLimits`)。
- 関数の分離: ログインなしは `stickerEntryApi`(確認)と `stickerPhotoUpload`(チケットでの保存)だけ。一覧・閲覧・削除・設定は Firebase Auth 必須の `stickerPhotoApi`・`stickerPhotoImage`。
- メタデータの読み取りは Functions 経由に統一し、`stickerPhotos` は Rules で全拒否。
- そのほか: 関数ごとの CORS、`X-Blur-Warned`(参考情報)、QR の API 名(`getEntryQr`・`rotateEntryQr`)、ウォームアップの取りやめ、上限の文言の統一、§8-4(基盤)と §8-5(テスト)の順序。
- 基盤: 専用の GCS バケットと IAM(Firebase Storage の連携なし・Storage Rules なし)、Secret `STICKER_TICKET_SECRET`、追加の依存は `sharp`・`qrcode` だけ、`firebase.json` は変更せず偽のバケットでテスト。
- 改訂の過程で、コードの再入力と両立させるためバケットのパスから年月を除き、入口トークンの参照を施設の文書から `stickerSettings/entry` へ移し、設定の読み取りの `getSettings` を追加した。

## commit ID
- 本体: 本ファイルを含む commit(`git log -1`)。

## テスト結果
- 文書のみのためテストは未実行。設計書の古い用語・節の参照・関数名の一致は検索で確認。

## push・Firebaseデプロイ
- `main` へ通常の push。Firebase のデプロイなし。バケットの作成・Secret の登録なし。

## 残課題
- R09: 台紙の試し刷りと行数の確定、シールを貼った台紙の容量と判読、送信時間、iPhone の検証。
- 実際のバケットでの保存・閲覧・削除の確認(配備の後)。
- 実際の次の注文メールでの、差出人名の表示の確認。

## 判断待ち事項
- R09: 実装の着手、バケットと権限の付与・Secret の登録の承認、最初に有効にする施設、アクセスコードの運用。
- 立川病院の発注用メール5件が、すべて現在の正しい宛先かの確認。
- Google フォームの受付をいつ終えるか。
- NP-T の下限の取り込み、E2E の環境の問題、使わなくなった複合インデックスの削除(前回から継続)。
