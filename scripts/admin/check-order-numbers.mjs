// 注文番号の確認【読み取り専用】: 全施設の注文番号が重複していないか、全施設共通の連番に切り替えた日以降に
// 旧方式(施設ごとのカウンター)で採番された形跡がないかを調べる。何も変更・削除しない(GET のみ)。
//   node scripts/admin/check-order-numbers.mjs          (gcloud auth login 済みであること)
// 使う場面: 新しい createOrder の配備の直後と、切り替え日(GLOBAL_ORDER_NUMBER_FROM)の朝・最初の注文の後。
// 出力は件数と注文番号だけ(施設は F1, F2… に置き換え、施設名・利用者・明細は出さない)。問題があれば終了コード 1。
import { execFileSync } from "node:child_process";
import { GLOBAL_ORDER_NUMBER_FROM } from "../../functions/src/orders.js";

const PROJECT = "medconf-iol-dev";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
const headers = { Authorization: `Bearer ${token}`, "x-goog-user-project": PROJECT };

async function listAll(path, mask = []) {
  const out = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ pageSize: "300" });
    mask.forEach(m => q.append("mask.fieldPaths", m));
    if (pageToken) q.set("pageToken", pageToken);
    const r = await fetch(`${BASE}/${path}?${q}`, { method: "GET", headers });
    if (r.status === 404) return out;
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    const j = await r.json();
    out.push(...(j.documents || []));
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}
const val = (f) => f && (f.stringValue ?? f.integerValue ?? null);

const facilities = await listAll("facilities", ["status"]);
const alias = new Map(facilities.map((f, i) => [f.name.split("/").pop(), `F${i + 1}`]));
const byNumber = new Map();
const legacyAfter = [];
const maxSeqByGlobalDay = new Map();
let total = 0;
for (const f of facilities) {
  const fid = f.name.split("/").pop();
  for (const o of await listAll(`facilities/${fid}/orders`, ["orderNumber"])) {
    total++;
    const n = val(o.fields?.orderNumber);
    if (!n) continue;
    if (!byNumber.has(n)) byNumber.set(n, []);
    byNumber.get(n).push(alias.get(fid));
    const m = /^IOL-(\d{8})-(\d+)$/.exec(n);
    if (m && m[1] >= GLOBAL_ORDER_NUMBER_FROM) maxSeqByGlobalDay.set(m[1], Math.max(maxSeqByGlobalDay.get(m[1]) || 0, Number(m[2])));
  }
  // 切り替え日以降の日付の施設ごとのカウンター = 旧方式の createOrder がその日に動いた形跡
  for (const c of await listAll(`facilities/${fid}/orderCounters`, ["count"])) {
    const day = c.name.split("/").pop();
    if (day >= GLOBAL_ORDER_NUMBER_FROM) legacyAfter.push(`${alias.get(fid)} ${day} count=${val(c.fields?.count)}`);
  }
}
const globals = await listAll("orderNumberCounters", ["count"]);
const behind = globals.filter(g => Number(val(g.fields?.count) || 0) < (maxSeqByGlobalDay.get(g.name.split("/").pop()) || 0)).map(g => g.name.split("/").pop());
const dups = [...byNumber.entries()].filter(([, xs]) => xs.length > 1).map(([n, xs]) => `${n} ← ${xs.join(",")}`);

console.log(`切り替え日(共通の連番の開始): ${GLOBAL_ORDER_NUMBER_FROM}`);
console.log(`注文: ${total} 件 / 注文番号の種類: ${byNumber.size}`);
console.log(`重複している注文番号: ${dups.length} 件${dups.length ? "\n  " + dups.join("\n  ") : ""}`);
console.log(`切り替え日以降の施設ごとのカウンター(旧方式が動いた形跡): ${legacyAfter.length} 件${legacyAfter.length ? "\n  " + legacyAfter.join("\n  ") : ""}`);
console.log(`共通のカウンター: ${globals.length} 件(${globals.map(g => `${g.name.split("/").pop()}=${val(g.fields?.count)}`).join(", ") || "なし"})${behind.length ? ` / 発行済みの番号より小さい: ${behind.join(", ")}` : ""}`);
console.log("読み取りのみ。何も変更していません。");
process.exit(dups.length || legacyAfter.length || behind.length ? 1 : 0);
