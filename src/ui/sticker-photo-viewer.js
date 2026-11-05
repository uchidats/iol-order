import { h } from "./markdown-view.js";
import { createImageZoom } from "./image-zoom.js";
import { createInfoTip } from "./info-tip.js";
import { confirmDialog } from "./confirm-dialog.js";
import { describeCallableError } from "../data/registration-api.js";
import { defaultPeriod, dayLabel, sessionLabel, groupForView, timeLabel, jstDate } from "../domain/sticker-photo-view.js";

const IMAGE_WORKERS = 4;   // サムネイルを同時に読む数

/** 注文画面の「注文画面に戻る」のクラス(施設設定の同じボタンと同じ見た目) */
export const ORDER_BACK_CLASS = "btn btn-outline-sm sticker-viewer-back";

/**
 * IOL シール写真の閲覧(一覧・拡大。docs/iol-sticker-photo-design.md §5・§6)。医療機関用とディーラー用で同じ部品。
 * 権限はサーバーが毎回確認し、ここでは表示だけを分ける。文字はすべて textContent。画像は Blob の URL で表示し、閉じたら解放する。
 * ダウンロード・共有のボタンは置かない。
 *
 * @param {object} deps
 * @param {HTMLElement} deps.mount
 * @param {string} deps.title 見出し
 * @param {string} deps.info ⓘ の説明
 * @param {string} deps.backLabel 戻るボタンの文言
 * @param {string} [deps.backClass] 戻るボタンのクラス(注文画面は ORDER_BACK_CLASS。ディーラー画面は既定のまま)
 * @param {() => void} deps.onClose
 * @param {() => number} [deps.now]
 * @param {(opts:object) => Promise<boolean>} [deps.confirm]
 */
export function createStickerPhotoViewer({ mount, title, info, backLabel, backClass = "btn btn-secondary", onClose, now = Date.now, confirm = confirmDialog }) {
  const root = h("section", { id: "stickerPhotoViewer", class: "settings-view sticker-viewer", hidden: true });
  mount.insertBefore(root, mount.firstChild);

  let open = false;
  let source = null;
  let facilities = [];
  let selected = new Set();
  let photos = [];
  let cursors = new Map();   // 施設 ID → 続きのカーソル(なければ続きなし)
  let period = defaultPeriod(now());
  let gen = 0;               // 読み込みの世代。条件を変えた・閉じたあとに届いた結果は捨てる
  let urls = new Set();      // 作った Blob の URL
  let queue = [];
  let workers = 0;
  let lightbox = null;

  const back = h("button", { type: "button", class: backClass, "data-act": "back" }, backLabel);
  back.addEventListener("click", () => { close(); onClose(); });
  const status = h("p", { class: "form-hint", role: "status" });
  const filters = h("div", { class: "sticker-viewer-filters" });
  const body = h("div", { class: "sticker-viewer-body" });
  root.append(
    h("div", { class: "settings-head" },
      h("div", { class: "settings-heading" }, h("h2", {}, title), createInfoTip(info, { label: `${title}の説明` }).root),
      h("span", { class: "settings-facility" }), back),
    filters, status, body);

  const showError = (e) => { status.textContent = describeCallableError(e); };

  function releaseImages() {
    for (const u of urls) URL.revokeObjectURL(u);
    urls = new Set();
    queue = [];
  }

  /** 画像を読んで Blob の URL を返す(なければ null) */
  async function imageUrl(photo, size) {
    const blob = await source.readImage({ facilityId: photo.facilityId, photoId: photo.photoId, size });
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    urls.add(url);
    return url;
  }

  /** サムネイルを同時に読みすぎないように順番に読む */
  function pump() {
    while (workers < IMAGE_WORKERS && queue.length) {
      const job = queue.shift();
      workers += 1;
      job().catch(() => {}).finally(() => { workers -= 1; pump(); });
    }
  }

  function thumbnail(photo, index) {
    const img = h("img", { class: "sticker-thumb-img", alt: `写真 ${index + 1}`, draggable: "false" });
    const btn = h("button", { type: "button", class: "sticker-thumb", "data-photo": photo.photoId, "aria-label": `写真 ${index + 1} を拡大` },
      img, h("span", { class: "sticker-thumb-no" }, String(index + 1)),
      photo.blurWarned ? h("span", { class: "sticker-thumb-warn", title: "ピンぼけの疑いで送信" }, "⚠") : null);
    const myGen = gen;
    queue.push(async () => {
      if (myGen !== gen) return;
      let url = null;
      try { url = await imageUrl(photo, "thumb"); } catch { /* 下で「表示できません」 */ }
      if (myGen !== gen) { if (url) { URL.revokeObjectURL(url); urls.delete(url); } return; }
      if (url) img.src = url;
      else btn.classList.add("is-missing");
    });
    return btn;
  }

  function sessionCard(session) {
    const grid = h("div", { class: "sticker-thumb-grid" }, session.photos.map(thumbnail));
    grid.addEventListener("click", (e) => {
      const b = e.target.closest("[data-photo]");
      if (b) openLightbox(session, session.photos.findIndex(p => p.photoId === b.dataset.photo));
    });
    return h("div", { class: "sticker-session", "data-session": session.sessionId },
      h("div", { class: "sticker-session-head" }, sessionLabel(session, now())), grid);
  }

  function renderList() {
    queue = [];
    const multi = selected.size > 1;
    const days = groupForView(photos);
    const more = [...cursors.values()].some(Boolean);
    const content = days.map(d => h("section", { class: "sticker-day", "data-day": d.date },
      h("h3", { class: "sticker-day-head" }, dayLabel(d.date, now())),
      d.facilities.map(f => [multi ? h("div", { class: "sticker-facility-name" }, f.facilityName) : null, f.sessions.map(sessionCard)])));
    const moreBtn = more ? h("button", { type: "button", class: "btn btn-secondary btn-aux history-more", "data-act": "more" }, "もっと見る") : null;
    if (moreBtn) moreBtn.addEventListener("click", () => load({ append: true }));
    body.replaceChildren(...content, ...(moreBtn ? [moreBtn] : []));
    if (!days.length && !status.textContent) status.textContent = "この期間の写真はありません。";
    pump();
  }

  /** 選んだ施設の写真を読む。append は続きだけ */
  async function load({ append = false } = {}) {
    const myGen = ++gen;
    if (!append) { releaseImages(); photos = []; cursors = new Map([...selected].map(id => [id, undefined])); body.replaceChildren(); }
    status.textContent = "読み込み中…";
    const targets = append ? [...cursors].filter(([, c]) => c).map(([id]) => id) : [...selected];
    try {
      const pages = await Promise.all(targets.map(async (id) => [id, await source.listPage(id, { ...period, cursor: cursors.get(id) })]));
      if (myGen !== gen || !open) return;
      for (const [id, page] of pages) {
        const name = (facilities.find(f => f.facilityId === id) || {}).name || "";
        photos.push(...page.photos.map(p => ({ ...p, facilityId: id, facilityName: name })));
        cursors.set(id, page.nextCursor);
      }
      status.textContent = "";
      renderList();
    } catch (e) {
      if (myGen !== gen || !open) return;
      showError(e);
    }
  }

  function renderFilters() {
    const checks = facilities.length > 1 ? h("div", { class: "sticker-viewer-facilities", role: "group", "aria-label": "医療機関" },
      facilities.map(f => {
        const cb = h("input", { type: "checkbox", "data-facility": f.facilityId });
        cb.checked = selected.has(f.facilityId);
        cb.addEventListener("change", () => { if (cb.checked) selected.add(f.facilityId); else selected.delete(f.facilityId); });
        return h("label", { class: "settings-check" }, cb, h("span", {}, f.name));
      })) : null;
    const from = h("input", { type: "date", class: "form-control", "data-f": "from", "aria-label": "期間の開始", max: jstDate(now()) });
    const to = h("input", { type: "date", class: "form-control", "data-f": "to", "aria-label": "期間の終わり", max: jstDate(now()) });
    from.value = period.from;
    to.value = period.to;
    const search = h("button", { type: "button", class: "btn btn-secondary btn-aux", "data-act": "search" }, "検索");
    search.addEventListener("click", () => { period = { from: from.value, to: to.value }; load(); });
    filters.replaceChildren(...[checks, h("div", { class: "sticker-viewer-period" }, from, h("span", {}, "〜"), to, search)].filter(Boolean));
  }

  /* ---------- 拡大表示 ---------- */

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.dispose();
    lightbox = null;
  }

  function openLightbox(session, start) {
    closeLightbox();
    let items = session.photos;
    let index = start;
    let shown = null;   // 表示中の原本の Blob の URL
    let seq = 0;
    const img = h("img", { class: "sticker-lightbox-img", alt: "", draggable: "false" });
    const stage = h("div", { class: "sticker-lightbox-stage" }, img);
    const zoom = createImageZoom({ stage, img });
    const position = h("span", { class: "sticker-lightbox-position" });
    const meta = h("div", { class: "form-hint sticker-lightbox-meta" });
    const message = h("p", { class: "form-hint", role: "status" });
    const button = (act, label, cls = "btn btn-secondary btn-aux") => h("button", { type: "button", class: cls, "data-act": act }, label);
    const prev = button("prev", "←"), next = button("next", "→"), rotate = button("rotate", "回転"), closeBtn = button("close", "閉じる");
    const del = source.deletePhoto ? button("delete", "削除", "btn btn-danger btn-aux") : null;
    const overlay = h("div", { class: "modal-overlay sticker-lightbox", role: "dialog", "aria-modal": "true", "aria-label": "写真の拡大" },
      h("div", { class: "sticker-lightbox-card" },
        h("div", { class: "sticker-lightbox-bar" }, position, h("span", { class: "sticker-lightbox-actions" }, prev, next, rotate, closeBtn)),
        stage, meta, message, del ? h("div", { class: "sticker-lightbox-foot" }, del) : null));

    const dropShown = () => { if (shown) { URL.revokeObjectURL(shown); urls.delete(shown); shown = null; } };
    async function show() {
      const photo = items[index];
      const mySeq = ++seq;
      zoom.reset();
      dropShown();
      img.removeAttribute("src");
      position.textContent = `${index + 1} / ${items.length}`;
      prev.disabled = index === 0;
      next.disabled = index === items.length - 1;
      meta.textContent = `送信 ${dayLabel(jstDate(Date.parse(photo.takenAt)), now())} ${timeLabel(photo.takenAt)}${photo.blurWarned ? " ・ ピンぼけの疑いで送信" : ""}`;
      message.textContent = "読み込み中…";
      try {
        const url = await imageUrl(photo, "full");
        if (mySeq !== seq) { if (url) { URL.revokeObjectURL(url); urls.delete(url); } return; }
        if (!url) { message.textContent = "画像を表示できません。"; return; }
        shown = url;
        img.src = url;
        message.textContent = "";
      } catch (e) {
        if (mySeq === seq) message.textContent = "画像を読み込めませんでした。時間をおいてお試しください。";
      }
    }
    const move = (d) => { const n = index + d; if (n >= 0 && n < items.length) { index = n; show(); } };
    prev.addEventListener("click", () => move(-1));
    next.addEventListener("click", () => move(1));
    rotate.addEventListener("click", () => zoom.reset((zoom.rotation + 90) % 360));
    img.addEventListener("load", () => zoom.reset(zoom.rotation));   // 画像の大きさが分かってから移動の範囲を合わせる
    closeBtn.addEventListener("click", closeLightbox);
    // 背景で押して背景で離したときだけ閉じる(画像のドラッグを背景で離しても閉じない)
    let pressedOverlay = false;
    overlay.addEventListener("pointerdown", (e) => { pressedOverlay = e.target === overlay; });
    overlay.addEventListener("click", (e) => { if (e.target === overlay && pressedOverlay) closeLightbox(); });
    const onKey = (e) => {
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowLeft") move(-1);
      else if (e.key === "ArrowRight") move(1);
    };
    document.addEventListener("keydown", onKey);
    if (del) del.addEventListener("click", async () => {
      const photo = items[index];
      if (!(await confirm({ message: "この写真を削除しますか？\n削除すると元に戻せません。", okLabel: "削除する" }))) return;
      del.disabled = true;
      try {
        await source.deletePhoto(photo.facilityId, photo.photoId);
      } catch (e) {
        del.disabled = false;
        message.textContent = describeCallableError(e);
        return;
      }
      del.disabled = false;
      photos = photos.filter(p => p.photoId !== photo.photoId);
      items = items.filter(p => p.photoId !== photo.photoId);
      renderList();
      if (!items.length) { closeLightbox(); return; }
      index = Math.min(index, items.length - 1);
      show();
    });

    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.body.append(overlay);
    closeBtn.focus();
    lightbox = {
      dispose() {
        seq += 1;
        dropShown();
        zoom.dispose();
        document.removeEventListener("keydown", onKey);
        document.body.style.overflow = overflow;
        overlay.remove();
      }
    };
    show();
  }

  function close() {
    open = false;
    gen += 1;
    closeLightbox();
    releaseImages();
    photos = [];
    root.hidden = true;
    body.replaceChildren();
  }

  return {
    isOpen: () => open,
    /** @param {{loadFacilities:Function, listPage:Function, readImage:Function, deletePhoto:Function|null}} src data/sticker-photo-api.js */
    async open(src) {
      close();
      source = src;
      open = true;
      root.hidden = false;
      period = defaultPeriod(now());
      const myGen = ++gen;
      filters.replaceChildren();
      status.textContent = "読み込み中…";
      try {
        facilities = await source.loadFacilities();
      } catch (e) {
        if (myGen === gen && open) showError(e);
        return;
      }
      if (myGen !== gen || !open) return;
      if (!facilities.length) { status.textContent = "共有されている写真はありません。"; return; }
      selected = new Set(facilities.map(f => f.facilityId));
      renderFilters();
      await load();
    },
    close
  };
}
