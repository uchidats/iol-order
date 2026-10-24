/**
 * データモデル定義（JSDoc型）
 * Firestore導入時のコレクション構造は docs/firestore-data-model.md を参照。
 * 施設・注文者・採用IOL・ディーラーはそれぞれ独立したデータとして扱い、IDで参照する。
 */

/**
 * @typedef {Object} Facility 施設
 * @property {string} id
 * @property {string} name
 * @property {"pending"|"active"|"suspended"} status
 */

/**
 * @typedef {Object} Orderer 担当医（施設のサブデータ。旧「注文者」。コレクション名は互換性のため orderers）
 * @property {string} id
 * @property {string} facilityId
 * @property {string} name
 * @property {string} [email]
 */

/**
 * @typedef {Object} Dealer ディーラー（発注先）
 * @property {string} id
 * @property {string} name
 * @property {string[]} orderEmails 発注先メールアドレス
 */

/**
 * @typedef {Object} AdoptedIol 施設ごとの採用IOL（カタログ参照 + 発注先）
 * @property {string} id
 * @property {string} facilityId
 * @property {string} catalogIolId IOLカタログ（IOL_MODELS相当）のID
 * @property {string} [dealerId] 発注先ディーラー
 * @property {boolean} enabled
 */

/**
 * 施設単位のデータ取得インターフェース。
 * 現在は StaticRepository（固定データ）、将来は FirestoreRepository に差し替える。
 * UI層はこのインターフェースだけに依存する。
 *
 * @typedef {Object} FacilityRepository
 * @property {(facilityId: string) => Promise<Facility>} getFacility
 * @property {(facilityId: string) => Promise<Orderer[]>} listOrderers
 * @property {(facilityId: string) => Promise<AdoptedIol[]>} listAdoptedIols
 * @property {(facilityId: string) => Promise<Dealer[]>} listDealers
 */

export {};
