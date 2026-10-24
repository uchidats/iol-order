/**
 * 施設のセルフ登録と招待参加（サーバー側ロジック）
 *
 * Admin SDK 経由で実行される（Firestore Security Rules を介さない）ため、
 * ここが唯一の「施設作成」「招待による所属作成」の経路になる。クライアントには一切の権限を与えない。
 * - 依存（db, FieldValue など）は注入する。テストはエミュレータ上の本物の Firestore で実行する。
 * - 入力は厳格に検証する（未知のキーは拒否）。クライアントは role / platformAdmin / facilityId を指定できない。
 */
import { createHash, randomBytes } from "node:crypto";

export const LIMITS = Object.freeze({
  nameMax: 100,
  maxFacilitiesPerUser: 3,           // 1ユーザーがセルフ登録できる施設数の上限（乱用防止）
  inviteTtlMs: 7 * 24 * 60 * 60 * 1000,
  maxPendingInvitesPerFacility: 20,
  emailMax: 254,
  // 1ユーザー・1操作あたりの呼び出し回数の上限（固定ウィンドウ）。失敗した呼び出しも数える
  rateWindowMs: 60 * 60 * 1000,
  rateMax: Object.freeze({ registerFacility: 10, createInvite: 30, acceptInvite: 20 })
});

/** クライアントに返すエラー。code は firebase-functions の HttpsError コードに対応 */
export class RegistrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RegistrationError";
    this.code = code;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUEST_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const FACILITY_ID_RE = /^[a-z0-9][a-z0-9-]{2,40}$/;

// ---------- 名前の正規化と類似判定 ----------
export function normalizeName(s) {
  return String(s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** 比較用キー: 小文字化し、空白・記号を除去 */
export function nameKey(s) {
  return normalizeName(s).toLowerCase().replace(/[\s\-_・･.,、。()（）「」『』]/g, "");
}

function editDistanceAtMostOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** 'exact' | 'similar' | null */
export function compareNames(aKey, bKey) {
  if (!aKey || !bKey) return null;
  if (aKey === bKey) return "exact";
  const [short, long] = aKey.length <= bKey.length ? [aKey, bKey] : [bKey, aKey];
  if (short.length >= 3 && long.includes(short)) return "similar";
  if (short.length >= 4 && editDistanceAtMostOne(aKey, bKey)) return "similar";
  return null;
}

// ---------- 入力検証 ----------
function assertKnownKeys(data, allowed) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new RegistrationError("invalid-argument", "リクエストの形式が正しくありません");
  }
  const extra = Object.keys(data).filter(k => !allowed.includes(k));
  if (extra.length) throw new RegistrationError("invalid-argument", "指定できない項目が含まれています");
}

export function parseRegisterInput(data) {
  assertKnownKeys(data, ["name", "requestId", "confirmDuplicate"]);
  const name = typeof data.name === "string" ? normalizeName(data.name) : "";
  if (!name || name.length > LIMITS.nameMax) {
    throw new RegistrationError("invalid-argument", `施設名は1〜${LIMITS.nameMax}文字で入力してください`);
  }
  if (typeof data.requestId !== "string" || !REQUEST_ID_RE.test(data.requestId)) {
    throw new RegistrationError("invalid-argument", "リクエストIDが正しくありません");
  }
  if (data.confirmDuplicate !== undefined && typeof data.confirmDuplicate !== "boolean") {
    throw new RegistrationError("invalid-argument", "リクエストの形式が正しくありません");
  }
  return { name, requestId: data.requestId, confirmDuplicate: data.confirmDuplicate === true };
}

export function parseInviteInput(data) {
  assertKnownKeys(data, ["facilityId", "email"]);
  if (typeof data.facilityId !== "string" || !FACILITY_ID_RE.test(data.facilityId)) {
    throw new RegistrationError("invalid-argument", "施設IDが正しくありません");
  }
  const email = String(data.email ?? "").trim().toLowerCase();
  if (!email || email.length > LIMITS.emailMax || !EMAIL_RE.test(email)) {
    throw new RegistrationError("invalid-argument", "メールアドレスの形式が正しくありません");
  }
  return { facilityId: data.facilityId, email };
}

export function parseAcceptInput(data) {
  assertKnownKeys(data, ["token"]);
  if (typeof data.token !== "string" || !TOKEN_RE.test(data.token)) {
    throw new RegistrationError("failed-precondition", INVALID_INVITE);
  }
  return { token: data.token };
}

const INVALID_INVITE = "招待コードが無効、期限切れ、または使用済みです";

// ---------- 認証 ----------
/** 認証済みかつメール確認済み。platformAdmin はクライアントから設定できないトークンクレーム */
export function assertVerifiedUser(auth) {
  if (!auth || !auth.uid) throw new RegistrationError("unauthenticated", "ログインが必要です");
  const token = auth.token || {};
  if (token.email_verified !== true || !token.email) {
    throw new RegistrationError("permission-denied", "メールアドレスの確認が済んだアカウントのみ利用できます");
  }
  return { uid: auth.uid, email: String(token.email).toLowerCase(), displayName: token.name || null, isPlatformAdmin: token.platformAdmin === true };
}

export const hashToken = (token) => createHash("sha256").update(token).digest("hex");

/** 施設IDはサーバーが (uid, requestId) から導出する。クライアントは指定できず、同じ要求の再試行は同じIDになる */
export function deriveFacilityId(uid, requestId) {
  return "fac-" + createHash("sha256").update(`${uid}:${requestId}`).digest("hex").slice(0, 24);
}

/**
 * @param {object} deps
 * @param {FirebaseFirestore.Firestore} deps.db
 * @param {{serverTimestamp:Function}} deps.FieldValue
 * @param {{fromMillis:Function}} deps.Timestamp
 * @param {() => number} [deps.now]
 * @param {(n:number) => Buffer} [deps.random]
 */
export function createRegistrationService({ db, FieldValue, Timestamp, now = Date.now, random = randomBytes }) {
  /** ユーザー単位のレート制限（トランザクションで数える）。上限超過は resource-exhausted */
  async function consumeRate(uid, action) {
    const ref = db.doc(`rateLimits/${uid}_${action}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const t = now();
      let start = snap.exists ? snap.get("windowStart") : 0;
      let n = snap.exists ? snap.get("count") || 0 : 0;
      if (!snap.exists || t - start >= LIMITS.rateWindowMs) { start = t; n = 0; }
      if (n >= LIMITS.rateMax[action]) {
        throw new RegistrationError("resource-exhausted", "操作の回数が上限に達しました。しばらくしてからお試しください");
      }
      tx.set(ref, { windowStart: start, count: n + 1, updatedAt: FieldValue.serverTimestamp() });
    });
  }

  /** 既存施設との名前の重複候補。他施設の名前・IDは返さず、件数と完全一致の有無のみ返す */
  async function findNameCandidates(key) {
    const snap = await db.collection("facilities").select("name").get();
    let exact = false, similarCount = 0;
    snap.forEach(d => {
      const r = compareNames(key, nameKey(d.get("name")));
      if (r === "exact") { exact = true; similarCount++; } else if (r === "similar") similarCount++;
    });
    return { exact, similarCount };
  }

  /** 新しい施設を登録し、呼び出したユーザーを最初の管理者にする */
  async function registerFacility({ auth, data }) {
    const user = assertVerifiedUser(auth);
    const input = parseRegisterInput(data);
    await consumeRate(user.uid, "registerFacility");
    const key = nameKey(input.name);
    const facilityId = deriveFacilityId(user.uid, input.requestId);
    const facRef = db.doc(`facilities/${facilityId}`);
    const memRef = db.doc(`facilities/${facilityId}/members/${user.uid}`);
    const quotaRef = db.doc(`registrationQuota/${user.uid}`);

    // 同じ要求の再試行（途中失敗後・二重送信）は、作成済みの施設をそのまま返す
    const existing = await facRef.get();
    if (existing.exists) {
      if (existing.get("createdBy") === user.uid) return { status: "exists", facilityId };
      throw new RegistrationError("already-exists", "登録できませんでした。もう一度お試しください");
    }

    // 重複候補（確認済みでなければ登録せず、候補の有無だけ返す）
    if (!input.confirmDuplicate) {
      const dup = await findNameCandidates(key);
      if (dup.exact || dup.similarCount > 0) return { status: "duplicate-candidate", ...dup };
    }

    // 施設・最初の管理者の所属・利用枠の更新を1つのトランザクションで行う（全部成功か全部失敗）
    return db.runTransaction(async (tx) => {
      const [fac, quota] = await Promise.all([tx.get(facRef), tx.get(quotaRef)]);
      if (fac.exists) {
        if (fac.get("createdBy") === user.uid) return { status: "exists", facilityId };
        throw new RegistrationError("already-exists", "登録できませんでした。もう一度お試しください");
      }
      const count = quota.exists ? quota.get("count") || 0 : 0;
      const keys = quota.exists ? quota.get("keys") || [] : [];
      if (count >= LIMITS.maxFacilitiesPerUser) {
        throw new RegistrationError("resource-exhausted", `セルフ登録できる施設は1ユーザーあたり${LIMITS.maxFacilitiesPerUser}件までです`);
      }
      // 同一ユーザーの同時登録（別タブ等）でも、同名の二重作成を直列化して検出する
      if (!input.confirmDuplicate && keys.includes(key)) {
        return { status: "duplicate-candidate", exact: true, similarCount: 1 };
      }
      tx.create(facRef, {
        name: input.name, status: "active",
        createdBy: user.uid, selfRegistered: true,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      });
      tx.create(memRef, {
        uid: user.uid, role: "admin", status: "active",
        displayName: user.displayName, updatedAt: FieldValue.serverTimestamp()
      });
      tx.set(quotaRef, { count: count + 1, keys: [...keys, key], updatedAt: FieldValue.serverTimestamp() });
      return { status: "created", facilityId };
    });
  }

  /** 施設管理者が、特定のメールアドレス宛ての参加招待（orderer 権限）を発行する。メールは送信しない */
  async function createInvite({ auth, data }) {
    const user = assertVerifiedUser(auth);
    const input = parseInviteInput(data);
    await consumeRate(user.uid, "createInvite");

    const [fac, mem] = await Promise.all([
      db.doc(`facilities/${input.facilityId}`).get(),
      db.doc(`facilities/${input.facilityId}/members/${user.uid}`).get()
    ]);
    const isAdmin = fac.exists && fac.get("status") === "active"
      && mem.exists && mem.get("role") === "admin" && mem.get("status") === "active";
    if (!isAdmin && !user.isPlatformAdmin) {
      throw new RegistrationError("permission-denied", "この施設の管理者のみ招待できます");
    }
    if (!fac.exists) throw new RegistrationError("not-found", "施設が見つかりません");

    const pending = await db.collection("invites")
      .where("facilityId", "==", input.facilityId).where("status", "==", "pending")
      .where("expiresAt", ">", Timestamp.fromMillis(now())).count().get(); // 期限切れの未使用招待は上限に数えない
    if (pending.data().count >= LIMITS.maxPendingInvitesPerFacility) {
      throw new RegistrationError("resource-exhausted", "未使用の招待が上限に達しています");
    }

    const token = random(32).toString("base64url");
    const expiresMs = now() + LIMITS.inviteTtlMs;
    // 保存するのはトークンのハッシュのみ（ドキュメントID）。トークン本体は発行時に1度だけ返す
    await db.doc(`invites/${hashToken(token)}`).create({
      facilityId: input.facilityId, email: input.email, role: "orderer", status: "pending",
      createdBy: user.uid, createdAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.fromMillis(expiresMs)
    });
    return { token, email: input.email, expiresAt: new Date(expiresMs).toISOString() };
  }

  /** 招待コードで施設に参加する。コード・メールアドレス（確認済み）・有効期限がすべて一致する場合のみ */
  async function acceptInvite({ auth, data }) {
    const user = assertVerifiedUser(auth);
    const input = parseAcceptInput(data);
    await consumeRate(user.uid, "acceptInvite");
    const inviteRef = db.doc(`invites/${hashToken(input.token)}`);

    return db.runTransaction(async (tx) => {
      const inv = await tx.get(inviteRef);
      // 存在しない・期限切れ・使用済み・別のメールアドレス宛て、は区別せず同じ応答にする（探索対策）
      const valid = inv.exists && inv.get("status") === "pending"
        && inv.get("expiresAt").toMillis() > now() && inv.get("email") === user.email;
      if (!valid) throw new RegistrationError("failed-precondition", INVALID_INVITE);

      const facilityId = inv.get("facilityId");
      const facRef = db.doc(`facilities/${facilityId}`);
      const memRef = db.doc(`facilities/${facilityId}/members/${user.uid}`);
      const [fac, mem] = await Promise.all([tx.get(facRef), tx.get(memRef)]);
      if (!fac.exists || fac.get("status") !== "active") throw new RegistrationError("failed-precondition", INVALID_INVITE);

      // 既に admin の人を orderer に降格しない。それ以外は orderer として有効化
      if (!(mem.exists && mem.get("role") === "admin" && mem.get("status") === "active")) {
        tx.set(memRef, {
          uid: user.uid, role: "orderer", status: "active",
          displayName: user.displayName, updatedAt: FieldValue.serverTimestamp()
        });
      }
      tx.update(inviteRef, { status: "used", usedBy: user.uid, usedAt: FieldValue.serverTimestamp() });
      return { facilityId };
    });
  }

  return { registerFacility, createInvite, acceptInvite };
}
