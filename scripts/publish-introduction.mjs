// サービス紹介「IOL Orderについて」の本文を、原稿から Firestore(platformContent/serviceIntroduction)へ登録する。
//   node scripts/publish-introduction.mjs            … 確認だけ(既定。書き込まない): 原稿の文字数・章・登録済みの内容との差
//   node scripts/publish-introduction.mjs --apply    … 登録する(登録済みの内容を backups/ に保存してから上書き)
//   --file <path> で原稿を指定(既定 docs/introduction/service-introduction-web.md)
//
// 原稿の正式な管理元は docs/introduction/service-introduction-web.md(git には入れない。公開サイトはリポジトリのファイルを
// そのまま配信するため、入れると誰でも読めてしまう)。画面は Firestore の本文を読み、Rules で platformAdmin だけが読める。
// 書き込みは gcloud でログインした運営者の権限(REST)で行う。サービスアカウントの鍵は使わない。対象は medconf-iol-dev のみ。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseMarkdown, inlineText } from "../src/manual/markdown.js";

const PROJECT = "medconf-iol-dev";
const DOC_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/platformContent/serviceIntroduction`;
const DEFAULT_FILE = "docs/introduction/service-introduction-web.md";
const MAX_BYTES = 200 * 1024;   // Firestore の文書の上限(1MB)より十分小さく

/** 原稿から登録内容を作る(検証つき)。章 = 見出し(##) */
export function buildIntroductionPayload(markdown, sourceFile = path.basename(DEFAULT_FILE)) {
  const text = String(markdown ?? "").replace(/\r\n?/g, "\n");
  const errors = [];
  if (!text.trim()) errors.push("原稿が空です");
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) errors.push(`原稿が大きすぎます(${MAX_BYTES} バイトまで)`);
  const blocks = parseMarkdown(text);
  const chapters = blocks.filter(b => b.type === "heading" && b.level === 2).map(b => inlineText(b.children));
  const title = (blocks.find(b => b.type === "heading" && b.level === 1) || {}).children;
  return {
    errors,
    chapters,
    title: title ? inlineText(title) : "",
    details: blocks.filter(b => b.type === "details").length,
    data: { markdown: text, sha256: createHash("sha256").update(text).digest("hex"), sourceFile }
  };
}

const fieldsOf = (d) => ({
  markdown: { stringValue: d.markdown },
  sha256: { stringValue: d.sha256 },
  sourceFile: { stringValue: d.sourceFile },
  updatedAt: { timestampValue: new Date().toISOString() },
  updatedBy: { stringValue: "scripts/publish-introduction.mjs" }
});

async function main(argv) {
  const apply = argv.includes("--apply");
  const fi = argv.indexOf("--file");
  const file = fi >= 0 ? argv[fi + 1] : DEFAULT_FILE;
  const unknown = argv.filter((a, i) => a !== "--apply" && a !== "--file" && !(fi >= 0 && i === fi + 1));
  if (unknown.length) throw new Error(`不明な引数: ${unknown.join(" ")}`);
  const p = buildIntroductionPayload(fs.readFileSync(file, "utf8"), path.basename(file));
  console.log(`原稿: ${file} / ${p.data.markdown.length} 文字 / sha256 ${p.data.sha256.slice(0, 12)}…`);
  console.log(`題名: ${p.title}`);
  console.log(`章(${p.chapters.length}): ${p.chapters.join(" / ")}`);
  console.log(`折りたたみ: ${p.details} 件`);
  if (p.errors.length) throw new Error(p.errors.join("、"));

  const token = execFileSync("gcloud auth print-access-token", { encoding: "utf8", shell: true }).trim();
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const cur = await fetch(DOC_URL, { headers: H });
  if (cur.status !== 200 && cur.status !== 404) throw new Error(`登録済みの内容を確認できません(HTTP ${cur.status})`);
  const existing = cur.status === 200 ? await cur.json() : null;
  const remoteSha = existing && existing.fields && existing.fields.sha256 ? existing.fields.sha256.stringValue : null;
  console.log(existing ? `登録済み: sha256 ${String(remoteSha).slice(0, 12)}…(${remoteSha === p.data.sha256 ? "原稿と同じ" : "原稿と異なる"})` : "登録済み: なし");
  if (remoteSha === p.data.sha256) { console.log("変更なし。書き込みません。"); return; }
  if (!apply) { console.log("確認のみ(書き込みなし)。登録するには --apply を付けて実行してください。"); return; }

  if (existing) {
    fs.mkdirSync("backups", { recursive: true });
    const out = path.join("backups", `platform-content-serviceIntroduction-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(out, JSON.stringify(existing, null, 2));
    console.log(`バックアップ: ${out}`);
  }
  const r = await fetch(DOC_URL, { method: "PATCH", headers: H, body: JSON.stringify({ fields: fieldsOf(p.data) }) });
  if (!r.ok) throw new Error(`登録に失敗しました(HTTP ${r.status})`);
  const saved = await r.json();
  console.log(`登録しました: sha256 ${saved.fields.sha256.stringValue.slice(0, 12)}…`);
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  main(process.argv.slice(2)).catch(e => { console.error(String(e.message || e)); process.exit(1); });
}
