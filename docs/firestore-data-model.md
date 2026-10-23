# Firestore データ設計（案）

> 設計のみ。Firebaseプロジェクトは未作成。実装は `src/data/schema.js` の `FacilityRepository` を差し替える形で行う。

## 方針
- 施設・注文者・採用IOL・ディーラーは**独立したドキュメント**とし、ID参照で結ぶ（名前の文字列で結ばない）。
- IOLの製品定義（現 `IOL_MODELS`）は全施設共通の**カタログ**。施設は「採用」するだけで定義を複製しない。
- 注文番号（`orderId`）は**サーバー（Cloud Functions）のみが発行**。クライアントは注文ドキュメントを直接作成できない。
- 病院側の在庫管理は持たない。

## コレクション

```
iolCatalog/{catalogIolId}            全施設共通（管理者のみ書込）
  manufacturer, model, displayName, isToric, toricModels[],
  powerRange{min,max,step,default,customSegments[]}, calculatorUrl, active

dealers/{dealerId}                   ディーラー
  name, orderEmails[], status, memberUids[]   ← SN照合画面のアクセス権

facilities/{facilityId}              施設（セルフ登録 → status: pending → 承認で active）
  name, status, createdByUid, createdAt
  ├─ orderers/{ordererId}            注文者
  │    name, email, uid?, active
  ├─ adoptedIols/{adoptedId}         採用IOL
  │    catalogIolId, dealerId, enabled
  ├─ facilityDealers/{dealerId}      施設が使うディーラー（施設側の発注先設定）
  │    dealerId, orderEmailOverride?, active
  └─ orders/{orderId}                注文（orderId はサーバー発行）
       status: "received" | "sent" | "failed"
       ordererId, adoptedIolId, catalogIolId, dealerId,
       snapshot{ model, toricModel, power, quantity, surgeryDate },   ← 発注時点の値を固定保存
       clientRequestId (重複検出), createdAt
       └─ iolLabels/{labelId}        将来: IOLシール写真・抽出結果・SN
            imagePath(Storage), extracted{model,power,serial,confidence}, confirmedByUid

users/{uid}
  memberships: { [facilityId]: "owner" | "admin" | "orderer" }
  dealerIds[]
```

## 現行コードとの対応
| 現行 | 将来 |
|---|---|
| `IOL_MODELS` | `iolCatalog` |
| `StaticRepository.listAdoptedIols` | `facilities/{id}/adoptedIols` |
| 注文者プルダウン（固定5名） | `facilities/{id}/orderers` |
| GAS `doPost` | Cloud Functions `createOrder`（`orderId` 発行・メール送信・`clientRequestId` で冪等化） |
| 生体計測OCR（端末内） | 同様に端末内。シールOCRも同方針（画像送信は別途判断） |

## セキュリティルール方針
- 施設配下は `users/{uid}.memberships[facilityId]` を持つ者のみ読取。書込は `owner/admin`。
- `orders` はクライアントからの create/update 不可（Functions経由のみ）。
- ディーラーは自社 `dealerId` が付いた注文・`iolLabels` のみ読取。
- `iolCatalog` は全認証ユーザー読取可、書込は管理者のみ。
- 患者名・生体計測値はFirestoreに保存しない（現行どおり端末内のみ）。

## 移行手順（案）
1. `FirestoreRepository` を `FacilityRepository` 実装として追加（UI層は無変更）。
2. 現行12モデルを `iolCatalog` に、立川病院を最初の `facility` として投入。
3. `createOrder` Functions を作成し、`order-client.js` の送信先を差し替え（応答検証ロジックはそのまま流用）。
