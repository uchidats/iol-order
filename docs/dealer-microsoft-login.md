# ディーラー専用画面の Microsoft ログイン(設定手順と安全上の扱い)

**状態: 実装・自動テストまで(ブランチ `feature/dealer-microsoft-login`)。本番の Microsoft Entra のアプリ登録・Firebase の設定・機能の有効化は未実施で、ユーザーの承認後に行う。** 本書にはシークレット(クライアント シークレットの値など)を書かない。

## 何ができるか
- ディーラー専用画面(`dealer.html`)のログイン画面に「Googleでログイン」「Microsoftでログイン」を並べ、その下にメールのリンク(パスワード不要)を置く。医療機関の画面のログインは変更しない。
- Microsoft は Firebase Authentication 標準の `OAuthProvider("microsoft.com")`。企業(Microsoft Entra ID / Microsoft 365)と個人の Microsoft アカウントの両方を想定する(テナント `common`)。毎回アカウントの選択画面を出す(`prompt=select_account`)。
- スマートフォンでもポップアップを使う。リダイレクト方式は、認証の画面が別のドメイン(`medconf-iol-dev.firebaseapp.com`)になり、ブラウザの保存の分断(Safari・Chrome の第三者ストレージの制限)で失敗しやすいため使わない。ポップアップがブロックされた場合は、許可するかメールのリンクを使うよう案内する。

## 安全上の扱い(サーバーで確認する)
- **参加(招待の承諾)は Microsoft ではできない。** 初回はメールのリンク(Gmail は Google も可)で、招待されたメールを今受け取れることを確かめてから参加する(Google ログインと共通の `mailboxProven`)。Microsoft でログインしている間は、招待の一覧に会社名を出さず、メールのリンクを案内する。
- **Microsoft でのログインは、本人が登録した Microsoft アカウントだけ使える。** Microsoft アカウントのメールは、組織の管理者が変更できる場合があり、確認済みとは限らない(メールの一致を本人確認に使う「nOAuth」の問題)。Firebase が同じメールの既存アカウント(UID)に結び付けた場合でも、メールや UID の一致だけでは閲覧させない。
  - 登録: メールのリンクでログインした直後(30分以内)に、受注一覧の「Microsoftアカウントを連携」で、本人がこのアカウントに Microsoft を連携(`linkWithPopup`)し、サーバーが連携された Microsoft の ID を `dealerStaffIndex/{uid}.trustedMicrosoftIds` に記録する(1つの UID に1つ)。Microsoft のセッション・古いメールのリンク・連携していない状態では登録できない。
  - 以後、Microsoft でのログイン(`sign_in_provider` が `microsoft.com`)は、トークンの Microsoft の ID が登録と一致するときだけ、会社・一覧・詳細・会社の候補を返す。登録していない ID・複数の ID は拒否。
- 既存の UID との自動的な統合、メールの一致だけによる権限の移行はしない。別の UID になった場合の移行は、Google ログインと同じ正式な手順(旧 UID の無効化 → 再招待 → メールのリンクで承諾)。
- メール未確認(`email_verified` が true でない)のアカウント、未招待、他社の所属、無効化された担当者、機能の停止中は、Microsoft でも拒否する(Google・メールのリンクと同じ確認)。認証そのものは停止スイッチでは止まらない(ログイン後に「現在ご利用いただけません」)。

## 本番で必要な設定(承認後に運営者が行う。今回は行っていない)
### 1. Microsoft Entra 管理センターでアプリを登録
1. Microsoft Entra 管理センター → アプリの登録 → 新規登録。
2. 名前: 例「IOL Order ディーラー画面」。
3. サポートされているアカウントの種類: **「任意の組織ディレクトリ内のアカウントと個人の Microsoft アカウント」**(企業と個人の両方)。企業だけにする場合は「任意の組織ディレクトリ内のアカウント」とし、Firebase 側のテナントの指定も合わせる。
4. リダイレクト URI(Web): **`https://medconf-iol-dev.firebaseapp.com/__/auth/handler`**(Firebase の認証ドメイン。Firebase Console の Microsoft の設定画面に表示される値と一致させる)。
5. 登録後、「アプリケーション (クライアント) ID」を控える。
6. 証明書とシークレット → 新しいクライアント シークレット。**値は Firebase Console にだけ入力し、リポジトリ・文書・チャットに残さない。** 有効期限を決め、期限前に更新する運用にする。
7. API のアクセス許可: 既定の Microsoft Graph `User.Read`(委任)で足りる。`openid`・`email`・`profile` を含める。管理者の同意が必要な組織では、各社の管理者の同意が要る場合がある。

### 2. Firebase Console(プロジェクト medconf-iol-dev)
1. Authentication → Sign-in method → **Microsoft を有効化**し、アプリケーション (クライアント) ID とクライアント シークレットを入力する。
2. 承認済みドメインに `iol.medconf.jp` があることを確認する(医療機関の画面と共通)。
3. ユーザー アカウントのリンクの設定を確認する(既定値と決め付けない)。この設定の変更は医療機関の画面にも及ぶ。
4. Microsoft を有効にすると、医療機関の画面の Firebase プロジェクトでも Microsoft の認証方式が有効になる(医療機関の画面にはボタンを出していない)。

### 3. 有効化の前の確認(承認された実アカウントで)
- Entra の企業アカウント・個人の Microsoft アカウントで: ポップアップの動作(PC・スマートフォン・Safari)、`email_verified` の値、既存の UID との関係(競合 `auth/account-exists-with-different-credential` になるか、同じ UID か、別の UID か)。
- メールのリンクで参加 → 「Microsoftアカウントを連携」→ 次回 Microsoft でログインして閲覧できること。登録していない Microsoft アカウントで閲覧できないこと。
- 実トークン・シークレットはログ・報告に残さない。

## 既知の制限
- 本番の Firebase が Microsoft のメールを未確認(`email_verified: false`)として発行する場合、Microsoft でのログインは「メールアドレスの確認が済んだアカウントのみ利用できます」となり使えない(安全側)。その場合はメールのリンクを使う。実アカウントでの確認が必要。
- Microsoft の連携が別の UID に付いている(`auth/credential-already-in-use`)場合は、案内して登録しない。運営者が状況を確認する。
- 登録の解除の画面はない(同じ UID で別の Microsoft を登録し直すと置き換わる。担当者の無効化で閲覧は止まる)。
