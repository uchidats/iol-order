import { resolveAdoptedModels } from "../data/static-repository.js";
import { buildLensOptions } from "../domain/lens-options.js";
import { applyIolOrder } from "../domain/iol-order.js";
import { renderConfirmLines, renderDealersCard } from "./confirm-lines.js";
import { findSelfDoctor } from "../domain/self-doctor.js";
import { draftKey } from "../domain/order-draft.js";
import { createDraftStore } from "./draft-store.js";
import { findPastOrderDuplicates } from "../domain/order-duplicates.js";
import { renderDuplicateWarning } from "./duplicate-warning.js";
import { showUndoToast, hideUndoToast } from "./undo-toast.js";
import { toOrderLines, totalQuantity } from "../domain/order-lines.js";
import { createLensLines } from "./lens-lines.js";
import { ORDER_MODES, sendsOrders } from "../config.js";
import { buildCreateOrderRequest } from "../domain/order-request.js";
import { describeCallableError } from "../data/registration-api.js";
import { pendingOrderKey, createPendingOrderStore, deriveOrderId, reconcilePendingOrder, isDefinitiveRejection } from "../domain/pending-order.js";
import { summarizeOrder } from "../domain/order-history.js";
import { surgeryDateRange } from "../domain/surgery-date.js";
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
let pendingStore = null;    // 送信したが受付結果が未確定の注文(server-dev かつログイン時のみ。pending-order.js)

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
    btnNewOrder: $("btnNewOrder"),
    duplicateModal: $("duplicateModal"), duplicateTitle: $("duplicateTitle"), duplicateList: $("duplicateList"),
    btnDupBack: $("btnDupBack"), btnDupContinue: $("btnDupContinue"), btnConfirm: $("btnConfirm")
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
    minDate: () => surgeryDateRange().min,   // 日本時間の本日(サーバーと同じ基準)
    maxDate: () => surgeryDateRange().max,
    onChange: () => { updateAlconGuide(); if (draft) draft.save(); },   // モデル・絞り込み・レンズの追加/削除/元に戻すは、すぐ下書きに反映する
    // 削除は確認ダイアログなし。「元に戻す」付きの通知を出す(元に戻した結果も下書きに反映される)
    onLineRemoved: ({ lineNo, undo }) => showUndoToast(`レンズ${lineNo}を削除しました`, undo)
  });
  setupEventListeners();
  setupDraft();
  pendingStore = sendsOrders(appConfig.orderMode) && loginUser && loginUser.uid && facilityRepositoryId
    ? createPendingOrderStore(window.localStorage, pendingOrderKey(loginUser.uid, facilityRepositoryId)) : null;
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

/** いずれかの明細が ALCON のトーリックなら、計算ツールの案内を表示する */
function updateAlconGuide() {
  if (!lensLines) return; // 明細の入力欄を作っている最中
  const url = lensLines.alconCalculator();
  // 表示は、各レンズ(明細)のチェックボックスの右にある小さなリンク(lens-lines.js)。ここでは、将来のカリキュレーター連携用に、対象のURLを保持する
  alconCalculatorUrl = url;
}

/** ヘッダー右側の状態表示。HTML の既定は非表示(本番で再読み込み時に一瞬出ないように)。開発用のモードだけ表示する。表示だけで、送信の可否は config.orderMode で決まる */
function renderModeBadge() {
  const badge = document.getElementById("systemBadge");
  if (!badge) return;
  if (appConfig.orderMode === ORDER_MODES.SERVER) { badge.hidden = true; return; }   // 本番は表示しない
  badge.textContent = appConfig.orderMode === ORDER_MODES.SERVER_DEV ? "開発用受付" : "開発モード";
  badge.hidden = false;
}

function setupEventListeners() {

  el.form.addEventListener("submit", handleFormSubmit);

  el.btnModalBack.addEventListener("click", hideConfirmModal);
  el.btnModalSubmit.addEventListener("click", handleExecuteOrder);
  el.btnNewOrder.addEventListener("click", handleResetForNewOrder);
  el.btnDupBack.addEventListener("click", hideDuplicateModal);                       // 修正する。次に「確認画面へ進む」を押したときに、重複を再判定する
  el.btnDupContinue.addEventListener("click", () => { hideDuplicateModal(); showConfirmModal(currentPendingOrderData); });   // 確認後は発注を許可(この後も、通常の確認画面と最終確認は省略しない)

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
let checkingDuplicates = false;

function hideDuplicateModal() {
  el.duplicateModal.classList.add("hidden");
  document.body.style.overflow = "";
}

/**
 * 確認画面へ進む前に、施設全体の発注済みの注文(最新)と照合する。照会できなかった場合は、注文を止めずに通常どおり進む(通知だけ出す)。
 * @returns {Promise<Array|null>} 重複したレンズ(なければ空配列)。照会できなければ null
 */
async function findDuplicatesFor(lines) {
  if (!facilityRepository || !facilityRepository.listOrders || !facilityRepositoryId) return [];   // 開発用の静的モードなど、注文履歴がない場合
  try {
    const orders = await facilityRepository.listOrders(facilityRepositoryId, 300);   // 最新の注文履歴を、確認画面へ進むたびに照会する
    return findPastOrderDuplicates(lines, orders);
  } catch (e) {
    console.warn("過去の注文との照合ができませんでした:", e);
    return null;
  }
}

async function handleFormSubmit(e) {
  e.preventDefault();
  if (checkingDuplicates) return;

  if (!validateOrderForm()) return;

  const lines = toOrderLines(lensLines.values());
  currentPendingOrderData = {
    // 明細(複数)。各明細は、系列名(model)・系列ID(modelId)・メーカー・トーリック正式型番(toricModel)・度数・枚数・手術日を持つ
    lines,
    totalQuantity: totalQuantity(lines),
    notes: el.notesInput.value.trim(),
    submittedAt: new Date().toISOString(),
    // 再送時の重複受付をサーバー側で検出するための識別子（注文番号ではない）。
    // 受付結果が未確定の注文と同じ内容なら、その値を再利用する(下の checkPendingOrder)。
    clientRequestId: crypto.randomUUID()
  };
  if (currentFacility) {
    currentPendingOrderData.facilityId = currentFacility.id;
    currentPendingOrderData.facilityName = currentFacility.name;
  }

  checkingDuplicates = true;
  el.btnConfirm.disabled = true;
  let proceed;
  try { proceed = await checkPendingOrder(currentPendingOrderData); } finally { checkingDuplicates = false; el.btnConfirm.disabled = false; }
  if (!proceed) return;

  // 過去の注文との重複確認: 一致するレンズがあれば警告(確認は1回。確認後は通常の確認画面へ)。なければ従来どおり確認画面へ
  checkingDuplicates = true;
  el.btnConfirm.disabled = true;
  let duplicates;
  try { duplicates = await findDuplicatesFor(lines); } finally { checkingDuplicates = false; el.btnConfirm.disabled = false; }
  if (duplicates === null) showToast("過去の注文との照合ができませんでした。内容をご確認ください");
  if (duplicates && duplicates.length) {
    renderDuplicateWarning({ title: el.duplicateTitle, list: el.duplicateList }, duplicates);
    el.duplicateModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    return;
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

/**
 * 前回送信して受付結果が未確定の注文があれば、確認画面へ進む前に受付状況を照会する(二重発注の防止。pending-order.js)。
 * @returns {Promise<boolean>} 確認画面へ進んでよいか
 */
async function checkPendingOrder(data) {
  if (!pendingStore || !facilityRepository.getOrder) return true;
  const fid = facilityRepositoryId, uid = loginUser.uid;
  const r = await reconcilePendingOrder(pendingStore.load(), buildCreateOrderRequest(data),
    async (requestId) => facilityRepository.getOrder(fid, await deriveOrderId(uid, requestId)));
  if (r.action === "reuse") { data.clientRequestId = r.requestId; return true; }   // 同じ内容: 同じ requestId で再送する(二重登録にならない)
  if (r.action === "unknown") {
    showToast("前回送信した注文の受付結果を確認できませんでした。通信状況を確認して、もう一度お試しください");
    return false;
  }
  pendingStore.clear();
  if (r.action === "accepted" && r.same) {
    // 前回の送信が受け付けられていた。同じ内容を新しい注文として送らず、保存済みの注文を完了画面に出す
    if (draft) { draft.clear(); draft.setReady(false); }
    showCompleteModal(r.order, { orderNumber: r.order.orderNumber, replayed: true });
    return false;
  }
  if (r.action === "accepted") showToast(`前回送信した注文（受付番号 ${r.order.orderNumber || "—"}）は受け付けられています`);
  return true;
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

/** @param {boolean} retryable 同じ内容の再送が同じ注文として扱われるか(未確定の注文をこの端末に保存できた) */
function describeOrderError(err, retryable) {
  if (isDefinitiveRejection(err)) return `${describeCallableError(err)} 注文は受け付けられていません。${RETAIN_NOTE}`;
  const head = `${describeCallableError(err)} 受付結果を確認できませんでした。注文が受け付けられている可能性があります。`;
  return retryable
    ? `${head}この端末から同じ内容のまま再送信した場合は、同じ注文として扱われます（二重には登録されません）。別の端末から注文し直す前に、注文履歴を確認してください。${RETAIN_NOTE}`
    : `${head}再送信する前に、注文履歴で受付状況を確認してください。${RETAIN_NOTE}`;
}

let submitting = false; // 連続クリックによる重複送信の防止

async function handleExecuteOrder() {
  if (!currentPendingOrderData || submitting) return;
  if (!sendsOrders(appConfig.orderMode)) {
    // dryrun: 送信しない(完了扱いにしない)
    console.log("【dryrun】送信予定のペイロード（送信はしていません）:", buildCreateOrderRequest(currentPendingOrderData));
    el.modalSubmitErrorText.textContent = `【開発モード】実際の発注は行われていません。${RETAIN_NOTE}`;
    el.modalSubmitError.classList.remove("hidden");
    return;
  }
  submitting = true;

  el.btnModalSubmit.disabled = true;
  el.btnModalBack.disabled = true;
  el.btnModalSubmit.textContent = "送信しています…";
  el.modalSubmitError.classList.add("hidden");

  const request = buildCreateOrderRequest(currentPendingOrderData);
  // 送信の直前に、requestId と送信内容を端末に保存する(タイムアウト・画面を閉じる・再読み込みのあとも同じ requestId で再送できる)
  const retryable = pendingStore ? pendingStore.save(request) : false;
  try {
    // サーバーで検証して保存する(テスト注文か・ディーラーへ送るかはサーバーが決める)
    if (!orderApi) throw Object.assign(new Error("サーバーに接続できません"), { code: "failed-precondition" });   // 送信していない
    const r = await orderApi.createOrder(request);
    if (pendingStore) pendingStore.clear();

    // サーバーが受付番号を返した場合のみ完了扱い。表示はサーバーが保存した注文の内容から作る
    let saved = null;
    try { saved = facilityRepository.getOrder ? await facilityRepository.getOrder(facilityRepositoryId, r.orderId) : null; }
    catch (e) { console.warn("保存した注文を読み込めませんでした:", e); }
    el.btnModalSubmit.disabled = false;
    el.btnModalBack.disabled = false;
    hideConfirmModal();
    if (draft) { draft.clear(); draft.setReady(false); }   // 注文が正常に完了したときだけ、下書きを削除する(失敗したときは下の catch に入り、下書きは残る)
    showCompleteModal(saved, { orderNumber: r.orderNumber, replayed: r.replayed === true });
  } catch (err) {
    console.error("注文送信エラー:", err);
    if (pendingStore && isDefinitiveRejection(err)) pendingStore.clear();   // サーバーが拒否した(注文は作られていない)
    el.modalSubmitErrorText.textContent = describeOrderError(err, retryable);
    el.modalSubmitError.classList.remove("hidden");
  } finally {
    submitting = false;
    el.btnModalSubmit.disabled = false;
    el.btnModalBack.disabled = false;
    el.btnModalSubmit.innerHTML = `
      注文を送信
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="22" y1="2" x2="11" y2="13"></line>
        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
      </svg>
    `;
  }
}

/**
 * 完了画面。内容はサーバーが保存した注文(saved)から表示する(画面の入力内容は使わない)。
 * 読み込めなかった場合は受付番号だけを出し、注文履歴での確認を案内する。
 */
function showCompleteModal(saved, { orderNumber, replayed }) {
  // 受付(accepted)まで。メールはこの後に送るので「発注済み」とは表示しない。テスト注文はディーラーへ送らない
  const test = saved ? saved.testOrder === true : appConfig.orderMode !== ORDER_MODES.SERVER;
  if (test) {
    $("completeTitle").textContent = replayed ? "この注文は受け付け済みです（開発用）" : "注文を受け付けました（開発用）";
    $("completeSubtitle").innerHTML = "<strong>開発用受付・ディーラー未通知</strong><br>サーバーに保存しました。ディーラーへの発注・メール送信は行われていません。";
  } else {
    $("completeTitle").textContent = replayed ? "この注文は受け付け済みです" : "注文を受け付けました";
    $("completeSubtitle").innerHTML = "<strong>ディーラーへ注文メールを送信します</strong><br>送信の結果(受付・配信・失敗)は、注文履歴で確認してください。";
  }
  const o = saved ? summarizeOrder(saved) : null;
  el.completeDetails.innerHTML = `
    <div style="margin-bottom: 8px;"><strong>受付番号:</strong> ${escapeHtml((o && o.orderNumber) || orderNumber || "—")}</div>
    ${o ? `
    ${o.lines.map(l => `<div style="margin-bottom: 4px;">${escapeHtml(l.lineNo)}. ${escapeHtml([l.maker, l.model].filter(Boolean).join(" / "))} / ${escapeHtml(l.power)} / ${escapeHtml(l.quantity)}枚 / 手術日 ${escapeHtml(l.surgeryDate)} / 担当医 ${escapeHtml(l.doctorName)} / ${escapeHtml(l.dealerName ? `発注先 ${l.dealerName}` : "発注先未設定")}</div>`).join("")}
    <div style="margin-bottom: 4px;"><strong>合計:</strong> ${escapeHtml(o.lineCount)}件・合計${escapeHtml(o.totalQuantity)}枚</div>
    <div style="margin-bottom: 4px; white-space: pre-wrap;"><strong>備考:</strong> ${escapeHtml(o.notes || "（なし）")}</div>
    <div style="margin-bottom: 4px;"><strong>状態:</strong> ${escapeHtml(o.statusLabel)}</div>` : `
    <div style="margin-bottom: 4px;">保存された注文の内容を読み込めませんでした。注文履歴で内容を確認してください。</div>`}
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
