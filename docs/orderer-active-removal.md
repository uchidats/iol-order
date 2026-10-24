# 注文者の「有効/無効(active)」廃止と移行手順

注文者(`facilities/{fid}/orderers/{id}`)から `active` を廃止した。注文者は「いる／いない」だけで、不要な注文者は**削除**する。
**利用者管理(`members` の `status`、無効化・再有効化)は別の仕組みで、変更していない。** ディーラー(`facilityDealers`)の `active` も対象外。

## コード側の変更
- 画面: 注文フォームの選択肢は全注文者。施設設定の一覧に「無効」表示・有効無効の状態はない。保存するドキュメントは `facilityId / name / email? / sortOrder / updatedAt` のみ。
- Cloud Functions `createOrder`: 注文者の `active` を見ない(旧形式のドキュメントでも、新形式でも同じに扱う)。
- Security Rules: 注文者の書き込みは **新しい形式だけ**(`active` を含む書き込みは拒否)。読み取りは旧形式も可。
- 過去の注文に保存された注文者情報(`orders/*.orderer`)は変更しない。

## 現在のデータ(medconf-iol-dev、読み取りで確認)
注文者 3 件: せんじゅ眼科 1 件(active=true)、立川病院 2 件(active=true 1 件、**active=false 1 件**: 「内田2」`uchidats@senju-eye-clinic.jp`)。すべて旧形式(active あり)。

## 移行スクリプト `scripts/admin/migrate-orderer-active.mjs`
- 既定は **dry-run**(読み取りのみ)。対象は medconf-iol-dev 固定。
- active=false の注文者は、**残す(`--keep-inactive 施設ID/注文者ID`)か削除する(`--remove-inactive 施設ID/注文者ID`)かを明示しないと実行できない**。「残す」場合は、通常の注文者として選択肢に表示されるようになる。
- 実行には `--execute` ・ `--backup <新しいファイル>` ・ `--confirm medconf-iol-dev` がすべて必要。実行前に全注文者のバックアップを書き出す(既存ファイルには書かない)。
- 各ドキュメントは、読み取り時点の `updateTime` が変わっていない場合だけ更新・削除する。実行後に再読み込みして、`active` が残っていないことを確認する。

## 反映の順序
**デプロイ・移行の順序は `docs/release-plan.md` に統一している（このファイルには順序を書かない）。** 順序は Rules → Functions → push → 公開サイトの新バージョン確認 → 移行。この件の移行は `node scripts/admin/migrate-orderer-active.mjs`(注文者)。**移行を先にしてはいけない**(旧画面は `active` が無いと注文者を表示しない)。

ロールバック: `docs/release-plan.md` の「バックアップからの復元」を参照(`scripts/admin/restore-from-backup.mjs`)。
