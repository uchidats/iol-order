// Git で追跡している環境ファイル(functions/.env.*)に、秘密の値・個人のメールアドレスが入っていないことを確かめる。
// リポジトリは公開されているので、追跡するファイルに書いた値は誰でも読める。秘密は Secret Manager(defineSecret)に置く。
// 見つけたときも、値は表示しない(ファイル名・行番号・種類だけ)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 値として書いてはいけない形式(種類の名前, 正規表現) */
const SECRET_PATTERNS = [
  ["秘密鍵(PEM)", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["サービスアカウントの鍵(JSON)", /"private_key"\s*:/],
  ["Resend の API キー", /\bre_[A-Za-z0-9_]{16,}/],
  ["Webhook の署名の鍵", /\bwhsec_[A-Za-z0-9+/=]{16,}/],
  ["GitHub のトークン", /\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ["Google の OAuth トークン", /\bya29\.[A-Za-z0-9_-]{20,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./],
  ["API キー(sk_ など)", /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/],
  ["AWS のアクセスキー", /\bAKIA[0-9A-Z]{16}\b/]
];
/** 名前が秘密を表す項目は、値を書かない(空だけ。値は Secret Manager に置く) */
const SECRET_NAME = /(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL|RECIPIENT)/;
/** 個人のメールアドレス(フリーメール)。運営者・利用者のアドレスをコメントや値に書かない */
const PERSONAL_MAIL = /[A-Za-z0-9._%+-]+@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|icloud|me|docomo|ezweb|softbank|au)\.[A-Za-z.]{2,}/i;

/** 環境ファイルの中身から、問題のある行を「行番号: 種類」で返す(値は含めない) */
export function findEnvProblems(text) {
  const problems = [];
  String(text).replace(/^﻿/, "").split(/\r?\n/).forEach((line, i) => {
    const at = (kind) => problems.push(`${i + 1}行目: ${kind}`);
    for (const [kind, re] of SECRET_PATTERNS) if (re.test(line)) at(kind);
    if (PERSONAL_MAIL.test(line)) at("個人のメールアドレス");
    if (/^\s*#/.test(line)) return;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m && SECRET_NAME.test(m[1].toUpperCase()) && m[2].trim().replace(/^["']|["']$/g, "") !== "") at(`秘密を表す名前の項目に値がある(${m[1]})`);
  });
  return problems;
}

const trackedEnvFiles = () => execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0").filter(f => /(^|\/)\.env(\.|$)/.test(f));

test("追跡している環境ファイル: 秘密の値・個人のメールアドレスを含まない(見つけても値は表示しない)", () => {
  const files = trackedEnvFiles();
  assert.deepEqual(files.sort(), ["functions/.env.demo-iol-e2e", "functions/.env.medconf-iol-dev"], "追跡する環境ファイルを増やすときは、内容が非機密であることを確かめて、ここに足す");
  const found = files.flatMap(f => findEnvProblems(readFileSync(join(ROOT, f), "utf8")).map(p => `${f} ${p}`));
  assert.equal(found.length, 0, `環境ファイルに書けない内容があります(値は表示しません):\n${found.join("\n")}`);
});

test("環境ファイルの検査: 鍵・トークン・個人のアドレス・秘密の名前の項目を見つけ、通常の設定は通す。結果に値を含めない", () => {
  const key = "re_" + "A1b2C3d4E5f6G7h8I9j0";
  const bad = [
    "MAIL_KEY=" + key,
    "# 連絡先 someone" + "@gmail.com",
    "X=-----BEGIN PRIVATE KEY-----",
    "STICKER_TICKET_SECRET=abc",
    "export DB_PASSWORD='p'",
    "HOOK=whsec_" + "abcdefghijklmnop1234"
  ].join("\r\n");
  const problems = findEnvProblems(bad);
  assert.deepEqual(problems.map(p => p.split(":")[0]), ["1行目", "2行目", "3行目", "4行目", "5行目", "6行目"]);
  assert.ok(!problems.join("\n").includes(key) && !problems.join("\n").includes("someone"), "値を含めない");
  const ok = [
    "# 注文受付の対象(許可リスト)",
    "RUNTIME_SERVICE_ACCOUNT=name@project-id.iam.gserviceaccount.com",
    "ORDER_INTAKE_ENABLED=true",
    "ORDER_TEST_UIDS=AbCdEfGhIjKlMnOpQrStUvWxYz12,AbCdEfGhIjKlMnOpQrStUvWxYz34",
    "MAIL_FROM=order@mail.example.jp",
    "MAIL_TEST_RECIPIENT=",
    "STICKER_PHOTO_BUCKET=project-sticker-photos",
    ""
  ].join("\n");
  assert.deepEqual(findEnvProblems(ok), []);
});
