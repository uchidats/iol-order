# 利用者(所属)の「有効/無効(status)」廃止と移行手順

所属(`facilities/{fid}/members/{uid}`)から `status` を廃止した。所属は「ある／ない」だけで、不要になった利用者は**所属を削除**する。
注文者マスターの `active` 廃止(`orderer-active-removal.md`)・ディーラーの `active` とは別の仕組みで、施設の `status`(pending/active/suspended)は変更していない。

## 仕様
- 所属ドキュメント: `uid / role(admin|orderer) / displayName? / email? / updatedAt?`。`status` と `lastAuditId` はない。
- **所属の削除**: Cloud Functions `removeMember`(施設管理者のみ)。**所属の削除と操作履歴(`auditLogs`)の記録を1つのトランザクションで行う**(片方だけは起きない)。
  - 削除できるのは、自施設の一般注文者(orderer)の所属だけ。**管理者(自分自身・最後の管理者を含む)の所属は削除できない**。他施設の所属は操作できない。
  - 削除した人宛ての未使用の招待は取り消す(古い招待コードで再参加できない)。再び参加させるには新しい招待を発行する。
- **削除後のアクセス**: Security Rules(`isMember`)が毎回、所属ドキュメントの存在を確認するため、ログイン中のセッションでも次のリクエストから、その施設のデータにアクセスできない。
- **操作履歴**: `facilities/{fid}/auditLogs`。クライアントは作成・変更・削除できない(Cloud Functionsだけが書く)。読めるのは施設管理者と運営者。
- Security Rules: 所属の作成・変更・削除はクライアントから不可(運営者を除く)。新規作成は新形式(`status` なし)のみ。
- 画面: 「利用者管理」に有効/無効の表示はなく、一般注文者の行に「所属を削除」ボタン(確認ダイアログあり)がある。

## 現在のデータ(medconf-iol-dev、読み取りで確認)
`node scripts/admin/migrate-member-status.mjs --phase 1` の dry-run で、所属の件数・無効(disabled)の有無を確認する(下記)。

## 移行スクリプト `scripts/admin/migrate-member-status.mjs`
- 既定は **dry-run**(読み取りのみ)。対象は medconf-iol-dev 固定。実行には `--execute`・`--backup <新しいファイル>`・`--confirm medconf-iol-dev` がすべて必要。実行前に全所属のバックアップを書き出す。更新・削除は、読み取り時点の `updateTime` が変わっていない場合だけ行う。
- **role には触れない。有効な所属を無効にも、無効な所属を勝手に有効にもしない。**
- **phase 1**(新Rules・新画面のデプロイの**前**): 無効(`status=disabled`)の所属ごとに、`--remove-disabled 施設ID/uid`(所属を削除)か `--restore-disabled 施設ID/uid`(明示的に有効に戻す)を指定する。指定がなければ実行できない。
- **phase 2**(新Rules・新画面のデプロイの**後**): 残った所属から `status` / `lastAuditId` を取り除く。無効の所属が残っていると実行できない(取り除くと有効になるため)。

## 反映の順序
**デプロイ・移行の順序は `docs/release-plan.md` に統一している（このファイルには順序を書かない）。** 順序は Rules → Functions → push → 公開サイトの新バージョン確認 → 移行。所属は **phase 1(新Rulesの前: 無効な所属の処理)と phase 2(公開サイトの新バージョン確認の後: `status` の除去)** の2段階。無効の所属が残ったまま新Rulesをデプロイすると、無効だった人が再びアクセスできてしまう。**phase 2 を画面の反映より先にしてはいけない**(旧画面は `status` が無いと所属として扱わない)。

ロールバック: `docs/release-plan.md` の「バックアップからの復元」を参照(`scripts/admin/restore-from-backup.mjs`)。過去の操作履歴(`member.disable` / `member.enable`)は、そのまま残る。
