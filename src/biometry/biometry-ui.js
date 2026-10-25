import { $, showToast } from "../ui/dom.js";
import { biometryState, BIOMETRY_FIELDS, liveOcrState } from "./state.js";
import { parseBiometryText } from "./parser.js";
import { preprocessImageForOcr, preprocessCanvasForOcr } from "./ocr.js";

// DOM要素（initBiometry で取得）
let btnOpenBiometryModal, btnOpenBiometryText, biometryStatusBadge, confirmedBiometrySummary;
let biometryModal, tabStaticMode, tabLiveMode, panelStaticMode, panelLiveMode;
let biometryFileInput, biometryDropzone, dropzonePrompt, biometryPreviewContainer;
let biometryPreviewImg, btnRetakeImage, btnRunOcr, ocrStatusMessage;
let biometryVideo, liveStatusPill, liveStatusText, btnStopLiveOcr, liveCaptureCanvas;
let ocrAL, ocrACD, ocrK1, ocrK2, ocrK1Axis, ocrK2Axis, ocrWTW;
let btnCancelBiometry, btnConfirmBiometry;

/**
 * 生体計測（OCR）機能の初期化
 */
/**
 * 写真からの計測値の読み取り(OCR)は一時停止中。true にするときは、Tesseract.js の読み込み方法(版の固定・自前配信など)を
 * 見直してから index.html に追加する(現在は外部CDNから読み込まない)。注文機能とは独立している(注文には反映しない)。
 */
export const BIOMETRY_OCR_ENABLED = false;

export function initBiometry() {
  btnOpenBiometryModal = $("btnOpenBiometryModal");
  btnOpenBiometryText = $("btnOpenBiometryText");
  biometryStatusBadge = $("biometryStatusBadge");
  confirmedBiometrySummary = $("confirmedBiometrySummary");

  biometryModal = $("biometryModal");
  tabStaticMode = $("tabStaticMode");
  tabLiveMode = $("tabLiveMode");
  panelStaticMode = $("panelStaticMode");
  panelLiveMode = $("panelLiveMode");

  biometryFileInput = $("biometryFileInput");
  biometryDropzone = $("biometryDropzone");
  dropzonePrompt = $("dropzonePrompt");
  biometryPreviewContainer = $("biometryPreviewContainer");
  biometryPreviewImg = $("biometryPreviewImg");
  btnRetakeImage = $("btnRetakeImage");
  btnRunOcr = $("btnRunOcr");
  ocrStatusMessage = $("ocrStatusMessage");

  biometryVideo = $("biometryVideo");
  liveStatusPill = $("liveStatusPill");
  liveStatusText = $("liveStatusText");
  btnStopLiveOcr = $("btnStopLiveOcr");
  liveCaptureCanvas = $("liveCaptureCanvas");

  ocrAL = $("ocrAL");
  ocrACD = $("ocrACD");
  ocrK1 = $("ocrK1");
  ocrK1Axis = $("ocrK1Axis");
  ocrK2 = $("ocrK2");
  ocrK2Axis = $("ocrK2Axis");
  ocrWTW = $("ocrWTW");

  btnCancelBiometry = $("btnCancelBiometry");
  btnConfirmBiometry = $("btnConfirmBiometry");

  btnOpenBiometryModal.addEventListener("click", openBiometryModal);
  btnCancelBiometry.addEventListener("click", closeBiometryModal);
  btnConfirmBiometry.addEventListener("click", handleConfirmBiometry);

  tabStaticMode.addEventListener("click", switchToStaticMode);
  tabLiveMode.addEventListener("click", switchToLiveMode);

  biometryDropzone.addEventListener("click", () => {
    if (biometryPreviewContainer.classList.contains("hidden")) {
      biometryFileInput.click();
    }
  });
  biometryFileInput.addEventListener("change", handleBiometryFileSelect);
  btnRetakeImage.addEventListener("click", (e) => {
    e.stopPropagation();
    biometryFileInput.click();
  });
  btnRunOcr.addEventListener("click", handleRunBiometryOcr);

  btnStopLiveOcr.addEventListener("click", stopLiveCamera);

  biometryModal.addEventListener("click", (e) => {
    if (e.target === biometryModal) closeBiometryModal();
  });

  // ユーザーが手動編集したときのバッジ状態更新
  BIOMETRY_FIELDS.forEach(f => {
    const el = $(f.id);
    if (el) {
      el.addEventListener("input", () => {
        updateFieldBadgeStatus(f.key, "confirmed", "✓ 手動入力");
      });
    }
  });

  // ページを離れる・リロード時のカメラ停止
  window.addEventListener("beforeunload", stopLiveCamera);
}

/**
 * 生体計測モーダルを開く
 */
function openBiometryModal() {
  // すでに確定値がある場合は入力欄に反映、なければ空欄
  BIOMETRY_FIELDS.forEach(f => {
    const el = $(f.id);
    if (!el) return;

    if (biometryState.userConfirmedValues.isConfirmed) {
      const val = biometryState.userConfirmedValues[f.key];
      el.value = val !== null ? val : "";
      updateFieldBadgeStatus(f.key, "confirmed", "✓ 確定済み");
    } else {
      updateFieldBadgeStatus(f.key, "unrecognized", "未検出");
    }
  });

  // 初期は静止画モードで開く
  switchToStaticMode();

  biometryModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

/**
 * 生体計測モーダルを閉じる
 * 安全設計: 必ずMediaStreamTrack.stop()を呼びカメラを停止
 */
function closeBiometryModal() {
  stopLiveCamera();
  biometryModal.classList.add("hidden");
  document.body.style.overflow = "";
}

/**
 * 静止画モードへの切り替え
 */
function switchToStaticMode() {
  stopLiveCamera();
  tabStaticMode.classList.add("active");
  tabLiveMode.classList.remove("active");
  panelStaticMode.classList.remove("hidden");
  panelLiveMode.classList.add("hidden");
}

/**
 * リアルタイムカメラモードへの切り替え
 */
async function switchToLiveMode() {
  tabLiveMode.classList.add("active");
  tabStaticMode.classList.remove("active");
  panelLiveMode.classList.remove("hidden");
  panelStaticMode.classList.add("hidden");

  await startLiveCamera();
}

/**
 * 背面カメラを起動しリアルタイムOCRループを開始
 */
async function startLiveCamera() {
  // 以前のストリームがあれば停止
  stopLiveCamera();
  resetLiveOcrHistory();

  liveStatusPill.className = "live-status-pill";
  liveStatusText.textContent = "カメラ起動中…";

  try {
    const constraints = {
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    liveOcrState.stream = stream;
    biometryVideo.srcObject = stream;
    await biometryVideo.play();

    liveStatusText.textContent = "連続スキャン中 (画面を向けてください)";

    // 約800msごとにフレームを解析（排他制御つき）
    liveOcrState.intervalId = setInterval(processLiveFrame, liveOcrState.sampleIntervalMs);
  } catch (err) {
    console.error("カメラ起動エラー:", err);
    alert("背面カメラの起動に失敗しました。カメラのアクセス権限を確認するか、静止画モードをご利用ください。");
    switchToStaticMode();
  }
}

/**
 * カメラストリームを停止しタイマーを解除
 */
function stopLiveCamera() {
  if (liveOcrState.intervalId) {
    clearInterval(liveOcrState.intervalId);
    liveOcrState.intervalId = null;
  }

  if (liveOcrState.stream) {
    liveOcrState.stream.getTracks().forEach(track => {
      try {
        track.stop();
      } catch (e) {
        console.warn("Track stop error:", e);
      }
    });
    liveOcrState.stream = null;
  }

  if (biometryVideo) {
    biometryVideo.srcObject = null;
  }

  liveOcrState.isProcessing = false;
  if (liveStatusText) {
    liveStatusText.textContent = "カメラ停止中";
  }
}

/**
 * リアルタイムOCRの履歴と状態を初期化
 */
function resetLiveOcrHistory() {
  BIOMETRY_FIELDS.forEach(f => {
    liveOcrState.history[f.key] = { candidate: null, count: 0 };
    liveOcrState.confirmed[f.key] = false;
    // 確定済みでない入力欄はリセット
    if (!biometryState.userConfirmedValues.isConfirmed) {
      updateFieldBadgeStatus(f.key, "unrecognized", "未検出");
    }
  });
}

/**
 * 各フレームのキャプチャ & Tesseract.js解析
 * - 全フレームを解析せず、前のOCRが完了してから次を実行（排他制御）
 */
async function processLiveFrame() {
  if (liveOcrState.isProcessing) return; // 前のフレームを解析中ならスキップ
  if (!liveOcrState.stream || biometryVideo.readyState < 2) return;

  liveOcrState.isProcessing = true;

  try {
    // 1. videoフレームをCanvasへ切り出し
    const canvas = liveCaptureCanvas;
    const vWidth = biometryVideo.videoWidth || 640;
    const vHeight = biometryVideo.videoHeight || 480;

    canvas.width = vWidth;
    canvas.height = vHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(biometryVideo, 0, 0, vWidth, vHeight);

    // 2. OCR前処理
    const frameDataUrl = await preprocessCanvasForOcr(canvas);

    // 3. Tesseract.js OCR実行
    if (typeof Tesseract === "undefined") return;

    const ocrResult = await Tesseract.recognize(frameDataUrl, 'eng');
    const text = (ocrResult && ocrResult.data && ocrResult.data.text) || "";

    // 4. OA-2000テキストのパース
    const parsed = parseBiometryText(text, ocrResult.data.confidence || 70);

    // 5. 複数回フレーム一致（コンセンサス）判定 & 画面反映
    updateLiveOcrConsensus(parsed);

  } catch (err) {
    console.warn("リアルタイムフレーム解析スキップ:", err);
  } finally {
    liveOcrState.isProcessing = false;
  }
}

/**
 * 複数回一致（コンセンサス）による安定性判定ロジック
 * - 1回検出しただけでは確定せず、3回同一値（または近似値）が安定して検出された場合に「✓ 読み取り済み」とする
 * - 変動中は「候補検出中」のまま保持
 */
function updateLiveOcrConsensus(parsed) {
  let newlyConfirmedCount = 0;

  BIOMETRY_FIELDS.forEach(f => {
    // 既に確定済みの項目は上書きしない
    if (liveOcrState.confirmed[f.key]) return;

    const detected = parsed[f.key];
    const history = liveOcrState.history[f.key];

    if (detected && detected.value !== null) {
      const newVal = detected.value;
      const isMatch = checkValuesMatch(f, history.candidate, newVal);

      if (isMatch) {
        history.count++;

        if (history.count >= liveOcrState.requiredMatches) {
          // ★ 3回一致で確定採用！
          liveOcrState.confirmed[f.key] = true;
          const inputEl = $(f.id);
          if (inputEl) inputEl.value = newVal;

          updateFieldBadgeStatus(f.key, "confirmed", "✓ 読み取り済み");

          biometryState.rawAiValues[f.key] = {
            value: newVal,
            confidence: detected.confidence
          };
          newlyConfirmedCount++;
        } else {
          // 候補検出中 (1/3 または 2/3)
          updateFieldBadgeStatus(f.key, "candidate", `候補検出中 (${history.count}/${liveOcrState.requiredMatches})`);
        }
      } else {
        // 新しい候補値に変更 (カウントリセット)
        history.candidate = newVal;
        history.count = 1;
        updateFieldBadgeStatus(f.key, "candidate", `候補検出中 (1/${liveOcrState.requiredMatches})`);
      }
    }
  });

  // 全主要項目（AL、K1、K2）が確定したかチェック
  const allMainConfirmed = liveOcrState.confirmed.al && liveOcrState.confirmed.k1 && liveOcrState.confirmed.k2;
  if (allMainConfirmed) {
    liveStatusText.textContent = "主要項目の安定読み取りが完了しました";
    liveStatusPill.style.backgroundColor = "rgba(22, 101, 52, 0.85)";
  }
}

/**
 * 2つの値が同一項目として一致しているか判定
 */
function checkValuesMatch(fieldDef, val1, val2) {
  if (val1 === null || val2 === null) return false;

  if (fieldDef.isText) {
    // 文字列項目: 完全一致（大文字小文字・スペース変更なし）
    return String(val1).trim() === String(val2).trim();
  }

  // 数値項目: 0.02以内の微小誤差なら同一値と判定（手ブレ対策）
  const num1 = parseFloat(val1);
  const num2 = parseFloat(val2);
  if (isNaN(num1) || isNaN(num2)) return false;

  return Math.abs(num1 - num2) <= 0.02;
}

/**
 * 入力欄横のステータスバッジの表示切り替え
 * @param {string} key - 項目キー (al, k1, etc.)
 * @param {"unrecognized"|"candidate"|"confirmed"} status
 * @param {string} text - バッジ表示文字
 */
function updateFieldBadgeStatus(key, status, text) {
  const fieldDef = BIOMETRY_FIELDS.find(f => f.key === key);
  if (!fieldDef) return;

  const badgeEl = $(fieldDef.badgeId);
  if (!badgeEl) return;

  badgeEl.classList.remove("status-unrecognized", "status-candidate", "status-confirmed");
  badgeEl.classList.add(`status-${status}`);
  badgeEl.textContent = text;
}

// ==========================================================================
// 10-B. 静止画OCR処理 (ファイル選択・撮影)
// ==========================================================================
function handleBiometryFileSelect(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  biometryState.selectedFileName = file.name;

  const reader = new FileReader();
  reader.onload = (event) => {
    biometryState.selectedImageDataUrl = event.target.result;
    
    // プレビュー表示
    biometryPreviewImg.src = event.target.result;
    dropzonePrompt.classList.add("hidden");
    biometryPreviewContainer.classList.remove("hidden");

    // 読み取りボタン活性化
    btnRunOcr.disabled = false;
    ocrStatusMessage.className = "ocr-status-message";
    ocrStatusMessage.textContent = "画像が読み込まれました。「画像から読み取る」を押してください。";
    ocrStatusMessage.classList.remove("hidden");
  };
  reader.readAsDataURL(file);
}

/**
 * 静止画OCRの実行
 */
async function handleRunBiometryOcr() {
  if (!biometryState.selectedImageDataUrl) {
    alert("生体計測の画像または写真を選択してください。");
    return;
  }

  if (typeof Tesseract === "undefined") {
    alert("OCR解析エンジンの読み込みに失敗しました。ネットワーク接続を確認してください。");
    return;
  }

  btnRunOcr.disabled = true;
  ocrStatusMessage.className = "ocr-status-message is-loading";
  ocrStatusMessage.textContent = "画像を前処理しています…";
  ocrStatusMessage.classList.remove("hidden");

  clearBiometryInputs();

  try {
    const preprocessedDataUrl = await preprocessImageForOcr(biometryState.selectedImageDataUrl);

    ocrStatusMessage.textContent = "文字認識を実行中 (0%)…";

    const ocrResult = await Tesseract.recognize(
      preprocessedDataUrl,
      'eng',
      {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            const pct = Math.floor((m.progress || 0) * 100);
            ocrStatusMessage.textContent = `文字認識を実行中 (${pct}%)…`;
          }
        }
      }
    );

    const extractedText = (ocrResult && ocrResult.data && ocrResult.data.text) || "";
    biometryState.rawAiValues.rawText = extractedText;
    biometryState.rawAiValues.analyzedAt = new Date().toISOString();

    const parsedValues = parseBiometryText(extractedText, ocrResult.data.confidence || 70);

    let extractedCount = 0;
    BIOMETRY_FIELDS.forEach(f => {
      const parsedItem = parsedValues[f.key];
      const inputEl = $(f.id);

      biometryState.rawAiValues[f.key] = {
        value: parsedItem ? parsedItem.value : null,
        confidence: parsedItem ? parsedItem.confidence : null
      };

      if (parsedItem && parsedItem.value !== null) {
        extractedCount++;
        if (inputEl) inputEl.value = parsedItem.value;
        updateFieldBadgeStatus(f.key, "confirmed", "✓ 読み取り済み");
      } else {
        if (inputEl) inputEl.value = "";
        updateFieldBadgeStatus(f.key, "unrecognized", "未検出");
      }
    });

    if (extractedCount > 0) {
      ocrStatusMessage.className = "ocr-status-message is-success";
      ocrStatusMessage.textContent = `✔ ${extractedCount} 項目の数値を検出しました。必ず実測値と照合し、空欄や誤りを手動で修正してください。`;
    } else {
      ocrStatusMessage.className = "ocr-status-message is-error";
      ocrStatusMessage.textContent = "画像から測定値を自動検出できませんでした。撮影角度や照明を調整して撮り直すか、下の欄へ手動入力してください。";
    }

  } catch (err) {
    console.error("OCR解析エラー:", err);
    ocrStatusMessage.className = "ocr-status-message is-error";
    ocrStatusMessage.textContent = "画像解析中にエラーが発生しました。手動で測定値を入力してください。";
  } finally {
    btnRunOcr.disabled = false;
    btnRunOcr.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M2 12h20M12 2v20"></path>
        <circle cx="12" cy="12" r="7"></circle>
      </svg>
      再度読み取る
    `;
  }
}

function clearBiometryInputs() {
  BIOMETRY_FIELDS.forEach(f => {
    const inputEl = $(f.id);
    if (inputEl) inputEl.value = "";
    updateFieldBadgeStatus(f.key, "unrecognized", "未検出");
  });
}

/**
 * 計測値の確定ハンドラ
 * 安全設計:
 * - ユーザーが目視確認・修正した値のみを userConfirmedValues に格納
 * - 注文送信やAlcon Calculatorへの転記は行わない
 */
function handleConfirmBiometry() {
  stopLiveCamera();

  const confirmedValues = {
    al: ocrAL.value !== "" ? parseFloat(ocrAL.value) : null,
    acd: ocrACD.value !== "" ? parseFloat(ocrACD.value) : null,
    k1: ocrK1.value !== "" ? parseFloat(ocrK1.value) : null,
    k1Axis: ocrK1Axis.value !== "" ? parseInt(ocrK1Axis.value, 10) : null,
    k2: ocrK2.value !== "" ? parseFloat(ocrK2.value) : null,
    k2Axis: ocrK2Axis.value !== "" ? parseInt(ocrK2Axis.value, 10) : null,
    wtw: ocrWTW.value !== "" ? parseFloat(ocrWTW.value) : null,
    isConfirmed: true,
    confirmedAt: new Date().toISOString()
  };

  // 最低限ALまたはK1が入力されているかチェック
  if (confirmedValues.al === null && confirmedValues.k1 === null) {
    alert("眼軸長（AL）または角膜屈折力（K1/K2）を入力してください。");
    return;
  }

  biometryState.userConfirmedValues = confirmedValues;

  closeBiometryModal();
  renderBiometrySummary();

  showToast("✔ 生体計測値を目視確認・確定しました（※注文データへの自動反映は行われません）");

  console.log("==========================================");
  console.log("【生体計測内部データ保持 (biometryState)】");
  console.log(JSON.stringify(biometryState, null, 2));
  console.log("==========================================");
}

/**
 * 確定済み生体計測値のサマリー表示
 */
function renderBiometrySummary() {
  const v = biometryState.userConfirmedValues;
  if (!v.isConfirmed) return;

  const items = [];
  if (v.al !== null) items.push(`AL: ${v.al.toFixed(2)}mm`);
  if (v.k1 !== null) items.push(`K1: ${v.k1.toFixed(2)}D@${v.k1Axis !== null ? v.k1Axis : 0}°`);
  if (v.k2 !== null) items.push(`K2: ${v.k2.toFixed(2)}D@${v.k2Axis !== null ? v.k2Axis : 0}°`);
  if (v.acd !== null) items.push(`ACD: ${v.acd.toFixed(2)}mm`);

  confirmedBiometrySummary.innerHTML = `
    <strong>✔ 確認済み計測値:</strong> ${items.join(" / ")}
  `;
  confirmedBiometrySummary.classList.remove("hidden");

  biometryStatusBadge.className = "badge badge-success";
  biometryStatusBadge.textContent = "計測値確認済み";

  btnOpenBiometryText.textContent = "計測結果を確認・再修正する";
}
