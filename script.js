/**
 * iol-order - 眼内レンズ（IOL）発注管理スクリプト
 * 運用元: 国家公務員共済組合連合会 立川病院眼科
 * 
 * Google Formの実際の運用内容・選択肢・度数範囲・関連リンクを正として完全準拠。
 * Google Apps Script (GAS) Web APIへの実POST送信対応。
 */

// ==========================================================================
// 0. API設定 & ストレージキー
// ==========================================================================
// Google Apps Script (GAS) Web API の公開URL
const ORDER_API_URL = "https://script.google.com/macros/s/AKfycbygDAOMuLcphwak4CdQizjF2A2XExWVVTTaSyE7j_XHLZHOi98V-22KOrMOdOhrS6US/exec";

// メールアドレスのlocalStorageキー
const STORAGE_KEY_EMAIL = "iol_order_saved_email";

// ==========================================================================
// 1. Google Form 準拠マスターデータ (IOL_MODELS)
// ==========================================================================
/**
 * Google Formに登録されているメーカー・モデルマスター
 * 要件指定のデータ構造:
 * {
 *   manufacturer: "...",
 *   model: "...",
 *   isToric: true / false,
 *   toricModels: [...],
 *   powerRange: { min: ..., max: ..., step: ..., customSteps: [...] },
 *   calculatorUrl: "...",
 *   notes: "..."
 * }
 */
const IOL_MODELS = [
  // 1. J&J / DIB00V
  {
    manufacturer: "J&J",
    model: "DIB00V",
    displayName: "J&J / DIB00V",
    isToric: false,
    toricModels: [],
    powerRange: { min: 6.0, max: 30.0, step: 0.5, default: 20.0 },
    calculatorUrl: "",
    notes: "+6.0～+30.0D [0.5ステップ]"
  },
  // 2. J&J / DIWxxx (トーリック)
  {
    manufacturer: "J&J",
    model: "DIWxxx (トーリック)",
    displayName: "J&J / DIWxxx (トーリック)",
    isToric: true,
    toricModels: [
      "DIW150",
      "DIW225",
      "DIW300",
      "DIW375",
      "DIW450",
      "DIW525",
      "DIW600"
    ],
    powerRange: { min: 6.0, max: 30.0, step: 0.5, default: 20.0 },
    calculatorUrl: "https://tecnistoriccalc.com",
    notes: "+6.0～+30.0D [0.5ステップ]"
  },
  // 3. ALCON / CNA0T0
  {
    manufacturer: "ALCON",
    model: "CNA0T0",
    displayName: "ALCON / CNA0T0",
    isToric: false,
    toricModels: [],
    powerRange: { min: 6.0, max: 30.0, step: 0.5, default: 20.0 },
    calculatorUrl: "",
    notes: "+6.0～+30.0D [0.5ステップ]"
  },
  // 4. ALCON / CNA0Tx / CNW0Tx (トーリック)
  {
    manufacturer: "ALCON",
    model: "CNA0Tx / CNW0Tx (トーリック)",
    displayName: "ALCON / CNA0Tx / CNW0Tx (トーリック)",
    isToric: true,
    toricModels: [
      "CNA0T2",
      "CNA0T3",
      "CNA0T4",
      "CNA0T5",
      "CNA0T6",
      "CNW0T7",
      "CNW0T8",
      "CNW0T9"
    ],
    powerRange: { min: 6.0, max: 30.0, step: 0.5, default: 20.0 },
    calculatorUrl: "https://www.myalcon-toriccalc.com",
    notes: "+6.0～+30.0D [0.5ステップ]"
  },
  // 5. SANTEN / NX-70S
  {
    manufacturer: "SANTEN",
    model: "NX-70S",
    displayName: "SANTEN / NX-70S",
    isToric: false,
    toricModels: [],
    powerRange: { min: 10.0, max: 27.0, step: 0.5, default: 20.0 },
    calculatorUrl: "",
    notes: "+10.0～+27.0D [0.5ステップ]"
  },
  // 6. SANTEN / LS-313MF15
  {
    manufacturer: "SANTEN",
    model: "LS-313MF15",
    displayName: "SANTEN / LS-313MF15",
    isToric: false,
    toricModels: [],
    powerRange: { min: 10.0, max: 27.0, step: 0.5, default: 20.0 },
    calculatorUrl: "",
    notes: "+10.0～+27.0D [0.5ステップ]"
  },
  // 7. SANTEN / LS-313MF15 Tx (トーリック)
  {
    manufacturer: "SANTEN",
    model: "LS-313MF15 Tx (トーリック)",
    displayName: "SANTEN / LS-313MF15 Tx (トーリック)",
    isToric: true,
    toricModels: [
      "LS-313MF15 T1",
      "LS-313MF15 T2",
      "LS-313MF15 T3"
    ],
    powerRange: { min: 10.0, max: 27.0, step: 0.5, default: 20.0 },
    calculatorUrl: "https://www.teleon-toric.com",
    notes: "+10.0～+27.0D [0.5ステップ]"
  },
  // 8. NIDEK / NSP-2
  {
    manufacturer: "NIDEK",
    model: "NSP-2",
    displayName: "NIDEK / NSP-2",
    isToric: false,
    toricModels: [],
    powerRange: {
      min: 1.0,
      max: 30.0,
      step: 0.5,
      default: 20.0,
      customSegments: [
        { min: 1.0, max: 5.0, step: 1.0 },
        { min: 5.0, max: 27.0, step: 0.5 },
        { min: 27.0, max: 30.0, step: 1.0 }
      ]
    },
    calculatorUrl: "",
    notes: "+1.0～+5.0D [1.0ステップ] / +5.0～+27.0D [0.5ステップ] / +27.0～+30.0D [1.0ステップ]"
  },
  // 9. NIDEK / NP-Tx (トーリック)
  {
    manufacturer: "NIDEK",
    model: "NP-Tx (トーリック)",
    displayName: "NIDEK / NP-Tx (トーリック)",
    isToric: true,
    toricModels: [
      "NP-T3",
      "NP-T4",
      "NP-T5",
      "NP-T6",
      "NP-T7"
    ],
    powerRange: {
      min: 1.0,
      max: 30.0,
      step: 0.5,
      default: 20.0,
      customSegments: [
        { min: 1.0, max: 5.0, step: 1.0 },
        { min: 5.0, max: 27.0, step: 0.5 },
        { min: 27.0, max: 30.0, step: 1.0 }
      ]
    },
    calculatorUrl: "",
    notes: "+1.0～+5.0D [1.0ステップ] / +5.0～+27.0D [0.5ステップ] / +27.0～+30.0D [1.0ステップ]"
  },
  // 10. HOYA / XY1
  {
    manufacturer: "HOYA",
    model: "XY1",
    displayName: "HOYA / XY1",
    isToric: false,
    toricModels: [],
    powerRange: { min: 6.0, max: 30.0, step: 0.5, default: 20.0 },
    calculatorUrl: "",
    notes: "+6.0～+30.0D [0.5ステップ]"
  },
  // 11. HOYA / PY-60AD
  {
    manufacturer: "HOYA",
    model: "PY-60AD",
    displayName: "HOYA / PY-60AD",
    isToric: false,
    toricModels: [],
    powerRange: { min: 6.0, max: 30.0, step: 0.5, default: 20.0 },
    calculatorUrl: "",
    notes: "+6.0～+30.0D [0.5ステップ]"
  },
  // 12. ALCON / MN60MA (イエロー)
  {
    manufacturer: "ALCON",
    model: "MN60MA (イエロー)",
    displayName: "ALCON / MN60MA (イエロー)",
    isToric: false,
    toricModels: [],
    powerRange: { min: -5.0, max: 5.0, step: 1.0, default: 0.0 },
    calculatorUrl: "",
    notes: "-5.0～+5.0D [1.0ステップ]"
  }
];

// Google Formに登録されている全60個のIOLパワー選択肢 (完全一致)
const GOOGLE_FORM_ALL_POWERS = [
  "-5.0D", "-4.0D", "-3.0D", "-2.0D", "-1.0D", "0D",
  "+1.0D", "+2.0D", "+3.0D", "+4.0D", "+5.0D", "+5.5D",
  "+6.0D", "+6.5D", "+7.0D", "+7.5D", "+8.0D", "+8.5D",
  "+9.0D", "+9.5D", "+10.0D", "+10.5D", "+11.0D", "+11.5D",
  "+12.0D", "+12.5D", "+13.0D", "+13.5D", "+14.0D", "+14.5D",
  "+15.0D", "+15.5D", "+16.0D", "+16.5D", "+17.0D", "+17.5D",
  "+18.0D", "+18.5D", "+19.0D", "+19.5D", "+20.0D", "+20.5D",
  "+21.0D", "+21.5D", "+22.0D", "+22.5D", "+23.0D", "+23.5D",
  "+24.0D", "+24.5D", "+25.0D", "+25.5D", "+26.0D", "+26.5D",
  "+27.0D", "+27.5D", "+28.0D", "+28.5D", "+29.0D", "+29.5D",
  "+30.0D"
];

// ==========================================================================
// 2. DOM要素の取得
// ==========================================================================
const form = document.getElementById("iolOrderForm");
const modelSelect = document.getElementById("iolModelSelect");
const modelBadgeInfo = document.getElementById("modelBadgeInfo");

const groupToricModel = document.getElementById("groupToricModel");
const toricModelSelect = document.getElementById("toricModelSelect");

const alconCalcArea = document.getElementById("alconCalcArea");
const alconCalcLink = document.getElementById("alconCalcLink");

const powerSelect = document.getElementById("iolPowerSelect");
const btnPowerPrev = document.getElementById("btnPowerPrev");
const btnPowerNext = document.getElementById("btnPowerNext");
const powerRangeGuide = document.getElementById("powerRangeGuide");

const surgeryDateInput = document.getElementById("surgeryDateInput");
const ordererSelect = document.getElementById("ordererSelect");
const emailInput = document.getElementById("emailInput");
const notesInput = document.getElementById("notesInput");

// モーダル関連
const confirmModal = document.getElementById("confirmModal");
const btnModalBack = document.getElementById("btnModalBack");
const btnModalSubmit = document.getElementById("btnModalSubmit");
const modalSubmitError = document.getElementById("modalSubmitError");
const modalSubmitErrorText = document.getElementById("modalSubmitErrorText");

const completeModal = document.getElementById("completeModal");
const completeDetails = document.getElementById("completeDetails");
const btnNewOrder = document.getElementById("btnNewOrder");

// トースト & 生体計測モーダル関連
const toastNotice = document.getElementById("toastNotice");
const btnOpenBiometryModal = document.getElementById("btnOpenBiometryModal");
const btnOpenBiometryText = document.getElementById("btnOpenBiometryText");
const biometryStatusBadge = document.getElementById("biometryStatusBadge");
const confirmedBiometrySummary = document.getElementById("confirmedBiometrySummary");

// 生体計測モーダルDOM要素
const biometryModal = document.getElementById("biometryModal");
const tabStaticMode = document.getElementById("tabStaticMode");
const tabLiveMode = document.getElementById("tabLiveMode");
const panelStaticMode = document.getElementById("panelStaticMode");
const panelLiveMode = document.getElementById("panelLiveMode");

// 静止画モード用要素
const biometryFileInput = document.getElementById("biometryFileInput");
const biometryDropzone = document.getElementById("biometryDropzone");
const dropzonePrompt = document.getElementById("dropzonePrompt");
const biometryPreviewContainer = document.getElementById("biometryPreviewContainer");
const biometryPreviewImg = document.getElementById("biometryPreviewImg");
const btnRetakeImage = document.getElementById("btnRetakeImage");
const btnRunOcr = document.getElementById("btnRunOcr");
const ocrStatusMessage = document.getElementById("ocrStatusMessage");

// リアルタイムカメラ用要素
const biometryVideo = document.getElementById("biometryVideo");
const liveStatusPill = document.getElementById("liveStatusPill");
const liveStatusText = document.getElementById("liveStatusText");
const btnStopLiveOcr = document.getElementById("btnStopLiveOcr");
const liveCaptureCanvas = document.getElementById("liveCaptureCanvas");

// 計測値入力欄
const ocrPatientName = document.getElementById("ocrPatientName");
const ocrAL = document.getElementById("ocrAL");
const ocrACD = document.getElementById("ocrACD");
const ocrK1 = document.getElementById("ocrK1");
const ocrK1Axis = document.getElementById("ocrK1Axis");
const ocrK2 = document.getElementById("ocrK2");
const ocrK2Axis = document.getElementById("ocrK2Axis");
const ocrWTW = document.getElementById("ocrWTW");

const btnCancelBiometry = document.getElementById("btnCancelBiometry");
const btnConfirmBiometry = document.getElementById("btnConfirmBiometry");

// 現在の状態キャッシュ
let selectedModelData = null;
let currentPendingOrderData = null;
let currentAllowedPowers = [...GOOGLE_FORM_ALL_POWERS];

// ==========================================================================
// 3. 初期化処理
// ==========================================================================
document.addEventListener("DOMContentLoaded", () => {
  initModelSelect();
  initPowerOptions(GOOGLE_FORM_ALL_POWERS);
  initDefaultDate();
  initSavedEmail();
  setupEventListeners();
});

/**
 * メーカー別にoptgroupを組んでモデル一覧を生成 (Google Formの全12種)
 */
function initModelSelect() {
  const manufacturers = {};
  IOL_MODELS.forEach(m => {
    if (!manufacturers[m.manufacturer]) {
      manufacturers[m.manufacturer] = [];
    }
    manufacturers[m.manufacturer].push(m);
  });

  Object.keys(manufacturers).forEach(mfg => {
    const optGroup = document.createElement("optgroup");
    optGroup.label = mfg;

    manufacturers[mfg].forEach(m => {
      const option = document.createElement("option");
      option.value = m.displayName;
      option.textContent = m.displayName;
      optGroup.appendChild(option);
    });

    modelSelect.appendChild(optGroup);
  });
}

/**
 * 度数プルダウンの選択肢を生成
 */
function initPowerOptions(powers, defaultVal = "+20.0D") {
  const previousValue = powerSelect.value;
  powerSelect.innerHTML = '<option value="">度数を選択してください</option>';

  powers.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    powerSelect.appendChild(opt);
  });

  currentAllowedPowers = powers;

  if (previousValue && powers.includes(previousValue)) {
    powerSelect.value = previousValue;
  } else if (defaultVal && powers.includes(defaultVal)) {
    powerSelect.value = defaultVal;
  }
}

/**
 * 手術日の初期設定（今日以降を選択可能）
 */
function initDefaultDate() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  surgeryDateInput.min = `${yyyy}-${mm}-${dd}`;
}

/**
 * 保存されたメールアドレスの復元
 */
function initSavedEmail() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_EMAIL);
    if (saved && emailInput) {
      emailInput.value = saved;
    }
  } catch (e) {
    console.warn("localStorageへのアクセスに失敗しました:", e);
  }
}

// ==========================================================================
// 4. イベントリスナー設定
// ==========================================================================
function setupEventListeners() {
  // モデル選択変更
  modelSelect.addEventListener("change", handleModelChange);

  // トーリック型番変更
  toricModelSelect.addEventListener("change", () => clearFieldError("toricModelSelect"));

  // 度数変更 & ステッパー
  powerSelect.addEventListener("change", () => clearFieldError("iolPowerSelect"));
  btnPowerPrev.addEventListener("click", () => stepPower(-1));
  btnPowerNext.addEventListener("click", () => stepPower(1));

  // 日付・注文者・メールアドレス
  surgeryDateInput.addEventListener("change", () => clearFieldError("surgeryDateInput"));
  ordererSelect.addEventListener("change", () => clearFieldError("ordererSelect"));
  emailInput.addEventListener("input", () => clearFieldError("emailInput"));

  // 枚数
  document.querySelectorAll('input[name="quantity"]').forEach(r => {
    r.addEventListener("change", () => clearFieldError("quantity"));
  });

  // フォーム送信（確認画面表示）
  form.addEventListener("submit", handleFormSubmit);

  // モーダルボタン
  btnModalBack.addEventListener("click", hideConfirmModal);
  btnModalSubmit.addEventListener("click", handleExecuteOrder);
  btnNewOrder.addEventListener("click", handleResetForNewOrder);

  // 背景クリックでモーダル閉じ (未送信中のみ)
  confirmModal.addEventListener("click", (e) => {
    if (e.target === confirmModal && !btnModalSubmit.disabled) {
      hideConfirmModal();
    }
  });

  // 生体計測モーダル操作
  btnOpenBiometryModal.addEventListener("click", openBiometryModal);
  btnCancelBiometry.addEventListener("click", closeBiometryModal);
  btnConfirmBiometry.addEventListener("click", handleConfirmBiometry);

  // 読み取りモードタブ切り替え
  tabStaticMode.addEventListener("click", switchToStaticMode);
  tabLiveMode.addEventListener("click", switchToLiveMode);

  // 静止画モード: 画像選択・カメラ撮影
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

  // リアルタイムモード: 停止ボタン
  btnStopLiveOcr.addEventListener("click", stopLiveCamera);

  // 背景クリックで生体計測モーダルを閉じる
  biometryModal.addEventListener("click", (e) => {
    if (e.target === biometryModal) closeBiometryModal();
  });

  // ページを離れる・リロード時のカメラ停止
  window.addEventListener("beforeunload", stopLiveCamera);
}

// ==========================================================================
// 5. モデル選択変更時の条件分岐ロジック
// ==========================================================================
function handleModelChange() {
  clearFieldError("iolModelSelect");
  const selectedName = modelSelect.value;
  selectedModelData = IOL_MODELS.find(m => m.displayName === selectedName) || null;

  if (!selectedModelData) {
    hideToricField();
    alconCalcArea.classList.add("hidden");
    modelBadgeInfo.style.display = "none";
    modelBadgeInfo.innerHTML = "";
    powerRangeGuide.textContent = "※モデルを選択すると対応度数範囲（ステップ）に自動連動します";
    initPowerOptions(GOOGLE_FORM_ALL_POWERS);
    return;
  }

  // 1. モデルプロパティのタグ表示
  modelBadgeInfo.style.display = "flex";
  modelBadgeInfo.innerHTML = `
    <span class="meta-chip">メーカー: ${selectedModelData.manufacturer}</span>
    <span class="meta-chip">${selectedModelData.notes}</span>
    ${selectedModelData.isToric ? '<span class="meta-chip" style="background:#fef3c7; color:#b45309; border-color:#fde68a;">トーリック</span>' : ''}
  `;

  // 2. トーリック条件分岐 (トーリック時のみ表示・必須 / 非トーリック時は非表示・クリア)
  if (selectedModelData.isToric) {
    showToricField(selectedModelData.toricModels);
  } else {
    hideToricField();
  }

  // 3. Alcon Online Toric Calculator エリアの表示制御 (ALCONかつトーリック)
  if (selectedModelData.manufacturer === "ALCON" && selectedModelData.isToric) {
    alconCalcArea.classList.remove("hidden");
    if (selectedModelData.calculatorUrl) {
      alconCalcLink.href = selectedModelData.calculatorUrl;
    }
  } else {
    alconCalcArea.classList.add("hidden");
  }

  // 4. モデルごとのIOL Power許容範囲の絞り込み
  updatePowerOptionsForModel(selectedModelData);
}

function showToricField(models) {
  groupToricModel.classList.remove("hidden");
  toricModelSelect.setAttribute("required", "required");
  toricModelSelect.innerHTML = '<option value="">型番を選択してください</option>';

  models.forEach(item => {
    const opt = document.createElement("option");
    opt.value = item;
    opt.textContent = item;
    toricModelSelect.appendChild(opt);
  });
}

function hideToricField() {
  groupToricModel.classList.add("hidden");
  toricModelSelect.removeAttribute("required");
  toricModelSelect.value = "";
  toricModelSelect.innerHTML = '<option value="">型番を選択してください</option>';
  clearFieldError("toricModelSelect");
}

function updatePowerOptionsForModel(modelData) {
  const allowed = filterPowersByModel(modelData);
  powerRangeGuide.textContent = `※度数範囲: ${modelData.notes}`;

  const defaultVal = modelData.powerRange.default !== undefined
    ? (modelData.powerRange.default > 0 ? `+${modelData.powerRange.default.toFixed(1)}D` : `${modelData.powerRange.default.toFixed(1)}D`.replace("-0.0D", "0D"))
    : "+20.0D";

  initPowerOptions(allowed, defaultVal);
}

function filterPowersByModel(modelData) {
  const pr = modelData.powerRange;
  if (!pr) return GOOGLE_FORM_ALL_POWERS;

  return GOOGLE_FORM_ALL_POWERS.filter(str => {
    let num = parseFloat(str.replace("D", ""));
    if (isNaN(num)) return false;

    if (num < pr.min || num > pr.max) return false;

    if (pr.customSegments) {
      for (const seg of pr.customSegments) {
        if (num >= seg.min && num <= seg.max) {
          const rem = Math.abs(num - seg.min) % seg.step;
          return rem < 0.001 || Math.abs(rem - seg.step) < 0.001;
        }
      }
      return false;
    }

    const rem = Math.abs(num - pr.min) % pr.step;
    return rem < 0.001 || Math.abs(rem - pr.step) < 0.001;
  });
}

function stepPower(direction) {
  clearFieldError("iolPowerSelect");
  if (!currentAllowedPowers.length) return;

  const currentIndex = currentAllowedPowers.indexOf(powerSelect.value);
  if (currentIndex === -1) {
    const midIndex = Math.floor(currentAllowedPowers.length / 2);
    powerSelect.value = currentAllowedPowers[midIndex];
    return;
  }

  const nextIndex = currentIndex + direction;
  if (nextIndex >= 0 && nextIndex < currentAllowedPowers.length) {
    powerSelect.value = currentAllowedPowers[nextIndex];
  }
}

// ==========================================================================
// 6. バリデーション & 確認画面フロー
// ==========================================================================
function handleFormSubmit(e) {
  e.preventDefault();

  const isValid = validateOrderForm();
  if (!isValid) return;

  const quantityEl = document.querySelector('input[name="quantity"]:checked');
  const emailVal = emailInput.value.trim();

  // メールアドレスを次回用に保存
  try {
    localStorage.setItem(STORAGE_KEY_EMAIL, emailVal);
  } catch (err) {
    console.warn("localStorageへの保存に失敗しました:", err);
  }

  // GASへPOSTする正規データ構造 (要件指定の全項目)
  const orderData = {
    model: modelSelect.value, // メーカー / IOLモデル
    manufacturer: selectedModelData ? selectedModelData.manufacturer : "",
    toricModel: selectedModelData && selectedModelData.isToric ? toricModelSelect.value : "", // 非トーリックは空文字
    power: powerSelect.value, // IOL Power
    quantity: quantityEl ? quantityEl.value : "1 枚", // 枚数
    surgeryDate: surgeryDateInput.value, // 手術日
    orderer: ordererSelect.value, // 注文者
    email: emailVal, // メールアドレス
    notes: notesInput.value.trim(), // 備考
    submittedAt: new Date().toISOString() // 送信日時 (ISO文字列)
  };

  currentPendingOrderData = orderData;
  showConfirmModal(orderData);
}

/**
 * フォームの全項目バリデーション
 */
function validateOrderForm() {
  let isValid = true;
  let firstInvalidEl = null;

  // 1. メーカー名 / IOLモデル (必須)
  if (!modelSelect.value) {
    setFieldError("iolModelSelect", "メーカー名 / IOLモデルを選択してください");
    isValid = false;
    if (!firstInvalidEl) firstInvalidEl = modelSelect;
  } else {
    clearFieldError("iolModelSelect");
  }

  // 2. トーリック型番 (トーリックモデル選択時のみ必須)
  if (selectedModelData && selectedModelData.isToric) {
    if (!toricModelSelect.value) {
      setFieldError("toricModelSelect", "トーリック型番を選択してください");
      isValid = false;
      if (!firstInvalidEl) firstInvalidEl = toricModelSelect;
    } else {
      clearFieldError("toricModelSelect");
    }
  }

  // 3. IOLパワー (必須)
  if (!powerSelect.value) {
    setFieldError("iolPowerSelect", "IOLパワー (ディオプター) を選択してください");
    isValid = false;
    if (!firstInvalidEl) firstInvalidEl = powerSelect;
  } else {
    clearFieldError("iolPowerSelect");
  }

  // 4. 枚数 (必須)
  const quantitySelected = document.querySelector('input[name="quantity"]:checked');
  if (!quantitySelected) {
    setFieldError("quantity", "枚数を選択してください");
    isValid = false;
  } else {
    clearFieldError("quantity");
  }

  // 5. 手術日 (必須)
  if (!surgeryDateInput.value) {
    setFieldError("surgeryDateInput", "手術日を選択してください");
    isValid = false;
    if (!firstInvalidEl) firstInvalidEl = surgeryDateInput;
  } else {
    clearFieldError("surgeryDateInput");
  }

  // 6. 注文者 (必須)
  if (!ordererSelect.value) {
    setFieldError("ordererSelect", "注文者を選択してください");
    isValid = false;
    if (!firstInvalidEl) firstInvalidEl = ordererSelect;
  } else {
    clearFieldError("ordererSelect");
  }

  // 7. メールアドレス (必須 & 書式チェック)
  const emailVal = emailInput.value.trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailVal) {
    setFieldError("emailInput", "メールアドレスを入力してください");
    isValid = false;
    if (!firstInvalidEl) firstInvalidEl = emailInput;
  } else if (!emailRegex.test(emailVal)) {
    setFieldError("emailInput", "正しいメールアドレスの形式で入力してください（例: doctor@example.jp）");
    isValid = false;
    if (!firstInvalidEl) firstInvalidEl = emailInput;
  } else {
    clearFieldError("emailInput");
  }

  if (firstInvalidEl) {
    firstInvalidEl.scrollIntoView({ behavior: "smooth", block: "center" });
    firstInvalidEl.focus();
  }

  return isValid;
}

function setFieldError(fieldId, message) {
  const errEl = document.getElementById(`err-${fieldId}`);
  if (errEl) errEl.textContent = message;

  const inputEl = document.getElementById(fieldId);
  if (inputEl) inputEl.classList.add("is-invalid");
}

function clearFieldError(fieldId) {
  const errEl = document.getElementById(`err-${fieldId}`);
  if (errEl) errEl.textContent = "";

  const inputEl = document.getElementById(fieldId);
  if (inputEl) inputEl.classList.remove("is-invalid");
}

// ==========================================================================
// 7. モーダル表示制御 & サマリー作成
// ==========================================================================
function showConfirmModal(data) {
  document.getElementById("summaryModel").textContent = data.model;

  const toricRow = document.getElementById("summaryToricRow");
  if (data.toricModel) {
    toricRow.style.display = "flex";
    document.getElementById("summaryToric").textContent = data.toricModel;
  } else {
    toricRow.style.display = "none";
  }

  document.getElementById("summaryPower").textContent = data.power;
  document.getElementById("summaryQuantity").textContent = data.quantity;

  const dateObj = new Date(data.surgeryDate + "T00:00:00");
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const formattedDate = !isNaN(dateObj)
    ? `${dateObj.getFullYear()}年${dateObj.getMonth() + 1}月${dateObj.getDate()}日 (${weekdays[dateObj.getDay()]})`
    : data.surgeryDate;
  document.getElementById("summarySurgeryDate").textContent = formattedDate;

  document.getElementById("summaryOrderer").textContent = data.orderer;
  document.getElementById("summaryEmail").textContent = data.email;
  document.getElementById("summaryNotes").textContent = data.notes || "（なし）";

  // エラー表示リセット
  modalSubmitError.classList.add("hidden");

  confirmModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function hideConfirmModal() {
  if (btnModalSubmit.disabled) return; // 送信中は閉じられない
  confirmModal.classList.add("hidden");
  document.body.style.overflow = "";
}

// ==========================================================================
// 8. 注文送信処理 (GAS Web APIへの実POST送信)
// ==========================================================================
async function handleExecuteOrder() {
  if (!currentPendingOrderData) return;

  // 1. 二重送信防止 & UI表示切り替え
  btnModalSubmit.disabled = true;
  btnModalBack.disabled = true;
  btnModalSubmit.textContent = "送信しています…";
  modalSubmitError.classList.add("hidden");

  try {
    // 2. GAS Web APIへのPOST送信
    const result = await submitOrder(currentPendingOrderData);

    // 成功時: 完了モーダルを表示
    hideConfirmModal();
    showCompleteModal(currentPendingOrderData, result);
  } catch (err) {
    console.error("注文送信エラー:", err);

    // 失敗時: 入力内容を保持したままエラー表示 & 再送信可能にする
    modalSubmitErrorText.textContent = "送信に失敗しました。時間をおいて再度お試しください。";
    modalSubmitError.classList.remove("hidden");
  } finally {
    // ボタンの再活性化（再送信可能にする）
    btnModalSubmit.disabled = false;
    btnModalBack.disabled = false;
    btnModalSubmit.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="22" y1="2" x2="11" y2="13"></line>
        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
      </svg>
      注文を送信
    `;
  }
}

/**
 * GAS WebアプリへPOST送信する関数
 * - CORSプリフライト回避のため Content-Type: "text/plain;charset=utf-8" を使用
 * - JSON.stringify(payload) を送信
 */
async function submitOrder(payload) {
  console.log("==========================================");
  console.log("【GAS送信ペイロード (POST)】");
  console.log(JSON.stringify(payload, null, 2));
  console.log("URL:", ORDER_API_URL);
  console.log("==========================================");

  // ダミーURLの場合のガイダンス表示 (未設定時のフェイルセーフ)
  if (!ORDER_API_URL || ORDER_API_URL === "ここにGASのURL") {
    console.warn("※ ORDER_API_URL が未設定（ダミーURL）です。実環境ではGAS WebアプリのURLを設定してください。");
    // ダミーURLではfetchがエラーになり「送信に失敗しました」が表示される動作をテストできます
  }

  const response = await fetch(ORDER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`HTTP Error: ${response.status}`);
  }

  // GASのdoPost(e)から返却されたJSONをパース
  let data;
  try {
    data = await response.json();
  } catch (e) {
    // レスポンスがJSONでなくテキストの場合のハンドリング
    data = { success: true };
  }

  // GAS側でエラーが返却された場合
  if (data && (data.status === "error" || data.success === false)) {
    throw new Error(data.message || "GAS側で処理エラーが発生しました");
  }

  return {
    success: true,
    orderId: data.orderId || "IOL-" + Math.floor(100000 + Math.random() * 900000),
    message: data.message || "注文が正常に受付されました"
  };
}

/**
 * 注文完了モーダルの表示
 */
function showCompleteModal(orderData, result) {
  completeDetails.innerHTML = `
    <div style="margin-bottom: 8px;"><strong>受付番号:</strong> ${result.orderId}</div>
    <div style="margin-bottom: 4px;"><strong>IOLモデル:</strong> ${orderData.model}</div>
    ${orderData.toricModel ? `<div style="margin-bottom: 4px;"><strong>トーリック型番:</strong> ${orderData.toricModel}</div>` : ''}
    <div style="margin-bottom: 4px;"><strong>度数 / 枚数:</strong> ${orderData.power} / ${orderData.quantity}</div>
    <div style="margin-bottom: 4px;"><strong>手術予定日:</strong> ${orderData.surgeryDate}</div>
    <div style="margin-bottom: 4px;"><strong>注文者:</strong> ${orderData.orderer}</div>
    <div><strong>メールアドレス:</strong> ${orderData.email}</div>
  `;

  completeModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

/**
 * 新規注文入力へのリセット
 */
function handleResetForNewOrder() {
  completeModal.classList.add("hidden");
  document.body.style.overflow = "";

  form.reset();
  modelSelect.value = "";
  handleModelChange();
  initDefaultDate();
  initSavedEmail(); // 保存済みメールアドレスは再入力
  window.scrollTo({ top: 0, behavior: "smooth" });
  showToast("フォームをリセットしました");
}

// ==========================================================================
// 9. トーストヘルパー
// ==========================================================================
let toastTimer = null;
function showToast(message) {
  if (toastTimer) clearTimeout(toastTimer);
  toastNotice.textContent = message;
  toastNotice.classList.remove("hidden");

  toastTimer = setTimeout(() => {
    toastNotice.classList.add("hidden");
  }, 3500);
}

// ==========================================================================
// 10. 生体計測結果 (Biometry) データ構造 & 画像読み取りロジック
// ==========================================================================
/**
 * 生体計測データの内部状態管理
 * - rawAiValues: AI/OCRで抽出された未加工値（値と信頼度をペアで保持）
 * - userConfirmedValues: ユーザーが目視確認・修正した確定値（安全性担保）
 */
const biometryState = {
  // 1. AI/OCR抽出値 (各項目ごとに値と信頼度を分離保持)
  rawAiValues: {
    patientName: { value: null, confidence: null },
    al: { value: null, confidence: null },
    acd: { value: null, confidence: null },
    k1: { value: null, confidence: null },
    k1Axis: { value: null, confidence: null },
    k2: { value: null, confidence: null },
    k2Axis: { value: null, confidence: null },
    wtw: { value: null, confidence: null },
    rawText: "",
    engine: "Tesseract.js (Client-Side)",
    analyzedAt: null
  },

  // 2. ユーザーが目視確認・修正した確定値
  userConfirmedValues: {
    patientName: null,
    al: null,
    acd: null,
    k1: null,
    k1Axis: null,
    k2: null,
    k2Axis: null,
    wtw: null,
    isConfirmed: false,
    confirmedAt: null
  },

  // 選択画像のキャッシュ
  selectedImageDataUrl: null,
  selectedFileName: null
};

// 入力フィールドと対応するバッジ要素のマッピング
const BIOMETRY_FIELDS = [
  { id: "ocrPatientName", key: "patientName", badgeId: "statusBadge-patientName", label: "患者名", isText: true },
  { id: "ocrAL", key: "al", badgeId: "statusBadge-al", label: "眼軸長 AL", unit: "mm" },
  { id: "ocrACD", key: "acd", badgeId: "statusBadge-acd", label: "前房深度 ACD", unit: "mm" },
  { id: "ocrK1", key: "k1", badgeId: "statusBadge-k1", label: "K1", unit: "D" },
  { id: "ocrK1Axis", key: "k1Axis", badgeId: "statusBadge-k1Axis", label: "K1 Axis", unit: "°" },
  { id: "ocrK2", key: "k2", badgeId: "statusBadge-k2", label: "K2", unit: "D" },
  { id: "ocrK2Axis", key: "k2Axis", badgeId: "statusBadge-k2Axis", label: "K2 Axis", unit: "°" },
  { id: "ocrWTW", key: "wtw", badgeId: "statusBadge-wtw", label: "角膜径 WTW", unit: "mm" }
];

// ==========================================================================
// 10-A. リアルタイム連続読み取り状態管理 (コンセンサス安定化方式)
// ==========================================================================
const liveOcrState = {
  stream: null,
  intervalId: null,
  isProcessing: false,
  sampleIntervalMs: 800, // 約800msごとに1フレーム解析
  requiredMatches: 3,    // 3フレーム連続または累積一致で「読み取り済み」判定
  // 候補追跡バッファ
  history: {
    patientName: { candidate: null, count: 0 },
    al: { candidate: null, count: 0 },
    acd: { candidate: null, count: 0 },
    k1: { candidate: null, count: 0 },
    k1Axis: { candidate: null, count: 0 },
    k2: { candidate: null, count: 0 },
    k2Axis: { candidate: null, count: 0 },
    wtw: { candidate: null, count: 0 }
  },
  // 確定フラグ
  confirmed: {
    patientName: false,
    al: false,
    acd: false,
    k1: false,
    k1Axis: false,
    k2: false,
    k2Axis: false,
    wtw: false
  }
};

/**
 * 生体計測モーダルを開く
 */
function openBiometryModal() {
  // すでに確定値がある場合は入力欄に反映、なければ空欄
  BIOMETRY_FIELDS.forEach(f => {
    const el = document.getElementById(f.id);
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
          const inputEl = document.getElementById(f.id);
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

  // 全主要項目（患者名、AL、K1、K2）が確定したかチェック
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
    // 文字列（患者名）: 完全一致（大文字小文字・スペース変更なし）
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

  const badgeEl = document.getElementById(fieldDef.badgeId);
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
      const inputEl = document.getElementById(f.id);

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
    const inputEl = document.getElementById(f.id);
    if (inputEl) inputEl.value = "";
    updateFieldBadgeStatus(f.key, "unrecognized", "未検出");
  });
}

/**
 * 静止画像用のCanvas前処理
 */
function preprocessImageForOcr(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const maxDim = 1600;
      let width = img.width;
      let height = img.height;

      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);

      resolve(preprocessCanvasForOcr(canvas));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/**
 * Canvas要素のグレースケール & コントラスト強調処理
 */
function preprocessCanvasForOcr(canvas) {
  const ctx = canvas.getContext("2d");
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  const factor = 1.35;

  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const contrasted = Math.min(255, Math.max(0, factor * (gray - 128) + 128));
    data[i] = contrasted;
    data[i + 1] = contrasted;
    data[i + 2] = contrasted;
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/**
 * OA-2000等の測定結果テキストパース正規表現
 * - 患者名（ローマ字）抽出を含む
 * - 大文字小文字・スペース・姓名順を勝手に補正しない
 */
function parseBiometryText(text, baseConfidencePct) {
  const result = {
    patientName: null,
    al: null,
    acd: null,
    k1: null,
    k1Axis: null,
    k2: null,
    k2Axis: null,
    wtw: null
  };

  if (!text) return result;

  const cleanText = text.replace(/,/g, ".").replace(/[\r\n]+/g, "\n");
  const baseConf = Math.min(0.95, Math.max(0.40, baseConfidencePct / 100));

  // 0. 患者名 (ローマ字) パース
  // 例: "Name: YAMADA TARO", "NAME TANAKA HANAKO", "Patient: SUZUKI ICHIRO"
  // 大文字小文字・スペース・姓名順をそのまま保持
  const nameMatch = cleanText.match(/(?:NAME|Name|PATIENT|Patient)[^\w\n]{0,8}([A-Za-z]+(?:\s+[A-Za-z]+)+)/);
  if (nameMatch) {
    const rawName = nameMatch[1].trim();
    if (rawName.length >= 3 && !/\d/.test(rawName)) {
      result.patientName = {
        value: rawName,
        confidence: baseConf
      };
    }
  }

  // 1. 眼軸長 AL
  const alMatch = cleanText.match(/(?:AL|AXIAL|Axial(?:\s*Length)?)[^\d]{0,8}(\d{2}\.\d{1,3})/i);
  if (alMatch) {
    const val = parseFloat(alMatch[1]);
    if (!isNaN(val) && val >= 16.0 && val <= 38.0) {
      result.al = {
        value: Math.round(val * 100) / 100,
        confidence: baseConf
      };
    }
  }

  // 2. 前房深度 ACD
  const acdMatch = cleanText.match(/(?:ACD|A\.C\.D)[^\d]{0,8}(\d\.\d{1,3})/i);
  if (acdMatch) {
    const val = parseFloat(acdMatch[1]);
    if (!isNaN(val) && val >= 1.5 && val <= 5.5) {
      result.acd = {
        value: Math.round(val * 100) / 100,
        confidence: baseConf
      };
    }
  }

  // 3. K1 & K1 Axis
  const k1Match = cleanText.match(/(?:K1|R1)[^\d]{0,8}(\d{2}\.\d{1,3})(?:[^\d\n]{1,15}(\d{1,3})(?:°|deg|度)?)?/i);
  if (k1Match) {
    const valK1 = parseFloat(k1Match[1]);
    if (!isNaN(valK1) && valK1 >= 32.0 && valK1 <= 58.0) {
      result.k1 = {
        value: Math.round(valK1 * 100) / 100,
        confidence: baseConf
      };

      if (k1Match[2]) {
        const valAxis = parseInt(k1Match[2], 10);
        if (!isNaN(valAxis) && valAxis >= 0 && valAxis <= 180) {
          result.k1Axis = {
            value: valAxis,
            confidence: baseConf * 0.9
          };
        }
      }
    }
  }

  // 4. K2 & K2 Axis
  const k2Match = cleanText.match(/(?:K2|R2)[^\d]{0,8}(\d{2}\.\d{1,3})(?:[^\d\n]{1,15}(\d{1,3})(?:°|deg|度)?)?/i);
  if (k2Match) {
    const valK2 = parseFloat(k2Match[1]);
    if (!isNaN(valK2) && valK2 >= 32.0 && valK2 <= 58.0) {
      result.k2 = {
        value: Math.round(valK2 * 100) / 100,
        confidence: baseConf
      };

      if (k2Match[2]) {
        const valAxis = parseInt(k2Match[2], 10);
        if (!isNaN(valAxis) && valAxis >= 0 && valAxis <= 180) {
          result.k2Axis = {
            value: valAxis,
            confidence: baseConf * 0.9
          };
        }
      }
    }
  }

  // 5. 角膜径 WTW
  const wtwMatch = cleanText.match(/(?:WTW|W-W|White)[^\d]{0,8}(\d{1,2}\.\d{1,2})/i);
  if (wtwMatch) {
    const valWtw = parseFloat(wtwMatch[1]);
    if (!isNaN(valWtw) && valWtw >= 8.5 && valWtw <= 14.5) {
      result.wtw = {
        value: Math.round(valWtw * 10) / 10,
        confidence: baseConf * 0.85
      };
    }
  }

  return result;
}

/**
 * ユーザーが手動編集したときのバッジ状態解除
 */
BIOMETRY_FIELDS.forEach(f => {
  const el = document.getElementById(f.id);
  if (el) {
    el.addEventListener("input", () => {
      updateFieldBadgeStatus(f.key, "confirmed", "✓ 手動入力");
    });
  }
});

/**
 * 計測値の確定ハンドラ
 * 安全設計:
 * - ユーザーが目視確認・修正した値のみを userConfirmedValues に格納
 * - 注文送信やAlcon Calculatorへの転記は行わない
 */
function handleConfirmBiometry() {
  stopLiveCamera();

  const confirmedValues = {
    patientName: ocrPatientName.value.trim() || null,
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

  // 最低限ALまたはK1または患者名が入力されているかチェック
  if (confirmedValues.al === null && confirmedValues.k1 === null && confirmedValues.patientName === null) {
    alert("眼軸長（AL）、角膜屈折力（K1/K2）、または患者名を入力してください。");
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
  if (v.patientName) items.push(`患者名: ${v.patientName}`);
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
