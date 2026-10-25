import test from "node:test";
import assert from "node:assert/strict";
import { findSelfDoctor } from "../src/domain/self-doctor.js";

const docs = [
  { id: "o1", name: "高橋", email: "Takahashi@Example.jp" },
  { id: "o2", name: "佐藤", email: "sato@example.jp" },
  { id: "o3", name: "山田" },                                // メール未登録
  { id: "o4", name: "田中", email: "tanaka@example.jp" },
  { id: "o5", name: "田中二郎", email: "TANAKA@example.jp" }  // 同じメールの医師が2人
];

test("本人の担当医: ログインアカウントのメールアドレスで紐づける(大文字小文字・全角半角の違いは同じ)", () => {
  assert.equal(findSelfDoctor(docs, { email: "takahashi@example.jp", emailVerified: true }), "o1");
  assert.equal(findSelfDoctor(docs, { email: "TAKAHASHI@EXAMPLE.JP" }), "o1");
  assert.equal(findSelfDoctor(docs, { email: "ｓａｔｏ＠example.jp", emailVerified: true }), "o2");
});

test("氏名だけでは判定しない: 氏名が同じでも、メールが違う・ないユーザーは紐づかない(CO・看護師・事務職員など)", () => {
  assert.equal(findSelfDoctor(docs, { email: "nurse@example.jp", emailVerified: true, displayName: "高橋" }), "");
  assert.equal(findSelfDoctor(docs, { displayName: "山田" }), "", "メールなし");
  assert.equal(findSelfDoctor(docs, { email: "", emailVerified: true }), "");
  assert.equal(findSelfDoctor(docs, null), "");
  assert.equal(findSelfDoctor(docs, undefined), "");
});

test("安全側: メール未確認のアカウント・同じメールの医師が複数いて決められない場合・担当医が未登録/空の施設は、初期値なし", () => {
  assert.equal(findSelfDoctor(docs, { email: "takahashi@example.jp", emailVerified: false }), "");
  assert.equal(findSelfDoctor(docs, { email: "tanaka@example.jp", emailVerified: true }), "", "あいまい");
  assert.equal(findSelfDoctor([], { email: "takahashi@example.jp" }), "");
  assert.equal(findSelfDoctor(undefined, { email: "takahashi@example.jp" }), "");
  assert.equal(findSelfDoctor([{ id: "x", name: "A" }], { email: "takahashi@example.jp" }), "", "メール未登録の医師だけ");
});
