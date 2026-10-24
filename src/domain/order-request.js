/**
 * 確認済みの注文入力(画面の状態)から、サーバー(createOrder)へ送るリクエストを組み立てる。
 * 送るのは識別子と選択値のみ。表示名・注文者名・メール・価格などは送らない(サーバーがマスターから決める)。
 */
export function buildCreateOrderRequest(pending) {
  const quantity = parseInt(String(pending.quantity), 10); // "1 枚" → 1
  const req = {
    facilityId: pending.facilityId,
    requestId: pending.clientRequestId,
    modelId: pending.modelId,
    power: pending.power,
    quantity,
    surgeryDate: pending.surgeryDate,
    ordererId: pending.ordererId
  };
  if (pending.toricModel) req.toricModel = pending.toricModel;
  if (pending.notes) req.notes = pending.notes;
  return req;
}
