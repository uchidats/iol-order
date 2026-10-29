// 【自動複製】src/domain/order-mail-profiles.js の複製。直接編集しない。
// 元ファイルを変更したら `npm run sync:catalog` で更新する(tests/functions-catalog-sync.test.js が不一致を検出する)。
/**
 * 発注メールの「形式」(施設ごと)。件名・宛名・本文の形式・定型文・署名・発注者への確認メールの有無。
 *
 * - **メールアドレスはここに書かない。** 固定の確認先メールは `confirmationEmails` として、生成時に設定(または引数)から渡す。
 *   ディーラー宛(発注用メール)・固定の確認先・発注者(ログインしたユーザー)宛は、別の概念として扱う(order-mail.js)。
 * - `confirmed: true` は、現行の Google Forms + GAS の形式を再現したものであることを表す(2026-10-25 に利用者から仕様を受領)。
 *   `confirmed: false` の暫定形式は、実送信に使ってはいけない。
 * - 施設ごとの署名・ディーラーの正式表記は、施設設定(Firestore)から読む(profileFromSettings)。コードには書かない。
 * - 担当医への確認メールは対象外。
 */

/** 形式が未確認の暫定(既定)。実送信には使えない */
export const GENERIC_DRAFT_PROFILE = Object.freeze({
  id: "generic-draft", confirmed: false, format: "draft", subject: null, salutationSuffix: " 御中",
  closing: [], signature: [], sendToOrderer: false
});

/** 現行GASの共通の形式(2026-10-25 に現行GASコードと受信メールで確認)。件名は「【施設名】…」、宛名は「ディーラー名御中」、本文は「質問名: 回答」の列挙 + 定型文 + 署名 */
/** 現行の注文メールの件名の形式(施設名は生成時に入れる) */
export const GAS_SUBJECT_TEMPLATE = "【{facility}】IOL注文：ご確認のほどよろしくお願いします";

export const GAS_CLOSING = Object.freeze([
  "大変お世話になっております。",
  "上記の眼内レンズを注文させていただきたく存じます。",
  "お忙しいところ大変恐縮ですが、何卒よろしくお願い申し上げます。"
]);

/**
 * GAS形式の形式を作る。**施設の住所・署名(signature)は施設ごとの設定**(未指定なら署名なし)。
 * 件名の「施設名」は、生成時に施設名から入れる(固定しない)。
 */
export function createGasProfile({ id, signature = [], dealerDisplayNames = {}, sendToOrderer = true }) {
  return Object.freeze({
    id, confirmed: true, format: "gas-questions",
    subjectTemplate: GAS_SUBJECT_TEMPLATE,
    salutationSuffix: "御中",
    closing: GAS_CLOSING,
    signature: Object.freeze([...signature]),
    signatureConfigured: signature.length > 0,
    // 宛名に使うディーラーの正式表記(キーは facilityDealers のID)。登録データの名称と異なる場合に、登録データを変えずに宛名だけ正式表記にする
    dealerDisplayNames: Object.freeze({ ...dealerDisplayNames }),
    sendToOrderer   // true: Google Forms の回答者(=発注者)のメールアドレスも宛先(To)に含める(旧GASの動作)
  });
}

/** 署名が未設定の施設の既定(GAS形式。住所・署名は出さず、警告を付ける) */
export const DEFAULT_GAS_PROFILE = createGasProfile({ id: "gas-default" });

/** 施設設定(メール)の上限。画面・Rules・サーバーで同じ値を使う(subjectPrefixMax: 発注先ごとの件名の先頭に付ける文字) */
export const MAIL_SETTINGS_LIMITS = Object.freeze({ signatureMax: 500, signatureLines: 10, mailNameMax: 100, subjectPrefixMax: 20 });

/** 件名の先頭に付ける文字に使えない文字(改行・タブなどの制御文字(C0・DEL・C1)・行/段落の区切り)。ヘッダーの注入を防ぐ */
export const SUBJECT_PREFIX_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/**
 * 発注先ごとの「件名の先頭に付ける文字」(任意)。送信時にサーバーが発注先の設定から読む(注文の入力では指定できない)。
 * 空白などは足さず、設定どおりに付ける。使えない文字は除き、上限で切る(保存時は画面・Rules が拒否する。ここは念のため)
 */
export function subjectPrefixOf(dealer) {
  const raw = dealer && typeof dealer.subjectPrefix === "string" ? dealer.subjectPrefix : "";
  return raw.replace(new RegExp(SUBJECT_PREFIX_FORBIDDEN.source, "g"), "").slice(0, MAIL_SETTINGS_LIMITS.subjectPrefixMax);
}

/** 施設設定の画面に出す件名の例(現行の形式「【施設名】IOL注文：…」に、発注先の先頭の文字を付けたもの) */
export function dealerSubjectExample({ facilityName = "", subjectPrefix = "" } = {}) {
  const facility = String(facilityName ?? "").replace(/[\r\n]+/g, " ").trim();
  return subjectPrefixOf({ subjectPrefix }) + GAS_SUBJECT_TEMPLATE.replace("{facility}", facility || "施設名");
}

/** 署名(施設設定の自由記述)を行の配列にする。前後の空行は除き、最大行数まで */
export function signatureLines(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n").map(l => l.replace(/\s+$/, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(0, MAIL_SETTINGS_LIMITS.signatureLines);
}

/**
 * 施設設定から形式を作る(コードに施設ごとの署名・正式表記を書かない)。
 * - 署名: 施設設定 `settings/mail` の signature
 * - 宛名の正式表記: 各ディーラーの mailName(未設定なら登録名)
 * - 宛先はディーラーの発注用メールだけ(発注者を To に入れない。控えは施設設定の「注文控えメール」で別に送る)
 * @param {{signature?:string}|null} mailSettings
 * @param {Array<{id:string, mailName?:string}>|Record<string,{mailName?:string}>} dealers
 */
export function profileFromSettings(mailSettings, dealers = []) {
  const list = Array.isArray(dealers) ? dealers : Object.entries(dealers || {}).map(([id, d]) => ({ id, ...d }));
  const names = {};
  for (const d of list) {
    const n = typeof d.mailName === "string" ? d.mailName.replace(/[\r\n]+/g, " ").trim() : "";
    if (n) names[d.id] = n.slice(0, MAIL_SETTINGS_LIMITS.mailNameMax);
  }
  return createGasProfile({ id: "facility-settings", signature: signatureLines(mailSettings && mailSettings.signature), dealerDisplayNames: names, sendToOrderer: false });
}
