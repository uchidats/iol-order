# Claude Code 作業報告(最新)

> このファイルは作業完了ごとに上書きする最新1件。記録のルールは `CLAUDE.md`。実データ・認証情報・バックアップの中身は書かない。

- **日時**: 2026-10-28
- **作業**: ディーラー専用画面(ポータル本体+Googleログイン)と最新 `main` の検証用統合。検証専用ブランチ `verify/dealer-portal-main`(`origin/main` 2f48918 に `origin/feature/dealer-google-login` 07f3d2f を統合)。
- **本番への反映はしていない**: `main` へのマージ、デプロイ、Firebase の設定変更、機能の有効化は未実施。既存の `main`・feature ブランチ・Codex がレビュー中の commit は変更していない。他AIの未追跡資料・NP-T・stash には触れていない(清潔な作業ツリーで作業)。

## 統合の内容
- 競合は2ファイルだけ: `index.html`(import map・CSS のバージョン付与の行だけ。競合箇所だけをフィーチャー側で解消し、`main` 側の確認画面の変更はそのまま。最後に `stamp-assets` で作り直し)、`docs/CLAUDE_REPORT.md`(本ファイルを統合の内容で作成)。
- 自動統合: `src/ui/facility-settings.js`(採用IOLの既定ディーラーと、ディーラー画面での閲覧の両方を含むことを確認)、`styles.css`、ROADMAP など。Rules・Functions は `main` 側に変更がなく、フィーチャー側のまま。
- 追加テスト(この検証ブランチだけ): 閲覧を許可中も採用IOLの既定ディーラーを Rules を通して保存できる、発注先の名称・削除はロック、既定ディーラー宛ての明細はその会社にだけ公開(2社混在)、取消の後は発注先を削除できる。

## commit ID
- 本体: 本ファイルを含む commit(`git log -1`。統合の commit)。

## テスト結果
- unit 264(成功 263・skip 1)、Rules 65、Functions 204(共存の新規1を含む)、Functions E2E 13 すべて成功。
- ブラウザ(ディーラー画面・施設設定・運営者・既定ディーラー・折りたたみ・確認画面・発注先・下書き・度数・重複警告・設定・注文履歴・再送・本人の担当医・マニュアル・紹介)125 中 124 成功。失敗の1件は WebKit の手術日のテスト(再送の画面)で、統合で変わっていないファイルのテスト。`origin/main` 単独でも3回中1回失敗する既存の不安定さ。
- 全ブラウザテスト(`npm run test:browser` 全体)は未実行。

## 判断待ち事項
- 本番への反映の方針(この統合結果を基に、Rules → Functions(停止のまま)→ 画面 の順で行うか)。有効化の前の本番の Firebase 設定と実アカウントでの確認。

## 残課題
- Codex のレビューの継続。他AIの `docs/manual/dealer.md` の扱い。
