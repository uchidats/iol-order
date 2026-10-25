# 施設設定の変更履歴(auditLogs)

担当医(`orderers`)・採用IOL(`adoptedIols`)・ディーラー(`facilityDealers`)は、画面から Firestore へ直接書き込む(Security Rules で検証)。
その変更を Firestore トリガー(`auditOrderers` / `auditAdoptedIols` / `auditFacilityDealers`。`onDocumentWrittenWithAuthContext`)で受け、
`facilities/{fid}/auditLogs/s_{イベントID}` に記録する。実装は `functions/src/settings-audit.js`。

## 記録の内容
- `action`: `settings.{コレクション}.{create|update|delete}`
- `target`: `{ collection, id, label }`(label は担当医名・ディーラー名、採用IOLはモデルID)
- `changes`: 変わった項目だけ `{ 項目: { before, after } }`
  - 発注用メール・使用報告用メール: `{ added: [...], removed: [...], countBefore, countAfter }`。各アドレスは **伏せ字(`a***@example.jp`)と指紋(SHA-256 の先頭8桁)だけ**で、アドレスそのものは記録しない。指紋は「同じアドレスか」の照合用。
  - 担当医のメールも同じく伏せ字・指紋。
  - 並び順(`sortOrder`)・`updatedAt` だけの変更、大文字小文字・前後の空白だけのメールの違いは記録しない。
- 変更者: `actorType`(`app_user` = 画面からの変更 / `admin` = サーバー処理 / `unknown`)、`actorUid`、`actorName`(その施設の所属の表示名)。
- 日時: `changedAt`(変更の時刻 = イベントの時刻)、`at`(記録した時刻)。
- 読めるのは施設の管理者・副管理者と運営者。クライアントからは作成・変更・削除できない(既存の Rules。テストで確認)。

## 重複実行・失敗時
- トリガーは同じイベントを2回以上届けることがある。履歴のIDをイベントIDから決めて `create` で書くので、2回目は何もしない(二重に記録しない)。
- 書き込みに失敗したら例外にして再試行させる(`retry: true`)。再試行でも上と同じ理由で二重にならない。設定の変更そのものは、履歴の失敗で取り消されない(トリガーは変更の後に動く)。
- 施設削除(`deleteFacility`)で設定がまとめて消えたときは、施設がもう無いので記録しない(削除された施設の下に履歴を作らない)。

## 対象外
- 表示順(`displaySettings`)・施設の名前/所在地(`facilities/{fid}`)の変更は対象外。利用者管理は従来どおり各 Functions がトランザクションで記録する。
- 画面での履歴の表示はまだない(Firebase Console・管理スクリプトで確認する)。

## デプロイの注意
- 第2世代の Firestore トリガーは Eventarc を使う。実行サービスアカウント(`iol-functions-dev`)に `roles/eventarc.eventReceiver` が必要になる場合がある(デプロイ時にエラーで分かる)。付与は最小限にする。
- エミュレータはトリガーに認証情報を渡さない(`actorType: unknown`)。本番で `app_user` と uid が記録されることは、デプロイ後に開発環境で確認する。
