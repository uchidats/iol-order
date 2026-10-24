import { resolveAdoptedModels } from "../data/static-repository.js";
import { buildLensOptions } from "../domain/lens-options.js";
import { toOrderLines, totalQuantity } from "../domain/order-lines.js";
import { createLensLines } from "./lens-lines.js";
import { ORDER_MODES } from "../config.js";
import { submitOrder, OrderError } from "../api/order-client.js";
import { buildCreateOrderRequest } from "../domain/order-request.js";
import { describeCallableError } from "../data/registration-api.js";
import { $, escapeHtml, setFieldError, clearFieldError, showToast } from "./dom.js";

// 現在の状態
let appConfig = null;
let orderApi = null; // 開発用のサーバー受付(createOrder)。server-dev のときだけ使う
let availableModels = [];
let lensOptions = [];           // 採用済み系列を、正式型番ごとの選択肢に展開したもの
let lensLines = null;           // 複数明細の入力欄(lens-lines.js)
let currentPendingOrderData = null;
let currentFacility = null; // { id, name }（Firebase有効時のみ）
let facilityRepository = null;
let facilityRepositoryId = null;

const el = {};

function cacheElements() {
  Object.assign(el, {
    form: $("iolOrderForm"),
    lensLinesBox: $("lensLines"),
    btnAddLine: $("btnAddLine"),
    alconCalcArea: $("alconCalcArea"),
    alconCalcLink: $("alconCalcLink"),
    ordererSelect: $("ordererSelect"),
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
 * @param {{createOrder:Function}} [deps.orderApi] サーバー受付(server-dev のときのみ使用)
 */
export async function initOrderForm({ config, repository, facilityId, facility = null, orderApi: api = null }) {
  cacheElements();
  appConfig = config;
  orderApi = api;
  currentFacility = facility;
  facilityRepository = repository;
  facilityRepositoryId = facilityId;

  const [adoptedIols, orderers] = await Promise.all([
    repository.listAdoptedIols(facilityId),
    repository.listOrderers(facilityId)
  ]);
  availableModels = resolveAdoptedModels(adoptedIols);

  lensOptions = buildLensOptions(availableModels);
  lensLines = createLensLines({
    container: el.lensLinesBox,
    addButton: el.btnAddLine,
    getOptions: () => lensOptions,
    minDate: todayString,
    onChange: updateAlconGuide
  });
  initOrdererSelect(orderers.filter(o => o.active));
  setupEventListeners();
  renderModeBadge();
}

/** 今日(端末のローカル日付)。手術日の最小値 */
function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** いずれかの明細が ALCON のトーリックなら、計算ツールの案内を表示する */
function updateAlconGuide() {
  if (!lensLines) return; // 明細の入力欄を作っている最中
  const url = lensLines.alconCalculator();
  el.alconCalcArea.classList.toggle("hidden", url === null);
  if (url) el.alconCalcLink.href = url;
}

/**
 * ヘッダー右側の状態表示。HTML の既定は「開発モード」で、実送信が有効な設定(gas)のときだけ「実運用版」にする。
 * 表示だけで、送信の可否は submitOrder(config.orderMode)で決まる。
 */
function renderModeBadge() {
  const badge = document.getElementById("systemBadge");
  if (!badge) return;
  badge.textContent = appConfig.orderMode === ORDER_MODES.GAS ? "実運用版"
    : appConfig.orderMode === ORDER_MODES.SERVER_DEV ? "開発用受付" : "開発モード";
}

/** 選択中の注文者のマスターに登録されたメールアドレス(未選択・未登録は空) */
function selectedOrdererEmail() {
  const opt = el.ordererSelect.selectedOptions && el.ordererSelect.selectedOptions[0];
  return opt && opt.value ? (opt.dataset.email || "").trim() : "";
}

function selectedOrdererId() {
  const opt = el.ordererSelect.selectedOptions && el.ordererSelect.selectedOptions[0];
  return opt && opt.value ? (opt.dataset.id || "") : "";
}

function initOrdererSelect(orderers) {
  orderers.forEach(o => {
    const option = document.createElement("option");
    option.value = o.name;
    option.textContent = o.name;
    option.dataset.id = o.id || "";
    option.dataset.email = (o.email || "").trim(); // 注文者マスターのメール(ログインユーザーのメールではない)
    el.ordererSelect.appendChild(option);
  });
}

function setupEventListeners() {
  el.ordererSelect.addEventListener("change", () => clearFieldError("ordererSelect"));

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
// ==========================================================================
// バリデーション & 確認画面フロー
// ==========================================================================
function handleFormSubmit(e) {
  e.preventDefault();

  if (!validateOrderForm()) return;

  const lines = toOrderLines(lensLines.values());
  // 注文者のメールアドレスは、選択された注文者のマスターデータから取得する(ログインユーザーのメールとは別物)
  const emailVal = selectedOrdererEmail();

  currentPendingOrderData = {
    // 明細(複数)。各明細は、系列名(model)・系列ID(modelId)・メーカー・トーリック正式型番(toricModel)・度数・枚数・手術日を持つ
    lines,
    totalQuantity: totalQuantity(lines),
    orderer: el.ordererSelect.value,
    ordererId: selectedOrdererId(),
    email: emailVal,
    notes: el.notesInput.value.trim(),
    submittedAt: new Date().toISOString(),
    // 再送時の重複受付をサーバー側で検出するための識別子（注文番号ではない）。
    // 同じ確認内容の再送では同一値を使う。
    clientRequestId: crypto.randomUUID()
  };
  if (lines.length === 1) {
    // 従来の単一IOL形式(旧経路・ログ)との互換: 1明細のときだけ、従来のトップレベルの項目も付ける
    const l = lines[0];
    Object.assign(currentPendingOrderData, {
      model: l.model, modelId: l.modelId, manufacturer: l.manufacturer, toricModel: l.toricModel,
      power: l.power, quantity: `${l.quantity} 枚`, surgeryDate: l.surgeryDate
    });
  }
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

  const lens = lensLines.validate(); // 全明細(モデル・度数・枚数・手術日・重複)
  if (!lens.ok) invalid("lensLines", "", lens.firstInvalid);

  if (!el.ordererSelect.value) {
    invalid("ordererSelect", "注文者を選択してください", el.ordererSelect);
  } else {
    clearFieldError("ordererSelect");
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
function formatDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return isNaN(d) ? iso : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${["日", "月", "火", "水", "木", "金", "土"][d.getDay()]})`;
}

function showConfirmModal(data) {
  // 発注先の取り違え防止のため、施設名を明示する
  const facilityRow = $("summaryFacilityRow");
  if (data.facilityName) {
    facilityRow.style.display = "flex";
    $("summaryFacility").textContent = data.facilityName;
  } else {
    facilityRow.style.display = "none";
  }

  // 全明細と合計枚数
  const list = $("summaryLines");
  list.replaceChildren(...data.lines.map(l => {
    const li = document.createElement("li");
    li.className = "summary-line";
    const title = document.createElement("div");
    title.className = "summary-line-title";
    title.textContent = `${l.lineNo}. ${l.label}`; // メーカー / 具体的な型番
    const detail = document.createElement("div");
    detail.className = "summary-line-detail";
    detail.textContent = `${l.power} ・ ${l.quantity} 枚 ・ 手術日 ${formatDate(l.surgeryDate)}`;
    li.append(title, detail);
    return li;
  }));
  $("summaryTotal").textContent = `${data.lines.length}明細・合計 ${data.totalQuantity} 枚`;

  $("summaryOrderer").textContent = data.orderer;
  $("summaryEmail").textContent = data.email || "（未登録）";
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
  if (appConfig.orderMode === ORDER_MODES.SERVER_DEV) {
    // 開発用のサーバー受付: 再送しても、同じ注文の識別子(clientRequestId)で二重登録にはならない
    return `${describeCallableError(err)} 同じ内容で再送信しても二重には登録されません。${RETAIN_NOTE}`;
  }
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

let submitting = false; // 連続クリックによる重複送信の防止

async function handleExecuteOrder() {
  if (!currentPendingOrderData || submitting) return;
  submitting = true;

  el.btnModalSubmit.disabled = true;
  el.btnModalBack.disabled = true;
  el.btnModalSubmit.textContent = "送信しています…";
  el.modalSubmitError.classList.add("hidden");

  try {
    let result;
    if (appConfig.orderMode === ORDER_MODES.SERVER_DEV) {
      // 開発用テスト経路: サーバーで検証して保存する(ディーラーへは通知されない)
      if (!orderApi) throw new Error("サーバーに接続できません");
      const r = await orderApi.createOrder(buildCreateOrderRequest(currentPendingOrderData));
      result = { orderId: r.orderNumber, message: "開発用受付・ディーラー未通知", serverDev: true };
    } else {
      if (appConfig.orderMode === ORDER_MODES.GAS && currentPendingOrderData.lines.length > 1) {
        // 廃止予定の旧経路(GAS直接送信)は、複数明細に対応しない(誤った内容で送らない)
        throw new OrderError("failed", "この送信方法は複数のレンズをまとめて注文できません。レンズを1つずつ注文してください");
      }
      if (appConfig.orderMode !== ORDER_MODES.GAS) {
        console.log("【dryrun】送信予定のペイロード（送信はしていません）:", currentPendingOrderData);
      }
      result = await submitOrder(currentPendingOrderData, appConfig);
    }

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
    submitting = false;
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
  if (result.serverDev) {
    // 受付(accepted)まで。ディーラーへは通知していないので「発注済み」とは表示しない
    $("completeTitle").textContent = "注文を受け付けました（開発用）";
    $("completeSubtitle").innerHTML = "<strong>開発用受付・ディーラー未通知</strong><br>サーバーに保存しました。ディーラーへの発注・メール送信は行われていません。";
  }
  el.completeDetails.innerHTML = `
    <div style="margin-bottom: 8px;"><strong>受付番号:</strong> ${escapeHtml(result.orderId)}</div>
    ${orderData.lines.map(l => `<div style="margin-bottom: 4px;">${escapeHtml(l.lineNo)}. ${escapeHtml(l.label)} / ${escapeHtml(l.power)} / ${escapeHtml(l.quantity)}枚 / 手術日 ${escapeHtml(l.surgeryDate)}</div>`).join("")}
    <div style="margin-bottom: 4px;"><strong>合計:</strong> ${escapeHtml(orderData.lines.length)}明細・${escapeHtml(orderData.totalQuantity)}枚</div>
    <div style="margin-bottom: 4px;"><strong>注文者:</strong> ${escapeHtml(orderData.orderer)}</div>
    ${orderData.email ? `<div><strong>メールアドレス:</strong> ${escapeHtml(orderData.email)}</div>` : ""}
  `;

  el.completeModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function handleResetForNewOrder() {
  el.completeModal.classList.add("hidden");
  document.body.style.overflow = "";
  currentPendingOrderData = null;

  el.form.reset();
  lensLines.reset(); // 1明細・両チェックOFFに戻る
  updateAlconGuide();
  window.scrollTo({ top: 0, behavior: "smooth" });
  showToast("フォームをリセットしました");
}

/**
 * 入力途中の内容があるか（施設切替時の破棄確認用）
 * 既定値だけの状態は「入力あり」とみなさない。
 */
export function isOrderFormDirty() {
  if (!el.form) return false;
  return Boolean(
    lensLines.isDirty() || el.ordererSelect.value ||
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

  const prevOrderer = el.ordererSelect.value;

  availableModels = resolveAdoptedModels(adoptedIols);
  while (el.ordererSelect.children.length > 1) el.ordererSelect.removeChild(el.ordererSelect.lastChild);
  lensOptions = buildLensOptions(availableModels);
  lensLines.refresh(); // 採用解除などで選択肢から外れた明細は、選択とパワーをリセットする
  updateAlconGuide();
  initOrdererSelect(orderers.filter(o => o.active));

  el.ordererSelect.value = [...el.ordererSelect.options].some(o => o.value === prevOrderer) ? prevOrderer : "";
}
