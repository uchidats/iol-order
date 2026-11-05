// stickerEntryApi(ログインなしの確認)の CORS。functions/index.js の実際の関数に、事前確認(OPTIONS)を直接渡して確かめる。
// Functions エミュレータは CORS を常に全許可にするので、エミュレータの E2E ではなくここで確かめる。
// CORS はブラウザの読み取りの制限で、認可ではない(コード・回数制限・チケットの確認は tests/functions/sticker-photo.test.js)。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const INDEX = new URL("../../functions/index.js", import.meta.url).href;
const CWD = fileURLToPath(new URL("../../functions/", import.meta.url));

/** 別のプロセスで functions/index.js を読み、各オリジンの事前確認の応答(許可のヘッダー)を返す。本番と同じ判定にするため、プロジェクト名を渡す */
function preflight(project, origins) {
  const code = `
    const m = await import(${JSON.stringify(INDEX)});
    const out = {};
    for (const origin of ${JSON.stringify(origins)}) {
      const headers = {};
      const res = { statusCode: 0, on: () => res, setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, getHeader: (k) => headers[k.toLowerCase()], end: () => {} };
      const done = new Promise((resolve) => { res.end = resolve; });
      m.stickerEntryApi({ method: "OPTIONS", on: () => {}, header(n) { return this.headers[n.toLowerCase()]; }, headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } }, res);
      await done;
      out[origin] = { status: res.statusCode, allow: headers["access-control-allow-origin"] ?? null, methods: headers["access-control-allow-methods"] ?? null };
    }
    console.log("RESULT" + JSON.stringify(out));
    process.exit(0);`;
  const env = { ...process.env, GCLOUD_PROJECT: project, GCP_PROJECT: project, FIREBASE_CONFIG: JSON.stringify({ projectId: project }) };
  delete env.FIREBASE_DEBUG_FEATURES;   // エミュレータの「CORS を全許可」を使わない
  delete env.FUNCTIONS_EMULATOR;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: CWD, env, encoding: "utf8", timeout: 60000 });
  const line = String(r.stdout || "").split("\n").find(l => l.startsWith("RESULT"));
  assert.ok(line, "関数を読み込めません: " + String(r.stderr || "").slice(0, 400));
  return JSON.parse(line.slice(6));
}

const SITE = "https://iol.medconf.jp";
const OTHERS = ["https://evil.example", "https://iol.medconf.jp.evil.example", "http://iol.medconf.jp", "https://medconf.jp", "null"];

test("stickerEntryApi の CORS: 本番は正規のオリジンだけを許可する(手元の 127.0.0.1 も許可しない)", () => {
  const r = preflight("iol-cors-check", [SITE, "http://127.0.0.1:5173", ...OTHERS]);
  assert.deepEqual([r[SITE].allow, r[SITE].status], [SITE, 204]);
  assert.match(String(r[SITE].methods), /POST/, "撮影画面の要求(POST)が通る");
  // 許可するオリジンが1つのとき、応答の許可のヘッダーは要求によらず正規のオリジンに固定される(ほかのオリジンのページは、自分と一致しないので読めない)。
  // 要求のオリジンをそのまま返すこと・「*」を返すことがないことを確かめる
  for (const origin of ["http://127.0.0.1:5173", ...OTHERS]) {
    assert.ok(r[origin].allow === null || r[origin].allow === SITE, origin + " → " + r[origin].allow);
    assert.notEqual(r[origin].allow, origin);
    assert.notEqual(r[origin].allow, "*");
  }
});

test("stickerEntryApi の CORS: エミュレータ(demo- のプロジェクト)では 127.0.0.1 も許可し、ほかは許可しない", () => {
  const r = preflight("demo-iol-cors", [SITE, "http://127.0.0.1:5173", "http://localhost:5173", ...OTHERS]);
  assert.equal(r[SITE].allow, SITE);
  assert.equal(r["http://127.0.0.1:5173"].allow, "http://127.0.0.1:5173");
  for (const origin of ["http://localhost:5173", ...OTHERS]) assert.equal(r[origin].allow, null, origin);
});
