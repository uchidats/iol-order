# IOL Order — Claude Code 作業ルール

## 作業報告(docs/CLAUDE_REPORT.md)
ChatGPT など他のツールと GitHub 経由で状況を共有するため、**作業が完了したら `docs/CLAUDE_REPORT.md` を最新の1件分に書き換える**(履歴は貯めず上書き。履歴は `git log` で追う)。

- 記録項目: 日時 / 変更内容 / commit ID / テスト結果 / push状況 / Firebaseデプロイ状況 / 残課題 / 判断待ち事項。
- 簡潔にまとめる。Bash のログ・コマンド出力の貼り付けはしない。
- **記録しないもの**: 認証情報(トークン・鍵・パスワード)、患者情報、バックアップの中身、実データ(メールアドレス・個人名・施設の実データを含む)。バックアップは存在とファイル名の種類だけを書く。
- **報告のためだけの commit・push はしない。** 作業の最後の commit に、報告の更新を含める(commit ID は、その作業内の「本体のcommit」を書く。報告を含む最終commitは `git log -1` で分かるので書かない)。push 済みかどうかは、書いた時点の状態であり、確認は `git status -sb` で行う。
- 作業を中断・失敗した場合も、状況と判断待ち事項を同じ形式で記録する。

## 守ること(常に)
- 本番の Google Forms・GAS には触れない。実発注・メール送信は有効化しない(`ORDER_INTAKE_ENABLED=false` を維持)。公開サイトは dryrun のまま。
- Firebase は開発プロジェクト `medconf-iol-dev` のみ。本番環境は作らない。過大なIAM権限・サービスアカウントの秘密鍵を作らない。
- push・Firebase デプロイ・実データ変更は、指示があるときだけ行う。実データを変更するスクリプトは dry-run を既定とし、バックアップを取ってから実行する。
- 全テスト成功時のみ commit/push する(`npm test` ほか。Rules は `npm run test:rules`、Functions は `npm run test:functions` / `test:functions:e2e`、ブラウザ回帰は必要時に `npm run test:browser`)。
- `src/` や `styles.css` を変更したら `node scripts/stamp-assets.mjs` を実行する(index.html のバージョン付与。更新漏れはテストが検出する)。
- デプロイ・移行の手順は `docs/release-plan.md` に従う。
