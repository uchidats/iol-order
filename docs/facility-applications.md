# 新しい施設の登録: 運営者の承認制

新しい施設の登録は、即時登録をやめ、**申請 → 運営者の承認・却下** にした。既存の施設・管理者・利用者・注文履歴は変更しない(今後の新規登録だけに適用)。

## 流れ
1. **申請**(ログイン済み・メール確認済みの人。画面「新しい施設の登録」→「申請する」。呼び出し名は従来の `registerFacility`)
   - `facilityApplications/{申請ID}` に、施設名・申請者名(任意。未入力ならログイン情報の表示名)・メールアドレス・申請日時を保存する。
   - **申請の時点では施設を作らず(有効化しない)、管理者の権限も付けない。** 未承認の施設では注文できない(施設が存在しないため)。
   - 申請ID = 承認後の施設ID(uid と要求IDから導出)。同じ要求の再送は同じ申請を返す(二重申請の防止)。
   - 重複の確認: 既存施設・審査中の申請との重複候補があれば、確認(`confirmDuplicate`)なしでは申請しない。1ユーザーの申請数の上限(3件)・回数制限は従来どおり。
2. **運営者への通知**(トリガー `notifyFacilityApplication`。申請の作成時に1回)
   - 施設名・申請者名・メールアドレス・申請日時を、運営者の通知先(Secret `OPERATOR_NOTIFY_RECIPIENT`。カンマ区切り)へ送る。返信先は申請者。
   - 送信の可否・宛先は注文メールと同じ設定に従う: `MAIL_SENDING_ENABLED=false` → 送らない(held)、`MAIL_TEST_ONLY=true` → `MAIL_TEST_RECIPIENT` だけ、通知先が未設定 → not_configured。
   - 二重送信の防止: 送信前にトランザクションで「送信中」にし、配信サービスへ申請ごとの冪等キーを付ける。**失敗しても申請は残り**、結果を申請の `notification` に記録する(運営者の一覧に表示)。自動の再送はしない。
3. **承認・却下**(ヘッダーのメニュー「施設登録の申請」。承認権限のある人だけに表示)
   - 一覧: 審査中(古い順・既存施設との重複候補つき)と、最近の承認・却下。
   - 承認: 施設を作成(有効)し、最初の管理者を決める。
     - 申請者(既定): 申請者の所属(管理者)を作る。
     - 別の責任者を指定: その人のメールアドレス宛てに**管理者の参加待ち**(`initialAdmin: true`)を作る。本人がメール確認済みのアカウントでログインし、参加を承諾したときに管理者になる(30日の期限・メール一致の確認は従来の参加確認と同じ)。承諾までは、申請者を含め誰にも権限はない。
     - 既存施設と同名なら、承認にも確認(`confirmDuplicate`)が必要。
   - 却下: 理由(任意・200文字まで)を残す。施設は作らない。
   - 履歴: 申請の `history`(申請・承認・却下、日時・処理した人)、`decidedAt`・`decidedBy`。承認は作成した施設の操作履歴(`auditLogs` の `facility.approve`)にも残す。

## 安全性
- **承認権限はサーバーで確認する**(`functions/src/roles.js` の `canApproveFacilities`。現在は platformAdmin のカスタムクレームを持つ運営者だけ)。画面のメニューの表示は補助で、一覧・承認・却下の関数がすべて確認する。
- **申請者は自分の申請を承認・却下できない**(同じアカウント・同じメールアドレス)。
- **二重承認・同時操作**: 承認・却下は、申請が審査中であることをトランザクションで確認してから1回だけ行う(後から来た操作は `failed-precondition`)。施設は `create`(既にあれば失敗)。
- 申請(`facilityApplications`)は Firestore Security Rules でクライアントから読み書きできない(運営者を含む。Cloud Functions だけ)。
- 管理者の参加待ちは、承認で指定した最初の管理者(`initialAdmin`)だけが承諾できる。施設の管理者による事前登録では、従来どおり管理者を登録できない。

## 将来の委任(今回は実装しない)
- 施設登録の承認権限は、`canApproveFacilities` だけで決まる(platformAdmin のほかの権限とは分けている)。信頼できる担当者(ディーラーの責任者など)に委任する場合は、この判定に専用の権限(例: カスタムクレーム `facilityApprover`)を加える。
- 承認権限で使えるのは、申請の一覧・承認・却下だけ。施設の注文履歴・取引情報を読む権限は与えない(Firestore Rules の施設のデータは、所属・platformAdmin だけが読める設計のまま)。

## デプロイ(承認後。この順で)
1. Secret の登録: `firebase functions:secrets:set OPERATOR_NOTIFY_RECIPIENT --project medconf-iol-dev`(運営者の通知先。カンマ区切り)。
2. Firestore Rules(`facilityApplications` の明示的な拒否): `firebase deploy --only firestore:rules`。
3. Functions: `registerFacility`(申請に変更)・`listFacilityApplications`・`decideFacilityApplication`・`notifyFacilityApplication`(新規)・`respondMembership`(最初の管理者の承諾)。
4. 画面(push)。**Functions より先に画面を公開しない**(新しい画面は申請者名を送るため、古い `registerFacility` は拒否する)。
- 運営者のアカウントに platformAdmin のカスタムクレームが必要(未設定ならメニューに出ず、承認もできない)。
