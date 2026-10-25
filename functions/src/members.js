/**
 * 利用者管理(所属)。役割と権限は roles.js(firestore.rules と一致)。
 *
 * - 所属は「ある／ない」だけで、有効・無効の状態はない。所属は uid で管理する(facilities/{施設ID}/members/{uid})。
 * - 操作できるのは、呼び出した人の施設の利用者だけ。管理者はすべての役割、副管理者は注文者・代行入力者だけを扱える
 *   (管理者・副管理者の追加・変更・削除は管理者のみ)。最後の管理者は降格できない。管理者の所属は削除できない(先に役割を変更する)。
 * - 事前登録(参加待ち): 管理者・副管理者が「名前・メールアドレス・役割」を登録する(pendingMembers/{施設ID}_{メールのハッシュ})。
 *   本人がそのメールアドレス(Firebase Authentication でメール確認済み)でログインし、参加確認で承認すると所属になる。
 *   有効期限は30日(サーバーで検証)。期限切れ・辞退は、管理者・副管理者が再登録できる。
 * - 重要な操作(追加・取り消し・再登録・参加・辞退・役割変更・削除)は、操作履歴(auditLogs)に同じトランザクションで記録する。
 *   操作履歴は Firestore Security Rules で、クライアントから作成・変更・削除できない(追記のみ・Cloud Functionsだけが書く)。
 * - 所属を削除した人宛ての、未使用の招待コード・参加待ちは取り消す。
 */
import { createHash } from "node:crypto";
import { RegistrationError, assertVerifiedUser, normalizeName } from "./registration.js";
import { ROLES, MEMBER_ROLES, isManagerRole, canManageRole } from "./roles.js";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PENDING_ID = /^[A-Za-z0-9_-]{1,128}_[0-9a-f]{64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 参加待ちの有効期限(30日)
const NAME_MAX = 50;
const RATE = {
  windowMs: 60 * 60 * 1000,
  max: { removeMember: 60, addMember: 60, cancelPendingMember: 60, renewPendingMember: 60, changeMemberRole: 60, listMyPendingMemberships: 120, respondMembership: 30, updateMember: 120, updatePendingMember: 60 }
};
const ROLE_LABEL = { admin: "管理者", subadmin: "副管理者", orderer: "注文者", proxy: "代行入力者" };
const NOT_MANAGER = "この施設の管理者・副管理者のみ操作できます";
const INVALID_PENDING = "参加の確認ができませんでした。登録が取り消された、期限切れ、または別のメールアドレス宛ての可能性があります";

export const emailHash = (email) => createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex");
export const pendingIdOf = (facilityId, email) => `${facilityId}_${emailHash(email)}`;

function badInput() { return new RegistrationError("invalid-argument", "入力内容を確認してください"); }
function assertShape(data, allowed, required = allowed) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw badInput();
  if (Object.keys(data).some(k => !allowed.includes(k))) throw badInput();
  if (required.some(k => data[k] === undefined)) throw badInput();
}
const assertId = (v) => { if (typeof v !== "string" || !ID.test(v)) throw badInput(); return v; };
function parseEmail(v) {
  const email = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw new RegistrationError("invalid-argument", "メールアドレスの形式が正しくありません");
  return email;
}
function parseName(v) {
  const name = typeof v === "string" ? normalizeName(v) : "";
  if (!name || name.length > NAME_MAX) throw new RegistrationError("invalid-argument", `名前は1〜${NAME_MAX}文字で入力してください`);
  return name;
}
function parseRole(v) {
  if (typeof v !== "string" || !MEMBER_ROLES.includes(v)) throw new RegistrationError("invalid-argument", "役割が正しくありません");
  return v;
}

/**
 * @param {object} deps
 * @param {import("firebase-admin/firestore").Firestore} deps.db
 * @param {typeof import("firebase-admin/firestore").FieldValue} deps.FieldValue
 * @param {{fromMillis:Function}} deps.Timestamp
 * @param {() => number} [deps.now]
 * @param {(uid:string) => Promise<string|null>} [deps.lookupEmail] 所属に記録されたメールが無い場合に、認証情報から調べる
 */
export function createMemberService({ db, FieldValue, Timestamp, now = Date.now, lookupEmail = async () => null }) {
  async function consumeRate(uid, action) {
    const ref = db.doc(`rateLimits/${uid}_${action}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const t = now();
      let start = snap.exists ? snap.get("windowStart") : 0;
      let n = snap.exists ? snap.get("count") || 0 : 0;
      if (!snap.exists || t - start >= RATE.windowMs) { start = t; n = 0; }
      if (n >= RATE.max[action]) throw new RegistrationError("resource-exhausted", "操作の回数が上限に達しました。しばらくしてからお試しください");
      tx.set(ref, { windowStart: start, count: n + 1, updatedAt: FieldValue.serverTimestamp() });
    });
  }

  /** 操作する人が、有効な施設の管理者・副管理者であること(他施設・所属なし・停止中は区別せず同じ拒否) */
  async function readManager(tx, facilityId, uid) {
    const [fac, actor] = await Promise.all([tx.get(db.doc(`facilities/${facilityId}`)), tx.get(db.doc(`facilities/${facilityId}/members/${uid}`))]);
    if (!fac.exists || fac.get("status") !== "active" || !actor.exists || !isManagerRole(actor.get("role"))) {
      throw new RegistrationError("permission-denied", NOT_MANAGER);
    }
    return { fac, actorRole: actor.get("role") };
  }
  function assertCanManage(actorRole, role) {
    if (!canManageRole(actorRole, role)) {
      throw new RegistrationError("permission-denied", actorRole === ROLES.SUBADMIN
        ? "副管理者は、管理者・副管理者の追加・変更・削除はできません"
        : NOT_MANAGER);
    }
  }
  function log(tx, facilityId, user, entry) {
    tx.create(db.collection(`facilities/${facilityId}/auditLogs`).doc(), {
      ...entry,
      actorUid: user.uid,
      ...(user.displayName ? { actorName: String(user.displayName).slice(0, 100) } : {}),
      at: FieldValue.serverTimestamp()
    });
  }
  const expired = (p) => !p.get("expiresAt") || p.get("expiresAt").toMillis() <= now();
  // 利用者管理の表示順(facilities/{施設ID}/displaySettings/memberOrder の order: ["m:{uid}" | "p:{参加待ちID}", ...])。画面が自動保存する
  const orderRef = (facilityId) => db.doc(`facilities/${facilityId}/displaySettings/memberOrder`);
  /** 表示順の中のキーを置き換える(参加・メールアドレスの変更で、同じ位置のまま表示する)。読み取りは呼び出し側で済ませておく */
  function replaceInOrder(tx, orderSnap, from, to) {
    if (!orderSnap || !orderSnap.exists) return;
    const list = orderSnap.get("order");
    if (!Array.isArray(list) || !list.includes(from)) return;
    tx.update(orderSnap.ref, { order: list.map(k => (k === from ? to : k)).filter((k, i, a) => a.indexOf(k) === i), updatedAt: FieldValue.serverTimestamp() });
  }
  const iso = (ms) => new Date(ms).toISOString();

  // ---------- 事前登録(参加待ち) ----------
  /** 管理者・副管理者が、名前・メールアドレス・役割を事前登録する(管理者の事前登録は不可。参加後に役割を変更する) */
  async function addMember({ auth, data }) {
    const user = assertVerifiedUser(auth);
    assertShape(data, ["facilityId", "name", "email", "role"]);
    const facilityId = assertId(data.facilityId);
    const email = parseEmail(data.email);
    const role = parseRole(data.role);
    const name = typeof data.name === "string" ? normalizeName(data.name) : "";
    if (!name || name.length > NAME_MAX) throw new RegistrationError("invalid-argument", `名前は1〜${NAME_MAX}文字で入力してください`);
    if (role === ROLES.ADMIN) throw new RegistrationError("invalid-argument", "管理者は事前登録できません。参加後に役割を変更してください");
    await consumeRate(user.uid, "addMember");

    const ref = db.doc(`pendingMembers/${pendingIdOf(facilityId, email)}`);
    return db.runTransaction(async (tx) => {
      const { fac, actorRole } = await readManager(tx, facilityId, user.uid);
      assertCanManage(actorRole, role);
      const [cur, sameEmail] = await Promise.all([tx.get(ref), tx.get(db.collection(`facilities/${facilityId}/members`).where("email", "==", email).limit(1))]);
      if (!sameEmail.empty) throw new RegistrationError("already-exists", "このメールアドレスの利用者は、既にこの施設に所属しています");
      if (cur.exists) {
        assertCanManage(actorRole, cur.get("role"));   // 副管理者は、副管理者宛ての参加待ちを上書きできない
        if (cur.get("status") === "pending" && !expired(cur)) throw new RegistrationError("already-exists", "このメールアドレスは、既に参加待ちです");
      }
      const expiresMs = now() + PENDING_TTL_MS;
      tx.set(ref, {
        facilityId, facilityName: fac.get("name") || "", email, name, role, status: "pending",
        createdBy: { uid: user.uid, name: user.displayName || null },
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(expiresMs)
      });
      log(tx, facilityId, user, { action: "member.preregister", targetEmail: email, targetName: name, targetRole: role });
      return { pendingId: ref.id, email, name, role, status: "pending", expiresAt: iso(expiresMs) };
    });
  }

  /** 参加待ちを指定して読む(施設・権限・対象の役割を確認) */
  async function readPendingForManager(tx, user, data) {
    const facilityId = assertId(data.facilityId);
    if (typeof data.pendingId !== "string" || !PENDING_ID.test(data.pendingId) || !data.pendingId.startsWith(`${facilityId}_`)) throw badInput();
    const { actorRole } = await readManager(tx, facilityId, user.uid);
    const ref = db.doc(`pendingMembers/${data.pendingId}`);
    const p = await tx.get(ref);
    if (!p.exists || p.get("facilityId") !== facilityId) throw new RegistrationError("not-found", "参加待ちが見つかりません(既に参加・取り消し済みの可能性があります)");
    assertCanManage(actorRole, p.get("role"));
    return { facilityId, ref, p, actorRole };
  }

  /** 参加待ちの取り消し(未参加の事前登録を消す) */
  async function cancelPendingMember({ auth, data }) {
    const user = assertVerifiedUser(auth);
    assertShape(data, ["facilityId", "pendingId"]);
    await consumeRate(user.uid, "cancelPendingMember");
    return db.runTransaction(async (tx) => {
      const { facilityId, ref, p } = await readPendingForManager(tx, user, data);
      tx.delete(ref);
      log(tx, facilityId, user, { action: "member.preregister.cancel", targetEmail: p.get("email"), targetRole: p.get("role"), previousStatus: p.get("status") });
      return { canceled: true };
    });
  }

  /** 参加待ちの再登録(期限切れ・辞退を、今日から30日の参加待ちに戻す) */
  async function renewPendingMember({ auth, data }) {
    const user = assertVerifiedUser(auth);
    assertShape(data, ["facilityId", "pendingId"]);
    await consumeRate(user.uid, "renewPendingMember");
    return db.runTransaction(async (tx) => {
      const { facilityId, ref, p } = await readPendingForManager(tx, user, data);
      const sameEmail = await tx.get(db.collection(`facilities/${facilityId}/members`).where("email", "==", p.get("email")).limit(1));
      if (!sameEmail.empty) throw new RegistrationError("already-exists", "このメールアドレスの利用者は、既にこの施設に所属しています");
      const expiresMs = now() + PENDING_TTL_MS;
      tx.update(ref, { status: "pending", expiresAt: Timestamp.fromMillis(expiresMs), renewedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), renewedBy: user.uid });
      log(tx, facilityId, user, { action: "member.preregister.renew", targetEmail: p.get("email"), targetRole: p.get("role"), previousStatus: p.get("status") });
      return { pendingId: ref.id, status: "pending", expiresAt: iso(expiresMs) };
    });
  }

  // ---------- 本人による参加確認 ----------
  /** ログインした本人(メール確認済み)宛ての、有効な参加待ち。返すのは施設名・役割・登録者名だけ */
  async function listMyPendingMemberships({ auth, data }) {
    const user = assertVerifiedUser(auth);   // メール確認済み(email_verified)でなければ拒否
    if (data !== undefined && data !== null) assertShape(data, []);
    await consumeRate(user.uid, "listMyPendingMemberships");
    const snap = await db.collection("pendingMembers").where("email", "==", user.email).get();
    const out = [];
    for (const p of snap.docs) {
      if (p.get("status") !== "pending" || expired(p)) continue;
      const fid = p.get("facilityId");
      const [fac, mem] = await Promise.all([db.doc(`facilities/${fid}`).get(), db.doc(`facilities/${fid}/members/${user.uid}`).get()]);
      if (!fac.exists || fac.get("status") !== "active" || mem.exists) continue;
      out.push({ pendingId: p.id, facilityId: fid, facilityName: fac.get("name") || "", role: p.get("role"), roleLabel: ROLE_LABEL[p.get("role")] || "", invitedByName: (p.get("createdBy") || {}).name || null, expiresAt: iso(p.get("expiresAt").toMillis()) });
    }
    return { memberships: out };
  }

  /** 参加の承認・辞退。メール確認済み・メールアドレスの一致・30日の期限を、ここで必ず確認する。承認すると uid の所属を作る */
  async function respondMembership({ auth, data }) {
    const user = assertVerifiedUser(auth);
    assertShape(data, ["pendingId", "accept"]);
    if (typeof data.pendingId !== "string" || !PENDING_ID.test(data.pendingId) || typeof data.accept !== "boolean") throw badInput();
    await consumeRate(user.uid, "respondMembership");
    const ref = db.doc(`pendingMembers/${data.pendingId}`);
    return db.runTransaction(async (tx) => {
      const p = await tx.get(ref);
      // 存在しない・別のメール宛て・取り消し済み・辞退済みは区別せず同じ応答(探索対策)。期限切れだけは、再登録を頼めるよう伝える
      if (!p.exists || p.get("email") !== user.email || p.get("status") !== "pending") throw new RegistrationError("failed-precondition", INVALID_PENDING);
      if (expired(p)) throw new RegistrationError("failed-precondition", "参加の有効期限(30日)が切れています。施設の管理者に再登録を依頼してください");
      const facilityId = p.get("facilityId");
      const role = p.get("role");
      if (!MEMBER_ROLES.includes(role) || role === ROLES.ADMIN) throw new RegistrationError("failed-precondition", INVALID_PENDING);
      const [fac, mem, order] = await Promise.all([tx.get(db.doc(`facilities/${facilityId}`)), tx.get(db.doc(`facilities/${facilityId}/members/${user.uid}`)), tx.get(orderRef(facilityId))]);
      if (!fac.exists || fac.get("status") !== "active") throw new RegistrationError("failed-precondition", INVALID_PENDING);

      if (!data.accept) {
        tx.update(ref, { status: "declined", respondedAt: FieldValue.serverTimestamp(), respondedBy: user.uid, updatedAt: FieldValue.serverTimestamp() });
        log(tx, facilityId, user, { action: "member.decline", targetUid: user.uid, targetEmail: user.email, targetRole: role });
        return { status: "declined", facilityId };
      }
      if (mem.exists) {   // 既に所属している(招待コードなど別の経路で参加済み)。役割は変えず、参加待ちだけ消す
        tx.delete(ref);
        return { status: "already-member", facilityId, role: mem.get("role") };
      }
      tx.create(db.doc(`facilities/${facilityId}/members/${user.uid}`), {
        uid: user.uid, role,
        displayName: p.get("name") || user.displayName || null,
        email: user.email, updatedAt: FieldValue.serverTimestamp()
      });
      tx.delete(ref);
      replaceInOrder(tx, order, `p:${data.pendingId}`, `m:${user.uid}`);   // 参加待ちの表示位置のまま、参加済みとして表示する
      log(tx, facilityId, user, { action: "member.join", via: "preregistration", targetUid: user.uid, targetEmail: user.email, targetRole: role });
      return { status: "joined", facilityId, role };
    });
  }

  // ---------- 編集(氏名・参加待ちの内容) ----------
  /**
   * 参加済みの利用者の氏名(この施設の所属に記録した表示名だけ。Firebase Authentication・他施設の所属は変えない)。
   * 自分自身の氏名は誰でも(管理者・副管理者)変更できる。他人は、その役割を扱える人だけ(副管理者は注文者・代行入力者のみ)。
   */
  async function updateMemberName({ auth, data }) {
    const user = assertVerifiedUser(auth);
    assertShape(data, ["facilityId", "uid", "name"]);
    const facilityId = assertId(data.facilityId);
    const targetUid = assertId(data.uid);
    const name = parseName(data.name);
    await consumeRate(user.uid, "updateMember");
    const targetRef = db.doc(`facilities/${facilityId}/members/${targetUid}`);
    return db.runTransaction(async (tx) => {
      const { actorRole } = await readManager(tx, facilityId, user.uid);
      const target = await tx.get(targetRef);
      if (!target.exists) throw new RegistrationError("not-found", "所属が見つかりません(既に削除されています)");
      if (targetUid !== user.uid) assertCanManage(actorRole, target.get("role"));
      const from = target.get("displayName") || null;
      if (from === name) return { changed: false, name };
      tx.update(targetRef, { displayName: name, updatedAt: FieldValue.serverTimestamp() });
      log(tx, facilityId, user, { action: "member.rename", targetUid, targetRole: target.get("role"), ...(from ? { fromName: String(from).slice(0, 100) } : {}), toName: name });
      return { changed: true, name };
    });
  }

  /**
   * 参加待ち(参加待ち・期限切れ・辞退)の氏名・メールアドレス・役割の編集。状態と期限はそのまま(期限切れ・辞退は「再登録」で戻す)。
   * メールアドレスを変えると、参加待ちのID(施設ID_メールのハッシュ)も変わる: 古い参加待ちを消し、新しいIDで作り直す(1トランザクション)。
   * 以前のメールアドレスでは参加できなくなり、新しいメールアドレス(メール確認済み)の本人だけが参加できる。表示順も引き継ぐ。
   */
  async function updatePendingMember({ auth, data }) {
    const user = assertVerifiedUser(auth);
    assertShape(data, ["facilityId", "pendingId", "name", "email", "role"]);
    const name = parseName(data.name);
    const email = parseEmail(data.email);
    const role = parseRole(data.role);
    if (role === ROLES.ADMIN) throw new RegistrationError("invalid-argument", "管理者は事前登録できません。参加後に役割を変更してください");
    await consumeRate(user.uid, "updatePendingMember");
    return db.runTransaction(async (tx) => {
      const { facilityId, ref, p, actorRole } = await readPendingForManager(tx, user, data);
      assertCanManage(actorRole, role);
      const newRef = db.doc(`pendingMembers/${pendingIdOf(facilityId, email)}`);
      const moved = newRef.id !== ref.id;
      let order = null;
      if (moved) {
        const [dst, sameEmail, ord] = await Promise.all([
          tx.get(newRef), tx.get(db.collection(`facilities/${facilityId}/members`).where("email", "==", email).limit(1)), tx.get(orderRef(facilityId))]);
        if (!sameEmail.empty) throw new RegistrationError("already-exists", "このメールアドレスの利用者は、既にこの施設に所属しています");
        if (dst.exists) throw new RegistrationError("already-exists", "このメールアドレスは、既に利用者管理に登録されています");
        order = ord;
      }
      const changes = { name, email, role, updatedAt: FieldValue.serverTimestamp(), updatedBy: user.uid };
      if (moved) {
        tx.set(newRef, { ...p.data(), ...changes });
        tx.delete(ref);
        replaceInOrder(tx, order, `p:${ref.id}`, `p:${newRef.id}`);
      } else {
        tx.update(ref, changes);
      }
      log(tx, facilityId, user, {
        action: "member.preregister.update",
        fromEmail: p.get("email"), targetEmail: email, fromRole: p.get("role"), targetRole: role,
        ...(p.get("name") !== name ? { fromName: String(p.get("name") || "").slice(0, 100), targetName: name } : {})
      });
      return { pendingId: newRef.id, name, email, role, status: p.get("status"), expiresAt: p.get("expiresAt") ? iso(p.get("expiresAt").toMillis()) : null };
    });
  }

  // ---------- 役割の変更 ----------
  /** 役割の変更。副管理者は注文者⇔代行入力者のみ。管理者・副管理者が関わる変更は管理者のみ。最後の管理者は降格できない */
  async function changeMemberRole({ auth, data }) {
    const user = assertVerifiedUser(auth);
    assertShape(data, ["facilityId", "uid", "role"]);
    const facilityId = assertId(data.facilityId);
    const targetUid = assertId(data.uid);
    const role = parseRole(data.role);
    await consumeRate(user.uid, "changeMemberRole");
    const targetRef = db.doc(`facilities/${facilityId}/members/${targetUid}`);
    return db.runTransaction(async (tx) => {
      const { actorRole } = await readManager(tx, facilityId, user.uid);
      const target = await tx.get(targetRef);
      if (!target.exists) throw new RegistrationError("not-found", "所属が見つかりません(既に削除されています)");
      const from = target.get("role");
      assertCanManage(actorRole, from);
      assertCanManage(actorRole, role);
      if (from === role) return { changed: false, role };
      if (from === ROLES.ADMIN) {
        const admins = await tx.get(db.collection(`facilities/${facilityId}/members`).where("role", "==", ROLES.ADMIN));
        if (admins.docs.filter(d => d.id !== targetUid).length === 0) throw new RegistrationError("failed-precondition", "最後の管理者の役割は変更できません。先に別の管理者を設定してください");
      }
      tx.update(targetRef, { role, updatedAt: FieldValue.serverTimestamp() });
      log(tx, facilityId, user, {
        action: "member.role", targetUid, fromRole: from, toRole: role,
        ...(target.get("displayName") ? { targetName: String(target.get("displayName")).slice(0, 100) } : {}),
        ...(target.get("email") ? { targetEmail: target.get("email") } : {})
      });
      return { changed: true, role, fromRole: from };
    });
  }

  // ---------- 所属の削除 ----------
  async function removeMember({ auth, data }) {
    const user = assertVerifiedUser(auth);
    if (!data || typeof data !== "object" || Array.isArray(data)
        || Object.keys(data).some(k => !["facilityId", "uid"].includes(k))
        || typeof data.facilityId !== "string" || !ID.test(data.facilityId)
        || typeof data.uid !== "string" || !ID.test(data.uid)) {
      throw badInput();
    }
    const { facilityId, uid: targetUid } = data;
    await consumeRate(user.uid, "removeMember");

    const targetRef = db.doc(`facilities/${facilityId}/members/${targetUid}`);

    // 所属に記録されたメールが無い古い所属は、認証情報から調べる(未使用の招待・参加待ちの取り消しに使う)
    const preTarget = await targetRef.get();
    let targetEmail = preTarget.exists ? preTarget.get("email") || null : null;
    if (preTarget.exists && !targetEmail) targetEmail = await lookupEmail(targetUid);
    targetEmail = targetEmail ? String(targetEmail).toLowerCase() : null;

    return db.runTransaction(async (tx) => {
      // 管理者・副管理者でない・他施設・存在しない施設は、区別せず同じ拒否にする
      const { actorRole } = await readManager(tx, facilityId, user.uid);
      const target = await tx.get(targetRef);
      if (targetUid === user.uid) throw new RegistrationError("failed-precondition", "自分自身の所属は削除できません");
      if (!target.exists) throw new RegistrationError("not-found", "所属が見つかりません(既に削除されています)");
      const targetRole = target.get("role");
      // 管理者の所属は削除できない(最後の管理者を守るため。先に役割を変更する)
      if (targetRole === ROLES.ADMIN) throw new RegistrationError("failed-precondition", "管理者の所属は削除できません。先に役割を変更してください");
      if (!MEMBER_ROLES.includes(targetRole)) throw new RegistrationError("failed-precondition", "削除できない権限です");
      assertCanManage(actorRole, targetRole);

      // 未使用の招待コード・参加待ち(削除する人のメール宛て)を取り消す
      let pending = [];
      let pendingMember = null;
      if (targetEmail) {
        pending = (await tx.get(db.collection("invites")
          .where("facilityId", "==", facilityId).where("email", "==", targetEmail).where("status", "==", "pending"))).docs;
        const pm = await tx.get(db.doc(`pendingMembers/${pendingIdOf(facilityId, targetEmail)}`));
        if (pm.exists) pendingMember = pm;
      }

      log(tx, facilityId, user, {
        action: "member.remove",
        targetUid, targetRole,
        ...(target.get("displayName") ? { targetName: String(target.get("displayName")).slice(0, 100) } : {}),
        ...(targetEmail ? { targetEmail } : {}),
        revokedInvites: pending.length
      });
      tx.delete(targetRef);
      for (const inv of pending) tx.update(inv.ref, { status: "revoked", revokedAt: FieldValue.serverTimestamp(), revokedBy: user.uid });
      if (pendingMember) tx.delete(pendingMember.ref);
      return { removed: true, revokedInvites: pending.length };
    });
  }

  return { removeMember, addMember, cancelPendingMember, renewPendingMember, listMyPendingMemberships, respondMembership, changeMemberRole, updateMemberName, updatePendingMember };
}
