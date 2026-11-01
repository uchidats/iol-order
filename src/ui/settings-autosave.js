import { h } from "./markdown-view.js";

/**
 * 設定画面の項目の自動保存と、項目のメッセージ(施設設定・ディーラー設定で共通)。
 * 表示先の項目(section)には、メッセージ用の要素 [data-msg] を置いておく。
 */

/** 項目のメッセージ(isError のときはエラーの見た目) */
export function setSectionMessage(container, text, isError = false) {
  const p = container.querySelector("[data-msg]");
  p.textContent = text || "";
  p.className = isError ? "error-message" : "form-hint";
}

/**
 * 自動保存。変更のたびに request() を呼ぶと、画面の最新の状態を、1件ずつ順番に保存する。
 *  - 保存中に続けて操作しても、保存は直列(同時に2つ走らない)。保存の時点の画面の状態を保存するので、古い内容で上書きしない。続けて操作した分は1回にまとめる。
 *  - 成功の通知は出さない。失敗したときだけエラーと「再試行」を表示し、画面の変更は消さない(次の操作か再試行で、最新の状態をもう一度保存する)。
 *  - exclusive(): 保存と同時に走らせてはいけない処理(削除)を、保存の合間に実行する。
 * @param {HTMLElement} section 表示先(メッセージ・再試行ボタン)
 * @param {() => Promise<void>} run 保存の実体(既存のサーバー・データベースへの保存処理)
 */
export function createAutoSaver(section, run) {
  let again = false, running = false;
  const waiters = [];
  const api = { failed: false };
  const settle = () => waiters.splice(0).forEach(r => r());
  const showError = () => {
    setSectionMessage(section, "保存できませんでした。変更はまだ保存されていません。通信状態や権限を確認して、再試行してください。", true);
    if (!section.querySelector('[data-act="retry-autosave"]')) {
      const b = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "retry-autosave" }, "再試行");
      b.addEventListener("click", () => api.request());
      section.querySelector("[data-msg]").after(b);
    }
  };
  const clearError = () => {
    const b = section.querySelector('[data-act="retry-autosave"]');
    if (b) b.remove();
    const p = section.querySelector("[data-msg]");
    if (p && p.classList.contains("error-message")) setSectionMessage(section, "");
  };
  async function pump() {
    if (running) return;
    running = true;
    try {
      while (again) {
        again = false;
        try { await run(); if (api.failed) { api.failed = false; clearError(); } }
        catch (e) { console.error("自動保存に失敗しました:", e); api.failed = true; again = false; showError(); break; }
      }
    } finally { running = false; settle(); if (again && !api.failed) pump(); }
  }
  api.request = () => { again = true; pump(); };
  api.idle = () => (running || again ? new Promise(r => waiters.push(r)) : Promise.resolve());
  api.exclusive = async (task) => {
    while (running) await new Promise(r => waiters.push(r));
    running = true;
    try { return await task(); } finally { running = false; settle(); if (again) pump(); }
  };
  return api;
}
