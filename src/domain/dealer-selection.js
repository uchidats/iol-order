/**
 * 明細の発注先ディーラーの決め方(純粋関数)。サーバー(functions/src/orders.js の resolveLineDealer / dealerDispatch)と同じ規則で、
 * 確認画面・注文の保存・メールdry-runの判定を一致させる(tests/dealer-selection.test.js で一致を確認)。
 * 施設の登録ディーラー(facilityDealers)だけが対象。採用IOLの dealerId には依存しない。
 *
 *  - 0社: 発注先なし → 「発注先未設定」
 *  - 1社: そのディーラーを自動選択
 *  - 2社以上: 明細ごとに選択が必須(勝手に決めない)
 *  - 発注用メールがない(または形式が不正な)ディーラーは、実メール送信不可
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 入力欄の種類: "none"(0社) / "auto"(1社) / "choose"(2社以上。選択必須) */
export function dealerMode(dealers) {
  return dealers.length === 0 ? "none" : dealers.length === 1 ? "auto" : "choose";
}

/** @returns {{ok:true, dealer:object|null}|{ok:false, error:"not-found"|"select"}} */
export function resolveLineDealer(dealers, requestedId) {
  const want = requestedId || "";
  if (dealers.length === 0) return want ? { ok: false, error: "not-found" } : { ok: true, dealer: null };
  if (dealers.length === 1) return want && want !== dealers[0].id ? { ok: false, error: "not-found" } : { ok: true, dealer: dealers[0] };
  if (!want) return { ok: false, error: "select" };
  const d = dealers.find(x => x.id === want);
  return d ? { ok: true, dealer: d } : { ok: false, error: "not-found" };
}

/** 実メール送信の可否(ディーラーなし・発注用メールなしは送信不可) */
export function dealerDispatch(dealer) {
  if (!dealer) return { allowed: false, reason: "dealer-unset" };
  const emails = Array.isArray(dealer.orderEmails) ? dealer.orderEmails : [];
  return emails.some(e => typeof e === "string" && EMAIL.test(e.trim()))
    ? { allowed: true, reason: null } : { allowed: false, reason: "no-order-email" };
}

/** 確認画面に出す発注先の文言 */
export function dealerLabel(dealer) {
  if (!dealer) return "発注先未設定";
  const d = dealerDispatch(dealer);
  return d.allowed ? `発注先 ${dealer.name}` : `発注先 ${dealer.name}(発注用メール未登録のため自動送信不可)`;
}
