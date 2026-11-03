/**
 * 依存なしの最小の .xlsx 生成(ディーラーの受注一覧の Excel 出力。docs/dealer-export-design.md §6-4)。
 * .xlsx は XML を ZIP にまとめたもの。ZIP は無圧縮(stored)で書き、CRC32 とヘッダーだけを作る。
 * 対応: 文字列(inline string)・数値・日付(日付セル yyyy/m/d)・見出しの太字・列幅・1行目の固定・オートフィルタ・複数シート。
 * 数式セルは作らない(人が入力した文字列が先頭 = + - @ でも数式として解釈されない)。文字はすべて XML エスケープする。
 * ブラウザ(Uint8Array → Blob)と Node(テスト)の両方で動く(TextEncoder のみ使用)。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32(ZIP 用) */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const utf8 = (s) => enc.encode(s);

/** ZIP の日時(DOS 形式。秒は2秒単位)。日本時間などの換算はせず、与えた Date のローカル値を使う */
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * 無圧縮の ZIP を作る。
 * @param {Array<{name:string, data:Uint8Array}>} files
 * @param {Date} [now] エントリの日時
 */
export function zipStored(files, now = new Date()) {
  const { time, date } = dosDateTime(now);
  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (const f of files) {
    const name = utf8(f.name);
    const crc = crc32(f.data);
    const local = Uint8Array.from([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(time), ...u16(date),
      ...u32(crc), ...u32(f.data.length), ...u32(f.data.length), ...u16(name.length), ...u16(0)
    ]);
    parts.push(local, name, f.data);
    central.push(Uint8Array.from([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(time), ...u16(date),
      ...u32(crc), ...u32(f.data.length), ...u32(f.data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset)
    ]), name);
    offset += local.length + name.length + f.data.length;
  }
  const centralSize = central.reduce((s, p) => s + p.length, 0);
  const eocd = Uint8Array.from([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(centralSize), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  for (const p of all) { out.set(p, pos); pos += p.length; }
  return out;
}

/** XML のエスケープ(属性・本文の両方に使える) */
export const xmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" }[c]))
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");   // XML に書けない制御文字は落とす

/** 列番号(0 始まり)→ 列名(A, B, …, AA) */
export function colName(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** YYYY-MM-DD → Excel のシリアル値(1900 日付システム。1899-12-30 からの日数) */
export function excelDateSerial(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  if (!m) return null;
  return Math.round((Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - Date.UTC(1899, 11, 30)) / 864e5);
}

/** セルの値 → XML。{ date: "YYYY-MM-DD" } は日付セル、{ v, bold: true } は太字、数値は数値セル、それ以外は文字列セル。null/undefined は空 */
function cellXml(ref, value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "object" && value !== null && "date" in value) {
    if (!value.date) return "";
    const n = excelDateSerial(value.date);
    return n === null ? `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value.date)}</t></is></c>` : `<c r="${ref}" s="2"><v>${n}</v></c>`;
  }
  const bold = typeof value === "object" && value !== null && value.bold === true;
  const v = bold ? value.v : value;
  if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${bold ? " s=\"1\"" : ""}><v>${v}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${bold ? " s=\"1\"" : ""}><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
}

const SHEET_NAME_BAD = /[\\/*?:[\]]/g;
const sheetName = (s, i) => (String(s || `Sheet${i + 1}`).replace(SHEET_NAME_BAD, "").slice(0, 31) || `Sheet${i + 1}`);

/**
 * ワークブックを作る。
 * @param {{ sheets: Array<{ name:string, rows:any[][], widths?:number[], freezeHeader?:boolean, autoFilter?:boolean }>, created?:Date }} wb
 *   rows[0] を見出しとして太字にする(freezeHeader/autoFilter の対象)
 * @returns {Uint8Array} .xlsx のバイト列
 */
export function buildXlsx({ sheets, created = new Date() }) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error("sheets required");
  const files = [];
  const names = sheets.map((s, i) => sheetName(s.name, i));
  const definedNames = [];
  sheets.forEach((sheet, idx) => {
    const rows = sheet.rows || [];
    const cols = rows.reduce((m, r) => Math.max(m, r.length), 1);
    const lastRef = `${colName(cols - 1)}${Math.max(rows.length, 1)}`;
    const widths = (sheet.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Number(w) || 10}" customWidth="1"/>`).join("");
    const body = rows.map((r, ri) => {
      const cells = r.map((v, ci) => cellXml(`${colName(ci)}${ri + 1}`, ri === 0 && v !== null && v !== undefined && v !== "" && typeof v !== "object" ? { v, bold: true } : v)).join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join("");
    const freeze = sheet.freezeHeader !== false && rows.length > 1
      ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : "";
    const filter = sheet.autoFilter && rows.length > 1 ? `<autoFilter ref="A1:${lastRef}"/>` : "";
    if (filter) definedNames.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${idx}" hidden="1">'${xmlEscape(names[idx]).replace(/'/g, "''")}'!$A$1:$${colName(cols - 1)}$${rows.length}</definedName>`);
    files.push({ name: `xl/worksheets/sheet${idx + 1}.xml`, data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastRef}"/>${freeze}<sheetFormatPr defaultRowHeight="15"/>${widths ? `<cols>${widths}</cols>` : ""}<sheetData>${body}</sheetData>${filter}<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/></worksheet>`) });
  });
  files.push({ name: "[Content_Types].xml", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`) });
  files.push({ name: "_rels/.rels", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) });
  files.push({ name: "xl/workbook.xml", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${definedNames.length ? `<definedNames>${definedNames.join("")}</definedNames>` : ""}</workbook>`) });
  files.push({ name: "xl/_rels/workbook.xml.rels", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) });
  // スタイル: 0 = 標準、1 = 太字(見出し)、2 = 日付(yyyy/m/d)
  files.push({ name: "xl/styles.xml", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy/m/d"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`) });
  return zipStored(files, created);
}

/**
 * 無圧縮 ZIP を読む(テスト・検証用。buildXlsx の出力だけを想定)。
 * @returns {Map<string, Uint8Array>} 名前 → 中身
 */
export function readZipStored(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory");
    const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (method !== 0) throw new Error("not stored: " + name);
    const lName = dv.getUint16(local + 26, true), lExtra = dv.getUint16(local + 28, true);
    const start = local + 30 + lName + lExtra;
    const data = bytes.subarray(start, start + size);
    if (crc32(data) !== crc) throw new Error("crc mismatch: " + name);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
