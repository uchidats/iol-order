/**
 * IOL シール写真(R09)の閲覧画面の表示用データ(純粋関数)。docs/iol-sticker-photo-design.md §5・§6。
 * まとめ方の元は src/domain/sticker-photo.js の groupPhotosBySession。権限の判定はしない(すべてサーバーが確認する)。
 */
import { groupPhotosBySession } from "./sticker-photo.js";

/**
 * 閲覧画面のメニューを出すか。false の間は画面に項目を出さない(撮影と配備の準備ができて、運営者が承認してから true にする)。
 * メニューの表示だけの設定で、権限は stickerPhotoApi・stickerPhotoImage が毎回確認する。
 */
export const STICKER_VIEWER_ENABLED = true;

/**
 * メニューを出すかを、対象(医療機関は施設、ディーラーは会社)ごとにサーバーへ確かめて覚える。
 * 対象が変わったら確かめ直し、答えが届くまでは出さない。古い対象への答えは捨てる。確かめられないときは出さない。
 * 表示だけの判定で、権限はサーバーが毎回確かめる。
 * @param {object} deps
 * @param {(target:string) => Promise<boolean>} deps.check
 * @param {() => void} [deps.onChange] 答えが変わったとき(メニューを描き直す)
 * @param {boolean} [deps.active] 公開の設定(既定 STICKER_VIEWER_ENABLED。false の間は問い合わせもしない)
 */
export function createStickerAvailability({ check, onChange = () => {}, active = STICKER_VIEWER_ENABLED }) {
  let key = null, enabled = false, seq = 0;
  const reset = () => { key = null; enabled = false; seq += 1; };
  return {
    /** 今の対象でメニューを出すか */
    of(target) {
      if (!active || typeof target !== "string" || !target) { if (key !== null) reset(); return false; }
      if (target !== key) {
        reset();
        key = target;
        const mine = seq;
        Promise.resolve().then(() => check(target)).then(v => v === true, () => false).then((ok) => {
          if (mine !== seq || key !== target || !ok) return;
          enabled = true;
          onChange();
        });
      }
      return enabled;
    },
    /** 覚えた答えを捨てる(ログアウト・会社の入り直し) */
    reset
  };
}

/** 既定の期間(直近4週)の日数 */
export const DEFAULT_PERIOD_DAYS = 28;

const JST_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

const toMs = (v) => (typeof v === "number" ? v : Date.parse(v));
const jst = (ms) => new Date(ms + JST_MS);
const pad = (n) => String(n).padStart(2, "0");

/** 日本時間の日付(YYYY-MM-DD) */
export const jstDate = (ms) => jst(ms).toISOString().slice(0, 10);

/** 既定の期間(今日を含む直近4週。日本時間) */
export function defaultPeriod(nowMs) {
  return { from: jstDate(nowMs - (DEFAULT_PERIOD_DAYS - 1) * DAY_MS), to: jstDate(nowMs) };
}

/** 日付の見出し「11/4(火)」。今年以外は年も付ける */
export function dayLabel(date, nowMs) {
  const d = new Date(`${date}T00:00:00Z`);
  const year = d.getUTCFullYear() === jst(nowMs).getUTCFullYear() ? "" : `${d.getUTCFullYear()}/`;
  return `${year}${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEK[d.getUTCDay()]})`;
}

/** 時刻「10:32」(日本時間) */
export function timeLabel(value) {
  const d = jst(toMs(value));
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 最終手術日の表示「11/4の手術分まで」。今年以外は年も付ける */
export function surgeryLabel(date, nowMs) {
  if (!date) return "";
  const [y, m, d] = date.split("-").map(Number);
  return `${y === jst(nowMs).getUTCFullYear() ? "" : `${y}/`}${m}/${d}の手術分まで`;
}

/** 撮影セッションの枠の見出し「10:32〜10:35 3枚 ・ 11/4の手術分まで」(最終手術日は入力があるときだけ) */
export function sessionLabel(session, nowMs) {
  const from = timeLabel(session.from), to = timeLabel(session.to);
  const time = from === to ? from : `${from}〜${to}`;
  const surgery = surgeryLabel(session.lastSurgeryDate, nowMs);
  return `${time} ${session.count}枚${surgery ? ` ・ ${surgery}` : ""}`;
}

/**
 * 一覧の表示: 送信日 → 医療機関 → 撮影セッション。送信日は新しい順で、セッションの中は送信順。
 * 送信日の中は最終手術日の新しい順で、同じ手術日は撮影の新しい順。手術日が未入力のセッションは、入力のあるものの下に撮影の新しい順で並べる。
 * 医療機関のまとまりは、その中で最初に来るセッションの順に並ぶ。
 * @param {Array<{sessionId:string, seq:number, takenAt:string, facilityId:string, facilityName?:string}>} photos
 * @returns {Array<{date:string, facilities:Array<{facilityId:string, facilityName:string, sessions:object[]}>}>}
 */
export function groupForView(photos) {
  const newest = [...photos].sort((a, b) => toMs(b.takenAt) - toMs(a.takenAt));
  const sessions = groupPhotosBySession(newest).sort((a, b) =>
    (b.lastSurgeryDate || "").localeCompare(a.lastSurgeryDate || "") || toMs(b.to) - toMs(a.to));
  const days = new Map();
  for (const session of sessions) {
    const date = jstDate(toMs(session.from));
    const facilityId = session.photos[0].facilityId;
    if (!days.has(date)) days.set(date, new Map());
    const byFacility = days.get(date);
    if (!byFacility.has(facilityId)) byFacility.set(facilityId, { facilityId, facilityName: session.photos[0].facilityName || "", sessions: [] });
    byFacility.get(facilityId).sessions.push(session);
  }
  return [...days].sort(([a], [b]) => b.localeCompare(a)).map(([date, byFacility]) => ({ date, facilities: [...byFacility.values()] }));
}
