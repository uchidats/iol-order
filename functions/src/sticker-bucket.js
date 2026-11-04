/**
 * IOL シール写真の保存先(専用の GCS バケット)の小さな部品。テストは同じ形の偽物に差し替える(docs/iol-sticker-photo-design.md §8-4)。
 * バケットは Firebase に連携せず、クライアントには権限がない。読み書きは Functions だけが行う。
 *
 * @param {() => import("@google-cloud/storage").Bucket} getBucket 使うときに取得する(全関数の起動時に触らない)
 */
const PAGE_SIZE = 500;

export function createStickerBucket(getBucket) {
  const file = (name) => getBucket().file(name);
  return {
    /** 保存する。キャッシュさせず、1回の要求で書く(大きさは 15MB まで) */
    save: (name, bytes) => file(name).save(bytes, { resumable: false, contentType: "image/jpeg", metadata: { cacheControl: "private, no-store" } }),
    /** 読み出す。なければ null */
    async read(name) {
      try {
        const [bytes] = await file(name).download();
        return bytes;
      } catch (e) {
        if (e && e.code === 404) return null;
        throw e;
      }
    },
    /** 消す。なければ何もしない */
    delete: (name) => file(name).delete({ ignoreNotFound: true }),
    /** 1ページの一覧 */
    async list({ pageToken = null } = {}) {
      const [files, next] = await getBucket().getFiles({ autoPaginate: false, maxResults: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) });
      return {
        items: files.map(f => ({ name: f.name, updatedMs: Date.parse(f.metadata.updated || f.metadata.timeCreated) })),
        nextPageToken: next?.pageToken ?? null
      };
    }
  };
}
