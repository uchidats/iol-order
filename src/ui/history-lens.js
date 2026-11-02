/**
 * 一覧のレンズ表示の共通部品(医療機関側の注文履歴 order-history.js と、ディーラーの受注一覧 dealer-app.js で同じ見た目にする)。
 * 表示する文字はすべて textContent(HTML として解釈しない)。見た目は styles.css の .history-lens-row・.history-card-head など
 * (医療機関側の #orderHistory と、ディーラーの .dealer-panel に限定)。
 */
import { summaryLineMain, formatShortSurgeryDate } from "./confirm-lines.js";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * 手術日の見出し(短い表記「11/25(水)」。手術日の記録がなければ「手術日の記録なし」)。badges は右端(取消済み・テストなど)
 * @param {string} date YYYY-MM-DD
 * @param {HTMLElement[]} [badges]
 */
export function lensDayHead(date, badges = []) {
  const head = el("div", "history-card-head");
  head.append(el("span", "history-card-date", date ? formatShortSurgeryDate(date) : "手術日の記録なし"));
  if (badges.length) { const b = el("span", "history-card-badges"); b.append(...badges); head.append(b); }
  return head;
}

/**
 * レンズ行: 左に「モデル 度数 枚数」(確認画面・詳細と同じ部品。一覧ではメーカー名を省く)、右に担当医名(長い名前は右の列の中で折り返す)。
 * badges は左の明細の末尾(取消済み・テスト。右の列は担当医名だけにして、明細の幅を確保する)
 * @param {string} tag "li"(カードの中)/ "div"(押せる行のボタンの中)
 * @param {{lineNo:number, model:string, power:string, quantity:number}} line
 * @param {{doctor:string, badges?:HTMLElement[], className?:string}} opts doctor = 右側の表示(「内田Dr」など)
 */
export function lensRow(tag, line, { doctor, badges = [], className = "" }) {
  const row = el(tag, ["history-line history-lens-row", className].filter(Boolean).join(" "));
  row.dataset.line = String(line.lineNo);
  const main = el("div", "history-lens-main");
  const m = summaryLineMain({ manufacturer: "", modelName: line.model, power: line.power, quantity: line.quantity });
  m.querySelector(".summary-maker").remove();   // 一覧ではメーカー名を出さない(詳細・確認画面は従来どおり)
  if (badges.length) m.append(...badges);
  main.append(m);
  const side = el("span", "history-lens-side");
  side.append(el("span", "history-lens-doctor", doctor));
  row.append(main, side);
  return row;
}
