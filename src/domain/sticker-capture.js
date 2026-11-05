/**
 * 看護師の撮影画面の表示と判定(純粋関数。docs/iol-sticker-photo-design.md §3)。認可の判定はしない(すべてサーバーが確認する)。
 */
import { isLastSurgeryDate, LIMIT_MESSAGE } from "./sticker-photo.js";

/** 通信の失敗を自動で再送するまでの待ち時間(§8-2。これでも失敗したら [再送信] を出す) */
export const UPLOAD_RETRY_DELAYS = Object.freeze([1000, 2000, 4000]);

export const MESSAGES = Object.freeze({
  noToken: "台紙のQRコードを読み取って開いてください",
  codeWrong: "コードが違います",
  codeBlocked: "しばらくしてからお試しください。続くときは、施設の管理者にお知らせください",
  connection: "接続できません。通信状態を確認して、もう一度お試しください",
  sendFailed: "送信できませんでした。通信状態を確認して、もう一度お試しください",
  tooLarge: "画像が大きすぎます。もう一度撮影してください",
  badImage: "この画像は送信できません。もう一度撮影してください",
  unavailable: "現在ご利用いただけません",
  futureDate: "未来の日付は選べません",
  reenterCode: "時間が過ぎたため、もう一度コードを入力してください。写真は残っています",
  lowResolution: "この端末では解像度が低い可能性があります。文字が読めるか拡大して確認してください",
  blurry: "ピンぼけの疑いがあります。文字が読めるか拡大して確認してください",
  cameraFailed: "カメラを起動できません"
});

const JST_MS = 9 * 60 * 60 * 1000;
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
const pad = (n) => String(n).padStart(2, "0");
const jst = (ms) => new Date(ms + JST_MS);
const yearOf = (ms) => jst(ms).getUTCFullYear();

/** 送信日時「11/4(火) 10:35」。今年以外は年も付ける */
export function formatSentAt(iso, nowMs) {
  const ms = Date.parse(iso);
  const d = jst(ms);
  const year = yearOf(ms) === yearOf(nowMs) ? "" : `${d.getUTCFullYear()}/`;
  return `${year}${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEK[d.getUTCDay()]}) ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 最終手術日「11月4日の手術分まで」。今年以外は年も付ける */
export function formatSurgeryUpTo(date, nowMs) {
  const [y, m, d] = date.split("-").map(Number);
  return `${y === yearOf(nowMs) ? "" : `${y}年`}${m}月${d}日の手術分まで`;
}

/** 確認画面の値「11/4」。今年以外は年も付ける */
export function shortDate(date, nowMs) {
  const [y, m, d] = date.split("-").map(Number);
  return `${y === yearOf(nowMs) ? "" : `${y}/`}${m}/${d}`;
}

/** 前回の送信の表示。確認の後にだけ使う */
export function lastSentLabel(last, nowMs) {
  if (!last || !last.lastSentAt) return "送信履歴なし";
  const sent = `最終送信 ${formatSentAt(last.lastSentAt, nowMs)}`;
  return last.lastSurgeryDate ? `${sent} ・ ${formatSurgeryUpTo(last.lastSurgeryDate, nowMs)}` : sent;
}

/** 今回の最終手術日の入力のエラー(空は任意なので可。過去は制限しない) */
export function surgeryDateError(value, nowMs) {
  return !value || isLastSurgeryDate(value, nowMs) ? "" : MESSAGES.futureDate;
}

/**
 * 送信の応答の扱い。
 * - ok: 保存された(再送で既存の記録が返った場合を含む)
 * - ticket: チケットの期限切れ・コードの変更。写真を残してコードの再入力へ
 * - retry: 通信の失敗・一時的な失敗。同じアップロードIDで再送してよい
 * - rejected: 再送しても変わらない。message を表示する
 * @param {number|null} status null は通信の失敗
 */
export function classifyUpload(status, body) {
  if (status === 200) return { kind: "ok" };
  if (status === 401) return { kind: "ticket" };
  if (status === null || status === 503 || status >= 500) return { kind: "retry" };
  if (status === 429) return { kind: "rejected", message: (body && body.message) || LIMIT_MESSAGE };
  if (status === 413) return { kind: "rejected", message: MESSAGES.tooLarge };
  if (status === 403) return { kind: "rejected", message: MESSAGES.unavailable };
  if (status === 400 && body && body.error === "surgery_date") return { kind: "rejected", message: MESSAGES.futureDate };
  if (status === 400 && body && body.error === "length") return { kind: "retry" };   // 本文の受信が途中で切れた
  return { kind: "rejected", message: MESSAGES.badImage };
}
