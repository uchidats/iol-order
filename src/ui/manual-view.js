import { MANUAL_PAGES } from "../manual/manual-pages.js";
import { externalLink } from "../manual/markdown.js";
import { h, renderMarkdown } from "./markdown-view.js";
import { canViewManualPage, visibleManualPages } from "../domain/manual-access.js";

/** マニュアルのページの URL(ハッシュ)。目次は #help、各ページは #help/<ページID> */
export const manualHash = (pageId) => (!pageId || pageId === "index" ? "#help" : `#help/${pageId}`);

/** 統合した旧ページの URL → 新しいページ(以前の #help/03-subadmin・#help/04-admin の共有リンクを案内する。閲覧範囲の判定は移動先で行う) */
export const MANUAL_PAGE_ALIASES = Object.freeze({ "03-subadmin": "03-managers", "04-admin": "03-managers" });

/** #help・#help/<ページID> ならページID(目次は "index"、旧ページは統合先)。それ以外は null */
export function pageIdFromHash(hash) {
  const m = String(hash || "").match(/^#help(?:\/([A-Za-z0-9_-]+))?\/?$/);
  if (!m) return null;
  const id = MANUAL_PAGE_ALIASES[m[1]] || m[1] || "index";
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

/** Markdown を表示用の要素にする(HTMLとして解釈しない。リンクは resolveManualLink で解決できるものだけ) */
export function renderManualMarkdown(markdown) {
  return renderMarkdown(markdown, { resolveLink: resolveManualLink });
}

/** #help/<ページID> のページID(目次は "index") */
const hashPageId = (href) => (href === "#help" ? "index" : String(href).replace(/^#help\//, ""));

/**
 * 閲覧範囲の外のページへのリンクを外す。目次(README)では、そのページの項目ごと表示しない。他のページでは文字だけにする
 * @param {HTMLElement} article
 * @param {(pageId:string) => boolean} canView
 */
function pruneHiddenLinks(article, canView, isIndex) {
  for (const a of [...article.querySelectorAll('a[href^="#help"]')]) {
    if (canView(hashPageId(a.getAttribute("href")))) continue;
    const li = a.closest("li");
    if (isIndex && li && li.parentElement && li.parentElement.parentElement === article) { li.remove(); continue; }
    a.replaceWith(...a.childNodes);
  }
}

/**
 * 使い方・ヘルプ(オンラインマニュアル)。ログインの前後どちらでも開ける。表示中は main の他の画面を CSS で隠すだけで、
 * 注文画面・施設設定などの状態には触れない(閉じると元の表示に戻る)。ページの移動は URL のハッシュ(#help/…)で行う。
 * 表示するページは、ログイン状態と施設内の役割で決める(domain/manual-access.js)。範囲外のページを開いたら目次へ戻す。
 * 確認中(audience が null)は、範囲外のページを表示せずに待つ(上位のページを一時的にも表示しない)。
 *
 * @param {object} deps
 * @param {HTMLElement} deps.mount 表示先(main)
 * @param {() => string} deps.backLabel 戻るボタンの文言(注文画面に戻る・ログイン画面に戻る など)
 * @param {() => void} deps.onBack 戻るボタン
 * @param {() => (string|null)} [deps.audience] 閲覧範囲(未指定は未ログインと同じ)
 */
export function createManualView({ mount, backLabel, onBack, audience = () => "guest" }) {
  const root = h("section", { id: "manualView", class: "settings-view manual-view", hidden: true, "aria-labelledby": "manualHeading" });
  mount.insertBefore(root, mount.firstChild);
  let current = null;     // 表示中のページ
  let requested = null;   // 開こうとしたページ(確認中は、範囲外なら待つ)
  let shownFor;           // 表示したときの閲覧範囲

  const backBtn = () => {
    const b = h("button", { type: "button", class: "btn btn-secondary manual-back" }, backLabel());
    b.addEventListener("click", () => onBack());
    return b;
  };
  const head = () => h("div", { class: "settings-head" }, h("h2", { id: "manualHeading" }, "使い方・ヘルプ"), h("span", { class: "settings-facility" }), backBtn());

  function open() {
    root.hidden = false;
    mount.classList.add("manual-open");
  }

  function show(pageId) {
    const aud = audience();
    shownFor = aud;
    requested = MANUAL_PAGES.some(p => p.id === pageId) ? pageId : "index";
    if (!canViewManualPage(requested, aud)) {
      if (aud === null) {   // 確認中: 本文は出さずに待つ(updateAudience で表示し直す)
        current = requested;
        root.replaceChildren(head(), h("p", { class: "form-hint", role: "status" }, "読み込んでいます…"));
        open();
        return;
      }
      history.replaceState(null, "", location.pathname + location.search + manualHash("index"));   // 範囲外: 閲覧できる目次へ
      requested = "index";
    }
    const pages = visibleManualPages(MANUAL_PAGES, aud);
    const page = pages.find(p => p.id === requested) || pages[0];
    current = page.id;
    // 旧ページ・知らないページの URL は、表示したページの URL に置き換える(履歴は増やさない)
    if (/^#help(?:\/|$)/.test(location.hash) && location.hash !== manualHash(page.id)) history.replaceState(null, "", location.pathname + location.search + manualHash(page.id));
    const nav = h("nav", { class: "manual-nav", "aria-label": "マニュアルのページ" },
      pages.map(p => h("a", { href: manualHash(p.id), class: "manual-nav-link", "aria-current": p.id === page.id ? "page" : null }, p.label)));
    const article = h("article", { class: "manual-body", tabindex: "-1" }, renderManualMarkdown(page.markdown));
    pruneHiddenLinks(article, (id) => canViewManualPage(id, aud), page.id === "index");
    const idx = pages.indexOf(page);
    const prev = idx > 0 ? pages[idx - 1] : null;
    const next = idx < pages.length - 1 ? pages[idx + 1] : null;
    const pager = h("div", { class: "manual-pager" },
      prev ? h("a", { href: manualHash(prev.id), class: "manual-pager-link is-prev" }, `← ${prev.label}`) : h("span"),
      next ? h("a", { href: manualHash(next.id), class: "manual-pager-link is-next" }, `${next.label} →`) : h("span"));
    const foot = h("div", { class: "manual-foot" },
      page.id !== "index" ? h("a", { href: manualHash("index"), class: "btn btn-secondary manual-toc" }, "目次へ戻る") : null,
      backBtn());
    root.replaceChildren(head(), nav, article, pager, foot);
    open();
    window.scrollTo(0, 0);
    article.focus({ preventScroll: true });
  }

  function close() {
    current = null;
    requested = null;
    root.hidden = true;
    root.replaceChildren();
    mount.classList.remove("manual-open");
  }

  /** 戻るボタンの文言を更新する(表示中にログインの状態が変わったとき) */
  function updateBackLabel() {
    const label = backLabel();
    for (const b of root.querySelectorAll(".manual-back")) if (b.textContent !== label) b.textContent = label;
  }

  /** ログイン・役割の確認が進んだら、閲覧範囲に合わせて表示し直す(範囲が変わったときだけ) */
  function updateAudience() {
    if (current === null) return;
    if (audience() !== shownFor) show(requested);
    else updateBackLabel();
  }

  return { show, close, updateBackLabel, updateAudience, isOpen: () => current !== null, currentPage: () => current };
}
