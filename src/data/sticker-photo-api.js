/**
 * IOL シール写真(R09)の閲覧の呼び出し。権限はすべてサーバーが確認する(docs/iol-sticker-photo-design.md §8-3)。
 * 一覧・削除は callable の stickerPhotoApi、画像は HTTP の stickerPhotoImage。
 * <img> の src は認証のヘッダーを送れないので、fetch で取得して Blob を返す。画面の外へ URL を持ち出さない。
 */
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined && o[k] !== null && o[k] !== "").map(k => [k, o[k]]));
const QUERY_KEYS = ["from", "to", "cursor"];

/** 画像の取得の URL(第2世代の関数のドメイン) */
export const stickerImageUrl = (projectId, region = "asia-northeast1") => `https://${region}-${projectId}.cloudfunctions.net/stickerPhotoImage`;

/**
 * @param {object} deps
 * @param {object} deps.functions
 * @param {Function} deps.httpsCallable
 * @param {string} deps.imageUrl stickerImageUrl の値
 * @param {() => Promise<string>} deps.getIdToken ログイン中の本人の ID トークン
 * @param {{get:()=>string|null}} [deps.device] ディーラーの確認済みの端末の値(ディーラー画面だけ)
 * @param {typeof fetch} [deps.fetchImpl]
 */
export function createStickerPhotoApi({ functions, httpsCallable, imageUrl, getIdToken, device = null, fetchImpl = (...a) => fetch(...a) }) {
  const call = async (payload) => (await httpsCallable(functions, "stickerPhotoApi")(payload)).data;
  const deviceToken = () => (device ? device.get() : null);

  /** 画像を読む。見えない・ないときは null */
  async function readImage({ facilityId, photoId, size, companyId = null }) {
    const url = `${imageUrl}?${new URLSearchParams({ facility: facilityId, photo: photoId, size })}`;
    const headers = { Authorization: `Bearer ${await getIdToken()}` };
    if (companyId) {
      headers["X-Dealer-Company"] = companyId;
      const token = deviceToken();
      if (token) headers["X-Dealer-Device"] = token;
    }
    const res = await fetchImpl(url, { method: "GET", headers, cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`image ${res.status}`);
    return res.blob();
  }

  return {
    /** 施設設定「IOLシール写真」の呼び出し(data/sticker-settings-api.js へ渡す。受注閲覧の許可とは別の関数) */
    settingsCall: call,
    /** 閲覧画面の部品へ渡す、医療機関用の読み出し(施設は1つ) */
    facilitySource: ({ facilityId, facilityName, canDelete }) => ({
      loadFacilities: async () => [{ facilityId, name: facilityName }],
      listPage: (id, q) => call({ action: "list", facilityId: id, ...pick(q, QUERY_KEYS) }),
      readImage,
      deletePhoto: canDelete ? (id, photoId) => call({ action: "delete", facilityId: id, photoId }) : null
    }),
    /** ディーラー用の読み出し(共有を許可された施設だけ。削除はない) */
    dealerSource: ({ companyId }) => {
      const base = () => ({ action: "dealerList", companyId, ...pick({ deviceToken: deviceToken() }, ["deviceToken"]) });
      return {
        loadFacilities: async () => (await call(base())).facilities,
        listPage: (id, q) => call({ ...base(), facilityId: id, ...pick(q, QUERY_KEYS) }),
        readImage: (a) => readImage({ ...a, companyId }),
        deletePhoto: null
      };
    }
  };
}
