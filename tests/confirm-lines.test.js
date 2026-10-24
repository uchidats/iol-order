import test from "node:test";
import assert from "node:assert/strict";
import { groupLinesBySurgeryDate, groupLinesByDateAndDoctor } from "../src/domain/order-lines.js";

const L = (lineNo, surgeryDate) => ({ lineNo, surgeryDate, tag: `l${lineNo}` });

test("手術日ごとにまとめる: 手術日の早い順・同じ日は入力順・元のレンズ番号を維持", () => {
  const lines = [L(1, "2026-11-12"), L(2, "2026-11-10"), L(3, "2026-11-12"), L(4, "2026-11-10"), L(5, "2026-12-01")];
  const g = groupLinesBySurgeryDate(lines);
  assert.deepEqual(g.map(x => [x.surgeryDate, x.lines.map(l => l.lineNo)]), [["2026-11-10", [2, 4]], ["2026-11-12", [1, 3]], ["2026-12-01", [5]]]);
  assert.deepEqual(g.flatMap(x => x.lines).map(l => l.tag).sort(), ["l1", "l2", "l3", "l4", "l5"], "全明細が1回ずつ");
});

test("表示だけの処理: 元の明細の配列・順序・内容を変えない。1日だけでも同じ形(1グループ)。年をまたぐ日付も正しく並ぶ", () => {
  const lines = [L(1, "2027-01-05"), L(2, "2026-12-30"), L(3, "2026-12-30")];
  const copy = JSON.parse(JSON.stringify(lines));
  const g = groupLinesBySurgeryDate(lines);
  assert.deepEqual(lines, copy);
  assert.deepEqual(g.map(x => x.surgeryDate), ["2026-12-30", "2027-01-05"]);
  const one = groupLinesBySurgeryDate([L(1, "2026-11-10"), L(2, "2026-11-10")]);
  assert.deepEqual([one.length, one[0].lines.map(l => l.lineNo)], [1, [1, 2]]);
  assert.deepEqual(groupLinesBySurgeryDate([]), []);
});

test("手術日 + 担当医でまとめる: 手術日の早い順・同じ日は担当医の初出順・同じ手術日かつ同じ担当医は1つ・担当医が違えば分ける・元のレンズ番号を維持", () => {
  const D = (lineNo, surgeryDate, doctorId, doctor) => ({ lineNo, surgeryDate, doctorId, doctor });
  const lines = [D(1, "2026-11-12", "o1", "内田"), D(2, "2026-11-10", "o2", "佐藤"), D(3, "2026-11-12", "o3", "山田"), D(4, "2026-11-10", "o1", "内田"), D(5, "2026-11-12", "o1", "内田"), D(6, "2026-11-10", "o2", "佐藤")];
  const copy = JSON.parse(JSON.stringify(lines));
  const g = groupLinesByDateAndDoctor(lines);
  assert.deepEqual(g.map(x => [x.surgeryDate, x.doctor, x.lines.map(l => l.lineNo)]), [
    ["2026-11-10", "佐藤", [2, 6]], ["2026-11-10", "内田", [4]], ["2026-11-12", "内田", [1, 5]], ["2026-11-12", "山田", [3]]]);
  assert.deepEqual(lines, copy, "元の明細は変更しない");
  // 同姓同名でも、担当医ID が違えば別のグループ。ID がなければ氏名で判定。空配列は空
  const same = groupLinesByDateAndDoctor([D(1, "2026-11-10", "a", "田中"), D(2, "2026-11-10", "b", "田中")]);
  assert.deepEqual(same.map(x => x.lines.map(l => l.lineNo)), [[1], [2]]);
  assert.deepEqual(groupLinesByDateAndDoctor([{ lineNo: 1, surgeryDate: "2026-11-10", doctor: "山田" }, { lineNo: 2, surgeryDate: "2026-11-10", doctor: "山田" }]).length, 1);
  assert.deepEqual(groupLinesByDateAndDoctor([]), []);
});
