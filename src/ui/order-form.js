import { resolveAdoptedModels } from "../data/static-repository.js";
import { buildLensOptions } from "../domain/lens-options.js";
import { applyIolOrder } from "../domain/iol-order.js";
import { renderConfirmLines, renderDealersCard } from "./confirm-lines.js";
import { findSelfDoctor } from "../domain/self-doctor.js";
import { draftKey } from "../domain/order-draft.js";
import { createDraftStore } from "./draft-store.js";
import { showUndoToast, hideUndoToast } from "./undo-toast.js";
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
let doctors = [];               // 担当医マスター(施設設定の「担当医」)
let alconCalculatorUrl = null;  // ALCONのトーリックを選択中なら、計算ツールのURL(将来の連携用に保持。画面の表示は各レンズのリンク)
let draft = null;               // 下書きの自動保存(createDraftStore)
let loginUser = null;            // ログインユーザー(認証情報のうち uid / email / emailVerified だけ。担当医の初期値の判定用。注文者とは別の情報)
let dealers = [];               // 施設の登録ディーラー(0社=発注先なし / 1社=自動 / 2社以上=明細ごとに選択)
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
export async function initOrderForm(args) {
  cacheElements();
  try {
    await initOrderFormInner(args);
  } catch (e) {
    // 入力欄が空のまま無反応になるのを避ける(例: 古いキャッシュのJSと新しいHTMLの食い違い)
    console.error("注文フォームの初期化に失敗しました:", e);
    if (el.lensLinesBox) {
      const p = document.createElement("p");
      p.className = "error-message";
      p.setAttribute("role", "alert");
      p.textContent = "画面の読み込みに失敗しました。ページを再読み込みしてください（Ctrl + Shift + R）。";
      el.lensLinesBox.replaceChildren(p);
    }
    throw e;
  }
}

async function initOrderFormInner({ config, repository, facilityId, facility = null, orderApi: api = null, user = null }) {
  loginUser = user;
  appConfig = config;
  orderApi = api;
  currentFacility = facility;
  facilityRepository = repository;
  facilityRepositoryId = facilityId;

  const [adoptedIols, doctorList, dealerList, iolOrder] = await Promise.all([
    repository.listAdoptedIols(facilityId),
    repository.listOrderers(facilityId),   // 担当医マスター(コレクション名は互換性のため orderers のまま)
    repository.listDealers(facilityId),
    repository.getIolOrder ? repository.getIolOrder(facilityId) : null   // 施設ごとのIOLの表示順(未設定は標準の順番)
  ]);
  availableModels = applyIolOrder(resolveAdoptedModels(adoptedIols), iolOrder);
  doctors = doctorList;
  dealers = dealerList;

  lensOptions = buildLensOptions(availableModels);
  lensLines = createLensLines({
    container: el.lensLinesBox,
    addButton: el.btnAddLine,
    getOptions: () => lensOptions,
    getDoctors: () => doctors,
    getDealers: () => dealers,
    // 担当医の初期値: ログインユーザー本人が担当医マスター(メールアドレスで紐づけ)にいれば本人。いなければ未選択(従来どおり)
    getDefaultDoctorId: () => findSelfDoctor(doctors, loginUser),
    minDate: todayString,
    onChange: () => { updateAlconGuide(); if (draft) draft.save(); },   // モデル・絞り込み・レンズの追加/削除/元に戻すは、すぐ下書きに反映する
    // 削除は確認ダイアログなし。「元に戻す」付きの通知を出す(元に戻した結果も下書きに反映される)
    onLineRemoved: ({ lineNo, undo }) => showUndoToast(`レンズ${lineNo}を削除しました`, undo)
  });
  setupEventListeners();
  setupDraft();
  renderModeBadge();
}

/** 入力内容の自動保存・復元(localStorage の下書き。ログインユーザー・施設ごと)。注文が正常に完了したときだけ削除する */
function setupDraft() {
  draft = createDraftStore({
    // ログインユーザーが分からない(開発用の静的モード)ときは、下書きを使わない
    key: loginUser && loginUser.uid && facilityRepositoryId ? draftKey(loginUser.uid, facilityRepositoryId) : null,
    form: el.form, lensLinesBox: el.lensLinesBox, notesInput: el.notesInput,
    getLensLines: () => lensLines,
    onRestored: () => { updateAlconGuide(); showToast("入力途中の内容を復元しました"); }
  });
  draft.restore();
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
  // 表示は、各レンズ(明細)のチェックボックスの右にある小さなリンク(lens-lines.js)。ここでは、将来のカリキュレーター連携用に、対象のURLを保持する
  alconCalculatorUrl = url;
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

function setupEventListeners() {

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
  currentPendingOrderData = {
    // 明細(複数)。各明細は、系列名(model)・系列ID(modelId)・メーカー・トーリック正式型番(toricModel)・度数・枚数・手術日を持つ
    lines,
    totalQuantity: totalQuantity(lines),
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
      orderer: l.doctor, email: l.doctorEmail, // 旧経路(GAS直接送信)の形式: 担当医を従来の項目に入れる
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
  // 発注先の取り違え防止のため、発注元(施設名)と発注先(ディーラー)を、最上部の1つのカードに並べて明示する
  const facilityBox = $("summaryFacilityBox");
  facilityBox.hidden = !data.facilityName;
  $("summaryFacility").textContent = data.facilityName || "";
  $("summaryPartiesRow").classList.toggle("is-dealer-only", !data.facilityName);

  // 全明細と合計枚数
  const list = $("summaryLines");
  renderConfirmLines(list, data.lines); // 手術日ごとにまとめて表示(表示のみ。注文データの並び順・送信内容は変えない)
  $("summaryTotal").textContent = `${data.lines.length}件・合計${data.totalQuantity}枚`; // 件数=レンズ明細の数、枚数=各明細の枚数の合計

  $("summaryNotes").textContent = data.notes || "（なし）";
  renderDealersCard($("summaryDealers"), data.lines);

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
    if (draft) { draft.clear(); draft.setReady(false); }   // 注文が正常に完了したときだけ、下書きを削除する(失敗したときは下の catch に入り、下書きは残る)
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
    ${orderData.lines.map(l => `<div style="margin-bottom: 4px;">${escapeHtml(l.lineNo)}. ${escapeHtml(l.label)} / ${escapeHtml(l.power)} / ${escapeHtml(l.quantity)}枚 / 手術日 ${escapeHtml(l.surgeryDate)} / 担当医 ${escapeHtml(l.doctor)}</div>`).join("")}
    <div style="margin-bottom: 4px;"><strong>合計:</strong> ${escapeHtml(orderData.lines.length)}件・合計${escapeHtml(orderData.totalQuantity)}枚</div>
  `;

  el.completeModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function handleResetForNewOrder() {
  el.completeModal.classList.add("hidden");
  document.body.style.overflow = "";
  currentPendingOrderData = null;

  hideUndoToast();
  el.form.reset();
  lensLines.reset(); // 1明細・両チェックOFFに戻る
  if (draft) { draft.setReady(true); draft.save(); }   // 新しい注文(空の状態)。下書きは作らない。完了後は、完了した内容を下書きとして保存し直さない
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
    lensLines.isDirty() ||
    el.notesInput.value.trim() || currentPendingOrderData
  );
}

/**
 * 施設設定の変更（担当医・採用IOL・ディーラー）を注文フォームの選択肢へ反映する。
 * 入力済みの値は、新しい選択肢にも存在する場合のみ維持する。
 */
export async function reloadFacilityOptions() {
  if (!facilityRepository || !el.form) return;
  const [adoptedIols, doctorList, dealerList, iolOrder] = await Promise.all([
    facilityRepository.listAdoptedIols(facilityRepositoryId),
    facilityRepository.listOrderers(facilityRepositoryId),
    facilityRepository.listDealers(facilityRepositoryId),
    facilityRepository.getIolOrder ? facilityRepository.getIolOrder(facilityRepositoryId) : null
  ]);

  availableModels = applyIolOrder(resolveAdoptedModels(adoptedIols), iolOrder);
  doctors = doctorList;
  dealers = dealerList;
  lensOptions = buildLensOptions(availableModels);
  lensLines.refresh(); // 採用解除・担当医の削除などで選択肢から外れた明細は、選択を未選択に戻す
  updateAlconGuide();
}
