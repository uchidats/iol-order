/**
 * IOL シール写真の印刷の様式(純粋関数。docs/iol-sticker-photo-design.md §4-2・§4-3)。座標の単位はすべて mm。
 * 台紙は 2列×6行(12枠)。行数・行の高さは SHEET の定数で決める。患者氏名・ID の欄は作らない。
 */
export const PAGE = Object.freeze({ width: 210, height: 297, margin: 12 });

/**
 * 台紙: A4 縦・2列×6行。列 90mm(日付欄 14mm + 貼付枠 76mm)・列の間 6mm・行 41mm。
 * 縦の割り付け: 上の余白 8mm + 上部(題名・表示・注意事項・QR)32mm + 見出し行 5mm + 41mm×6 = 291mm(下の余白 6mm)
 */
export const SHEET = Object.freeze({ rows: 6, columns: 2, columnWidth: 90, columnGap: 6, dateWidth: 14, rowHeight: 41, headHeight: 32, headingHeight: 5, marginTop: 8, qrSize: 28 });

/** 見出し行の文字(各列の上。左が日付欄、右が貼付枠) */
export const SHEET_HEADINGS = Object.freeze({ date: "日付", lens: "使用レンズ" });

/** QR のみ: A4 縦・2列×4行 = 8枚 */
export const QR_SHEET = Object.freeze({ rows: 4, columns: 2, qrSize: 40 });

export const SHEET_TITLE = "眼内レンズ使用報告";
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

/** 1pt の mm */
export const MM_PER_PT = 0.3528;

/** 文字列を幅に合わせて折り返す(全角 1・半角 0.5 で数える) */
function wrapUnits(text, unitsPerLine) {
  const lines = [];
  let line = "", units = 0;
  for (const ch of text) {
    const u = unitsOf(ch);
    if (units + u > unitsPerLine) { lines.push(line); line = ""; units = 0; }
    line += ch;
    units += u;
  }
  if (line) lines.push(line);
  return lines;
}

/** 上部の表示を幅に合わせて折り返す(全角 1・半角 0.5 で数える)。入らない分は出さない */
export function wrapHeader(text, unitsPerLine = HEADER_LINE_UNITS, maxLines = HEADER_MAX_LINES) {
  return wrapUnits(String(text || "").replace(/\s*[\r\n]+\s*/g, " ").trim(), unitsPerLine).slice(0, maxLines);
}

/** 台紙の注意事項の文字の大きさ(大きい順に試す) */
const NOTE_POINTS = [9, 8.5, 8, 7.5, 7, 6.5, 6];
const NOTE_LINE_RATIO = 1.2;
const NOTE_QR_GAP = 4;       // QR との間(mm)
const NOTE_FRAME_GAP = 1.5;  // 貼付枠との間(mm)

/**
 * 台紙の注意事項を、上部の表示の下・QR の左・貼付枠の上の余白に収める。入る最大の文字の大きさを選ぶ。
 * 最小の大きさでも入らない分は出さず truncated を返す(QR・貼付枠には重ねない)。枠の寸法は変えない。
 * @param {string} note 改行を含む文字列
 * @param {number} headerLines 上部の表示の行数
 * @returns {{lines:string[], pt:number, x:number, y:number, lineHeight:number, truncated:boolean}} y は1行目のベースライン(mm)
 */
export function fitSheetNote(note, headerLines = 1, s = SHEET, page = PAGE) {
  const rows = String(note ?? "").replace(/\r\n?/g, "\n").trimEnd().split("\n").map(l => l.trimEnd());
  const top = s.marginTop + 15 + (Math.max(1, headerLines) - 1) * 5.5 + 2.2;
  const bottom = s.marginTop + s.headHeight - NOTE_FRAME_GAP;
  const width = page.width - 2 * page.margin - s.qrSize - NOTE_QR_GAP;
  const place = (pt) => {
    const lineHeight = pt * MM_PER_PT * NOTE_LINE_RATIO;
    const unitsPerLine = Math.floor(width / (pt * MM_PER_PT));
    const lines = rows.flatMap(r => (r ? wrapUnits(r, unitsPerLine) : [""]));
    return { lines, pt, lineHeight, x: page.margin, y: top + pt * MM_PER_PT, capacity: Math.max(0, Math.floor((bottom - top) / lineHeight)) };
  };
  if (rows.length === 1 && !rows[0]) return { ...place(NOTE_POINTS[0]), lines: [], capacity: undefined, truncated: false };
  for (const pt of NOTE_POINTS) {
    const { capacity, ...fit } = place(pt);
    if (fit.lines.length <= capacity) return { ...fit, truncated: false };
  }
  const { capacity, ...fit } = place(NOTE_POINTS[NOTE_POINTS.length - 1]);
  return { ...fit, lines: fit.lines.slice(0, capacity), truncated: true };
}

/**
 * 台紙の線・見出し行・貼付枠の位置。top は見出し行の上端、bodyTop は最初の枠の上端。
 * headings は見出しの文字の中心(各列に 日付・使用レンズ)。日付欄の中には何も描かない(手書き)
 */
export function sheetLayout(s = SHEET, page = PAGE) {
  const top = s.marginTop + s.headHeight;
  const bodyTop = top + s.headingHeight;
  const bottom = bodyTop + s.rowHeight * s.rows;
  const lines = [], headings = [], slots = [];
  for (let c = 0; c < s.columns; c += 1) {
    const x = page.margin + c * (s.columnWidth + s.columnGap);
    lines.push({ x1: x, y1: top, x2: x + s.columnWidth, y2: top });
    for (let r = 0; r <= s.rows; r += 1) lines.push({ x1: x, y1: bodyTop + r * s.rowHeight, x2: x + s.columnWidth, y2: bodyTop + r * s.rowHeight });
    for (const lx of [x, x + s.dateWidth, x + s.columnWidth]) lines.push({ x1: lx, y1: top, x2: lx, y2: bottom });
    const cy = top + s.headingHeight / 2;
    headings.push({ x: x + s.dateWidth / 2, y: cy, text: SHEET_HEADINGS.date }, { x: x + s.dateWidth + (s.columnWidth - s.dateWidth) / 2, y: cy, text: SHEET_HEADINGS.lens });
    for (let r = 0; r < s.rows; r += 1) {
      slots.push({ x: x + s.dateWidth, y: bodyTop + r * s.rowHeight, width: s.columnWidth - s.dateWidth, height: s.rowHeight });
    }
  }
  return {
    lines, headings, slots, top, bodyTop, bottom, headTop: s.marginTop,
    right: page.margin + s.columns * s.columnWidth + (s.columns - 1) * s.columnGap,
    qr: { x: page.width - page.margin - s.qrSize, y: s.marginTop, size: s.qrSize }
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
