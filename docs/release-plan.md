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

## 反映の順序
0. 事前: 全テスト成功（unit / Rules / Functions / E2E）と、下記の dry-run を再確認する。
1. **member phase 1**（dry-run → 実行）。無効な所属を処理してから新Rulesへ（新Rulesは `status` を見ないため）。
2. **Cloud Functions をデプロイ**（`createOrder`・`removeMember`。受付は無効のまま）。
3. **Security Rules をデプロイ** → 続けて **push（画面）**。数分以内に続けて行う。
4. **移行**: orderers → facilityDealers → member phase 2（それぞれ dry-run → 実行。バックアップ・`--confirm medconf-iol-dev` 必須）。
5. 確認: 施設切替・担当医選択・注文確認画面・設定（担当医/ディーラー/利用者/採用IOLの↑↓）。

**移行を画面・Rules・Functionsより先にしてはいけない**（旧画面は `active` / `status` が無いと表示・アクセスしない）。
ロールバック: 各バックアップJSONから戻し、Functions・Rules・画面は前のコミットへ戻して再デプロイ。

## 「内田2」（無効な注文者）の扱い
方針: 不要なテスト登録のため、移行時に削除対象とする（`--remove-inactive 施設ID/注文者ID`）。
**ただし最新の dry-run（読み取りのみ）では、`active=false` の注文者は存在しない。**
`tachikawa-hospital/tOg4OhoJV7CfYTmh3He9`（メール uchidats@senju-eye-clinic.jp）は名前が「敦郎」・`active=true` に変わっており、削除対象にならない（スクリプトは `active=false` のものだけ削除し、`active=true` は削除しない）。
この「敦郎」を不要として削除する場合は、別途ご指示のうえ、施設設定の「削除」で行う（移行スクリプトでは行わない）。

## 直近の dry-run 結果（読み取りのみ）
- orderers: 3件すべて `active=true` → active除去のみ（削除0）
- facilityDealers: 1件 `active=true` → active除去のみ
- members phase 1: 3件すべて `status=active`（disabled 0）→ phase 1 の処理は不要。施設 `fac-bafcbe…` に一般注文者(orderer) の所属が1件ある。
