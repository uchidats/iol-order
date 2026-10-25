# 公開前の最終確認と反映順序（feature/remove-active）

対象: 注文者/ディーラーの `active` 廃止、所属の `status` 廃止（`removeMember`）、レンズ明細ごとの担当医、施設ごとのIOL表示順。
すべて medconf-iol-dev のみ。本番Google Forms・GASには触れない。実発注・メール送信はしない（`ORDER_INTAKE_ENABLED=false`、公開サイトは dryrun のまま）。

## 依存関係
| 変更 | Functions | Rules | Web | 旧データ移行 |
|---|---|---|---|---|
| 担当医（明細ごと） | `createOrder`（`doctorId` / 旧 `ordererId` どちらも受付） | 変更なし | 新画面は `doctorId` を送る | 不要 |
| orderer `active` 廃止 | `createOrder` が `active` を見ない | `active` を含む書き込みを拒否 | `active` を無視 | **反映後**に `migrate-orderer-active.mjs` |
| dealer `active` 廃止 | 同上（ディーラーは施設の登録で確認） | 同上 + 管理者の削除 | 同上 | **反映後**に `--collection facilityDealers` |
| member `status` 廃止 | `removeMember` を追加 | members 書込みは運営者のみ・`isMember` は存在確認のみ | 「所属を削除」 | **phase 1 は Rules の前**、phase 2 は反映後 |
| IOL表示順 | なし | `displaySettings/iolOrder` を追加 | 設定の↑↓・注文フォームに反映 | 不要（未設定=標準順） |

## 反映の順序（最終版）
0. 事前: 全テスト成功と、各移行の dry-run を再確認する。この間、新規登録・招待の受諾を行わない（データ変更の混在を避ける）。
1. **member phase 1**: 無効な所属が0件なら処理不要（dry-run で確認）。1件でもあれば先に削除/復帰を決める。
2. **Security Rules をデプロイ**（Functions より先）。
3. **Cloud Functions をデプロイ**（`createOrder`・`removeMember`。受付は無効のまま）。
4. **push（画面）**。続けて公開サイトで動作確認する。
5. **公開サイトが新バージョンを配信していることを検証する**(待機時間だけに頼らない):
   `node scripts/verify-deployed.mjs --wait 20 --interval 30`(読み取りのみ。公開サイトの `index.html` を毎回キャッシュ回避で取得し、手元の import map と `styles.css`/`main.js` の `?v=` ハッシュが全一致するまで最大10分確認する。一致=終了コード0、不一致=1)。**不一致のまま移行しない。**
   さらに、ブラウザで公開サイトを開き(通常の再読み込み1回)、設定画面の見出し・「担当医」表記・レンズ明細の「担当医」欄が出ていること、コンソールにエラーがないことを確認する。
6. **移行**: orderers → facilityDealers → member phase 2（各 dry-run → 実行。バックアップ・`--confirm medconf-iol-dev` 必須）。
7. 確認: 施設切替・担当医選択・確認画面・設定（担当医/ディーラー/利用者/採用IOLの↑↓）。

Rules を Functions より先にする理由(旧記載の「Functions → Rules」から変更): 新Functions は `status` なしの所属を作る。旧Rulesは `status=='active'` を要求するため、Functions が先だと、その間に参加・登録した人が施設にアクセスできない。Rules が先なら、旧Functions が作る所属(`status` あり)も新Rulesで問題なく使える。

**移行は必ず 5(検証の一致)の後。** 旧画面(キャッシュ含む)は、注文者・ディーラーの `active` が無いと表示せず、所属の `status` が無いと施設へアクセスさせない(`src/domain/access.js`)。

## 新旧が混在する時間帯の互換性
| 組み合わせ | 動くもの | 動かないもの(影響) |
|---|---|---|
| 旧Web + 新Rules (2〜3) | ログイン・施設切替(既存の所属は `status=active`)・注文画面の読み取り・採用IOL保存 | 旧画面の担当医/ディーラー保存(`active` を含む書き込みを拒否)、旧「所属の無効化」(クライアントからの所属変更を拒否)。設定画面の保存だけで、注文・アクセスには影響なし |
| 旧Web + 新Rules + 新Functions (3〜4) | 上記に加え注文(旧画面の `ordererId` 形式も受付。ただし現在は受付無効) | 同上。`removeMember` の画面がまだ無い |
| 新Web + 新Rules + 新Functions (4〜6) | すべて。`active`/`status` が残る旧データも読める | なし |
| 移行後に残った旧Web(キャッシュ・開きっぱなしのタブ) (6以降) | — | 担当医・ディーラーが表示されない／所属(`status` なし)を持つ施設に入れない。5の検証で入れ替わりを確認して回避。残っていれば再読み込み(Ctrl+F5)で解消 |
新Functions + 旧Rules(Functionsを先にした場合)は上記の理由で避ける。

## 利用者のアクセス権限（確認結果）
- 新Rulesでは `isMember` は所属ドキュメントの存在と role を見る(`status` は見ない)。`status` のある旧所属もない新所属も同じ扱い。
- 施設管理者: 自施設の担当医・ディーラー(新形式)・採用IOL・表示順を書ける。所属・操作履歴(`auditLogs`)はクライアントから書けない。一般注文者は設定を書けない。他施設・未認証は不可。`collectionGroup` の所属取得は自分の所属のみ。いずれも Rules テストで確認済み(42件)。
- 現データの所属3件はすべて `status=active` で、無効な所属は0件のため、新Rulesで新たにアクセスできるようになる人はいない。
- 所属削除は `removeMember`(施設管理者のみ、一般注文者のみ、監査ログと同一トランザクション)。

## 途中で失敗した場合の安全な停止・復旧
共通: **失敗したらそこで止め、次の手順に進まない。移行は行わない。** どの途中状態でも、既存の所属・データ・注文は壊れない（受付は無効のまま）。
- **2 Rules のデプロイ失敗**: 何も変わらない(原子的)。原因を直して再実行。
- **3 Functions のデプロイ失敗**: 関数は個別に更新される。失敗した関数だけ再デプロイ。旧Functions + 新Rules でも動く(上表)。
- **4 push 失敗**(拒否・Pages のビルド失敗・確認で不具合): Pages は直前の成功版を配信し続けるため、公開サイトは旧画面のまま。上表のとおり旧Web+新Rules+新Functionsは安全(設定の保存の一部が拒否されるだけ)なので、**ロールバック不要で停止し、原因を直して再push**する。長引く場合のみ、画面を戻したうえで Rules を前のコミットへ戻す。
  - 戻す前に確認: `status` なしの所属が無いこと(あれば `status: active` を補う。旧Rulesは `status` を要求する)。
- **6 移行の途中失敗**: スクリプトは各ドキュメントを `updateTime` 付きで更新し、失敗した時点で停止する(取り消しはしない)。`active`/`status` の有無が混在しても、新Web・新Rules・新Functionsは両方を扱えるので**そのままで動く**。dry-run で残りを確認し、同じコマンドで再実行する(すでに新形式のものは対象外)。元に戻す場合は、バックアップ(JSON)の値から対象フィールドを戻す(手作業)。
- **全体を戻す場合**: 画面 → Rules → Functions を前のコミットへ戻して再デプロイ。移行後に戻すなら、先に上記「バックアップからの復元」で `status`/`active` を戻す(旧画面は無いと表示しない)。
- **手順5の検証が一致しない**: push が反映されていない(Pages のビルド失敗・遅延)。GitHub の Actions/Pages のビルド結果を確認し、移行に進まず待つ・再pushする。長時間一致しない場合は上記「push 失敗」と同じ扱い。

## 新旧のWeb画面が混在する場合の注意
- **混在しうるのは、push から公開サイトの入れ替わり(Pages のキャッシュ最大10分)まで**、および**開きっぱなしのタブ・古いキャッシュを持つ端末**。公開サイトは import map で JS をハッシュ付きで取得するため、HTML が新しければ JS も新しいが、HTML が古いままのタブは旧版のまま動く。
- **旧画面から移行済みデータを見ると**: 担当医・ディーラーが選択肢に出ない(`active` が無い)、施設に入れない(`status` が無い)。**データを壊すわけではない**。再読み込みで新版になる。
- **旧画面から保存しない**: 旧画面で担当医・ディーラーを保存すると、新Rulesが拒否する(`active` を含む書き込み)。旧画面で「所属の無効化」を押しても拒否される。保存が拒否されたら、再読み込みして新版でやり直す。
- **利用者(施設管理者・注文者)への連絡**: 移行(手順6)の前後は、設定の変更や注文をしないよう伝える。移行の前に、管理者の端末で再読み込みしてもらう。
- 移行は、検証(手順5)で一致を確認し、かつ自分の端末が新版であることを確認してから行う。

## バックアップからの復元(`active` / `status` を戻す)
**必要になるのは、旧Web・旧Rulesへ戻す場合だけ**(新Web・新Rules・新Functionsのままなら、`active`/`status` が無くても動く)。
バックアップJSONは移行スクリプトが実行前に自動で書き出す(`backups/` 。注文者・ディーラー: `docs` 形式、所属: `members` 形式)。復元は種類ごとに、バックアップ1ファイルずつ:
```
node scripts/admin/restore-from-backup.mjs --backup backups/orderers-YYYYMMDD.json                     # dry-run(現在の値と比べて、戻す内容を表示)
node scripts/admin/restore-from-backup.mjs --backup backups/orderers-YYYYMMDD.json --execute --confirm medconf-iol-dev
```
- 戻すのは `active`(注文者・ディーラー)、`status`/`lastAuditId`(所属)だけ。名前・メール・role など他のフィールドは触らない。更新は読み取り時点の `updateTime` が変わっていない場合だけ。
- 移行で**削除した**ドキュメントも戻すなら `--recreate-deleted` を付ける(存在しない場合だけ再作成)。付けなければ削除済みは対象外と表示する。
- 途中で失敗しても、同じコマンドを再実行できる(戻し済みは対象外になる)。
- 手順: ①旧Web・Rulesへ戻す前に、dry-run で内容を確認 → ②復元 → ③画面 → Rules → Functions の順に前のコミットへ戻す。**旧Rulesに戻す前に、`status` のない所属がないこと**を確認する(旧Rulesは `status=='active'` を要求する)。
- 所属を戻す場合は、バックアップの種類(phase 1 / phase 2 のどちらの前か)を取り違えない。無効だった所属(`status=disabled`)を戻すと、再び無効になる(アクセス不可)。
- 現データにはバックアップがまだない(未実行)。移行実行時に自動で作られる。

## 無効な注文者の扱い
方針: 不要なテスト登録のため、移行時に削除対象とする（`--remove-inactive 施設ID/注文者ID`）。
**ただし最新の dry-run（読み取りのみ）では、`active=false` の注文者は存在しない。**
`tachikawa-hospital/tOg4OhoJV7CfYTmh3He9`は名前が変更・`active=true` に変わっており、削除対象にならない（スクリプトは `active=false` のものだけ削除し、`active=true` は削除しない）。
**決定: この担当医は今回は削除せず残す**（active を外すだけ）。不要な担当医の整理は、移行後に施設設定から行う。

## 直近の dry-run 結果（読み取りのみ）
- orderers: 3件すべて `active=true` → active除去のみ（削除0）
- facilityDealers: 1件 `active=true` → active除去のみ
- members phase 1: 3件すべて `status=active`（disabled 0）→ phase 1 の処理は不要。施設 `fac-bafcbe…` に一般注文者(orderer) の所属が1件ある。
