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

/**
 * 施設の「代行入力時の担当医」の設定を読む。未設定・OFF・担当医マスターにいない担当医(削除済みなど)は OFF として扱う
 * @returns {{enabled:boolean, doctorId:string}}
 */
export function readProxyDoctor(raw, doctors) {
  const id = raw && raw.enabled === true && typeof raw.doctorId === "string" ? raw.doctorId : "";
  return id && (doctors || []).some(d => d.id === id) ? { enabled: true, doctorId: id } : { enabled: false, doctorId: "" };
}

/**
 * 注文フォームの担当医の初期値。
 *  1. ログインユーザー本人が担当医(メールアドレスで正確に紐づく。findSelfDoctor)なら本人(施設の設定より優先)
 *  2. 代行入力者(役割 proxy)で、施設の「代行入力時の担当医を初期選択する」が ON なら、その担当医
 *  3. それ以外は未選択(従来どおり)
 * 初期値は新しいレンズの欄にだけ使う(手動で変えた担当医・下書きの復元・「レンズを追加」の引き継ぎは上書きしない。lens-lines.js)
 */
export function initialDoctorId(doctors, user, { role = "", proxyDoctor = null } = {}) {
  const self = findSelfDoctor(doctors, user);
  if (self) return self;
  if (role !== "proxy") return "";
  return readProxyDoctor(proxyDoctor, doctors).doctorId;
}
