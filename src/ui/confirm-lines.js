import { groupLinesByDateAndDoctor } from "../domain/order-lines.js";
import { summarizeDealers } from "../domain/dealer-selection.js";

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

/** 「2026年11月10日(火)」。読めなければそのまま */
export function formatSurgeryDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return isNaN(d) ? iso : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]})`;
}

const span = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; };

/** 見出し「手術日 2026年10月29日(木)　高橋Dr」(確認画面のグループ見出しと、入力欄の折りたたみ表示で共通) */
export function summaryDateHead(surgeryDate, doctor) {
  const head = document.createElement("div");
  head.className = "summary-date-head";
  // 手術日と担当医を同じ見出しに(幅が足りなければ、全角スペースの位置で自然に折り返す)
  head.append(`手術日 ${formatSurgeryDate(surgeryDate)}`, "　", span("summary-doctor", `${doctor}Dr`));
  return head;
}

/** 1行「メーカー モデル名 度数 枚数」(レンズ番号のバッジは含めない。確認画面と折りたたみ表示で共通) */
export function summaryLineMain(l, badge = null) {
  const main = document.createElement("div");
  main.className = "summary-line-main";
  main.append(...[badge,
    span("summary-maker", l.manufacturer),
    span("summary-model", l.modelName),
    span("summary-power", l.power),
    span("summary-qty", `${l.quantity}枚`)].filter(Boolean));
  return main;
}

function lineItem(l) {
  const li = document.createElement("li");
  li.className = "summary-line";
  // 1行: [レンズN] メーカー モデル名 度数 枚数(収まらないときだけ折り返す)。手術日・担当医は、グループの見出しにまとめる
  li.append(summaryLineMain(l, span("lens-no-badge", `レンズ${l.lineNo}`)));   // 元のレンズ番号(表示順で振り直さない)
  return li;
}

/**
 * 注文確認画面の「発注するレンズ」を、「手術日 + 担当医」ごとにまとめて表示する(表示のみ)。
 * 見出しは「手術日 2026年10月29日(木)　高橋Dr」。同じ手術日でも担当医が違えば見出しを分ける。
 * 注文データの並び順・送信内容・保存内容には影響しない。グループは手術日の早い順、同じ日は担当医の初出順、レンズは入力順。
 * @param {HTMLElement} list 表示先(ol / ul)
 * @param {Array<object>} lines 確認済みの明細(lineNo・manufacturer・modelName・power・quantity・surgeryDate・doctor・isToric・isMultifocal)
 */
export function renderConfirmLines(list, lines) {
  list.replaceChildren(...groupLinesByDateAndDoctor(lines).map(group => {
    const section = document.createElement("li");
    section.className = "summary-date-group";
    const head = summaryDateHead(group.surgeryDate, group.doctor);
    const items = document.createElement("ul");
    items.className = "summary-lines summary-date-lines";
    items.append(...group.lines.map(lineItem));
    section.append(head, items);
    return section;
  }));
}

/**
 * 「発注先:」(発注元と同じカードの右側)。1社なら名称を1回だけ、複数社ならディーラーごとにレンズ番号をまとめて表示する。
 * 発注先未設定・発注用メール未登録(自動送信不可)の警告は、ディーラー名の下に小さく出す。判定(dealer-selection.js)・送信データは変更しない。
 */
export function renderDealersCard(box, lines) {
  const { allSame, groups } = summarizeDealers(lines);
  box.replaceChildren(...groups.map(g => {
    const item = document.createElement("div");
    item.className = "summary-dealer";
    const title = document.createElement("div");
    title.className = "summary-dealer-name";
    const nos = g.lineNos.map(n => `レンズ${n}`).join("・");
    title.textContent = g.name || "未設定";   // 「発注先：」の右に出す
    item.append(title);
    if (!allSame) { // 複数の発注先: ディーラー名の下に、対象のレンズ番号(小さめ)
      const lenses = document.createElement("div");
      lenses.className = "summary-dealer-lenses";
      lenses.textContent = nos;
      item.append(lenses);
    }
    if (g.name && g.warning) {
      const w = document.createElement("div");
      w.className = "summary-dealer-warning";
      w.textContent = g.warning;
      item.append(w);
    }
    return item;
  }));
}

/**
 * 発注先が2社以上のときの確認内容: ディーラーごとに、通常の確認内容(template の dl)と同じ構成のまとまりを作り、縦に並べる(表示のみ)。
 * まとまりの順は、注文の中で最初に登場した順(summarizeDealers)。レンズ番号は入力時のまま(振り直さない)。
 * 各まとまり: 手術日・担当医とそのディーラー宛てのレンズ / 件数・合計枚数 / 備考(注文全体の共通備考を同じ内容で表示) / 発注元・発注先(警告はその中)。
 * 最後に注文全体の件数・合計枚数を1回だけ。注文データ・発注先の判定・宛先・送信内容は変えない。
 * @param {HTMLElement} box 表示先(summaryByDealer)
 * @param {HTMLElement} template 通常の確認内容の dl(data-part で差し込み先を示す。複製して ID を外す)
 * @param {{lines:Array<object>, notes?:string, facilityName?:string}} data
 * @returns {number} ディーラーのまとまりの数
 */
export function renderConfirmByDealer(box, template, { lines, notes = "", facilityName = "" }) {
  const { groups } = summarizeDealers(lines);
  const blocks = groups.map(g => {
    const own = lines.filter(l => (l.dealerId || "") === g.dealerId);
    const dl = template.cloneNode(true);
    dl.removeAttribute("id");
    dl.querySelectorAll("[id]").forEach(e => e.removeAttribute("id"));   // ID の重複を避ける(中身は data-part で差し込む)
    dl.hidden = false;
    dl.classList.add("summary-dealer-block");
    dl.dataset.dealer = g.dealerId;
    dl.setAttribute("role", "group");
    dl.setAttribute("aria-label", `${g.name || "発注先未設定"} 宛ての注文`);
    const part = (k) => dl.querySelector(`[data-part="${k}"]`);
    renderConfirmLines(part("lines"), own);
    part("total").textContent = `${own.length}件・合計${own.reduce((s, l) => s + (Number(l.quantity) || 0), 0)}枚`;
    part("notes").textContent = notes || "（なし）";
    part("facilityBox").hidden = !facilityName;
    part("facility").textContent = facilityName || "";
    part("parties").classList.toggle("is-dealer-only", !facilityName);
    renderDealersCard(part("dealers"), own);   // 1社分: ディーラー名と警告だけ(レンズ番号の対応表は出さない)
    return dl;
  });
  const grand = document.createElement("div");
  grand.className = "summary-grand-total";
  grand.append(span("summary-grand-label", "注文全体"), span("highlight-value", `${lines.length}件・合計${lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0)}枚`));
  box.replaceChildren(...blocks, grand);
  return blocks.length;
}

/**
 * 確認画面の表示の切り替え: 発注先が1社(または発注先なし)なら通常の確認内容(single)をそのまま表示、2社以上ならディーラーごとのまとまり(byDealer)を表示する。
 * single の中身(明細・合計・備考・発注元・発注先)は、呼び出し側が先に埋めておく(2社以上のときは、それをひな形に複製する)。
 * @returns {boolean} 2社以上か
 */
export function renderDealerSections(single, byDealer, data) {
  const multi = summarizeDealers(data.lines).groups.length > 1;
  if (multi) renderConfirmByDealer(byDealer, single, data); else byDealer.replaceChildren();
  single.hidden = multi;
  byDealer.hidden = !multi;
  return multi;
}
