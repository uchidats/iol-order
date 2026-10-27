import { IOL_MODELS } from "./iol-models.js";

// 固定データ(施設・注文者)で動く静的モードは廃止した(Firebase の設定がない場合はエラー表示。src/main.js)。

/**
 * 採用IOLからフォームに表示するモデル定義を解決する
 */
export function resolveAdoptedModels(adoptedIols, catalog = IOL_MODELS) {
  return adoptedIols
    .filter(a => a.enabled)
    .map(a => {
      const m = catalog.find(x => x.id === a.catalogIolId);
      // 既定ディーラー(採用IOLの dealerId)があれば系列に付ける(注文画面の初期選択用)。マスター自体は変えない
      return m && typeof a.dealerId === "string" && a.dealerId ? { ...m, dealerId: a.dealerId } : m;
    })
    .filter(Boolean);
}
