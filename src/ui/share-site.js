/**
 * サイトの共有(ヘッダーのメニュー「サイトを共有」)。ログインしていなくても使える。
 * IOL Order のURL(固定)のQRコード・URL・「URLをコピー」を、既存のモーダルと同じ見た目(白い背景)で表示する。
 * QRコードは https://iol.medconf.jp/ だけを表す(施設ID・招待コード・個人情報は含めない)。
 * QRコードは qrcode(1.5.4・誤り訂正 M・周囲の余白 4 モジュール)で生成した SVG を埋め込んだもの(外部への通信なし。tests/browser/share-site.pw.mjs で読み取りを確認)。
 */
export const SITE_URL = "https://iol.medconf.jp/";
const QR_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" class=\"share-qr\" role=\"img\" aria-label=\"IOL Order のQRコード(https://iol.medconf.jp/)\" viewBox=\"0 0 33 33\" shape-rendering=\"crispEdges\"><path fill=\"#ffffff\" d=\"M0 0h33v33H0z\"/><path stroke=\"#000000\" d=\"M4 4.5h7m2 0h2m1 0h2m2 0h1m1 0h7M4 5.5h1m5 0h1m2 0h1m3 0h4m1 0h1m5 0h1M4 6.5h1m1 0h3m1 0h1m1 0h1m7 0h1m1 0h1m1 0h3m1 0h1M4 7.5h1m1 0h3m1 0h1m1 0h2m3 0h2m3 0h1m1 0h3m1 0h1M4 8.5h1m1 0h3m1 0h1m1 0h1m1 0h2m4 0h1m1 0h1m1 0h3m1 0h1M4 9.5h1m5 0h1m1 0h1m1 0h1m2 0h4m1 0h1m5 0h1M4 10.5h7m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h7M12 11.5h1m1 0h2M4 12.5h1m1 0h5m2 0h1m1 0h3m1 0h1m2 0h5M4 13.5h3m1 0h2m1 0h5m1 0h1m2 0h1m2 0h1m3 0h1M5 14.5h4m1 0h2m3 0h5m1 0h1m1 0h1m1 0h1m1 0h2M4 15.5h2m1 0h3m2 0h3m4 0h3m2 0h1m3 0h1M4 16.5h2m4 0h2m2 0h1m1 0h4m1 0h2m1 0h1m1 0h3M4 17.5h2m2 0h1m2 0h3m3 0h1m2 0h1m2 0h1m1 0h1m1 0h1M4 18.5h1m1 0h1m3 0h2m2 0h4m1 0h3m1 0h3m1 0h2M4 19.5h1m2 0h2m3 0h2m1 0h1m3 0h2m1 0h3m3 0h1M4 20.5h1m1 0h1m1 0h3m1 0h1m1 0h2m1 0h8m1 0h1M12 21.5h2m2 0h1m1 0h3m3 0h2M4 22.5h7m9 0h1m1 0h1m1 0h1m1 0h3M4 23.5h1m5 0h1m1 0h1m3 0h1m3 0h1m3 0h2m1 0h1M4 24.5h1m1 0h3m1 0h1m1 0h1m3 0h2m1 0h6m1 0h3M4 25.5h1m1 0h3m1 0h1m1 0h2m3 0h1m4 0h1m1 0h5M4 26.5h1m1 0h3m1 0h1m1 0h1m1 0h5m1 0h1m4 0h2m1 0h1M4 27.5h1m5 0h1m2 0h3m2 0h4m1 0h3m2 0h1M4 28.5h7m1 0h5m6 0h6\"/></svg>";

/** URL をクリップボードへ。使えない環境では、選択してコピーする方法に切り替える */
async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* 下の方法を試す */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

/** 共有のモーダルを開く(閉じる: 「閉じる」・Escape・背景のクリック) */
export function openShareDialog() {
  if (document.querySelector(".share-dialog")) return;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay share-dialog";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "shareDialogTitle");
  overlay.innerHTML = `
    <div class="modal-card">
      <div class="modal-header modal-header-simple"><h2 class="modal-title" id="shareDialogTitle">サイトを共有</h2></div>
      <div class="modal-body">
        <div class="share-qr-box">${QR_SVG}</div>
        <p class="share-url" id="shareUrl"></p>
        <p class="form-hint share-status" role="status" aria-live="polite"></p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-act="close">閉じる</button>
        <button type="button" class="btn btn-primary" data-act="copy">URLをコピー</button>
      </div>
    </div>`;
  overlay.querySelector("#shareUrl").textContent = SITE_URL;
  const status = overlay.querySelector(".share-status");
  const before = document.activeElement, overflow = document.body.style.overflow;
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    document.body.style.overflow = overflow;
    if (before && typeof before.focus === "function") before.focus();
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  overlay.querySelector('[data-act="close"]').addEventListener("click", close);
  overlay.querySelector('[data-act="copy"]').addEventListener("click", async () => {
    status.textContent = (await copyText(SITE_URL)) ? "URLをコピーしました" : "コピーできませんでした。URLを長押し(選択)してコピーしてください";
  });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  overlay.querySelector('[data-act="copy"]').focus();
}
