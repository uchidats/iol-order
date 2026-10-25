# 新規施設のセルフ登録と招待参加

初めて利用する医療機関が、開発者の介入なしで施設登録・初期設定を行うための機能。
**施設の作成と所属の作成は、Cloud Functions（信頼できるサーバー側）だけが行う。Firestore Security Rules はクライアントに施設作成も自己参加も許可していない。**

## 採用した方式: Cloud Functions（第2世代 callable）
| 関数 | 呼び出せる人 | 内容 |
|---|---|---|
| `registerFacility` | ログイン済み **かつ `email_verified=true`** | 施設を作成し、呼び出したユーザーを最初の管理者にする |
| `createInvite` | その施設の有効な管理者（または運営者クレーム） | 特定のメールアドレス宛ての参加招待（orderer 権限）を発行 |
| `acceptInvite` | 招待されたメールアドレスの確認済みアカウント | 招待コードで施設に参加（orderer 権限） |

ルールだけで実現する案（`getAfter()` で同時作成を検証）を採らなかった理由: 他施設の名前を漏らさずに重複候補を検出できない／利用回数の制限ができない／メールアドレスに紐付けた招待を安全に扱えない。いずれもサーバー側処理が必要で、ルールを緩めて代用すべきではないため。

実装: [functions/src/registration.js](../functions/src/registration.js)（ロジック）、[functions/index.js](../functions/index.js)（callable の薄い入口）。クライアント: `src/data/registration-api.js`、`src/domain/registration-flow.js`、`src/ui/auth-ui.js`、`src/ui/facility-settings.js`（招待セクション）。

## 画面の流れ
1. ログイン済みで所属施設がないユーザーに「新しい施設を登録」「既存施設に参加する」を表示（注文画面・施設情報は出ない）。
2. **新規登録**: 施設名を入力 →（同名・類似施設があれば警告。別施設として確認すれば続行）→ 作成 → 自動で「施設設定」画面へ。
3. **参加**: 管理者から受け取った招待コードを入力。招待がなければ参加できない。
4. 所属が複数になった場合の施設選択・GPS・切替は従来どおり。

## セキュリティ設計
- **認証**: 未ログインは `unauthenticated`、メール未確認・メールなしは `permission-denied`。`platformAdmin` はトークンクレームでありサーバー（Admin SDK）でしか設定できない。関数はクレームを設定せず、入力に `role` / `platformAdmin` / `facilityId` / `uid` などの未知のキーがあれば `invalid-argument` で拒否する。
- **施設ID**: サーバーが `(uid, requestId)` から導出（`fac-` + sha256 の先頭24桁）。クライアントは指定できない。同じ要求の再試行は同じIDになる（冪等）。他人の施設を上書き・奪取できない（作成は `create` のみ）。
- **整合性**: 施設・最初の管理者所属・利用枠の更新を **1つの Firestore トランザクション**で実行。途中で失敗すれば何も残らず、同じ要求で再試行できる。
- **同時実行・重複**: 同じ要求の並列送信は1施設のみ。別要求の同名二重送信（別タブ等）も、ユーザー単位の利用枠ドキュメントを介して直列化し、確認なしでは1施設しか作られない。
- **重複候補の検出**: 全施設名と正規化比較（NFKC＝全角半角の統一・空白/記号/ハイフン類の除去・法人名（医療法人社団・株式会社・（医）など）の有無・ヶ/ケの統一・包含・編集距離1）。返すのは `exact` と `similarCount` だけで、他施設の名前・IDは返さない。同名の別施設もありえるため、利用者の確認（`confirmDuplicate`）で登録可能（施設名だけで登録は禁止しない）。登録の確定時にもサーバーで必ず確認する。
- **入力中の重複案内**: 登録画面で施設名を入力すると（入力が止まって0.7秒後）、読み取り専用の `checkFacilityName` で確認し、候補があれば「既に登録されている可能性があります。既存の施設に参加する場合は、その施設の管理者から招待コードを受け取り…」と案内する（登録は止めない）。返すのは `exact`・`similarCount`・候補の**施設名のみ（最大5件、有効な施設だけ）**（施設ID・メール・職員・注文・招待は返さない）。候補を選ぶと、その施設の管理者から招待コードを受け取って「既存施設に参加する」から参加するよう案内する（施設名の入力は書き換えない）。`registerFacility` の重複応答は従来どおり件数のみ。
- **施設名の変更**: 施設設定の施設名の横の鉛筆から、**施設管理者のみ**変更できる（Callable `renameFacility`。管理者確認・入力検証・回数制限・既存施設との重複確認つき。候補があれば確認(`confirmDuplicate`)なしでは変更しない。自分の施設自身は重複扱いしない）。更新するのは `name` と `updatedAt` だけで、施設ID・所属・注文は変わらない。外部API（Google等）は使わない。
- **入力中の候補（部分一致）**: 入力中の候補表示に限り、2文字以上の入力が施設名の一部に含まれれば候補にする（例:「立川」→「立川病院」。先頭一致を先に表示）。以前は共通部分が3文字未満だと候補にならなかったため。登録・変更時の重複判定は従来の基準のまま。
- **施設の削除**: 施設設定の最下部「施設の削除」から、**施設管理者のみ**、施設名を入力して実行（Callable `deleteFacility`。Rulesは `delete: false` のまま＝クライアントから直接は削除できない）。サーバーが1トランザクションで、管理者・施設名の一致・**注文履歴なし**・**自分以外の所属なし**を再確認してから削除する（条件を満たさなければ何も消えない）。削除するのは、その施設の配下（所属・担当医・採用IOL・ディーラー・表示設定・操作履歴・注文カウンタ）、その施設宛ての招待（`invites` の `facilityId` 一致）、作成者のセルフ登録の利用枠1件分（`registrationQuota` の count と名前キー）。他施設・他ユーザーには触れない。1回の削除は450件まで（超える場合は拒否）。レート制限10回/時間。ログイン・メール確認済みのみ、1ユーザーあたり回数制限あり（施設名の総当たり防止）。関数が未配備・通信エラーの場合は案内を出さないだけで、登録操作は妨げない。
- **上限**: 1ユーザーのセルフ登録は3施設まで（`LIMITS.maxFacilitiesPerUser`）。施設あたり未使用の招待は20件まで。
- **招待**: 256bit のランダムトークン。**保存するのはハッシュ（ドキュメントID）のみ**で、コードは発行時に1度だけ表示。有効期限7日。招待先のメールアドレス（確認済み）と一致する本人のみ使用可。無効・期限切れ・使用済み・別メールは**同じ応答**にして探索を防ぐ。使用は1回限り（トランザクション）。付与されるのは常に orderer（admin の付与は従来どおり運営者のみ）。既存の admin は降格されない。
- **Rules**: `invites` と `registrationQuota` は全クライアントから読み書き不可。`facilities` の作成は運営者のみのまま。既存の施設間分離・自己昇格防止は変更していない。
- **未承認ユーザー**: 他施設の内部情報（名前一覧・メンバー等）はどのAPIからも見えない。

## データ
- `facilities/{id}`: `createdBy`, `selfRegistered`, `createdAt` が付く（セルフ登録の場合）。`createdBy` は管理者でも変更不可（Rules）。
- `invites/{sha256(token)}`: `facilityId`, `email`（小文字）, `role: "orderer"`, `status: pending|used`, `createdBy`, `expiresAt`, `usedBy`, `usedAt`。サーバー専用。
- `registrationQuota/{uid}`: `count`, `keys[]`（登録済み施設名の正規化キー）。サーバー専用。

## テスト
| コマンド | 内容 |
|---|---|
| `npm test` | 単体テスト（クライアント側ロジック含む） |
| `npm run test:rules` | Security Rules（エミュレータ） |
| `npm run test:functions` | サーバーロジック（正常系、メール未確認、不正入力、途中失敗と再試行、冪等、同時登録、重複候補、上限、招待、施設間分離）。エミュレータ上の実Firestore＋Rules |
| `npm run test:functions:e2e` | 実際の callable を Functions + Auth + Firestore エミュレータで通し（IDトークンの `email_verified` 判定、エラーコード変換） |

## デプロイと実環境での検証（未実施）
Cloud Functions のデプロイには次が必要。**この変更では Firebase へのデプロイは行っていない。**
1. プロジェクト `medconf-iol-dev` を **Blaze（従量課金）プラン**にする（Cloud Functions の前提）。
2. API の有効化（初回デプロイ時に CLI が案内）: Cloud Functions, Cloud Build, Artifact Registry, Eventarc（callable では不要な場合あり）。
3. `npm run deploy:dev:firestore`（Rules/インデックス。今回 `invites` / `registrationQuota` の明示的な拒否を追加）→ `npm run deploy:dev:functions`。
4. 検証: テスト用アカウント（メール確認済み）で `http://localhost:<port>/` にログイン →「新しい施設を登録」→ 施設設定へ進む。Console で `facilities/fac-…` と `members/<uid>(role=admin)` を確認。別アカウントで同名登録して警告を確認。管理者が招待コードを発行し、別アカウント（招待先メールでログイン）で参加できること、別メールでは拒否されることを確認。
5. 運用: 費用・乱用の監視（Functions のログ、`registrationQuota`）。App Check 導入後に `enforceAppCheck` を有効化する。

## デプロイ前チェック（medconf-iol-dev）
- **リージョン**: `asia-northeast1`（`functions/index.js`）。Firestore のロケーションと合わせること（Console で確認）。
- **ランタイム**: Node.js **22**（Node 20 は 2026-10-30 に Cloud Functions で廃止され、作成・更新できなくなる）。
- **実行サービスアカウント**: 専用SA `iol-functions-dev@medconf-iol-dev.iam.gserviceaccount.com` で実行する（`functions/index.js` の `RUNTIME_SERVICE_ACCOUNT`、既定SAへはフォールバックしない）。**2026-10-24 時点で未作成**（`gcloud iam service-accounts list` で確認済み。存在するのは firebase-adminsdk のみ）。作成するまでデプロイはエラーになる。
  - 実行権限（SAに付与）: `roles/datastore.user`（Firestore の読み書き・トランザクション・count。Admin SDK は Security Rules を経由しない）、`roles/logging.logWriter`（ログ出力）。これ以外は付与しない。Auth の ID トークン検証は関数基盤が行うため、Identity Toolkit 系の権限は不要。
  - デプロイ権限（デプロイ実行者に付与。実行SAとは別）: `roles/cloudfunctions.developer`、`roles/run.admin`（呼び出し設定の更新）、`roles/artifactregistry.writer`、`roles/cloudbuild.builds.editor`、そして **実行SA 1つに限定した** `roles/iam.serviceAccountUser`（プロジェクト全体には付けない）。Firestore のルール／インデックスは `roles/firebaserules.admin`、`roles/datastore.indexAdmin`。実際に不足した権限はデプロイのエラーで確認し、Editor/Owner では代用しない。ビルドに使われるSA（Cloud Build 用）は実行SAとは別で、組織ポリシーにより必要な権限が異なる。
  - 作成手順（実施時）: `gcloud iam service-accounts create iol-functions-dev --project medconf-iol-dev` → `gcloud projects add-iam-policy-binding medconf-iol-dev --member=serviceAccount:iol-functions-dev@medconf-iol-dev.iam.gserviceaccount.com --role=roles/datastore.user`（`roles/logging.logWriter` も同様）→ デプロイ実行者に対象SAへの `roles/iam.serviceAccountUser` を付与。別名にする場合は `functions/.env.medconf-iol-dev` に `RUNTIME_SERVICE_ACCOUNT=...` を設定。
- **必要API**: cloudfunctions, cloudbuild, artifactregistry, run, eventarc（任意）, firestore, identitytoolkit。デプロイ実行者に Firebase Admin 相当と `iam.serviceAccounts.actAs`。
- **インデックス**: `invites`（facilityId, status, expiresAt）の複合インデックスが必要。`npm run deploy:dev:firestore` を **functions より先に**実行（未作成だと招待発行が `failed-precondition` で内部エラーになる）。
- **レート制限**: `rateLimits/{uid}_{action}`（1時間あたり 登録10 / 招待発行30 / 招待受諾20）。期限切れの未使用招待は上限（20件）に数えない。
- **費用発生要因**: 呼び出し数・CPU/メモリ時間（`maxInstances: 5`）、Cloud Build と Artifact Registry の保管、Firestore の読み書き（重複検出は `facilities` を全件走査するため、登録1回あたり施設数ぶんの読取）、ログ保管。無料枠内に収まる想定だが、**Cloud Billing に予算アラートを設定**すること。
- **既存施設の所属ユーザー**: ヘッダーメニューの「新しい施設を登録」「別の施設に参加」から利用できる（サーバー側の上限は3施設）。現在の施設・入力中の注文はそのまま維持され、追加した施設へはメニューの「施設を切り替える」で移動する。
- **同じメールで複数施設**: 所属は UID 単位で施設ごとに独立。招待はメール（確認済み）と一致すれば使用可。

## 制限事項・今後
- 重複候補の検出は `facilities` を走査する（現規模向け）。施設数が増えたら名前キーのインデックス化を検討。
- 招待コードはメール送信しない（要件）。管理者が安全な方法で本人へ伝える。招待の取り消し・一覧画面は未実装（期限切れ／使用済みで無効化）。
- 所属のあるユーザーが後から別の施設に参加／登録する導線は未提供（所属なしの画面のみ）。
- 自己登録した施設の承認フロー（運営者による審査）は無い。必要なら `status: pending` で作成し、承認で `active` にする設計に変更できる。

## 利用者管理・所属の反映手順
[member-status-removal.md](member-status-removal.md)（所属の status 廃止・所属削除）を参照。
