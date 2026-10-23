import { IOL_MODELS } from "./iol-models.js";

export const DEFAULT_FACILITY_ID = "tachikawa-hospital";

const FACILITY = {
  id: DEFAULT_FACILITY_ID,
  name: "国家公務員共済組合連合会 立川病院 眼科",
  status: "active"
};

// 既存フォームの注文者（Google Form準拠）
const ORDERER_NAMES = ["内田", "角田", "利根川", "秋冨", "木村"];

/**
 * 現行の固定データを返す FacilityRepository 実装
 * @returns {import("./schema.js").FacilityRepository}
 */
export function createStaticRepository() {
  return {
    async getFacility() {
      return FACILITY;
    },
    async listOrderers(facilityId = DEFAULT_FACILITY_ID) {
      return ORDERER_NAMES.map((name, i) => ({
        id: `orderer-${i + 1}`,
        facilityId,
        name,
        active: true
      }));
    },
    async listAdoptedIols(facilityId = DEFAULT_FACILITY_ID) {
      return IOL_MODELS.map(m => ({
        id: m.displayName,
        facilityId,
        catalogIolId: m.displayName,
        enabled: true
      }));
    },
    async listDealers() {
      // 現行フローではディーラー管理なし（発注先はGAS側で決定）
      return [];
    }
  };
}

/**
 * 採用IOLからフォームに表示するモデル定義を解決する
 */
export function resolveAdoptedModels(adoptedIols, catalog = IOL_MODELS) {
  return adoptedIols
    .filter(a => a.enabled)
    .map(a => catalog.find(m => m.displayName === a.catalogIolId))
    .filter(Boolean);
}
