import test from "node:test";
import assert from "node:assert/strict";
import { draftKey, buildDraft, parseDraft, isEmptyDraft, sanitizeLineState, DRAFT_MAX_AGE_MS } from "../src/domain/order-draft.js";

const NOW = Date.parse("2026-10-25T00:00:00Z");
const line = (over = {}) => ({ toric: false, multifocal: false, modelKey: "jj-dib00v", power: "+20.0D", quantity: 1, date: "2026-11-10", doctorId: "o1", dealerId: "", ...over });

test("保存キーは、ログインユーザー・施設ごとに別(他の人・他の施設の下書きは読まない)", () => {
  assert.notEqual(draftKey("u1", "fA"), draftKey("u2", "fA"));
  assert.notEqual(draftKey("u1", "fA"), draftKey("u1", "fB"));
  assert.match(draftKey("u1", "fA"), /^iol-order-draft:v1:u1:fA$/);
});

test("保存するのは選んだ値だけ: 不明な項目(認証情報・患者情報のような余計な項目)は捨てる。値の型・長さも制限する", () => {
  const d = buildDraft({ now: NOW, notes: "備考", lines: [{ ...line(), token: "SECRET", idToken: "x", patientName: "山田太郎", email: "a@example.jp", displayName: "ログイン太郎" }] });
  const json = JSON.stringify(d);
  assert.ok(!/SECRET|山田太郎|a@example\.jp|ログイン太郎|token/i.test(json), json);
  assert.deepEqual(Object.keys(d).sort(), ["lines", "notes", "savedAt", "v"]);
  assert.deepEqual(Object.keys(d.lines[0]).sort(), ["date", "dealerId", "doctorId", "modelKey", "multifocal", "power", "quantity", "quantityManual", "toric"]);
  assert.equal(sanitizeLineState({ quantity: 1, quantityManual: true }).quantityManual, true, "利用者が変えた枚数の記録は保つ");
  assert.equal(sanitizeLineState({ quantity: 1, quantityManual: "yes" }).quantityManual, false);
  const bad = sanitizeLineState({ quantity: 7, date: "2026/11/10", doctorId: "../evil", dealerId: "x y", modelKey: "m".repeat(500), power: 5, toric: "yes" });
  assert.deepEqual(bad, { toric: false, multifocal: false, modelKey: "m".repeat(200), power: "", quantity: 1, quantityManual: false, date: "", doctorId: "", dealerId: "" });
  assert.equal(buildDraft({ now: NOW, lines: Array(30).fill(line()), notes: "あ".repeat(5000) }).lines.length, 20);
  assert.equal(buildDraft({ now: NOW, lines: [line()], notes: "あ".repeat(5000) }).notes.length, 1000);
});

test("読み込み: 往復できる。壊れている・版が違う・古い・未来すぎる・明細なしの下書きは捨てる", () => {
  const d = buildDraft({ now: NOW, notes: "メモ\n2行目", lines: [line(), line({ toric: true, modelKey: "jj-diwxxx-toric|DIW300", quantity: 2 })] });
  assert.deepEqual(parseDraft(JSON.stringify(d), NOW + 1000), d);
  assert.equal(parseDraft("not json", NOW), null);
  assert.equal(parseDraft("null", NOW), null);
  assert.equal(parseDraft(JSON.stringify({ ...d, v: 99 }), NOW), null);
  assert.equal(parseDraft(JSON.stringify({ ...d, lines: "x" }), NOW), null);
  assert.equal(parseDraft(JSON.stringify({ ...d, lines: [] }), NOW), null);
  assert.equal(parseDraft(JSON.stringify(d), NOW + DRAFT_MAX_AGE_MS + 1), null, "14日より古い");
  assert.equal(parseDraft(JSON.stringify({ ...d, savedAt: NOW + 3 * 24 * 3600 * 1000 }), NOW), null, "未来の日時");
});

test("実質的に空か: 担当医の初期値・枚数の既定(1枚)だけでは入力ありにしない。備考・複数のレンズ・モデル/度数/手術日/2枚は入力あり", () => {
  const empty = line({ modelKey: "", power: "", date: "", doctorId: "o1" });
  assert.equal(isEmptyDraft(buildDraft({ now: NOW, lines: [empty], notes: "" })), true);
  assert.equal(isEmptyDraft(buildDraft({ now: NOW, lines: [empty], notes: "   " })), true);
  assert.equal(isEmptyDraft(buildDraft({ now: NOW, lines: [empty], notes: "備考" })), false);
  assert.equal(isEmptyDraft(buildDraft({ now: NOW, lines: [empty, empty], notes: "" })), false);
  for (const over of [{ modelKey: "x" }, { power: "+1.0D" }, { date: "2026-11-10" }, { quantity: 2 }, { toric: true }, { multifocal: true }]) {
    assert.equal(isEmptyDraft(buildDraft({ now: NOW, lines: [{ ...empty, ...over }], notes: "" })), false, JSON.stringify(over));
  }
  assert.equal(isEmptyDraft(null), true);
});
