// 移行前のバックアップJSONから、active(注文者・ディーラー)/ status・lastAuditId(所属)を復元する(medconf-iol-dev のみ)。
// 「旧Web・旧Rulesへ戻す」場合にだけ必要。新Web・新Rules・新Functionsのままなら、復元しなくても動く。
//
//   1) dry-run(既定。現在の値を読み取って、復元する内容を表示するだけ):
//        node scripts/admin/restore-from-backup.mjs --backup backups/orderers-YYYYMMDD.json
//   2) 実行:
//        node scripts/admin/restore-from-backup.mjs --backup backups/orderers-YYYYMMDD.json --execute --confirm medconf-iol-dev
//      削除済みのドキュメント(移行で削除した無効の注文者・削除した所属)も戻す場合は --recreate-deleted を付ける
//
// - 復元するのは active / status / lastAuditId だけ。他のフィールド(名前・メール・並び・role など)には触れない。
// - 更新は、読み取り時点の updateTime が変わっていない場合だけ。再作成は「存在しない場合だけ」。
// - バックアップ1ファイルにつき1種類(orderers / facilityDealers / members)。種類ごとに実行する。
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { PROJECT, readBackup, docPathOf, planRestore, parseRestoreArgs } from "./restore-plan.mjs";

const args = parseRestoreArgs(process.argv.slice(2));
if (args.errors.length) { console.error(args.errors.map(e => "エラー: " + e).join("\n")); process.exit(2); }
if (!fs.existsSync(args.backup)) { console.error(`エラー: バックアップが見つかりません: ${args.backup}`); process.exit(2); }
const bk = readBackup(JSON.parse(fs.readFileSync(args.backup, "utf8")));
if (bk.error) { console.error("エラー: " + bk.error); process.exit(2); }

const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
const headers = { Authorization: `Bearer ${token}`, "x-goog-user-project": PROJECT, "content-type": "application/json" };

const current = new Map();
for (const raw of bk.docs) {
  const p = docPathOf(raw);
  const r = await fetch(`${BASE}/${p}`, { headers });
  if (r.status === 404) current.set(p, null);
  else if (r.ok) current.set(p, await r.json());
  else { console.error(`読み取り失敗: ${p}: HTTP ${r.status}`); process.exit(1); }
}
const plan = planRestore(bk.kind, bk.docs, current, { recreateDeleted: args.recreateDeleted });

console.log(`対象: ${PROJECT} / ${bk.kind}  バックアップ: ${args.backup}  モード: ${args.mode === "execute" ? "実行" : "dry-run(何も変更しません)"}\n`);
for (const op of plan.ops) console.log(`  ${op.type === "recreate" ? "再作成" : "復元  "}  ${op.path}${op.fields ? "  [" + op.fields.join(", ") + "]" : ""}`);
for (const s of plan.skipped) console.log(`  (対象外) ${s}`);
plan.errors.forEach(e => console.log("  エラー: " + e));
if (args.mode !== "execute") { console.log("\ndry-run のため、何も変更していません。"); process.exit(plan.ok ? 0 : 1); }
if (!plan.ok) { console.error("エラーがあるため実行しません。"); process.exit(1); }

for (const op of plan.ops) {
  const url = op.type === "recreate"
    ? `${BASE}/${op.path}?currentDocument.exists=false`
    : `${BASE}/${op.path}?${op.fields.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&")}&currentDocument.updateTime=${encodeURIComponent(op.updateTime)}`;
  const r = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(op.body) });
  if (!r.ok) {
    console.error(`失敗: ${op.path}: HTTP ${r.status} ${await r.text()}`);
    console.error("途中で止めました。dry-run からやり直してください(完了済みの分は「対象外」になります)。");
    process.exit(1);
  }
  console.log(`完了: ${op.type === "recreate" ? "再作成" : "復元"}  ${op.path}`);
}
