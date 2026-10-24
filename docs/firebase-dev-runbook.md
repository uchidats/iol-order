# Firebase 開発環境 運用手順（medconf-iol-dev）

対象は開発プロジェクト `medconf-iol-dev` のみ。Hosting は使わない（公開は GitHub Pages）。本番プロジェクトは未作成。

## 1. 現在の状態
| 項目 | 状態 |
|---|---|
| Webアプリ設定 | apiKey / authDomain / projectId / appId は Firebase CLI（`apps:sdkconfig`）の値と一致 |
| Firestore DB | `(default)` 作成済み（Native） |
| Security Rules / インデックス | デプロイ済み（施設の位置情報の項目を含む最新版）。未認証の読取は 403。`members.uid` の collection group インデックス登録済み |
| Google ログイン / メールリンク認証 | 有効化済み |
| 承認済みドメイン | `localhost`, `medconf-iol-dev.firebaseapp.com`, `medconf-iol-dev.web.app`, `iol.medconf.jp`（`uchidats.github.io` は未登録・認証テストには使わない） |
| データ | **施設・所属・管理者は未登録**（`platformAdmin` クレームも未設定） |

### 重要: どこでログインを試すか
- `iol.medconf.jp` が配信しているのは GitHub Pages の `main`。**Firebase対応コードを push するまで、そこでは旧版（dryrun のみ・ログインなし）が表示される。**
- push 前の接続テストは **ローカル（`http://localhost:<port>/`）** で行う。`localhost` は承認済みドメインに含まれる。
- push すると、`iol.medconf.jp` でもログインと施設への所属が必須になる（管理者登録前は誰も注文画面に入れない）。push は管理者登録の完了後を推奨。

### 任意の Console 設定
- Google Cloud Console > 認証情報 で、Web用APIキーに HTTP リファラ制限（`iol.medconf.jp/*`, `localhost/*`）を設定（apiKey は公開前提だが悪用防止に推奨）。

## 2. デプロイ（Firestoreのみ）
```
npm test                          # 単体テスト
npm run test:rules                # ルールテスト（エミュレータ。Java と firebase CLI が必要）
npm run deploy:dev:firestore      # firebase deploy --only firestore --project medconf-iol-dev
```
`.firebaserc` の既定は `medconf-iol-dev` のみ。Hosting / Functions はデプロイ対象外。

## 3. ログイン接続テスト手順（ローカル）
1. 静的サーバーを起動（ES Modules のため `file://` は不可）: `npx http-server -p 8080` など。
2. `http://localhost:8080/` を開く → 「ログインが必要です」が表示され、注文フォームとOCRは非表示。
3. **Googleログイン**: 「Googleでログイン」→ 成功後、所属が無いので「施設への所属が確認できません」が表示される（期待動作）。注文画面は出ない。
4. **メールリンク**: ログアウト → メールアドレス入力 →「ログインリンクを送信」→ 受信したリンクを**同じブラウザ**で開く → ログイン完了（別端末で開くとメールアドレスの再入力を求められる）。
5. **状態保持**: リロードしてもログイン状態が維持される。
6. **ログアウト**: ヘッダーのメニュー（所属がある場合）またはパネルからログアウトできる。
7. アクセス制御（管理者・施設登録後）: 所属ありは注文画面、所属なしは案内のみ。

## 4. 最初のプラットフォーム管理者・施設の初期登録
`scripts/admin/run.mjs`（Admin SDK）を使う。**既定は dry-run**、対象は `medconf-iol-dev` 固定、`--apply` には対象UID（施設系は施設ID）の再入力が必須。
サービスアカウント秘密鍵は使わない（`GOOGLE_APPLICATION_CREDENTIALS` が設定されていると中止する）。`platformAdmin` の付与は、メール確認済みで無効化されていないアカウントにのみ可能。

### 4-1. gcloud と ADC（Application Default Credentials）の準備
gcloud が未導入の場合（PowerShell）:
```
winget install --id Google.CloudSDK -e
# 導入後、PowerShell/ターミナルを開き直す
gcloud --version
gcloud auth application-default login
gcloud auth application-default set-quota-project medconf-iol-dev
```
- `application-default login` はブラウザで**運営者本人のGoogleアカウント**を認証し、ユーザー資格情報を `%APPDATA%\gcloud\application_default_credentials.json` に保存する。これはサービスアカウント鍵ではない。管理作業が終わったら `gcloud auth application-default revoke` で破棄できる。
- そのアカウントには `medconf-iol-dev` で Firestore と Firebase Authentication を操作できる権限（例: プロジェクトの Owner / Editor、または Firebase Admin）が必要。

### 4-2. UID を安全に確認する（クレーム付与の前）
1. 運営者本人が、**ローカルのアプリ**（3 の手順）でログインし、Authentication にアカウントを作る。
2. UID を **2経路で突き合わせる**:
   - Firebase Console > Authentication > Users: 本人のメール・プロバイダ（Google など）・作成日時から該当行を特定し、UID をコピー。
   - 読み取り専用スクリプト: `node scripts/admin/run.mjs lookup --email <運営者のメール>`
     → `uid / email / providers / emailVerified / createdAt / lastSignInAt / customClaims` が表示される。
3. 次を**すべて**満たすことを目視確認する:
   - 2つの UID が一致する。
   - メールが本人のもの、`emailVerified: true`、プロバイダが想定どおり。
   - 作成日時・最終ログインが、先ほど自分でログインした時刻と合う。
   - `customClaims` が空（まだ何も付与されていない）。
   - 同じ名前・似たメールの別アカウントが Users に無い。
4. 一致しなければ中止する。UID を他人から口頭・チャットで受け取った値のまま使わない。

### 4-3. 運営者権限・施設・施設管理者（実データ登録。準備ができてから）
各コマンドはまず `--apply` なし（dry-run）で内容を確認し、問題なければ `--apply` と確認用の値を付けて実行する。既存ドキュメントは上書きしない（`create` のみ）。
```
# 運営者権限（再ログイン後に反映される）
node scripts/admin/run.mjs grant-platform-admin --uid <UID>
node scripts/admin/run.mjs grant-platform-admin --uid <UID> --apply --confirm-uid <UID>

# 施設の作成
node scripts/admin/run.mjs create-facility --facility-id <英小文字数字-> --facility-name "<名称>"
node scripts/admin/run.mjs create-facility --facility-id <id> --facility-name "<名称>" --apply --confirm-facility-id <id>

# 施設管理者の所属（admin の付与は運営者のみ可能な設計）
node scripts/admin/run.mjs add-facility-admin --facility-id <id> --uid <UID>
node scripts/admin/run.mjs add-facility-admin --facility-id <id> --uid <UID> --apply --confirm-uid <UID>
```
実行後、ローカルで再ログインすると注文画面が表示される（所属が1施設なら選択なし）。

### 4-4. 施設の位置情報（現在地による施設選択用・任意）
座標と判定距離は施設ごとに運営者／施設管理者が登録する（推測値は登録しない）。複数施設に所属するユーザーの自動選択にのみ使われ、未登録の施設は判定対象外。
```
node scripts/admin/run.mjs set-facility-geo --facility-id <id> --lat <緯度> --lng <経度> --radius-m <判定距離m>
node scripts/admin/run.mjs set-facility-geo --facility-id <id> --lat <緯度> --lng <経度> --radius-m <判定距離m> --apply --confirm-facility-id <id>
```
判定距離は後から同じコマンドで調整できる（10〜5000m）。

## 4-5. 施設管理者による初期設定（画面から）
Rules（施設設定の項目を含む最新版）をデプロイ済みであること（`npm run deploy:dev:firestore`）。
1. 施設管理者でログイン → ヘッダーのメニュー →「施設設定」。
2. **注文者**: 名前（必要ならメール）を入力して保存。上下ボタンで並び順、チェックで有効/無効。
3. **採用IOL**: 施設で使うモデルにチェックして保存。
4. **ディーラー**（任意）: 名称と、発注用／使用報告用のメールアドレスを別々に入力して保存。メール送信はまだ行われない。
5. 「注文画面に戻る」で、注文者・モデルの選択肢に反映されていることを確認する（注文は dryrun）。
立川病院の注文者・採用IOLは自動登録していない。実際の運用内容に合わせて管理者が登録する。

## 5. 守ること
- サービスアカウント鍵・Admin SDK 認証情報は作成・保存・commit しない。
- 注文は dryrun のまま。Forms / 本番GAS / 本番Firebaseには触れない。
