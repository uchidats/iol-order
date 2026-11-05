/**
 * IOL シール写真(R09。docs/iol-sticker-photo-design.md)の画面側の純粋な処理。
 * コードの形式・上限の定数・最終手術日・QR の URL・撮影セッションのまとまり。
 * ここの確認は利用者への案内のためで、認可・制限の判定はサーバー(functions/src/sticker-photo.js)が行う。
 * 同じ値をサーバーにも置き、一致は tests/sticker-photo.test.js で確かめる。
 */

/** 上限(§8-2)。画像の大きさはブラウザとサーバーで同じ値。枚数と容量は不正利用を止めるための安全上限 */
export const STICKER_LIMITS = Object.freeze({
  imageBytes: 15 * 1024 * 1024,
  sessionPhotos: 100,
  dailyPhotos: 300,
  dailyBytes: 3 * 1024 * 1024 * 1024,
  ticketMinutes: 30,
  listPageSize: 60
});

/** アクセスコードの桁数(半角数字) */
export const ACCESS_CODE_DIGITS = Object.freeze({ min: 6, max: 12 });

/** 台紙の注意事項の最大の文字数(サーバーと同じ値) */
export const SHEET_NOTE_MAX_LENGTH = 150;

/** 台紙の注意事項の正規化(改行を LF にそろえ、末尾の空白を落とす) */
export const normalizeSheetNote = (value) => String(value).replace(/\r\n?/g, "\n").trimEnd();

/** 撮影ページの URL。QR にはこの URL と入口トークンだけを含める */
export const STICKER_ENTRY_URL = "https://iol.medconf.jp/sticker.html";

/** これより長辺が短い映像は、確認画面に解像度の注意を出す(暫定。iPhone の検証で確定。送信は止めない) */
export const LOW_RESOLUTION_LONG_SIDE = 3000;

/** 上限に達したときの文言(どの上限かは出さない) */
export const LIMIT_MESSAGE = "送信の上限に達しました。時間をおいてお試しください";

const JST_MS = 9 * 60 * 60 * 1000;
const ENTRY_TOKEN = /^[A-Za-z0-9_-]{22}$/;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 半角数字6〜12桁か */
export function isAccessCode(value) {
  return typeof value === "string" && /^[0-9]{6,12}$/.test(value);
}

/** 入口トークンの形式か(128 ビットの乱数の base64url) */
export const isEntryToken = (value) => typeof value === "string" && ENTRY_TOKEN.test(value);

/** アップロードIDの形式か(crypto.randomUUID() の UUID v4。小文字だけ) */
export const isUploadId = (value) => typeof value === "string" && UPLOAD_ID.test(value);

/** 撮影ページの URL(QR の中身) */
export function buildEntryUrl(token, base = STICKER_ENTRY_URL) {
  if (!isEntryToken(token)) throw new Error("入口トークンの形式が違います");
  return `${base}#f=${token}`;
}

/** location.hash から入口トークンを取り出す。ない・形式が違うときは null */
export function parseEntryToken(hash) {
  const m = /^#f=(.*)$/.exec(String(hash ?? ""));
  return m && isEntryToken(m[1]) ? m[1] : null;
}

/** 日本時間の日付(YYYY-MM-DD) */
export const jstDateOf = (ms) => new Date(ms + JST_MS).toISOString().slice(0, 10);

/** 今回の最終手術日として受け付けられるか(空は別に扱う)。実在する日付で、日本時間の今日より後でないこと */
export function isLastSurgeryDate(value, nowMs) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return false;
  return value <= jstDateOf(nowMs);
}

/** 映像の解像度が低いか(確認画面の注意の判定) */
export function isLowResolution(width, height) {
  return Math.max(width, height) < LOW_RESOLUTION_LONG_SIDE;
}

/**
 * 写真の一覧を撮影セッションの枠にまとめる(§8-2)。枠は最初に現れた順(一覧は takenAt の降順)、枠の中は seq の順。
 * @param {Array<{sessionId:string, seq:number, takenAt:string|number, lastSurgeryDate?:string|null}>} photos
 * @returns {Array<{sessionId:string, photos:object[], count:number, from:string|number, to:string|number, lastSurgeryDate:string|null}>}
 */
export function groupPhotosBySession(photos) {
  const groups = new Map();
  for (const photo of photos) {
    if (!groups.has(photo.sessionId)) groups.set(photo.sessionId, []);
    groups.get(photo.sessionId).push(photo);
  }
  const time = (photo) => new Date(photo.takenAt).getTime();
  return [...groups].map(([sessionId, items]) => {
    const sorted = [...items].sort((a, b) => a.seq - b.seq);
    const byTime = [...items].sort((a, b) => time(a) - time(b));
    return {
      sessionId,
      photos: sorted,
      count: sorted.length,
      from: byTime[0].takenAt,
      to: byTime[byTime.length - 1].takenAt,
      lastSurgeryDate: sorted[0].lastSurgeryDate ?? null
    };
  });
}
