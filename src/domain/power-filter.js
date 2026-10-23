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
 * モデルの既定度数を選択肢文字列（例: "+20.0D"）で返す
 */
export function defaultPowerLabel(modelData) {
  const d = modelData.powerRange.default;
  if (d === undefined) return "+20.0D";
  return d > 0 ? `+${d.toFixed(1)}D` : `${d.toFixed(1)}D`.replace("-0.0D", "0D");
}
