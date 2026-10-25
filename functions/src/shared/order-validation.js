// 【自動複製】src/domain/order-validation.js の複製。直接編集しない。
// 元ファイルを変更したら `npm run sync:catalog` で更新する(tests/functions-catalog-sync.test.js が不一致を検出する)。
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value) {
  return EMAIL_REGEX.test(value);
}
