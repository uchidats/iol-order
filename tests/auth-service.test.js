import test from "node:test";
import assert from "node:assert/strict";
import { createAuthService } from "../src/firebase/auth-service.js";
import { createFirestoreRepository, fetchMemberships } from "../src/data/firestore-repository.js";

function makeFns(overrides = {}) {
  const calls = [];
  class GoogleAuthProvider {}
  const fns = {
    GoogleAuthProvider,
    onAuthStateChanged: (a, cb) => { calls.push(["onAuthStateChanged"]); cb({ uid: "u" }); return () => {}; },
    signInWithPopup: async (a, p) => { calls.push(["popup", p instanceof GoogleAuthProvider]); return { user: { uid: "u" } }; },
    sendSignInLinkToEmail: async (a, email, settings) => { calls.push(["send", email, settings]); },
    isSignInWithEmailLink: (a, href) => href.includes("oobCode="),
    signInWithEmailLink: async (a, email, href) => { calls.push(["emailSignIn", email]); return { user: { uid: "u" } }; },
    signOut: async () => { calls.push(["signOut"]); },
    ...overrides
  };
  return { fns, calls };
}

const memStore = () => {
  const d = new Map();
  return { getItem: k => d.get(k) ?? null, setItem: (k, v) => d.set(k, v), removeItem: k => d.delete(k) };
};

test("Googleログインはポップアップ + GoogleAuthProvider", async () => {
  const { fns, calls } = makeFns();
  const s = createAuthService({ auth: {}, fns, currentUrl: () => "https://x/y/" });
  await s.signInWithGoogle();
  assert.deepEqual(calls[0], ["popup", true]);
});

test("メールリンク送信は handleCodeInApp とクエリ無しの戻り先を使う", async () => {
  const { fns, calls } = makeFns();
  const storage = memStore();
  const s = createAuthService({ auth: {}, fns, currentUrl: () => "https://x/y/", storage });
  await s.sendEmailLink("  a@example.jp ");
  assert.deepEqual(calls[0], ["send", "a@example.jp", { url: "https://x/y/", handleCodeInApp: true }]);
  assert.equal(storage.getItem("iol_order_emaillink_pending"), "a@example.jp");
  await assert.rejects(s.sendEmailLink(" "));
});

test("メールリンク完了: 保存済みメールを使用し、完了後に破棄", async () => {
  const { fns, calls } = makeFns();
  const storage = memStore();
  storage.setItem("iol_order_emaillink_pending", "a@example.jp");
  const s = createAuthService({ auth: {}, fns, currentUrl: () => "", storage });
  await s.completeEmailLink("https://x/?oobCode=1", () => { throw new Error("should not ask"); });
  assert.deepEqual(calls[0], ["emailSignIn", "a@example.jp"]);
  assert.equal(storage.getItem("iol_order_emaillink_pending"), null);
});

test("メールリンク完了: 別端末では再入力を求め、拒否されたら失敗", async () => {
  const { fns, calls } = makeFns();
  const s = createAuthService({ auth: {}, fns, currentUrl: () => "", storage: memStore() });
  await s.completeEmailLink("https://x/?oobCode=1", () => "b@example.jp");
  assert.equal(calls[0][1], "b@example.jp");
  await assert.rejects(s.completeEmailLink("https://x/?oobCode=1", () => null));
});

test("メールリンクでないURLは何もしない", async () => {
  const { fns, calls } = makeFns();
  const s = createAuthService({ auth: {}, fns, currentUrl: () => "" });
  assert.equal(await s.completeEmailLink("https://x/", () => "a@example.jp"), null);
  assert.equal(calls.length, 0);
});

test("ログアウトと状態購読", async () => {
  const { fns, calls } = makeFns();
  const s = createAuthService({ auth: {}, fns, currentUrl: () => "" });
  let got = null;
  s.onChange(u => { got = u; });
  assert.equal(got.uid, "u");
  await s.signOut();
  assert.deepEqual(calls.at(-1), ["signOut"]);
});

test("Firestoreリポジトリは施設配下のサブコレクションを読む", async () => {
  const seen = [];
  const fs = {
    collection: (db, ...path) => ({ path: path.join("/") }),
    getDocs: async (ref) => { seen.push(ref.path); return { docs: [{ id: "d1", data: () => ({ name: "n" }) }] }; },
    doc: (db, ...path) => ({ path: path.join("/") }),
    getDoc: async () => ({ exists: () => false })
  };
  const repo = createFirestoreRepository({}, fs);
  const o = await repo.listOrderers("f1");
  await repo.listAdoptedIols("f1");
  await repo.listDealers("f1");
  assert.deepEqual(seen, ["facilities/f1/orderers", "facilities/f1/adoptedIols", "facilities/f1/facilityDealers"]);
  assert.deepEqual(o, [{ id: "d1", facilityId: "f1", name: "n" }]);
  await assert.rejects(repo.getFacility("f1"));
});

test("所属取得は members の collectionGroup を uid で絞る", async () => {
  let where = null;
  const fs = {
    collectionGroup: (db, name) => ({ name }),
    where: (f, op, v) => (where = [f, op, v]),
    query: (c, w) => ({ c, w }),
    getDocs: async (q) => ({
      docs: [{ ref: { parent: { parent: { id: "f9" } } }, data: () => ({ role: "orderer" }) }]
    })
  };
  const r = await fetchMemberships({}, fs, "uid1");
  assert.deepEqual(where, ["uid", "==", "uid1"]);
  assert.deepEqual(r, [{ facilityId: "f9", role: "orderer" }]);
});
