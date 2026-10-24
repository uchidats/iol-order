# ディーラーの「有効/無効(active)」廃止と移行手順

ディーラー(`facilities/{fid}/facilityDealers/{id}`)から `active` を廃止した。ディーラー管理は「追加・編集・削除」。注文者の `active` 廃止(`orderer-active-removal.md`)・所属の `status` 廃止(`member-status-removal.md`)と同じ考え方で、互いに独立している。

## 仕様
- ドキュメント: `facilityId / name / dealerId? / orderEmails? / usageReportEmails? / sortOrder? / updatedAt`。`active` はない。**発注用・使用報告用メールアドレスの別管理は従来どおり**(各最大5件)。
- 削除: 自施設の施設管理者(と運営者)が、画面のゴミ箱(確認ダイアログあり)から削除できる。他施設・orderer・未認証は不可(Security Rules)。
- **削除後は発注先として使われない**: `createOrder` は、採用IOLの `dealerId` が**その施設に今も登録されているディーラー**のときだけ、明細の発注先(`dealerId` / `dealer`)にする。削除済み・他施設のIDは `null`。
- **過去の注文は変わらない**: 注文の各明細には、注文時点のディーラー(`dealer: {id, name}`)をスナップショットで保存している。ディーラーを削除・改名しても、既存の注文は書き換えられない(注文はクライアントから書けない)。
- 旧形式(`active` つき)のディーラーも、移行までは読め、`createOrder` は `active` を見ない(登録されていれば発注先になる)。Rules は新形式だけを書き込める(`active` を含む書き込みは拒否)。

## 現在のデータ(medconf-iol-dev、読み取りで確認)
ディーラー 1 件: 立川病院「栗原医療機械店」(`active=true`)。無効(`active=false`)はなし。メール未登録。

## 移行(`scripts/admin/migrate-orderer-active.mjs --collection facilityDealers`)
注文者と同じスクリプトを、`--collection facilityDealers` で使う。既定は dry-run。無効のディーラーがあれば、`--keep-inactive` / `--remove-inactive` で残す・削除するを明示しない限り実行できない。実行には `--execute --backup <新しいファイル> --confirm medconf-iol-dev` が必要。各ドキュメントは `updateTime` が変わっていない場合だけ更新・削除する。

## 反映の順序
**デプロイ・移行の順序は `docs/release-plan.md` に統一している（このファイルには順序を書かない）。** 順序は Rules → Functions → push → 公開サイトの新バージョン確認 → 移行。ディーラーの移行は `--collection facilityDealers`。**移行を先にしてはいけない**(旧画面は `active` が無いと無効扱いにする)。

