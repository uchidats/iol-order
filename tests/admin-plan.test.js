import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, buildPlan, ALLOWED_PROJECT } from "../scripts/admin/plan.mjs";

const UID = "a".repeat(28);
const plan = (...argv) => buildPlan(parseArgs(argv));

test("既定は dry-run（--apply なしでは書き込まない）", () => {
  const r = plan("grant-platform-admin", "--uid", UID);
  assert.equal(r.ok, true);
  assert.equal(r.plan.apply, false);
});

test("--apply には対象UIDの再入力(--confirm-uid)が必須", () => {
  assert.equal(plan("grant-platform-admin", "--uid", UID, "--apply").ok, false);
  assert.equal(plan("grant-platform-admin", "--uid", UID, "--apply", "--confirm-uid", "b".repeat(28)).ok, false);
  const r = plan("grant-platform-admin", "--uid", UID, "--apply", "--confirm-uid", UID);
  assert.equal(r.ok, true);
  assert.equal(r.plan.apply, true);
});

test("施設作成の --apply には --confirm-facility-id が必須", () => {
  const base = ["create-facility", "--facility-id", "demo-clinic", "--facility-name", "デモ施設"];
  assert.equal(plan(...base, "--apply").ok, false);
  assert.equal(plan(...base, "--apply", "--confirm-facility-id", "other").ok, false);
  assert.equal(plan(...base, "--apply", "--confirm-facility-id", "demo-clinic").ok, true);
});

test("開発プロジェクト以外は拒否", () => {
  assert.equal(plan("lookup", "--email", "a@example.jp", "--project", "my-prod-project").ok, false);
  assert.equal(plan("lookup", "--email", "a@example.jp", "--project", ALLOWED_PROJECT).ok, true);
});

test("不正なUID・施設ID・action は拒否", () => {
  assert.equal(plan("grant-platform-admin", "--uid", "short").ok, false);
  assert.equal(plan("create-facility", "--facility-id", "Bad_ID", "--facility-name", "x").ok, false);
  assert.equal(plan("delete-everything").ok, false);
  assert.equal(plan().ok, false);
});

test("施設管理者の追加計画は create のみ（上書きしない）で admin 固定", () => {
  const r = plan("add-facility-admin", "--facility-id", "demo-clinic", "--uid", UID);
  const op = r.plan.operations[0];
  assert.equal(op.failIfExists, true);
  assert.equal(op.path, `facilities/demo-clinic/members/${UID}`);
  assert.deepEqual(op.data, { uid: UID, role: "admin", status: "active" });
});

test("施設の位置情報登録: 座標・判定距離は明示指定が必須（既定値なし）", () => {
  const base = ["set-facility-geo", "--facility-id", "demo-clinic"];
  assert.equal(plan(...base).ok, false);
  assert.equal(plan(...base, "--lat", "35", "--lng", "139").ok, false);
  assert.equal(plan(...base, "--lat", "95", "--lng", "139", "--radius-m", "100").ok, false);
  assert.equal(plan(...base, "--lat", "35", "--lng", "139", "--radius-m", "5").ok, false);
  const r = plan(...base, "--lat", "35.5", "--lng", "-139.25", "--radius-m", "120");
  assert.equal(r.ok, true);
  assert.equal(r.plan.apply, false);
  assert.deepEqual(r.plan.operations[0].data, { location: { lat: 35.5, lng: -139.25 }, geoRadiusM: 120 });
  assert.equal(plan(...base, "--lat", "35", "--lng", "139", "--radius-m", "100", "--apply").ok, false);
  assert.equal(plan(...base, "--lat", "35", "--lng", "139", "--radius-m", "100", "--apply", "--confirm-facility-id", "demo-clinic").ok, true);
});
