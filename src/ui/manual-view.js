import { MANUAL_PAGES } from "../manual/manual-pages.js";
import { parseMarkdown, externalLink } from "../manual/markdown.js";

/** 要素生成の小さなヘルパー(表示する文字列は textContent で扱い、HTMLとして解釈しない) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

/** マニュアルのページの URL(ハッシュ)。目次は #help、各ページは #help/<ページID> */
export const manualHash = (pageId) => (!pageId || pageId === "index" ? "#help" : `#help/${pageId}`);

/** #help・#help/<ページID> ならページID(目次は "index")。それ以外は null */
export function pageIdFromHash(hash) {
  const m = String(hash || "").match(/^#help(?:\/([A-Za-z0-9_-]+))?\/?$/);
  if (!m) return null;
  const id = m[1] || "index";
  return MANUAL_PAGES.some(p => p.id === id) ? id : "index";
}

/** 原稿どうしのリンク(./02-orderer.md など)はマニュアルのページへ、http(s) は別のタブへ。それ以外はリンクにしない */
export function resolveManualLink(url) {
  const m = String(url).match(/^(?:\.\/)?([A-Za-z0-9_-]+)\.md$/);
  if (m) {
    const page = MANUAL_PAGES.find(p => p.file === `${m[1]}.md`);
    return page ? { kind: "page", href: manualHash(page.id) } : null;
  }
  return externalLink(url);
}

function inlineNodes(nodes) {
  return nodes.map(n => {
    if (n.type === "text") return document.createTextNode(n.text);
    if (n.type === "br") return h("br");
    if (n.type === "code") return h("code", {}, n.text);
    if (n.type === "strong") return h("strong", {}, inlineNodes(n.children));
    if (n.type === "link") {
      const attrs = n.link.kind === "external" ? { href: n.link.href, target: "_blank", rel: "noopener noreferrer" } : { href: n.link.href };
      return h("a", attrs, inlineNodes(n.children));
    }
    return null;
  });
}

function blockNodes(blocks, { tight = false } = {}) {
  return blocks.map(b => {
    switch (b.type) {
      case "heading": return h(`h${Math.min(b.level, 6)}`, {}, inlineNodes(b.children));
      case "paragraph": return tight ? inlineNodes(b.children) : h("p", {}, inlineNodes(b.children));
      case "hr": return h("hr");
      case "code": return h("pre", {}, h("code", {}, b.text));
      case "blockquote": return h("blockquote", {}, blockNodes(b.children));
      case "list": {
        const attrs = b.ordered && b.start !== 1 ? { start: String(b.start) } : {};
        // 項目の最初の段落は <p> で包まない(詰めた箇条書き)
        return h(b.ordered ? "ol" : "ul", attrs, b.items.map(it => h("li", {}, it.children.map((c, k) => blockNodes([c], { tight: k === 0 })))));
      }
      case "table": {
        const cell = (tag, nodes, k) => h(tag, b.align[k] ? { class: `align-${b.align[k]}` } : {}, inlineNodes(nodes));
        return h("div", { class: "manual-table-wrap" },
          h("table", {},
            h("thead", {}, h("tr", {}, b.head.map((c, k) => cell("th", c, k)))),
            h("tbody", {}, b.rows.map(r => h("tr", {}, r.map((c, k) => cell("td", c, k)))))));
      }
      default: return null;
    }
  });
}

/** Markdown を表示用の要素にする(HTMLとして解釈しない。リンクは resolveManualLink で解決できるものだけ) */
export function renderManualMarkdown(markdown) {
  const frag = document.createDocumentFragment();
  for (const n of blockNodes(parseMarkdown(markdown, { resolveLink: resolveManualLink })).flat(Infinity)) if (n) frag.appendChild(n);
  return frag;
}

/**
 * 使い方・ヘルプ(オンラインマニュアル)。ログインの前後どちらでも開ける。表示中は main の他の画面を CSS で隠すだけで、
 * 注文画面・施設設定などの状態には触れない(閉じると元の表示に戻る)。ページの移動は URL のハッシュ(#help/…)で行う。
 *
 * @param {object} deps
 * @param {HTMLElement} deps.mount 表示先(main)
 * @param {() => string} deps.backLabel 戻るボタンの文言(注文画面に戻る・ログイン画面に戻る など)
 * @param {() => void} deps.onBack 戻るボタン
 */
export function createManualView({ mount, backLabel, onBack }) {
  const root = h("section", { id: "manualView", class: "settings-view manual-view", hidden: true, "aria-labelledby": "manualHeading" });
  mount.insertBefore(root, mount.firstChild);
  let current = null;

  const backBtn = () => {
    const b = h("button", { type: "button", class: "btn btn-secondary manual-back" }, backLabel());
    b.addEventListener("click", () => onBack());
    return b;
  };

  function show(pageId) {
    const page = MANUAL_PAGES.find(p => p.id === pageId) || MANUAL_PAGES[0];
    current = page.id;
    const nav = h("nav", { class: "manual-nav", "aria-label": "マニュアルのページ" },
      MANUAL_PAGES.map(p => h("a", { href: manualHash(p.id), class: "manual-nav-link", "aria-current": p.id === page.id ? "page" : null }, p.label)));
    const article = h("article", { class: "manual-body", tabindex: "-1" }, renderManualMarkdown(page.markdown));
    const idx = MANUAL_PAGES.indexOf(page);
    const prev = idx > 0 ? MANUAL_PAGES[idx - 1] : null;
    const next = idx < MANUAL_PAGES.length - 1 ? MANUAL_PAGES[idx + 1] : null;
    const pager = h("div", { class: "manual-pager" },
      prev ? h("a", { href: manualHash(prev.id), class: "manual-pager-link is-prev" }, `← ${prev.label}`) : h("span"),
      next ? h("a", { href: manualHash(next.id), class: "manual-pager-link is-next" }, `${next.label} →`) : h("span"));
    const foot = h("div", { class: "manual-foot" },
      page.id !== "index" ? h("a", { href: manualHash("index"), class: "btn btn-secondary manual-toc" }, "目次へ戻る") : null,
      backBtn());
    root.replaceChildren(
      h("div", { class: "settings-head" }, h("h2", { id: "manualHeading" }, "使い方・ヘルプ"), h("span", { class: "settings-facility" }), backBtn()),
      nav, article, pager, foot);
    root.hidden = false;
    mount.classList.add("manual-open");
    window.scrollTo(0, 0);
    article.focus({ preventScroll: true });
  }

  function close() {
    current = null;
    root.hidden = true;
    mount.classList.remove("manual-open");
  }

  /** 戻るボタンの文言を更新する(表示中にログインの状態が変わったとき) */
  function updateBackLabel() {
    const label = backLabel();
    for (const b of root.querySelectorAll(".manual-back")) if (b.textContent !== label) b.textContent = label;
  }

  return { show, close, updateBackLabel, isOpen: () => current !== null, currentPage: () => current };
}
