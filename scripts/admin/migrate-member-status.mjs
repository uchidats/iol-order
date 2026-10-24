// 所属(members)の `status` フィールドを廃止するための移行(medconf-iol-dev のみ)。手順の全体は docs/member-status-removal.md。
//
//   dry-run(既定。読み取りだけで、何も変更しない):
//     node scripts/admin/migrate-member-status.mjs --phase 1
//     node scripts/admin/migrate-member-status.mjs --phase 2
//   phase 1: 無効(disabled)の所属ごとに「削除 / 明示的に有効へ戻す」を決める(新Rules・新画面のデプロイ前)
//     node scripts/admin/migrate-member-status.mjs --phase 1 --remove-disabled 施設ID/uid --restore-disabled 施設ID/uid \
//          --execute --backup backups/members-YYYYMMDD.json --confirm medconf-iol-dev
//   phase 2: 残った所属から status / lastAuditId を取り除く(新Rules・新画面のデプロイ後)
//     node scripts/admin/migrate-member-status.mjs --phase 2 --execute --backup backups/members-after.json --confirm medconf-iol-dev
//
// - role(管理者/注文者)には一切触れない。有効(active)の所属を無効にしたり、無効の所属を勝手に有効にしたりしない。
// - 実行前に全施設の所属ドキュメント(生の値)を --backup のファイルへ書き出す(既にあるファイルには書かない)。
// - 各ドキュメントの更新・削除は、読み取り時点の updateTime が変わっていない場合だけ行う。
// - 過去の操作履歴(auditLogs)・招待・注文には触れない。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PROJECT, buildMemberPlan, parseMemberArgs } from "./member-migration.mjs";

const args = parseMemberArgs(process.argv.slice(2));
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
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
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

async function loadMembers() {
  const res = [];
  for (const f of await listAll("facilities")) {
    const facilityId = f.name.split("/").pop();
    for (const d of await listAll(`facilities/${facilityId}/members`)) {
      res.push({
        facilityId, id: d.name.split("/").pop(), updateTime: d.updateTime, raw: d,
        fields: Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, plain(v)]))
      });
    }
  }
  return res;
}

const members = await loadMembers();
const plan = buildMemberPlan(members, { phase: args.phase, removeDisabled: args.removeDisabled, restoreDisabled: args.restoreDisabled });

console.log(`対象: ${PROJECT}   phase ${args.phase}   モード: ${args.mode === "execute" ? "実行" : "dry-run(何も変更しません)"}\n`);
for (const m of members) {
  const f = m.fields;
  console.log(`  ${m.facilityId}/${m.id}  role=${f.role}  名前=${f.displayName ?? "-"}  status=${"status" in f ? f.status : "(なし)"}  lastAuditId=${"lastAuditId" in f ? f.lastAuditId : "(なし)"}`);
}
console.log("\n集計:", JSON.stringify(plan.summary));
if (plan.ops.length) {
  console.log("\n予定の操作:");
  for (const op of plan.ops) {
    const what = op.type === "delete" ? "所属を削除        " : op.type === "restore" ? "明示的に有効に戻す" : `フィールド除去 ${op.fields.join(",")}`;
    console.log(`  ${what}  ${op.key}  (role=${op.role})`);
  }
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
fs.writeFileSync(args.backup, JSON.stringify({ project: PROJECT, phase: args.phase, takenAt: new Date().toISOString(), members: members.map(m => m.raw) }, null, 2), { flag: "wx" });
console.log(`\nバックアップを書き出しました: ${args.backup} (${members.length}件)`);

for (const op of plan.ops) {
  const doc = `${BASE}/facilities/${op.facilityId}/members/${op.id}`;
  const pre = `currentDocument.updateTime=${encodeURIComponent(op.updateTime)}`;
  let r;
  if (op.type === "delete") r = await fetch(`${doc}?${pre}`, { method: "DELETE", headers });
  else if (op.type === "restore") r = await fetch(`${doc}?updateMask.fieldPaths=status&${pre}`, { method: "PATCH", headers, body: JSON.stringify({ fields: { status: { stringValue: "active" } } }) });
  else r = await fetch(`${doc}?${op.fields.map(f => `updateMask.fieldPaths=${f}`).join("&")}&${pre}`, { method: "PATCH", headers, body: JSON.stringify({ fields: {} }) });
  if (!r.ok) {
    console.error(`失敗: ${op.type} ${op.key}: HTTP ${r.status} ${await r.text()}`);
    console.error("途中で止めました。これまでの操作は取り消されません。バックアップを確認し、dry-run からやり直してください。");
    process.exit(1);
  }
  console.log(`完了: ${op.type}  ${op.key}`);
}

const after = await loadMembers();
if (args.phase === 2) {
  const left = after.filter(m => "status" in m.fields || "lastAuditId" in m.fields);
  console.log(`\n確認: 所属 ${after.length} 件、status / lastAuditId が残っているもの ${left.length} 件`);
  process.exit(left.length ? 1 : 0);
}
console.log(`\n確認: 所属 ${after.length} 件、無効(disabled)のまま残っているもの ${after.filter(m => m.fields.status === "disabled").length} 件`);
process.exit(after.some(m => m.fields.status === "disabled") ? 1 : 0);
