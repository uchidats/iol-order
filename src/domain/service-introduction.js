/**
 * サービス紹介「IOL Orderについて」の閲覧範囲。当面は運営者(platformAdmin)だけ。
 * 本文は Firestore(platformContent/serviceIntroduction)にあり、Rules でも platformAdmin だけが読める(画面の表示の制御だけに頼らない)。
 * 一般公開は、運営者の承認後に、この値と firestore.rules の introductionPublic() を両方 true にして公開する(tests/manual.test.js が両者の一致を確認する)。
 */
export const INTRODUCTION_PUBLIC_RELEASE = false;

/** メニューの表示・画面を開くかどうか(表示だけの判定。本文を読めるかは Rules が決める) */
export const canViewIntroduction = ({ isPlatformAdmin } = {}) => INTRODUCTION_PUBLIC_RELEASE || isPlatformAdmin === true;

/** URL のハッシュ */
export const INTRODUCTION_HASH = "#about";
