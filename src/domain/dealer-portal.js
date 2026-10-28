/**
 * ディーラー専用画面の、画面側の純粋な処理(表示の文言・日付・施設の選択)。権限の判定はしない(すべてサーバー)。
 */

/** 施設の許可の前後に示す説明(設計 docs/design/dealer-portal.md 6.1) */
export const DEALER_ACCESS_NOTICE =
  "この会社の有効な全担当者が、許可後の新規注文のうち、自社宛ての明細を閲覧できます。支店や担当施設の設定は表示上の整理であり、初版では閲覧制限になりません。共通備考は初期状態では共有しません。";

const JST_MS = 9 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");

/** 日本時間の日付(YYYY-MM-DD) */
export const jstDate = (ms) => new Date(ms + JST_MS).toISOString().slice(0, 10);

/** ISO の日時 → 日本時間の「YYYY/MM/DD HH:mm」(不正なら "—") */
export function formatJstDateTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms + JST_MS);
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** YYYY-MM-DD → 「YYYY/MM/DD」 */
export const formatDate = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.replace(/-/g, "/") : "—");

/**
 * 検索の施設の条件。表示中の候補をすべて選んでいるときも、選んだ施設を明示して送る(サーバーは許可済みの施設か確認する)。
 * @param {string[]} selectedIds
 */
export const facilityFilterOf = (selectedIds) => ({ mode: "selected", facilityIds: [...new Set(selectedIds)] });

/** 「担当施設を選択」「閲覧可能施設をすべて選択」「選択を解除」 */
export function selectionFor(kind, facilities) {
  if (kind === "assigned") return facilities.filter(f => f.assigned).map(f => f.id);
  if (kind === "all") return facilities.map(f => f.id);
  return [];
}

/** 現在の検索範囲の説明 */
export function scopeLabel(selectedIds, facilities) {
  const sel = new Set(selectedIds);
  const n = facilities.filter(f => sel.has(f.id)).length;
  if (!facilities.length) return "閲覧できる施設はまだありません";
  if (n === 0) return "施設が選択されていません(0件)";
  if (n === facilities.length) return `閲覧可能な全施設(${n}施設)`;
  const assigned = facilities.filter(f => f.assigned).map(f => f.id);
  if (assigned.length && assigned.length === n && assigned.every(id => sel.has(id))) return `担当施設(${n}施設)`;
  return `選択した施設(${n}施設)`;
}

/** ディーラー画面の入口(メールリンクの戻り先。同じドメインの dealer.html に固定する) */
export const dealerEntryUrl = (origin) => `${origin}/dealer.html`;
