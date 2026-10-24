import test from "node:test";
import assert from "node:assert/strict";
import { groupLinesBySurgeryDate } from "../src/domain/order-lines.js";

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
