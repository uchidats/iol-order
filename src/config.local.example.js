// このファイルを src/config.local.js にコピーして使用する（config.local.js はGit管理外）。
// 開発用のサーバー受付(Cloud Functions の createOrder。ディーラー通知なし)で保存を試すときだけ設定する。
export default {
  orderMode: "server-dev" // "dryrun" | "server-dev"
};
