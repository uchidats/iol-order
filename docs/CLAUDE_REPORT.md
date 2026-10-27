# Claude Code 作業報告(最新)

> このファイルは作業完了ごとに上書きする最新1件。記録のルールは `CLAUDE.md`。実データ・認証情報・バックアップの中身は書かない。

- **日時**: 2026-10-27
- **作業**: 新しい施設の登録を運営者の承認制に(申請 → 運営者への通知 → 承認・却下)。詳細は `docs/facility-applications.md`。
- **ブランチ**: `feature/facility-approval`(`main` には未反映。Functions・Rules のデプロイは承認待ち。画面を先に公開すると、古い `registerFacility` が申請者名を拒否して登録できなくなるため、デプロイの後に `main` へ反映する)
- 本番運用中(許可リストのまま)。注文処理・メール送信の安全設定は変更なし。実注文・メール送信はしていない。デプロイなし。

## 変更内容
- **申請**(`functions/src/facility-applications.js`。呼び出し名は従来の `registerFacility`): `facilityApplications/{申請ID}` に施設名・申請者名・メールアドレス・申請日時を保存。施設は作らず、管理者の権限も付けない(未承認では注文できない)。既存施設・審査中の申請との重複確認、申請数の上限・回数制限、同じ要求の再送は同じ申請。
- **通知**(トリガー `notifyFacilityApplication`): 運営者(Secret `OPERATOR_NOTIFY_RECIPIENT`)へ施設名・申請者名・メールアドレス。送信の設定(`MAIL_SENDING_ENABLED`・`MAIL_TEST_ONLY`)に従い、冪等キー・送信前の状態切り替えで二重送信を防ぐ。失敗しても申請は残り、結果を記録。
- **承認・却下**(`listFacilityApplications`・`decideFacilityApplication`。画面はヘッダーのメニュー「施設登録の申請」): 承認権限(`roles.js` の `canApproveFacilities`。現在は platformAdmin のみ。将来の委任はこの判定だけを変える)をサーバーで確認。自分の申請は承認・却下できない。審査中の申請だけをトランザクションで1回だけ処理(二重承認・同時操作)。承認で施設を有効化し、最初の管理者は申請者、または指定した別の責任者(管理者の参加待ち `initialAdmin`。本人がメール確認済みでログインし承諾したときに管理者)。履歴は申請の `history`・`decidedBy`、施設の `auditLogs`(facility.approve)。
- `members.js`: 管理者の参加待ちは `initialAdmin` のときだけ承諾できる(施設の管理者による管理者の事前登録は従来どおり不可)。
- **Rules**: `facilityApplications` はクライアントから読み書き不可(運営者を含む)。
- **画面**: 登録画面に「申請者のお名前」(初期値はログイン情報の表示名)、ボタンは「申請する」、ⓘに承認制の説明。申請後は「申請しました」と案内。承認者だけにメニュー「施設登録の申請」(一覧・承認・却下。確認はアプリのダイアログ)。

## commit ID
- 本ファイルを含む最新 commit(`feature/facility-approval`。`git log -1 -- docs/CLAUDE_REPORT.md`)。

## テスト結果
- unit 241 / Rules 61 / Functions 158(申請・通知・承認・却下・権限・自分の申請・二重承認・同時操作・指定した管理者の承諾・Rules を追加)/ Functions E2E 10(申請 → 運営者の承認を通しで)/ ブラウザ 108 成功・4 件失敗。失敗は、既に `main` に反映済みの変更に対するテストの期待値の古さ(発注先のテストが同じ注文の中の重複を入力エラーと期待・サイト共有のテストがコピーの結果を待たない)で、この作業とは無関係。`main` 側で修正する。

## デプロイの手順(承認後)
1. Secret: `OPERATOR_NOTIFY_RECIPIENT`(運営者の通知先)を登録。
2. Firestore Rules → Functions(`registerFacility`・`listFacilityApplications`・`decideFacilityApplication`・`notifyFacilityApplication`・`respondMembership`)。
3. `feature/facility-approval` を `main` に取り込み、push(画面)。
- 運営者のアカウントに platformAdmin のカスタムクレームが必要。

## 判断待ち
- 上記のデプロイの承認、通知先のメールアドレス(Secret に登録)。
