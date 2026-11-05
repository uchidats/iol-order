/**
 * 看護師の撮影画面の流れ(DOM に触らない。docs/iol-sticker-photo-design.md §3)。画面は state を描くだけ。
 * コード・チケット・写真はこのオブジェクトのメモリだけに置き、端末には保存しない。
 *  - チケットは画面へ渡さない。コードは確認の後に持たない
 *  - アップロードIDは写真ごとに1回だけ作り、再送・コードの再入力の後も同じ値を使う
 *  - 送信がチケットの期限切れで失敗したら、写真を残してコード入力へ戻し、確認の後に同じIDで自動で再送する
 */
import { STICKER_LIMITS } from "../domain/sticker-photo.js";
import { MESSAGES, UPLOAD_RETRY_DELAYS, classifyUpload, surgeryDateError } from "../domain/sticker-capture.js";

/**
 * @param {object} deps
 * @param {{verify:Function, upload:Function}} deps.api data/sticker-capture-api.js
 * @param {string|null} deps.token 入口トークン(URL から読んだ値。無効なら null)
 * @param {(blob:Blob) => Promise<string>} deps.sha256
 * @param {() => string} [deps.newUploadId]
 * @param {() => number} [deps.now]
 * @param {(ms:number) => Promise<void>} [deps.sleep]
 * @param {(state:object) => void} [deps.onChange]
 */
export function createCaptureController({ api, token, sha256, newUploadId = () => crypto.randomUUID(), now = Date.now,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)), onChange = () => {} }) {
  let ticket = null, expiresAt = 0;
  let resume = false;    // コードの再入力の後に、残した写真を自動で再送する
  let gen = 0;           // 「終了」の後に届いた結果を捨てる
  const state = {
    screen: token ? "code" : "no-token",   // no-token / code / camera / review / done
    busy: false, sending: false, error: "", notice: "", canResend: false,
    facilityName: "", last: null, sentCount: 0,
    surgeryDate: "", surgeryLocked: false,
    photo: null,        // { blob, width, height, blurWarned, uploadId, sha256 }
    done: null          // { takenAt, count }
  };
  const emit = () => onChange(state);
  const set = (patch) => { Object.assign(state, patch); emit(); };

  function needCode() {
    ticket = null;
    resume = true;
    set({ screen: "code", sending: false, error: "", notice: MESSAGES.reenterCode, canResend: false });
  }

  function succeeded(body) {
    const created = body.created === true;
    const date = body.lastSurgeryDate ?? null;
    state.surgeryDate = date || "";
    state.surgeryLocked = true;   // サーバーの値にそろえる(セッションの間は変更しない)
    if (created) {
      state.sentCount += 1;
      state.last = { lastSentAt: body.takenAt, lastSurgeryDate: date };
    }
    set({ screen: "done", sending: false, error: "", notice: "", canResend: false, photo: null, done: { takenAt: body.takenAt, count: state.sentCount } });
  }

  /** 送信。通信の失敗は同じアップロードIDで自動で再送し、それでも失敗したら [再送信] を出す */
  async function send() {
    const photo = state.photo;
    if (!photo || state.sending) return;
    const dateError = state.surgeryLocked ? "" : surgeryDateError(state.surgeryDate, now());
    if (dateError) return set({ error: dateError });
    if (photo.blob.size > STICKER_LIMITS.imageBytes) return set({ error: MESSAGES.tooLarge, canResend: false });
    if (!ticket || now() >= expiresAt) return needCode();
    const myGen = gen;
    set({ sending: true, error: "", notice: "", canResend: false });
    photo.sha256 ??= await sha256(photo.blob);
    for (let attempt = 0; ; attempt += 1) {
      const r = await api.upload({
        ticket, uploadId: photo.uploadId, sha256: photo.sha256, blob: photo.blob, lastSurgeryDate: state.surgeryDate || null, blurWarned: photo.blurWarned === true
      });
      if (myGen !== gen) return;
      const c = classifyUpload(r.status, r.body);
      if (c.kind === "ok") return succeeded(r.body);
      if (c.kind === "ticket") return needCode();
      if (c.kind === "rejected") return set({ sending: false, error: c.message, canResend: false });
      if (attempt >= UPLOAD_RETRY_DELAYS.length) return set({ sending: false, error: MESSAGES.sendFailed, canResend: true });
      await sleep(UPLOAD_RETRY_DELAYS[attempt]);
      if (myGen !== gen) return;
    }
  }

  return {
    state,
    /** コードの確認 = 撮影セッションの開始。コードは保持しない */
    async verify(code) {
      if (state.busy || !token) return;
      set({ busy: true, error: "" });
      const myGen = gen;
      const r = await api.verify({ token, code });
      if (myGen !== gen) return;
      if (!r.ok) {
        return set({ busy: false, error: r.reason === "blocked" ? MESSAGES.codeBlocked : r.reason === "failed" ? MESSAGES.codeWrong : MESSAGES.connection });
      }
      ticket = r.result.ticket;
      expiresAt = r.result.expiresAt;
      const resuming = resume && state.photo;
      resume = false;
      Object.assign(state, {
        busy: false, notice: "", facilityName: r.result.facilityName, sentCount: 0, surgeryLocked: false,
        surgeryDate: resuming ? state.surgeryDate : "",   // 新しいセッション。再送する写真の値は残す
        last: { lastSentAt: r.result.lastSentAt, lastSurgeryDate: r.result.lastSurgeryDate }
      });
      if (resuming) { set({ screen: "review" }); return send(); }
      set({ screen: "camera" });
    },
    /** 撮影した写真(アップロードIDはここで1回だけ作る) */
    takePhoto({ blob, width, height, blurWarned = false }) {
      set({ screen: "review", error: "", canResend: false, photo: { blob, width, height, blurWarned, uploadId: newUploadId(), sha256: null } });
    },
    /** 撮り直す(新しい写真になるので、次の撮影で新しいIDになる) */
    retake() {
      if (state.sending) return;
      set({ screen: "camera", photo: null, error: "", canResend: false });
    },
    setSurgeryDate(value) {
      if (state.surgeryLocked) return;
      set({ surgeryDate: value, error: "" });
    },
    send,
    /** 続けて撮影(コードの再入力なし) */
    continueShooting() { set({ screen: "camera", done: null, error: "" }); },
    /** 終了: セッションと写真をメモリから消す */
    finish() {
      gen += 1;
      ticket = null; expiresAt = 0; resume = false;
      set({ screen: token ? "code" : "no-token", busy: false, sending: false, error: "", notice: "", canResend: false, facilityName: "", last: null, sentCount: 0,
        surgeryDate: "", surgeryLocked: false, photo: null, done: null });
    }
  };
}
