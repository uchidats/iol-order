import { featureBadges } from "../domain/lens-labels.js";

/**
 * IOLの特徴(多焦点・トーリック)を示す、小さな楕円形のバッジ。情報表示専用(クリック操作なし)。
 * 判定は isToric / isMultifocal のみ。文言は textContent で入れる。
 * @returns {HTMLElement[]}
 */
export function lensBadgeElements(model) {
  return featureBadges(model).map((text) => {
    const el = document.createElement("span");
    el.className = "lens-badge";
    el.textContent = text;
    return el;
  });
}
