/**
 * 施設の事前登録(運営者 = platformAdmin のみ)。運営者が承認済みの施設をあらかじめ登録し、初期管理者が参加を承諾したときに利用を始める。
 *
 * - 事前登録: 施設を status "preregistered"(未有効)で作り、初期管理者のメールアドレス宛てに管理者の参加待ち
 *   (pendingMembers。role admin・initialAdmin・preregistration)を作る。この時点では所属(管理者の権限)を作らない。
 *   未有効の施設には所属がないため、誰も読めず、注文もできない(注文の受付には施設の有効化と許可リストの両方が必要)。
 * - 参加: 指定のメールアドレス(メール確認済み)でログインした本人が、参加確認で「参加する」を押すと、members.js の
 *   respondMembership が同じトランザクションで施設を有効化し、その人を最初の管理者にする。運営者の再承認は不要。
 * - 重複: 施設名は、登録済み・事前登録済みの施設(registration.findNameCandidates は状態を問わず数える)と、審査中の申請の
 *   両方と、既存の表記ゆれ判定で照合する。一般の利用者が同名の施設を申請しようとしたときも、同じ照合で重複候補になる。
 * - 編集(施設名・初期管理者)・取り消しは、未有効(承諾前)の間だけ。操作は運営者の操作履歴(platformAuditLogs)に記録する。
 */
import { RegistrationError, assertVerifiedUser, deriveFacilityId, nameKey, normalizeName, LIMITS } from "./registration.js";
import { ROLES } from "./roles.js";
import { pendingIdOf, PENDING_TTL_MS } from "./members.js";
import { pendingApplicationMatches } from "./facility-applications.js";
import { isValidEmail } from "./shared/order-validation.js";

export const PREREGISTERED = "preregistered";
const FACILITY_ID = /^fac-[0-9a-f]{24}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
const badInput = () => new RegistrationError("invalid-argument", "入力内容を確認してください");
const NOT_OPERATOR = "施設の事前登録は運営者のみ操作できます";
const maskEmail = (e) => String(e || "").replace(/^(.).*?@/, "$1***@");

function parseFields(data, { required }) {
  const out = {};
  if (data.name !== undefined || required) {
    const name = typeof data.name === "string" ? normalizeName(data.name) : "";
    if (!name || name.length > LIMITS.nameMax) throw new RegistrationError("invalid-argument", `施設名は1〜${LIMITS.nameMax}文字で入力してください`);
    out.name = name;
  }
  if (data.adminEmail !== undefined || required) {
    const email = typeof data.adminEmail === "string" ? data.adminEmail.trim().toLowerCase() : "";
    if (!isValidEmail(email)) throw new RegistrationError("invalid-argument", "初期管理者のメールアドレスの形式が正しくありません");
    out.adminEmail = email;
  }
  if (data.adminName !== undefined && data.adminName !== null && data.adminName !== "") {
    const n = typeof data.adminName === "string" ? normalizeName(data.adminName) : null;
    if (n === null || n.length > 50) throw new RegistrationError("invalid-argument", "初期管理者のお名前は50文字以内で入力してください");
    out.adminName = n;
  } else if (data.adminName !== undefined) out.adminName = "";
  if (data.confirmDuplicate !== undefined && typeof data.confirmDuplicate !== "boolean") throw badInput();
  return out;
}

export function createFacilityPreregistrationService({ db, FieldValue, Timestamp, registration, now = Date.now }) {
  function assertOperator(auth) {
    const user = assertVerifiedUser(auth);
    if (user.isPlatformAdmin !== true) throw new RegistrationError("permission-denied", NOT_OPERATOR);
    return user;
  }
  const audit = (tx, user, entry) => tx.create(db.collection("platformAuditLogs").doc(), { ...entry, actorUid: user.uid, actorEmail: user.email, at: FieldValue.serverTimestamp() });
  /** 登録済み・事前登録済みの施設、審査中の申請との重複(excludeFacilityId: 編集中の自分の事前登録は数えない) */
  async function duplicates(name, excludeFacilityId = null) {
    const key = nameKey(name);
    const [fac, pend] = await Promise.all([registration.findNameCandidates(key, excludeFacilityId), pendingApplicationMatches(db, key)]);
    return { exact: fac.exact || pend.exact, similarCount: fac.similarCount + pend.similarCount, candidates: fac.candidates };
  }
  const pendingRef = (facilityId, email) => db.doc(`pendingMembers/${pendingIdOf(facilityId, email)}`);
  const pendingData = (facilityId, name, email, adminName, user) => ({
    facilityId, facilityName: name, email, name: adminName || "", role: ROLES.ADMIN, status: "pending",
    initialAdmin: true, preregistration: true,   // 事前登録の初期管理者(承諾で施設を有効化する。members.js)
    createdBy: { uid: user.uid, name: "IOL Order 運営者" },
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(now() + PENDING_TTL_MS)
  });

  /** 事前登録。data: { name, adminEmail, adminName?, requestId, confirmDuplicate? } */
  async function preregisterFacility({ auth, data }) {
    const user = assertOperator(auth);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw badInput();
    if (Object.keys(data).some(k => !["name", "adminEmail", "adminName", "requestId", "confirmDuplicate"].includes(k))) throw badInput();
    if (typeof data.requestId !== "string" || !REQUEST_ID_RE.test(data.requestId)) throw badInput();
    const f = parseFields(data, { required: true });
    const facilityId = deriveFacilityId(user.uid, data.requestId);
    const facRef = db.doc(`facilities/${facilityId}`);
    const existing = await facRef.get();
    if (existing.exists) {   // 同じ要求の再送は、作成済みの事前登録を返す
      if (existing.get("preregisteredBy") && existing.get("preregisteredBy").uid === user.uid) return { status: "exists", facilityId };
      throw new RegistrationError("already-exists", "登録できませんでした。もう一度お試しください");
    }
    if (data.confirmDuplicate !== true) {
      const dup = await duplicates(f.name);
      if (dup.exact || dup.similarCount > 0) return { status: "duplicate-candidate", ...dup };
    }
    return db.runTransaction(async (tx) => {
      const fac = await tx.get(facRef);
      if (fac.exists) return { status: "exists", facilityId };
      tx.create(facRef, {
        name: f.name, status: PREREGISTERED, selfRegistered: false,
        preregisteredBy: { uid: user.uid, email: user.email }, initialAdminEmail: f.adminEmail,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      });
      tx.set(pendingRef(facilityId, f.adminEmail), pendingData(facilityId, f.name, f.adminEmail, f.adminName, user));
      audit(tx, user, { action: "facility.preregister", facilityId, facilityName: f.name, initialAdminEmailMasked: maskEmail(f.adminEmail) });
      return { status: "created", facilityId };
    });
  }

  /** 事前登録の一覧(未有効の施設と、初期管理者の参加待ちの状態) */
  async function listPreregistrations({ auth, data }) {
    assertOperator(auth);
    if (data !== undefined && data !== null && (typeof data !== "object" || Object.keys(data).length)) throw badInput();
    const facs = await db.collection("facilities").where("status", "==", PREREGISTERED).get();
    const t = now();
    const out = [];
    for (const d of facs.docs) {
      const email = d.get("initialAdminEmail") || "";
      const p = email ? await pendingRef(d.id, email).get() : null;
      const exp = p && p.exists && p.get("expiresAt") ? p.get("expiresAt").toMillis() : null;
      const state = !p || !p.exists ? "missing" : p.get("status") === "declined" ? "declined" : exp !== null && exp <= t ? "expired" : "pending";
      out.push({ facilityId: d.id, name: d.get("name"), adminEmail: email, adminName: p && p.exists ? p.get("name") || "" : "",
        state, expiresAt: exp, createdAt: d.get("createdAt") ? d.get("createdAt").toMillis() : null });
    }
    out.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    return { preregistrations: out };
  }

  /** 編集(未有効の間だけ)。施設名・初期管理者のメールアドレス・お名前。初期管理者の参加の期限は今日から30日に延びる */
  async function updatePreregistration({ auth, data }) {
    const user = assertOperator(auth);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw badInput();
    if (Object.keys(data).some(k => !["facilityId", "name", "adminEmail", "adminName", "confirmDuplicate"].includes(k))) throw badInput();
    if (typeof data.facilityId !== "string" || !FACILITY_ID.test(data.facilityId)) throw badInput();
    const f = parseFields(data, { required: false });
    const facRef = db.doc(`facilities/${data.facilityId}`);
    if (f.name !== undefined && data.confirmDuplicate !== true) {
      const cur = await facRef.get();
      if (cur.exists && cur.get("name") !== f.name) {
        const dup = await duplicates(f.name, data.facilityId);
        if (dup.exact || dup.similarCount > 0) return { status: "duplicate-candidate", ...dup };
      }
    }
    return db.runTransaction(async (tx) => {
      const fac = await tx.get(facRef);
      if (!fac.exists || fac.get("status") !== PREREGISTERED) throw new RegistrationError("failed-precondition", "参加の承諾が済んだ施設、または取り消された施設は編集できません");
      const oldEmail = fac.get("initialAdminEmail");
      const oldRef = pendingRef(data.facilityId, oldEmail);
      const old = await tx.get(oldRef);
      const name = f.name !== undefined ? f.name : fac.get("name");
      const email = f.adminEmail !== undefined ? f.adminEmail : oldEmail;
      const adminName = f.adminName !== undefined ? f.adminName : (old.exists ? old.get("name") || "" : "");
      if (email !== oldEmail && old.exists) tx.delete(oldRef);   // 以前のメールアドレスでは参加できなくする
      tx.set(pendingRef(data.facilityId, email), pendingData(data.facilityId, name, email, adminName, user));
      tx.update(facRef, { name, initialAdminEmail: email, updatedAt: FieldValue.serverTimestamp() });
      audit(tx, user, { action: "facility.preregistration.update", facilityId: data.facilityId, facilityName: name,
        nameChanged: name !== fac.get("name"), initialAdminChanged: email !== oldEmail, initialAdminEmailMasked: maskEmail(email) });
      return { status: "updated", facilityId: data.facilityId };
    });
  }

  /** 取り消し(未有効の間だけ)。施設と初期管理者の参加待ちを削除する(施設は未有効のため、所属・注文はない) */
  async function cancelPreregistration({ auth, data }) {
    const user = assertOperator(auth);
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(k => k !== "facilityId")) throw badInput();
    if (typeof data.facilityId !== "string" || !FACILITY_ID.test(data.facilityId)) throw badInput();
    const facRef = db.doc(`facilities/${data.facilityId}`);
    return db.runTransaction(async (tx) => {
      const fac = await tx.get(facRef);
      if (!fac.exists) throw new RegistrationError("not-found", "事前登録が見つかりません(既に取り消された可能性があります)");
      if (fac.get("status") !== PREREGISTERED) throw new RegistrationError("failed-precondition", "参加の承諾が済んだ施設は取り消せません");
      const ref = pendingRef(data.facilityId, fac.get("initialAdminEmail"));
      const p = await tx.get(ref);
      if (p.exists) tx.delete(ref);
      tx.delete(facRef);
      audit(tx, user, { action: "facility.preregistration.cancel", facilityId: data.facilityId, facilityName: fac.get("name"), initialAdminEmailMasked: maskEmail(fac.get("initialAdminEmail")) });
      return { status: "cancelled", facilityId: data.facilityId };
    });
  }

  return { preregisterFacility, listPreregistrations, updatePreregistration, cancelPreregistration };
}
