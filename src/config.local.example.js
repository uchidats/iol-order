// このファイルを src/config.local.js にコピーして使用する（config.local.js はGit管理外）。
// 接続先と処理仕様を確認済みの「開発用」GASのURLのみを設定すること。
export default {
  orderMode: "gas", // "dryrun" | "gas"
  orderApiUrl: "https://script.google.com/macros/s/<開発用デプロイID>/exec"
};
