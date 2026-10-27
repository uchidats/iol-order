// ブラウザテスト用: 実際の index.html・main.js を、偽の Firebase SDK で動かす(外部への通信はしない)。
// 偽の SDK は main.js が読み込む4つのモジュール。データは window.__fakeUser・window.__fakeDb、読み取りの記録は window.__fakeReads。
// Firestore の Rules のうち、紹介の本文(platformContent)だけは同じ制限(platformAdmin のみ)をまねる。

export const FAKE_SDK = {
  "firebase-app.js": "export const initializeApp = (c) => ({ c });",
  "firebase-auth.js": `
    export const getAuth = () => ({ get currentUser() { return window.__fakeUser || null; } });
    export function onAuthStateChanged(auth, cb) { setTimeout(() => { window.__authAt = performance.now(); cb(window.__fakeUser || null); }, window.__fakeAuthDelay || 0); return () => {}; }
    export class GoogleAuthProvider {}
    export const signInWithPopup = async () => { throw Object.assign(new Error("closed"), { code: "auth/popup-closed-by-user" }); };
    export const sendSignInLinkToEmail = async (auth, email, settings) => { (window.__linkSent = window.__linkSent || []).push([email, settings && settings.url]); };
    export const isSignInWithEmailLink = () => false;
    export const signInWithEmailLink = async () => ({});
    export const signOut = async () => {};`,
  "firebase-firestore.js": `
    const store = () => window.__fakeDb || {};
    const snap = (p, d) => ({ id: p.split("/").pop(), exists: () => d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))),
      ref: { path: p, parent: { parent: { id: p.split("/").slice(-3)[0] } } } });
    export const getFirestore = () => ({});
    export const doc = (db, ...s) => ({ kind: "doc", path: s.join("/") });
    export const collection = (db, ...s) => ({ kind: "col", path: s.join("/") });
    export const collectionGroup = (db, id) => ({ kind: "group", id });
    export const where = (f, op, v) => ({ t: "where", f, v });
    export const orderBy = () => ({ t: "orderBy" });
    export const limit = () => ({ t: "limit" });
    export const query = (ref, ...cs) => ({ ...ref, cs });
    export const serverTimestamp = () => ({});
    export async function getDoc(ref) {
      (window.__fakeReads = window.__fakeReads || []).push(ref.path);
      if (ref.path.startsWith("platformContent/") && !(window.__fakeUser && window.__fakeUser.claims && window.__fakeUser.claims.platformAdmin === true)) {
        throw Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" });
      }
      return snap(ref.path, store()[ref.path]);
    }
    export async function getDocs(q) {
      const docs = [];
      for (const [p, d] of Object.entries(store())) {
        const s = p.split("/");
        if (q.kind === "col" && !(p.startsWith(q.path + "/") && s.length === q.path.split("/").length + 1)) continue;
        if (q.kind === "group" && s[s.length - 2] !== q.id) continue;
        if ((q.cs || []).some(c => c.t === "where" && d[c.f] !== c.v)) continue;
        docs.push(snap(p, d));
      }
      return { docs, empty: !docs.length, size: docs.length, forEach: (fn) => docs.forEach(fn) };
    }`,
  "firebase-functions.js": `
    export const getFunctions = () => ({});
    // 呼び出しの記録(window.__calls)と、テストごとの応答(window.__fakeCallables[name](data)。例外の { code, message } はエラー)
    export const httpsCallable = (fns, name) => async (data) => {
      (window.__calls = window.__calls || []).push([name, data]);
      const h = window.__fakeCallables && window.__fakeCallables[name];
      if (h) return { data: await h(data) };
      return { data: name === "listMyPendingMemberships" ? { memberships: [] } : {} };
    };`
};

/**
 * 偽の SDK を返し、ローカル(base)以外への通信は止めたブラウザのコンテキスト。
 * @param {{user:object, claims?:object, db:object, authDelay?:number}|null} session null は未ログイン(authDelay: ログイン状態が分かるまでの時間 ms)
 */
export async function newFakeContext(browser, base, width, session) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  await context.route(/^https?:\/\//, (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    const m = url.match(/^https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/(firebase-[a-z]+\.js)$/);
    if (m && FAKE_SDK[m[1]]) return route.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_SDK[m[1]] });
    return route.abort();
  });
  await context.addInitScript((s) => {
    const claims = (s && s.claims) || {};
    window.__fakeUser = s ? { ...s.user, claims, getIdTokenResult: async () => ({ claims }) } : null;
    window.__fakeDb = s ? s.db : {};
    window.__fakeAuthDelay = (s && s.authDelay) || 0;
  }, session);
  return context;
}
