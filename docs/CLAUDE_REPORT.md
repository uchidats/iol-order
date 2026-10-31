# 作業報告 — R18 本番公開

- 日時: 2026-11-01（日本時間）。担当: Codex。ユーザーの明示指示により公開。
- 本体commit: 43bef06。取得した最新origin/main: f294abc（R18の基点と一致、追加差分・競合なし）。mainへの統合commitは本報告を含むcommit（git log -1で確認）。
- 統合範囲: R18の関連リンク管理・専用Rules・マニュアル・生成アセット・テスト・文書。既存の施設設定/注文/認証の判定は維持。Functions・注文受付/メールの設定は変更・再配備しない。
- 再検証: npm test 280成功・1スキップ、Rulesのrelated-links/firestore.rules/settings-actor 65成功、関連ブラウザrelated-links/ref-links 8成功（Edge/Firefox/WebKit、スマホ・PC、草稿・保存失敗/再試行・削除・表示・施設分離・離脱ガード）。全Functions/E2E・全Rules・全ブラウザは再実行していない。実装時の関連52ブラウザ検証は43bef06の報告を参照。
- 本番Rules: 配備前のアクティブRulesがorigin/mainと一致し、差分がrelatedLinks追加だけであることを確認。firebase deploy --only firestore:rules --project medconf-iol-devで先行配備に成功。配備後のアクティブRulesが43bef06と一致（ruleset 04f3f8dd-e4d4-4e37-83e7-a6cfa36e50c7）。既存のルールの変更・削除なし。Functions・索引は配備しない。
- Web: この統合commitをmainへpushして公開する。配信の一致はpush後にverify-deployedと変更した画面/JS/CSS/マニュアル本文の比較で確認し、作業完了の回答に結果とmain IDを報告する。
- 本番データ: 一括登録・移行・変更なし。実際の注文・メール送信なし。実アカウントでのリンクの追加/編集や実機確認も実施しない。
- 残る操作確認: 利用者によるログイン後の本番画面・実機での表示確認。
