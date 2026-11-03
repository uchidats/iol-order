/**
 * R09 の撮影(docs/iol-sticker-photo-design.md §3-3)。ブラウザのカメラ(getUserMedia)で背面カメラを最大の解像度で開き、
 * 映像の1コマを JPEG にする。写真ライブラリを経由しない(画像はページのメモリの Blob だけ)。
 * 比較のため、対応する端末(Android の Chrome など)では静止画の撮影(ImageCapture.takePhoto)も使える。
 * 実機検証のページ(sticker-camera-check.html)と、本番の sticker.html で共通に使う予定。
 */
import { toGray, laplacianVariance, scaledSize, judgeSharpness } from "../domain/image-sharpness.js";

/** 要求する解像度(端末の上限で撮る。実際の値は track.getSettings() で確かめる) */
export const CAMERA_REQUEST = Object.freeze({ width: 4096, height: 3072 });
/** 暫定の JPEG の品質(設計 §3-4。実機検証の後に決める) */
export const JPEG_QUALITY = 0.92;

/** 背面カメラを開いて <video> に映す。{ stream, track, settings, capabilities } */
export async function startCamera(video, request = CAMERA_REQUEST) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("このブラウザはカメラを使えません");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: "environment" }, width: { ideal: request.width }, height: { ideal: request.height } }
  });
  video.srcObject = stream;
  video.setAttribute("playsinline", "");   // iOS: 全画面にしない
  video.muted = true;
  await video.play();
  if (!video.videoWidth) await new Promise(r => video.addEventListener("loadedmetadata", r, { once: true }));
  const track = stream.getVideoTracks()[0];
  return {
    stream, track,
    settings: track.getSettings ? track.getSettings() : {},
    capabilities: track.getCapabilities ? track.getCapabilities() : {}
  };
}

/** カメラを止める */
export function stopCamera(stream, video) {
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (video) video.srcObject = null;
}

const canvasToJpeg = (canvas, quality = JPEG_QUALITY) => new Promise((resolve, reject) =>
  canvas.toBlob(b => (b ? resolve(b) : reject(new Error("JPEG にできませんでした"))), "image/jpeg", quality));

/** 映像の1コマを、映像の解像度のまま JPEG にする。{ blob, width, height } */
export async function captureFrame(video, quality = JPEG_QUALITY) {
  const width = video.videoWidth, height = video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  canvas.getContext("2d").drawImage(video, 0, 0, width, height);
  const blob = await canvasToJpeg(canvas, quality);
  canvas.width = canvas.height = 0;   // メモリを早く手放す
  return { blob, width, height };
}

/** 静止画の撮影に対応しているか(ImageCapture.takePhoto) */
export const canTakePhoto = (track) => typeof globalThis.ImageCapture === "function" && Boolean(track);

/** 静止画で撮影する(端末が返す JPEG のまま)。{ blob, width, height } */
export async function takeStill(track) {
  const ic = new globalThis.ImageCapture(track);
  let opts = {};
  try {
    const caps = await ic.getPhotoCapabilities();
    if (caps && caps.imageWidth && caps.imageHeight) opts = { imageWidth: caps.imageWidth.max, imageHeight: caps.imageHeight.max };
  } catch { /* 上限が分からなければ既定の大きさ */ }
  const blob = await ic.takePhoto(opts);
  const { width, height } = await imageSize(blob);
  return { blob, width, height };
}

/** 画像の大きさ(画素) */
export async function imageSize(blob) {
  const bmp = await createImageBitmap(blob);
  const r = { width: bmp.width, height: bmp.height };
  bmp.close();
  return r;
}

/** 画像の鮮鋭度(縮小してラプラシアンの分散)。{ score, blurry } */
export async function measureSharpness(blob) {
  const bmp = await createImageBitmap(blob);
  const { width, height } = scaledSize(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const data = ctx.getImageData(0, 0, width, height).data;
  canvas.width = canvas.height = 0;
  return judgeSharpness(laplacianVariance(toGray(data), width, height));
}
