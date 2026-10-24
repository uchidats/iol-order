# IOLモデルの表示順（施設ごと）

施設設定「採用IOL」で、メーカーの順番とメーカー内のモデルの順番を ↑↓ で変更できます（スマホでもタップで操作可能）。
保存した順番は、注文フォームのIOLモデル選択肢（トーリック・多焦点の絞り込み後も含む）に反映されます。

## データ
- `facilities/{fid}/displaySettings/iolOrder` = `{ makerOrder: [メーカー名], modelOrder: [系列ID], updatedAt }`
- 順番だけの設定。採用状態（`adoptedIols`）、モデルID、注文内容、注文処理には影響しない。
- 未設定の施設は共通IOLマスターの標準の順番。後から追加されたメーカー・モデルは、既存の順番を崩さず末尾に標準の順番で並ぶ。マスターに無いIDは無視する。
- 読み込みに失敗した場合も標準の順番で表示する（注文フォームを止めない）。

## Rules
- 読取: 運営管理者 / 自施設メンバー
- 作成・更新: 運営管理者 / 自施設の施設管理者のみ。ドキュメントIDは `iolOrder` 固定、キーは `makerOrder`・`modelOrder`・`updatedAt` のみ、リストの上限あり（メーカー50・モデル200）。
- 削除: 運営管理者 / 施設管理者
- 「設定担当者」ロールは未実装のため、現状は施設管理者のみ。

## 実装
- `src/domain/iol-order.js`（純粋関数）、`src/ui/facility-settings.js`、`src/ui/order-form.js`、`src/data/firestore-repository.js`（`getIolOrder` / `saveIolOrder`）
- デプロイ時は Rules を先にデプロイする（未デプロイだと保存が拒否されるが、閲覧・注文には影響しない）。
