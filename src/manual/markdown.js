/**
 * マニュアル(docs/manual の Markdown)を、表示用の構造(ただのオブジェクト)に変換する。DOM・HTML は扱わない。
 * 表示側(ui/manual-view.js)は、この構造から要素を組み立て、文字列は textContent で入れる(HTMLとして解釈しない)。
 * 原稿に含まれる HTML のタグも、ただの文字として表示される。
 *
 * 対応する書式(マニュアルで使うものだけ): 見出し(#〜######)・段落・行末の空白2つの改行・区切り線(---)・
 * 箇条書き(-・*・+、番号付き。字下げで入れ子)・引用(>)・表(| 区切り。列の揃え)・コード(``` と `…`)・太字(**…**)・
 * リンク([文字](URL))・本文中の https:// の URL・施設管理者のみの印(`{*}`。画面では赤い *)・折りたたみ(`<details>` の行、`<summary>見出し</summary>` の行、`</details>` の行。
 * この決まった形だけを折りたたみとして扱い、見出しも文字として表示する。それ以外の HTML はすべて文字のまま)。
 *
 * リンク先は resolveLink に任せる。解決できないもの(javascript: など)はリンクにせず、文字だけを表示する。
 */

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/;
const QUOTE = /^\s{0,3}>/;
const FENCE = /^\s{0,3}```/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const DETAILS_OPEN = /^\s*<details>\s*$/i;
const DETAILS_CLOSE = /^\s*<\/details>\s*$/i;
const SUMMARY = /^\s*<summary>(.*?)<\/summary>\s*$/i;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, "    ").length;
const isBlank = (line) => !line.trim();
const isOrderedMarker = (m) => /\d/.test(m);

/** 行頭の空白を最大 n 文字取り除く */
const dedent = (line, n) => {
  let i = 0;
  while (i < n && i < line.length && line[i] === " ") i++;
  return line.slice(i);
};

/** 段落などの終わり(別の種類のブロックの始まり) */
const startsBlock = (line, next) =>
  DETAILS_OPEN.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || FENCE.test(line) || ITEM.test(line) ||
  (line.includes("|") && next !== undefined && TABLE_SEP.test(next));

/**
 * @param {string} markdown
 * @param {{resolveLink?: (url:string) => (object|null)}} [options]
 * @returns {Array<object>} ブロックの配列
 */
export function parseMarkdown(markdown, options = {}) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  return parseBlocks(lines, options);
}

function parseBlocks(lines, options) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    if (FENCE.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++;   // 閉じの ```(なければ末尾まで)
      out.push({ type: "code", text: body.join("\n") });
      continue;
    }

    if (DETAILS_OPEN.test(line)) {
      const d = parseDetails(lines, i, options);
      if (d) { out.push(d.block); i = d.next; continue; }
    }

    const hm = line.match(HEADING);
    if (hm) { out.push({ type: "heading", level: hm[1].length, children: parseInline(hm[2], options) }); i++; continue; }

    if (HR.test(line)) { out.push({ type: "hr" }); i++; continue; }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].replace(/^\s{0,3}> ?/, ""));
      out.push({ type: "blockquote", children: parseBlocks(inner, options) });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map(c => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      i += 2;
      const rows = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      const width = head.length;
      const fit = (cells) => Array.from({ length: width }, (_, k) => parseInline(cells[k] ?? "", options));
      out.push({ type: "table", align: Array.from({ length: width }, (_, k) => align[k] ?? null), head: fit(head), rows: rows.map(fit) });
      continue;
    }

    if (ITEM.test(line)) { i = parseList(lines, i, out, options); continue; }

    // 段落: 空行・別のブロックの始まりまで
    const para = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++]);
    out.push({ type: "paragraph", children: paragraphInline(para, options) });
  }
  return out;
}

/** 箇条書き(同じ字下げ・同じ種類の項目が続く間)。項目の中身は字下げを外して、ブロックとして解析し直す(入れ子) */
function parseList(lines, i, out, options) {
  const first = lines[i].match(ITEM);
  const baseIndent = indentOf(first[1]);
  const ordered = isOrderedMarker(first[2]);
  const list = { type: "list", ordered, start: ordered ? Number.parseInt(first[2], 10) : null, items: [] };
  while (i < lines.length) {
    const m = lines[i].match(ITEM);
    if (!m || indentOf(m[1]) !== baseIndent || isOrderedMarker(m[2]) !== ordered) break;
    const contentIndent = baseIndent + m[2].length + 1;
    const body = [m[3]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        // 空行のあと、字下げした続き(入れ子・続きの段落)があれば同じ項目
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) > baseIndent) { body.push(""); i = j; continue; }
        break;
      }
      if (indentOf(l) <= baseIndent) break;
      body.push(dedent(l, contentIndent));
      i++;
    }
    list.items.push({ children: parseBlocks(body, options) });
    // 項目の間の空行(同じ箇条書きの次の項目が続く場合だけ読み飛ばす)
    let j = i;
    while (j < lines.length && isBlank(lines[j])) j++;
    const nm = j < lines.length && lines[j].match(ITEM);
    if (nm && indentOf(nm[1]) === baseIndent && isOrderedMarker(nm[2]) === ordered) i = j;
    else break;
  }
  out.push(list);
  return i;
}

/** 折りたたみ: <details> から対応する </details> まで(入れ子も数える)。最初の行が <summary>…</summary> でなければ null(文字のまま) */
function parseDetails(lines, i, options) {
  let depth = 0, end = -1;
  for (let j = i; j < lines.length; j++) {
    if (DETAILS_OPEN.test(lines[j])) depth++;
    else if (DETAILS_CLOSE.test(lines[j]) && --depth === 0) { end = j; break; }
  }
  if (end < 0) return null;
  const inner = lines.slice(i + 1, end);
  const k = inner.findIndex(l => !isBlank(l));
  const sm = k >= 0 ? inner[k].match(SUMMARY) : null;
  if (!sm) return null;
  return { block: { type: "details", summary: parseInline(sm[1], { ...options, noLinks: true }), children: parseBlocks(inner.slice(k + 1), options) }, next: end + 1 };
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map(c => c.trim());
}

const CJK = /[　-鿿＀-￯]/;

/** 段落の行をつなぐ。行末の空白2つ(以上)は改行。日本語どうしの改行は詰め、それ以外は空白1つ */
function paragraphInline(lines, options) {
  const out = [];
  lines.forEach((raw, k) => {
    const hard = / {2,}$/.test(raw);
    const text = raw.trim();
    out.push(...parseInline(text, options));
    if (k === lines.length - 1) return;
    if (hard) { out.push({ type: "br" }); return; }
    const next = lines[k + 1].trim();
    if (!(CJK.test(text.slice(-1)) || CJK.test(next.charAt(0)))) out.push({ type: "text", text: " " });
  });
  return mergeText(out);
}

const INLINE_RULES = [
  { type: "code", re: /`([^`]+)`/ },
  { type: "adminMark", re: /\{\*\}/ },   // マニュアルの「施設管理者のみ」の印(画面では赤い *)
  { type: "strong", re: /\*\*(.+?)\*\*/ },
  { type: "link", re: /\[([^\]]+)\]\(([^)\s]+)\)/ },
  { type: "url", re: /https?:\/\/[^\s<>()（）「」『』、。，]+[^\s<>()（）「」『』、。，.,:;!?]/ }
];

/**
 * 行内の書式。最も手前で始まる書式から順に取り出し、残りは文字のまま。
 * @returns {Array<object>} text / code / strong(children) / link(link, children) / br
 */
export function parseInline(text, options = {}) {
  const out = [];
  let rest = String(text ?? "");
  while (rest) {
    let best = null;
    for (const rule of INLINE_RULES) {
      const m = rest.match(rule.re);
      if (m && (!best || m.index < best.m.index)) best = { rule, m };
    }
    if (!best) { out.push({ type: "text", text: rest }); break; }
    const { rule, m } = best;
    if (m.index > 0) out.push({ type: "text", text: rest.slice(0, m.index) });
    if (rule.type === "code") out.push({ type: "code", text: m[1] });
    else if (rule.type === "adminMark") out.push({ type: "adminMark" });
    else if (rule.type === "strong") out.push({ type: "strong", children: parseInline(m[1], options) });
    else {
      const label = rule.type === "link" ? m[1] : m[0];
      const url = rule.type === "link" ? m[2] : m[0];
      const children = rule.type === "link" ? parseInline(label, { ...options, noLinks: true }) : [{ type: "text", text: label }];
      const link = options.noLinks ? null : resolve(url, options);
      if (link) out.push({ type: "link", link, children });
      else out.push(...children);   // リンクにできないもの(未知の書式・危険なURL)は文字だけ
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return mergeText(out);
}

function resolve(url, options) {
  const fn = options.resolveLink || defaultResolveLink;
  try { return fn(url) || null; } catch { return null; }
}

/** 既定: http(s) の外部リンクだけ。それ以外(javascript:・data:・相対パスなど)はリンクにしない */
export function defaultResolveLink(url) {
  return externalLink(url);
}

export function externalLink(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return { kind: "external", href: u.href };
}

function mergeText(nodes) {
  const out = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === "text" && last && last.type === "text") last.text += n.text;
    else if (!(n.type === "text" && n.text === "")) out.push(n);
  }
  return out;
}

/** 見出しなどの行内の構造から、書式を除いた文字だけを取り出す */
export function inlineText(nodes) {
  return (nodes || []).map(n => (n.type === "text" || n.type === "code" ? n.text : n.type === "br" ? " " : n.type === "adminMark" ? "*" : inlineText(n.children))).join("");
}
