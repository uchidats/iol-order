# Firebase 開発環境 運用手順（medconf-iol-dev）

対象は開発プロジェクト `medconf-iol-dev` のみ。Hosting は使わない（公開は GitHub Pages）。本番プロジェクトは未作成。

## 1. 現在の状態（確認済み）
| 項目 | 状態 |
|---|---|
| Webアプリ設定 | apiKey / authDomain / projectId / appId は Firebase CLI（`apps:sdkconfig`）の値と一致 |
| Firestore DB | `(default)` 作成済み（Native） |
| Security Rules / インデックス | デプロイ済み。未認証の読取は 403。`members.uid` の collection group インデックス登録済み |
| Google ログイン | 有効（サーバー側で確認） |
| メールリンク認証 | **Consoleで要確認**（外部から副作用なしに確認する方法がないため） |
| 承認済みドメイン | `localhost`, `medconf-iol-dev.firebaseapp.com`, `medconf-iol-dev.web.app`, `iol.medconf.jp`。**`uchidats.github.io` が未登録** |

### Console でやること
1. Authentication > Settings > 承認済みドメイン に `uchidats.github.io` を追加（現在の公開先でログインするために必須）。
2. Authentication > Sign-in method で「メール/パスワード」プロバイダ内の「メールリンク（パスワードなしでログイン）」を有効化。
3. Google Cloud Console > 認証情報 で、Web用APIキーに HTTP リファラ制限（`uchidats.github.io/*`, `iol.medconf.jp/*`, `localhost/*`）を設定（apiKey は公開前提だが、悪用防止のため制限を推奨）。

## 2. デプロイ（Firestoreのみ）
```
npm run test:rules                # ルールテスト（エミュレータ）
npm run deploy:dev:firestore      # firebase deploy --only firestore --project medconf-iol-dev
```
`.firebaserc` の既定は `medconf-iol-dev` のみ。Hosting / Functions はデプロイ対象外。

## 3. ログイン接続テスト手順
前提: 上記 Console 設定の完了。ローカルは静的サーバー（例 `npx http-server`）で `http://localhost:<port>/`。

1. **Googleログイン**: ページを開く → 「ログインが必要です」→「Googleでログイン」→ ログイン成功後、所属が無い場合は「施設への所属が確認できません」が表示され、注文画面とOCRは表示されない（期待動作）。
2. **メールリンク**: メールアドレス入力 → 「ログインリンクを送信」→ 受信メールのリンクを**同じブラウザ**で開く → ログイン完了。別端末で開いた場合は確認のためメールアドレスの再入力を求められる。
3. **状態保持**: リロードしてもログイン状態が維持される。
4. **ログアウト**: ログアウトでページが再読み込みされ、ログイン画面に戻る。
5. **アクセス制御**（管理者登録後）: 所属ありユーザーでは注文画面が表示され、所属なしユーザーでは表示されない。

## 4. 最初のプラットフォーム管理者・施設の初期登録
`scripts/admin/run.mjs`（Admin SDK）を使う。**既定は dry-run**、対象は `medconf-iol-dev` 固定、`--apply` には対象UID（施設作成は施設ID）の再入力が必須。
サービスアカウント秘密鍵は使わない（`GOOGLE_APPLICATION_CREDENTIALS` が設定されていると中止する）。

### 4-1. 認証情報（ADC）
```
winget install Google.CloudSDK            # 未導入の場合
gcloud auth application-default login     # 運営者本人のGoogleアカウントでブラウザ認証
gcloud auth application-default set-quota-project medconf-iol-dev
```
### 4-2. 手順
1. 運営者本人が、一度アプリにログインして Authentication にユーザーを作成しておく（Googleまたはメールリンク）。
2. UID を確認（読取のみ）:
   `node scripts/admin/run.mjs lookup --email <運営者のメール>`
3. **表示された UID・メール・プロバイダが本人であることを目視確認する。**
4. 運営者権限（dry-run → 適用）:
   ```
   node scripts/admin/run.mjs grant-platform-admin --uid <UID>
   node scripts/admin/run.mjs grant-platform-admin --uid <UID> --apply --confirm-uid <UID>
   ```
   クレームは再ログイン後に反映される。
5. 施設の作成（実データ登録。ルール検証済みの現在は実行可能だが、必要になるまで実行しない）:
   ```
   node scripts/admin/run.mjs create-facility --facility-id <英小文字数字-> --facility-name "<名称>"
   node scripts/admin/run.mjs create-facility --facility-id <id> --facility-name "<名称>" --apply --confirm-facility-id <id>
   ```
6. 施設管理者の所属を追加（admin の付与は運営者のみ可能な設計）:
   ```
   node scripts/admin/run.mjs add-facility-admin --facility-id <id> --uid <UID>
   node scripts/admin/run.mjs add-facility-admin --facility-id <id> --uid <UID> --apply --confirm-uid <UID>
   ```
いずれも既存ドキュメントを上書きしない（`create` のみ）。

## 5. 守ること
- サービスアカウント鍵・Admin SDK 認証情報は作成・保存・commit しない。
- 注文は dryrun のまま。Forms / 本番GAS / 本番Firebaseには触れない。
