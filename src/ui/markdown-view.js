import { parseMarkdown, externalLink } from "../manual/markdown.js";

/**
 * Markdown の表示(使い方・ヘルプ、IOL Orderについて で共通)。parseMarkdown の構造から要素を組み立てる。
 * 文字はすべて textContent で入れ、HTML として解釈しない。リンクは resolveLink で解決できたもの(ページ内 #… か https の外部)だけ。
 */

/** 要素生成の小さなヘルパー(表示する文字列は textContent で扱い、HTMLとして解釈しない) */
export function h(tag, attrs = {}, ...children) {
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

function inlineNodes(nodes) {
  return nodes.map(n => {
    if (n.type === "text") return document.createTextNode(n.text);
    if (n.type === "br") return h("br");
    if (n.type === "code") return h("code", {}, n.text);
    if (n.type === "adminMark") return h("span", { class: "manual-admin-mark", title: "施設管理者のみ" }, "*");
    if (n.type === "strong") return h("strong", {}, inlineNodes(n.children));
    if (n.type === "link") {
      // 念のため、表示の直前にも href を確かめる(ページ内の #… か http(s) だけ)
      if (n.link.kind === "external" && externalLink(n.link.href)) return h("a", { href: n.link.href, target: "_blank", rel: "noopener noreferrer" }, inlineNodes(n.children));
      if (n.link.kind === "page" && /^#[A-Za-z0-9_/-]*$/.test(n.link.href)) return h("a", { href: n.link.href }, inlineNodes(n.children));
      return inlineNodes(n.children);
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
      case "details": return h("details", { class: "markdown-details" }, h("summary", {}, inlineNodes(b.summary)), h("div", { class: "markdown-details-body" }, blockNodes(b.children)));
      case "list": {
        const attrs = b.ordered && b.start !== 1 ? { start: String(b.start) } : {};
        // 項目の最初の段落は <p> で包まない(詰めた箇条書き)
        return h(b.ordered ? "ol" : "ul", attrs, b.items.map(it => h("li", {}, it.children.map((c, k) => blockNodes([c], { tight: k === 0 })))));
      }
      case "table": {
        const cell = (tag, nodes, k) => h(tag, b.align[k] ? { class: `align-${b.align[k]}` } : {}, inlineNodes(nodes));
        return h("div", { class: b.head.length > 3 ? "manual-table-wrap is-wide" : "manual-table-wrap" },   // 4列以上の表だけ、狭い画面で横にスクロールする
          h("table", {},
            h("thead", {}, h("tr", {}, b.head.map((c, k) => cell("th", c, k)))),
            h("tbody", {}, b.rows.map(r => h("tr", {}, r.map((c, k) => cell("td", c, k)))))));
      }
      default: return null;
    }
  });
}

/**
 * @param {string} markdown
 * @param {{resolveLink?: (url:string) => (object|null)}} [options] 既定は https の外部リンクだけ
 * @returns {DocumentFragment}
 */
export function renderMarkdown(markdown, options = {}) {
  const frag = document.createDocumentFragment();
  for (const n of blockNodes(parseMarkdown(markdown, options)).flat(Infinity)) if (n) frag.appendChild(n);
  return frag;
}
