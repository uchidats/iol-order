/**
 * 過去の注文と一致するレンズの警告(重複したレンズだけを一覧表示。確認操作は1回)。表示のみ。
 * 見出し: 「過去の注文と一致するレンズが○件あります」。各レンズは2行: ①[レンズN]バッジ + IOLモデル + 度数 / ②過去の注文日。
 * バッジは通常の注文フォームと同じデザイン(.lens-no-badge)を再利用する。
 */
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

/**
 * @param {{title:HTMLElement, list:HTMLElement}} nodes 見出しと一覧の表示先
 * @param {Array<{lineNo:number, modelName:string, power:string, dates:string[]}>} duplicates findPastOrderDuplicates の結果
 */
export function renderDuplicateWarning({ title, list }, duplicates) {
  title.textContent = `過去の注文と一致するレンズが${duplicates.length}件あります`;
  list.replaceChildren(...duplicates.map(d => {
    const li = el("li", "dup-line");
    const main = el("div", "dup-line-main");
    main.append(el("span", "lens-no-badge", `レンズ${d.lineNo}`), el("span", "dup-model", d.modelName), el("span", "dup-power", d.power));   // モデルと度数の間に「／」は入れず、余白で区切る
    li.append(main, el("div", "dup-line-date", `過去の注文日：${d.dates.join("、")}`));
    return li;
  }));
}
