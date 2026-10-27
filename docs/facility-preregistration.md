# 施設の事前登録(運営者のみ)

運営者が承認済みの施設をあらかじめ登録し、**初期管理者が参加を承諾するだけで利用を始められる**ようにする。
一般の利用者による施設登録の申請(`docs/facility-applications.md`)とは別の経路で、申請・承認・却下・削除の機能はそのまま。

## 運営者の操作(ヘッダーのメニュー「施設を事前登録」。platformAdmin のみ表示)
- 登録: 施設名(必須)・初期管理者のメールアドレス(必須)・初期管理者のお名前(任意)。
- 重複の確認: 登録済みの施設・事前登録の施設・審査中の申請と、既存の表記ゆれ判定(`nameKey` / `compareNames`)で照合する。重複候補があれば確認ダイアログで確かめてから登録する。
- 一覧: 承諾前の事前登録(承諾待ち・期限切れ・辞退)。**編集**(施設名・初期管理者の入力ミスの修正。保存すると参加の期限は今日から30日、メールアドレスを変えると以前のメールアドレスでは参加できない)と**取り消し**ができる。
- 事前登録・一覧・編集・取り消しは、サーバー(`preregisterFacility`・`listFacilityPreregistrations`・`updateFacilityPreregistration`・`cancelFacilityPreregistration`)でも platformAdmin に限定する。操作は運営者の操作履歴(`platformAuditLogs`。メールは伏せ字)に記録する。
- 初期管理者への連絡(メール送信)はしない。運営者が本人に、ログインのメールアドレスと利用開始の方法を伝える。

## データ
- 施設: `facilities/{施設ID}` を `status: "preregistered"`(未有効)で作る。`initialAdminEmail`・`preregisteredBy` を持つ。施設IDは運営者と要求IDから導出(同じ要求の再送は同じ事前登録)。
- 初期管理者: `pendingMembers/{施設ID}_{メールのハッシュ}`(role admin・`initialAdmin`・`preregistration`・30日の期限)。
- 未有効の施設には所属がないため、Firestore Rules で運営者以外は読めず、注文もできない(注文の受付には施設の有効化と、受付の許可リストの両方が必要。許可リストは別に管理する)。

## 初期管理者の参加
1. 指定のメールアドレス(メール確認済み)で Google ログインまたはメールリンク認証すると、既存の参加確認の画面に施設名と「参加すると、この施設の管理者になります」を表示する。
2. 「参加する」で、`respondMembership` が**同じトランザクションで施設を有効化(status active)し、その人を最初の管理者にする**。運営者の再承認は不要。施設名は変更しない(変更は参加後に施設設定から)。
3. 「参加しない」は辞退として記録し、施設は未有効のまま(運営者が編集すると再び参加できる)。

## 安全性
- 参加前に管理者の権限を付けない。メール確認済み・メールアドレスの一致・期限を、参加の時点でサーバーが確認する(第三者は参加できない)。
- 二重の承諾・同時の承諾でも、有効化と管理者の作成は1回だけ(参加待ちの状態をトランザクションで確認)。
- 管理者の参加待ちは、事前登録・申請の承認で指定した最初の管理者だけ。施設の管理者による管理者の事前登録は従来どおり不可。
- 一般の利用者が事前登録と同名の施設を申請しようとしても、重複候補になる。
- 既存の施設・所属・注文履歴には触れない。

## デプロイ(承認後)
1. Functions: `preregisterFacility`・`listFacilityPreregistrations`・`updateFacilityPreregistration`・`cancelFacilityPreregistration`(新規)・`respondMembership`・`listMyPendingMemberships`(参加確認)・`registerFacility`(申請の重複照合の共通化)。
2. Firestore Rules は変更なし(未有効の施設も既存のルールで保護される)。
3. 画面(`main` への取り込み・push)。
