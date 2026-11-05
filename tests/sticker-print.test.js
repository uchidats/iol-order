// IOL シール写真の印刷の様式(台紙・QR のみ)
import test from "node:test";
import assert from "node:assert/strict";
import {
  PAGE, SHEET, QR_SHEET, SHEET_NOTE, SHEET_TITLE, QR_LABEL, dealerLabel, defaultHeaderText, initialDealer, wrapHeader, sheetLayout, qrSheetLayout
} from "../src/domain/sticker-print.js";

test("台紙: A4 縦・2列×5行の10枠で、貼付枠は 76×46mm。印刷範囲(余白 12mm)に収まる", () => {
  const lay = sheetLayout();
  assert.deepEqual([PAGE.width, PAGE.height, SHEET.rows, SHEET.columns], [210, 297, 5, 2]);
  assert.equal(lay.slots.length, 10);
  assert.ok(lay.slots.every(s => s.width === 76 && s.height === 46));
  assert.equal(lay.dates.length, 10, "各枠に日付の手書き欄");
  assert.equal(lay.right, PAGE.width - PAGE.margin);
  assert.ok(lay.bottom + 10 <= PAGE.height - PAGE.margin, "下の注意書きと確認線も余白の内側");
  assert.ok(lay.qr.y + lay.qr.size <= lay.top, "QR は枠に重ならない");
  assert.deepEqual([lay.qr.size, lay.qr.x + lay.qr.size], [28, 198]);
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
  assert.equal(four.bottom, 44 + 57 * 4);
});

test("印刷の文言に患者氏名・ID の記入欄がない(書かない注意だけ)", () => {
  assert.equal(SHEET_TITLE, "IOLシール貼付台紙");
  assert.match(SHEET_NOTE, /患者氏名・IDは書かない/);
  assert.equal(QR_LABEL, "IOLシール写真");
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
