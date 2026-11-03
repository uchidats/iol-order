// 全施設共通の注文番号のカウンター(orderNumberCounters/{yyyymmdd})の初期値を確かめ、必要なら設定する。
//   node scripts/admin/seed-order-number-counter.mjs [YYYYMMDD]           確認のみ(既定。何も書き込まない)
//   node scripts/admin/seed-order-number-counter.mjs [YYYYMMDD] --apply   必要なときだけ設定(gcloud auth login 済みであること)
// 日付を省略すると、日本時間の今日。重複しない初期値 = その日の「全施設の施設ごとのカウンター」と「発行済みの注文番号の連番」の最大値。
// 共通のカウンターがすでにそれ以上なら何もしない(下げることはしない)。既存の注文・注文番号・施設ごとのカウンターは変更しない。
// --apply で書き込む前に、共通のカウンターの現在の内容を backups/ に保存する(存在しなければ「なし」を記録)。
// 書き込みは、読んだ時点から変わっていないこと(更新時刻・存在しないこと)を条件にする(createOrder と同時でも上書きしない)。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jstDate } from "../../functions/src/orders.js";

const PROJECT = "medconf-iol-dev";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOCS = `projects/${PROJECT}/databases/(default)/documents`;
const BASE = `https://firestore.googleapis.com/v1/${DOCS}`;
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const day = args.find(a => /^\d{8}$/.test(a)) || jstDate(Date.now()).replace(/-/g, "");
const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
const headers = { Authorization: `Bearer ${token}`, "x-goog-user-project": PROJECT, "Content-Type": "application/json" };

async function listAll(p, mask = []) {
  const out = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ pageSize: "300" });
    mask.forEach(m => q.append("mask.fieldPaths", m));
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
const num = (f) => Number(f && (f.integerValue ?? f.doubleValue) || 0);

let legacyMax = 0, seqMax = 0, ordersToday = 0;
for (const f of await listAll("facilities", ["status"])) {
  const fid = f.name.split("/").pop();
  const r = await fetch(`${BASE}/facilities/${fid}/orderCounters/${day}`, { headers });
  if (r.ok) legacyMax = Math.max(legacyMax, num((await r.json()).fields?.count));
  for (const o of await listAll(`facilities/${fid}/orders`, ["orderNumber"])) {
    const m = /^IOL-(\d{8})-(\d+)$/.exec(o.fields?.orderNumber?.stringValue || "");
    if (m && m[1] === day) { ordersToday++; seqMax = Math.max(seqMax, Number(m[2])); }
  }
}
const g = await fetch(`${BASE}/orderNumberCounters/${day}`, { headers });
const current = g.ok ? await g.json() : null;
if (!g.ok && g.status !== 404) throw new Error(`orderNumberCounters/${day}: HTTP ${g.status}`);
const currentCount = current ? num(current.fields?.count) : 0;
const needed = Math.max(legacyMax, seqMax);

console.log(`日付: ${day}(日本時間)`);
console.log(`その日の注文: ${ordersToday} 件 / 発行済みの連番の最大: ${seqMax} / 施設ごとのカウンターの最大: ${legacyMax}`);
console.log(`重複しない初期値: ${needed}(次の注文は ${needed + 1} 番から)`);
console.log(`共通のカウンター: ${current ? `count=${currentCount}` : "なし(初期値 0 と同じ)"}`);
if (currentCount >= needed) {
  console.log("設定は不要です(共通のカウンターはすでに重複しない値)。何も変更していません。");
  process.exit(0);
}
if (!apply) {
  console.log(`--apply で共通のカウンターを count=${needed} にします(確認のみ。何も変更していません)。`);
  process.exit(0);
}
// バックアップ(共通のカウンターの現在の内容)
const dir = path.join(ROOT, "backups");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `orderNumberCounters-${day}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify({ path: `orderNumberCounters/${day}`, document: current }, null, 2));
const precondition = current ? { updateTime: current.updateTime } : { exists: false };
const body = { writes: [{ update: { name: `${DOCS}/orderNumberCounters/${day}`, fields: { count: { integerValue: String(needed) }, day: { stringValue: day } } },
  updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }], currentDocument: precondition }] };
const w = await fetch(`${BASE}:commit`, { method: "POST", headers, body: JSON.stringify(body) });
if (!w.ok) throw new Error(`書き込みに失敗しました(HTTP ${w.status})。読んだ後に変わった可能性があります。もう一度確認してください`);
console.log(`共通のカウンターを count=${needed} にしました。バックアップ: ${path.relative(ROOT, file)}`);
