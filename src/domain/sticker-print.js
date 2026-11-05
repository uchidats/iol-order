/**
 * IOL シール写真の印刷の様式(純粋関数。docs/iol-sticker-photo-design.md §4-2・§4-3)。座標の単位はすべて mm。
 * 台紙の行数は試し刷りの結果で変えるので、SHEET.rows の1か所で決める(暫定 5 行)。患者氏名・ID の欄は作らない。
 */
export const PAGE = Object.freeze({ width: 210, height: 297, margin: 12 });

/** 台紙: A4 縦・2列。列 90mm(日付欄 14mm + 貼付枠 76mm)・列の間 6mm・行 46mm */
export const SHEET = Object.freeze({ rows: 5, columns: 2, columnWidth: 90, columnGap: 6, dateWidth: 14, rowHeight: 46, headHeight: 32, qrSize: 28 });

/** QR のみ: A4 縦・2列×4行 = 8枚 */
export const QR_SHEET = Object.freeze({ rows: 4, columns: 2, qrSize: 40 });

export const SHEET_TITLE = "IOLシール貼付台紙";
export const SHEET_NOTE = "挿入できなかったレンズのシールには大きく×を書いて貼る ・ 患者氏名・IDは書かない";
export const QR_LABEL = "IOLシール写真";
export const HEADER_MAX_LENGTH = 100;

const HEADER_LINE_UNITS = 39;   // 上部の表示の1行の幅(全角の文字数。QR の左の幅 154mm・11pt)
const HEADER_MAX_LINES = 3;
const SEPARATOR = "　→　";

/** 発注先の表示名(注文メールの宛名があれば宛名。読むだけで変更しない) */
export const dealerLabel = (dealer) => String((dealer && (dealer.mailName || dealer.name)) || "").trim();

/** 上部の表示の初期値「施設名 → 発注先」。発注先がなければ施設名だけ */
export function defaultHeaderText(facilityName, dealer = null) {
  const facility = String(facilityName || "").trim();
  const name = dealerLabel(dealer);
  return name ? `${facility}${SEPARATOR}${name}` : facility;
}

/** 発注先が1社なら自動で入れる。2社以上は選ぶまで入れない(勝手に決めない) */
export const initialDealer = (dealers) => (Array.isArray(dealers) && dealers.length === 1 ? dealers[0] : null);

const unitsOf = (ch) => (/[ -~｡-ﾟ]/.test(ch) ? 0.5 : 1);

/** 上部の表示を幅に合わせて折り返す(全角 1・半角 0.5 で数える)。入らない分は出さない */
export function wrapHeader(text, unitsPerLine = HEADER_LINE_UNITS, maxLines = HEADER_MAX_LINES) {
  const lines = [];
  let line = "", units = 0;
  for (const ch of String(text || "").replace(/\s*[\r\n]+\s*/g, " ").trim()) {
    const u = unitsOf(ch);
    if (units + u > unitsPerLine) { lines.push(line); line = ""; units = 0; }
    line += ch;
    units += u;
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

/** 台紙の線・日付欄・貼付枠の位置 */
export function sheetLayout(s = SHEET, page = PAGE) {
  const top = page.margin + s.headHeight;
  const bottom = top + s.rowHeight * s.rows;
  const lines = [], dates = [], slots = [];
  for (let c = 0; c < s.columns; c += 1) {
    const x = page.margin + c * (s.columnWidth + s.columnGap);
    for (let r = 0; r <= s.rows; r += 1) lines.push({ x1: x, y1: top + r * s.rowHeight, x2: x + s.columnWidth, y2: top + r * s.rowHeight });
    for (const lx of [x, x + s.dateWidth, x + s.columnWidth]) lines.push({ x1: lx, y1: top, x2: lx, y2: bottom });
    for (let r = 0; r < s.rows; r += 1) {
      const y = top + r * s.rowHeight;
      dates.push({ x: x + s.dateWidth / 2, y: y + s.rowHeight / 2 });
      slots.push({ x: x + s.dateWidth, y, width: s.columnWidth - s.dateWidth, height: s.rowHeight });
    }
  }
  return {
    lines, dates, slots, top, bottom,
    right: page.margin + s.columns * s.columnWidth + (s.columns - 1) * s.columnGap,
    qr: { x: page.width - page.margin - s.qrSize, y: page.margin, size: s.qrSize }
  };
}

/** QR のみの様式の枠・切り取り線の位置 */
export function qrSheetLayout(s = QR_SHEET, page = PAGE) {
  const w = page.width / s.columns, h = page.height / s.rows;
  const tiles = [];
  for (let r = 0; r < s.rows; r += 1) {
    for (let c = 0; c < s.columns; c += 1) {
      const cx = c * w + w / 2, top = r * h + (h - s.qrSize - 12) / 2;
      tiles.push({ cx, qr: { x: cx - s.qrSize / 2, y: top, size: s.qrSize }, nameY: top + s.qrSize + 5, labelY: top + s.qrSize + 10 });
    }
  }
  const cuts = [];
  for (let c = 1; c < s.columns; c += 1) cuts.push({ x1: c * w, y1: 0, x2: c * w, y2: page.height });
  for (let r = 1; r < s.rows; r += 1) cuts.push({ x1: 0, y1: r * h, x2: page.width, y2: r * h });
  return { tiles, cuts };
}
