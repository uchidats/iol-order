/** DOM参照ヘルパー（モジュールはDOM構築後に実行される） */
export const $ = (id) => document.getElementById(id);

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

export function setFieldError(fieldId, message) {
  const errEl = $(`err-${fieldId}`);
  if (errEl) errEl.textContent = message;
  const inputEl = $(fieldId);
  if (inputEl) inputEl.classList.add("is-invalid");
}

export function clearFieldError(fieldId) {
  const errEl = $(`err-${fieldId}`);
  if (errEl) errEl.textContent = "";
  const inputEl = $(fieldId);
  if (inputEl) inputEl.classList.remove("is-invalid");
}

let toastTimer = null;
export function showToast(message) {
  const toastNotice = $("toastNotice");
  if (toastTimer) clearTimeout(toastTimer);
  toastNotice.textContent = message;
  toastNotice.classList.remove("hidden");
  toastTimer = setTimeout(() => toastNotice.classList.add("hidden"), 3500);
}
