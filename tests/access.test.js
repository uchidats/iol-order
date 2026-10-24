import test from "node:test";
import assert from "node:assert/strict";
import { decideAccess, ACCESS } from "../src/domain/access.js";
import { FIREBASE_CONFIG, isFirebaseConfigured, missingFirebaseKeys } from "../src/firebase/firebase-config.js";

const base = { configured: true, authReady: true, user: { uid: "u1" }, membershipsLoaded: true, memberships: [] };
const m = (o) => ({ facilityId: "f1", role: "orderer", status: "active", ...o });

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

test("無効・不正な所属は許可しない", () => {
  for (const bad of [
    m({ status: "disabled" }), m({ status: "pending" }), m({ role: "owner" }),
    m({ role: undefined }), m({ facilityId: "" }), null
  ]) {
    assert.equal(decideAccess({ ...base, memberships: [bad] }).state, ACCESS.NO_MEMBERSHIP);
  }
});

test("有効な所属があれば許可し、施設IDと権限を返す", () => {
  const r = decideAccess({ ...base, memberships: [m({ facilityId: "b" }), m({ facilityId: "a", role: "admin" })] });
  assert.equal(r.state, ACCESS.GRANTED);
  assert.equal(r.facilityId, "a");
  assert.equal(r.role, "admin");
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
