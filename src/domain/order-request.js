/**
 * 確認済みの注文入力(画面の状態)から、サーバー(createOrder)へ送るリクエストを組み立てる。
 * 送るのは識別子と選択値のみ。表示名・注文者名・メール・施設名・価格などは送らない(サーバーがマスターから決める)。
 * 明細(lines)は複数可。各明細は 系列ID(modelId)・トーリック正式型番(toricModel)・度数・枚数・手術日。
 */
export function buildCreateOrderRequest(pending) {
  const req = {
    facilityId: pending.facilityId,
    requestId: pending.clientRequestId,
    ordererId: pending.ordererId,
    lines: pending.lines.map(l => {
      const line = { modelId: l.modelId, power: l.power, quantity: Number(l.quantity), surgeryDate: l.surgeryDate };
      if (l.toricModel) line.toricModel = l.toricModel;
      return line;
    })
  };
  if (pending.notes) req.notes = pending.notes;
  return req;
}
