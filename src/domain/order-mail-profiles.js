/**
 * 発注メールの「形式」(施設ごと)。件名・宛名・本文の形式・定型文・署名・発注者への確認メールの有無。
 *
 * - **メールアドレスはここに書かない。** 固定の確認先メールは `confirmationEmails` として、生成時に設定(または引数)から渡す。
 *   ディーラー宛(発注用メール)・固定の確認先・発注者(ログインしたユーザー)宛は、別の概念として扱う(order-mail.js)。
 * - `confirmed: true` は、現行の Google Forms + GAS の形式を再現したものであることを表す(2026-10-25 に利用者から仕様を受領)。
 *   `confirmed: false` の暫定形式は、実送信に使ってはいけない。
 * - 将来は、この形式を施設ごとの設定(Firestore)から読み込めるようにする。今回は設定UIを作らず、コード上の定義だけ。
 * - 担当医への確認メールは対象外。
 */

/** 形式が未確認の暫定(既定)。実送信には使えない */
export const GENERIC_DRAFT_PROFILE = Object.freeze({
  id: "generic-draft", confirmed: false, format: "draft", subject: null, salutationSuffix: " 御中",
  closing: [], signature: [], sendToOrderer: false
});

/** 現行GAS(立川病院)の再現。件名は固定。本文は「質問名: 回答」の列挙 + 定型文 + 署名 */
export const TACHIKAWA_GAS_PROFILE = Object.freeze({
  id: "tachikawa-gas", confirmed: true, format: "gas-questions",
  subject: "【立川病院】IOL注文：ご確認のほどよろしくお願いします",
  salutationSuffix: "御中",
  closing: [
    "大変お世話になっております。",
    "上記の眼内レンズを注文させていただきたく存じます。",
    "お忙しいところ大変恐縮ですが、何卒よろしくお願い申し上げます。"
  ],
  signature: [
    "〒190-8531 東京都立川市錦町4-2-22",
    "国家公務員共済組合連合会　立川病院　眼科"
  ],
  sendToOrderer: true   // Google Forms の回答者(=発注者)のメールアドレスも宛先(To)に含める
});

const BY_FACILITY = Object.freeze({ "tachikawa-hospital": TACHIKAWA_GAS_PROFILE });

/** 施設の形式。定義がない施設は、暫定の既定(実送信不可) */
export function resolveMailProfile(facilityId) {
  return BY_FACILITY[facilityId] || GENERIC_DRAFT_PROFILE;
}
