/**
 * 確認済みの注文入力(画面の状態)から、サーバー(createOrder)へ送るリクエストを組み立てる。
 * 送るのは識別子と選択値のみ。表示名・注文者名・メール・施設名・価格などは送らない(サーバーがマスターから決める)。
 * 明細(lines)は複数可。各明細は 系列ID(modelId)・トーリック正式型番(toricModel)・度数・枚数・手術日・担当医ID(doctorId)。
 */
export function buildCreateOrderRequest(pending) {
  const req = {
    facilityId: pending.facilityId,
    requestId: pending.clientRequestId,
    lines: pending.lines.map(l => {
      // 担当医は明細ごとにIDだけを送る。実際の発注者(ログインしたアカウント)は送らない(サーバーが認証情報から記録する)
      const line = { modelId: l.modelId, power: l.power, quantity: Number(l.quantity), surgeryDate: l.surgeryDate, doctorId: l.doctorId };
      if (l.toricModel) line.toricModel = l.toricModel;
      // 確認画面に表示した発注先のIDを、1社の自動選択も含めて必ず送る(null = 発注先なしで確認した)。
      // 確認後に施設のディーラー設定が変わった場合、サーバーは別のディーラーに切り替えず拒否する。名前・メールは送らない
      line.dealerId = l.dealerId || null;
      return line;
    })
  };
  if (pending.notes) req.notes = pending.notes;
  return req;
}
