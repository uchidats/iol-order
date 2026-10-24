import { GOOGLE_FORM_ALL_POWERS } from "../data/iol-models.js";
import { resolveAdoptedModels } from "../data/static-repository.js";
import { filterPowersByModel, defaultPowerLabel } from "../domain/power-filter.js";
import { isValidEmail } from "../domain/order-validation.js";
import { STORAGE_KEY_EMAIL, ORDER_MODES } from "../config.js";
import { submitOrder, OrderError } from "../api/order-client.js";
import { $, escapeHtml, setFieldError, clearFieldError, showToast } from "./dom.js";

// 現在の状態
let appConfig = null;
let availableModels = [];
let selectedModelData = null;
let currentPendingOrderData = null;
let currentAllowedPowers = [...GOOGLE_FORM_ALL_POWERS];
let currentFacility = null; // { id, name }（Firebase有効時のみ）
let facilityRepository = null;
let facilityRepositoryId = null;

const el = {};

function cacheElements() {
  Object.assign(el, {
    form: $("iolOrderForm"),
    modelSelect: $("iolModelSelect"),
    modelBadgeInfo: $("modelBadgeInfo"),
    groupToricModel: $("groupToricModel"),
    toricModelSelect: $("toricModelSelect"),
    alconCalcArea: $("alconCalcArea"),
    alconCalcLink: $("alconCalcLink"),
    powerSelect: $("iolPowerSelect"),
    btnPowerPrev: $("btnPowerPrev"),
    btnPowerNext: $("btnPowerNext"),
    powerRangeGuide: $("powerRangeGuide"),
    surgeryDateInput: $("surgeryDateInput"),
    ordererSelect: $("ordererSelect"),
    emailInput: $("emailInput"),
    notesInput: $("notesInput"),
    confirmModal: $("confirmModal"),
    btnModalBack: $("btnModalBack"),
    btnModalSubmit: $("btnModalSubmit"),
    modalSubmitError: $("modalSubmitError"),
    modalSubmitErrorText: $("modalSubmitErrorText"),
    completeModal: $("completeModal"),
    completeDetails: $("completeDetails"),
    btnNewOrder: $("btnNewOrder")
  });
}

/**
 * 注文フォームの初期化
 * @param {object} deps
 * @param {object} deps.config アプリ設定
 * @param {import("../data/schema.js").FacilityRepository} deps.repository
 * @param {string} deps.facilityId
 * @param {{id:string, name:string}} [deps.facility] 注文確認画面に表示する施設（Firebase有効時）
 */
export async function initOrderForm({ config, repository, facilityId, facility = null }) {
  cacheElements();
  appConfig = config;
  currentFacility = facility;
  facilityRepository = repository;
  facilityRepositoryId = facilityId;

  const [adoptedIols, orderers] = await Promise.all([
    repository.listAdoptedIols(facilityId),
    repository.listOrderers(facilityId)
  ]);
  availableModels = resolveAdoptedModels(adoptedIols);

  initModelSelect();
  initOrdererSelect(orderers.filter(o => o.active));
  initPowerOptions(GOOGLE_FORM_ALL_POWERS);
  initDefaultDate();
  initSavedEmail();
  setupEventListeners();
  renderModeBanner();
}

/**
 * 開発モード時の表示（実発注されないことを明示）
 */
function renderModeBanner() {
  if (appConfig.orderMode === ORDER_MODES.GAS) return;
  const banner = document.createElement("div");
  banner.className = "modal-error-alert";
  banner.setAttribute("role", "status");
  banner.style.margin = "0 0 12px";
  banner.textContent = "【開発モード】注文は送信されません。実際の発注は行われません。";
  el.form.parentNode.insertBefore(banner, el.form);
}

function initModelSelect() {
  const manufacturers = {};
  availableModels.forEach(m => {
    if (!manufacturers[m.manufacturer]) manufacturers[m.manufacturer] = [];
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
    el.modelSelect.appendChild(optGroup);
  });
}

function initOrdererSelect(orderers) {
  orderers.forEach(o => {
    const option = document.createElement("option");
    option.value = o.name;
    option.textContent = o.name;
    el.ordererSelect.appendChild(option);
  });
}

function initPowerOptions(powers, defaultVal = "+20.0D") {
  const previousValue = el.powerSelect.value;
  el.powerSelect.innerHTML = '<option value="">度数を選択してください</option>';

  powers.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    el.powerSelect.appendChild(opt);
  });

  currentAllowedPowers = powers;

  if (previousValue && powers.includes(previousValue)) {
    el.powerSelect.value = previousValue;
  } else if (defaultVal && powers.includes(defaultVal)) {
    el.powerSelect.value = defaultVal;
  }
}

function initDefaultDate() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  el.surgeryDateInput.min = `${yyyy}-${mm}-${dd}`;
}

function initSavedEmail() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_EMAIL);
    if (saved && el.emailInput) el.emailInput.value = saved;
  } catch (e) {
    console.warn("localStorageへのアクセスに失敗しました:", e);
  }
}

function setupEventListeners() {
  el.modelSelect.addEventListener("change", handleModelChange);
  el.toricModelSelect.addEventListener("change", () => clearFieldError("toricModelSelect"));

  el.powerSelect.addEventListener("change", () => clearFieldError("iolPowerSelect"));
  el.btnPowerPrev.addEventListener("click", () => stepPower(-1));
  el.btnPowerNext.addEventListener("click", () => stepPower(1));

  el.surgeryDateInput.addEventListener("change", () => clearFieldError("surgeryDateInput"));
  el.ordererSelect.addEventListener("change", () => clearFieldError("ordererSelect"));
  el.emailInput.addEventListener("input", () => clearFieldError("emailInput"));

  document.querySelectorAll('input[name="quantity"]').forEach(r => {
    r.addEventListener("change", () => clearFieldError("quantity"));
  });

  el.form.addEventListener("submit", handleFormSubmit);

  el.btnModalBack.addEventListener("click", hideConfirmModal);
  el.btnModalSubmit.addEventListener("click", handleExecuteOrder);
  el.btnNewOrder.addEventListener("click", handleResetForNewOrder);

  // 背景クリックでモーダル閉じ (送信中は不可)
  el.confirmModal.addEventListener("click", (e) => {
    if (e.target === el.confirmModal && !el.btnModalSubmit.disabled) hideConfirmModal();
  });
}

// ==========================================================================
// モデル選択変更時の条件分岐ロジック
// ==========================================================================
function handleModelChange() {
  clearFieldError("iolModelSelect");
  const selectedName = el.modelSelect.value;
  selectedModelData = availableModels.find(m => m.displayName === selectedName) || null;

  if (!selectedModelData) {
    hideToricField();
    el.alconCalcArea.classList.add("hidden");
    el.modelBadgeInfo.style.display = "none";
    el.modelBadgeInfo.innerHTML = "";
    el.powerRangeGuide.textContent = "※モデルを選択すると対応度数範囲（ステップ）に自動連動します";
    initPowerOptions(GOOGLE_FORM_ALL_POWERS);
    return;
  }

  el.modelBadgeInfo.style.display = "flex";
  el.modelBadgeInfo.innerHTML = `
    <span class="meta-chip">メーカー: ${selectedModelData.manufacturer}</span>
    <span class="meta-chip">${selectedModelData.notes}</span>
    ${selectedModelData.isToric ? '<span class="meta-chip" style="background:#fef3c7; color:#b45309; border-color:#fde68a;">トーリック</span>' : ''}
  `;

  if (selectedModelData.isToric) {
    showToricField(selectedModelData.toricModels);
  } else {
    hideToricField();
  }

  if (selectedModelData.manufacturer === "ALCON" && selectedModelData.isToric) {
    el.alconCalcArea.classList.remove("hidden");
    if (selectedModelData.calculatorUrl) {
      el.alconCalcLink.href = selectedModelData.calculatorUrl;
    }
  } else {
    el.alconCalcArea.classList.add("hidden");
  }

  updatePowerOptionsForModel(selectedModelData);
}

function showToricField(models) {
  el.groupToricModel.classList.remove("hidden");
  el.toricModelSelect.setAttribute("required", "required");
  el.toricModelSelect.innerHTML = '<option value="">型番を選択してください</option>';

  models.forEach(item => {
    const opt = document.createElement("option");
    opt.value = item;
    opt.textContent = item;
    el.toricModelSelect.appendChild(opt);
  });
}

function hideToricField() {
  el.groupToricModel.classList.add("hidden");
  el.toricModelSelect.removeAttribute("required");
  el.toricModelSelect.value = "";
  el.toricModelSelect.innerHTML = '<option value="">型番を選択してください</option>';
  clearFieldError("toricModelSelect");
}

function updatePowerOptionsForModel(modelData) {
  const allowed = filterPowersByModel(modelData);
  el.powerRangeGuide.textContent = `※度数範囲: ${modelData.notes}`;
  initPowerOptions(allowed, defaultPowerLabel(modelData));
}

function stepPower(direction) {
  clearFieldError("iolPowerSelect");
  if (!currentAllowedPowers.length) return;

  const currentIndex = currentAllowedPowers.indexOf(el.powerSelect.value);
  if (currentIndex === -1) {
    const midIndex = Math.floor(currentAllowedPowers.length / 2);
    el.powerSelect.value = currentAllowedPowers[midIndex];
    return;
  }

  const nextIndex = currentIndex + direction;
  if (nextIndex >= 0 && nextIndex < currentAllowedPowers.length) {
    el.powerSelect.value = currentAllowedPowers[nextIndex];
  }
}

// ==========================================================================
// バリデーション & 確認画面フロー
// ==========================================================================
function handleFormSubmit(e) {
  e.preventDefault();

  if (!validateOrderForm()) return;

  const quantityEl = document.querySelector('input[name="quantity"]:checked');
  const emailVal = el.emailInput.value.trim();

  try {
    localStorage.setItem(STORAGE_KEY_EMAIL, emailVal);
  } catch (err) {
    console.warn("localStorageへの保存に失敗しました:", err);
  }

  currentPendingOrderData = {
    model: el.modelSelect.value,
    manufacturer: selectedModelData ? selectedModelData.manufacturer : "",
    toricModel: selectedModelData && selectedModelData.isToric ? el.toricModelSelect.value : "",
    power: el.powerSelect.value,
    quantity: quantityEl ? quantityEl.value : "1 枚",
    surgeryDate: el.surgeryDateInput.value,
    orderer: el.ordererSelect.value,
    email: emailVal,
    notes: el.notesInput.value.trim(),
    submittedAt: new Date().toISOString(),
    // 再送時の重複受付をサーバー側で検出するための識別子（注文番号ではない）。
    // 同じ確認内容の再送では同一値を使う。
    clientRequestId: crypto.randomUUID()
  };
  if (currentFacility) {
    currentPendingOrderData.facilityId = currentFacility.id;
    currentPendingOrderData.facilityName = currentFacility.name;
  }

  showConfirmModal(currentPendingOrderData);
}

function validateOrderForm() {
  let isValid = true;
  let firstInvalidEl = null;
  const invalid = (fieldId, message, focusEl) => {
    setFieldError(fieldId, message);
    isValid = false;
    if (!firstInvalidEl && focusEl) firstInvalidEl = focusEl;
  };

  if (!el.modelSelect.value) {
    invalid("iolModelSelect", "メーカー名 / IOLモデルを選択してください", el.modelSelect);
  } else {
    clearFieldError("iolModelSelect");
  }

  if (selectedModelData && selectedModelData.isToric) {
    if (!el.toricModelSelect.value) {
      invalid("toricModelSelect", "トーリック型番を選択してください", el.toricModelSelect);
    } else {
      clearFieldError("toricModelSelect");
    }
  }

  if (!el.powerSelect.value) {
    invalid("iolPowerSelect", "IOLパワー (ディオプター) を選択してください", el.powerSelect);
  } else {
    clearFieldError("iolPowerSelect");
  }

  if (!document.querySelector('input[name="quantity"]:checked')) {
    invalid("quantity", "枚数を選択してください");
  } else {
    clearFieldError("quantity");
  }

  if (!el.surgeryDateInput.value) {
    invalid("surgeryDateInput", "手術日を選択してください", el.surgeryDateInput);
  } else {
    clearFieldError("surgeryDateInput");
  }

  if (!el.ordererSelect.value) {
    invalid("ordererSelect", "注文者を選択してください", el.ordererSelect);
  } else {
    clearFieldError("ordererSelect");
  }

  const emailVal = el.emailInput.value.trim();
  if (!emailVal) {
    invalid("emailInput", "メールアドレスを入力してください", el.emailInput);
  } else if (!isValidEmail(emailVal)) {
    invalid("emailInput", "正しいメールアドレスの形式で入力してください（例: doctor@example.jp）", el.emailInput);
  } else {
    clearFieldError("emailInput");
  }

  if (firstInvalidEl) {
    firstInvalidEl.scrollIntoView({ behavior: "smooth", block: "center" });
    firstInvalidEl.focus();
  }

  return isValid;
}

// ==========================================================================
// モーダル表示制御 & サマリー作成
// ==========================================================================
function showConfirmModal(data) {
  // 発注先の取り違え防止のため、施設名を明示する
  const facilityRow = $("summaryFacilityRow");
  if (data.facilityName) {
    facilityRow.style.display = "flex";
    $("summaryFacility").textContent = data.facilityName;
  } else {
    facilityRow.style.display = "none";
  }

  $("summaryModel").textContent = data.model;

  const toricRow = $("summaryToricRow");
  if (data.toricModel) {
    toricRow.style.display = "flex";
    $("summaryToric").textContent = data.toricModel;
  } else {
    toricRow.style.display = "none";
  }

  $("summaryPower").textContent = data.power;
  $("summaryQuantity").textContent = data.quantity;

  const dateObj = new Date(data.surgeryDate + "T00:00:00");
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const formattedDate = !isNaN(dateObj)
    ? `${dateObj.getFullYear()}年${dateObj.getMonth() + 1}月${dateObj.getDate()}日 (${weekdays[dateObj.getDay()]})`
    : data.surgeryDate;
  $("summarySurgeryDate").textContent = formattedDate;

  $("summaryOrderer").textContent = data.orderer;
  $("summaryEmail").textContent = data.email;
  $("summaryNotes").textContent = data.notes || "（なし）";

  el.modalSubmitError.classList.add("hidden");

  el.confirmModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function hideConfirmModal() {
  if (el.btnModalSubmit.disabled) return; // 送信中は閉じられない
  el.confirmModal.classList.add("hidden");
  document.body.style.overflow = "";
}

// ==========================================================================
// 注文送信処理
// ==========================================================================
const RETAIN_NOTE = "入力内容は保持されています。";

function describeOrderError(err) {
  if (!(err instanceof OrderError)) {
    return `送信中に予期しないエラーが発生しました。${RETAIN_NOTE}`;
  }
  switch (err.kind) {
    case "dryrun":
      return `【開発モード】実際の発注は行われていません。${RETAIN_NOTE}`;
    case "failed":
      return `注文は受け付けられていません（${err.message}）。内容を確認して再送信できます。${RETAIN_NOTE}`;
    default: // unconfirmed
      return "送信結果を確認できませんでした。注文が受け付けられている可能性があります。" +
        `再送信する前に、受付状況（メール・ディーラー）を確認してください。${RETAIN_NOTE}`;
  }
}

async function handleExecuteOrder() {
  if (!currentPendingOrderData) return;

  el.btnModalSubmit.disabled = true;
  el.btnModalBack.disabled = true;
  el.btnModalSubmit.textContent = "送信しています…";
  el.modalSubmitError.classList.add("hidden");

  try {
    if (appConfig.orderMode !== ORDER_MODES.GAS) {
      console.log("【dryrun】送信予定のペイロード（送信はしていません）:", currentPendingOrderData);
    }
    const result = await submitOrder(currentPendingOrderData, appConfig);

    // サーバーが受付番号を返した場合のみ完了扱い
    el.btnModalSubmit.disabled = false;
    el.btnModalBack.disabled = false;
    hideConfirmModal();
    showCompleteModal(currentPendingOrderData, result);
  } catch (err) {
    if (err instanceof OrderError && err.kind === "dryrun") {
      console.info("注文は送信されていません（開発モード）");
    } else {
      console.error("注文送信エラー:", err);
    }
    el.modalSubmitErrorText.textContent = describeOrderError(err);
    el.modalSubmitError.classList.remove("hidden");
  } finally {
    el.btnModalSubmit.disabled = false;
    el.btnModalBack.disabled = false;
    el.btnModalSubmit.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="22" y1="2" x2="11" y2="13"></line>
        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
      </svg>
      注文を送信
    `;
  }
}

function showCompleteModal(orderData, result) {
  el.completeDetails.innerHTML = `
    <div style="margin-bottom: 8px;"><strong>受付番号:</strong> ${escapeHtml(result.orderId)}</div>
    <div style="margin-bottom: 4px;"><strong>IOLモデル:</strong> ${escapeHtml(orderData.model)}</div>
    ${orderData.toricModel ? `<div style="margin-bottom: 4px;"><strong>トーリック型番:</strong> ${escapeHtml(orderData.toricModel)}</div>` : ""}
    <div style="margin-bottom: 4px;"><strong>度数 / 枚数:</strong> ${escapeHtml(orderData.power)} / ${escapeHtml(orderData.quantity)}</div>
    <div style="margin-bottom: 4px;"><strong>手術予定日:</strong> ${escapeHtml(orderData.surgeryDate)}</div>
    <div style="margin-bottom: 4px;"><strong>注文者:</strong> ${escapeHtml(orderData.orderer)}</div>
    <div><strong>メールアドレス:</strong> ${escapeHtml(orderData.email)}</div>
  `;

  el.completeModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function handleResetForNewOrder() {
  el.completeModal.classList.add("hidden");
  document.body.style.overflow = "";
  currentPendingOrderData = null;

  el.form.reset();
  el.modelSelect.value = "";
  handleModelChange();
  initDefaultDate();
  initSavedEmail();
  window.scrollTo({ top: 0, behavior: "smooth" });
  showToast("フォームをリセットしました");
}

/**
 * 入力途中の内容があるか（施設切替時の破棄確認用）
 * 保存済みメールアドレスや既定値だけの状態は「入力あり」とみなさない。
 */
export function isOrderFormDirty() {
  if (!el.form) return false;
  return Boolean(
    el.modelSelect.value || el.ordererSelect.value || el.surgeryDateInput.value ||
    el.notesInput.value.trim() || currentPendingOrderData
  );
}

/**
 * 施設設定の変更（注文者・採用IOL）を注文フォームの選択肢へ反映する。
 * 入力済みの値は、新しい選択肢にも存在する場合のみ維持する。
 */
export async function reloadFacilityOptions() {
  if (!facilityRepository || !el.form) return;
  const [adoptedIols, orderers] = await Promise.all([
    facilityRepository.listAdoptedIols(facilityRepositoryId),
    facilityRepository.listOrderers(facilityRepositoryId)
  ]);

  const prevModel = el.modelSelect.value;
  const prevOrderer = el.ordererSelect.value;

  availableModels = resolveAdoptedModels(adoptedIols);
  while (el.modelSelect.children.length > 1) el.modelSelect.removeChild(el.modelSelect.lastChild);
  while (el.ordererSelect.children.length > 1) el.ordererSelect.removeChild(el.ordererSelect.lastChild);
  initModelSelect();
  initOrdererSelect(orderers.filter(o => o.active));

  el.ordererSelect.value = [...el.ordererSelect.options].some(o => o.value === prevOrderer) ? prevOrderer : "";
  if (prevModel && !availableModels.some(m => m.displayName === prevModel)) {
    el.modelSelect.value = "";
    handleModelChange(); // 採用解除されたモデルが選ばれていた場合はリセット
  } else {
    el.modelSelect.value = prevModel;
  }
}
