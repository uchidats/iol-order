/**
 * 施設ごとの「IOLモデルの表示順」(メーカーの順番 + メーカー内のモデルの順番)。
 *
 * - 保存: facilities/{fid}/displaySettings/iolOrder = { makerOrder: [メーカー名...], modelOrder: [系列ID...], updatedAt }
 * - 未設定の施設は、共通IOLマスターの標準の順番のまま。
 * - 後から追加されたメーカー・モデル(保存された順番に含まれないもの)は、既存の順番を崩さず、それぞれの末尾に標準の順番で並ぶ。
 * - 保存された順番に残っていても、マスターに無いIDは無視する(採用状態・注文内容には影響しない。順番だけの設定)。
 * 純粋関数。
 */

const asList = (v) => (Array.isArray(v) ? v.filter(x => typeof x === "string") : []);

/** 保存された順番にしたがって並べ替えたメーカー名の一覧(マスターに存在するメーカーだけ) */
export function orderedMakers(models, setting) {
  const standard = [...new Set(models.map(m => m.manufacturer))];
  const saved = asList(setting && setting.makerOrder).filter(n => standard.includes(n));
  const seen = new Set(saved);
  return [...saved, ...standard.filter(n => !seen.has(n))];
}

/** メーカー内のモデル(系列)を、保存された順番にしたがって並べ替える。未保存のモデルは末尾(標準の順) */
export function orderedModelsOf(models, maker, setting) {
  const inMaker = models.filter(m => m.manufacturer === maker);
  const rank = new Map(asList(setting && setting.modelOrder).map((id, i) => [id, i]));
  const saved = inMaker.filter(m => rank.has(m.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
  return [...saved, ...inMaker.filter(m => !rank.has(m.id))];
}

/** 施設の表示順を適用した、モデル(系列)の一覧。メーカーごとにまとめ、メーカー → モデルの順 */
export function applyIolOrder(models, setting) {
  return orderedMakers(models, setting).flatMap(maker => orderedModelsOf(models, maker, setting));
}

/** 画面の並び(メーカー名の配列・系列IDの配列)から、保存する内容を作る。マスターに無いものは入れない */
export function buildIolOrderSetting(models, makerOrder, modelOrder) {
  const makers = new Set(models.map(m => m.manufacturer));
  const ids = new Set(models.map(m => m.id));
  return {
    makerOrder: [...new Set(makerOrder)].filter(n => makers.has(n)),
    modelOrder: [...new Set(modelOrder)].filter(id => ids.has(id))
  };
}

/** 配列の要素を1つ上(-1)/下(+1)へ。範囲外は何もしない(新しい配列を返す) */
export function moveItem(list, index, delta) {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  [out[index], out[to]] = [out[to], out[index]];
  return out;
}
