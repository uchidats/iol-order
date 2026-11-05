import { h } from "./markdown-view.js";
import { createSectionHeading, createInfoTip } from "./info-tip.js";
import { confirmDialog } from "./confirm-dialog.js";
import { linkIcon } from "./related-links.js";
import { describeCallableError } from "../data/registration-api.js";
import { STICKER_ENTRY_URL, SHEET_NOTE_MAX_LENGTH, normalizeSheetNote } from "../domain/sticker-photo.js";
import { accessCodeError, accessCodeStatus, qrImageUrl, shareableDealers, verifyLockNotice } from "../domain/sticker-settings.js";

const HELP = "看護師が台紙を撮影して送るための設定です。アクセスコードは台紙やQRコードには載らず、設定後に再表示もできません。看護師へは別途お伝えください。忘れた場合は新しいコードに変更してください。ディーラーへの共有は、チェックを入れた後に送られた写真が対象です。";
const VIEW_HELP = "看護師が台紙を撮影して送るためのQRコードと台紙を、表示・印刷できます。アクセスコードは台紙やQRコードには載りません。アクセスコードの設定・変更、QRコードの作り直し、ディーラーへの共有は、施設の管理者・副管理者が行います。";
const ROTATE_HELP = "QRコードを紛失したときなどに作り直せます。これまでのQRコードは使えなくなります。";
const CODE_NOTE = "設定したコードは後から確認できません。控えてから保存してください。";
const QR_NOT_ISSUED_NOTE = "QRコードはまだ発行されていません。施設の管理者・副管理者に発行を依頼してください。";
const NOT_LINKED_HELP = "ディーラーの会社との関連付けは運営者が登録します。受注一覧の閲覧の許可とは別の設定です。";
const STALE_NOTE = "許可の後に発注先の情報が変わったため、公開を止めています。チェックを外して、入れ直してください。";

/** 機能の停止中・この施設が対象外のときは項目ごと出さない(施設の所属者の画面でのみ使うので、権限のエラーは対象外を表す) */
const isUnavailable = (e) => {
  const code = String((e && e.code) || "");
  return code.endsWith("permission-denied") || code.endsWith("not-found") || (code.endsWith("failed-precondition") && /現在ご利用いただけません/.test(String(e.message)));
};

/** 表示・非表示(ボタンは見た目の指定が hidden より強いので、display も切り替える) */
const setShown = (el, on) => { el.hidden = !on; el.style.display = on ? "" : "none"; };

/** 撮影ページを開くリンク(アイコンだけ)。URL は QR と同じ値で、文字列は出さない。別タブへ参照元を渡さない */
function entryLink(url) {
  if (typeof url !== "string" || !url.startsWith(`${STICKER_ENTRY_URL}#f=`)) return null;
  return h("a", { class: "sticker-qr-open", href: url, target: "_blank", rel: "noopener noreferrer", title: "撮影ページを開く", "aria-label": "撮影ページを開く", "data-act": "openEntry" }, linkIcon());
}

/** QR のモーダル(「サイトを共有」と同じ見た目。閉じる: 「閉じる」・Escape・背景のクリック)。URL の文字列は出さない */
function openQrDialog({ svg, url, printActions = [] }) {
  const closeBtn = h("button", { type: "button", class: "btn btn-secondary", "data-act": "close" }, "閉じる");
  const img = h("img", { class: "share-qr", alt: "IOLシール写真のQRコード", src: qrImageUrl(svg) });
  const overlay = h("div", { class: "modal-overlay share-dialog sticker-qr-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "stickerQrTitle" },
    h("div", { class: "modal-card" },
      h("div", { class: "modal-header modal-header-simple" }, h("h2", { class: "modal-title", id: "stickerQrTitle" }, "IOLシール写真のQRコード")),
      h("div", { class: "modal-body" }, h("div", { class: "share-qr-box" }, img), h("p", { class: "share-url" }, entryLink(url)),
        h("div", { class: "settings-actions" }, printActions.map(a => { const b = h("button", { type: "button", class: "btn btn-secondary btn-aux", "data-act": a.act }, a.label); b.addEventListener("click", () => { close(); a.run(); }); return b; }))),
      h("div", { class: "modal-footer" }, closeBtn)));
  const before = document.activeElement, overflow = document.body.style.overflow;
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    document.body.style.overflow = overflow;
    if (before && typeof before.focus === "function") before.focus();
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  document.body.style.overflow = "hidden";
  closeBtn.focus();
}

/**
 * 施設設定の「IOLシール写真」。所属者全員に出し、コードの状態・QR コードの表示ができる。台紙と QR コードの印刷は、QR のモーダルから開く。
 * アクセスコードの設定と変更・QR コードの作り直し・ディーラーへの写真の共有は、管理者・副管理者だけに出す(canManage。サーバーも同じ規則で拒否する)。
 * 写真の共有は stickerPhotoGrants で、受注閲覧の許可(「ディーラー画面での閲覧」)とは別の設定。
 * 文字はすべて textContent。入力したコードは保存の後に画面へ出さず、端末にも保存しない。
 * @param {{api: ReturnType<import("../data/sticker-settings-api.js").createStickerSettingsApi>, confirm?: Function, getDealers?: () => Array<object>, canManage?: boolean}} deps getDealers: 施設の発注先(台紙の上部の表示の初期値。読むだけ)。canManage: 変更の操作を出すか(既定は出す)
 */
export function createStickerSettingsSection({ api, confirm = confirmDialog, getDealers = () => [], canManage = true }) {
  const msg = h("p", { class: "form-hint", "data-msg": "", role: "status" });
  let facilityId = null, facilityName = "", settings = null, busy = false, gen = 0;
  /** 変更の操作を出すか。画面の役割と、サーバーの答えの両方が許すときだけ */
  const manage = () => canManage && (!settings || settings.canManage !== false);

  /* ---------- アクセスコード ---------- */
  const codeStatus = h("span", { "data-f": "codeStatus" });   // 状態のバッジ(「ディーラー画面での閲覧」の「許可中」「未許可」と同じ見た目)
  setShown(codeStatus, false);
  const lockNote = h("p", { class: "error-message", "data-f": "verifyLock", role: "status", hidden: true });   // コードの確認の停止中だけ出す
  const codeBtn = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "editCode" });   // 「ディーラー画面での閲覧」の「許可する」と同じ見た目
  const codeInput = h("input", { type: "text", class: "form-control", "data-f": "code", inputmode: "numeric", autocomplete: "off", maxlength: "12", "aria-label": "新しいアクセスコード" });
  const codeError = h("p", { class: "error-message", "data-err": "code" });
  const saveCode = h("button", { type: "button", class: "btn btn-primary btn-aux", "data-act": "saveCode" });
  const cancelCode = h("button", { type: "button", class: "btn btn-secondary btn-aux", "data-act": "cancelCode" }, "キャンセル");
  const codeForm = h("div", { "data-f": "codeForm", hidden: true }, codeInput, codeError, h("p", { class: "form-hint", "data-f": "codeNote" }, CODE_NOTE), h("div", { class: "settings-actions" }, saveCode, cancelCode));
  const closeForm = () => { codeInput.value = ""; codeError.textContent = ""; codeForm.hidden = true; };

  codeBtn.addEventListener("click", () => {
    if (!manage()) return;
    msg.textContent = "";
    saveCode.textContent = settings && settings.accessCodeSet ? "変更する" : "設定する";
    codeForm.hidden = false;
    codeInput.focus();
  });
  cancelCode.addEventListener("click", closeForm);
  saveCode.addEventListener("click", async () => {
    if (busy || !manage()) return;
    const code = codeInput.value.trim();
    const problem = accessCodeError(code);
    codeError.textContent = problem;
    if (problem) return;
    const changing = settings && settings.accessCodeSet;
    if (changing && !(await confirm({ message: "アクセスコードを変更しますか？\n今のコードは使えなくなり、撮影中の方は新しいコードの入力が必要になります。", okLabel: "変更する", cancelLabel: "キャンセル" }))) return;
    busy = true; msg.textContent = ""; saveCode.disabled = true;
    try {
      await api.setAccessCode(facilityId, code);
      closeForm();
      msg.textContent = changing ? "アクセスコードを変更しました。" : "アクセスコードを設定しました。";
      await load().catch(() => {});   // 保存は成功している。表示の読み直しの失敗では通知を変えない
    } catch (e) {
      codeError.textContent = describeCallableError(e);
    } finally { busy = false; saveCode.disabled = false; }
  });

  /* ---------- QR コード ---------- */
  const showQr = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "showQr", "aria-label": "QRコードを表示" }, "表示");   // 「変更」と同じ見た目
  const rotateQr = h("button", { type: "button", class: "btn btn-secondary btn-aux", "data-act": "rotateQr" }, "QRコードを作り直す");
  /** 印刷の画面を開く。QR は毎回サーバーから有効な入口を受け取る(作り直した後に古い QR を印刷しない) */
  const openPrint = async (kind) => {
    if (busy) return;
    busy = true; msg.textContent = "";
    try {
      const [{ svg }, print] = await Promise.all([api.getEntryQr(facilityId), import("./sticker-print-view.js")]);
      if (kind === "sheet") print.openSheetPrint({ facilityName, dealers: getDealers(), qrSvg: svg, sheetNote: (settings && settings.sheetNote) || "" });
      else print.openQrPrint({ facilityName, qrSvg: svg });
    } catch (e) {
      msg.textContent = describeCallableError(e);
    } finally { busy = false; }
  };
  const printActions = [{ act: "printSheet", label: "台紙を印刷", run: () => openPrint("sheet") }, { act: "printQr", label: "QRコードのみ印刷", run: () => openPrint("qr") }];
  // 印刷はモーダルから開く。設定の読み直しの間もモーダルの印刷を押せるよう、QR を受け取った時点で busy を解く
  const qrAction = async (fn) => {
    if (busy) return;
    busy = true; msg.textContent = "";
    let svg, url;
    try {
      ({ svg, url } = await fn(facilityId));
    } catch (e) {
      msg.textContent = describeCallableError(e);
      return;
    } finally { busy = false; }
    openQrDialog({ svg, url, printActions });
    try {
      await load();
    } catch (e) {
      msg.textContent = describeCallableError(e);
    }
  };
  showQr.addEventListener("click", () => qrAction(api.getEntryQr));
  // 「QRコードを作り直す」は通常は出さず、見出しのⓘの中に置く(管理者・副管理者だけ)。
  // ボタンを押す間に ⓘ のフォーカスが外れて閉じないようにする(Safari はボタンを押すとフォーカスを外す)
  const rotateTip = createInfoTip(ROTATE_HELP, { label: "QRコードの作り直し" });
  rotateTip.root.dataset.f = "rotateTip";
  rotateTip.popup.removeAttribute("role");   // 操作を含むので tooltip にしない
  rotateTip.popup.style.marginTop = "0";     // 行の高さが増えた分、マウスを ⓘ からボタンへ動かす途中で閉じないように詰める
  rotateTip.popup.append(h("div", { class: "settings-actions" }, rotateQr));
  rotateTip.popup.addEventListener("mousedown", (e) => e.preventDefault());
  rotateQr.addEventListener("click", async () => {
    rotateTip.close();
    if (!manage()) return;
    if (!(await confirm({ message: "QRコードを作り直しますか？\nこれまでに印刷・貼付したQRコードは使えなくなります。新しいQRコードを印刷して貼り替えてください。", okLabel: "作り直す", cancelLabel: "キャンセル" }))) return;
    qrAction(api.rotateEntryQr);
  });

  /* ---------- 台紙の注意事項(施設ごと。管理者・副管理者だけが編集する。台紙の上部に印刷する) ---------- */
  const noteBtn = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "editNote" }, "変更");
  const noteHead = h("div", { class: "settings-actions sticker-code-row sticker-qr-row", "data-f": "noteHead" }, h("h4", {}, "台紙の注意事項"), noteBtn);
  const noteView = h("p", { class: "sticker-note-view", "data-f": "noteView" });
  const noteInput = h("textarea", { class: "form-control", "data-f": "note", rows: "3", maxlength: String(SHEET_NOTE_MAX_LENGTH), "aria-label": "台紙の注意事項" });
  const noteError = h("p", { class: "error-message", "data-err": "note" });
  const saveNote = h("button", { type: "button", class: "btn btn-primary btn-aux", "data-act": "saveNote" }, "保存する");
  const cancelNote = h("button", { type: "button", class: "btn btn-secondary btn-aux", "data-act": "cancelNote" }, "キャンセル");
  const noteForm = h("div", { "data-f": "noteForm", hidden: true }, noteInput, noteError,
    h("p", { class: "form-hint" }, `${SHEET_NOTE_MAX_LENGTH}文字以内。改行できます。空欄で保存すると、台紙に注意事項を印刷しません。`),
    h("div", { class: "settings-actions" }, saveNote, cancelNote));
  const closeNote = () => { noteInput.value = ""; noteError.textContent = ""; noteForm.hidden = true; setShown(noteView, manage()); };
  noteBtn.addEventListener("click", () => {
    if (!manage()) return;
    msg.textContent = "";
    noteInput.value = (settings && settings.sheetNote) || "";
    noteForm.hidden = false;
    setShown(noteView, false);
    noteInput.focus();
  });
  cancelNote.addEventListener("click", closeNote);
  saveNote.addEventListener("click", async () => {
    if (busy || !manage()) return;
    const note = normalizeSheetNote(noteInput.value);
    if (note.length > SHEET_NOTE_MAX_LENGTH) { noteError.textContent = `${SHEET_NOTE_MAX_LENGTH}文字以内で入力してください`; return; }
    busy = true; msg.textContent = ""; noteError.textContent = ""; saveNote.disabled = true;
    try {
      await api.setSheetNote(facilityId, note);
      settings = { ...settings, sheetNote: note };
      noteView.textContent = note || "なし";
      closeNote();
      msg.textContent = "台紙の注意事項を保存しました。";
      await load().catch(() => {});   // 保存は成功している。表示の読み直しの失敗では通知を変えない
    } catch (e) {
      noteError.textContent = describeCallableError(e);
    } finally { busy = false; saveNote.disabled = false; }
  });

  /* ---------- ディーラーへの共有 ---------- */
  const dealerList = h("div", { "data-f": "dealers" });

  function dealerRow(d) {
    const cb = h("input", { type: "checkbox", "data-dealer": d.localDealerId });
    cb.checked = d.shared === true;
    cb.addEventListener("change", async () => {
      const shared = cb.checked;
      cb.disabled = true; msg.textContent = "";
      try {
        await api.setDealerShare(facilityId, d.localDealerId, shared);
        await load();
      } catch (e) {
        cb.checked = !shared;   // 保存できなかったら元に戻す
        cb.disabled = false;
        msg.textContent = describeCallableError(e);
      }
    });
    const company = d.companyName && d.companyName !== d.dealerName ? d.companyName : "";
    return h("div", { class: "dealer-portal-item", "data-share": d.localDealerId },
      h("label", { class: "settings-check dealer-portal-main" }, cb,
        h("span", {}, d.dealerName), company ? h("span", { class: "dealer-portal-meta" }, `(${company})`) : null),
      d.stale ? h("span", { class: "member-role-badge dealer-portal-state is-stale", "data-state": "stale" }, "停止中") : null,
      d.stale ? createInfoTip(STALE_NOTE, { label: `「${d.dealerName}」の共有の状態` }).root : null);
  }

  function renderSettings() {
    codeStatus.textContent = accessCodeStatus(settings);
    codeStatus.className = `member-role-badge dealer-portal-state${settings.accessCodeSet ? " is-active" : ""}`;
    setShown(codeStatus, true);
    const editable = manage();
    // QR の初回の発行は管理者・副管理者だけ。未発行なら、注文者・代理入力者には表示・印刷を出さず、依頼の案内を出す
    const canUseQr = editable || settings.entryIssued !== false;
    setShown(showQr, canUseQr);
    setShown(qrNote, !canUseQr);
    lockNote.textContent = verifyLockNotice(settings, { canManage: editable });
    lockNote.hidden = !lockNote.textContent;
    codeBtn.textContent = settings.accessCodeSet ? "変更" : "設定";
    // 変更の操作は、管理者・副管理者だけに出す
    for (const el of manageOnly) setShown(el, editable);
    noteView.textContent = settings.sheetNote || "なし";
    if (!noteForm.hidden) setShown(noteView, false);
    if (!editable) { closeForm(); noteForm.hidden = true; dealerList.replaceChildren(); return; }
    const dealers = shareableDealers(settings.dealers);
    dealerList.replaceChildren(...(dealers.length ? dealers.map(dealerRow)
      : [h("p", { class: "form-hint" }, "共有できるディーラーはありません", createInfoTip(NOT_LINKED_HELP, { label: "共有できるディーラーの説明" }).root)]));
  }

  const shareHead = h("h4", { "data-f": "shareHead" }, "ディーラーへの共有");
  const qrNote = h("p", { class: "form-hint", "data-f": "qrNotIssued" }, QR_NOT_ISSUED_NOTE);
  setShown(qrNote, false);
  const manageOnly = [codeBtn, rotateTip.root, noteHead, noteView, shareHead, dealerList];
  if (!canManage) for (const el of manageOnly) setShown(el, false);
  const section = h("section", { class: "settings-section", "data-section": "stickerPhotos", hidden: true },
    createSectionHeading("眼内レンズ使用報告", canManage ? HELP : VIEW_HELP),
    h("div", { class: "settings-actions sticker-code-row" }, h("div", { class: "dealer-portal-name" }, h("h4", {}, "アクセスコード"), codeStatus), codeBtn), lockNote, codeForm,
    h("div", { class: "settings-actions sticker-code-row sticker-qr-row" }, h("h4", {}, "QRコード", rotateTip.root), showQr), qrNote,
    noteHead, noteView, noteForm,
    shareHead, dealerList,
    msg);

  async function load() {
    const myGen = ++gen;
    const r = await api.getSettings(facilityId);
    if (myGen !== gen) return;
    settings = r;
    section.hidden = false;
    renderSettings();
  }

  /** 施設を開いたときに読み込む(失敗しても施設設定の他の項目は使える) */
  section._render = async (fid, name) => {
    facilityId = fid; facilityName = name || ""; settings = null;
    setShown(codeStatus, false);
    msg.textContent = "";
    closeForm(); noteInput.value = ""; noteError.textContent = ""; noteForm.hidden = true;
    try {
      await load();
    } catch (e) {
      if (isUnavailable(e)) { section.hidden = true; return; }
      section.hidden = false;
      dealerList.replaceChildren();
      msg.textContent = describeCallableError(e);
    }
  };
  /** 画面を閉じるときに、表示中の新しいコードと入力を消す */
  section._clear = () => { gen += 1; msg.textContent = ""; closeForm(); closeNote(); };
  return section;
}
