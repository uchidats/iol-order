// 注文履歴の手術日順の索引(facilities/{施設ID}/orderSurgeryIndex)を、既存の注文から作る(medconf-iol-dev のみ)。
// 新しい注文の索引はトリガー(indexOrderSurgeryDates)が作る。これはトリガーより前の注文のためのもの。
//
//   1) dry-run(既定。読み取りだけで、何も変更しない):
//        node scripts/admin/backfill-order-surgery-index.mjs
//   2) 実行(作成だけ。既にある索引は上書きしない。作成したパスの一覧を backups/ に書き出す):
//        node scripts/admin/backfill-order-surgery-index.mjs --execute --confirm medconf-iol-dev
//
// - 注文・メール・その他のドキュメントは読み取るだけで変更しない。
// - 索引の中身は functions/src/order-surgery-index.js の surgeryIndexEntries(トリガーと同じ)。注文の論理削除の印も写す。
// - 作成は「存在しないこと」を条件にした書き込み(途中でトリガーが作った索引とは衝突しても上書きしない)。
// - 取り消すときは、書き出した一覧のパスを削除する(索引だけなので、注文には影響しない)。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { surgeryIndexEntries } from "../../functions/src/order-surgery-index.js";

const PROJECT = "medconf-iol-dev";
const argv = process.argv.slice(2);
const execute = argv.includes("--execute");
const ci = argv.indexOf("--confirm");
const unknown = argv.filter((a, i) => !["--execute", "--confirm"].includes(a) && !(ci >= 0 && i === ci + 1));
if (unknown.length) { console.error(`エラー: 不明な引数 ${unknown.join(" ")}`); process.exit(2); }
if (execute && argv[ci + 1] !== PROJECT) { console.error(`エラー: 実行には --confirm ${PROJECT} が必要です`); process.exit(2); }

const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
const headers = { Authorization: `Bearer ${token}`, "x-goog-user-project": PROJECT, "content-type": "application/json" };

/** REST の値 → JS の値(タイムスタンプは { __ts: ISO } のまま持つ) */
function plain(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return { __ts: v.timestampValue };
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(plain);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, plain(x)]));
  return null;
}
/** JS の値 → REST の値(索引で使う型だけ) */
function rest(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v && v.__ts) return { timestampValue: v.__ts };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (Number.isInteger(v)) return { integerValue: String(v) };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(rest) } };
  throw new Error(`索引に使えない値: ${JSON.stringify(v)}`);
}

async function listAll(p) {
  const out = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ pageSize: "100" });
    if (pageToken) q.set("pageToken", pageToken);
    const r = await fetch(`${BASE}/${p}?${q}`, { headers });
    if (r.status === 404) return out;
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
    const j = await r.json();
    out.push(...(j.documents || []));
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}
const idOf = (doc) => doc.name.split("/").pop();

const plan = [];
let orderCount = 0;
for (const fac of await listAll("facilities")) {
  const fid = idOf(fac);
  const existing = new Set((await listAll(`facilities/${fid}/orderSurgeryIndex`)).map(idOf));
  for (const o of await listAll(`facilities/${fid}/orders`)) {
    orderCount++;
    const order = plain({ mapValue: { fields: o.fields || {} } });
    for (const e of surgeryIndexEntries(fid, idOf(o), order)) {
      if (!existing.has(e.id)) plan.push({ path: `facilities/${fid}/orderSurgeryIndex/${e.id}`, data: e.data });
    }
  }
}
console.log(`注文 ${orderCount} 件。作成する索引 ${plan.length} 件(既にあるものは除く)。うち論理削除の印あり ${plan.filter(p => p.data.deleted).length} 件。`);
if (!execute) { console.log("確認のみ(書き込みなし)。作成するには --execute --confirm medconf-iol-dev を付けて実行してください。"); process.exit(0); }

fs.mkdirSync("backups", { recursive: true });
const out = path.join("backups", `order-surgery-index-created-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const created = [];
let skipped = 0;
try {
  for (const p of plan) {
    const fields = Object.fromEntries(Object.entries(p.data).map(([k, v]) => [k, rest(v)]));
    const r = await fetch(`${BASE.replace(/\/documents$/, "/documents:commit")}`, {
      method: "POST", headers,
      body: JSON.stringify({ writes: [{ update: { name: `projects/${PROJECT}/databases/(default)/documents/${p.path}`, fields }, currentDocument: { exists: false } }] })
    });
    if (r.ok) created.push(p.path);
    else if (r.status === 400 || r.status === 409) skipped++;   // 実行中にトリガーが作った(上書きしない)
    else throw new Error(`${p.path}: HTTP ${r.status}`);
  }
} finally {
  fs.writeFileSync(out, JSON.stringify({ project: PROJECT, created }, null, 2));
}
console.log(`作成 ${created.length} 件、既にあったため作成しなかった ${skipped} 件。作成したパスの一覧: ${out}`);
