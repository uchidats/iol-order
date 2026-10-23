import { ORDER_MODES } from "../config.js";

/**
 * 注文送信エラー
 * kind:
 *  - "dryrun"      : 開発モード。送信していない
 *  - "failed"      : 送信前に中止、またはサーバーが明示的にエラーを返した（注文は成立していない）
 *  - "unconfirmed" : 送信したが受付結果を確認できない（注文が成立している可能性がある）
 */
export class OrderError extends Error {
  constructor(kind, message, options = {}) {
    super(message);
    this.name = "OrderError";
    this.kind = kind;
    this.cause = options.cause;
  }
}

const REQUEST_TIMEOUT_MS = 30000;

/**
 * GASの応答を検証する。サーバーが発行した orderId を含む明確な成功応答のみ受理する。
 * ブラウザ側で注文番号を生成・補完することはしない。
 */
export function parseOrderResponse(data) {
  if (!data || typeof data !== "object") {
    throw new OrderError("unconfirmed", "サーバーの応答を解釈できませんでした");
  }

  if (data.success === false || data.status === "error") {
    throw new OrderError("failed", data.message || "サーバー側で注文を受け付けられませんでした");
  }

  const isSuccess = data.success === true || data.status === "success" || data.status === "ok";
  const orderId = typeof data.orderId === "string" ? data.orderId.trim() : "";

  if (!isSuccess || !orderId) {
    throw new OrderError("unconfirmed", "サーバーから受付番号が返却されませんでした");
  }

  return { orderId, message: data.message || "注文を受け付けました" };
}

/**
 * 注文を送信する
 * @param {object} payload
 * @param {{orderMode: string, orderApiUrl: string}} config
 * @param {typeof fetch} fetchImpl テスト用に差し替え可能
 */
export async function submitOrder(payload, config, fetchImpl = globalThis.fetch) {
  if (config.orderMode !== ORDER_MODES.GAS || !config.orderApiUrl) {
    throw new OrderError("dryrun", "開発モードのため送信していません");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    // CORSプリフライト回避のため text/plain で送信
    response = await fetchImpl(config.orderApiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (err) {
    // 送信後に応答を読めない場合（CORS・タイムアウト・切断）も、サーバー側で処理済みの可能性がある
    throw new OrderError("unconfirmed", "送信結果を確認できませんでした", { cause: err });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new OrderError("unconfirmed", `サーバーがエラーを返しました (HTTP ${response.status})`);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new OrderError("unconfirmed", "サーバーの応答を解釈できませんでした", { cause: err });
  }

  return parseOrderResponse(data);
}
