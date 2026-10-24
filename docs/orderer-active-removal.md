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

## 反映の順序(新旧が混在しても注文画面が使えなくならないこと)
1. **Cloud Functions をデプロイ**(`createOrder` が `active` を見なくなる。旧形式・新形式どちらも注文可。現在は受付無効のため影響なし)。
2. **Security Rules をデプロイ**し、続けて**画面(push)を反映**する。
   - 画面が先だと、新形式の保存が旧Rulesに拒否される。Rules が先で旧画面が残っていると、旧画面での注文者の保存が拒否される(読み取り・注文は影響なし)。2つは数分以内に続けて行う。
   - 画面は `active` を無視するので、移行前の旧形式ドキュメントが残っていても注文フォームは使える。ただし **active=false の注文者(内田2)は、移行までは選択肢に表示される**。
3. 直後に、dry-run → 判断(内田2を残す/削除する) → 実行の順で**移行**する。
4. 移行後に、施設設定で注文者の追加・編集・並び替え・削除を確認する。

**移行を先にしてはいけない**: 旧画面は `active` が無いと注文者を表示しない。必ず 1〜2 の後に移行する。

ロールバック: バックアップ(JSON)から `active` を戻せる。画面・Functions・Rules は前のコミットへ戻してデプロイする。
