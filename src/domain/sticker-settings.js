/**
 * 施設設定「IOLシール写真」の表示用の処理(純粋関数。docs/iol-sticker-photo-design.md §4)。権限の判定はしない(すべてサーバーが確認する)。
 */
import { ACCESS_CODE_DIGITS, isAccessCode } from "./sticker-photo.js";

/**
 * 施設設定にセクションを出すか。false の間は表示しない(撮影と配備の準備ができて、運営者が承認してから true にする)。
 * 表示だけの設定で、操作の権限は stickerPhotoApi が毎回確認する。
 */
export const STICKER_SETTINGS_ENABLED = false;

/** 自動で作るコードの桁数 */
export const GENERATED_CODE_DIGITS = 8;

const JST_MS = 9 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");

/** 入力のエラーの文言。問題がなければ空 */
export function accessCodeError(value) {
  return isAccessCode(value) ? "" : `アクセスコードは半角数字${ACCESS_CODE_DIGITS.min}〜${ACCESS_CODE_DIGITS.max}桁で入力してください`;
}

/**
 * アクセスコードを乱数で作る。偏りが出ないよう、10 の倍数に収まらない値は捨てて引き直す。
 * @param {(array:Uint32Array) => Uint32Array} [fill] 乱数の取得(既定は crypto.getRandomValues)
 */
export function generateAccessCode(fill = (a) => crypto.getRandomValues(a), digits = GENERATED_CODE_DIGITS) {
  const limit = Math.floor(0x100000000 / 10) * 10;
  let code = "";
  while (code.length < digits) {
    for (const v of fill(new Uint32Array(digits))) {
      if (v < limit && code.length < digits) code += String(v % 10);
    }
  }
  return code;
}

/** アクセスコードの状態の表示「設定済み(2026/11/03 変更)」「未設定」。コードそのものは扱わない */
export function accessCodeStatus({ accessCodeSet, accessCodeUpdatedAt }) {
  if (!accessCodeSet) return "未設定";
  const ms = Date.parse(accessCodeUpdatedAt);
  if (Number.isNaN(ms)) return "設定済み";
  const d = new Date(ms + JST_MS);
  return `設定済み(${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} 変更)`;
}

/** 写真を共有できる発注先(運営者が会社に関連付けたものだけ)。受注閲覧の許可の有無は関係しない */
export const shareableDealers = (dealers) => (dealers || []).filter(d => d && d.linked === true);

/** サーバーが作った QR の SVG を、画像として表示する URL(img の中のスクリプトは動かない) */
export const qrImageUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
