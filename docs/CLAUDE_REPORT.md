# Claude Code 作業報告(最新)

> このファイルは作業完了ごとに上書きする最新1件。記録のルールは `CLAUDE.md`。実データ・認証情報・バックアップの中身は書かない。

- **日時**: 2026-10-28
- **作業**: 採用IOLごとの既定ディーラー(ROADMAP R14)。ブランチ `feature/default-dealer`(最新の `origin/main` 734d503 から作成)。設計の参考は `docs/research/default-dealer-design.md`(他AI。変更していない)。
- **本番への反映はしていない**: `main` への取り込み・push・デプロイ・Firebase の変更は未実施(ユーザーの確認待ち)。
- Firestore Rules・Functions・注文の保存内容・注文履歴・メール送信は変更なし(既存の `adoptedIols.dealerId` と、注文時のサーバーの発注先照合をそのまま使う)。`feature/dealer-portal`・`fix/np-t-power-limits`・stash・他AIの資料には触れていない(未追跡の `docs/manual/dealer.md` が混ざらないよう、清潔な作業ツリーで作業)。

## 変更内容
- `src/domain/facility-settings.js`: `planAdoptedWrites` に既定ディーラー(設定・変更・既定なし・登録に無いIDの除去)を追加。引数を省略した従来の呼び出しは同じ結果。
- `src/data/static-repository.js`: `resolveAdoptedModels` で採用IOLの `dealerId` を系列に付ける(マスターは変えない)。
- `src/domain/dealer-selection.js`: `defaultDealerIdOf`(登録にある既定ディーラーだけ返す)。
- `src/ui/facility-settings.js`・`styles.css`: 「採用IOL」の各モデルに既定の発注先の選択欄(ディーラー2社以上・採用中のときだけ。PC は右、スマホは名前の下)。変更で自動保存。ディーラーの保存・削除の後に選択肢を合わせ、削除したディーラーを既定にしていた採用IOLは既定なしにして保存。
- `src/ui/lens-lines.js`: IOLモデルを選んだときの自動選択。別の系列のモデルに変えると新しい既定を優先し、既定がなければ未選択。初めて選ぶときに既定がなければ今の発注先のまま。同じ系列の型番・度数・枚数・手術日では維持。1社は従来どおり。下書きの復元は保存された発注先を維持(登録に無いものは未選択)。
- オンラインマニュアル: 03(採用IOLの既定の発注先・ディーラーの登録数の説明)、02(発注先の自動選択)。
- 設計書との差異: 手動で選んだ発注先をモデル変更でも保護する設計案ではなく、ユーザー指定(モデル変更で新しい既定を優先・未設定なら未選択)に従った。

## commit ID
- 本体: 本ファイルを含む commit(`git log -1`。今回の作業は1 commit)。

## テスト結果
- unit 258(成功 257・skip 1)。追加: 既定ディーラーの解決(ノントーリック・トーリック各型番、削除済み・未設定)、採用IOLの書き込み計画(設定・変更・既定なし・削除済みの除去・未変更・従来の呼び出し)。
- Rules 64、注文の検証(Functions `orders.test.js`)56 すべて成功(Rules・Functions は無変更。登録に無い発注先の注文は既存テストで拒否を確認)。
- ブラウザ 65 すべて成功。新規 `default-dealer.pw.mjs`(3ブラウザ・スマートフォン/PC): 施設設定の表示条件・自動保存・既定なし・採用時・ディーラー削除・1社、注文画面のモデル変更・手動変更・度数等での維持・トーリックの絞り込み・同じ系列の型番・削除済みの既定・レンズの追加・下書き復元・ディーラー削除・1社。既存のレンズ・確認画面・設定のテストも成功。
- 全ブラウザテスト・Functions E2E は未実行(Functions・Rules は無変更)。

## 判断待ち事項
- `main` への取り込み・公開の可否と時期。
- モデル変更時の規則(新しいモデルに既定がなければ、手動で選んでいた発注先も未選択に戻す)で運用上よいか。

## 残課題
- ディーラー専用画面(`feature/dealer-portal`)の Codex 再々レビュー。NP-T の修正(`fix/np-t-power-limits`)の取り込み。他AIの `docs/manual/dealer.md` の扱い。
