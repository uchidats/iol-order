/**
 * 注文の明細(複数のIOL)に関する純粋関数。
 * 1回の注文は複数の明細を持てる。明細ごとにモデル・度数・枚数・手術日を持ち、将来はディーラーごとに振り分ける。
 */
import { baseModelName } from "./lens-labels.js";

export const MAX_LINES = 20;          // サーバー(createOrder)の上限と同じ
export const MAX_TOTAL_QUANTITY = 40; // 同上

/** 明細の同一性(同じレンズ・型番・度数・手術日・担当医)。枚数は含めない */
export const lineKey = (l) => JSON.stringify([
  l.lens ? l.lens.key : (l.modelId ? `${l.modelId}|${l.toricModel || ""}` : ""), l.power, l.surgeryDate,
  l.doctor ? l.doctor.id : (l.doctorId || ""),   // 担当医が違えば、同じレンズ・度数・手術日でも別の明細
  l.dealer ? l.dealer.id : (l.dealerId || "")    // 発注先が違えば別の明細
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
    modelName: v.lens.isToric ? v.lens.toricModel : baseModelName(v.lens.model), // 画面表示用(モデル名だけ。メーカーは別に表示)
    isToric: v.lens.model.isToric, isMultifocal: v.lens.model.isMultifocal, // 画面表示用(バッジ)。サーバーには送らない
    power: v.power,
    quantity: v.quantity,
    surgeryDate: v.surgeryDate,
    // 担当医(明細ごと)。IDだけをサーバーへ送り、氏名・メールはサーバーがマスターから記録する(画面表示用にここで持つ)
    doctorId: v.doctor.id, doctor: v.doctor.name, doctorEmail: v.doctor.email || "",
    // 発注先(明細ごと)。IDだけをサーバーへ送り、名前・メールはサーバーが登録ディーラーから記録する(確認画面の表示用にここで持つ)。
    // 0社は発注先なし、1社は自動選択、2社以上は選択済み
    dealerSelected: Boolean(v.dealerExplicit && v.dealer), // 利用者が複数社から選んだときだけ、IDをサーバーへ送る
    dealerId: v.dealer ? v.dealer.id : "", dealerName: v.dealer ? v.dealer.name : "", dealerOrderEmails: v.dealer ? (v.dealer.orderEmails || []) : []
  }));
}

/**
 * 確認画面用: 明細を手術日ごとにまとめる(表示のみ。注文データの並び順・送信・保存には使わない)。
 * グループは手術日の早い順。同じ手術日の中は入力順を維持する。各明細の lineNo(元のレンズ番号)は変えない。
 * @returns {Array<{surgeryDate:string, lines:Array<object>}>}
 */
export function groupLinesBySurgeryDate(lines) {
  const groups = new Map();
  for (const l of lines) {
    if (!groups.has(l.surgeryDate)) groups.set(l.surgeryDate, []);
    groups.get(l.surgeryDate).push(l);      // Map と配列は挿入順 = 入力順
  }
  return [...groups.keys()].sort().map(surgeryDate => ({ surgeryDate, lines: groups.get(surgeryDate) })); // YYYY-MM-DD は文字列順 = 日付順
}

/**
 * 確認画面用: 「手術日 + 担当医」ごとにまとめる(表示のみ。注文データの並び順・送信・保存には使わない)。
 * 手術日の早い順(既存の groupLinesBySurgeryDate を再利用)。同じ手術日の中は、担当医グループの初出順。同じ手術日でも担当医が違えば別グループ。
 * 担当医の同一性は doctorId(なければ氏名)。各明細の lineNo(元のレンズ番号)・入力順は変えない。
 * @returns {Array<{surgeryDate:string, doctor:string, lines:Array<object>}>}
 */
export function groupLinesByDateAndDoctor(lines) {
  return groupLinesBySurgeryDate(lines).flatMap(day => {
    const byDoctor = new Map();
    for (const l of day.lines) {
      const key = l.doctorId || l.doctor || "";
      if (!byDoctor.has(key)) byDoctor.set(key, { surgeryDate: day.surgeryDate, doctor: l.doctor || "", lines: [] });
      byDoctor.get(key).lines.push(l);
    }
    return [...byDoctor.values()];
  });
}
