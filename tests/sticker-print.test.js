// IOL シール写真の印刷の様式(台紙・QR のみ)
import test from "node:test";
import assert from "node:assert/strict";
import {
  PAGE, SHEET, QR_SHEET, SHEET_TITLE, QR_LABEL, MM_PER_PT, fitSheetNote, dealerLabel, defaultHeaderText, initialDealer, wrapHeader, sheetLayout, qrSheetLayout
} from "../src/domain/sticker-print.js";

test("台紙: A4 縦・2列×6行の12枠で、貼付枠は 76×41mm・日付欄は 14mm。A4 の1枚に収まる", () => {
  const lay = sheetLayout();
  assert.deepEqual([PAGE.width, PAGE.height, SHEET.rows, SHEET.columns], [210, 297, 6, 2]);
  assert.equal(lay.slots.length, 12);
  assert.ok(lay.slots.every(s => s.width === 76 && s.height === 41));
  assert.equal(SHEET.dateWidth, 14);
  assert.equal(lay.right, PAGE.width - PAGE.margin);
  assert.deepEqual([lay.headTop, lay.top, lay.bodyTop, lay.bottom], [8, 40, 45, 291]);
  assert.ok(lay.bottom <= PAGE.height - 6, "下の余白 6mm");
  assert.ok(lay.qr.y + lay.qr.size <= lay.top, "QR は枠に重ならない");
  assert.deepEqual([lay.qr.size, lay.qr.x + lay.qr.size, lay.qr.y], [28, 198, 8]);
  assert.equal(lay.dates, undefined, "日付欄に斜線を描かない");
});

test("台紙: 各列の上に見出し行(日付・使用レンズ)。文字はそれぞれの欄の中央", () => {
  const lay = sheetLayout();
  assert.deepEqual(lay.headings.map(h => h.text), ["日付", "使用レンズ", "日付", "使用レンズ"]);
  assert.deepEqual(lay.headings.map(h => h.x), [12 + 7, 26 + 38, 108 + 7, 122 + 38]);
  assert.ok(lay.headings.every(h => h.y === 42.5), "見出し行(40〜45mm)の中央");
  assert.equal(lay.slots[0].y, 45, "最初の枠は見出し行の下");
});

test("台紙: 枠の中に線が入らない(シールと文字の読み取りを妨げない)", () => {
  const lay = sheetLayout();
  for (const s of lay.slots) {
    for (const l of lay.lines) {
      const insideX = (x) => x > s.x && x < s.x + s.width, insideY = (y) => y > s.y && y < s.y + s.height;
      assert.ok(!(l.x1 === l.x2 && insideX(l.x1)) && !(l.y1 === l.y2 && insideY(l.y1)));
    }
  }
});

test("台紙: 行数は定数1つで変えられ、線と枠が合わせて変わる", () => {
  const four = sheetLayout({ ...SHEET, rows: 4, rowHeight: 57 });
  assert.equal(four.slots.length, 8);
  assert.equal(four.bottom, 45 + 57 * 4);
});

test("印刷の文言: 台紙の題名と QR の文言", () => {
  assert.equal(SHEET_TITLE, "眼内レンズ使用報告");
  assert.equal(QR_LABEL, "IOLシール写真");
});

/** 注意事項の下端(mm) */
const noteBottom = (n) => n.y + (n.lines.length - 1) * n.lineHeight + n.pt * MM_PER_PT * 0.25;
const FRAME_TOP = SHEET.marginTop + SHEET.headHeight;

test("台紙の注意事項: 2行の初期値は大きい文字のまま入り、改行を保つ。空欄は何も出さない", () => {
  const n = fitSheetNote("挿入されなかったレンズのシールには上から大きく×を書く\n前回使用した台紙は、次の手術日の朝に撮影・送信する");
  assert.deepEqual(n.lines, ["挿入されなかったレンズのシールには上から大きく×を書く", "前回使用した台紙は、次の手術日の朝に撮影・送信する"]);
  assert.equal(n.pt, 9);
  assert.equal(n.truncated, false);
  for (const empty of ["", "  \n ", null, undefined]) assert.deepEqual([fitSheetNote(empty).lines, fitSheetNote(empty).truncated], [[], false]);
  assert.deepEqual(fitSheetNote("a\r\nb").lines, ["a", "b"], "CRLF も改行");
  assert.deepEqual(fitSheetNote("a\n\nb").lines, ["a", "", "b"], "空行を保つ");
});

test("台紙の注意事項: 長文でも貼付枠と重ならず、幅は QR の手前まで。入らない分だけ省略を知らせる", () => {
  const width = PAGE.width - 2 * PAGE.margin - SHEET.qrSize - 4;
  const notes = ["あ".repeat(150), "A".repeat(150), Array.from({ length: 10 }, () => "い".repeat(15)).join("\n"), Array.from({ length: 75 }, () => "う").join("\n")];
  for (const note of notes) {
    for (const headerLines of [0, 1, 2, 3]) {
      const n = fitSheetNote(note, headerLines);
      assert.ok(n.pt >= 6 && n.pt <= 9);
      assert.ok(noteBottom(n) <= FRAME_TOP, `枠に重ならない: ${noteBottom(n)}`);
      for (const line of n.lines) {
        const units = [...line].reduce((sum, ch) => sum + (/[ -~]/.test(ch) ? 0.5 : 1), 0);
        assert.ok(units * n.pt * MM_PER_PT <= width + 0.01, `QR に重ならない: ${line}`);
      }
    }
  }
  assert.equal(fitSheetNote("あ".repeat(150), 1).truncated, false, "150文字は1行の上部の表示なら入る");
  const many = fitSheetNote(Array.from({ length: 75 }, () => "う").join("\n"), 1);
  assert.equal(many.truncated, true);
  assert.ok(many.lines.length < 75);
});

test("上部の表示: 施設名と発注先から作る。宛名があれば宛名。発注先がなければ施設名だけ", () => {
  assert.equal(defaultHeaderText("立川病院 眼科", { name: "栗原 立川", mailName: "栗原医療器械店 立川支店" }), "立川病院 眼科　→　栗原医療器械店 立川支店");
  assert.equal(defaultHeaderText("A眼科", { name: "X商事" }), "A眼科　→　X商事");
  assert.equal(defaultHeaderText("A眼科", null), "A眼科");
  assert.equal(dealerLabel({ name: "X", mailName: "" }), "X");
});

test("発注先は1社なら自動で入れ、2社以上は勝手に決めない", () => {
  assert.deepEqual(initialDealer([{ id: "a" }]), { id: "a" });
  assert.equal(initialDealer([{ id: "a" }, { id: "b" }]), null);
  assert.equal(initialDealer([]), null);
});

test("上部の表示の折り返し: 全角と半角の幅で分け、3行までに収める。改行は空白にする", () => {
  assert.deepEqual(wrapHeader("あいう", 2), ["あい", "う"]);
  assert.deepEqual(wrapHeader("abcd", 1), ["ab", "cd"]);
  assert.deepEqual(wrapHeader("あ".repeat(100)).map(l => l.length), [39, 39, 22]);
  assert.equal(wrapHeader("あ".repeat(200)).length, 3);
  assert.deepEqual(wrapHeader("a\nb"), ["a b"]);
  assert.deepEqual(wrapHeader(""), []);
  // 実際の文字の幅で折り返す(英大文字は半角の見積もりより広い)
  const wide = (ch) => (ch === "W" ? 1 : 0.5);
  assert.deepEqual(wrapHeader("WWWiiii", 2, 3, wide), ["WW", "Wii", "ii"]);
  assert.deepEqual(fitSheetNote("W".repeat(60), 1, SHEET, PAGE, () => 1).lines.map(l => l.length), [48, 12]);
  assert.deepEqual(fitSheetNote("W".repeat(60), 1).lines.map(l => l.length), [60], "測らないときは今までの見積もり");
});

test("QR のみ: 2列×4行の8枚で、QR は約 40mm。切り取り線は枠の間にあり、QR にかからない", () => {
  const { tiles, cuts } = qrSheetLayout();
  assert.equal(tiles.length, 8);
  assert.ok(tiles.every(t => t.qr.size === QR_SHEET.qrSize && t.qr.size === 40));
  assert.equal(cuts.length, 1 + 3);
  const h = PAGE.height / QR_SHEET.rows, w = PAGE.width / QR_SHEET.columns;
  tiles.forEach((t, i) => {
    const row = Math.floor(i / 2), col = i % 2;
    assert.ok(t.qr.x > col * w && t.qr.x + t.qr.size < (col + 1) * w);
    assert.ok(t.qr.y > row * h && t.labelY < (row + 1) * h);
  });
});
