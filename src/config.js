/**
 * アプリ設定
 *
 * 既定は "dryrun"（ネットワーク送信を一切行わない）。
 * 注文の受付はサーバー(Cloud Functions の createOrder)だけ。保存を試すには、リポジトリ管理外の
 * src/config.local.js で orderMode: "server-dev" を設定する（src/config.local.example.js を参照。config.local.js は .gitignore 済み）。
 * 旧経路(ブラウザから GAS へ直接送信する orderMode: "gas")は廃止した。指定されても dryrun で動作する。
 */

export const ORDER_MODES = Object.freeze({
  DRYRUN: "dryrun", // 送信しない。入力内容の確認のみ（開発既定）
  SERVER_DEV: "server-dev", // 開発用: Cloud Functions で検証して保存する(ディーラー通知なし)。src/config.local.js でのみ有効化できる
  SERVER: "server" // 本番: Cloud Functions で保存し、ディーラーへ注文メールを送る(誰が注文できるか・テスト注文かはサーバーが決める)
});

/**
 * 公開サイト(config.local.js がないとき)の注文モード。本番の受付を始めるときに SERVER にする(docs/order-mail.md)。
 * 画面の設定は表示と送信の可否だけで、受付の可否・対象のユーザー・メールの宛先はサーバー側の設定で決まる。
 */
export const SITE_ORDER_MODE = ORDER_MODES.DRYRUN;

export const STORAGE_KEY_EMAIL = "iol_order_saved_email";

/**
 * 設定値を検証して返す。server-dev・server 以外は siteMode(公開サイトの既定)に倒す。
 */
export function resolveConfig(overrides = {}, siteMode = SITE_ORDER_MODE) {
  if (overrides.orderMode === ORDER_MODES.SERVER_DEV || overrides.orderMode === ORDER_MODES.SERVER) return { orderMode: overrides.orderMode };
  if (overrides.orderMode === "gas") console.warn("orderMode=gas(ブラウザからGASへ直接送信)は廃止しました。dryrun で動作します。");
  return { orderMode: siteMode === ORDER_MODES.SERVER ? ORDER_MODES.SERVER : ORDER_MODES.DRYRUN };
}

/** サーバーへ注文を送るモード(開発用・本番) */
export const sendsOrders = (mode) => mode === ORDER_MODES.SERVER_DEV || mode === ORDER_MODES.SERVER;

/**
 * 既定設定 + （存在すれば）config.local.js を読み込む
 */
export async function loadConfig() {
  let overrides = {};
  try {
    const mod = await import("./config.local.js");
    overrides = mod.default || {};
  } catch (e) {
    // config.local.js が無い場合は既定（dryrun）
  }
  return resolveConfig(overrides);
}
