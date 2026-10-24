// 注文者(orderers)・ディーラー(facilityDealers)のドキュメントから `active` フィールドを取り除く移行(medconf-iol-dev のみ)。
// 対象は --collection orderers(既定) / facilityDealers で指定する。コレクションごとに dry-run → 判断 → 実行を行う。
//
//   1) dry-run(既定。読み取りだけで、何も変更しない):
//        node scripts/admin/migrate-orderer-active.mjs
//   2) 無効(active=false)の注文者ごとに「残す / 削除」を決めて、もう一度 dry-run:
//        node scripts/admin/migrate-orderer-active.mjs --keep-inactive 施設ID/注文者ID --remove-inactive 施設ID/注文者ID
//   3) 実行(バックアップの書き出しと、プロジェクトIDの確認が必須):
//        node scripts/admin/migrate-orderer-active.mjs --keep-inactive … --remove-inactive … --execute --backup backups/orderers-YYYYMMDD.json --confirm medconf-iol-dev
//
// - 実行前に、全施設の注文者ドキュメント(生の値)を --backup のファイルへ書き出す(既にあるファイルには書かない)。
// - 各ドキュメントの更新・削除は、読み取り時点の updateTime が変わっていない場合だけ行う(途中で編集されていたら失敗する)。
// - 過去の注文(orders)に保存された注文者情報には触れない。利用者管理(members の status)にも触れない。
// - 実行後に再読み込みして、active が残っていないことを確認する。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PROJECT, buildPlan, parseMigrationArgs } from "./orderer-migration.mjs";

const args = parseMigrationArgs(process.argv.slice(2));
if (args.errors.length) {
  console.error(args.errors.map(e => "エラー: " + e).join("\n"));
  process.exit(2);
}
if (args.mode === "execute" && fs.existsSync(args.backup)) {
  console.error(`エラー: バックアップ先が既に存在します: ${args.backup}(上書きしません。別のファイル名を指定してください)`);
  process.exit(2);
}

const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
const headers = { Authorization: `Bearer ${token}`, "x-goog-user-project": PROJECT, "content-type": "application/json" };

const plain = (v) => {
  if (v === undefined) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  return JSON.stringify(v);
};

async function listAll(p) {
  const out = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ pageSize: "100" });
    if (pageToken) q.set("pageToken", pageToken);
    const r = await fetch(`${BASE}/${p}?${q}`, { headers });
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
    const j = await r.json();
    out.push(...(j.documents || []));
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

async function loadOrderers() {
  const res = [];
  for (const f of await listAll("facilities")) {
    const facilityId = f.name.split("/").pop();
    for (const d of await listAll(`facilities/${facilityId}/${args.collection}`)) {
      res.push({
        facilityId, id: d.name.split("/").pop(), updateTime: d.updateTime, raw: d,
        fields: Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, plain(v)]))
      });
    }
  }
  return res;
}

const orderers = await loadOrderers();
const plan = buildPlan(orderers, { keepInactive: args.keepInactive, removeInactive: args.removeInactive });

console.log(`対象: ${PROJECT} / ${args.collection}   モード: ${args.mode === "execute" ? "実行" : "dry-run(何も変更しません)"}\n`);
for (const o of orderers) {
  const f = o.fields;
  console.log(`  ${o.facilityId}/${o.id}  名前=${f.name}  メール=${f.email ?? "(なし)"}  active=${"active" in f ? f.active : "(なし=新形式)"}  並び=${f.sortOrder ?? "-"}`);
}
console.log("\n集計:", JSON.stringify(plan.summary));
if (plan.ops.length) {
  console.log("\n予定の操作:");
  for (const op of plan.ops) console.log(`  ${op.type === "delete" ? "削除        " : "active を除去"}  ${op.key}  (${op.name})`);
}
if (!plan.ok) {
  console.log("\n要対応:");
  plan.errors.forEach(e => console.log("  - " + e));
}

if (args.mode !== "execute") {
  console.log("\ndry-run のため、何も変更していません。");
  process.exit(plan.ok ? 0 : 1);
}
if (!plan.ok) { console.error("\n要対応の項目があるため、実行しません。"); process.exit(1); }

// ---- 実行 ----
fs.mkdirSync(path.dirname(path.resolve(args.backup)), { recursive: true });
fs.writeFileSync(args.backup, JSON.stringify({ project: PROJECT, takenAt: new Date().toISOString(), collection: args.collection, docs: orderers.map(o => o.raw) }, null, 2), { flag: "wx" });
console.log(`\nバックアップを書き出しました: ${args.backup} (${orderers.length}件)`);

for (const op of plan.ops) {
  const doc = `${BASE}/facilities/${op.facilityId}/${args.collection}/${op.id}`;
  const pre = `currentDocument.updateTime=${encodeURIComponent(op.updateTime)}`;
  const r = op.type === "delete"
    ? await fetch(`${doc}?${pre}`, { method: "DELETE", headers })
    : await fetch(`${doc}?updateMask.fieldPaths=active&${pre}`, { method: "PATCH", headers, body: JSON.stringify({ fields: {} }) });
  if (!r.ok) {
    console.error(`失敗: ${op.type} ${op.key}: HTTP ${r.status} ${await r.text()}`);
    console.error("途中で止めました。これまでの操作は取り消されません。バックアップを確認し、dry-run からやり直してください。");
    process.exit(1);
  }
  console.log(`完了: ${op.type === "delete" ? "削除" : "active を除去"}  ${op.key}`);
}

const after = await loadOrderers();
const left = after.filter(o => "active" in o.fields);
console.log(`\n確認: 注文者 ${after.length} 件、active が残っているもの ${left.length} 件`);
process.exit(left.length ? 1 : 0);
