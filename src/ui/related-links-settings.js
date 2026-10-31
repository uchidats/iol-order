import { STANDARD_LINKS, relatedLinkRows, validateRelatedLink, planRelatedLinkWrites } from "../domain/related-links.js";
import { createSectionHeading } from "./info-tip.js";

const LEAVE = "この画面を離れると、未保存の入力や保存に失敗した変更が破棄されます";
export function createRelatedLinksSection({ h, createAutoSaver, repository, settingsApi, onSaved }) {
  const standards = h("div"), customs = h("div", { "data-custom-links": "" });
  const add = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "add" }, "追加");
  const section = h("section", { class: "settings-section", "data-section": "relatedLinks" },
    createSectionHeading("関連リンク", "標準リンクは表示の切替のみ。施設独自のリンクは名前とHTTPS URLを登録できます。入力停止後500msで有効な行だけ自動保存します。↑で独自リンク内を並べ替えます。この端末では保存後すぐ反映され、ほかの端末では再読み込み後に反映されます。"),
    h("h4", {}, "標準リンク"), standards, h("h4", {}, "施設独自のリンク"), customs,
    h("div", { class: "settings-actions" }, add), h("p", { "data-msg": "", class: "form-hint" }));
  let id = null, original = [], rows = [], pendingDeletes = new Set(), timer = null, generation = 0, ready = false;
  const controls = new Map();
  const saver = createAutoSaver(section, async () => {
    if (!ready) return;
    const fid = id, gen = generation;
    const plan = planRelatedLinkWrites(original, rows, [...pendingDeletes]);
    if (!plan.upserts.length && !plan.deletes.length) return;
    await settingsApi.saveRelatedLinks(fid, plan);
    if (gen !== generation) return;
    const written = new Map(original.map(r => [r.id, r]));
    for (const w of plan.upserts) written.set(w.id, { id: w.id, ...w.data });
    for (const key of plan.deletes) {
      written.delete(key); pendingDeletes.delete(key);
      rows = rows.filter(r => r.id !== key); controls.get(key)?.remove(); controls.delete(key);
    }
    original = [...written.values()];
    onSaved(fid, original);
    updateMoves();
  });
  const changed = (debounce = false) => {
    clearTimeout(timer); timer = null;
    if (debounce) timer = setTimeout(() => { timer = null; saver.request(); }, 500);
    else saver.request();
  };
  const updateMoves = () => {
    rows.filter(r => !r.standard).forEach((r, i) => {
      const up = controls.get(r.id)?.querySelector('[data-act="up"]');
      if (up) { up.disabled = i === 0 || pendingDeletes.has(r.id); up.style.visibility = i === 0 ? "hidden" : ""; }
    });
  };
  function rowElement(row, editing = false) {
    const checkbox = h("input", { type: "checkbox", checked: row.enabled, "aria-label": `${row.name || "独自リンク"}を表示` });
    const name = h("span", { class: "related-link-name" }, row.name || "（名前未入力）");
    const el = h("div", { class: "related-setting-row", "data-id": row.id }); controls.set(row.id, el);
    checkbox.addEventListener("change", () => { row.enabled = checkbox.checked; changed(); });
    if (row.standard) { el.append(h("label", {}, checkbox, name), h("span", { class: "form-hint related-url" }, row.url)); return el; }
    const input = h("input", { class: "form-control", value: row.name, maxlength: "100", "aria-label": "リンク名" });
    const url = h("input", { class: "form-control", value: row.url, type: "url", maxlength: "2048", "aria-label": "リンクURL" });
    const error = h("p", { class: "error-message", role: "status" });
    const editBox = h("div", { class: "related-link-editor", hidden: !editing }, input, url, error);
    const up = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "up", "aria-label": "リンクを上へ" }, "↑");
    const edit = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "edit" }, "編集");
    const del = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "delete" }, "削除");
    el.append(h("div", { class: "related-link-line" }, checkbox, name, up, edit, del), editBox);
    edit.addEventListener("click", () => { editBox.hidden = !editBox.hidden; if (!editBox.hidden) input.focus(); });
    const read = () => {
      row.name = input.value; row.url = url.value; name.textContent = row.name || "（名前未入力）";
      const v = validateRelatedLink(row); error.textContent = v.ok ? "" : v.errors.join(" "); changed(true);
    };
    input.addEventListener("input", read); url.addEventListener("input", read);
    up.addEventListener("click", () => {
      const i = rows.indexOf(row); if (i <= STANDARD_LINKS.length) return;
      const previous = rows[i - 1]; rows.splice(i - 1, 2, row, previous);
      customs.insertBefore(el, controls.get(previous.id));
      rows.filter(r => !r.standard).forEach((r, n) => { r.sortOrder = (n + 1) * 10; });
      updateMoves(); changed();
    });
    del.addEventListener("click", () => {
      if (!window.confirm(`「${row.name || "このリンク"}」を削除しますか？`)) return;
      clearTimeout(timer); timer = null;
      // 保存中の追加行も同じIDの削除として後続バッチで処理する。
      pendingDeletes.add(row.id); el.classList.add("is-deleting");
      for (const c of el.querySelectorAll("input,button")) c.disabled = true;
      changed();
    });
    return el;
  }
  add.addEventListener("click", () => {
    if (!ready) return;
    const row = { id: `custom-${crypto.randomUUID()}`, name: "", url: "", enabled: true,
      sortOrder: Math.max(0, ...rows.filter(r => !r.standard).map(r => r.sortOrder || 0)) + 10 };
    rows.push(row); customs.append(rowElement(row, true)); updateMoves(); controls.get(row.id).querySelector('input[aria-label="リンク名"]').focus();
  });
  const hasUnsaved = () => ready && (Boolean(timer) || pendingDeletes.size > 0 || saver.failed || rows.some(r => !r.standard && !validateRelatedLink(r).ok)
    || planRelatedLinkWrites(original, rows).upserts.length > 0);
  section._related = {
    saver,
    async load(fid) {
      const gen = ++generation; id = fid; ready = false; clearTimeout(timer); timer = null;
      saver.failed = false; section.querySelector('[data-act="retry-autosave"]')?.remove();
      original = []; rows = []; pendingDeletes.clear(); controls.clear(); standards.replaceChildren(); customs.replaceChildren(); add.disabled = true;
      const msg = section.querySelector("[data-msg]"); msg.textContent = "読み込み中…";
      section.querySelector('[data-act="retry-load"]')?.remove();
      try {
        const docs = await repository.listRelatedLinks(fid);
        if (gen !== generation) return;
        original = docs; rows = relatedLinkRows(docs).map(r => ({ ...r })); ready = true; add.disabled = false;
        standards.replaceChildren(...rows.filter(r => r.standard).map(r => rowElement(r)));
        customs.replaceChildren(...rows.filter(r => !r.standard).map(r => rowElement(r))); updateMoves(); msg.textContent = "";
      } catch {
        if (gen !== generation) return;
        msg.textContent = "関連リンクを読み込めませんでした。再試行してください。";
        const retry = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "retry-load" }, "再試行");
        retry.addEventListener("click", () => section._related.load(fid)); msg.after(retry);
      }
    },
    async flush() { if (timer) { clearTimeout(timer); timer = null; saver.request(); } await saver.idle(); },
    hasUnsaved,
    discard() { generation++; ready = false; clearTimeout(timer); timer = null; },
    leaveMessage: LEAVE
  };
  window.addEventListener("beforeunload", e => { if (hasUnsaved()) { e.preventDefault(); e.returnValue = LEAVE; } });
  return section;
}
