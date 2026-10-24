import { buildDraft, isEmptyDraft, parseDraft } from "../domain/order-draft.js";

/**
 * 入力内容の自動保存・復元(localStorage の下書き)。保存先のキーは、ログインユーザー・施設ごと(draftKey)。
 * 保存の内容は src/domain/order-draft.js(選んだ値だけ。患者の個人情報・認証情報は保存しない)。
 * 保存・復元に失敗しても(容量・プライベートモード・壊れた下書き)、注文画面は動く。
 *
 * @param {object} deps
 * @param {string|null} deps.key 保存先(null なら何もしない)
 * @param {HTMLElement} deps.form 入力の変更を検知するフォーム
 * @param {HTMLElement} deps.lensLinesBox レンズのカードを並べる場所(追加・削除の検知)
 * @param {HTMLTextAreaElement} deps.notesInput 備考
 * @param {() => ({snapshot:Function, restore:Function}|null)} deps.getLensLines
 * @param {Storage} [deps.storage]
 * @param {() => void} [deps.onRestored] 復元したとき
 */
export function createDraftStore({ key, form, lensLinesBox, notesInput, getLensLines, storage = null, onRestored = () => {} }) {
  const store = () => { try { return storage || window.localStorage; } catch { return null; } };
  let ready = false;   // 復元の試行が終わるまでは保存しない(空の状態で下書きを上書きしない)
  let timer = null;

  function save() {
    const lens = getLensLines();
    const s = store();
    if (!ready || !key || !lens || !s) return;
    try {
      const draft = buildDraft({ lines: lens.snapshot(), notes: notesInput.value });
      if (isEmptyDraft(draft)) s.removeItem(key);        // 実質的に空なら、保存せず、残っている下書きも消す
      else s.setItem(key, JSON.stringify(draft));
    } catch (e) { console.warn("下書きを保存できませんでした:", e); }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(save, 400); };

  /** 注文が正常に完了したとき(だけ)、下書きを削除する。送信に失敗したときは呼ばない(下書きは残る) */
  function clear() {
    clearTimeout(timer);
    try { const s = store(); if (s && key) s.removeItem(key); } catch { /* 何もしない */ }
  }

  /** 保存された下書きがあれば、入力途中の状態に復元する(選択肢にないモデル・度数・担当医・発注先は未選択になる)。入力チェックは、確認時に通常どおり行う */
  function restore() {
    try {
      const s = store();
      const text = key && s ? s.getItem(key) : null;
      if (text) {
        const draft = parseDraft(text);
        if (!draft) s.removeItem(key);                      // 壊れている・古い下書きは捨てる
        else if (!isEmptyDraft(draft)) {
          getLensLines().restore(draft.lines);
          notesInput.value = draft.notes;
          onRestored();
        }
      }
    } catch (e) { console.warn("下書きを復元できませんでした:", e); }
    ready = true;
  }

  form.addEventListener("input", schedule);
  form.addEventListener("change", schedule);
  new MutationObserver(save).observe(lensLinesBox, { childList: true });
  window.addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(); });

  return {
    save, schedule, clear, restore,
    /** false の間は保存しない(注文の完了後・復元前) */
    setReady(v) { ready = Boolean(v); }
  };
}
