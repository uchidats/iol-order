// デプロイ・エミュレータ設定の整合性(実環境・エミュレータには接続しない)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
const firebase = read("firebase.json");
const fnPkg = read("functions/package.json");

test("Node.js: functions/package.json の engines と firebase.json の runtime が一致し、廃止済みの 20 以前ではない", () => {
  const major = Number(fnPkg.engines.node);
  const fn = firebase.functions.find((f) => f.codebase === "default");
  assert.equal(fn.runtime, `nodejs${major}`);
  assert.ok(major >= 22);
});

test("エミュレータのポートは重複せず、ローカルWebサーバーの一般的なポートと競合しない", () => {
  const ports = Object.values(firebase.emulators).filter((e) => e.port).map((e) => e.port);
  assert.equal(new Set(ports).size, ports.length);
  // http-server(8080) / serve(3000) / VS Code Live Server(5500) / python -m http.server(8000) / Firebase Hosting(5000) / Vite(5173)
  const webServerPorts = [3000, 5000, 5173, 5500, 8000, 8080, 8081, 8888];
  for (const p of ports) assert.ok(!webServerPorts.includes(p), `port ${p} conflicts with a local web server`);
  for (const e of Object.values(firebase.emulators)) if (e.host) assert.equal(e.host, "127.0.0.1");
});

test("関数は専用サービスアカウントで実行する(既定のサービスアカウントにフォールバックしない)", () => {
  const src = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
  assert.match(src, /serviceAccount\s*[:,]/);
  assert.match(src, /iol-functions-dev@medconf-iol-dev\.iam\.gserviceaccount\.com/);
});
