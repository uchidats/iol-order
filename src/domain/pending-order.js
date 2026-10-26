/**
 * 送信したが受付結果を確認できていない注文(requestId と送信内容)を端末(localStorage)に保存し、二重発注を防ぐ。
 *  - 送信の直前に保存し、受付の成功、またはサーバーが明確に拒否した(注文が作られていない)ときだけ削除する。
 *  - 次に確認画面へ進むとき、保存した注文の受付状況を、注文ドキュメント(ID = deriveOrderId)で照会する。
 *    受付済み → その注文を知らせる / 未登録で同じ内容 → 同じ requestId を再利用(サーバー側で冪等) /
 *    未登録で内容が違う → 破棄して新しい requestId / 照会できず内容が違う → 進ませない(結果の確認を求める)。
 *  - タイムアウト・確認画面を閉じる・再読み込みのあとも同じ requestId になる。別の端末・ブラウザからの再送は防げない。
 */

export const pendingOrderKey = (uid, facilityId) => `iol_order_pending:${uid}:${facilityId}`;

/** サーバー(functions/src/orders.js の deriveOrderId)と同じ注文ドキュメントID */
export async function deriveOrderId(uid, requestId, subtle = globalThis.crypto.subtle) {
  const buf = await subtle.digest("SHA-256", new TextEncoder().encode(`${uid}:${requestId}`));
  return "o" + [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// 重複の了承(duplicateAcknowledged)は注文の内容ではないので比べない(確認画面へ進む前の照会でも、同じ内容の再送として扱う)
const contentOf = (request) => { const { requestId, duplicateAcknowledged, ...rest } = request; return JSON.stringify(rest); };
/** requestId 以外の送信内容が同じか(送信内容は buildCreateOrderRequest が同じ順番で組み立てる) */
export const sameRequestContent = (a, b) => contentOf(a) === contentOf(b);

// サーバーが明確に拒否したエラー(注文は作られていない)。これ以外(通信断・タイムアウト・不明・already-exists)は結果未確定として扱う
const REJECTED_CODES = new Set(["invalid-argument", "permission-denied", "failed-precondition", "resource-exhausted", "unauthenticated"]);
export const isDefinitiveRejection = (err) => REJECTED_CODES.has(String((err && err.code) || "").replace(/^functions\//, ""));

/** 保存できない環境(プライベートモードなど)では save が false を返す。読み書きの失敗で画面を止めない */
export function createPendingOrderStore(storage, key) {
  return {
    load() {
      try {
        const v = JSON.parse(storage.getItem(key) || "null");
        return v && typeof v.requestId === "string" && v.request && v.request.requestId === v.requestId ? v : null;
      } catch { return null; }
    },
    save(request) {
      try { storage.setItem(key, JSON.stringify({ requestId: request.requestId, request, savedAt: Date.now() })); return true; } catch { return false; }
    },
    clear() { try { storage.removeItem(key); } catch { /* 保存できない環境 */ } }
  };
}

/**
 * これから確認する送信内容(request。新しい requestId 付き)に対して、保存済みの未確定の注文をどう扱うか決める。
 * @param {{requestId:string, request:object}|null} pending
 * @param {object} request
 * @param {(requestId:string) => Promise<object|null>} lookup 注文の照会(未登録は null。照会の失敗は例外)
 * @returns {Promise<{action:"new"}|{action:"reuse", requestId:string}|{action:"accepted", order:object, same:boolean}|{action:"unknown"}>}
 */
export async function reconcilePendingOrder(pending, request, lookup) {
  if (!pending) return { action: "new" };
  const same = sameRequestContent(pending.request, request);
  let order;
  try { order = await lookup(pending.requestId); } catch { return same ? { action: "reuse", requestId: pending.requestId } : { action: "unknown" }; }
  if (order) return { action: "accepted", order, same };
  return same ? { action: "reuse", requestId: pending.requestId } : { action: "new" };
}
