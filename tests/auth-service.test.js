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

test("Googleログイン: selectAccount を指定すると毎回アカウントの選択画面(ディーラー画面)。指定なしは従来どおり(医療機関の画面)", async () => {
  const params = [];
  class GoogleAuthProvider { setCustomParameters(p) { this.p = p; } }
  const { fns } = makeFns({ GoogleAuthProvider, signInWithPopup: async (a, p) => { params.push(p.p || null); return { user: { uid: "u" } }; } });
  const s = createAuthService({ auth: {}, fns, currentUrl: () => "https://x/y/" });
  await s.signInWithGoogle();
  await s.signInWithGoogle({ selectAccount: true });
  assert.deepEqual(params, [null, { prompt: "select_account" }]);
});

test("Microsoftログイン: OAuthProvider(\"microsoft.com\") のポップアップ(アカウントの選択画面)。連携はログイン中のアカウントに linkWithPopup し(連携済みなら省略)、トークンを更新する", async () => {
  const calls = [];
  class OAuthProvider { constructor(id) { this.id = id; } setCustomParameters(p) { this.p = p; } }
  const user = { uid: "u", getIdToken: async (force) => { calls.push(["token", force]); return "t"; } };
  const { fns } = makeFns({ OAuthProvider,
    signInWithPopup: async (a, p) => { calls.push(["popup", p.id, p.p || null]); return {}; },
    linkWithPopup: async (u, p) => { calls.push(["link", u.uid, p.id, p.p || null]); return {}; } });
  const s = createAuthService({ auth: { currentUser: user }, fns, currentUrl: () => "https://x/y/" });
  await s.signInWithMicrosoft({ selectAccount: true });
  await s.signInWithMicrosoft();
  await s.linkMicrosoft();
  assert.deepEqual(calls, [["popup", "microsoft.com", { prompt: "select_account" }], ["popup", "microsoft.com", null], ["link", "u", "microsoft.com", { prompt: "select_account" }], ["token", true]]);
  const none = createAuthService({ auth: { currentUser: null }, fns, currentUrl: () => "https://x/y/" });
  await assert.rejects(none.linkMicrosoft(), (e) => e.code === "auth/no-current-user");  // 連携済み(連携の後に登録が終わらなかった)なら、連携を省略してトークンだけ更新する(MS-03 の再開。provider-already-linked にしない)
  calls.length = 0;
  const linked = createAuthService({ auth: { currentUser: { ...user, providerData: [{ providerId: "password" }, { providerId: "microsoft.com" }] } }, fns, currentUrl: () => "https://x/y/" });
  await linked.linkMicrosoft();
  assert.deepEqual(calls, [["token", true]]);
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
