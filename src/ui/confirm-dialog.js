/**
 * 確認ダイアログ(ブラウザ標準の confirm の代わり)。既存のモーダル(.modal-overlay / .modal-card / .modal-footer)と同じ見た目・操作感。
 * 端末のダークモードに関係なく、白い背景・黒系の文字で表示する(styles.css の .confirm-dialog)。
 * キャンセル・Escape キー・背景のクリックは false、確定ボタンは true。最初のフォーカスは安全な「キャンセル」。
 * @param {{message:string, okLabel?:string, cancelLabel?:string}} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ message, okLabel = "OK", cancelLabel = "キャンセル" }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay confirm-dialog";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-body"><p class="confirm-dialog-message" id="confirmDialogMessage"></p></div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-act="cancel"></button>
          <button type="button" class="btn btn-primary" data-act="ok"></button>
        </div>
      </div>`;
    overlay.setAttribute("aria-describedby", "confirmDialogMessage");
    overlay.querySelector(".confirm-dialog-message").textContent = message;
    const cancel = overlay.querySelector('[data-act="cancel"]'), ok = overlay.querySelector('[data-act="ok"]');
    cancel.textContent = cancelLabel;
    ok.textContent = okLabel;

    const before = document.activeElement;
    const overflow = document.body.style.overflow;
    const close = (result) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      document.body.style.overflow = overflow;
      if (before && typeof before.focus === "function") before.focus();
      resolve(result);
    };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(false); } };
    cancel.addEventListener("click", () => close(false));
    ok.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";
    cancel.focus();
  });
}
