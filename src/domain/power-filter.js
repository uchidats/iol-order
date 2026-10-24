import { GOOGLE_FORM_ALL_POWERS } from "../data/iol-models.js";

/**
 * モデルの許容度数範囲・ステップに合致する度数のみを返す
 */
export function filterPowersByModel(modelData, allPowers = GOOGLE_FORM_ALL_POWERS) {
  const pr = modelData.powerRange;
  if (!pr) return allPowers;

  return allPowers.filter(str => {
    let num = parseFloat(str.replace("D", ""));
    if (isNaN(num)) return false;

    if (num < pr.min || num > pr.max) return false;

    if (pr.customSegments) {
      for (const seg of pr.customSegments) {
        if (num >= seg.min && num <= seg.max) {
          const rem = Math.abs(num - seg.min) % seg.step;
          return rem < 0.001 || Math.abs(rem - seg.step) < 0.001;
        }
      }
      return false;
    }

    const rem = Math.abs(num - pr.min) % pr.step;
    return rem < 0.001 || Math.abs(rem - pr.step) < 0.001;
  });
}

/**
 * モデル(または絞り込み)を変えたとき、変更前の度数を維持できるか。変更後の度数の選択肢にあれば維持し、なければ未選択("")。
 * 変更前が未選択なら未選択のまま。比較は選択肢と同じ数値の読み方(filterPowersByModel と同じ parseFloat)で行うため、"+20.0D" と "+20D" のような表記の違いも同じ度数として扱う。
 * @returns {string} 変更後の選択肢の中の値(維持する度数)。維持できなければ ""
 */
export function keepPowerIfAvailable(prev, powers) {
  if (!prev) return "";
  if (powers.includes(prev)) return prev;
  const n = parseFloat(String(prev).replace("D", ""));
  if (Number.isNaN(n)) return "";
  return powers.find(p => Math.abs(parseFloat(p.replace("D", "")) - n) < 0.001) || "";
}

/**
 * モデルの既定度数を選択肢文字列（例: "+20.0D"）で返す
 */
export function defaultPowerLabel(modelData) {
  const d = modelData.powerRange.default;
  if (d === undefined) return "+20.0D";
  return d > 0 ? `+${d.toFixed(1)}D` : `${d.toFixed(1)}D`.replace("-0.0D", "0D");
}
