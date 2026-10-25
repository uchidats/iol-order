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
- 変更者: `actorType`(`user` / `server` / `unknown`)、`actorUid`、`actorName`(その施設の所属の表示名)、`actorSource`、`actorVerified`(下の「変更者の決め方」)。
- 診断用: `auth: { type, id?, idMatchesActor? }`。`id`(authId)はサービスアカウント(個人ではない)のときだけ。それ以外は変更者と一致したかだけを残す。
- 日時: `changedAt`(変更の時刻 = イベントの時刻)、`at`(記録した時刻)。
- 読めるのは施設の管理者・副管理者と運営者。クライアントからは作成・変更・削除できない(既存の Rules。テストで確認)。

## 変更者の決め方(Auth Context だけに頼らない)
トリガーの Auth Context(`authtype` / `authid`)は、Firebase の公式ドキュメントに「利用者の変更で authid に何が入るか」の記載がなく、
firebase-functions の型定義にも `app_user` がない。そのため、Rules で検証した値を優先する。
1. `authType` が `service_account` / `system` → `server`(Admin SDK・Cloud Functions など)。
2. 作成・更新: `updatedBy`。Rules が「ログイン中の本人の uid」かつ「`updatedAt` = この書き込みの時刻(serverTimestamp)」を検証する。
   トリガーは、この書き込みで `updatedAt` が新しくなった場合だけ使う(Admin SDK が `updatedAt` を変えずに書いた場合に、前回の `updatedBy` を使わない)。`actorSource: "updatedBy"`、`actorVerified: true`。
3. 削除(担当医・ディーラー): 画面は、削除と同じ一括書き込みで `facilities/{fid}/deletionMarks/{コレクション}_{ID}` に `deletedBy`(本人の uid)・`deletedAt`(時刻)を書く。Rules が本人・時刻を検証し、削除の規則は `getAfter` でこの記録を確認する。トリガーは、削除イベントの時刻の前後2分以内で、最後の更新より新しい記録だけ使う。`actorSource: "deletionMark"`。記録はクライアントから読めず、消せない。
4. 1〜3 で決まらず、`authType` が `app_user` で `authId` がこの施設の所属の uid と一致するとき → 未検証の変更者(`actorSource: "authContext"`、`actorVerified: false`)。
5. それ以外 → `unknown`(変更者なし)。変更の内容は記録する。

### 変更者を確実に記録できない条件
- 移行期間(Rules の `actorRequired()` が `false` の間)に、旧版の画面(`SETTINGS_ACTOR_TRACKING` が `false` の版。開いたままのタブを含む)から変更した場合。4 に当たらなければ `unknown`。
- Admin SDK・管理スクリプト・Firebase Console からの変更。`server`(サービスアカウント)または `unknown` で、人は特定しない(IAM の個人アカウントのメールは記録しない)。
- 採用IOLの削除(画面にはない。運営者が Console などで削除した場合)、施設削除に伴う設定の削除(記録しない)。
- トリガーが最大の再試行期間(イベントの保持期間)を過ぎても失敗し続けた場合(その変更の履歴が残らない。Cloud Logging にエラーが残る)。
- 削除の記録と削除イベントの時刻の差が2分を超えた場合(通常は起きない。`unknown` になる)。
- `actorName` は記録した時点の所属の表示名(変更時点ではない)。所属を外れた人は `actorUid` だけになる。

## 重複実行・失敗時
- トリガーは同じイベントを2回以上届けることがある。履歴のIDをイベントIDから決めて `create` で書くので、2回目は何もしない(二重に記録しない)。
- 書き込みに失敗したら例外にして再試行させる(`retry: true`)。再試行でも上と同じ理由で二重にならない。設定の変更そのものは、履歴の失敗で取り消されない(トリガーは変更の後に動く)。
- 施設削除(`deleteFacility`)で設定がまとめて消えたときは、施設がもう無いので記録しない(削除された施設の下に履歴を作らない)。

## 対象外
- 表示順(`displaySettings`)・施設の名前/所在地(`facilities/{fid}`)の変更は対象外。利用者管理は従来どおり各 Functions がトランザクションで記録する。
- 画面での履歴の表示はまだない(Firebase Console・管理スクリプトで確認する)。

## 移行の手順(この順で行う)
1. Rules をデプロイする(移行中: `updatedBy`・削除の記録は「あれば検証」、なくても受け付ける)。旧画面も新画面も動く。
2. `src/data/firestore-repository.js` の `SETTINGS_ACTOR_TRACKING` を `true` にして push する(画面が変更者を送り始める)。
3. IAM を付与し、トリガー3つをデプロイする(下)。開発環境で変更し、`actorSource: "updatedBy"` / `"deletionMark"` と uid が記録されることを確認する。
4. 利用者の画面が新しい版になった後(開いたままのタブの再読み込みを待つ)、`firestore.rules` の `actorRequired()` を `true` にして Rules をデプロイする(変更者の記録を必須にする)。
   2 より前に 4 を行うと、旧画面の保存・削除が拒否される。1 より前に 2 を行うと、新画面の保存・削除が拒否される。

## デプロイの注意
- 第2世代の Firestore トリガーは Eventarc を使う。実行サービスアカウント(`iol-functions-dev`)に `roles/eventarc.eventReceiver` が必要になる場合がある(デプロイ時にエラーで分かる)。付与は最小限にする。
- エミュレータはトリガーに認証情報を渡さない(authType: unknown)。それでも Rules を通した `updatedBy`・削除の記録から変更者が決まることを E2E テストで確認している。本番の authType / authId の実際の値は、デプロイ後に `auth.type` で確認する。
