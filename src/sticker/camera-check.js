/**
 * R09 実機検証のページ(sticker-camera-check.html)。撮影した画像の解像度・JPEG の大きさ・ピンぼけの判定を表示し、
 * 拡大して文字・シリアル番号を確かめ、写真ライブラリに残ったかを記録する。画像はページのメモリ(Blob)だけで、送信・保存しない。
 */
import { startCamera, stopCamera, captureFrame, canTakePhoto, takeStill, imageSize, measureSharpness, CAMERA_REQUEST, JPEG_QUALITY } from "../ui/sticker-camera.js";
import { SHARPNESS_THRESHOLD } from "../domain/image-sharpness.js";

const $ = (id) => document.getElementById(id);
const video = $("ccVideo"), info = $("ccCamInfo"), camMsg = $("ccCamMsg"), results = $("ccResults"), summary = $("ccSummary");
let cam = null, count = 0;
const records = [];   // 画面のまとめ用(画像そのものは持たない)
const urls = [];      // 表示用の URL(消すときに解放)

const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === "class") e.className = v; else if (v !== null && v !== undefined) e.setAttribute(k, v); }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(typeof c === "string" ? document.createTextNode(c) : c);
  return e;
};
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const mp = (w, h) => `${(w * h / 1e6).toFixed(1)} MP`;
const dl = (pairs) => pairs.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]);

function renderCamInfo() {
  const s = cam ? cam.settings : {}, c = cam ? cam.capabilities : {};
  const max = c.width && c.height ? `${c.width.max}×${c.height.max}` : "不明";
  info.replaceChildren(...dl([
    ["映像の解像度", cam ? `${video.videoWidth}×${video.videoHeight}(${mp(video.videoWidth, video.videoHeight)})` : "—"],
    ["要求した解像度", `${CAMERA_REQUEST.width}×${CAMERA_REQUEST.height}`],
    ["カメラの上限", max],
    ["カメラの向き", s.facingMode || "不明"],
    ["静止画モード", cam && canTakePhoto(cam.track) ? "使える(比較用)" : "使えない"]
  ]));
}

function renderSummary() {
  const lines = [
    `端末: ${navigator.userAgent}`,
    `画面: ${screen.width}×${screen.height} @${window.devicePixelRatio}`,
    `JPEG品質: ${JPEG_QUALITY} / ピンぼけのしきい値(暫定): ${SHARPNESS_THRESHOLD}`,
    ...records.map(r => `#${r.no} ${r.method}: ${r.width}×${r.height}(${mp(r.width, r.height)}) ${mb(r.bytes)} 鮮鋭度 ${r.score}${r.blurry ? "(ピンぼけの疑い)" : ""} 処理 ${r.ms}ms ライブラリ: ${r.library}`)
  ];
  summary.value = lines.join("\n");
}

/** 撮影した1枚の結果(解像度・大きさ・鮮鋭度・拡大表示・ライブラリの確認) */
async function addResult(method, shot, startedAt) {
  const no = ++count;
  const sharp = await measureSharpness(shot.blob);
  const ms = Math.round(performance.now() - startedAt);
  const rec = { no, method, width: shot.width, height: shot.height, bytes: shot.blob.size, score: sharp.score, blurry: sharp.blurry, ms, library: "未確認" };
  records.push(rec);
  const url = URL.createObjectURL(shot.blob);
  urls.push(url);
  const zoom = el("div", { class: "cc-zoom", "data-zoom": "fit" }, el("img", { src: url, alt: `撮影 ${no}` }));
  const zoomBtn = (mode, label) => {
    const b = el("button", { type: "button", class: "btn btn-outline-sm", "data-zoom-mode": mode }, label);
    b.addEventListener("click", () => { zoom.className = `cc-zoom${mode === "fit" ? "" : ` is-${mode}`}`; zoom.dataset.zoom = mode;
      const img = zoom.querySelector("img"); img.style.width = mode === "200" ? `${shot.width * 2 / window.devicePixelRatio}px` : ""; });
    return b;
  };
  const libName = `ccLib${no}`;
  const lib = el("div", { class: "cc-lib", role: "radiogroup", "aria-label": "写真ライブラリ" },
    el("span", {}, "撮影後、写真ライブラリ(ギャラリー)に:"),
    ...["残っていない", "残っている", "未確認"].map(v => {
      const input = el("input", { type: "radio", name: libName, value: v });
      if (v === "未確認") input.checked = true;
      input.addEventListener("change", () => { rec.library = v; renderSummary(); });
      return el("label", { class: "settings-check" }, input, el("span", {}, v));
    }));
  const card = el("section", { class: "cc-card", "data-result": String(no) },
    el("h2", {}, `撮影 ${no}: ${method}`),
    el("dl", { class: "cc-dl" }, ...dl([
      ["解像度", `${shot.width}×${shot.height}(${mp(shot.width, shot.height)})`],
      ["JPEG の大きさ", mb(shot.blob.size)],
      ["鮮鋭度", el("span", { class: sharp.blurry ? "cc-blurry" : null, "data-blurry": String(sharp.blurry) }, `${sharp.score}${sharp.blurry ? "(ピンぼけの疑い)" : "(問題なし)"}`)],
      ["処理時間", `${ms} ms`]
    ])),
    el("div", { class: "cc-row", style: "margin-top:8px" }, zoomBtn("fit", "全体"), zoomBtn("100", "等倍"), zoomBtn("200", "2倍")),
    zoom, lib);
  results.prepend(card);
  renderSummary();
}

$("ccStart").addEventListener("click", async () => {
  camMsg.textContent = "カメラを起動しています…";
  try {
    cam = await startCamera(video);
    video.hidden = false;
    $("ccShot").disabled = false; $("ccStop").disabled = false; $("ccStart").disabled = true;
    const still = $("ccStill");
    still.hidden = !canTakePhoto(cam.track); still.disabled = !canTakePhoto(cam.track);
    camMsg.textContent = "";
  } catch (e) {
    camMsg.textContent = `カメラを起動できません: ${e && e.name ? e.name : ""} ${e && e.message ? e.message : ""}`;
  }
  renderCamInfo();
});

$("ccShot").addEventListener("click", async () => {
  const t = performance.now();
  try { await addResult("ブラウザのカメラ(映像の1コマ)", await captureFrame(video), t); }
  catch (e) { camMsg.textContent = `撮影できませんでした: ${e.message}`; }
});

$("ccStill").addEventListener("click", async () => {
  const t = performance.now();
  try { await addResult("静止画モード(ImageCapture)", await takeStill(cam.track), t); }
  catch (e) { camMsg.textContent = `静止画モードで撮影できませんでした: ${e.message}`; }
});

$("ccStop").addEventListener("click", () => {
  stopCamera(cam && cam.stream, video);
  cam = null; video.hidden = true;
  $("ccShot").disabled = true; $("ccStill").disabled = true; $("ccStop").disabled = true; $("ccStart").disabled = false;
  renderCamInfo();
});

$("ccFileInput").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const t = performance.now();
  try { await addResult(`ファイル選択(${file.type || "形式不明"})`, { blob: file, ...(await imageSize(file)) }, t); }
  catch (err) { camMsg.textContent = `画像を読み込めませんでした: ${err.message}`; }
  e.target.value = "";
});

$("ccCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(summary.value); $("ccCopyMsg").textContent = "コピーしました"; }
  catch { summary.select(); $("ccCopyMsg").textContent = "選択しました。長押しでコピーしてください"; }
});

$("ccClear").addEventListener("click", () => {
  results.replaceChildren(); records.length = 0; count = 0;
  urls.splice(0).forEach(u => URL.revokeObjectURL(u));
  renderSummary();
});

window.addEventListener("pagehide", () => { stopCamera(cam && cam.stream, video); urls.forEach(u => URL.revokeObjectURL(u)); });
renderCamInfo();
renderSummary();
