/**
 * レンズ選択肢の組み立て(純粋関数)
 * 共通IOLマスターの「系列」(採用IOLの単位)を、画面の選択肢(variant)に展開する。
 * - ノントーリック: 系列そのものが1つの選択肢。
 * - トーリック: 系列の toricModels(正式型番)ごとに1つの選択肢。型番はメーカーへ送る情報なので、必ず保持する。
 * 注文データは従来どおり、系列(modelId / model 表示名)と型番(toricModel)を別々に持つ。
 */

/**
 * @param {Array<object>} models 採用済みの系列(resolveAdoptedModels の結果)
 * @returns {Array<{key:string, label:string, manufacturer:string, model:object, toricModel:string, isToric:boolean, isMultifocal:boolean}>}
 */
export function buildLensOptions(models) {
  const out = [];
  for (const m of models) {
    if (typeof m.isMultifocal !== "boolean") continue; // 分類が無い系列は推測せず表示しない
    if (m.isToric) {
      for (const t of m.toricModels) {
        out.push({ key: `${m.id}|${t}`, label: `${m.manufacturer} / ${t}`, manufacturer: m.manufacturer, model: m, toricModel: t, isToric: true, isMultifocal: m.isMultifocal });
      }
    } else {
      out.push({ key: m.id, label: m.displayName, manufacturer: m.manufacturer, model: m, toricModel: "", isToric: false, isMultifocal: m.isMultifocal });
    }
  }
  return out;
}

/**
 * 「多焦点」「トーリック」のチェックで、メーカーを問わず絞り込む。
 * 両方OFF=単焦点かつノントーリックのみ / 片方ON=その条件に合うもの(もう片方は含まない) / 両方ON=多焦点かつトーリック
 */
export function filterLensOptions(options, { multifocal = false, toric = false } = {}) {
  return options.filter(o => o.isMultifocal === Boolean(multifocal) && o.isToric === Boolean(toric));
}

export function findLensOption(options, key) {
  return options.find(o => o.key === key) || null;
}
