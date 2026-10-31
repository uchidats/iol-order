import { visibleRelatedLinks } from "../domain/related-links.js";

export function renderRelatedLinks(documents, root = document.querySelector(".ref-links-accordion")) {
  if (!root) return;
  const links = visibleRelatedLinks(documents);
  root.querySelector(".ref-links-list").replaceChildren(...links.map(link => {
    const li = document.createElement("li"), a = document.createElement("a");
    a.className = "ref-link"; a.href = link.url; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = link.name;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [k, v] of Object.entries({ class: "ext-icon", viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", "stroke-width": "2", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(k, v);
    const p = document.createElementNS(svg.namespaceURI, "path");
    p.setAttribute("d", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3");
    svg.append(p); a.append(svg); li.append(a); return li;
  }));
  root.hidden = links.length === 0;
}

// 遅れて終わった旧施設の読み込みを、新施設や保存直後の表示へ適用しない。
export function createRelatedLinksView(root = document.querySelector(".ref-links-accordion")) {
  let facilityId = null, revision = 0;
  const notice = document.createElement("p");
  notice.className = "form-hint"; notice.setAttribute("role", "status"); notice.hidden = true;
  root?.after(notice);
  return {
    clear() { notice.hidden = true; facilityId = null; revision++; if (root) { root.hidden = true; root.querySelector("ul").replaceChildren(); } },
    saved(id, docs) { if (id !== facilityId) return; revision++; notice.hidden = true; renderRelatedLinks(docs, root); },
    async load(id, repository) {
      notice.hidden = true;
      facilityId = id; const ticket = ++revision;
      if (root) { root.hidden = true; root.querySelector("ul").replaceChildren(); }
      try {
        const docs = await repository.listRelatedLinks(id);
        if (ticket === revision && facilityId === id) renderRelatedLinks(docs, root);
      } catch (e) { if (ticket === revision && facilityId === id) { notice.textContent = "関連リンクを読み込めませんでした。ページを再読み込みしてください。"; notice.hidden = false; } console.warn("関連リンクを読み込めませんでした。再読み込みしてください:", e); }
    }
  };
}
