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
- **重複候補の検出**: 全施設名と正規化比較（NFKC・空白/記号除去・包含・編集距離1）。返すのは `exact` と `similarCount` だけで、他施設の名前・IDは返さない。同名の別施設もありえるため、利用者の確認（`confirmDuplicate`）で登録可能。
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

## 制限事項・今後
- 重複候補の検出は `facilities` を走査する（現規模向け）。施設数が増えたら名前キーのインデックス化を検討。
- 招待コードはメール送信しない（要件）。管理者が安全な方法で本人へ伝える。招待の取り消し・一覧画面は未実装（期限切れ／使用済みで無効化）。
- 所属のあるユーザーが後から別の施設に参加／登録する導線は未提供（所属なしの画面のみ）。
- 自己登録した施設の承認フロー（運営者による審査）は無い。必要なら `status: pending` で作成し、承認で `active` にする設計に変更できる。
