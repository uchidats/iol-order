# 注文受付（第1段階）

Cloud Functions（第2世代 callable `createOrder`）が注文を検証し、Firestore に保存する。**ディーラーへの通知・メール送信は行わない**（次段階）。

## 流れ
1. 画面は、確認済みの入力から `{ facilityId, requestId, ordererId, notes?, lines: [{ modelId, toricModel?, power, quantity, surgeryDate }, ...] }` だけを送る。1回の注文に複数の明細(最大20件・合計40枚)を入れられ、明細ごとに手術日が違ってもよい。従来の単一IOL形式(`modelId` 等をトップレベルに置く)も受け付け、1明細として扱う(同じ内容なら、どちらの形式で再送しても同じ注文になる)（`src/domain/order-request.js`）。レンズ名・注文者名・メール・価格などは送らない（送っても未知のキーとして拒否される）。
2. サーバー（`functions/src/orders.js`）が、1つのトランザクション内で次を確認する。
   - ログイン済み・メール確認済み。
   - 施設が有効で、操作者がその施設の有効な `admin` / `orderer` であること（毎回 Firestore で再確認。無効化されたユーザー・他施設・所属なしは `permission-denied`）。
   - `adoptedIols/{modelId}` が有効（`enabled=true`）で、サーバー側のIOLマスターに存在すること。
   - 度数がモデルの範囲・刻み（区間ごとの刻みを含む）に合うこと。トーリックは型番が必須で、そのモデルの型番のみ。非トーリックに型番は付けられない。
   - 枚数は 1 か 2。手術日は実在する日付で、日本時間の今日から366日以内。備考は1000文字以内。
   - 注文者は `orderers/{ordererId}` にいる有効（`active=true`）な人。注文者のメールは**任意**。
3. 保存先 `facilities/{facilityId}/orders/{orderId}`。`orderId` は (操作ユーザー, `requestId`) から決まる。注文番号 `IOL-YYYYMMDD-NNNN`（日本時間・施設ごと・日ごとの連番）はサーバーが発行する。

## 保存内容（スナップショット）
`schemaVersion: 2`、`status`（`accepted`）、`orderNumber`、`requestId`、`contentHash`、`facilityId` / `facilityName`、`lines[]`、`lineCount`、`totalQuantity`、`firstSurgeryDate` / `lastSurgeryDate`、`orderer`。
各明細 `lines[i]` = `{ lineNo, status, dealerId, surgeryDate, item }`。`item` は `modelId`, `manufacturer`, `model`, `displayName`, `isToric`, `isMultifocal`, `toricModel`(メーカーへ送る正式型番), `power`, `quantity`。**`dealerId` は採用IOLの設定(`adoptedIols/{id}.dealerId`)をその時点でスナップショットしたもので、未設定は `null`。将来はこれで明細をディーラーごとに振り分け、明細ごとの `status`(通知待ち・通知済み・失敗)を更新する。**
従来の単一IOL形式の保存(`schemaVersion: 1`: トップレベルの `item` / `surgeryDate`)は、`orderLinesOf()` で明細の配列として読める(実データには未作成)。
その他: `orderer`（`id`, `name`, `email|null`）、`notes`、`createdBy`（ログインユーザーの `uid` / `email` / `displayName`。注文者とは別）、`createdAt` / `acceptedAt` / `statusUpdatedAt`、`schemaVersion`。マスターを後で変更しても、この内容から注文を再現できる。

## 複数明細の検証
- 1つでも不正な明細があれば、注文全体を拒否し(何も保存せず、注文番号も消費しない)、エラーに「明細N:」を付ける。
- 明細ごとに: 採用済み・有効なモデル、度数の範囲と刻み、トーリックの正式型番、枚数(1か2)、手術日(日本時間で本日以降・366日以内)を検証する。
- 同じレンズ・型番・度数・手術日の明細の重複は拒否(枚数で指定する)。
- 画面側の検証と上限(`src/domain/order-lines.js`)は、サーバーの上限と一致していることをテストで確認している。
- 旧経路(GAS直接送信)は複数明細に対応しない(複数明細のときは送信せずエラーにする)。

## 冪等性・二重送信
- 同じ `requestId`・同じ内容の再送 → 既存の注文番号を返す（`replayed: true`）。
- 同じ `requestId` で内容が違う → `already-exists` で拒否。元の注文は変わらない。
- 画面は、確認画面を開いてから送信が成功するまで同じ `requestId` を使う。通信エラー後の再試行・連続クリックでも二重登録されない。
- 並列送信（同じ注文20並列、別注文10並列）でも、1件だけ作成・注文番号の重複／欠番なし（テストで確認）。

## 注文状態
`draft`（画面上のみ）→ `accepted`（今回ここまで）→ `notification_pending` → `notified` / `notification_failed`（将来。`ORDER_STATUS` に定義済み）。今回作る注文は `accepted` のみで、画面でも「発注済み」とは表示しない（「開発用受付・ディーラー未通知」）。

## Security Rules
`facilities/{fid}/orders/**` は、自施設の有効な所属者と運営者だけが**読める**。**作成・変更・削除は全員不可**（Admin SDK＝Cloud Functions のみ）。注文番号のカウンター（`orderCounters`）とレート制限（`rateLimits`）はクライアントから見えない。

## 有効化（二重の安全装置）
- **サーバー**: `ORDER_INTAKE_ENABLED`（既定 `false`）。`false` の間は認証済みの所属者でも `failed-precondition`。`functions/.env.medconf-iol-dev` で `true` にしてデプロイする。エミュレータのE2E（`demo-iol-e2e`）だけ `true`。
- **画面**: 公開サイトは `dryrun` のまま。保存を試すには、**ローカルの** `src/config.local.js`（Git管理外）に `orderMode: "server-dev"` を設定する。バッジは「開発用受付」になり、完了画面は「開発用受付・ディーラー未通知」と表示する。
- `orderMode: "gas"`（ブラウザからGASへ直接送信）は**廃止予定**。設定時に警告を出す。サーバー受付（と次段階の通知）が動作確認できた後に、コードごと削除する。

## IOLマスターの二重管理
サーバーは `functions/src/iol-catalog.js`・`power-filter.js`（`src/` の複製）を使う。`src/data/iol-models.js` / `src/domain/power-filter.js` を変更したら `npm run sync:catalog` を実行する。`tests/functions-catalog-sync.test.js` が、複製の不一致と、全モデルでクライアント／サーバーの許容度数が一致することを検査する。

## 実環境へ反映するときの注意
1. 順序: Rules（変更なし。念のため確認）→ Functions。`createOrder` は `ORDER_INTAKE_ENABLED=false` のまま先にデプロイでき、その間は何も保存されない。
2. 有効化は開発環境のみ。`functions/.env.medconf-iol-dev` を `ORDER_INTAKE_ENABLED=true` にして再デプロイ → ローカルの `config.local.js` で `server-dev` にして確認 → 確認後は `false` に戻す運用を推奨。
3. `createOrder` は他の callable と同じく `allUsers` に `run.invoker` が付く（公開エンドポイント）。認可は関数内（認証・所属・権限）。レート制限（1ユーザー1時間60回）あり。
4. 費用: 呼び出し1回あたり Firestore の読み取り6・書き込み3程度。`maxInstances: 5`。
5. 既存データ（立川病院・せんじゅ眼科）は変更しない。注文ドキュメントは、有効化して注文したときにだけ作られる。

## App Check の前提整理
- 目的: 正規のアプリ（`iol.medconf.jp` と開発用 `localhost`）以外からの callable 呼び出し（スクリプトによる濫用）を減らす。認可の代わりにはならない。
- 手順: ① Firebase Console で Web アプリに reCAPTCHA Enterprise（または v3）を登録 ② クライアントで `initializeAppCheck` をSDKの初期化直後に実行（`src/firebase/sdk.js` にApp Check SDKの読み込みを追加）③ **まず `enforceAppCheck: false` のまま**、Console の指標で未検証リクエストの割合を観察 ④ 問題なければ `functions/index.js` の `options.enforceAppCheck` を `true` にしてデプロイ。
- 注意: enforce にすると、App Check トークンを持たない古いクライアント・curl・エミュレータのテストは拒否される（エミュレータ用に debug token が必要）。リファラ制限した API キーと併用する。
