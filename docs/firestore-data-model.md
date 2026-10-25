# Firestore データ設計と認証・権限

開発環境: Firebase プロジェクト `medconf-iol-dev`（本番プロジェクトは未作成）。
Security Rules は [firestore.rules](../firestore.rules)、テストは `npm run test:rules`（エミュレータ、実プロジェクトには接続しない）。

## アクセスの原則
1. **ログイン ≠ 利用許可。** ログイン後、`members` に所属ドキュメント（`role=admin|orderer`）が確認できるまで、注文画面・施設情報は表示も取得もされない（画面側 `decideAccess`、サーバー側 Rules の両方で拒否）。所属に有効/無効はなく、所属が削除されると既存のセッションでも次のリクエストから拒否される。
2. 所属の取得に失敗した場合も許可しない（fail closed）。
3. **権限は本人が付与できない。**
   - 自分の `members` ドキュメントは誰も（admin でも）クライアントから変更できない。
   - `admin` の付与・昇格・削除は、カスタムクレーム `platformAdmin` を持つ運営者のみ。
   - 施設管理者（admin）が管理できるのは、他人の `orderer` 所属、注文者、採用IOL、施設のディーラー設定、施設名のみ。
   - 施設の作成・状態変更・削除、IOLカタログ・ディーラー本体の変更は運営者のみ。
4. `platformAdmin` クレームは Admin SDK（サーバー側・秘密鍵が必要）でのみ設定できる。クライアントから設定する手段はない。
5. 注文（`orders`）はクライアントから作成・変更不可。将来の Cloud Functions のみが作成する。

## コレクション

```
iolCatalog/{catalogIolId}        全施設共通（ログイン済みは読取、運営者のみ書込）
dealers/{dealerId}               ディーラー本体（運営者 + memberUids に含まれる者のみ読取、運営者のみ書込）

facilities/{facilityId}          name, status: pending|active|suspended, updatedAt,
                                 location?: {lat, lng}, geoRadiusM?: number   ← 現在地による施設選択の補助（任意）
  ├─ members/{uid}               uid, role: admin|orderer, displayName?, email?, updatedAt   ← 有効/無効(status)はない。削除=所属の解除
  ├─ orderers/{id}               facilityId, name(1-50), email?, sortOrder?, updatedAt   ← 有効/無効(active)はない
  ├─ adoptedIols/{catalogIolId}  facilityId, catalogIolId(=doc id, 共通マスターのID), dealerId?, enabled, updatedAt
  ├─ facilityDealers/{id}        facilityId, name(1-100), dealerId?, sortOrder?, updatedAt,
  │                              orderEmails[<=5]?（発注用）, usageReportEmails[<=5]?（使用報告用。発注用とは別管理）
  ├─ orders/{orderId}            サーバー(createOrder)発行のみ・クライアント書込不可。詳細は order-intake.md
  └─ orderCounters/{yyyymmdd}    注文番号の連番(サーバー専用)
```

- `members/{uid}` のドキュメントIDは Firebase Auth の uid。`uid` フィールドと一致必須。
- ログイン直後の所属確認は `collectionGroup("members")` + `where("uid","==",自分)`。
  Rules は自分の所属ドキュメントのみ許可。`firestore.indexes.json` で `members.uid` の collection group インデックスを定義。
- `users` コレクションは作らない（Rules でも全拒否）。プロフィールが必要になった時点で設計する。
- 病院側の在庫管理は持たない。

## 施設のセルフ登録と招待（サーバー側のみ）
施設の作成・招待による所属の作成は Cloud Functions だけが行う。詳細は [self-registration.md](self-registration.md)。
- `facilities/{id}` にセルフ登録の場合 `createdBy` / `selfRegistered` / `createdAt` が付く。
- （旧招待コード方式は廃止。残っていても使用不能）`invites/{sha256(token)}`（招待。トークンのハッシュのみ保存）と `registrationQuota/{uid}`（利用枠）は **サーバー専用**（Rules で全クライアント拒否）。

## 施設設定（施設管理者のみ）
画面: ヘッダーメニューの「施設設定」（`role=admin` のみ表示）。注文者 / 採用IOL / ディーラーを編集し、保存すると注文フォームの選択肢へ即時反映される。
- **注文者**: 追加・名前/メール編集・並び替え（`sortOrder` は表示順×10）。削除（ゴミ箱アイコン・確認ダイアログあり）は自施設の施設管理者と運営者が可能。削除するのは注文者マスターのみで、所属・認証ユーザー・過去の注文には影響しない。一時的に外すだけなら無効化を使う。同名（大文字小文字・全角半角の差を無視）は登録不可。
- **採用IOL**: 共通IOLマスター（`src/data/iol-models.js` の `IOL_MODELS[].id`）から選ぶ。ドキュメントID＝マスターID（重複採用を構造的に防ぐ）。解除は `enabled=false`。マスターに無いIDは Rules が拒否する。
  Rules 内の許可IDの一覧は `IOL_MODELS` と同期が必要（`tests/rules-catalog-sync.test.js` が不一致を検出する）。マスターを Firestore の `iolCatalog` へ移す際にこの二重管理を解消する。
- **ディーラー**: 名称・追加・編集・削除(有効/無効はない)・**発注用メール**と**使用報告用メール**（それぞれ最大5件、形式検証あり）。現時点では登録のみで、メール送信・ディーラー連携は未実装。
- 検証は画面（`src/domain/facility-settings.js`）と Rules の両方で行う。権限は常に Rules が最終判定し、画面でメニューを隠すだけに依存しない。
- 所属先以外の施設・orderer 権限・所属のない人・未認証は、設定の読み書きができない（Rules テストで検証）。

## 施設の選択と位置情報（GPS）
施設の確定ルール（複数所属の場合のみ選択が発生する）:
1. 有効な所属が1つ → GPSを使わず自動選択。
2. 複数 → 端末に記憶した前回の施設（uid と facilityId のみ。**Firestoreで検証済みの有効な所属に含まれる場合だけ採用**）。ログアウトで消去、「施設を切り替える」でも消去。
3. 記憶がなく、ユーザーが位置情報の利用に同意済み（「現在地から施設を選ぶ」を押した端末）かつブラウザの許可が granted → ログイン時に現在地を1回だけ取得して判定。
4. 判定できない／同意がない → 施設選択画面（手動）。
- 選択後は通常の注文画面。切替はヘッダーメニュー「施設を切り替える」。入力中の内容があれば破棄の確認を出し、承諾するとページを再読込して入力・計測値をメモリごと破棄する。切替直後の1回は自動復元・自動判定を行わない。

位置情報の扱い:
- 施設ドキュメントの `location`（{lat,lng}）と `geoRadiusM`（判定距離, m）は施設管理データ。**両方が登録された施設だけが判定対象**で、コード内に既定の座標・距離は持たない。設定は管理者（Rules上は 10〜5000m・緯度経度の範囲のみ検証）または運営者が行う（`scripts/admin/run.mjs set-facility-geo`）。
- 判定: 現在地の測位誤差 a、施設までの距離 d、判定距離 r に対し、`d + a <= r`（誤差円が判定円に完全に収まる）施設がちょうど1つで、他に `d - a <= r` の施設がない場合のみ自動選択。測位誤差が大きい・複数該当・圏外は手動選択。
- 比較はブラウザ内のみ。**座標はFirestoreに保存せず、外部送信せず、ログにも出さない。** 取得はログイン時／ボタン操作時の `getCurrentPosition` 1回のみで、`watchPosition` による継続追跡はしない。
- **GPSは所属・権限の代わりにならない。** 自動選択の対象は Firestore で検証済みの所属施設に限られ、権限は常に Rules が判定する。
- 注文確認画面には施設名を表示する（取り違え防止）。

## 現行コードとの対応
| 現行 | 実装 |
|---|---|
| `IOL_MODELS`（コード内） | 当面コード内。各モデルの不変の `id` を `adoptedIols`（ドキュメントID / `catalogIolId`）が参照する。`iolCatalog` への移行は今後 |
| `StaticRepository`（Firebase未設定時） | `FirestoreRepository`（`src/data/firestore-repository.js`）。UI層は `FacilityRepository` のみに依存 |
| 注文送信 | 引き続き dryrun。`orders` と `createOrder` Functions は未実装 |

## 未実装・今後
- 施設のセルフ登録（`pending` 施設の作成 + 初代 admin の付与は Cloud Functions + Admin SDK で行う。クライアント直書きにしない）
- メンバー招待フロー（現状は運営者/管理者が uid を指定して `members` を作る必要がある）
- 複数施設に所属するユーザーの施設切替UI（現状は facilityId 昇順の先頭）
- `createOrder`（orderId 発行・冪等化・メール送信）、IOLシール画像、ディーラー向けSN照合

## 利用者管理（施設管理者）
画面: 施設設定 > 利用者管理。所属ユーザーの氏名・メール・権限を表示し、**一般注文者(orderer)** の所属を削除できる（確認ダイアログあり）。有効/無効の状態はない。詳細・移行手順は [member-status-removal.md](member-status-removal.md)。
- 所属の削除は Cloud Functions `removeMember` だけが行う（クライアントは所属を作成・変更・削除できない）。管理者（自分自身・最後の管理者を含む）の所属・他施設の所属は削除できない。
- **所属の削除と操作記録 `facilities/{fid}/auditLogs/{id}` は1つのトランザクション**。記録は追記のみ（クライアントは作成・変更・削除不可）で、施設管理者と運営者だけが読める。
- 削除後は、`isMember()` が毎回所属ドキュメントの存在を確認するため、ログイン中のセッションでも次のリクエストからアクセスできない。削除した人宛ての未使用の招待は取り消される。
- `members/{uid}.email`: 参加・登録時にサーバーが確認済みメールを記録する（表示用）。古い所属には無く、画面では「—」と表示される。


- IOLモデルの表示順: `facilities/{fid}/displaySettings/iolOrder` = `{ makerOrder, modelOrder, updatedAt }`（詳細は docs/iol-display-order.md）
