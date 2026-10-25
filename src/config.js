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
  SERVER_DEV: "server-dev" // 開発用: Cloud Functions で検証して保存する(ディーラー通知なし)。src/config.local.js でのみ有効化できる
});

export const STORAGE_KEY_EMAIL = "iol_order_saved_email";

/**
 * 設定値を検証して返す。server-dev 以外はすべて dryrun に倒す。
 */
export function resolveConfig(overrides = {}) {
  if (overrides.orderMode === ORDER_MODES.SERVER_DEV) return { orderMode: ORDER_MODES.SERVER_DEV };
  if (overrides.orderMode === "gas") console.warn("orderMode=gas(ブラウザからGASへ直接送信)は廃止しました。dryrun で動作します。");
  return { orderMode: ORDER_MODES.DRYRUN };
}

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
