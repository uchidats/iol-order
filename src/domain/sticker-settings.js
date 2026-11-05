/**
 * 施設設定「IOLシール写真」の表示用の処理(純粋関数。docs/iol-sticker-photo-design.md §4)。権限の判定はしない(すべてサーバーが確認する)。
 */
import { ACCESS_CODE_DIGITS, isAccessCode } from "./sticker-photo.js";
import { MEMBER_ROLES, isManagerRole } from "./member-admin.js";

/**
 * 施設設定にセクションを出すか。false の間は表示しない(撮影と配備の準備ができて、運営者が承認してから true にする)。
 * 表示だけの設定で、操作の権限は stickerPhotoApi が毎回確認する。
 */
export const STICKER_SETTINGS_ENABLED = true;

/**
 * アクセスコードの変更・QR の作り直し・ディーラーへの共有の操作を出すか(管理者・副管理者だけ)。
 * 注文者・代理入力者には、コードの状態と、QR の表示・印刷、台紙の印刷だけを出す。表示だけの判定で、サーバーも同じ規則で拒否する
 */
export const canManageStickerSettings = (role) => isManagerRole(role);

/**
 * メニュー「施設設定」を出すか。管理者・副管理者は従来どおり常に出す。
 * 注文者・代理入力者には、「IOLシール写真」の欄を使える施設(公開の設定が true で、サーバーが使えると答えた施設)だけに出す
 */
export function showSettingsMenu({ role, stickerAvailable = false, enabled = STICKER_SETTINGS_ENABLED }) {
  if (isManagerRole(role)) return true;
  return enabled === true && stickerAvailable === true && MEMBER_ROLES.includes(role);
}

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

/**
 * コードの確認が停止中のときの案内(誤ったコードの入力が続いたとき)。停止していなければ空。
 * 復旧はコードの変更(すぐに再開)。心当たりがなければ QR も作り直す。操作できない人(注文者・代理入力者)には、管理者へ知らせる案内にする
 */
export function verifyLockNotice({ verifyBlockedUntil } = {}, { canManage = true } = {}) {
  const ms = Date.parse(verifyBlockedUntil);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms + JST_MS);
  const head = `誤ったコードの入力が続いたため、撮影画面でのコードの確認を停止しています(${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} まで)。`;
  return head + (canManage ? "アクセスコードを変更すると、すぐに再開できます。心当たりがないときは、QRコードも作り直してください。" : "施設の管理者・副管理者にお知らせください。");
}

/** 写真を共有できる発注先(運営者が会社に関連付けたものだけ)。受注閲覧の許可の有無は関係しない */
export const shareableDealers = (dealers) => (dealers || []).filter(d => d && d.linked === true);

/** サーバーが作った QR の SVG を、画像として表示する URL(img の中のスクリプトは動かない) */
export const qrImageUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
