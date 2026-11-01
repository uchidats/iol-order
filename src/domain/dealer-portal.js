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
/** 招待・役割の変更で選べる役割(会社管理者はすべて、支店管理者は閲覧者だけ) */
export const assignableRoles = (actorRole) => (actorRole === "companyAdmin" ? ["reader", "branchAdmin", "companyAdmin"] : actorRole === "branchAdmin" ? ["reader"] : []);
/**
 * 担当者の行で出す操作(サーバーの規則 managerPolicyError と同じ考え方)。
 * 会社管理者は全員(自分の役割・有効/無効は除く)。支店管理者は自分の支店の閲覧者と、自分の氏名・担当施設だけ(所属支店は変えられない)。
 * @param {{role:string, staffId:string, branchId?:string|null}} me 操作する本人
 * @returns {{edit:boolean, roleOptions:string[], branch:boolean, toggle:boolean, cancel:boolean}}
 */
export function staffActions(me, t) {
  const none = { edit: false, roleOptions: [], branch: false, toggle: false, cancel: false };
  if (!me || !isDealerManager(me.role)) return none;
  const ca = me.role === "companyAdmin";
  const own = ca || (!!me.branchId && (t.branchId || null) === me.branchId);   // 支店管理者: 自分の支店の担当者か
  if (t.status === "invited" || t.status === "expired") return { ...none, cancel: ca || (own && t.role === "reader") };
  if (t.staffId === me.staffId) return { ...none, edit: own, branch: ca };   // 自分の役割・有効/無効は変えない
  if (!ca && (!own || t.role !== "reader")) return none;
  return { edit: true, roleOptions: assignableRoles(me.role), branch: ca, toggle: true, cancel: false };
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

/**
 * 注文フォームのメニュー「ディーラー用受注一覧」を出すか(表示だけ。ディーラー画面のログイン・閲覧の許可は別に確認する)。
 * 運営者(platformAdmin)と、検証用の施設「テスト眼科」(施設名ではなく施設 ID で判定)に所属する利用者だけ
 */
export const DEALER_PORTAL_MENU_FACILITY_IDS = Object.freeze(["fac-4313b230edb2bb033859d315"]);   // テスト眼科
export const canOpenDealerPortalMenu = ({ isPlatformAdmin = false, memberships = [] } = {}) =>
  isPlatformAdmin === true || (memberships || []).some(m => m && DEALER_PORTAL_MENU_FACILITY_IDS.includes(m.facilityId));
