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

// ---- 手術日の週表示(月曜〜日曜) ----
const DAY = 24 * 60 * 60 * 1000;
const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];
const utcOf = (date) => Date.parse(`${date}T00:00:00Z`);
/** 日付を n 日ずらす(YYYY-MM-DD) */
export const addDays = (date, n) => new Date(utcOf(date) + n * DAY).toISOString().slice(0, 10);
/** その日を含む週の月曜(YYYY-MM-DD) */
export function mondayOf(date) {
  const dow = new Date(utcOf(date)).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}
/** 「11月2日(月)」 */
export function formatDayHead(date) {
  const d = new Date(utcOf(date));
  return Number.isFinite(d.getTime()) ? `${d.getUTCMonth() + 1}月${d.getUTCDate()}日(${WEEKDAY[d.getUTCDay()]})` : "—";
}
/** 「2026年11月2日(月)〜11月8日(日)」(年をまたぐ週は終わりにも年) */
export function weekLabel(weekStart) {
  const end = addDays(weekStart, 6);
  const y = (d) => d.slice(0, 4);
  return `${y(weekStart)}年${formatDayHead(weekStart)}〜${y(end) !== y(weekStart) ? `${y(end)}年` : ""}${formatDayHead(end)}`;
}
/** 「11/12」(ほかの手術日の案内) */
export const shortDate = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// ---- 担当者・支店の管理(会社管理者・支店管理者)。画面の表示だけの判定(実行の可否はサーバーが確認する) ----
export const DEALER_ROLE_LABELS = Object.freeze({ companyAdmin: "会社管理者", branchAdmin: "支店管理者", reader: "閲覧者" });
export const isDealerManager = (role) => role === "companyAdmin" || role === "branchAdmin";
/** 招待・役割の変更で選べる役割(会社管理者はすべて、支店管理者は支店管理者・閲覧者) */
export const assignableRoles = (actorRole) => (actorRole === "companyAdmin" ? ["reader", "branchAdmin", "companyAdmin"] : actorRole === "branchAdmin" ? ["reader", "branchAdmin"] : []);
/**
 * 担当者の行で出す操作(サーバーの規則 managerPolicyError と同じ考え方)。
 * @returns {{edit:boolean, roleOptions:string[], toggle:boolean, cancel:boolean}}
 */
export function staffActions(actorRole, meId, t) {
  const none = { edit: false, roleOptions: [], toggle: false, cancel: false };
  if (!isDealerManager(actorRole)) return none;
  const ca = actorRole === "companyAdmin";
  if (t.status === "invited" || t.status === "expired") return { ...none, cancel: ca || t.role !== "companyAdmin" };
  if (!ca && t.role === "companyAdmin") return none;
  const self = t.staffId === meId;
  const fixedRole = self || (!ca && t.role === "branchAdmin");   // 自分自身・他の支店管理者(支店管理者から)は役割と有効/無効を変えない
  return { edit: true, roleOptions: fixedRole ? [] : assignableRoles(actorRole), toggle: !fixedRole, cancel: false };
}
/** 担当者の一覧の支店の絞り込み: "all"(すべての支店)/ "none"(支店未設定)/ 支店 ID */
export const filterStaffByBranch = (staff, key) => (staff || []).filter(x => key === "all" || (key === "none" ? !x.branchId : x.branchId === key));

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
