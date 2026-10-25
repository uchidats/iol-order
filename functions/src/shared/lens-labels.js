// 【自動複製】src/domain/lens-labels.js の複製。直接編集しない。
// 元ファイルを変更したら `npm run sync:catalog` で更新する(tests/functions-catalog-sync.test.js が不一致を検出する)。
/**
 * IOLモデルの表示用の名前と特徴(バッジ)。
 * 特徴の判定は、マスターの isToric / isMultifocal だけを使う(モデル名の文字列から推測しない)。
 * モデル名に埋め込まれた「（トーリック）」などの表記は、表示時に取り除く(特徴はバッジで示すため、二重にしない)。
 */

// 名前の末尾に付いた、特徴・色を表す括弧書き(全角・半角)は、表示時に取り除く。
// 例: "DIWxxx (トーリック)" / "XXX（多焦点）" / "XXX (多焦点トーリック)" / "MN60MA (イエロー)"。内部のモデルID・発注用の名称(displayName)は変更しない。
const TRAILING_FEATURE = /\s*[（(]\s*(?:(?:多焦点\s*)?(?:トーリック|多焦点)|イエロー)\s*[）)]\s*$/g;

/** メーカー名の接頭辞(「メーカー / 」)と、特徴の括弧書きを取り除いたモデル名 */
export function baseModelName(model) {
  let name = String(model.displayName || model.model || "");
  name = name.replace(/^[^/]+\/\s*/, "");               // メーカー名の接頭辞
  let prev;
  do { prev = name; name = name.replace(TRAILING_FEATURE, ""); } while (name !== prev);
  return name.trim();
}

/** 「メーカー / モデル名」(特徴の括弧書きは含まない) */
export function displayLabel(model) {
  return `${model.manufacturer} / ${baseModelName(model)}`;
}

/** 表示するバッジの文言。多焦点 → トーリックの順(両方あれば2つ) */
export function featureBadges(model) {
  const out = [];
  if (model && model.isMultifocal === true) out.push("多焦点");
  if (model && model.isToric === true) out.push("トーリック");
  return out;
}
