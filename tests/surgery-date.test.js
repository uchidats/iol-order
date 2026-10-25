import test from "node:test";
import assert from "node:assert/strict";
import { jstDate, surgeryDateRange, SURGERY_MAX_DAYS_AHEAD } from "../src/domain/surgery-date.js";
import { jstDate as serverJstDate, ORDER_LIMITS, parseOrderInput } from "../functions/src/orders.js";

test("手術日の上限日数がサーバーと同じ", () => {
  assert.equal(SURGERY_MAX_DAYS_AHEAD, ORDER_LIMITS.maxDaysAhead);
});

test("日本時間の日付: 端末のタイムゾーンに依存せず、サーバーと同じ(日付が変わる境界を含む)", () => {
  for (const iso of ["2026-10-24T14:59:59Z", "2026-10-24T15:00:00Z", "2026-12-31T15:00:00Z", "2028-02-28T15:00:00Z"]) {
    const ms = Date.parse(iso);
    assert.equal(jstDate(ms), serverJstDate(ms), iso);
  }
  assert.equal(jstDate(Date.parse("2026-10-24T15:00:00Z")), "2026-10-25", "UTC 15時 = 日本時間の翌日0時");
});

test("画面の範囲(最小・最大)は、サーバーが受け付ける範囲と一致する(範囲の内側は受付、外側は拒否)", () => {
  const nowMs = Date.parse("2026-10-24T20:00:00Z");   // 日本時間 10/25 05:00
  const { min, max } = surgeryDateRange(nowMs);
  assert.deepEqual([min, max], ["2026-10-25", "2027-10-26"]);
  const accepts = (surgeryDate) => {
    try { parseOrderInput({ facilityId: "f", requestId: "req-0123456789abcdef", lines: [{ modelId: "m", power: "+20.0D", quantity: 1, surgeryDate, doctorId: "o1" }] }, nowMs); return true; }
    catch { return false; }
  };
  assert.equal(accepts(min), true);
  assert.equal(accepts(max), true);
  assert.equal(accepts("2026-10-24"), false, "前日");
  assert.equal(accepts("2027-10-27"), false, "上限の翌日");
});
