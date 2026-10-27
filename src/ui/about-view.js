import { h, renderMarkdown } from "./markdown-view.js";

/**
 * サービス紹介「IOL Orderについて」(当面は運営者 platformAdmin だけ。メニューの表示と画面を開く判定は main.js、本文を読めるかは Rules)。
 * 本文は Firestore から読み込み、Markdown を安全に表示する(HTML は解釈しない。折りたたみは決まった形の <details> だけ)。
 * 表示中は main の他の画面を CSS で隠すだけで、注文画面の入力などには触れない。
 *
 * @param {object} deps
 * @param {HTMLElement} deps.mount 表示先(main)
 * @param {() => Promise<{markdown?:string}|null>} deps.loadContent 本文の読み込み
 * @param {() => string} deps.backLabel 戻るボタンの文言
 * @param {() => void} deps.onBack 戻るボタン
 */
export function createAboutView({ mount, loadContent, backLabel, onBack }) {
  const root = h("section", { id: "aboutView", class: "settings-view manual-view about-view", hidden: true, "aria-labelledby": "aboutHeading" });
  mount.insertBefore(root, mount.firstChild);
  let open = false;
  let seq = 0;   // 読み込みの世代。閉じた後に届いた結果は捨てる

  const backBtn = () => {
    const b = h("button", { type: "button", class: "btn btn-secondary manual-back" }, backLabel());
    b.addEventListener("click", () => onBack());
    return b;
  };

  /** 章(見出し h2)への移動ボタン。URL のハッシュは変えない(#about のまま) */
  function chapterNav(article) {
    const heads = [...article.querySelectorAll("h2")];
    if (!heads.length) return null;
    return h("nav", { class: "manual-nav", "aria-label": "章" }, heads.map(hd => {
      const b = h("button", { type: "button", class: "manual-nav-link" }, hd.textContent);
      b.addEventListener("click", () => hd.scrollIntoView({ behavior: "smooth", block: "start" }));
      return b;
    }));
  }

  async function show() {
    const my = ++seq;
    open = true;
    const status = h("p", { class: "form-hint", role: "status" }, "読み込んでいます…");
    root.replaceChildren(
      h("div", { class: "settings-head" }, h("h2", { id: "aboutHeading" }, "IOL Orderについて"), h("span", { class: "settings-facility" }), backBtn()),
      status);
    root.hidden = false;
    mount.classList.add("about-open");
    window.scrollTo(0, 0);
    let content = null, failed = false;
    try { content = await loadContent(); } catch (e) { failed = true; console.warn("紹介ページを読み込めませんでした:", e); }
    if (my !== seq || !open) return;
    if (failed || !content || typeof content.markdown !== "string" || !content.markdown.trim()) {
      status.textContent = failed ? "紹介ページを表示できませんでした。" : "紹介ページの原稿がまだ登録されていません。";
      return;
    }
    const article = h("article", { class: "manual-body about-body", tabindex: "-1" }, renderMarkdown(content.markdown));
    const nav = chapterNav(article);
    status.remove();
    root.append(...[nav, article, h("div", { class: "manual-foot" }, backBtn())].filter(Boolean));
    article.focus({ preventScroll: true });
  }

  function close() {
    open = false;
    seq++;
    root.hidden = true;
    root.replaceChildren();   // 閉じたら本文を画面に残さない
    mount.classList.remove("about-open");
  }

  function updateBackLabel() {
    const label = backLabel();
    for (const b of root.querySelectorAll(".manual-back")) if (b.textContent !== label) b.textContent = label;
  }

  return { show, close, updateBackLabel, isOpen: () => open };
}
