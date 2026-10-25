import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { BIOMETRY_FIELDS } from "../src/biometry/state.js";
import { parseBiometryText } from "../src/biometry/parser.js";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

test("OCR は一時停止: Tesseract.js を外部CDNから読み込まない。読み取りの画面は非表示", () => {
  assert.doesNotMatch(html, /<script[^>]*tesseract/i);
  assert.doesNotMatch(html, /<script[^>]+src="https?:\/\//, "外部のスクリプトを読み込まない");
  assert.match(html, /<section class="feature-card future-feature" id="ocrFeatureCard" hidden>/);
  assert.match(fs.readFileSync(new URL("../src/biometry/biometry-ui.js", import.meta.url), "utf8"), /export const BIOMETRY_OCR_ENABLED = false;/);
  assert.match(main, /if \(BIOMETRY_OCR_ENABLED\) initBiometry\(\);/);
});

test("患者名の入力欄・抽出はない(注文に不要な患者情報を扱わない)", () => {
  assert.doesNotMatch(html, /患者名|ocrPatientName|patientName/);
  assert.ok(!BIOMETRY_FIELDS.some(f => f.key === "patientName"));
  const r = parseBiometryText("Name: YAMADA TARO\nAL 24.12", 90);
  assert.equal("patientName" in r, false);
  assert.equal(r.al.value, 24.12);
});

test("完了画面の初期の文言に、旧Googleスプレッドシート・控えメールの記述が残っていない", () => {
  assert.doesNotMatch(html, /スプレッドシート|控えが送信|Google ?Form/);
});

test("Firebase の設定がない場合は静的モードにせず、エラーを表示する(固定データを使わない)", () => {
  assert.doesNotMatch(main, /createStaticRepository|DEFAULT_FACILITY_ID/);
  assert.match(main, /if \(!isFirebaseConfigured\(FIREBASE_CONFIG\)\) \{\s*showFatal\(/);
  const repo = fs.readFileSync(new URL("../src/data/static-repository.js", import.meta.url), "utf8");
  assert.doesNotMatch(repo, /立川|ORDERER_NAMES|createStaticRepository/);
});
