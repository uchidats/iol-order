import { groupLinesByDateAndDoctor } from "../domain/order-lines.js";
import { lensBadgeElements } from "./lens-badges.js";

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

/** 「2026年11月10日(火)」。読めなければそのまま */
export function formatSurgeryDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return isNaN(d) ? iso : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]})`;
}

const span = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; };

function lineItem(l) {
  const li = document.createElement("li");
  li.className = "summary-line";
  // 1行: [レンズN] メーカー モデル名 度数 枚数(収まらないときだけ折り返す)。手術日・担当医は、グループの見出しにまとめる
  const main = document.createElement("div");
  main.className = "summary-line-main";
  main.append(
    span("lens-no-badge", `レンズ${l.lineNo}`),                 // 元のレンズ番号(表示順で振り直さない)
    span("summary-maker", l.manufacturer),
    span("summary-model", l.modelName),
    ...lensBadgeElements({ isToric: l.isToric, isMultifocal: l.isMultifocal }), // 特徴はバッジ(判定は isToric / isMultifocal)
    span("summary-power", l.power),
    span("summary-qty", `${l.quantity}枚`));
  li.append(main);
  return li;
}

/**
 * 注文確認画面の「発注するレンズ」を、「手術日 + 担当医」ごとにまとめて表示する(表示のみ)。
 * 見出しは「手術日 2026年10月29日(木)　Dr. 内田」。同じ手術日でも担当医が違えば見出しを分ける。
 * 注文データの並び順・送信内容・保存内容には影響しない。グループは手術日の早い順、同じ日は担当医の初出順、レンズは入力順。
 * @param {HTMLElement} list 表示先(ol / ul)
 * @param {Array<object>} lines 確認済みの明細(lineNo・manufacturer・modelName・power・quantity・surgeryDate・doctor・isToric・isMultifocal)
 */
export function renderConfirmLines(list, lines) {
  list.replaceChildren(...groupLinesByDateAndDoctor(lines).map(group => {
    const section = document.createElement("li");
    section.className = "summary-date-group";
    const head = document.createElement("div");
    head.className = "summary-date-head";
    // 手術日と担当医を同じ見出しに(幅が足りなければ、全角スペースの位置で自然に折り返す)
    head.append(`手術日 ${formatSurgeryDate(group.surgeryDate)}`, "　", span("summary-doctor", `Dr. ${group.doctor}`));
    const items = document.createElement("ul");
    items.className = "summary-lines summary-date-lines";
    items.append(...group.lines.map(lineItem));
    section.append(head, items);
    return section;
  }));
}
