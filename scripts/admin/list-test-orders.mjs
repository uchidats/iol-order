// 開発用受付で保存されたテスト注文(testOrder: true)を一覧するだけのスクリプト。【読み取り専用】何も変更・削除しない。
//   node scripts/admin/list-test-orders.mjs            (gcloud auth login 済みであること)
// 削除するかは、一覧を見てから人が判断する(削除用のコマンドは用意していない)。
import { execFileSync } from "node:child_process";

const PROJECT = "medconf-iol-dev"; // 開発環境のみ
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
const headers = { Authorization: `Bearer ${token}`, "x-goog-user-project": PROJECT };

async function listAll(path, mask = []) {
  const out = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ pageSize: "100" });
    mask.forEach(m => q.append("mask.fieldPaths", m));
    if (pageToken) q.set("pageToken", pageToken);
    const r = await fetch(`${BASE}/${path}?${q}`, { headers });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    const j = await r.json();
    out.push(...(j.documents || []));
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

const val = (f) => f && (f.stringValue ?? f.integerValue ?? f.booleanValue ?? f.timestampValue ?? null);

const facilities = await listAll("facilities", ["name"]);
let total = 0, tests = 0;
for (const f of facilities) {
  const fid = f.name.split("/").pop();
  for (const o of await listAll(`facilities/${fid}/orders`)) {
    total++;
    const isTest = o.fields.testOrder && o.fields.testOrder.booleanValue === true;
    if (!isTest) continue;
    tests++;
    const lines = (o.fields.lines?.arrayValue?.values || []).map(v => v.mapValue.fields);
    console.log(`${val(o.fields.orderNumber)}  facility=${fid}  orderId=${o.name.split("/").pop()}  status=${val(o.fields.status)}  lines=${lines.length}  total=${val(o.fields.totalQuantity)}  created=${val(o.fields.createdAt)}`);
    for (const l of lines) {
      const item = l.item.mapValue.fields;
      console.log(`    ${val(l.lineNo)}. ${val(item.displayName)} ${val(item.toricModel) || ""} ${val(item.power)} x${val(item.quantity)}  手術日 ${val(l.surgeryDate)}`);
    }
  }
}
console.log(`\n${PROJECT}: 注文 ${total} 件のうち、テスト注文(testOrder=true) ${tests} 件。何も変更していません。`);
