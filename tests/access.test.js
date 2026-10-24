import test from "node:test";
import assert from "node:assert/strict";
import { decideAccess, ACCESS } from "../src/domain/access.js";
import { FIREBASE_CONFIG, isFirebaseConfigured, missingFirebaseKeys } from "../src/firebase/firebase-config.js";

const base = { configured: true, authReady: true, user: { uid: "u1" }, membershipsLoaded: true, memberships: [] };
const m = (o) => ({ facilityId: "f1", role: "orderer", ...o });

test("Firebase未設定は従来モード", () => {
  assert.equal(decideAccess({ ...base, configured: false }).state, ACCESS.LEGACY);
});

test("認証状態の確認中は LOADING", () => {
  assert.equal(decideAccess({ ...base, authReady: false }).state, ACCESS.LOADING);
  assert.equal(decideAccess({ ...base, membershipsLoaded: false }).state, ACCESS.LOADING);
});

test("未ログインは SIGNED_OUT", () => {
  assert.equal(decideAccess({ ...base, user: null }).state, ACCESS.SIGNED_OUT);
});

test("ログイン済みでも所属が無ければ許可しない", () => {
  assert.equal(decideAccess(base).state, ACCESS.NO_MEMBERSHIP);
});

test("不正な所属は許可しない(所属に有効/無効の状態はなく、role と施設IDがある所属だけが有効)", () => {
  for (const bad of [
    m({ role: "owner" }), m({ role: undefined }), m({ role: "viewer" }), m({ facilityId: "" }), m({ facilityId: undefined }), null
  ]) {
    assert.equal(decideAccess({ ...base, memberships: [bad] }).state, ACCESS.NO_MEMBERSHIP);
  }
});

test("所属が1つなら選択なしで自動確定（権限も返す）", () => {
  const r = decideAccess({ ...base, memberships: [m({ facilityId: "a", role: "admin" }), m({ facilityId: "x", role: "owner" })] });
  assert.equal(r.state, ACCESS.GRANTED);
  assert.equal(r.facilityId, "a");
  assert.equal(r.role, "admin");
});

test("複数所属で選択が無ければ SELECT_FACILITY（不正な所属は除く）", () => {
  const r = decideAccess({ ...base, memberships: [m({ facilityId: "b" }), m({ facilityId: "a" }), m({ facilityId: "c", role: "owner" })] });
  assert.equal(r.state, ACCESS.SELECT_FACILITY);
  assert.deepEqual(r.memberships.map(x => x.facilityId), ["a", "b"]);
});

test("複数所属: 検証済みの所属に含まれる選択のみ採用する", () => {
  const ms = [m({ facilityId: "a" }), m({ facilityId: "b", role: "admin" }), m({ facilityId: "c", role: "owner" })];
  const ok = decideAccess({ ...base, memberships: ms, selectedFacilityId: "b" });
  assert.equal(ok.state, ACCESS.GRANTED);
  assert.equal(ok.facilityId, "b");
  assert.equal(ok.role, "admin");
  // 端末の記憶値が所属に無い / 無効な所属 / 他人の施設 → 許可しない
  for (const forged of ["zzz", "c", "", null]) {
    assert.equal(decideAccess({ ...base, memberships: ms, selectedFacilityId: forged }).state, ACCESS.SELECT_FACILITY, String(forged));
  }
});

test("所属ゼロのユーザーは、記憶された施設IDがあっても許可しない", () => {
  assert.equal(decideAccess({ ...base, memberships: [], selectedFacilityId: "a" }).state, ACCESS.NO_MEMBERSHIP);
});

test("Firebase設定: 開発プロジェクトの値が揃っている（秘密鍵類は含まない）", () => {
  assert.equal(FIREBASE_CONFIG.projectId, "medconf-iol-dev");
  assert.equal(FIREBASE_CONFIG.authDomain, "medconf-iol-dev.firebaseapp.com");
  assert.equal(FIREBASE_CONFIG.appId, "1:591596535765:web:d7a336aa6c6bb3d229875c");
  assert.match(FIREBASE_CONFIG.apiKey, /^AIza[0-9A-Za-z_-]{35}$/);
  assert.equal(isFirebaseConfigured(), true);
  assert.deepEqual(missingFirebaseKeys(), []);
  assert.equal(isFirebaseConfigured({ ...FIREBASE_CONFIG, apiKey: "" }), false);
  assert.deepEqual(missingFirebaseKeys({ ...FIREBASE_CONFIG, apiKey: "" }), ["apiKey"]);
  const keys = Object.keys(FIREBASE_CONFIG);
  assert.ok(!keys.some(k => /private|secret|client_email|serviceAccount/i.test(k)));
});
