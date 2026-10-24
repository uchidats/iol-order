/**
 * 「元に戻す」付きの通知(スナックバー)。画面の下に数秒表示し、押すと onUndo を呼ぶ。新しい通知が出たら古いものは消える。
 * 確認ダイアログの代わりに使う(削除してもすぐ元に戻せる)。
 */
let current = null;

export function hideUndoToast() {
  if (!current) return;
  clearTimeout(current.timer);
  current.node.remove();
  current = null;
}

/**
 * @param {string} message
 * @param {() => void} onUndo
 * @param {{duration?: number}} [opts]
 */
export function showUndoToast(message, onUndo, { duration = 8000 } = {}) {
  hideUndoToast();
  const node = document.createElement("div");
  node.className = "undo-toast";
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  const text = document.createElement("span");
  text.className = "undo-toast-text";
  text.textContent = message;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "undo-toast-btn";
  btn.textContent = "元に戻す";
  btn.addEventListener("click", () => { hideUndoToast(); onUndo(); });
  node.append(text, btn);
  document.body.appendChild(node);
  current = { node, timer: setTimeout(hideUndoToast, duration) };
}
