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
   - 注文者は `orderers/{ordererId}` にいる人(注文者に有効/無効はない。旧形式の `active` フィールドが残っていても無視する)。注文者のメールは**任意**。
3. 保存先 `facilities/{facilityId}/orders/{orderId}`。`orderId` は (操作ユーザー, `requestId`) から決まる。注文番号 `IOL-YYYYMMDD-NNNN`（日本時間・施設ごと・日ごとの連番）はサーバーが発行する。

## 保存内容（スナップショット）
`schemaVersion: 2`、`status`（`accepted`）、`orderNumber`、`requestId`、`contentHash`、`facilityId` / `facilityName`、`lines[]`、`lineCount`、`totalQuantity`、`firstSurgeryDate` / `lastSurgeryDate`、`orderer`。
各明細 `lines[i]` = `{ lineNo, status, dealerId, surgeryDate, item }`。`item` は `modelId`, `manufacturer`, `model`, `displayName`, `isToric`, `isMultifocal`, `toricModel`(メーカーへ送る正式型番), `power`, `quantity`。**`dealerId` / `dealer` は、注文時に決まった発注先(施設の登録ディーラー)のスナップショットで、発注先なしは `null`(下記「発注先の決め方」)。将来はこれで明細をディーラーごとに振り分け、明細ごとの `status`(通知待ち・通知済み・失敗)を更新する。**
従来の単一IOL形式の保存(`schemaVersion: 1`: トップレベルの `item` / `surgeryDate`)は、`orderLinesOf()` で明細の配列として読める(実データには未作成)。
その他: `orderer`（`id`, `name`, `email|null`）、`notes`、`createdBy`（ログインユーザーの `uid` / `email` / `displayName`。注文者とは別）、`createdAt` / `acceptedAt` / `statusUpdatedAt`、`schemaVersion`。マスターを後で変更しても、この内容から注文を再現できる。

## 複数明細の検証
- 1つでも不正な明細があれば、注文全体を拒否し(何も保存せず、注文番号も消費しない)、エラーに「明細N:」を付ける。
- 明細ごとに: 採用済み・有効なモデル、度数の範囲と刻み、トーリックの正式型番、枚数(1か2)、手術日(日本時間で本日以降・366日以内)を検証する。
- 同じレンズ・型番・度数・手術日の明細の重複は拒否(枚数で指定する)。
- 画面側の検証と上限(`src/domain/order-lines.js`)は、サーバーの上限と一致していることをテストで確認している。

## 冪等性・二重送信
- 同じ `requestId`・同じ内容の再送 → 既存の注文番号を返す（`replayed: true`）。
- 同じ `requestId` で内容が違う → `already-exists` で拒否。元の注文は変わらない。
- 画面は、送信の直前に `requestId` と送信内容を端末(localStorage。ログインユーザー・施設ごと)に保存し、受付の成功、またはサーバーが明確に拒否したとき(`invalid-argument` など。注文は作られていない)だけ消す(`src/domain/pending-order.js`)。
- 次に確認画面へ進むとき、保存した注文を注文ドキュメント(ID はサーバーと同じ `deriveOrderId`)で照会する。受付済みで同じ内容 → 新しく送らず、保存済みの注文を完了画面に出す。受付済みで内容が違う → 受付番号を知らせて新しい注文として進む。未登録で同じ内容 → 同じ `requestId` を再利用。照会できず内容が違う → 進ませない。
- これにより、タイムアウト・確認画面を閉じる(戻る)・再読み込みのあとの再送でも二重登録されない(`tests/browser/order-resend.pw.mjs`)。**別の端末・ブラウザからの再送は防げない**ため、エラー表示では注文履歴の確認を案内する。端末に保存できない環境では「二重には登録されません」と表示しない。
- 並列送信（同じ注文20並列、別注文10並列）でも、1件だけ作成・注文番号の重複／欠番なし（テストで確認）。

## 注文状態
`draft`（画面上のみ）→ `accepted`（今回ここまで）→ `notification_pending` → `notified` / `notification_failed`（将来。`ORDER_STATUS` に定義済み）。今回作る注文は `accepted` のみで、画面でも「発注済み」とは表示しない（「開発用受付・ディーラー未通知」）。
完了画面と注文履歴の詳細は、サーバーが保存した注文(明細・担当医・発注先・備考・状態)から表示する。

### メール送信(実装済み・送信停止中)
ディーラーへの注文メール・注文控え・送信状態の記録は `docs/order-mail.md`。注文と同じトランザクションで送信待ちのメールを保存し、送信は別の処理が行う。

## 発注先の一致
- 画面は、確認画面に表示した発注先のIDを、1社の自動選択を含めて必ず送る(発注先なしで確認した場合は `dealerId: null`)。
- サーバーは、確認した発注先が登録にない(削除された)場合や、発注先なしで確認したあとにディーラーが登録された場合、別のディーラーに切り替えず `invalid-argument`(「発注先の設定が変更された可能性があります」)で拒否する。`dealerId` の省略(旧形式)は従来どおり1社なら自動選択。

## Security Rules
`facilities/{fid}/orders/**` は、自施設の有効な所属者と運営者だけが**読める**。**作成・変更・削除は全員不可**（Admin SDK＝Cloud Functions のみ）。注文番号のカウンター（`orderCounters`）とレート制限（`rateLimits`）はクライアントから見えない。

## 開発用受付の制限(サーバー側で強制)
`ORDER_INTAKE_ENABLED=true` にしても、次を**すべて**満たす注文だけを受け付ける(`functions/.env.<project>`)。ブラウザ側の設定では回避できない。
- `ORDER_TEST_FACILITY_IDS`(カンマ区切り)に、注文先の施設IDが含まれる(開発環境: せんじゅ眼科 `fac-bafcbe1e6d6c6f6c3528cb11`)。
- `ORDER_TEST_UIDS`(カンマ区切り)に、操作者のUIDが含まれる(開発環境: 運営者アカウント)。ログイン済み・メール確認済みも必須。
- さらに従来どおり、その施設の有効な所属者であること(許可リストは所属確認の代わりにならない)。
- どちらかのリストが空・未設定なら**全員拒否**(安全側)。`ORDER_INTAKE_UNRESTRICTED=true` にしたときだけ制限なしの受付になる(将来の本番用。エミュレータのE2Eでも使用)。
- 許可外の呼び出しは、理由(許可リストの内容)を明かさず `permission-denied` で拒否し、何も書き込まない(利用枠・レート制限・注文番号も消費しない)。
- 制限つきの受付で保存した注文には `testOrder: true` が付く(通常の受付は `false`)。ディーラー通知・GAS通信はどちらでも行わない。
- テスト注文は自動では削除しない。一覧は `node scripts/admin/list-test-orders.mjs`(読み取り専用)で確認し、削除は内容を見てから人が判断する。

## 有効化（二重の安全装置）
- **サーバー**: `ORDER_INTAKE_ENABLED`（既定 `false`）。`false` の間は認証済みの所属者でも `failed-precondition`。`functions/.env.medconf-iol-dev` で `true` にしてデプロイする。エミュレータのE2E（`demo-iol-e2e`）だけ `true`。
- **画面**: 公開サイトは `dryrun` のまま。保存を試すには、**ローカルの** `src/config.local.js`（Git管理外）に `orderMode: "server-dev"` を設定する。バッジは「開発用受付」になり、完了画面は「開発用受付・ディーラー未通知」と表示する。
- `orderMode: "gas"`（ブラウザからGASへ直接送信）は**廃止した**（コードを削除。指定されても `dryrun`）。旧GASの Web アプリ(doPost)の停止は、別途 GAS 側で行う。

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

## 発注先の決め方(施設の登録ディーラー)
採用IOLごとの発注先設定は**使わない**(採用IOLの `dealerId` が残っていても無視する。既存データは変更しない)。発注先は、施設の登録ディーラー(`facilityDealers`)の数で決まる。

| 登録ディーラー | 画面 | サーバー(`createOrder`) |
|---|---|---|
| 0社 | 「発注先未設定」と表示。入力欄なし | 発注先なし(`dealer: null`)で受け付ける。`dealerId` の指定があれば拒否 |
| 1社 | そのディーラーを自動選択(入力欄なし) | 自動選択。指定がある場合はその1社と一致すること |
| 2社以上 | **明細ごとに「発注先」を選択(必須)**。直前の明細を引き継ぐが、勝手には決めない | 各明細に `dealerId` が必須。未選択・登録にないIDは拒否(`明細N: 発注先を選択してください` / `発注先が見つかりません`) |

- 画面の判定(`src/domain/dealer-selection.js`)とサーバー(`functions/src/orders.js` の `resolveLineDealer` / `dealerDispatch`)は同じ規則で、`tests/dealer-selection.test.js` で全組み合わせの一致を確認する。メールdry-runの送信可否も同じ判定。
- 画面がサーバーへ送るのは、**利用者が複数社から選んだ発注先のIDだけ**。1社の自動選択は送らず、サーバーが決める(確認画面から送信までの間に登録が増えて2社になった場合は、サーバーが「発注先を選択してください」と拒否し、画面で選び直す)。
- 注文時の発注先は、これまでどおり明細ごとに `{id, name}` のスナップショットで保存する(後で改名・削除しても変わらない)。同じ明細でも発注先が違えば別の明細(重複ではない)。冪等性のハッシュにも発注先を含める(未指定の場合は従来と同じ値)。
- 他施設のディーラーID・施設間の権限分離は従来どおり(自施設の `facilityDealers` だけを見る)。

## 発注先・実メール送信の可否(dispatch)
- 各明細は `dealerId` / `dealer`(その時点の `{id, name}` のスナップショット。後でディーラーを改名・削除しても過去の注文は変わらない)と、`dispatch: { allowed, reason }` を持つ。
  - `allowed=true`: 発注先が施設に登録されていて、**有効な形式の発注用メール(`orderEmails`)が1件以上**ある。
  - `allowed=false`: `reason` が `dealer-unset`(発注先未設定・削除済み)または `no-order-email`(発注用メール未登録)。
- 注文全体の `dispatchAllowed` は、全明細が `allowed=true` のときだけ true。
- **将来の実メール送信は、`dispatch.allowed=true` の明細だけを対象にし、使用報告用メール(`usageReportEmails`)を発注の送信先に使わない。** メールアドレスは注文には保存しない(送信時点のディーラー設定を参照するか、その設計時に別途決める)。
- 現在は送信機能なし(`ORDER_INTAKE_ENABLED=false`)。画面の確認では、発注先がない明細に「発注先未設定」と表示する。

## 発注メールのdry-run生成(プレビューのみ・送信しない)
- `src/domain/order-mail.js`(純粋関数)と `scripts/admin/preview-order-mail.mjs`(読み取り専用)。**メールの送信機能は実装していない。**
- 1回の注文の明細を、発注先ディーラーごとに振り分けて、ディーラーごとに1通分の 件名・本文・宛先を作る。担当医・手術日・度数が異なる明細も、そのまま対応付く。
- 宛先は、**生成時点の**施設のディーラー設定の発注用メール(`orderEmails`)だけ(重複・不正な形式は除く)。使用報告用メールは宛先にも本文にも使わない。
- 注文に保存された `dispatch.allowed` は参考情報。生成時点で、ディーラーが存在すること・発注用メールが1件以上あることを再検証する。食い違うときは警告を付け、判定は現在の設定で行う。発注先未設定の明細はメールにせず(`unrouted`)、1通でも送れないものがあれば `allReady=false`。
- **【保留】件名・本文の形式は未確定。** 現行 Google Forms + GAS が送るメールの形式は、このリポジトリの資料・コードに無い(GAS側は管理外)。現在の件名・本文は暫定の下書き(`templateStatus: "draft-unconfirmed"`)。形式が確定したら `buildSubject` / `buildBody` だけを差し替える(宛先の決定・振り分け・検証は形式に依存しない)。
- **現行GAS形式を再現済み**(現行GASコードと受信メールで確認。`src/domain/order-mail-profiles.js`)。
  - 件名: `【施設名】IOL注文：ご確認のほどよろしくお願いします`(施設名は生成時に入れる)。宛名: `ディーラー名御中`。
  - 本文: Google Forms の質問名と回答を入力順に「質問名: 回答」で列挙。複数レンズは「レンズN」ごとに1ブロック(メーカー名 / IOLモデル・トーリック型番(該当時のみ。空欄は出さない)・IOLパワー・枚数・手術日・担当医)→ 発注者(Googleログイン情報。担当医とは別)とそのメールアドレス → 備考(省略・要約・整形せず、改行を含めてそのまま)→ 定型文3行 → 施設の署名。
  - **宛名のディーラー名は、現行GASの正式表記を優先**する(`dealerDisplayNames`: ディーラーID → 正式表記。立川病院の「1Fc1MIFpWjR6bwjuG1sS」は「栗原医療器械店」。Firestore の登録名「栗原医療機械店」は**変更しない**。表記が異なる場合は警告を付ける)。
  - **施設の形式の対応**: メール形式は施設ID(`facilities/{id}` のドキュメントID)で選ぶ。立川病院は実際のID `tachikawa-hospital`(読み取りで確認)。
  - **固定の確認先メールアドレスは、将来、施設設定で管理する**(今回は設定UI・データの追加なし。dry-run では引数 `--confirm-to` / 関数の引数で渡す。コードには書かない)。
  - **施設の住所・署名は施設ごとの設定**(`createGasProfile({ id, signature })`)。立川病院の署名は立川病院にだけ使い、署名の定義がない施設は署名なしで生成して警告を出す(将来は施設設定から読み込む)。
  - 宛先(すべて To、CC・BCC なし): ①ディーラーの発注用メール ②固定の確認先 ③発注者のメール(サーバーが記録したログイン情報)。**3つは別の概念**で、①が1件もなければ②③があっても送信不可。メールアドレスはコードに書かない(②は設定・引数から渡す)。
  - 施設ごとに形式を変えられる(`resolveMailProfile(facilityId)`。定義のない施設は暫定の既定)。設定UIは作らない。将来は施設設定(Firestore)から読み込む。担当医への確認メールは対象外。
- **暫定テンプレート(定義のない施設の既定)は正式版ではない。** 各メールに `templateStatus: "draft-unconfirmed"`・`reviewRequired: true` が付き、`isTemplateConfirmed()` は常に false。**将来の実送信の処理は、現行GASの形式で確認済みになる(この関数を変更する)まで、このテンプレートを使ってはいけない。**
- **備考**は注文時の自由記述(患者に関わる内容が書かれうる)。現時点ではdry-run生成のみで、本文に載せるとともに `notes` として別にも返し、実送信の前に人が内容を確認できるようにしている(プレビューCLIも備考を別行で表示する)。実送信の設計では、送信前の確認(承認)の手順を残す。
- 使い方: `node scripts/admin/preview-order-mail.mjs --facility <施設ID> --latest`(medconf-iol-dev・読み取りのみ)。
