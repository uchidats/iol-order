# Claude Code 作業報告(最新)

> このファイルは作業完了ごとに上書きする最新1件。記録のルールは `CLAUDE.md`。実データ・認証情報・バックアップの中身は書かない。

- **日時**: 2026-10-27
- **作業**: 運営者専用の「施設を事前登録」を本番にデプロイし、`main` に取り込み(`feature/facility-preregistration` の 50253a5)。詳細は `docs/facility-preregistration.md`。
- 実際の施設の事前登録・参加承諾はしていない(利用者が画面から確認する)。注文処理・メール送信・本番の安全設定・受付の許可リストは変更なし。
- 作業フォルダの `docs/manual/`・`docs/introduction/`(別ツールで作成された正式な成果物。次のオンラインマニュアル・紹介ページで使用)は、git に含めず、変更・移動せずに保持。

## デプロイ(medconf-iol-dev)
- Functions: `preregisterFacility`・`listFacilityPreregistrations`・`updateFacilityPreregistration`・`cancelFacilityPreregistration`(新規)、`respondMembership`・`listMyPendingMemberships`(更新)。いずれも成功。Firestore Rules は変更なし(デプロイなし)。
- 画面: `main` へ取り込み・push。公開サイトの反映を確認。

## デプロイ後の確認(読み取りのみ)
- 6つの関数は稼働中、安全設定(受付・テストモード・送信)の値と許可リスト(施設1件・利用者1件)は従来どおり。`createOrder`・`registerFacility` は今回デプロイしていない。
- 未ログインでの事前登録・一覧の呼び出しは 401 で拒否。
- 既存の施設は2件とも有効のまま、所属(役割)と注文履歴の件数も変更なし。
- 運営者のメニュー「施設を事前登録」、既存の施設登録・注文画面の動作は、エミュレータのテスト(Functions・E2E・ブラウザ)で確認済み。本番の画面での操作確認は利用者が行う。

## commit ID
- 事前登録の本体: 50253a5。取り込み: 本ファイルを含む最新 commit(`git log -1 -- docs/CLAUDE_REPORT.md`)。

## テスト結果
- unit 241 / Rules 61 / Functions 172 / Functions E2E 11 / ブラウザ 121(WebKit の手術日テストの1件は変更前の `main` でも起きる既知の不安定。再実行で成功)。

## 残課題
- 前回の残り: 失敗した注文メールの画面からの再送、`actorRequired()=true` への切り替え、CLI が自動付与した権限の扱い、App Check、`firebase-functions` の更新、申請の通知の自動再送(なし)。
- 次: オンラインマニュアル・紹介ページの実装(`docs/manual/`・`docs/introduction/` を利用)。
