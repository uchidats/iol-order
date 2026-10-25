import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setupAppCheck, APP_CHECK_SITE_KEY } from "../src/firebase/app-check.js";

const fakeModule = (calls) => ({
  ReCaptchaEnterpriseProvider: class { constructor(k) { this.key = k; } },
  initializeAppCheck: (app, opts) => calls.push([app, opts])
});

test("サイトキーが未設定の間は App Check を読み込まない・初期化しない(既存の動作のまま)", async () => {
  assert.equal(APP_CHECK_SITE_KEY, "", "サイトキーは Firebase Console に登録してから設定する");
  let loaded = false;
  assert.equal(await setupAppCheck({ app: {}, load: async () => { loaded = true; return {}; } }), "disabled");
  assert.equal(loaded, false);
});

test("サイトキーがあれば reCAPTCHA Enterprise で初期化し、トークンを自動更新する。localhost はデバッグトークン", async () => {
  const calls = [], g = {};
  assert.equal(await setupAppCheck({ app: { a: 1 }, siteKey: "KEY", load: async () => fakeModule(calls), hostname: "iol.medconf.jp", globalObj: g }), "enabled");
  assert.equal(calls[0][1].provider.key, "KEY");
  assert.equal(calls[0][1].isTokenAutoRefreshEnabled, true);
  assert.equal("FIREBASE_APPCHECK_DEBUG_TOKEN" in g, false, "公開サイトではデバッグトークンを使わない");
  await setupAppCheck({ app: {}, siteKey: "KEY", load: async () => fakeModule([]), hostname: "localhost", globalObj: g });
  assert.equal(g.FIREBASE_APPCHECK_DEBUG_TOKEN, true);
});

test("監視モード: 初期化に失敗しても例外にしない(ログイン・注文・施設管理を止めない)。Functions は App Check を強制しない", async () => {
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(await setupAppCheck({ app: {}, siteKey: "KEY", load: async () => { throw new Error("blocked"); } }), "failed"); }
  finally { console.warn = warn; }
  const index = fs.readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
  assert.match(index, /enforceAppCheck: false/);
  assert.doesNotMatch(index, /enforceAppCheck: true/);
});
