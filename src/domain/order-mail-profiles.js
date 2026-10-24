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

/** 現行GASの共通の形式(2026-10-25 に現行GASコードと受信メールで確認)。件名は「【施設名】…」、宛名は「ディーラー名御中」、本文は「質問名: 回答」の列挙 + 定型文 + 署名 */
export const GAS_CLOSING = Object.freeze([
  "大変お世話になっております。",
  "上記の眼内レンズを注文させていただきたく存じます。",
  "お忙しいところ大変恐縮ですが、何卒よろしくお願い申し上げます。"
]);

/**
 * GAS形式の形式を作る。**施設の住所・署名(signature)は施設ごとの設定**(未指定なら署名なし)。
 * 件名の「施設名」は、生成時に施設名から入れる(固定しない)。
 */
export function createGasProfile({ id, signature = [] }) {
  return Object.freeze({
    id, confirmed: true, format: "gas-questions",
    subjectTemplate: "【{facility}】IOL注文：ご確認のほどよろしくお願いします",
    salutationSuffix: "御中",
    closing: GAS_CLOSING,
    signature: Object.freeze([...signature]),
    signatureConfigured: signature.length > 0,
    sendToOrderer: true   // Google Forms の回答者(=発注者)のメールアドレスも宛先(To)に含める
  });
}

/** 立川病院の署名(施設の情報。他の施設には使わない) */
export const TACHIKAWA_GAS_PROFILE = createGasProfile({
  id: "tachikawa-gas",
  signature: ["〒190-8531 東京都立川市錦町4-2-22", "国家公務員共済組合連合会　立川病院　眼科"]
});

/** 署名が未設定の施設の既定(GAS形式。住所・署名は出さず、警告を付ける) */
export const DEFAULT_GAS_PROFILE = createGasProfile({ id: "gas-default" });

const BY_FACILITY = Object.freeze({ "tachikawa-hospital": TACHIKAWA_GAS_PROFILE });

/** 施設の形式。署名の定義がない施設は、署名なしのGAS形式(立川病院の住所・署名は使わない) */
export function resolveMailProfile(facilityId) {
  return BY_FACILITY[facilityId] || DEFAULT_GAS_PROFILE;
}
