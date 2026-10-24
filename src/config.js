/**
 * アプリ設定
 *
 * 既定は "dryrun"（ネットワーク送信を一切行わない）。
 * 実際にGASへ送信するには、リポジトリ管理外の src/config.local.js で上書きする。
 * （src/config.local.example.js を参照。config.local.js は .gitignore 済み）
 */

export const ORDER_MODES = Object.freeze({
  DRYRUN: "dryrun", // 送信しない。入力内容の確認のみ（開発既定）
  GAS: "gas",       // GAS Webアプリへ実際にPOSTする【廃止予定】サーバー受付(createOrder)へ移行後に削除する
  SERVER_DEV: "server-dev" // 開発用: Cloud Functions で検証して保存する(ディーラー通知なし)。src/config.local.js でのみ有効化できる
});

const DEFAULT_CONFIG = Object.freeze({
  orderMode: ORDER_MODES.DRYRUN,
  orderApiUrl: ""
});

// GAS WebアプリURLとして許可する接頭辞（想定外の宛先への送信を防ぐ）
const ALLOWED_API_PREFIX = "https://script.google.com/macros/s/";

export const STORAGE_KEY_EMAIL = "iol_order_saved_email";

/**
 * 設定値を検証して返す。不正な組み合わせは dryrun に倒す。
 */
export function resolveConfig(overrides = {}) {
  const merged = { ...DEFAULT_CONFIG, ...overrides };

  if (merged.orderMode === ORDER_MODES.SERVER_DEV) {
    return { ...merged, orderApiUrl: "" }; // サーバー経由。GASのURLは使わない
  }

  if (merged.orderMode === ORDER_MODES.GAS) {
    console.warn("orderMode=gas(ブラウザからGASへ直接送信)は廃止予定です。サーバー受付(server-dev)へ移行してください。");
    const url = String(merged.orderApiUrl || "");
    if (!url.startsWith(ALLOWED_API_PREFIX)) {
      console.warn("orderApiUrl が未設定または許可されない形式のため、dryrun に切り替えました。");
      return { ...merged, orderMode: ORDER_MODES.DRYRUN, orderApiUrl: "" };
    }
    return merged;
  }

  return { ...merged, orderMode: ORDER_MODES.DRYRUN, orderApiUrl: "" };
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
