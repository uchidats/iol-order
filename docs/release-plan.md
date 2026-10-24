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
5. **公開サイトのキャッシュが入れ替わるまで待つ**（GitHub Pages は最大10分キャッシュ。目安15分）。
6. **移行**: orderers → facilityDealers → member phase 2（各 dry-run → 実行。バックアップ・`--confirm medconf-iol-dev` 必須）。
7. 確認: 施設切替・担当医選択・確認画面・設定（担当医/ディーラー/利用者/採用IOLの↑↓）。

Rules を Functions より先にする理由(旧記載の「Functions → Rules」から変更): 新Functions は `status` なしの所属を作る。旧Rulesは `status=='active'` を要求するため、Functions が先だと、その間に参加・登録した人が施設にアクセスできない。Rules が先なら、旧Functions が作る所属(`status` あり)も新Rulesで問題なく使える。

**移行は必ず 4 と 5 の後。** 旧画面(キャッシュ含む)は、注文者・ディーラーの `active` が無いと表示せず、所属の `status` が無いと施設へアクセスさせない(`src/domain/access.js`)。

## 新旧が混在する時間帯の互換性
| 組み合わせ | 動くもの | 動かないもの(影響) |
|---|---|---|
| 旧Web + 新Rules (2〜3) | ログイン・施設切替(既存の所属は `status=active`)・注文画面の読み取り・採用IOL保存 | 旧画面の担当医/ディーラー保存(`active` を含む書き込みを拒否)、旧「所属の無効化」(クライアントからの所属変更を拒否)。設定画面の保存だけで、注文・アクセスには影響なし |
| 旧Web + 新Rules + 新Functions (3〜4) | 上記に加え注文(旧画面の `ordererId` 形式も受付。ただし現在は受付無効) | 同上。`removeMember` の画面がまだ無い |
| 新Web + 新Rules + 新Functions (4〜6) | すべて。`active`/`status` が残る旧データも読める | なし |
| 移行後の旧Webキャッシュ (6以降) | — | 担当医・ディーラー・施設が表示されない(5の待機で回避。再読み込みで解消) |
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
- **全体を戻す場合**: 画面 → Rules → Functions を前のコミットへ戻して再デプロイ。移行後に戻すなら、先に`status`/`active` をバックアップから復元する(旧画面は無いと表示しない)。

## 「内田2」（無効な注文者）の扱い
方針: 不要なテスト登録のため、移行時に削除対象とする（`--remove-inactive 施設ID/注文者ID`）。
**ただし最新の dry-run（読み取りのみ）では、`active=false` の注文者は存在しない。**
`tachikawa-hospital/tOg4OhoJV7CfYTmh3He9`（メール uchidats@senju-eye-clinic.jp）は名前が「敦郎」・`active=true` に変わっており、削除対象にならない（スクリプトは `active=false` のものだけ削除し、`active=true` は削除しない）。
**決定: 「敦郎」は今回は削除せず残す**（active を外すだけ）。不要な担当医の整理は、移行後に施設設定から行う。

## 直近の dry-run 結果（読み取りのみ）
- orderers: 3件すべて `active=true` → active除去のみ（削除0）
- facilityDealers: 1件 `active=true` → active除去のみ
- members phase 1: 3件すべて `status=active`（disabled 0）→ phase 1 の処理は不要。施設 `fac-bafcbe…` に一般注文者(orderer) の所属が1件ある。
