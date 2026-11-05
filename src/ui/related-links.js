import { visibleRelatedLinks } from "../domain/related-links.js";

/** 既存のリンクと同じアイコン(右上向きの矢印) */
function linkIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({ class: "ext-icon", viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", "stroke-width": "2", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(k, v);
  const p = document.createElementNS(svg.namespaceURI, "path");
  p.setAttribute("d", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3");
  svg.append(p);
  return svg;
}

/**
 * @param {Array<object>|null} documents 施設が登録した関連リンク(null は読み込みの前・失敗。標準のリンクも出さない)
 * @param {Element} [root]
 * @param {{onOpenStickerPhotos?: (() => void)|null}} [extra] 「IOLシール写真」(画面内の閲覧画面を開く。利用できる施設だけ。登録したリンクの後ろに置く)
 */
export function renderRelatedLinks(documents, root = document.querySelector(".ref-links-accordion"), { onOpenStickerPhotos = null } = {}) {
  if (!root) return;
  const links = documents ? visibleRelatedLinks(documents) : [];
  const items = links.map(link => {
    const li = document.createElement("li"), a = document.createElement("a");
    a.className = "ref-link"; a.href = link.url; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = link.name;
    a.append(linkIcon()); li.append(a); return li;
  });
  if (onOpenStickerPhotos) {
    const li = document.createElement("li"), a = document.createElement("a");
    a.className = "ref-link"; a.href = "#"; a.id = "refLinkStickerPhotos";
    a.textContent = "IOLシール写真";
    a.addEventListener("click", (e) => { e.preventDefault(); onOpenStickerPhotos(); });
    a.append(linkIcon()); li.append(a); items.push(li);
  }
  root.querySelector(".ref-links-list").replaceChildren(...items);
  root.hidden = items.length === 0;
}

// 遅れて終わった旧施設の読み込みを、新施設や保存直後の表示へ適用しない。
export function createRelatedLinksView(root = document.querySelector(".ref-links-accordion")) {
  let facilityId = null, revision = 0;
  let docs = null;            // 表示中の関連リンク(読み込みの前・失敗のときは null。標準のリンクも出さない)
  let openSticker = null;     // 「IOLシール写真」を開く処理(この施設で利用できるときだけ)
  const notice = document.createElement("p");
  notice.className = "form-hint"; notice.setAttribute("role", "status"); notice.hidden = true;
  root?.after(notice);
  // 押したときの処理は、その時点で設定されているものを呼ぶ(描き直さずに差し替えられるように)
  const paint = () => renderRelatedLinks(docs, root, { onOpenStickerPhotos: openSticker ? () => { if (openSticker) openSticker(); } : null });
  return {
    clear() { notice.hidden = true; facilityId = null; revision++; docs = null; openSticker = null; paint(); },
    saved(id, saved) { if (id !== facilityId) return; revision++; notice.hidden = true; docs = saved; paint(); },
    /** 「IOLシール写真」を出す・消す(null で消す)。関連リンクの読み込みとは別に切り替わる */
    setStickerPhotos(open) {
      if (Boolean(open) === Boolean(openSticker)) { openSticker = open || null; return; }
      openSticker = open || null;
      paint();
    },
    async load(id, repository) {
      notice.hidden = true;
      facilityId = id; const ticket = ++revision;
      docs = null; paint();
      try {
        const loaded = await repository.listRelatedLinks(id);
        if (ticket === revision && facilityId === id) { docs = loaded; paint(); }
      } catch (e) { if (ticket === revision && facilityId === id) { notice.textContent = "関連リンクを読み込めませんでした。ページを再読み込みしてください。"; notice.hidden = false; } console.warn("関連リンクを読み込めませんでした。再読み込みしてください:", e); }
    }
  };
}
