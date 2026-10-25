# App Check(reCAPTCHA Enterprise)の導入手順

現状: **未導入**。画面のコード(`src/firebase/app-check.js`)は用意済みで、サイトキー `APP_CHECK_SITE_KEY` が空の間は何もしない。
Functions は `enforceAppCheck: false`(強制しない)。

## 1. 監視モードで導入する(強制しない)
1. Google Cloud(`medconf-iol-dev`)で reCAPTCHA Enterprise API を有効にし、ウェブサイト用のキーを作る。ドメインは `iol.medconf.jp`(公開サイト)と開発用の `localhost`。チェックボックスなし(スコアベース)。
2. Firebase Console → App Check → Web アプリに reCAPTCHA Enterprise を登録し、上のサイトキーを設定する。**Firestore・Functions・Authentication の「適用(Enforce)」は押さない。**
3. `src/firebase/app-check.js` の `APP_CHECK_SITE_KEY` にサイトキー(公開前提の値)を設定し、`node scripts/stamp-assets.mjs` → テスト → push。
4. ローカル開発(localhost)では、ブラウザのコンソールに出るデバッグトークンを Firebase Console の App Check に登録する。
5. 確認: ログイン(Google・メールリンク)、施設の選択、注文履歴、施設設定の保存、利用者管理、(受付を有効にした開発環境での)注文が、これまでどおり動く。App Check の「指標」で、正規のリクエストの割合(verified)が十分高いことを数日確認する。

## 2. 強制への切り替え(まだ行わない)
- 指標で未検証のリクエストがほぼ無いことを確認してから、Firestore → Functions の順に適用する。Functions は `functions/index.js` の `enforceAppCheck` を `true` にしてデプロイする。
- 切り替え前に、管理スクリプト(Admin SDK)は App Check の対象外であることを確認する(影響なし)。

## 注意
- reCAPTCHA Enterprise は Google のスクリプトを読み込む(サイトキー設定後)。
- App Check はアクセス制御の代わりではない。権限は従来どおり Rules と Functions で検証する。
