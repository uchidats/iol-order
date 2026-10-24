// 公開サイトが、手元(コミット済み)の index.html と同じバージョンを配信していることを確認する(読み取りのみ)。
//   node scripts/verify-deployed.mjs                          … https://iol.medconf.jp/ を1回確認
//   node scripts/verify-deployed.mjs --wait 20 --interval 30  … 一致するまで30秒おきに最大20回確認
//   node scripts/verify-deployed.mjs --url https://example/   … URLを指定
// 比較するのは、index.html の import map(各JSの ?v=ハッシュ)と、styles.css・main.js の ?v=。キャッシュを避けるため毎回クエリを付けて取得する。
// 一致 = 終了コード0。不一致・取得失敗 = 終了コード1(移行に進まない)。
import fs from "node:fs";

const DEFAULT_URL = "https://iol.medconf.jp/";

/** index.html から、バージョン情報(import map と styles.css / main.js の ?v=)を取り出す */
export function extractStamp(html) {
  const text = String(html).replace(/\r\n/g, "\n");
  const m = text.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  let imports = {};
  try { imports = m ? JSON.parse(m[1]).imports || {} : {}; } catch { imports = {}; }
  const v = (re) => (text.match(re) || [])[1] || "";
  return { imports, css: v(/href="styles\.css\?v=([0-9a-f]+)"/), main: v(/src="src\/main\.js\?v=([0-9a-f]+)"/) };
}

/** 手元と公開版の差。空なら一致 */
export function diffStamps(local, remote) {
  const out = [];
  if (!Object.keys(remote.imports).length) out.push("公開版に import map がありません(旧版、または取得できていません)");
  if (local.css !== remote.css) out.push(`styles.css: 手元 ${local.css || "(なし)"} / 公開 ${remote.css || "(なし)"}`);
  if (local.main !== remote.main) out.push(`main.js: 手元 ${local.main || "(なし)"} / 公開 ${remote.main || "(なし)"}`);
  for (const k of new Set([...Object.keys(local.imports), ...Object.keys(remote.imports)])) {
    if (local.imports[k] !== remote.imports[k]) out.push(`${k}: 手元 ${local.imports[k] || "(なし)"} / 公開 ${remote.imports[k] || "(なし)"}`);
  }
  return out;
}

export function parseVerifyArgs(argv) {
  const a = { url: DEFAULT_URL, wait: 1, interval: 30, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i], val = () => argv[++i];
    if (t === "--url") a.url = String(val() || "");
    else if (t === "--wait") a.wait = Number(val());
    else if (t === "--interval") a.interval = Number(val());
    else a.errors.push(`不明な引数: ${t}`);
  }
  if (!/^https:\/\//.test(a.url)) a.errors.push("--url は https:// で始まる必要があります");
  if (!(a.wait >= 1 && a.wait <= 120)) a.errors.push("--wait は 1〜120");
  if (!(a.interval >= 1 && a.interval <= 600)) a.errors.push("--interval は 1〜600(秒)");
  return a;
}

async function main() {
  const args = parseVerifyArgs(process.argv.slice(2));
  if (args.errors.length) { console.error(args.errors.map(e => "エラー: " + e).join("\n")); process.exit(2); }
  const local = extractStamp(fs.readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  let diffs = [];
  for (let n = 1; n <= args.wait; n++) {
    try {
      const r = await fetch(`${args.url}?_=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
      diffs = r.ok ? diffStamps(local, extractStamp(await r.text())) : [`HTTP ${r.status}`];
    } catch (e) { diffs = [`取得に失敗: ${e.message}`]; }
    if (!diffs.length) { console.log(`一致: ${args.url} は手元と同じバージョンを配信しています(${n}回目)`); process.exit(0); }
    console.log(`[${n}/${args.wait}] 不一致 ${diffs.length} 件。${diffs.slice(0, 3).join(" / ")}`);
    if (n < args.wait) await new Promise(r => setTimeout(r, args.interval * 1000));
  }
  console.error("公開版が手元と一致しませんでした。移行には進まないでください。");
  process.exit(1);
}
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) await main();
