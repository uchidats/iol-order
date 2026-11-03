// ディーラー受注一覧の出力(印刷・Excel)の純粋な処理と、依存なしの .xlsx 生成(docs/dealer-export-design.md)
import test from "node:test";
import assert from "node:assert/strict";
import { buildXlsx, readZipStored, excelDateSerial, colName, crc32, xmlEscape } from "../src/domain/xlsx-writer.js";
import { EXPORT_LIMITS, EXCEL_HEADERS, linesFromOrdered, linesFromWeeks, exportCounts, overLimit, LIMIT_MESSAGE, orderedRangeLabel, weekRangeLabel, facilityLabel,
  partialNotice, exportFileName, exportBaseName, exportMeta, excelRows, conditionRows, workbookSheets, orderedGroups, surgerySections, shortDay, weekdayOf, jstParts } from "../src/domain/dealer-export.js";

const dec = new TextDecoder();
const xmlOf = (zip, name) => dec.decode(zip.get(name));

test("xlsx-writer: 無圧縮 ZIP と OOXML の最小構成。文字列は inline string(数式セルなし)、数値・日付セル、見出しの太字・固定・フィルタ、XML エスケープ", () => {
  assert.equal(crc32(new TextEncoder().encode("hello")).toString(16), "3610a686");
  assert.deepEqual([colName(0), colName(25), colName(26), colName(27 * 26)], ["A", "Z", "AA", "AAA"]);
  assert.equal(excelDateSerial("2026-11-10"), 46336);
  assert.equal(excelDateSerial("1899-12-31"), 1);
  assert.equal(excelDateSerial("bad"), null);
  assert.equal(xmlEscape("a<b&c>\"d'\u0001"), "a&lt;b&amp;c&gt;&quot;d&apos;");
  const bytes = buildXlsx({ sheets: [
    { name: "明細", rows: [["注文番号", "枚数", "手術日"], ["=SUM(A1)", 2, { date: "2026-11-10" }], ["x<&>\"", "+21.0D", { date: "" }]], widths: [14, 6, 12], autoFilter: true },
    { name: "出力条件", rows: [["項目", "内容"], ["会社", "テスト社"]], freezeHeader: false }
  ], created: new Date(2026, 10, 3, 15, 32, 0) });
  const zip = readZipStored(bytes);   // CRC も検証する
  assert.deepEqual([...zip.keys()].sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
  const s1 = xmlOf(zip, "xl/worksheets/sheet1.xml");
  assert.ok(!s1.includes("<f>") && !s1.includes("<f "), "数式セルを作らない");
  assert.ok(s1.includes(`<c r="A2" t="inlineStr"><is><t xml:space="preserve">=SUM(A1)</t></is></c>`), "先頭が = でも文字列セル");
  assert.ok(s1.includes(`<c r="A1" t="inlineStr" s="1">`), "見出しは太字(スタイル1)");
  assert.ok(s1.includes(`<c r="B2"><v>2</v></c>`), "数値セル");
  assert.ok(s1.includes(`<c r="C2" s="2"><v>46336</v></c>`), "日付セル(シリアル値 + 日付の書式)");
  assert.ok(!s1.includes(`r="C3"`), "空の日付は空セル");
  assert.ok(s1.includes("x&lt;&amp;&gt;&quot;"), "エスケープ");
  assert.ok(s1.includes(`<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`), "1行目を固定");
  assert.ok(s1.includes(`<autoFilter ref="A1:C3"/>`), "オートフィルタ");
  assert.ok(s1.includes(`<col min="1" max="1" width="14" customWidth="1"/>`), "列幅");
  const s2 = xmlOf(zip, "xl/worksheets/sheet2.xml");
  assert.ok(!s2.includes("<pane") && !s2.includes("<autoFilter"), "2シート目は固定・フィルタなし");
  const wb = xmlOf(zip, "xl/workbook.xml");
  assert.ok(wb.includes(`<sheet name="明細" sheetId="1" r:id="rId1"/><sheet name="出力条件" sheetId="2" r:id="rId2"/>`));
  assert.ok(wb.includes(`<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'明細'!$A$1:$C$3</definedName>`));
  assert.ok(xmlOf(zip, "xl/styles.xml").includes(`formatCode="yyyy/m/d"`));
  assert.ok(xmlOf(zip, "[Content_Types].xml").includes("/xl/worksheets/sheet2.xml"));
  // ZIP の先頭はローカルヘッダー(PK\x03\x04)、無圧縮(method 0)
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.equal(bytes[8] | (bytes[9] << 8), 0);
  assert.throws(() => buildXlsx({ sheets: [] }));
});

const ITEMS = [
  { receiptId: "r1", orderNumber: "IOL-20261103-01", facilityId: "fA", facilityName: "A眼科", orderedAt: "2026-11-03T00:12:00.000Z",
    lines: [{ no: 2, surgeryDate: "2026-11-17", model: "ZCT", toricModel: "ZCT225", power: "+19.0D", quantity: 2, doctorName: "内田" },
      { no: 1, surgeryDate: "2026-11-10", model: "DIB00V", toricModel: "", power: "+21.0D", quantity: 1, doctorName: "内田" }] },
  { receiptId: "r2", orderNumber: "IOL-20261102-11", facilityId: "fB", facilityName: "B<眼科>", orderedAt: "2026-11-02T08:40:00.000Z",
    lines: [{ no: 1, surgeryDate: "", model: "SN60WF", toricModel: "", power: "+22.0D", quantity: 1, doctorName: "" }] }
];
const WEEKS = [
  { weekStart: "2026-11-02", weekEnd: "2026-11-08", truncated: false, days: [{ date: "2026-11-02", orders: [] }, { date: "2026-11-03", orders: [
    { receiptId: "r1", facilityId: "fA", facilityName: "A眼科", orderNumber: "IOL-1", orderedAt: "2026-10-27T01:00:00.000Z", lines: [{ no: 1, manufacturer: "J&J", model: "DIB00V", toricModel: "", power: "+21.0D", quantity: 2, doctorName: "山田" }] }] }] },
  { weekStart: "2026-11-09", weekEnd: "2026-11-15", truncated: false, days: [{ date: "2026-11-09", orders: [] }] },
  { weekStart: "2026-11-16", weekEnd: "2026-11-22", truncated: false, days: [{ date: "2026-11-16", orders: [] }] },
  { weekStart: "2026-11-23", weekEnd: "2026-11-29", truncated: true, days: [{ date: "2026-11-25", orders: [
    { receiptId: "r9", facilityId: "fB", facilityName: "B眼科", orderNumber: "IOL-9", orderedAt: "2026-11-20T01:00:00.000Z", lines: [{ no: 1, manufacturer: "Alcon", model: "SN6AT", toricModel: "SN6AT4", power: "+20.0D", quantity: 1, doctorName: "佐藤" }] }] }] }
];
const TODAY = "2026-11-03";

test("dealer-export: 1レンズ1行(注文日順は明細番号順、手術日順は週→日→注文→明細)、件数、上限", () => {
  const lines = linesFromOrdered(ITEMS);
  assert.deepEqual(lines.map(l => [l.orderNumber, l.no, l.surgeryDate, l.toricModel || l.model, l.quantity]), [["IOL-20261103-01", 1, "2026-11-10", "DIB00V", 1], ["IOL-20261103-01", 2, "2026-11-17", "ZCT225", 2], ["IOL-20261102-11", 1, "", "SN60WF", 1]]);
  assert.deepEqual(exportCounts(lines), { orders: 2, lines: 3, quantity: 4 });
  const wl = linesFromWeeks(WEEKS);
  assert.deepEqual(wl.map(l => [l.surgeryDate, l.orderNumber, l.model]), [["2026-11-03", "IOL-1", "DIB00V"], ["2026-11-25", "IOL-9", "SN6AT"]]);
  assert.equal(overLimit({ orders: 1000, lines: 3000 }), false);
  assert.equal(overLimit({ orders: 1001, lines: 10 }), true);
  assert.equal(overLimit({ orders: 10, lines: 3001 }), true);
  assert.deepEqual(EXPORT_LIMITS, { orders: 1000, lines: 3000 });
  assert.match(LIMIT_MESSAGE, /注文1,000件または明細3,000行/);
});

test("dealer-export: 条件・件数・一部のみの注記・ファイル名(日本時間)", () => {
  assert.equal(orderedRangeLabel("2026-10-01", "2026-12-31"), "2026/10/01 〜 2026/12/31");
  assert.equal(orderedRangeLabel("2026-10-01", ""), "2026/10/01 以降");
  assert.equal(orderedRangeLabel("", "2026-12-31"), "2026/12/31 まで");
  assert.equal(orderedRangeLabel("", ""), "全期間");
  assert.equal(weekRangeLabel(WEEKS, TODAY), "11月2日の週 〜 11月23日の週");
  assert.equal(weekRangeLabel(WEEKS.slice(0, 1), TODAY), "11月2日の週");
  assert.equal(facilityLabel(["A", "B"], 2), "全施設(2)");
  assert.equal(facilityLabel(["A"], 2), "A");
  assert.equal(facilityLabel(["A"], 1), "A", "1施設だけの会社は名前");
  assert.equal(facilityLabel([], 2), "—");
  assert.equal(partialNotice(WEEKS, TODAY), "11月23日の週は一部のみ(件数が多いため)");
  assert.equal(partialNotice(WEEKS.slice(0, 2), TODAY), "");
  assert.equal(exportFileName(Date.UTC(2026, 10, 3, 6, 32), "xlsx"), "受注一覧_20261103-1532.xlsx");
  assert.equal(exportBaseName(Date.UTC(2026, 10, 3, 15, 5)), "受注一覧_20261104-0005", "日本時間で日付が変わる");
  assert.equal(shortDay("2026-11-10"), "11/10(火)");
  assert.equal(shortDay(""), "手術日の記録なし");
  assert.equal(weekdayOf("2026-11-08"), "日");
  assert.deepEqual(jstParts("2026-11-03T00:12:00.000Z"), { date: "2026-11-03", time: "09:12" });
  assert.deepEqual(jstParts("x"), { date: "", time: "" });
  const meta = exportMeta({ kind: "ordered", companyName: "X社", facilityNames: ["A眼科"], facilityTotal: 2, from: "2026-10-01", to: "", asOf: "2026-11-03T06:30:00.000Z", exportedAt: Date.UTC(2026, 10, 3, 6, 32), lines: linesFromOrdered(ITEMS) });
  assert.deepEqual([meta.title, meta.facilities, meta.rangeLabel, meta.range, meta.asOf, meta.exportedAt, meta.counts, meta.partial],
    ["受注一覧(注文日順)", "A眼科", "注文日", "2026/10/01 以降", "2026/11/03 15:30", "2026/11/03 15:32", { orders: 2, lines: 3, quantity: 4 }, ""]);
  const sm = exportMeta({ kind: "surgery", companyName: "X社", facilityNames: ["A眼科", "B眼科"], facilityTotal: 2, weeks: WEEKS, asOf: null, exportedAt: Date.UTC(2026, 10, 2, 6, 0), lines: linesFromWeeks(WEEKS) });
  assert.deepEqual([sm.title, sm.rangeLabel, sm.range, sm.asOf, sm.partial], ["受注一覧(手術日順)", "手術日", "11月2日の週 〜 11月23日の週", "", "11月23日の週は一部のみ(件数が多いため)"]);
});

test("dealer-export: Excel の行(見出し・日付セル・数値)、出力条件、不完全なときだけ注記、帳票のまとまり", () => {
  const lines = linesFromOrdered(ITEMS);
  const rows = excelRows(lines);
  assert.deepEqual(rows[0], [...EXCEL_HEADERS]);
  assert.deepEqual(rows[1], ["IOL-20261103-01", "A眼科", { date: "2026-11-03" }, "09:12", { date: "2026-11-10" }, "火", 1, "DIB00V", "", "+21.0D", 1, "内田"]);
  assert.deepEqual(rows[3], ["IOL-20261102-11", "B<眼科>", { date: "2026-11-02" }, "17:40", "", "", 1, "SN60WF", "", "+22.0D", 1, ""], "手術日の記録がなければ空");
  assert.ok(!EXCEL_HEADERS.includes("メーカー") && !EXCEL_HEADERS.includes("注文区分"), "第1段階ではメーカー・注文区分の列はない");
  const meta = exportMeta({ kind: "ordered", companyName: "X社", facilityNames: ["A眼科", "B<眼科>"], facilityTotal: 2, from: "", to: "", asOf: null, exportedAt: Date.UTC(2026, 10, 3, 6, 32), lines });
  const cond = conditionRows(meta);
  assert.deepEqual(cond.map(r => r[0]), ["項目", "帳票", "会社", "医療機関", "注文日", "出力日時", "注文", "明細", "合計枚数", "内容"], "検索時点がなければ出さない。注意の行もない");
  const sheets = workbookSheets(lines, meta);
  assert.deepEqual(sheets.map(s => [s.name, s.rows.length, s.freezeHeader, s.autoFilter]), [["明細", 4, true, true], ["出力条件", 10, false, false]]);
  // 実際に .xlsx を作れて、医療機関名の < > がエスケープされる
  const zip = readZipStored(buildXlsx({ sheets }));
  assert.ok(xmlOf(zip, "xl/worksheets/sheet1.xml").includes("B&lt;眼科&gt;"));
  // 一部のみ: 「明細」の1行目に注記(見出しは2行目。固定・フィルタなし)、「出力条件」に注意の行
  const wl = linesFromWeeks(WEEKS);
  const sm = exportMeta({ kind: "surgery", companyName: "X社", facilityNames: ["A眼科", "B眼科"], facilityTotal: 2, weeks: WEEKS, asOf: null, exportedAt: Date.UTC(2026, 10, 2, 6, 0), lines: wl });
  const ps = workbookSheets(wl, sm);
  assert.deepEqual(ps[0].rows[0], ["※ 11月23日の週は一部のみ(件数が多いため)。この出力は不完全です。"]);
  assert.deepEqual(ps[0].rows[1], [...EXCEL_HEADERS]);
  assert.deepEqual([ps[0].freezeHeader, ps[0].autoFilter], [false, false]);
  assert.deepEqual(conditionRows(sm).at(-1), ["注意", "11月23日の週は一部のみ(件数が多いため)。この出力は不完全です。"]);
  // 帳票: 注文ごとのまとまり / 手術日ごとのまとまり(受注のない週が続く所は1行)
  assert.deepEqual(orderedGroups(lines).map(g => [g.orderNumber, g.lines.length]), [["IOL-20261103-01", 2], ["IOL-20261102-11", 1]]);
  const sec = surgerySections(WEEKS, TODAY);
  assert.deepEqual(sec.map(s => s.type === "empty" ? ["empty", s.label] : ["day", s.date, s.lines.length, s.quantity, s.truncated]),
    [["day", "2026-11-03", 1, 2, false], ["empty", "11月9日の週〜11月16日の週: 受注はありません"], ["day", "2026-11-25", 1, 1, true]]);
});
