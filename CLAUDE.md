# IOL Order — Claude Code 作業ルール

## 開発計画・アイデアの共通管理

- 作業開始時に `git status` と `docs/ROADMAP.md`・`docs/IDEAS.md` を確認し、他のAIの変更を上書きしない。
- 実装が決まった項目は `docs/ROADMAP.md` で優先順位・進捗・担当AIを管理し、作業後に更新する。実装済み・テスト済み・本番公開済みを区別し、確認日・根拠・残作業を記録する。今回実施していない確認を完了扱いにしない。
- 未確定のアイデア・将来構想・保留事項は `docs/IDEAS.md` に記録し、採用・検討中・保留・見送りとその根拠を残す。採用決定後にROADMAPへ反映する。
- 採否・仕様・優先順位・担当の最終決定はユーザーが行う。AIの提案だけで採用済みにせず、計画への記載だけで実装・本番公開の許可としない。ユーザーが指定した作業範囲を優先する。

## 作業報告(docs/CLAUDE_REPORT.md)
ChatGPT など他のツールと GitHub 経由で状況を共有するため、**作業が完了したら `docs/CLAUDE_REPORT.md` を最新の1件分に書き換える**(履歴は貯めず上書き。履歴は `git log` で追う)。

- 記録項目: 日時 / 変更内容 / commit ID / テスト結果 / push状況 / Firebaseデプロイ状況 / 残課題 / 判断待ち事項。
- 簡潔にまとめる。Bash のログ・コマンド出力の貼り付けはしない。
- **記録しないもの**: 認証情報(トークン・鍵・パスワード)、患者情報、バックアップの中身、実データ(メールアドレス・個人名・施設の実データを含む)。バックアップは存在とファイル名の種類だけを書く。
- **報告のためだけの commit・push はしない。** 作業の最後の commit に、報告の更新を含める(commit ID は、その作業内の「本体のcommit」を書く。報告を含む最終commitは `git log -1` で分かるので書かない)。push 済みかどうかは、書いた時点の状態であり、確認は `git status -sb` で行う。
- 作業を中断・失敗した場合も、状況と判断待ち事項を同じ形式で記録する。
- Claude Codeの回答、進捗報告、作業完了報告は原則として日本語で行ってください。コード、API名、コマンド、識別子は英語のままで構いません。

## 守ること(常に)
- **本番運用中**(2026-10-26 開始): 公開サイト(https://iol.medconf.jp/、`SITE_ORDER_MODE=server`)から、許可した施設・利用者(`ORDER_TEST_FACILITY_IDS`・`ORDER_TEST_UIDS`、`ORDER_INTAKE_UNRESTRICTED=false`)だけが注文でき、注文メールは実際のディーラーへ送られる(`ORDER_INTAKE_ENABLED=true`・`ORDER_TEST_MODE=false`・`MAIL_SENDING_ENABLED=true`・`MAIL_TEST_ONLY=false`)。ほかの医師は従来の Google フォームを使う。
- 注文受付・メール送信の安全設定(上記の値・許可リスト)は、指示があるときだけ変更する。実際の注文・メール送信・施設登録の申請と承認は、利用者の確認なしに行わない(テストは偽の配信サービス・エミュレータで行う)。
- 本番の Google Forms・GAS には触れない。
- 新しい施設の登録は運営者の承認制(`docs/facility-applications.md`)。承認権限は platformAdmin の運営者のみ。権限(カスタムクレーム)を勝手に付与しない。
- Firebase は `medconf-iol-dev`(本番運用中のプロジェクト)のみ。別の環境は作らない。過大なIAM権限・サービスアカウントの秘密鍵を作らない。
- push・Firebase デプロイ・実データ変更は、指示があるときだけ行う。実データを変更するスクリプトは dry-run を既定とし、バックアップを取ってから実行する。
- 実施したテストがすべて成功したときだけ commit/push する。テストの範囲は下の「テスト範囲」に従う。
- `src/`・`styles.css`・`docs/manual/` を変更したら `node scripts/stamp-assets.mjs` を実行する(マニュアルの表示データの作成と index.html のバージョン付与。更新漏れはテストが検出する)。

## オンラインマニュアル(画面の「使い方・ヘルプ」)
- 原稿の正式な管理元は `docs/manual/` の Markdown(README.md = 目次、01〜04 = 各ページ)。画面はその内容を表示する(`src/manual/manual-pages.js` は `scripts/build-manual.mjs` の自動生成。直接編集しない。原稿との不一致は `tests/manual.test.js` が検出する)。
- **機能・操作画面・表示の文言を変更したら、同じ作業で関連するマニュアルも更新する**(該当する役割のページ・目次)。更新後は `node scripts/stamp-assets.mjs` を実行し、`npm test` と `tests/browser/manual.pw.mjs` で表示・リンクを確認する。
- 未実装・未公開の機能を利用できるものとして書かない。運営者(platformAdmin)専用の内部操作の手順は、通常利用者向けのマニュアルに詳しく載せない。
- `docs/introduction/`(サービス紹介。Codex 作成)は別の成果物。マニュアルの作業では変更しない。
- デプロイ・移行の手順は `docs/release-plan.md` に従う。

## テスト範囲(変更内容に応じて調整する)
- **軽微なUI/CSS変更**(ボタン位置・余白・色・文言など): 関連箇所の確認だけでよい(`npm test`、変更箇所のブラウザでの確認、関連するブラウザテストのファイル単体)。Functions・Rules・全ブラウザE2E(`npm run test:browser` 全体)は毎回は実行しない。確認後、速やかに commit・push して本番へ反映する。
- **注文処理・メール送信・認証・権限などに影響する変更**: 従来どおり十分にテストする(`npm test`、`npm run test:rules`、`npm run test:functions` / `test:functions:e2e`、`npm run test:browser`)。
- テスト範囲を省略した場合は、その旨を作業報告と回答で簡潔に伝える。
