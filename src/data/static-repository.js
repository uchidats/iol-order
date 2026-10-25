import { IOL_MODELS } from "./iol-models.js";

// 固定データ(施設・注文者)で動く静的モードは廃止した(Firebase の設定がない場合はエラー表示。src/main.js)。

/**
 * 採用IOLからフォームに表示するモデル定義を解決する
 */
export function resolveAdoptedModels(adoptedIols, catalog = IOL_MODELS) {
  return adoptedIols
    .filter(a => a.enabled)
    .map(a => catalog.find(m => m.id === a.catalogIolId))
    .filter(Boolean);
}
