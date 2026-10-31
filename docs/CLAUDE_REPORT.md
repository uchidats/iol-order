# Claude Code 作業報告(最新)

> このファイルは作業完了ごとに上書きする最新1件。記録のルールは `CLAUDE.md`。実データ・認証情報・バックアップの中身は書かない。

- **日時**: 2026-11-01
- **作業**: ディーラー専用画面(ROADMAP R06)の運営者の試験モード(本体 3180c4b)の独立レビュー(Fable 5.1)への対応と本番配備。ブランチ `feature/dealer-portal-test-mode`。
- ユーザーの指示で、この commit の後に main へ統合・push し、4つの Functions(`dealerPortalApi`・`deliverDealerAuthCode`・`dealerPortalOperator`・`facilityDealerPortal`)と画面を本番へ配備する(配備の結果は完了回答に記録)。`DEALER_PORTAL_ENABLED=false`、`DEALER_PORTAL_TEST_UIDS`・`DEALER_PORTAL_TEST_UNTIL` は空のまま(試験モード・一般利用とも使えない)。
- Rules・注文処理・本番データ・IAM は変更しない。確認コードのメール・注文メールは送らない。

## IAM の調査(読み取りのみ。変更なし)
- 本番の Functions(`dealerPortalApi`・`deliverDealerAuthCode`)は `.env` の `RUNTIME_SERVICE_ACCOUNT` の実行サービスアカウントで動いている。
- その役割は `roles/datastore.user`・`roles/eventarc.eventReceiver`・`roles/logging.logWriter` だけで、Firebase Auth のユーザー情報の読み取り(`firebaseauth.users.get`)を含まない。
- このため「いまも有効な運営者」の確認が失敗し、試験モードは常に閉じる(安全側)。本番で試験モードを使う前に、ユーザーの承認を得て読み取りだけの `roles/firebaseauth.viewer` を付与する必要がある(手順を `docs/dealer-portal.md` に記載)。

## 変更内容(文書のみ)
- `docs/dealer-portal.md`: 試験モードの配備の対象を4つの Functions に訂正(Low-1)。実行サービスアカウントの権限の調査結果と、試験の前の付与の手順を追記(Medium-1)。一般公開の前に、試験用の会社の招待の取消・担当者の無効化・会社の停止を行い、有効化の直前に運営者の一覧で確かめる手順を追記(Low-2。デプロイ手順の4にも反映)。
- `docs/ROADMAP.md`(R06)、本報告。

## commit ID
- 本体: 3180c4b(試験モードの実装)。今回の文書の修正は本ファイルを含む commit(`git log -1`)。

## テスト結果
- 今回は文書だけの変更のため、コードのテストは実行していない(3180c4b の時点で Functions のディーラー 44・E2E 15・unit 21・ブラウザ 27 が成功)。統合後にバージョン付与の確認(`tests/asset-stamp.test.js`)を行う。

## 判断待ち事項
- 本番で試験モードを使うか(使う場合は `roles/firebaseauth.viewer` の付与、UID・期限の設定、`dealerPortalApi`・`deliverDealerAuthCode` の再デプロイ)。

## 残課題
- 試験用の会社のデータの後片付け(削除の API はない)。ディーラー向けマニュアル(他AIの未追跡原稿)の扱い。E2E のトリガーの待ち時間。
