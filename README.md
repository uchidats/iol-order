# iol-order (眼内レンズ発注専用Webフォーム)

国家公務員共済組合連合会 立川病院眼科で運用されている眼内レンズ（IOL）発注フォームを、スマートフォンおよびPCから快適かつ確実に発注できるようにした専用Webアプリケーションです。

---

## 📋 運用元・参照Google Form仕様

- **運用施設**: 国家公務員共済組合連合会 立川病院眼科
- **参照元Form**: `https://docs.google.com/forms/d/e/1FAIpQLScin9rDfPOuxRkO3QFlqRpZwtf52NWjIW2eCaW7xpvilhI8Bg/viewform`
- **対象メーカー**: J&J, ALCON, SANTEN, NIDEK, HOYA (全12モデル)

---

## 🎯 登録メーカー・IOLモデルマスター一覧

| # | 表示名 / モデル | メーカー | トーリック | トーリック型番 | 許容度数範囲・ステップ |
|---|---|---|:---:|---|---|
| 1 | `J&J / DIB00V` | J&J | ✕ | - | +6.0D ～ +30.0D (0.5ステップ) |
| 2 | `J&J / DIWxxx (トーリック)` | J&J | **○** | DIW150, DIW225, DIW300, DIW375, DIW450, DIW525, DIW600 | +6.0D ～ +30.0D (0.5ステップ) |
| 3 | `ALCON / CNA0T0` | ALCON | ✕ | - | +6.0D ～ +30.0D (0.5ステップ) |
| 4 | `ALCON / CNA0Tx / CNW0Tx (トーリック)` | ALCON | **○** | CNA0T2, CNA0T3, CNA0T4, CNA0T5, CNA0T6, CNW0T7, CNW0T8, CNW0T9 | +6.0D ～ +30.0D (0.5ステップ) |
| 5 | `SANTEN / NX-70S` | SANTEN | ✕ | - | +10.0D ～ +27.0D (0.5ステップ) |
| 6 | `SANTEN / LS-313MF15` | SANTEN | ✕ | - | +10.0D ～ +27.0D (0.5ステップ) |
| 7 | `SANTEN / LS-313MF15 Tx (トーリック)` | SANTEN | **○** | LS-313MF15 T1, LS-313MF15 T2, LS-313MF15 T3 | +10.0D ～ +27.0D (0.5ステップ) |
| 8 | `NIDEK / NSP-2` | NIDEK | ✕ | - | +1.0～+5.0D (1.0ステップ)<br>+5.0～+27.0D (0.5ステップ)<br>+27.0～+30.0D (1.0ステップ) |
| 9 | `NIDEK / NP-Tx (トーリック)` | NIDEK | **○** | NP-T3, NP-T4, NP-T5, NP-T6, NP-T7 | +1.0～+5.0D (1.0ステップ)<br>+5.0～+27.0D (0.5ステップ)<br>+27.0～+30.0D (1.0ステップ) |
| 10 | `HOYA / XY1` | HOYA | ✕ | - | +6.0D ～ +30.0D (0.5ステップ) |
| 11 | `HOYA / PY-60AD` | HOYA | ✕ | - | +6.0D ～ +30.0D (0.5ステップ) |
| 12 | `ALCON / MN60MA (イエロー)` | ALCON | ✕ | - | -5.0D ～ +5.0D (1.0ステップ) |

---

## 🔍 入力項目と送信仕様

1. **メーカー名 / IOLモデル** (必須): 上記12種類から選択
2. **トーリックの場合は型番を選択** (トーリック選択時のみ表示・必須):
   - 非トーリック時は完全に非表示化＆値クリア（送信時は空文字 `""`）
3. **IOLパワー (ディオプター)** (必須):
   - Google Formの全60選択肢（`-5.0D` ～ `+30.0D`）から、モデルの許容度数・ステップに合致する度数のみを自動抽出して表示
   - `◀` / `▶` ステッパーボタンによる前後切り替え対応
4. **枚数** (必須): `1 枚` / `2 枚`
5. **手術日** (必須): HTML5標準日付ピッカー
6. **注文者** (必須): `内田` / `角田` / `利根川` / `秋冨` / `木村`（Google Form準拠のプルダウン）
7. **メールアドレス** (必須・新規):
   - 入力値を `localStorage` に保持し、次回起動時に自動入力
   - 注文完了控えや業者宛て送信の返信先として利用
8. **備考（フリーコメント）** (任意):
   - 各社Toric Calculatorの公式リンクを折りたたみ式で同梱

---

## 🌐 Google Apps Script (GAS) POST送信仕様

### 1. 接続設定（既定は送信しない「開発モード」）
GASのURLはコードに含めません。既定は `dryrun`（ネットワーク送信なし・実発注なし）です。
接続先と処理仕様を確認済みの開発用GASに限り、`src/config.local.example.js` を `src/config.local.js` にコピーして設定します（`config.local.js` は Git 管理外）。
`https://script.google.com/macros/s/` 以外のURLは拒否され、`dryrun` に戻ります。

### 2. 送信方式と成功判定
CORSプリフライトを回避するため `Content-Type: text/plain;charset=utf-8` でJSON文字列をPOSTします。
**サーバーが `success: true`（または `status: "success"|"ok"`）と、サーバー発行の `orderId` を返した場合のみ「受付完了」と表示します。** 受付番号をブラウザ側で生成・補完することはありません。

| 結果 | 画面表示 |
|---|---|
| dryrun | 「開発モード: 実際の発注は行われていません」（完了扱いにしない） |
| サーバーが明示的にエラー | 「注文は受け付けられていません」 |
| 通信エラー・HTTPエラー・非JSON・`orderId` なし | 「送信結果を確認できません。受け付けられている可能性があります」 |

いずれも入力内容は保持され、確認画面から再確認・再送信できます。

### 3. 送信payloadのJSON形式（例）

```json
{
  "model": "ALCON / CNA0Tx / CNW0Tx (トーリック)",
  "manufacturer": "ALCON",
  "toricModel": "CNA0T3",
  "power": "+20.0D",
  "quantity": "1 枚",
  "surgeryDate": "2026-10-15",
  "orderer": "内田",
  "email": "doctor@tachikawa-hosp.gr.jp",
  "notes": "右眼 白内障手術用",
  "submittedAt": "2026-10-02T01:35:00.000Z",
  "clientRequestId": "（再送時の重複検出用UUID。注文番号ではない）"
}
```
※トーリックIOLでない場合、`toricModel` は `""`（空文字）となります。

---

## 📷 生体計測結果の画像読み取り機能（クライアントサイドOCR解析）

OA-2000等の測定結果画面をスマートフォンから撮影・選択し、数値を自動抽出して手動確認・確定できる機能を実装しています。

### 1. 画像解析方式（ブラウザ内完全実行型 OCR）
- **解析エンジン**: **Tesseract.js**（Web Workerによるブラウザ内完全実行）
- **医療セキュリティ・プライバシー保護**: 画像データや患者情報を**外部サーバーやサードパーティAPIへ一切送信しません**。すべての画像前処理（Canvasによるグレースケール・コントラスト調整）および文字認識は端末のブラウザ内で完結します。

### 2. 厳格な安全設計（推測・補完の完全排除）
- **ダミー・補完値の排除**: OCR解析で明確に検出できた数値のみを入力欄に反映し、**解析できなかった項目は完全に空欄（未検出）のまま**保持します。推測値や平均値による自動補完は一切行いません。
- **ヒューマン・イン・ザ・ループ**: 抽出結果をそのまま注文やCalculatorへ反映せず、必ずユーザーが画面上で照合・手動修正・確定するステップを挟みます。
- **信頼度（Confidence）インジケータ**: 信頼度が低い項目や境界値には「⚠️ 要確認」バッジを表示して注意を促します。手動編集時はバッジが自動解除されます。

### 3. データ構造 (`rawAiValues` と `userConfirmedValues` の分離)
```javascript
biometryState = {
  rawAiValues: {
    al: { value: 24.12, confidence: 0.92 },
    acd: { value: 3.15, confidence: 0.88 },
    k1: { value: 43.25, confidence: 0.90 },
    k1Axis: { value: 175, confidence: 0.85 },
    k2: { value: null, confidence: null }, // 未検出項目はnull
    // ...
    rawText: "...",
    engine: "Tesseract.js (Client-Side)"
  },
  userConfirmedValues: {
    al: 24.12,
    acd: 3.15,
    k1: 43.25,
    k1Axis: 175,
    // ...
    isConfirmed: true
  }
};
```
※現段階では、確定された計測値は注文送信やAlcon Toric Calculatorへは転記されず、JavaScript内部に確認済み計測値として安全に保持されます。

---

## 🗂 ソース構成（ES Modules）

```
index.html            画面（<script type="module" src="src/main.js">）
src/main.js           起動処理
src/config.js         設定（既定dryrun）/ config.local.js で上書き
src/api/order-client.js     GAS送信と応答検証
src/data/iol-models.js      IOLモデル・度数マスター
src/data/schema.js          施設・注文者・採用IOL・ディーラーの型定義とRepository IF
src/data/static-repository.js  現行の固定データを返すRepository実装
src/domain/                 度数フィルタ・入力検証（純粋関数）
src/ui/                     注文フォーム・共通DOMヘルパー
src/biometry/               生体計測OCR（state / parser / ocr / UI）
docs/firestore-data-model.md  Firebase導入時のデータ設計（案）
tests/                      `npm test`（Node標準テストランナー）
```

ローカル確認は任意の静的サーバーで行います（ES Modulesのため `file://` では動作しません）。

---

## 🔐 Firebase（Authentication / Firestore）基盤

- 開発プロジェクト: `medconf-iol-dev`。設定は [src/firebase/firebase-config.js](src/firebase/firebase-config.js)。
- **`apiKey` が未設定の間は Firebase 機能を完全に無効化し、従来どおり（dryrun・固定データ）で動作します。** 値は推測せず、Firebase Console の値を設定してください。
- `apiKey` を設定すると、ログイン（Google / メールリンク）と施設への所属確認が済むまで、注文画面と生体計測OCRは表示されません。ログイン済みでも所属が無ければ、案内のみ表示されます。
- Firebase JavaScript SDK は v10.14.1 を CDN（gstatic）から動的に読み込みます（ビルド不要・既存の GitHub Pages 構成のまま）。
- Security Rules: `firestore.rules`。権限設計は [docs/firestore-data-model.md](docs/firestore-data-model.md)。
- テスト: `npm test`（単体）、`npm run test:rules`（Firestoreエミュレータ。Java と firebase-tools が必要。`demo-` プロジェクトで実行し、実プロジェクトには接続しません）。
- **サービスアカウント秘密鍵・Admin SDK 認証情報は Git に置かないこと**（`.gitignore` で代表的なファイル名を除外済み）。Web 用の `firebaseConfig` は公開前提の識別情報で、秘密鍵とは別物です。

詳細な運用手順（Console設定・ログイン接続テスト・管理者初期登録）は [docs/firebase-dev-runbook.md](docs/firebase-dev-runbook.md) を参照。
