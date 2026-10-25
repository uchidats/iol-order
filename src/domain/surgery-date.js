/**
 * 手術日の範囲(純粋関数)。サーバー(functions/src/orders.js の parseLine)と同じ基準:
 * 日本時間の本日以降、かつ本日から 366 日後まで。端末のタイムゾーンには依存しない(tests/surgery-date.test.js で一致を確認)。
 */
export const SURGERY_MAX_DAYS_AHEAD = 366;   // サーバーの ORDER_LIMITS.maxDaysAhead と同じ
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 日本時間の日付(YYYY-MM-DD) */
export const jstDate = (ms) => new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);

/** 選択できる手術日の最小・最大(YYYY-MM-DD) */
export const surgeryDateRange = (nowMs = Date.now()) => ({ min: jstDate(nowMs), max: jstDate(nowMs + SURGERY_MAX_DAYS_AHEAD * DAY_MS) });
