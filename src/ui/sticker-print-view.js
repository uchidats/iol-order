import { h } from "./markdown-view.js";
import { qrImageUrl } from "../domain/sticker-settings.js";
import {
  PAGE, SHEET_TITLE, QR_LABEL, HEADER_MAX_LENGTH, MM_PER_PT,
  SHEET, dealerLabel, defaultHeaderText, initialDealer, wrapHeader, fitSheetNote, sheetLayout, qrSheetLayout
} from "../domain/sticker-print.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const FONT = "'Yu Gothic', 'Meiryo', 'Hiragino Sans', 'Noto Sans CJK JP', sans-serif";
/** 台紙の文字。端末の明朝体を使う(フォントファイルは配らない)。BIZ UDP明朝 Medium がない端末は、近い明朝体から順に使う */
const SHEET_FONT = "'BIZ UDP明朝 Medium', 'BIZ UDPMincho Medium', 'BIZ UDPMincho', 'BIZ UD明朝 Medium', 'BIZ UDMincho Medium', '游明朝', 'Yu Mincho', 'YuMincho', 'Hiragino Mincho ProN', 'Noto Serif CJK JP', 'Noto Serif JP', 'MS PMincho', serif";
const SHEET_WEIGHT = "500";
const PT = MM_PER_PT;

/**
 * 台紙の文字の実際の幅を測る(全角 1 とする比)。端末で使われるフォントの幅に合わせて折り返し、英大文字が続いても QR・用紙の外へ出さない。
 * 測れないときは undefined(全角 1・半角 0.5 の見積もりを使う)
 */
function sheetTextMeasure() {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return undefined;
  ctx.font = `${SHEET_WEIGHT} 100px ${SHEET_FONT}`;
  const widths = new Map();
  return (ch) => {
    if (!widths.has(ch)) widths.set(ch, ctx.measureText(ch).width / 100);
    return widths.get(ch);
  };
}
const LINE = { stroke: "#999999", "stroke-width": "0.2" };
const HEADING_PT = 9;   // 見出し行(日付・使用レンズ)の文字の大きさ

function svgEl(tag, attrs = {}, text = null) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== null) el.textContent = text;
  return el;
}
const label = (x, y, text, pt, extra = {}) => svgEl("text", { x, y, "font-size": pt * PT, "font-family": FONT, fill: "#000000", ...extra }, text);
const sheetLabel = (x, y, text, pt, extra = {}) => label(x, y, text, pt, { "font-family": SHEET_FONT, "font-weight": SHEET_WEIGHT, ...extra });
const line = (l, extra = {}) => svgEl("line", { ...l, ...LINE, ...extra });
const qrImage = (url, { x, y, size }) => svgEl("image", { href: url, x, y, width: size, height: size });

function pageSvg(children) {
  const svg = svgEl("svg", { viewBox: `0 0 ${PAGE.width} ${PAGE.height}`, class: "sticker-print-svg", role: "img" });
  svg.append(...children);
  return svg;
}

/** 台紙の SVG(A4 実寸の座標)。枠の中には何も描かない。注意事項は上部の余白に出す(fitSheetNote の結果) */
function sheetSvg({ headerLines, qrUrl, note }) {
  const lay = sheetLayout();
  return pageSvg([
    sheetLabel(PAGE.margin, lay.headTop + 7, SHEET_TITLE, 14, { "font-weight": "700" }),
    ...headerLines.map((t, i) => sheetLabel(PAGE.margin, lay.headTop + 15 + i * 5.5, t, 11, { "data-f": "header" })),
    qrImage(qrUrl, lay.qr),
    ...lay.lines.map(l => line(l)),
    ...lay.headings.map(hd => sheetLabel(hd.x, hd.y + HEADING_PT * PT * 0.36, hd.text, HEADING_PT, { "text-anchor": "middle", "data-f": "sheetHeading" })),
    ...note.lines.map((t, i) => sheetLabel(note.x, note.y + i * note.lineHeight, t, note.pt, { "data-f": "sheetNote" }))
  ]);
}

/** QR のみの SVG(8枚・切り取り線) */
function qrSheetSvg({ facilityName, qrUrl }) {
  const lay = qrSheetLayout();
  return pageSvg([
    ...lay.cuts.map(c => line(c, { "stroke-dasharray": "2 1.5" })),
    ...lay.tiles.flatMap(t => [
      qrImage(qrUrl, t.qr),
      label(t.cx, t.nameY, facilityName, 11, { "text-anchor": "middle" }),
      label(t.cx, t.labelY, QR_LABEL, 9, { "text-anchor": "middle" })
    ])
  ]);
}

/** 印刷専用の CSS。@page はページ全体に効くので、開いている間だけ読み、閉じたら外す(ほかの印刷に影響させない) */
function loadPrintStyles() {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./sticker-print.css", import.meta.url).href;
  link.dataset.stickerPrint = "";
  const ready = new Promise((resolve, reject) => { link.onload = resolve; link.onerror = () => reject(new Error("print styles")); });
  document.head.append(link);
  return { link, ready };
}

/** QR の画像を読み終えてから印刷できるようにする */
function loadQr(url) {
  const img = new Image();
  img.src = url;
  return img.decode();
}

/** 印刷の画面(見本・操作)。操作の部分は印刷されない */
function openView({ title, hint, controls = [], renderPage, qrUrl, print }) {
  const styles = loadPrintStyles();
  const printBtn = h("button", { type: "button", class: "btn btn-primary btn-aux", "data-act": "print", disabled: true }, "印刷する");
  const closeBtn = h("button", { type: "button", class: "btn btn-secondary btn-aux", "data-act": "closePrint" }, "閉じる");
  const message = h("p", { class: "form-hint", role: "status" }, "読み込み中…");
  const page = h("div", { class: "sticker-print-page" });
  const view = h("div", { class: "sticker-print-view", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "sticker-print-toolbar" },
      h("h2", { class: "sticker-print-title" }, title),
      ...controls,
      h("p", { class: "form-hint" }, hint),
      h("div", { class: "sticker-print-actions" }, closeBtn, printBtn),
      message),
    page);
  const render = () => page.replaceChildren(renderPage());
  const overflow = document.body.style.overflow;
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    view.remove();
    styles.link.remove();
    document.body.classList.remove("sticker-print-open");
    document.body.style.overflow = overflow;
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  closeBtn.addEventListener("click", close);
  printBtn.addEventListener("click", () => print());
  document.addEventListener("keydown", onKey, true);
  document.body.classList.add("sticker-print-open");
  document.body.style.overflow = "hidden";
  document.body.append(view);
  render();
  Promise.all([styles.ready, loadQr(qrUrl)])
    .then(() => { printBtn.disabled = false; message.textContent = ""; })
    .catch(() => { message.textContent = "印刷の準備ができませんでした。もう一度お試しください。"; });
  closeBtn.focus();
  return { render, close };
}

const SCALE_HINT = "印刷の倍率は100%(実際のサイズ)にしてください。「ページに合わせる」は使わないでください。印刷先に「PDFに保存」を選ぶとPDFになります。";

/**
 * 「台紙を印刷」。上部の表示は既存の設定から初期値を入れ、この画面の間だけ編集できる(保存しない。閉じると初期値に戻る)。
 * 発注先の表示は案内のためだけで、写真の閲覧の権限には関係しない。
 * @param {{facilityName:string, dealers?:Array<{id:string, name?:string, mailName?:string}>, qrSvg:string, print?:() => void}} p
 */
export function openSheetPrint({ facilityName, dealers = [], qrSvg, sheetNote = "", print = () => window.print() }) {
  const qrUrl = qrImageUrl(qrSvg);
  const header = h("input", { type: "text", class: "form-control", "data-f": "sheetHeader", maxlength: String(HEADER_MAX_LENGTH), autocomplete: "off", "aria-label": "台紙の上部の表示" });
  header.value = defaultHeaderText(facilityName, initialDealer(dealers));
  const noteWarning = h("p", { class: "error-message", "data-f": "noteTruncated", role: "status" }, "注意事項が長いため、入りきらない部分は印刷されません。施設設定で短くしてください。");
  const measure = sheetTextMeasure();
  let view = null;
  header.addEventListener("input", () => view.render());
  const select = dealers.length > 1 ? h("select", { class: "form-control", "data-f": "sheetDealer", "aria-label": "発注先" },
    h("option", { value: "" }, "発注先を表示しない"), dealers.map(d => h("option", { value: d.id }, dealerLabel(d)))) : null;
  if (select) select.addEventListener("change", () => { header.value = defaultHeaderText(facilityName, dealers.find(d => d.id === select.value)); view.render(); });
  view = openView({
    title: "台紙を印刷", hint: `${SCALE_HINT}上部の表示は、この印刷のときだけ変更できます(設定は変わりません)。`,
    controls: [select, header, noteWarning].filter(Boolean), qrUrl, print,
    renderPage: () => {
      const headerLines = wrapHeader(header.value, undefined, undefined, measure);
      const note = fitSheetNote(sheetNote, headerLines.length, SHEET, PAGE, measure);
      noteWarning.style.display = note.truncated ? "" : "none";
      return sheetSvg({ headerLines, qrUrl, note });
    }
  });
  return view;
}

/**
 * 「QRコードのみ印刷」。既存の台紙に貼る QR を A4 に8枚。URL・アクセスコードは載せない。
 * @param {{facilityName:string, qrSvg:string, print?:() => void}} p
 */
export function openQrPrint({ facilityName, qrSvg, print = () => window.print() }) {
  const qrUrl = qrImageUrl(qrSvg);
  return openView({ title: "QRコードのみ印刷", hint: SCALE_HINT, qrUrl, print, renderPage: () => qrSheetSvg({ facilityName, qrUrl }) });
}
