/**
 * 注文の明細(複数のIOL)に関する純粋関数。
 * 1回の注文は複数の明細を持てる。明細ごとにモデル・度数・枚数・手術日を持ち、将来はディーラーごとに振り分ける。
 */
export const MAX_LINES = 20;          // サーバー(createOrder)の上限と同じ
export const MAX_TOTAL_QUANTITY = 40; // 同上

/** 明細の同一性(同じレンズ・型番・度数・手術日)。枚数は含めない */
export const lineKey = (l) => JSON.stringify([
  l.lens ? l.lens.key : (l.modelId ? `${l.modelId}|${l.toricModel || ""}` : ""), l.power, l.surgeryDate
]);

/** 重複している明細の添字(2回目以降)を返す */
export function findDuplicateLines(lines) {
  const seen = new Set();
  const dup = [];
  lines.forEach((l, i) => {
    const k = lineKey(l);
    if (seen.has(k)) dup.push(i); else seen.add(k);
  });
  return dup;
}

export const totalQuantity = (lines) => lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0);

/**
 * 確認済みの明細を、注文内容(確認画面・送信用)の明細に変える。
 * 系列名(model)・系列ID(modelId)・メーカー・トーリック正式型番(toricModel)を、従来どおり別々に保持する。
 */
export function toOrderLines(values) {
  return values.map((v, i) => ({
    lineNo: i + 1,
    model: v.lens.model.displayName,
    modelId: v.lens.model.id,
    manufacturer: v.lens.manufacturer,
    toricModel: v.lens.isToric ? v.lens.toricModel : "",
    label: v.lens.label, // 画面表示用(メーカー / 型番)
    power: v.power,
    quantity: v.quantity,
    surgeryDate: v.surgeryDate
  }));
}
