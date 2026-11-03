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
/**
 * 手術週の見出し(表示だけ。週の計算は mondayOf・addDays)。今年(日本時間)は年を省略し、同じ月なら終わりの月も省略する。
 *   今年・同じ月「11月2日(月)〜8日(日)」/ 今年・月をまたぐ「11月30日(月)〜12月6日(日)」/
 *   今年以外「2025年11月2日(月)〜8日(日)」/ 年をまたぐ「2026年12月28日(月)〜2027年1月3日(日)」(両方に年)
 * @param {string} weekStart 月曜(YYYY-MM-DD)
 * @param {string} [today] 今日(日本時間の YYYY-MM-DD。今年の判定に使う)
 */
export function weekLabel(weekStart, today = jstDate(Date.now())) {
  const end = addDays(weekStart, 6);
  const y = (d) => d.slice(0, 4), m = (d) => d.slice(5, 7);
  const crossYear = y(end) !== y(weekStart);
  const startYear = crossYear || y(weekStart) !== y(today) ? `${y(weekStart)}年` : "";
  const endHead = formatDayHead(end);
  const endText = crossYear ? `${y(end)}年${endHead}` : m(end) === m(weekStart) ? endHead.replace(/^\d+月/, "") : endHead;
  return `${startYear}${formatDayHead(weekStart)}〜${endText}`;
}
/**
 * 期間の見出し(曜日なし。年・月の省略は weekLabel と同じ規則)。「11月9日〜15日」「11月30日〜12月6日」「2026年12月28日〜2027年1月3日」
 * @param {string} start YYYY-MM-DD  @param {string} end YYYY-MM-DD  @param {string} [today] 今日(日本時間)
 */
export function spanLabel(start, end, today = jstDate(Date.now())) {
  const y = (d) => d.slice(0, 4), m = (d) => Number(d.slice(5, 7)), dd = (d) => Number(d.slice(8, 10));
  const crossYear = y(end) !== y(start);
  const head = `${crossYear || y(start) !== y(today) ? `${y(start)}年` : ""}${m(start)}月${dd(start)}日`;
  if (start === end) return head;
  return `${head}〜${crossYear ? `${y(end)}年${m(end)}月` : m(end) === m(start) ? "" : `${m(end)}月`}${dd(end)}日`;
}
/** 週の期間「11月9日〜15日の週」(予定のない週の案内など、期間を明示する所) */
export const weekSpanLabel = (weekStart, today) => `${spanLabel(weekStart, addDays(weekStart, 6), today)}の週`;
/** 手術日順の週の区切り「11月9日の週」(週の開始日 = 月曜だけ。今年以外は「2025年12月29日の週」) */
export const weekStartLabel = (weekStart, today) => `${spanLabel(weekStart, weekStart, today)}の週`;
/**
 * 注文日の検索の欄に出す日付(値は YYYY-MM-DD のまま)。今年(日本時間)は月日だけ「11/10」、今年以外は年も「2027/1/5」(年を誤認しないように)。
 * 値がなければ空文字。読めない値はそのまま
 */
export function dateFieldLabel(value, today = jstDate(Date.now())) {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const md = `${Number(m[2])}/${Number(m[3])}`;
  return m[1] === today.slice(0, 4) ? md : `${m[1]}/${md}`;
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

/**
 * 医療機関のチェック(表示の絞り込み)の記憶。ログインユーザー × 会社ごとに端末へ保存する。保存するのは施設 ID の配列だけ。
 * 担当施設の登録(staff.facilityAssignments)・閲覧の権限とは別のもの。
 */
export const facilityViewKey = (uid, companyId) => `iolDealerFacilityView.${uid}.${companyId}`;
/**
 * 保存したチェックの復元。今の閲覧可能な施設だけに絞る。
 * 未保存・壊れた値はサーバーの初期選択(fallback)。空(すべて解除)は「選択なし」のまま。
 * 保存していた施設がすべて閲覧できなくなったときは、選択なしにせず初期選択に戻す。
 * @returns {{ ids: string[], restored: boolean }}
 */
export function restoreFacilitySelection(raw, facilities, fallback) {
  let saved = null;
  try { saved = raw == null ? null : JSON.parse(raw); } catch (e) { saved = null; }
  if (!Array.isArray(saved) || saved.some(x => typeof x !== "string")) return { ids: [...fallback], restored: false };
  if (!saved.length) return { ids: [], restored: true };
  const allowed = new Set(facilities.map(f => f.id));
  const ids = [...new Set(saved)].filter(id => allowed.has(id));
  return ids.length ? { ids, restored: true } : { ids: [...fallback], restored: false };
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

/** 受注詳細の注文メールの状態の文言(「送信済み(配信サービスが受付)(日時) ・ 配信済み」)。状態がなければ "—" */
export const mailStatusText = (mail, fmt) => (mail ? `${mail.label}${mail.at ? `(${fmt(mail.at)})` : ""}${mail.delivery ? ` ・ ${mail.delivery.label}` : ""}` : "—");
/**
 * 受注詳細で注文メールの状態を常時表示するか。通常(送信済み=配信サービスが受付、配信の結果なし・配信済み)は出さず(ⓘで確認)、
 * 送信待ち・送信処理中・未送信・送信停止中・送信できなかった・配信の遅延/失敗・状態不明 は出す
 */
export function mailNeedsAttention(mail) {
  if (!mail) return false;
  if (mail.status !== "accepted") return true;
  return !!mail.delivery && mail.delivery.status !== "delivered";
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
