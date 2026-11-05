/**
 * 看護師の撮影画面の通信(docs/iol-sticker-photo-design.md §8)。Firebase SDK は読み込まず、fetch だけで呼ぶ。
 * - 確認: callable の stickerEntryApi(ログインなし)を、callable の形式(POST {data} → {result}|{error})で呼ぶ
 * - 保存: HTTP の stickerPhotoUpload に画像のバイト列をそのまま PUT する
 * コード・チケット・画像はどこにも保存しない。App Check を必須にするときは、確認の要求にトークンを足す(docs/app-check.md)。
 */
const REGION = "asia-northeast1";

/** 関数の URL の先頭(第2世代の関数のドメイン) */
export const stickerFunctionsBase = (projectId) => `https://${REGION}-${projectId}.cloudfunctions.net`;

/**
 * @param {object} deps
 * @param {string} deps.baseUrl stickerFunctionsBase の値
 * @param {typeof fetch} [deps.fetchImpl]
 */
export function createCaptureApi({ baseUrl, fetchImpl = (...a) => fetch(...a) }) {
  return {
    /**
     * @returns {Promise<{ok:true, result:object}|{ok:false, reason:"failed"|"blocked"|"network"}>}
     *   サーバーは失敗の理由(トークン・コード)を区別しない。画面も区別しない
     */
    async verify({ token, code }) {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/stickerEntryApi`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: { token, code } }), cache: "no-store" });
      } catch { return { ok: false, reason: "network" }; }
      const body = await res.json().catch(() => null);
      if (res.ok && body && body.result) return { ok: true, result: body.result };
      const status = body && body.error && body.error.status;
      if (status === "RESOURCE_EXHAUSTED") return { ok: false, reason: "blocked" };
      if (status === "PERMISSION_DENIED") return { ok: false, reason: "failed" };
      return { ok: false, reason: "network" };
    },

    /**
     * 画像を保存する。通信の失敗は status: null
     * @returns {Promise<{status:number|null, body:object|null}>}
     */
    async upload({ ticket, uploadId, sha256, blob, lastSurgeryDate, blurWarned }) {
      const headers = { "Content-Type": "image/jpeg", "X-Sticker-Ticket": ticket, "X-Upload-Id": uploadId, "X-Content-Sha256": sha256 };
      if (lastSurgeryDate) headers["X-Last-Surgery-Date"] = lastSurgeryDate;
      if (blurWarned) headers["X-Blur-Warned"] = "1";
      try {
        const res = await fetchImpl(`${baseUrl}/stickerPhotoUpload`, { method: "PUT", headers, body: blob, cache: "no-store" });
        return { status: res.status, body: await res.json().catch(() => null) };
      } catch { return { status: null, body: null }; }
    }
  };
}

/** 画像の SHA-256(16進の小文字) */
export async function sha256OfBlob(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
