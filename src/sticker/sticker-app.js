import { h } from "../ui/markdown-view.js";
import { createInfoTip } from "../ui/info-tip.js";
import { startCamera, stopCamera, captureFrame, measureSharpness, JPEG_QUALITY } from "../ui/sticker-camera.js";
import { isLowResolution, jstDateOf } from "../domain/sticker-photo.js";
import { MESSAGES, formatSentAt, lastSentLabel, shortDate } from "../domain/sticker-capture.js";

const CODE_HELP = "施設から共有されたアクセスコードを入力してください。コードは施設の管理者・副管理者が設定・変更します。患者情報が写らないように撮影してください。";
const CAMERA_HELP = "台紙全体が枠に入るように、真上から撮ってください。文字が読めるよう明るい場所で。患者情報が写らないようにしてください。「カメラで撮影」の方法では、端末によって写真が端末に残ることがあります。";
const REVIEW_HELP = "最後の手術日は、台紙のどの手術日の分まで撮ったかの目安です(任意)。";

/** カメラを開き直す間隔(ms)。外部のカメラから戻った直後は、まだカメラが使用中のことがある */
const CAMERA_RESTART_DELAYS = [0, 500, 1500];
/** 外部のカメラから戻った後、写真が届くのを待つ時間(ms)。届かなければキャンセルとして扱う */
const EXTERNAL_RETURN_WAIT_MS = 400;
/** 開き直しが終わらないときに「カメラを再開」を出すまでの時間(ms) */
const CAMERA_STALL_MS = 6000;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** カメラがすでに許可されているか。分からないときは false(確認を出さないよう、自動では開かない) */
async function cameraGranted() {
  try { return (await navigator.permissions.query({ name: "camera" })).state === "granted"; }
  catch { return false; }
}

/** ファイル選択の写真を、同じ解像度のまま描き直す(EXIF を落とす。向きは反映する) */
async function redrawFile(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width; canvas.height = bmp.height;
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  const { width, height } = bmp;
  bmp.close();
  const blob = await new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error("JPEG にできませんでした"))), "image/jpeg", JPEG_QUALITY));
  canvas.width = canvas.height = 0;
  return { blob, width, height };
}

/**
 * 看護師の撮影画面(docs/iol-sticker-photo-design.md §3)。controller の state を描くだけで、流れの判定はしない。
 * 文字はすべて textContent。写真は Blob の URL で表示し、次の写真・終了で解放する。端末には保存しない。
 * @param {{mount:HTMLElement, controller:object, now?:()=>number}} deps
 */
export function createStickerApp({ mount, controller, now = Date.now }) {
  const state = controller.state;
  let camera = null, shooting = false, previewUrl = null, previewBlob = null;
  let cameraGen = 0, starting = null;       // 開いている途中の処理(同時に1つだけ。世代が変わった結果は捨てる)
  let cameraHold = false;                   // 「カメラを再開」を押すまで開かない
  let external = false, leftPage = false, returnTimer = null;   // 外部のカメラを開いている間

  /* ---------- 共通 ---------- */
  const facility = h("p", { class: "sticker-facility", "data-f": "facility" });
  const printSheet = h("button", { type: "button", class: "btn btn-outline-sm sticker-print-sheet", "data-act": "printSheet" }, "台紙を印刷");
  const facilityRow = h("div", { class: "sticker-facility-row", "data-f": "facilityRow", hidden: true }, facility, printSheet);
  // 様式は施設設定と同じ処理を使う(ui/sticker-print-view.js)。材料は毎回サーバーから受け取る(最新の注意事項・有効な QR)
  printSheet.addEventListener("click", async () => {
    const sheet = await controller.loadSheet();
    if (!sheet) return;
    const print = await import("../ui/sticker-print-view.js");
    print.openSheetPrint(sheet);
  });
  const lastSent = h("p", { class: "sticker-last-sent", "data-f": "lastSent", hidden: true });
  const message = h("p", { class: "error-message sticker-message", "data-f": "error", role: "alert" });
  const notice = h("p", { class: "sticker-notice", "data-f": "notice", role: "status" });

  /* ---------- QR なし ---------- */
  const noToken = h("section", { class: "sticker-screen", "data-screen": "no-token", hidden: true }, h("p", {}, MESSAGES.noToken));

  /* ---------- ① コード入力 ---------- */
  const codeInput = h("input", { type: "password", class: "form-control sticker-code", "data-f": "code", inputmode: "numeric", autocomplete: "off", maxlength: "12", "aria-label": "アクセスコード" });
  const next = h("button", { type: "submit", class: "btn btn-primary sticker-wide", "data-act": "verify" }, "次へ");
  const codeForm = h("form", { class: "sticker-screen", "data-screen": "code", hidden: true, autocomplete: "off" },
    h("div", { class: "sticker-label" }, h("label", {}, "アクセスコード"), createInfoTip(CODE_HELP, { label: "アクセスコードの説明" }).root),
    codeInput, next);
  codeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = codeInput.value.trim();
    codeInput.value = "";   // 入力欄に残さない
    await controller.verify(code);
  });

  /* ---------- ② 撮影 ---------- */
  const video = h("video", { class: "sticker-video", "data-f": "video", playsinline: true, muted: true });
  const shutter = h("button", { type: "button", class: "sticker-shutter", "data-act": "shutter", "aria-label": "撮影" });
  const light = h("button", { type: "button", class: "btn btn-secondary btn-aux", "data-act": "light", hidden: true }, "ライトを点ける");
  const fileInput = h("input", { type: "file", accept: "image/*", capture: "environment", "data-f": "file", hidden: true });
  const fileBtn = h("button", { type: "button", class: "btn btn-secondary btn-aux", "data-act": "file", hidden: true }, "カメラで撮影");
  const resume = h("button", { type: "button", class: "btn btn-secondary btn-aux sticker-resume", "data-act": "resumeCamera", hidden: true }, "カメラを再開");
  const cameraNote = h("p", { class: "error-message", "data-f": "cameraNote" });
  const camScreen = h("section", { class: "sticker-screen", "data-screen": "camera", hidden: true },
    h("div", { class: "sticker-label" }, h("span", {}, "台紙を撮影"), createInfoTip(CAMERA_HELP, { label: "撮影の説明" }).root),
    h("div", { class: "sticker-frame" }, video, h("span", { class: "sticker-guide", "aria-hidden": "true" })),
    cameraNote, h("div", { class: "sticker-shutter-row" }, shutter), h("div", { class: "sticker-actions" }, light, resume, fileBtn), fileInput);

  /** 写真を確かめて確認画面へ(鮮鋭度は警告だけで、送信は止めない) */
  async function accept(shot) {
    let blurWarned = false;
    try { blurWarned = (await measureSharpness(shot.blob)).blurry === true; } catch { /* 測れなければ警告しない */ }
    controller.takePhoto({ ...shot, blurWarned });
  }
  shutter.addEventListener("click", async () => {
    if (shooting || !camera) return;
    shooting = true; shutter.disabled = true;
    try { await accept(await captureFrame(video)); }
    catch { cameraNote.textContent = MESSAGES.cameraFailed; }
    finally { shooting = false; shutter.disabled = false; }
  });
  // 外部のカメラと同時に使わないよう、先にストリームを止める。戻ったら開き直す(止めたままにしない)
  fileBtn.addEventListener("click", () => {
    clearTimeout(returnTimer);
    external = true; leftPage = false;
    releaseCamera();
    resume.hidden = false;   // 戻ったことが分からない端末でも、操作を残す
    fileInput.click();
  });
  fileInput.addEventListener("change", async () => {
    clearTimeout(returnTimer);
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    let note = "";
    if (file) {
      external = true;
      try { await accept(await redrawFile(file)); }
      catch { note = MESSAGES.badImage; }
    }
    external = false; leftPage = false;
    await reviveCamera();
    if (note) cameraNote.textContent = note;
  });
  fileInput.addEventListener("cancel", waitForExternalReturn);
  let torch = false;
  light.addEventListener("click", async () => {
    torch = !torch;
    try { await camera.track.applyConstraints({ advanced: [{ torch }] }); light.textContent = torch ? "ライトを消す" : "ライトを点ける"; }
    catch { light.hidden = true; }
  });

  /** 古くなった開く処理の結果を捨てる(今の映像は残す) */
  function dropStale(opened) {
    if (!opened) return;
    stopCamera(opened.stream, null);
    if (video.srcObject !== opened.stream) return;
    video.srcObject = camera ? camera.stream : null;
    if (camera) video.play().catch(() => {});
  }
  function ensureCamera(delays = [0]) {
    if (camera || starting || external || cameraHold) return starting;
    const gen = ++cameraGen;
    cameraNote.textContent = "";
    resume.hidden = true;
    const stall = delays.length > 1 ? setTimeout(() => {
      if (gen === cameraGen && !camera) { cameraNote.textContent = MESSAGES.cameraPaused; resume.hidden = false; }
    }, CAMERA_STALL_MS) : null;
    starting = (async () => {
      let opened = null;
      for (const delay of delays) {
        if (delay) await wait(delay);
        if (gen !== cameraGen) break;
        try { opened = await startCamera(video); break; }
        catch (e) { if (e && e.name === "NotAllowedError") break; }
      }
      clearTimeout(stall);
      if (gen !== cameraGen) { dropStale(opened); return; }
      starting = null;
      if (!opened) {
        cameraNote.textContent = MESSAGES.cameraFailed;
        fileBtn.hidden = false;
        shutter.hidden = true;
        resume.hidden = false;
        return;
      }
      camera = opened;
      camera.track.addEventListener("ended", reviveCamera);
      light.hidden = !(camera.capabilities && camera.capabilities.torch);
      fileBtn.hidden = !isLowResolution(video.videoWidth, video.videoHeight);
      shutter.hidden = false;
      resume.hidden = true;
      cameraNote.textContent = "";
    })();
    return starting;
  }
  /** ストリームを止める。開いている途中の処理は、結果を捨てる */
  function releaseCamera() {
    cameraGen += 1;
    starting = null;
    if (camera) {
      camera.track.removeEventListener("ended", reviveCamera);
      stopCamera(camera.stream, video);
    }
    camera = null; torch = false;
    light.textContent = "ライトを点ける";
    light.hidden = true;
  }
  function closeCamera() {
    releaseCamera();
    cameraHold = false;
    resume.hidden = true;
    shutter.hidden = false;
  }
  const cameraLive = () => Boolean(camera) && camera.track.readyState === "live" && !camera.track.muted && !video.paused && video.srcObject === camera.stream;
  const canRevive = () => state.screen === "camera" && !external && !document.hidden && !starting && !cameraHold;

  /** 映像が止まっていたら開き直す。許可が確かめられないときは確認を出さず、「カメラを再開」を出す */
  async function reviveCamera() {
    if (!canRevive() || cameraLive()) return;
    const granted = await cameraGranted();
    if (!canRevive() || cameraLive()) return;
    releaseCamera();
    if (granted) { ensureCamera(CAMERA_RESTART_DELAYS); return; }
    cameraHold = true;
    shutter.hidden = true;
    cameraNote.textContent = MESSAGES.cameraPaused;
    resume.hidden = false;
  }
  function waitForExternalReturn() {
    clearTimeout(returnTimer);
    returnTimer = setTimeout(() => { external = false; leftPage = false; reviveCamera(); }, EXTERNAL_RETURN_WAIT_MS);
  }
  function onPageReturn() {
    if (document.hidden) { leftPage = true; return; }
    if (!external) reviveCamera();
    else if (leftPage) waitForExternalReturn();
  }
  document.addEventListener("visibilitychange", onPageReturn);
  window.addEventListener("pageshow", onPageReturn);
  window.addEventListener("focus", onPageReturn);
  window.addEventListener("blur", () => { leftPage = true; });
  resume.addEventListener("click", () => {
    clearTimeout(returnTimer);
    external = false; leftPage = false; cameraHold = false;
    releaseCamera();
    ensureCamera(CAMERA_RESTART_DELAYS);
  });

  /* ---------- ③ 確認 ---------- */
  const preview = h("img", { class: "sticker-preview", "data-f": "preview", alt: "撮影した画像" });
  const warnBlur = h("p", { class: "sticker-warning", "data-f": "warnBlur", hidden: true }, `⚠ ${MESSAGES.blurry}`);
  const warnLow = h("p", { class: "sticker-warning", "data-f": "warnLow", hidden: true }, `⚠ ${MESSAGES.lowResolution}`);
  const dateInput = h("input", { type: "date", class: "form-control", "data-f": "surgeryDate", "aria-label": "最後の手術日" });
  const dateRow = h("div", { class: "sticker-date", "data-f": "dateRow" }, h("span", {}, "最後の手術日（任意）"), dateInput);
  const dateFixed = h("p", { class: "sticker-date", "data-f": "dateFixed", hidden: true });
  const retake = h("button", { type: "button", class: "btn btn-secondary", "data-act": "retake" }, "撮り直す");
  const sendBtn = h("button", { type: "button", class: "btn btn-primary", "data-act": "send" }, "送信");
  const reviewScreen = h("section", { class: "sticker-screen", "data-screen": "review", hidden: true },
    h("div", { class: "sticker-label" }, h("span", {}, "画像の確認"), createInfoTip(REVIEW_HELP, { label: "最後の手術日の説明" }).root),
    h("div", { class: "sticker-preview-box" }, preview), warnBlur, warnLow, dateRow, dateFixed, h("div", { class: "sticker-actions sticker-actions-split" }, retake, sendBtn));
  retake.addEventListener("click", () => controller.retake());
  sendBtn.addEventListener("click", () => controller.send());
  dateInput.addEventListener("change", () => controller.setSurgeryDate(dateInput.value));

  /* ---------- ④ 完了 ---------- */
  const doneDetail = h("p", { class: "sticker-done-detail", "data-f": "doneDetail" });
  const again = h("button", { type: "button", class: "btn btn-primary sticker-wide", "data-act": "again" }, "続けて撮影");
  const finish = h("button", { type: "button", class: "btn btn-secondary btn-aux", "data-act": "finish" }, "終了");
  const doneScreen = h("section", { class: "sticker-screen sticker-done", "data-screen": "done", hidden: true },
    h("p", { class: "sticker-done-title" }, "✓ 送信しました"), doneDetail, again, finish);
  again.addEventListener("click", () => controller.continueShooting());
  finish.addEventListener("click", () => { controller.finish(); });

  /* ---------- 描画 ---------- */
  function showPreview(blob) {
    if (blob === previewBlob) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewBlob = blob;
    previewUrl = blob ? URL.createObjectURL(blob) : null;
    if (previewUrl) preview.src = previewUrl; else preview.removeAttribute("src");
  }

  function render() {
    for (const [name, el] of [["no-token", noToken], ["code", codeForm], ["camera", camScreen], ["review", reviewScreen], ["done", doneScreen]]) el.hidden = state.screen !== name;
    const t = now();
    const verified = Boolean(state.facilityName) && state.screen !== "code";
    facilityRow.hidden = lastSent.hidden = !verified;   // 確認の前には出さない
    facility.textContent = verified ? state.facilityName : "";
    lastSent.textContent = verified ? lastSentLabel(state.last, t) : "";
    message.textContent = state.error;
    notice.textContent = state.notice;
    next.disabled = state.busy;
    printSheet.disabled = state.sheetBusy || state.sending;

    showPreview(state.photo ? state.photo.blob : null);
    const p = state.photo;
    warnBlur.hidden = !(p && p.blurWarned);
    warnLow.hidden = !(p && isLowResolution(p.width, p.height));
    dateRow.hidden = state.surgeryLocked;
    dateFixed.hidden = !state.surgeryLocked;
    dateFixed.textContent = `最後の手術日 ${state.surgeryDate ? shortDate(state.surgeryDate, t) : "未入力"}`;
    dateInput.max = jstDateOf(t);
    if (dateInput.value !== state.surgeryDate) dateInput.value = state.surgeryDate;
    sendBtn.textContent = state.sending ? "送信中…" : state.canResend ? "再送信" : "送信";
    sendBtn.disabled = state.sending;
    retake.disabled = state.sending;
    if (state.done) doneDetail.textContent = `${formatSentAt(state.done.takenAt, t)}  この回 ${state.done.count}枚目`;

    if (state.screen === "camera") ensureCamera();
    if (state.screen === "code" || state.screen === "no-token") { if (!state.photo) closeCamera(); }
  }

  mount.replaceChildren(facilityRow, lastSent, noToken, codeForm, camScreen, reviewScreen, doneScreen, notice, message);
  return { render };
}
