// 保存済みの注文から、発注メールのプレビューを表示する。【読み取り専用・メールは送信しない】何も変更しない。
//   node scripts/admin/preview-order-mail.mjs --facility <施設ID> --latest
//   node scripts/admin/preview-order-mail.mjs --facility <施設ID> --order <注文ID>
// 件名・本文は暫定の下書き(現行GASの形式が未確認。src/domain/order-mail.js を参照)。medconf-iol-dev のみ。
import { execFileSync } from "node:child_process";
import { buildOrderMailPreview } from "../../src/domain/order-mail.js";

const PROJECT = "medconf-iol-dev";
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const facility = opt("--facility"), orderId = opt("--order"), latest = args.includes("--latest");
const unknown = args.filter((a, i) => a.startsWith("--") && !["--facility", "--order", "--latest"].includes(a));
if (!facility || (!orderId && !latest) || unknown.length || !/^[A-Za-z0-9_-]{1,128}$/.test(facility)) {
  console.error("使い方: node scripts/admin/preview-order-mail.mjs --facility <施設ID> (--latest | --order <注文ID>)");
  process.exit(2);
}

const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
const headers = { Authorization: `Bearer ${token}`, "x-goog-user-project": PROJECT };

/** Firestore REST の値 → 素の値 */
function plain(v) {
  if (v === undefined || v === null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return { toMillis: () => Date.parse(v.timestampValue) };
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(plain);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, plain(x)]));
  return null;
}
const decode = (d) => ({ id: d.name.split("/").pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, plain(v)])) });

async function get(path) {
  const r = await fetch(`${BASE}/${path}`, { headers });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
async function list(path) {
  const out = []; let pageToken = "";
  do {
    const q = new URLSearchParams({ pageSize: "100" }); if (pageToken) q.set("pageToken", pageToken);
    const r = await fetch(`${BASE}/${path}?${q}`, { headers });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    const j = await r.json(); out.push(...(j.documents || [])); pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

const fac = decode(await get(`facilities/${facility}`));
const dealers = Object.fromEntries((await list(`facilities/${facility}/facilityDealers`)).map(decode).map(d => [d.id, d]));
const order = orderId
  ? decode(await get(`facilities/${facility}/orders/${orderId}`))
  : (await list(`facilities/${facility}/orders`)).map(decode).sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0))[0];
if (!order) { console.error("注文がありません。"); process.exit(1); }

const p = buildOrderMailPreview(order, { facilityName: fac.name, dealers });
console.log(`【プレビュー(送信しません)】 テンプレート: ${p.templateStatus}(現行GASの形式は未確認の暫定版)`);
console.log(`注文 ${p.orderNumber}  ディーラー宛のメール ${p.mails.length} 通 / 発注先未設定の明細 ${p.unrouted.length} 件 / 全て送信可: ${p.allReady}\n`);
for (const m of p.mails) {
  console.log(`=== ${m.dealerName} (${m.status}${m.blockedReason ? ": " + m.blockedReason : ""}) ===`);
  console.log(`宛先: ${m.to.length ? m.to.join(", ") : "(なし)"}`);
  console.log(`件名: ${m.subject}`);
  if (m.warnings.length) console.log(`警告: ${m.warnings.join(" / ")}`);
  console.log(`---\n${m.body}\n`);
}
for (const u of p.unrouted) console.log(`発注先未設定: レンズ${u.lineNo}(メールにしません)`);
console.log("\nメールは送信していません。何も変更していません。");
