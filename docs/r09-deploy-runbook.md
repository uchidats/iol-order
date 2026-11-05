# R09 IOLシール写真 配備の手順(段階ごとのコマンドと確認)

設計は `docs/iol-sticker-photo-design.md`(§8-4・§8-6・§9-3)。この文書は実行するときの手順だけをまとめる。
**どの段階も、運営者の指示の後に、1段階ずつ行う。** 値(Secret・アクセスコード・施設の実データ)をこの文書・チャット・ログに書かない。

- プロジェクト: `medconf-iol-dev` / リージョン: `asia-northeast1`
- 実行サービスアカウント: `iol-functions-dev@medconf-iol-dev.iam.gserviceaccount.com`(全関数で共通。ユーザー管理の鍵なし)
- 配備の前(2026-11-05)の状態: Storage の権限なし、写真用のバケットなし、Secret は既存の4個、必要な API(Storage・Secret Manager・Cloud Scheduler)は有効、本番に R09 のデータなし。

## 実施の状況(2026-11-05 時点)

機能は停止のまま(`STICKER_PHOTO_ENABLED=false`、対象の施設なし)。どの施設も利用できない。

| 段階 | 状況 | 結果 |
| --- | --- | --- |
| 1. バケットと IAM | 実施済み | この文書のコマンドどおり。確認の結果は期待どおり(匿名の一覧は 401) |
| 2. Secret | 実施済み | 作成の方法を変更(段階 2 の記録)。有効な版が1つ、自動レプリケーション |
| 3. Rules・インデックス | 実施済み | 差分は全拒否の 8 領域(28 行の追加)と `stickerPhotos` の1本だけ。インデックスは `READY`。旧版のルールセットは `6e8a3125…`(戻すときに使う) |
| 4. 新しい5関数 | 実施済み | 5つとも `ACTIVE`。既存の 38 関数は更新時刻・設定とも変更なし |
| 5. 停止の状態での確認 | 一部を除き実施済み | 下の一覧の応答はすべて期待どおり。**別々の回線からの送信元 IP の確認は未実施** |
| 6〜8 | 未実施 | 運営者の指示の後に行う |

## 既存の機能への影響(先に読む)

- `functions/index.js` は `STICKER_TICKET_SECRET` を宣言している。段階 2 が済むまで Functions 全体を配備しない(2026-11-05 に登録済み)。**注文・メールの関数を直すときは、これからも関数を指定して配備する**(例 `--only functions:createOrder`)。既存の関数の環境変数は配備の時期によって値が異なるものがあるので、全体を配備すると、それらの関数の環境変数も現在の `.env` の値に揃う。
- 段階 4・7 は新しい5関数だけを指定する。既存の関数は再配備しない。
- Rules の差は R09 の領域の全拒否の追加だけ。インデックスは `stickerPhotos` の1つが増えるだけ(既存のものは削除しない。`--force` を付けない)。

## 段階 0. 配備の前のテスト

`npm test`、`npm run test:rules`、`npm run test:functions`、`npm run test:functions:e2e`、R09 と既存画面のブラウザテスト。
e2e の「施設設定の変更履歴」の1件は `main` でも失敗する既存の問題(エミュレータで Firestore のトリガーが動かない。R09 と無関係)。

## 段階 1. バケットと IAM

```bash
gcloud storage buckets create gs://medconf-iol-dev-sticker-photos --project=medconf-iol-dev --location=asia-northeast1 --default-storage-class=STANDARD --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=0
```

確認(読み取りだけ)。期待: `ASIA-NORTHEAST1`、均一なアクセス `true`、公開アクセスの防止 `enforced`、Soft Delete の保持 `0`、バージョニングは空(無効)。

```bash
gcloud storage buckets describe gs://medconf-iol-dev-sticker-photos --format="yaml(location,storage_class,uniform_bucket_level_access,public_access_prevention,soft_delete_policy,versioning_enabled)"
```

権限(バケット単位の1件だけ。プロジェクト単位の役割は増やさない)。

```bash
gcloud storage buckets add-iam-policy-binding gs://medconf-iol-dev-sticker-photos --member=serviceAccount:iol-functions-dev@medconf-iol-dev.iam.gserviceaccount.com --role=roles/storage.objectUser
```

確認。期待: 上の1件のほかに `allUsers`・`allAuthenticatedUsers` がないこと。

```bash
gcloud storage buckets get-iam-policy gs://medconf-iol-dev-sticker-photos --format="table(bindings.role,bindings.members)"
```

外から読めないこと。期待: 401(認証なしでは一覧も取得もできない)。

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://storage.googleapis.com/storage/v1/b/medconf-iol-dev-sticker-photos/o"
```

- バケット名は世界で一意。作成が名前の重複で失敗したら、名前を変えて `STICKER_PHOTO_BUCKET` に設定する。
- 取り消し: 空のバケットは `gcloud storage buckets delete gs://medconf-iol-dev-sticker-photos` で消せる。
- プロジェクトのオーナーと、既定のサービスアカウント(編集者)は、プロジェクト単位の権限でバケットに届く。これは既存の状態で、ここでは変えない。

## 段階 2. Secret

値は画面・ログ・ファイルに出さない。

**2026-11-05 の実施(当初の手順からの変更)**: 当初の手順は `openssl rand -base64 48 | gcloud secrets create … --data-file=-` だった。この環境(Windows)では Bash の `gcloud` が動かず、PowerShell のパイプは値の末尾に改行を足すおそれがあるので、次の方法に変えた。

1. 同名の Secret がないことを確かめる。
2. `gcloud secrets create STICKER_TICKET_SECRET --project=medconf-iol-dev --replication-policy=automatic --labels=firebase-managed=functions`(ラベルは既存の4個と同じ)。
3. PowerShell の `RandomNumberGenerator` で 48 バイトの乱数をメモリ内に作り、Base64 の文字列(64 文字)にする。
4. 文字列を Secret Manager の REST API(`:addVersion`)へ直接送り、変数を消す。値はファイルに書かない。
5. 権限は、この Secret に限って `iol-functions-dev` へ `roles/secretmanager.secretAccessor` を付ける(既存の4個と同じ形)。

値は読み戻していない。段階 4 の配備で関数に割り当てられたことを確かめた。実際の署名は、段階 7 で確かめる。

確認(値は読まない)。期待: 有効な版が1つ。

```bash
gcloud secrets versions list STICKER_TICKET_SECRET --project=medconf-iol-dev --format="table(name,state)"
```

- 関数への割り当ては `stickerEntryApi`・`stickerPhotoUpload` の2つだけ。全関数が同じ実行サービスアカウントなので、IAM では2関数に絞れない(権限上はほかの関数の実行環境からも読める)。絞っているのはコードの `secrets:` の宣言で、既存のメール用の Secret と同じ扱い。
- 段階 4 の配備のとき、CLI は「権限を付けた」と表示するが、同じ内容の再設定で、権限は変わらない(前後で確認済み)。
- 既存の Secret(メール関連の4個)は変更しない。
- 鍵を替えると、発行済みのチケット(最長 30 分)が無効になるだけで、保存済みの写真には影響しない。

## 段階 3. Rules とインデックス

```bash
firebase deploy --only firestore:rules,firestore:indexes --project medconf-iol-dev
```

確認。期待: `stickerPhotos`(`status`・`takenAt`)が `READY`。作成の完了を待ってから次へ。

```bash
gcloud firestore indexes composite list --project medconf-iol-dev --format="table(collectionGroup,state)"
```

## 段階 4. 新しい5関数(機能は停止のまま)

`functions/.env.medconf-iol-dev` に次を足す(値は停止のまま)。`--non-interactive` では既定値のある変数も入力を求められて失敗するので、`STICKER_PHOTO_BUCKET` も明記する。

```
STICKER_PHOTO_ENABLED=false
STICKER_PHOTO_FACILITY_IDS=
STICKER_PHOTO_BUCKET=medconf-iol-dev-sticker-photos
```

```bash
firebase deploy --only functions:stickerEntryApi,functions:stickerPhotoApi,functions:stickerPhotoUpload,functions:stickerPhotoImage,functions:stickerPhotoCleanup --project medconf-iol-dev
```

確認。期待: 5つが `ACTIVE` で、実行サービスアカウントが `iol-functions-dev`。既存の関数の更新時刻が変わっていないこと。

```bash
gcloud functions list --project medconf-iol-dev --filter="name~sticker" --format="table(name.basename(),state,serviceConfig.serviceAccountEmail,updateTime)"
```

## 段階 5. 停止の状態での確認(外部から呼べる入口)

4つの入口は、ログインの有無にかかわらず URL に届く。機能が停止の間は、すべて拒否することを確かめる(エミュレータでは `tests/functions/sticker-photo.test.js` の「機能の停止中」で確認済み)。
`BASE=https://asia-northeast1-medconf-iol-dev.cloudfunctions.net`

| 入口 | 認証・認可 | 停止中の応答 |
| --- | --- | --- |
| `stickerEntryApi`(callable。ログインなし) | 入口トークン + アクセスコード + 回数制限 | 正しいコードでも、誤りと同じ `PERMISSION_DENIED`。チケット・施設名を返さない |
| `stickerPhotoUpload`(HTTP。ログインなし) | 署名付きの送信チケット(30 分・コードの世代) | チケットを確かめる前に 503。別オリジンは 403、PUT 以外は 405 |
| `stickerPhotoImage`(HTTP。ログイン必須) | ID トークン + 所属、ディーラーは共有の許可 | 未ログインは 401、ログイン済みは 404 |
| `stickerPhotoApi`(callable。ログイン必須) | ID トークン + 所属・役割、ディーラーは担当者の確認 | 未ログインは `UNAUTHENTICATED`、ログイン済みは `FAILED_PRECONDITION`。`status` だけは `enabled: false` を返す |

```bash
curl -s -X POST "$BASE/stickerEntryApi" -H "Content-Type: application/json" -H "Origin: https://iol.medconf.jp" -d '{"data":{"token":"AAAAAAAAAAAAAAAAAAAAAA","code":"123456"}}'
```

期待: `"status":"PERMISSION_DENIED"`。

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X PUT "$BASE/stickerPhotoUpload" -H "Origin: https://iol.medconf.jp" -H "Content-Type: image/jpeg" --data-binary "x"
```

期待: `503`。`Origin` を `https://evil.example` にすると `403`、`-X POST` にすると `405`。

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/stickerPhotoImage?facility=x&photo=x"
```

期待: `401`。

```bash
curl -s -X POST "$BASE/stickerPhotoApi" -H "Content-Type: application/json" -d '{"data":{"action":"list","facilityId":"x"}}'
```

期待: `"status":"UNAUTHENTICATED"`。

CORS(事前確認)。期待: 許可のヘッダーは `https://iol.medconf.jp` だけ(要求のオリジンをそのまま返さない)。

```bash
curl -s -i -X OPTIONS "$BASE/stickerEntryApi" -H "Origin: https://evil.example" -H "Access-Control-Request-Method: POST" | grep -i "access-control-allow-origin"
```

**送信元 IP の取り方(設計書 §8-6 (4))**: 別々の回線(例: Wi-Fi と携帯の回線)から、上の `stickerEntryApi` の確認を1回ずつ送る → Firestore の `stickerRateLimits` で `scope` が `ip` の文書が回線ごとに分かれていれば(それぞれの回線の `count` が 1 ずつ増える)正しい。1つにまとまっていたら、機能を有効にせず `clientIpOf` を直す。IP そのものは記録されない(文書の ID はハッシュ)。

- 確認の要求は、停止中も回数制限の記録を作る(送信元ごとに 10 分で 30 回まで)。この記録は、機能を有効にした後に `stickerPhotoCleanup` が期限切れのものから消す。
- `stickerPhotoCleanup` は公開していない。未認証の呼び出しは `403`(本文なしの POST は `411` になるので、`Content-Length` を付けて確かめる)。実行の権限は `iol-functions-dev` だけ。スケジューラは 24 時間ごとに呼ぶが、停止の間は何もしない。
- `stickerPhotoUpload` の 503 は、Cloud Run の要求ログに ERROR として残る。アプリのエラーではない。

**2026-11-05 の実環境の確認の結果(偽のトークン・コードだけを使用。一覧のとおり)**

- 確認 `PERMISSION_DENIED`、保存 `503`(チケットなし・偽のチケット)、別オリジン `403`、`POST` `405`、画像 `401`(未ログイン・偽の ID トークン)、API `UNAUTHENTICATED`(`list`・`status`)、`stickerPhotoCleanup` `403`。
- CORS: `stickerEntryApi` は別オリジンでも許可のヘッダーが正規のサイトのまま。`stickerPhotoUpload`・`stickerPhotoImage` は別オリジンの事前確認が `403`。`stickerPhotoApi` は別オリジンをそのまま返す(`createOrder` などの既存の callable と同じ。ID トークンが必須で Cookie を使わない。設計書 §8-2 のとおり)。
- バケット: 匿名の一覧 `401`、匿名の XML 一覧・オブジェクトの取得 `403`、オブジェクト 0 個。
- 確認の呼び出しを1回行ったので、`stickerRateLimits` に記録が3件(`ip`・`token`・`tokenDay`。各 `count` 1)ある。IP そのものは含まない。段階 5 の送信元 IP の確認では、この `ip` の文書も数に入る(別の回線から送ると、`ip` の文書が増えることを確かめる)。

## 段階 6. 画面(`main` へ統合。表示の設定は false のまま)

`feature/r09-integration` を `main` へ統合して push する。メニューと施設設定の項目は出ない。`sticker.html` は開けるが、確認は通らない。

## 段階 7. 立川病院だけを有効にする

`functions/.env.medconf-iol-dev` を次のようにする(施設 ID は、既存の `ORDER_TEST_FACILITY_IDS` にある立川病院の値)。

```
STICKER_PHOTO_ENABLED=true
STICKER_PHOTO_FACILITY_IDS=<立川病院の施設ID>
```

段階 4 と同じコマンドで、5関数だけを配備する。

- ほかの施設: サーバーが設定・確認・保存・一覧・画像・ディーラーの閲覧をすべて拒否する(`facilityOn`)。
- 止めるとき: `STICKER_PHOTO_ENABLED=false` にして、同じ5関数を配備する。

## 段階 8. 実機の確認と、画面の表示

1. `STICKER_VIEWER_ENABLED`・`STICKER_SETTINGS_ENABLED` を true にして `main` へ push する。
   - メニュー「IOLシール写真」は、サーバーが「使える」と答えた施設(立川病院)だけに出る。施設を切り替えると確かめ直す。
   - ディーラーの「シール写真」は、写真の共有を許可された施設がある会社にだけ出る。
   - 施設設定の項目は、対象の施設の管理者・副管理者だけに出る(対象外の施設では自動で隠れる)。
   - 表示の設定を true にしても、サーバーが停止の間・対象外の施設には何も出ない。段階 7 より前に true にしてもよいが、順序を単純にするため、ここで行う。
2. 実機(Galaxy・iPhone)で、コードの設定・QR・台紙の印刷・撮影・送信・再送・閲覧・削除・共有と取消を確かめる。手順書は `docs/r09-pilot-guide.md`。

## 費用の目安(立川病院だけの試験)

保存は1枚 2〜3MB。月 100 枚で約 0.3GB の増加(月に数円〜十数円)。Secret は無料枠の中。関数とスケジュールの呼び出しはほぼ無料枠の中。合計で月に数十円以下の見込み。
