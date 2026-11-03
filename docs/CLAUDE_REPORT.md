# Claude Code 作業報告(最新)

> このファイルは作業完了ごとに上書きする最新1件。記録のルールは `CLAUDE.md`。実データ・認証情報・バックアップの中身は書かない。

- **日時**: 2026-11-04
- **作業**: `.gitignore` と `CLAUDE.md` のテスト方針の更新(コードの変更なし)。NP-T の度数下限の調査(報告のみ)。
- `.gitignore`: `docs/introduction/` を追加(紹介ページの原稿を誤って commit しないため)。`docs/design`・`docs/reviews`・`docs/research` は対象外で、GitHub へは追加していない。
- `CLAUDE.md`: Codex 作業フォルダ `mobile-updates` のテスト方針から「関連テストを必要最小限に絞る」内容を反映。軽微な修正では `npm test` 全体を実行しない。ただし更新漏れを検出するテスト(`tests/asset-stamp.test.js`・`tests/manual.test.js`)は省略しない。
- 既存の規則は維持: テスト成功時だけ commit/push、Functions・権限の変更の関連テスト、全テストを実行する場面、本番の安全設定。`mobile-updates` の「重要な変更でも全テストを機械的に必須としない」という文は採用しなかった(同じ趣旨は既存の「全テスト」の項目にある)。
- 既存の作業フォルダ・stash は変更していない(作業は一時的な clone で実施)。`docs/drafts`・`scratch`・worktree は削除していない。

## commit ID
- 本体: 本ファイルを含む commit(`git log -1`)。

## テスト結果
- `.gitignore`: `git check-ignore` で `docs/introduction/` 以下が対象になり、`docs/reviews`・`docs/manual`・`docs/dealer-portal.md` は対象にならないことを確認。
- unit: `tests/asset-stamp.test.js`・`tests/manual.test.js` 成功。
- 未実行(コードの変更なし): `npm test` 全体・ブラウザ・Functions・Rules。

## push・公開
- main へ push。Functions・Rules のデプロイはなし。

## NP-T の調査結果(変更なし)
- main は NP-T3〜T7 に同じ度数の候補を使っており、画面とサーバーの両方で、メーカーの製造範囲にない NP-T4〜T6 の +1.0D、NP-T7 の +1.0D・+2.0D を受け付ける。
- ニデックの現行の製品ページの仕様画像と 2024年1月の発売案内はいずれも、下限を T3 +1.0D、T4〜T6 +2.0D、T7 +3.0D としている。ブランチ `fix/np-t-power-limits` の値と一致する。
- 第三者の製品仕様表(2025年3月更新)は「T5-T7: 3.0D から」としており、T5・T6 の下限だけ公式資料と異なる。メーカーへの確認が必要。
- ブランチは main へ自動で統合できないファイルが3件(`docs/CLAUDE_REPORT.md`・`docs/ROADMAP.md`・`index.html`)ある。コードの統合に衝突はなく、一時的な統合で関連する単体テスト 30 件は成功。Functions・ブラウザのテストは未実行。stash のコードの変更はブランチのコミットと同一。

## 判断待ち事項
- NP-T の下限の取り込み(メーカーへの T5・T6 の確認、main への統合、Functions のデプロイ)。
- 実機検証の結果の共有(Galaxy S24 Ultra → iPhone)と、それによる R09 の圧縮条件・15MB の上限・鮮鋭度のしきい値の確定。
- R09 第1段階の着手(バケットと IAM の付与の承認・実施方法、有効にする施設とコードの運用)。
- E2E の2件の環境の問題(エミュレータ用の秘密情報のダミー値)を直すか(前回から継続)。
- 使わなくなった降順用の複合インデックス(`orderSurgeryIndex`)を削除するか(前回から継続)。
- 実行サービスアカウントの `roles/firebaseauth.viewer` を外すか(前回から継続)。

## 残課題
- 本体フォルダ(`feature/dealer-portal`)は今回の `.gitignore` を含まないため、main に切り替えるまでは `docs/introduction/` が未追跡のまま表示される。
- サブテーマカラー(施設・ディーラー)の実機での目視確認(運営者の端末で)。
- 共通連番での最初の実注文の後に `node scripts/admin/check-order-numbers.mjs` を実行して確認する(前回から継続)。
- ディーラーのログインを伴う実画面での確認(運営者の端末で。出力を含む)。
