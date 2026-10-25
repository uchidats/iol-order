/**
 * 施設のセルフ登録・施設名の確認と変更・施設の削除（サーバー側ロジック）
 *
 * Admin SDK 経由で実行される（Firestore Security Rules を介さない）ため、
 * ここが唯一の「施設作成」の経路になる(既存施設への参加は利用者管理の事前登録: members.js。旧招待コード方式は廃止)。クライアントには一切の権限を与えない。
 * - 依存（db, FieldValue など）は注入する。テストはエミュレータ上の本物の Firestore で実行する。
 * - 入力は厳格に検証する（未知のキーは拒否）。クライアントは role / platformAdmin / facilityId を指定できない。
 */
import { createHash } from "node:crypto";

export const LIMITS = Object.freeze({
  nameMax: 100,
  maxFacilitiesPerUser: 3,           // 1ユーザーがセルフ登録できる施設数の上限（乱用防止）
  // 1ユーザー・1操作あたりの呼び出し回数の上限（固定ウィンドウ）。失敗した呼び出しも数える
  rateWindowMs: 60 * 60 * 1000,
  rateMax: Object.freeze({ registerFacility: 10, checkFacilityName: 120, renameFacility: 20, deleteFacility: 10 }),
  maxDeleteDocs: 450,   // 1回の削除(トランザクション)で扱える書き込み数の上限(Firestoreは500)
  maxCandidates: 5
});

/** クライアントに返すエラー。code は firebase-functions の HttpsError コードに対応 */
export class RegistrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RegistrationError";
    this.code = code;
  }
}

const REQUEST_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
const FACILITY_ID_RE = /^[a-z0-9][a-z0-9-]{2,40}$/;

// ---------- 名前の正規化と類似判定 ----------
export function normalizeName(s) {
  return String(s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

// 法人名・会社名の表記(有無で別の施設とみなさない)。長いものから取り除く
const CORPORATE_WORDS = [
  "特定医療法人", "社会医療法人", "医療法人社団", "医療法人財団", "医療法人", "社会福祉法人", "学校法人", "宗教法人",
  "一般社団法人", "一般財団法人", "公益社団法人", "公益財団法人", "地方独立行政法人", "独立行政法人", "国立大学法人", "公立大学法人",
  "特定非営利活動法人", "npo法人", "株式会社", "有限会社", "合同会社", "(医)", "(株)", "(有)", "(社)", "(財)", "(学)", "(福)"
];

/** 比較用キー: 全角・半角を統一(NFKC)・小文字化し、法人名の表記・空白・記号・ハイフン類を除去。ヶ/ヵ/ケ のゆれも統一 */
export function nameKey(s) {
  let k = normalizeName(s).toLowerCase();
  for (const w of CORPORATE_WORDS) k = k.split(w).join("");
  return k.replace(/[ヶヵ]/g, "ケ").replace(/[\s\-_・･.,、。()（）「」『』\u2010-\u2015\u2212]/g, "");
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
 */
export function createRegistrationService({ db, FieldValue, Timestamp, now = Date.now }) {
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

  /**
   * 既存施設との名前の重複候補。返すのは、完全一致の有無・似た施設の件数・候補の施設名(最大 maxCandidates 件。施設名のみ)。
   * 施設ID・メール・職員・注文などは返さない。excludeId の施設(名前変更中の自分の施設)は数えない
   */
  async function findNameCandidates(key, excludeId = null, { suggest = false } = {}) {
    const snap = await db.collection("facilities").select("name", "status").get();
    let exact = false, similarCount = 0;
    const named = [];
    snap.forEach(d => {
      if (d.id === excludeId) return;
      const fk = nameKey(d.get("name"));
      let r = compareNames(key, fk);
      // 入力中の候補表示(suggest)だけは、短い入力(2文字以上)でも「施設名の一部」として候補にする(例: 「立川」→「立川病院」)。登録・変更時の重複判定には使わない
      let rank = r === "exact" ? 0 : 1;
      if (!r && suggest && key.length >= 2 && fk.includes(key)) { r = "similar"; rank = fk.startsWith(key) ? 1 : 2; }
      if (!r) return;
      similarCount++;
      if (r === "exact") exact = true;
      if (d.get("status") === "active" && typeof d.get("name") === "string") named.push({ name: d.get("name"), rank });
    });
    named.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, "ja"));
    const candidates = [...new Set(named.map(n => n.name))].slice(0, LIMITS.maxCandidates);
    return { exact, similarCount, candidates };
  }

  /**
   * 施設名を入力している間の、重複候補の確認(読み取りのみ。何も作成しない)。
   * 返すのは「完全一致があるか」「似た施設の件数」「候補の施設名(最大5件)」だけ。施設ID・メールアドレス・職員・注文・招待などは一切返さない。
   * ログイン済み・メール確認済みのユーザーだけ。回数制限あり(施設名の総当たりを防ぐ)。
   */
  async function checkFacilityName({ auth, data }) {
    const user = assertVerifiedUser(auth);
    assertKnownKeys(data, ["name"]);
    const name = typeof data.name === "string" ? normalizeName(data.name) : "";
    if (!name || name.length > LIMITS.nameMax) {
      throw new RegistrationError("invalid-argument", `施設名は1〜${LIMITS.nameMax}文字で入力してください`);
    }
    await consumeRate(user.uid, "checkFacilityName");
    const { exact, similarCount, candidates } = await findNameCandidates(nameKey(name), null, { suggest: true });
    return { exact, similarCount, candidates };
  }

  /**
   * 施設名の変更(施設管理者のみ)。既存施設との重複を確認し、候補があれば確認(confirmDuplicate)なしでは変更しない。
   * 変更するのは name と updatedAt だけ。施設ID・所属・注文などは変わらない
   */
  async function renameFacility({ auth, data }) {
    const user = assertVerifiedUser(auth);
    assertKnownKeys(data, ["facilityId", "name", "confirmDuplicate"]);
    if (typeof data.facilityId !== "string" || !FACILITY_ID_RE.test(data.facilityId)) {
      throw new RegistrationError("invalid-argument", "施設の指定が正しくありません");
    }
    const name = typeof data.name === "string" ? normalizeName(data.name) : "";
    if (!name || name.length > LIMITS.nameMax) {
      throw new RegistrationError("invalid-argument", `施設名は1〜${LIMITS.nameMax}文字で入力してください`);
    }
    if (data.confirmDuplicate !== undefined && data.confirmDuplicate !== true) {
      throw new RegistrationError("invalid-argument", "入力が正しくありません");
    }
    await consumeRate(user.uid, "renameFacility");
    const facRef = db.doc(`facilities/${data.facilityId}`);
    const [fac, mem] = await Promise.all([facRef.get(), db.doc(`facilities/${data.facilityId}/members/${user.uid}`).get()]);
    if (!(fac.exists && fac.get("status") === "active" && mem.exists && mem.get("role") === "admin")) {
      throw new RegistrationError("permission-denied", "この施設の管理者のみ施設名を変更できます");
    }
    if (fac.get("name") === name) return { status: "unchanged", name };
    if (data.confirmDuplicate !== true) {
      const dup = await findNameCandidates(nameKey(name), data.facilityId);
      if (dup.exact || dup.similarCount > 0) return { status: "duplicate-candidate", exact: dup.exact, similarCount: dup.similarCount, candidates: dup.candidates };
    }
    await facRef.update({ name, updatedAt: FieldValue.serverTimestamp() });
    return { status: "renamed", name };
  }

  /**
   * 施設の削除(施設管理者のみ)。施設は施設IDだけで特定する(施設名では特定しない)。次の場合は削除しない: 注文履歴がある / 自分以外の所属ユーザーがいる。
   * 削除するのは、その施設の配下のデータ(所属・担当医・採用IOL・ディーラー・表示設定・操作履歴など)と、その施設宛ての招待・参加待ち、
   * 作成者のセルフ登録の利用枠(1件ぶん)。1つのトランザクションで、条件の再確認と削除を行う(途中で失敗しても何も消えない)。
   * 他施設のデータには触れない。
   */
  async function deleteFacility({ auth, data }) {
    const user = assertVerifiedUser(auth);
    assertKnownKeys(data, ["facilityId", "confirmName"]);   // confirmName は旧画面との互換のため受け付けるだけで、使わない(施設IDで特定する)
    if (typeof data.facilityId !== "string" || !FACILITY_ID_RE.test(data.facilityId)) {
      throw new RegistrationError("invalid-argument", "施設の指定が正しくありません");
    }
    await consumeRate(user.uid, "deleteFacility");

    const facRef = db.doc(`facilities/${data.facilityId}`);
    const subNames = (await facRef.listCollections()).map(c => c.id);
    const NOT_ALLOWED = "この施設の管理者のみ削除できます";
    return db.runTransaction(async (tx) => {
      const [fac, actor] = await Promise.all([tx.get(facRef), tx.get(db.doc(`facilities/${data.facilityId}/members/${user.uid}`))]);
      if (!(fac.exists && fac.get("status") === "active" && actor.exists && actor.get("role") === "admin")) {
        throw new RegistrationError("permission-denied", NOT_ALLOWED);
      }
      // 注文履歴(どの形でも1件でもあれば削除しない)
      const orders = await tx.get(facRef.collection("orders").limit(1));
      if (!orders.empty) throw new RegistrationError("failed-precondition", "注文履歴がある施設は削除できません");
      const members = await tx.get(facRef.collection("members"));
      if (members.docs.some(m => m.id !== user.uid)) {
        throw new RegistrationError("failed-precondition", "ほかの利用者が所属している施設は削除できません。先に利用者を削除してください");
      }
      const subs = await Promise.all(subNames.filter(n => n !== "orders").map(n => tx.get(facRef.collection(n))));
      const invites = await tx.get(db.collection("invites").where("facilityId", "==", data.facilityId));   // 旧招待コード方式の残りのデータ(使用不能)も一緒に消す
      const pendingMembers = await tx.get(db.collection("pendingMembers").where("facilityId", "==", data.facilityId));   // この施設の参加待ち(事前登録)
      const creator = typeof fac.get("createdBy") === "string" && fac.get("selfRegistered") ? fac.get("createdBy") : null;
      const quotaRef = creator ? db.doc(`registrationQuota/${creator}`) : null;
      const quota = quotaRef ? await tx.get(quotaRef) : null;

      const refs = [...subs.flatMap(s => s.docs.map(d => d.ref)), ...invites.docs.map(d => d.ref), ...pendingMembers.docs.map(d => d.ref), facRef];
      if (refs.length > LIMITS.maxDeleteDocs) {
        throw new RegistrationError("failed-precondition", "データが多いため、この画面からは削除できません。運営者にご連絡ください");
      }
      // 書き込みは、すべての読み取りのあと
      for (const r of refs) tx.delete(r);
      if (quota && quota.exists) {
        const keys = [...(quota.get("keys") || [])];
        const i = keys.indexOf(nameKey(fac.get("name")));
        if (i >= 0) keys.splice(i, 1);
        tx.set(quotaRef, { count: Math.max(0, (quota.get("count") || 0) - 1), keys, updatedAt: FieldValue.serverTimestamp() });
      }
      return { status: "deleted", facilityId: data.facilityId };
    });
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
      if (dup.exact || dup.similarCount > 0) return { status: "duplicate-candidate", exact: dup.exact, similarCount: dup.similarCount };
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
        uid: user.uid, role: "admin",
        displayName: user.displayName, email: user.email, updatedAt: FieldValue.serverTimestamp()
      });
      tx.set(quotaRef, { count: count + 1, keys: [...keys, key], updatedAt: FieldValue.serverTimestamp() });
      return { status: "created", facilityId };
    });
  }

  return { registerFacility, checkFacilityName, renameFacility, deleteFacility };
}
