/**
 * ログインユーザー本人が担当医マスターの医師に紐づいているかを調べる(担当医の初期値用。表示の初期値だけで、注文の権限・内容には影響しない)。
 *
 * - 紐づけは、**認証済みアカウントのメールアドレス**と、担当医マスターの `email` が一致するかで判定する。氏名だけでは判定しない。
 *   (担当医マスターの `email` は任意項目。未登録の医師・紐づかないユーザー(CO・看護師・事務職員など)は、従来どおり初期値なし)
 * - メールアドレスの確認が済んでいない(emailVerified === false)アカウントは紐づけない。
 * - 同じメールアドレスの医師が複数いて1人に決められない場合は、勝手に決めない(初期値なし)。
 * - ログインユーザー(注文者)と担当医(執刀医)は別の情報。ここで決めるのは、担当医のプルダウンの初期値だけ(変更できる)。
 */
const norm = (s) => String(s ?? "").normalize("NFKC").trim().toLowerCase();

/**
 * @param {Array<{id:string, name?:string, email?:string}>} doctors 施設の担当医マスター
 * @param {{email?:string|null, emailVerified?:boolean}|null} user ログインユーザー(認証情報)
 * @returns {string} 本人の担当医ID。紐づかない・決められないときは ""
 */
export function findSelfDoctor(doctors, user) {
  const email = norm(user && user.email);
  if (!email || (user && user.emailVerified === false)) return "";
  const hits = (doctors || []).filter(d => norm(d.email) === email);
  return hits.length === 1 ? hits[0].id : "";
}
