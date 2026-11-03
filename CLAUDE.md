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
- 原稿の正式な管理元は `docs/manual/` の Markdown(README.md = 目次、01 初めて利用する方 / 02 注文者・代行入力者 / 03 副管理者・施設管理者)。画面はその内容を表示する(`src/manual/manual-pages.js` は `scripts/build-manual.mjs` の自動生成。直接編集しない。原稿との不一致は `tests/manual.test.js` が検出する)。
- **機能・操作画面・表示の文言を変更したら、同じ作業で関連するマニュアルも更新する**(該当する役割のページ・目次)。更新後は `node scripts/stamp-assets.mjs` を実行し、`tests/manual.test.js`・`tests/asset-stamp.test.js` と、`tests/browser/manual.pw.mjs` の変更に関連するケースで表示・リンクを確認する。マニュアルの更新だけを理由に、全単体テスト・マニュアルのブラウザテスト全体は実行しない。
- 未実装・未公開の機能を利用できるものとして書かない。運営者(platformAdmin)専用の内部操作の手順は、通常利用者向けのマニュアルに詳しく載せない。
- 表示するページはログイン状態と施設内の役割で分ける(`src/domain/manual-access.js`。未ログイン: 目次・1 / 注文者・代行入力者: 〜2 / 副管理者・管理者・運営者: 〜3。統合前の旧ページの URL は `src/ui/manual-view.js` の `MANUAL_PAGE_ALIASES` で統合先へ)。画面の整理のためで、権限・Rules とは別。ページを追加したら範囲も決める。
- 3 では、施設管理者のみが操作できる項目に `{*}`(画面では赤い *)を付け、末尾に「{*} 施設管理者のみ操作できます。」と書く。
- 当面、マニュアルにはサービス名「IOL Order」とサイトの URL を載せない(「本システム」などと書く。テストが検出する)。
- `docs/introduction/` はマニュアルの作業では変更しない。
- **ディーラー画面(`dealer.html`)の「使い方・ヘルプ」は別の原稿 `docs/dealer-manual/`**(README.md = 目次、01 ログインと本人確認 / 02 受注一覧 / 03 ディーラー設定 / 04 よくある質問)。医療機関用に依存させず、ディーラーの利用者目線で書く(共通の操作は同じ説明文でよい)。`src/manual/dealer-manual-pages.js` は同じ `scripts/build-manual.mjs` の自動生成(`tests/dealer-manual.test.js` が一致を確認)。表示の部品(`src/ui/manual-view.js`)は共通。担当者は全員、全ページを読める。会社管理者のみの項目に `{*}` を付け、03 の末尾に「{*} 会社管理者のみ操作できます。」。ディーラー画面の機能・文言を変えたら同じ作業で更新し、上と同じ方針(未実装の機能・「IOL Order」・URL・運営者専用の操作は書かない)に従う。

## 紹介ページ「IOL Orderについて」(当面は運営者 platformAdmin だけ)
- 原稿の正式な管理元は `docs/introduction/service-introduction-web.md`(元原稿 `service-introduction.md` は変更しない)。**git に入れない**(公開サイトはリポジトリのファイルをそのまま配信するため、入れると誰でも読める)。
- 画面は Firestore `platformContent/serviceIntroduction` の本文を表示する。Rules で platformAdmin だけが読める(メニューの非表示だけに頼らない)。原稿を変えたら `node scripts/publish-introduction.mjs`(確認のみ)→ `--apply`(登録。既存の内容を `backups/` に保存してから上書き)。
- 一般公開は運営者の承認後だけ: `firestore.rules` の `introductionPublic()` と `src/domain/service-introduction.js` の `INTRODUCTION_PUBLIC_RELEASE` を両方 true にし、メニューの表示範囲も見直す。
- 内容は現行の実装と照合し、未実装の機能を実装済みとして書かない。
- デプロイ・移行の手順は `docs/release-plan.md` に従う。

## ディーラー専用画面(docs/dealer-portal.md)
- 閲覧は「会社の担当者として有効 × 施設の管理者・副管理者の明示的な許可 × 自社宛ての明細」だけ。元の注文ドキュメントをディーラーへ渡さず、返す項目を列挙して組み立てる(共通備考・入力者・他社の情報は返さない)。担当施設は表示用で、権限の判定に使わない。
- ディーラーの担当者を施設の `members` に入れない。新しい領域(`dealerCompanies` など)は Rules でクライアントの読み書きを拒否したまま、サーバーだけで扱う。
- 機能スイッチ `DEALER_PORTAL_ENABLED` は注文受付・メールのスイッチと別。ポータルの処理(索引のトリガー)を注文の受付・メール送信の処理に組み込まない。
- 入口の `dealer.html` も `node scripts/stamp-assets.mjs` の対象。

## テスト範囲(原則: 変更箇所とその影響範囲に絞る)
- **原則**: 変更箇所に関連するテストを、変更範囲とリスクに応じて必要最小限のファイル・ケースに絞って実行する。既存機能の維持と安全性を優先し、影響範囲を判断できないときは範囲を広げる。
- **軽微なUI・CSS・文言の修正**(ボタン位置・余白・色・文言など): 変更箇所のブラウザでの確認と、関連するテストだけ(関連する単体テスト・ブラウザテストのファイル単体。必要なら `--test-name-pattern` でケースを絞る)。全単体テスト(`npm test`)・全ブラウザテストは実行しない。ただし、更新漏れを検出するテストは省略しない(`src/`・`styles.css`・`docs/manual/` を変更したら `tests/asset-stamp.test.js`、`docs/manual/` を変更したら `tests/manual.test.js` も)。確認後、速やかに commit・push して本番へ反映する。
- **通常の機能追加・修正**: 関連する単体テストとブラウザテスト(該当のファイル・テスト名で絞る)。
- **Functions・権限管理(認証・Rules)の変更、注文送信・メール送信・共通処理に影響する変更**: 関連する Functions・Rules・E2E のテストを優先し、影響範囲に応じて検証を広げる(該当のテストファイル。注文処理・メール送信に影響する場合はその関連も)。軽微な修正の扱いにしない。
- **全テスト**(`npm run test:browser` 全体・`test:functions` 全体など): 広範囲の変更、重大な不具合、リリース前の総合確認など、必要性が明確な場合だけ。毎回は実行しない。実行中に変更と無関係な長時間のテストと分かれば止めてよい。
- **報告**: 実行したテストと結果を簡潔に伝える。テスト範囲を絞った・省略した場合はその旨を、省略した検証や未確認の事項が安全性に関係する場合はその点も、作業報告と回答で簡潔に伝える。
