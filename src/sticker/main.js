/**
 * 看護師の撮影画面(sticker.html)の起動。ログインなしの別の入口で、Firebase SDK は読み込まない。
 * QR の #f= の入口トークンと、毎回入力するアクセスコードで送信チケットを受け取る。端末には何も保存しない。
 */
import { FIREBASE_CONFIG } from "../firebase/firebase-config.js";
import { parseEntryToken } from "../domain/sticker-photo.js";
import { createCaptureApi, sha256OfBlob, stickerFunctionsBase } from "../data/sticker-capture-api.js";
import { createCaptureController } from "./capture-controller.js";
import { createStickerApp } from "./sticker-app.js";

let app = null;
const controller = createCaptureController({
  api: createCaptureApi({ baseUrl: stickerFunctionsBase(FIREBASE_CONFIG.projectId) }),
  token: parseEntryToken(location.hash),
  sha256: sha256OfBlob,
  onChange: () => { if (app) app.render(); }
});
app = createStickerApp({ mount: document.getElementById("stickerMain"), controller });
app.render();
