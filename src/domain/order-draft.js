/**
 * 入力途中の注文の下書き(localStorage に自動保存・復元する内容)。純粋関数。
 *
 * - 保存するのは、画面で選んだ値(モデル・度数・枚数(と利用者が変えたか)・トーリック/多焦点・手術日・担当医ID・発注先ID・備考・レンズの数)だけ。
 *   患者の個人情報・認証情報(トークン等)は保存しない。ログインユーザー・施設ごとに別々のキーで保存する(他の人の下書きは読まない)。
 * - 担当医・発注先は ID だけ。復元時に、施設のマスターに今も存在するものだけを使う(lens-lines.js)。
 * - 形式が不正・古い(14日以上前)・版が違う下書きは、復元せず捨てる。保存の形式が壊れていても注文画面は動く。
 */

export const DRAFT_VERSION = 1;
export const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_LINES = 20;               // 注文の明細の上限(サーバーと同じ)
const NOTES_MAX = 1000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** ログインユーザー・施設ごとの保存キー */
export const draftKey = (uid, facilityId) => `iol-order-draft:v${DRAFT_VERSION}:${uid}:${facilityId}`;

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

/** 1明細の入力状態を、保存・復元してよい形に整える(不明な項目は捨てる) */
export function sanitizeLineState(s) {
  const x = s && typeof s === "object" ? s : {};
  const qty = Number(x.quantity);
  return {
    toric: x.toric === true,
    multifocal: x.multifocal === true,
    modelKey: str(x.modelKey, 200),
    power: str(x.power, 12),
    quantity: qty === 1 || qty === 2 ? qty : 1,
    quantityManual: x.quantityManual === true,   // 枚数を利用者が変えたか(復元後も、チェックの操作で上書きしない)
    date: DATE.test(str(x.date, 10)) ? x.date : "",
    doctorId: ID.test(str(x.doctorId, 128)) ? x.doctorId : "",
    dealerId: ID.test(str(x.dealerId, 128)) ? x.dealerId : ""
  };
}

/** 保存する下書き */
export function buildDraft({ lines, notes, now = Date.now() }) {
  return {
    v: DRAFT_VERSION,
    savedAt: now,
    lines: (Array.isArray(lines) ? lines : []).slice(0, MAX_LINES).map(sanitizeLineState),
    notes: str(notes, NOTES_MAX)
  };
}

/** 入力が実質的に空か(空なら下書きを保存せず、残っていれば消す)。担当医・発注先の初期値や、枚数の既定(1枚)だけでは「入力あり」にしない */
export function isEmptyDraft(d) {
  if (!d) return true;
  if (d.notes && d.notes.trim()) return false;
  if (d.lines.length !== 1) return d.lines.length === 0;
  const l = d.lines[0];
  return !(l.toric || l.multifocal || l.modelKey || l.power || l.date || l.quantity === 2);
}

/** 保存されていた文字列を、下書きとして読む。使えなければ null */
export function parseDraft(text, now = Date.now()) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== "object" || raw.v !== DRAFT_VERSION || !Array.isArray(raw.lines)) return null;
  const savedAt = Number(raw.savedAt);
  if (!Number.isFinite(savedAt) || now - savedAt > DRAFT_MAX_AGE_MS || savedAt - now > 24 * 60 * 60 * 1000) return null;
  const draft = buildDraft({ lines: raw.lines, notes: raw.notes, now: savedAt });
  return draft.lines.length ? draft : null;
}
