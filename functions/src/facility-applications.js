/**
 * 新しい施設の登録は、運営者の承認制(申請 → 承認 / 却下)。
 *
 * - 申請(applyFacility。画面からは従来の registerFacility として呼ぶ): ログイン済み・メール確認済みの人が申請する。
 *   申請の時点では施設を作らず(有効化しない)、管理者の権限も付けない。facilityApplications/{申請ID} に、施設名・申請者名・
 *   メールアドレス・申請日時を保存する。申請ID = 承認後の施設ID(uid と要求IDから導出。同じ要求の再送は同じ申請)。
 *   既存施設・審査中の申請との重複候補は、確認(confirmDuplicate)なしでは申請しない。1ユーザーの申請数の上限・回数制限は従来どおり。
 * - 通知(notifyApplication): 申請の作成をきっかけに運営者へメールで知らせる。失敗しても申請は残り、結果を申請に記録する。
 * - 承認・却下(listApplications / decideApplication): 施設登録の承認権限(roles.js の canApproveFacilities。現在は運営者のみ)を
 *   サーバーで確認する。自分の申請は承認・却下できない。審査中の申請だけを、トランザクションで1回だけ処理する(二重承認・同時操作)。
 *   承認で施設を作成(有効)し、最初の管理者を決める: 申請者本人なら管理者の所属を作る。別の責任者を指定した場合は、
 *   その人のメールアドレス宛てに管理者の参加待ちを作り、本人がログイン(メール確認済み)して参加を承諾したときに管理者になる。
 *   承認・却下の履歴は申請に記録し、作成した施設の操作履歴(auditLogs)にも残す。
 * - 申請は Firestore Security Rules でクライアントから読み書きできない(Cloud Functions だけ)。
 */
import { createHash } from "node:crypto";
import { RegistrationError, assertVerifiedUser, parseRegisterInput, deriveFacilityId, nameKey, compareNames, normalizeName, LIMITS } from "./registration.js";
import { canApproveFacilities, ROLES } from "./roles.js";
import { pendingIdOf, PENDING_TTL_MS } from "./members.js";
import { isValidEmail } from "./shared/order-validation.js";

export const APPLICATION_STATUS = Object.freeze({ PENDING: "pending", APPROVED: "approved", REJECTED: "rejected" });
export const NOTIFY_STATUS = Object.freeze({ PENDING: "pending", SENDING: "sending", ACCEPTED: "accepted", FAILED: "failed", HELD: "held", NOT_CONFIGURED: "not_configured" });
const APP_ID = /^fac-[0-9a-f]{24}$/;
const REASON_MAX = 200;
const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();
const badInput = () => new RegistrationError("invalid-argument", "入力内容を確認してください");
const NOT_APPROVER = "施設登録の申請を承認できる運営者のみ操作できます";

/** 日本時間の「YYYY/MM/DD HH:mm」 */
function formatJst(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
const ms = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : null);

/** 運営者への通知メール(件名・本文)。申請者の入力は1行にして載せる */
export function buildApplicationMail(app, createdAtMs) {
  const name = oneLine(app.name);
  return {
    subject: oneLine(`【IOL Order】施設登録の申請: ${name}`),
    text: [
      "IOL Order に新しい施設の登録申請がありました。",
      "",
      `施設名: ${name}`,
      `申請者名: ${oneLine(app.applicant && app.applicant.name) || "（未入力）"}`,
      `メールアドレス: ${oneLine(app.applicant && app.applicant.email)}`,
      `申請日時: ${createdAtMs ? formatJst(createdAtMs) : "—"}`,
      "",
      "IOL Order(https://iol.medconf.jp/)にログインし、メニューの「施設登録の申請」から承認・却下してください。",
      "申請の時点では施設は有効になっておらず、管理者の権限も付与されていません。"
    ].join("\n")
  };
}

/** 審査中の申請との重複(既存施設・事前登録の施設との重複は registration.findNameCandidates)。施設名だけを数える */
export async function pendingApplicationMatches(db, key, excludeId = null) {
  const snap = await db.collection("facilityApplications").where("status", "==", APPLICATION_STATUS.PENDING).select("nameKey").get();
  let exact = false, similar = 0;
  snap.forEach(d => {
    if (d.id === excludeId) return;
    const r = compareNames(key, d.get("nameKey"));
    if (r) { similar++; if (r === "exact") exact = true; }
  });
  return { exact, similarCount: similar };
}

/**
 * @param {object} deps
 * @param {object} deps.registration createRegistrationService の戻り値(findNameCandidates・consumeRate を使う)
 */
export function createFacilityApplicationService({ db, FieldValue, Timestamp, registration, now = Date.now }) {
  const appRef = (id) => db.doc(`facilityApplications/${id}`);
  const historyEntry = (action, user, extra = {}) => ({ action, at: Timestamp.fromMillis(now()), byUid: user.uid, ...(user.email ? { byEmail: user.email } : {}), ...extra });

  const pendingNameMatches = (key, excludeId) => pendingApplicationMatches(db, key, excludeId);

  // ---------- 申請 ----------
  async function applyFacility({ auth, data }) {
    const user = assertVerifiedUser(auth);
    const input = parseRegisterInput(data);
    await registration.consumeRate(user.uid, "registerFacility");
    const key = nameKey(input.name);
    const id = deriveFacilityId(user.uid, input.requestId);
    const ref = appRef(id);
    const quotaRef = db.doc(`registrationQuota/${user.uid}`);
    const done = (snap) => ({ status: "submitted", applicationId: id, applicationStatus: snap.get("status") });

    // 同じ要求の再試行(途中失敗後・二重送信)は、保存済みの申請をそのまま返す
    const existing = await ref.get();
    if (existing.exists) {
      if ((existing.get("applicant") || {}).uid === user.uid) return done(existing);
      throw new RegistrationError("already-exists", "申請できませんでした。もう一度お試しください");
    }
    // 重複候補(既存施設・審査中の申請)。確認済みでなければ申請せず、候補の有無だけ返す
    if (!input.confirmDuplicate) {
      const [fac, pend] = await Promise.all([registration.findNameCandidates(key), pendingNameMatches(key, id)]);
      const exact = fac.exact || pend.exact, similarCount = fac.similarCount + pend.similarCount;
      if (exact || similarCount > 0) return { status: "duplicate-candidate", exact, similarCount };
    }
    return db.runTransaction(async (tx) => {
      const [cur, quota, facility] = await Promise.all([tx.get(ref), tx.get(quotaRef), tx.get(db.doc(`facilities/${id}`))]);
      if (cur.exists) {
        if ((cur.get("applicant") || {}).uid === user.uid) return done(cur);
        throw new RegistrationError("already-exists", "申請できませんでした。もう一度お試しください");
      }
      if (facility.exists) throw new RegistrationError("already-exists", "申請できませんでした。もう一度お試しください");
      const count = quota.exists ? quota.get("count") || 0 : 0;
      const keys = quota.exists ? quota.get("keys") || [] : [];
      if (count >= LIMITS.maxFacilitiesPerUser) {
        throw new RegistrationError("resource-exhausted", `施設の登録申請は1ユーザーあたり${LIMITS.maxFacilitiesPerUser}件までです`);
      }
      // 同一ユーザーの同時申請(別タブ等)でも、同名の二重申請を直列化して検出する
      if (!input.confirmDuplicate && keys.includes(key)) return { status: "duplicate-candidate", exact: true, similarCount: 1 };
      const applicantName = input.applicantName || (user.displayName ? normalizeName(user.displayName).slice(0, 50) : "") || null;
      tx.create(ref, {
        name: input.name, nameKey: key, status: APPLICATION_STATUS.PENDING,
        applicant: { uid: user.uid, email: user.email, name: applicantName },
        duplicateConfirmed: input.confirmDuplicate,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        history: [historyEntry("submitted", user)],
        notification: { status: NOTIFY_STATUS.PENDING }
      });
      tx.set(quotaRef, { count: count + 1, keys: [...keys, key], updatedAt: FieldValue.serverTimestamp() });
      return { status: "submitted", applicationId: id, applicationStatus: APPLICATION_STATUS.PENDING };
    });
  }

  // ---------- 承認・却下(施設登録の承認権限のみ) ----------
  function assertApprover(auth) {
    const user = assertVerifiedUser(auth);
    if (!canApproveFacilities(user)) throw new RegistrationError("permission-denied", NOT_APPROVER);
    return user;
  }

  /** 申請の一覧: 審査中(古い順・既存施設との重複候補つき)と、最近の承認・却下(新しい順・最大30件) */
  async function listApplications({ auth, data }) {
    assertApprover(auth);
    if (data !== undefined && data !== null && (typeof data !== "object" || Object.keys(data).length)) throw badInput();
    const view = (d) => {
      const a = d.data();
      return {
        id: d.id, name: a.name, status: a.status,
        applicant: { name: (a.applicant || {}).name || null, email: (a.applicant || {}).email || "" },
        createdAt: ms(a.createdAt), decidedAt: ms(a.decidedAt),
        decidedBy: a.decidedBy ? { name: a.decidedBy.name || null, email: a.decidedBy.email || "" } : null,
        firstAdmin: a.firstAdmin || null, reason: a.reason || "", duplicateConfirmed: a.duplicateConfirmed === true,
        notification: { status: (a.notification || {}).status || null }
      };
    };
    const [pending, decided] = await Promise.all([
      db.collection("facilityApplications").where("status", "==", APPLICATION_STATUS.PENDING).get(),
      db.collection("facilityApplications").where("status", "in", [APPLICATION_STATUS.APPROVED, APPLICATION_STATUS.REJECTED]).get()
    ]);
    const pend = [];
    for (const d of pending.docs) {
      const dup = await registration.findNameCandidates(d.get("nameKey") || nameKey(d.get("name")));
      pend.push({ ...view(d), duplicates: { exact: dup.exact, similarCount: dup.similarCount, candidates: dup.candidates } });
    }
    pend.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const recent = decided.docs.map(view).sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0)).slice(0, 30);
    return { pending: pend, recent };
  }

  /**
   * 承認・却下。data: { applicationId, decision: "approve"|"reject", firstAdmin?: { name, email }(別の責任者を最初の管理者にする), reason?, confirmDuplicate? }
   * firstAdmin を省略すると申請者本人を最初の管理者にする。
   */
  async function decideApplication({ auth, data }) {
    const user = assertApprover(auth);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw badInput();
    if (Object.keys(data).some(k => !["applicationId", "decision", "firstAdmin", "reason", "confirmDuplicate"].includes(k))) throw badInput();
    const { applicationId, decision } = data;
    if (typeof applicationId !== "string" || !APP_ID.test(applicationId) || !["approve", "reject"].includes(decision)) throw badInput();
    const reason = data.reason === undefined || data.reason === null ? "" : (typeof data.reason === "string" ? oneLine(data.reason) : null);
    if (reason === null || reason.length > REASON_MAX) throw new RegistrationError("invalid-argument", `理由は${REASON_MAX}文字以内で入力してください`);
    if (data.confirmDuplicate !== undefined && typeof data.confirmDuplicate !== "boolean") throw badInput();
    let designated = null;
    if (data.firstAdmin !== undefined && data.firstAdmin !== null) {
      if (decision !== "approve" || typeof data.firstAdmin !== "object" || Array.isArray(data.firstAdmin)) throw badInput();
      if (Object.keys(data.firstAdmin).some(k => !["name", "email"].includes(k))) throw badInput();
      const email = typeof data.firstAdmin.email === "string" ? data.firstAdmin.email.trim().toLowerCase() : "";
      const name = typeof data.firstAdmin.name === "string" ? normalizeName(data.firstAdmin.name) : "";
      if (!isValidEmail(email)) throw new RegistrationError("invalid-argument", "最初の管理者のメールアドレスの形式が正しくありません");
      if (!name || name.length > 50) throw new RegistrationError("invalid-argument", "最初の管理者のお名前は1〜50文字で入力してください");
      designated = { name, email };
    }
    const ref = appRef(applicationId);

    // 既存施設と同名の施設の承認は、確認(confirmDuplicate)が必要(重複登録の防止)
    if (decision === "approve" && data.confirmDuplicate !== true) {
      const snap = await ref.get();
      if (snap.exists && snap.get("status") === APPLICATION_STATUS.PENDING) {
        const dup = await registration.findNameCandidates(snap.get("nameKey") || nameKey(snap.get("name")));
        if (dup.exact) return { status: "duplicate-candidate", exact: true, similarCount: dup.similarCount, candidates: dup.candidates };
      }
    }

    return db.runTransaction(async (tx) => {
      const app = await tx.get(ref);
      if (!app.exists) throw new RegistrationError("not-found", "申請が見つかりません");
      const applicant = app.get("applicant") || {};
      // 自分の申請は承認・却下できない(同じアカウント・同じメールアドレス)
      if (applicant.uid === user.uid || (applicant.email && applicant.email === user.email)) {
        throw new RegistrationError("permission-denied", "自分の申請は承認・却下できません。別の運営者に依頼してください");
      }
      if (app.get("status") !== APPLICATION_STATUS.PENDING) {
        throw new RegistrationError("failed-precondition", "この申請は既に処理されています。一覧を更新してください");
      }
      const by = { uid: user.uid, email: user.email, name: user.displayName || null };
      const history = [...(app.get("history") || []), historyEntry(decision === "approve" ? "approved" : "rejected", user, reason ? { reason } : {})];

      if (decision === "reject") {
        tx.update(ref, { status: APPLICATION_STATUS.REJECTED, reason, decidedAt: FieldValue.serverTimestamp(), decidedBy: by, history, updatedAt: FieldValue.serverTimestamp() });
        return { status: APPLICATION_STATUS.REJECTED, applicationId };
      }

      // 承認: 施設を作成(有効)し、最初の管理者を決める
      const facilityId = applicationId;
      const facRef = db.doc(`facilities/${facilityId}`);
      const reads = [tx.get(facRef)];
      const pendingRef = designated ? db.doc(`pendingMembers/${pendingIdOf(facilityId, designated.email)}`) : null;
      if (pendingRef) reads.push(tx.get(pendingRef));
      const [fac] = await Promise.all(reads);
      if (fac.exists) throw new RegistrationError("failed-precondition", "この申請の施設は既に作成されています");
      tx.create(facRef, {
        name: app.get("name"), status: "active",
        createdBy: applicant.uid, selfRegistered: true, applicationId, approvedBy: by,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      });
      let firstAdmin;
      if (!designated) {
        tx.create(db.doc(`facilities/${facilityId}/members/${applicant.uid}`), {
          uid: applicant.uid, role: ROLES.ADMIN, displayName: applicant.name || null, email: applicant.email, updatedAt: FieldValue.serverTimestamp()
        });
        firstAdmin = { type: "applicant", email: applicant.email, name: applicant.name || null, status: "granted" };
      } else {
        // 別の責任者: 本人がメール確認済みのアカウントでログインし、参加を承諾したときに管理者になる(members.js の respondMembership)
        tx.set(pendingRef, {
          facilityId, facilityName: app.get("name"), email: designated.email, name: designated.name, role: ROLES.ADMIN, status: "pending",
          initialAdmin: true,   // 承認時に指定した最初の管理者(管理者の参加待ちは、この場合だけ作る)
          createdBy: { uid: user.uid, name: "IOL Order 運営者" },
          createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(now() + PENDING_TTL_MS)
        });
        firstAdmin = { type: "designated", email: designated.email, name: designated.name, status: "pending", pendingId: pendingRef.id };
      }
      tx.create(db.collection(`facilities/${facilityId}/auditLogs`).doc(), {
        action: "facility.approve", applicationId, firstAdmin: { type: firstAdmin.type, email: firstAdmin.email },
        actorUid: user.uid, ...(user.displayName ? { actorName: String(user.displayName).slice(0, 100) } : {}), at: FieldValue.serverTimestamp()
      });
      tx.update(ref, { status: APPLICATION_STATUS.APPROVED, facilityId, firstAdmin, decidedAt: FieldValue.serverTimestamp(), decidedBy: by, history, updatedAt: FieldValue.serverTimestamp() });
      return { status: APPLICATION_STATUS.APPROVED, applicationId, facilityId, firstAdmin: { type: firstAdmin.type, status: firstAdmin.status } };
    });
  }

  /**
   * 申請の削除(運営者 = platformAdmin のみ。施設登録の承認権限を委任しても、削除は運営者だけ)。審査中・却下済みだけを削除できる。
   * 承認済みは施設と対応しているため削除しない。削除はトランザクションで1回だけ行い、申請者の申請枠(registrationQuota)を1件空け、
   * 運営者の操作履歴(platformAuditLogs。クライアントから読み書き不可)に記録する。施設・所属・注文には触れない。
   */
  async function deleteApplication({ auth, data }) {
    const user = assertVerifiedUser(auth);
    if (user.isPlatformAdmin !== true) throw new RegistrationError("permission-denied", "申請の削除は運営者のみ操作できます");
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(k => k !== "applicationId")) throw badInput();
    const { applicationId } = data;
    if (typeof applicationId !== "string" || !APP_ID.test(applicationId)) throw badInput();
    const ref = appRef(applicationId);
    return db.runTransaction(async (tx) => {
      const app = await tx.get(ref);
      if (!app.exists) throw new RegistrationError("not-found", "申請が見つかりません(既に削除された可能性があります)");
      const status = app.get("status");
      if (status === APPLICATION_STATUS.APPROVED) throw new RegistrationError("failed-precondition", "承認済みの申請は、施設と対応しているため削除できません");
      if (status !== APPLICATION_STATUS.PENDING && status !== APPLICATION_STATUS.REJECTED) throw new RegistrationError("failed-precondition", "この申請は削除できません");
      const applicant = app.get("applicant") || {};
      const quotaRef = applicant.uid ? db.doc(`registrationQuota/${applicant.uid}`) : null;
      const quota = quotaRef ? await tx.get(quotaRef) : null;
      // 申請者の申請枠を1件空ける(同じ名前の再申請・上限の数え方を、申請がなかった状態に戻す)
      if (quota && quota.exists) {
        const keys = [...(quota.get("keys") || [])];
        const i = keys.indexOf(app.get("nameKey"));
        if (i >= 0) keys.splice(i, 1);
        tx.update(quotaRef, { count: Math.max(0, (quota.get("count") || 0) - 1), keys, updatedAt: FieldValue.serverTimestamp() });
      }
      tx.delete(ref);
      const email = String(applicant.email || "");
      tx.create(db.collection("platformAuditLogs").doc(), {
        action: "facilityApplication.delete", applicationId, applicationStatus: status, facilityName: app.get("name") || "",
        applicantUid: applicant.uid || null, applicantEmailMasked: email ? email.replace(/^(.).*?@/, "$1***@") : null,
        historyCount: (app.get("history") || []).length,
        actorUid: user.uid, actorEmail: user.email, at: FieldValue.serverTimestamp()
      });
      return { status: "deleted", applicationId };
    });
  }

  return { applyFacility, listApplications, decideApplication, deleteApplication };
}

/**
 * 運営者への通知(申請の作成をきっかけに1回)。送信の可否・宛先は送信の設定に従う
 * (MAIL_SENDING_ENABLED=false → held、MAIL_TEST_ONLY=true → テスト用の宛先だけ、宛先が未設定 → not_configured)。
 * 二重送信の防止: 送信前にトランザクションで「送信中」にし、配信サービスへ申請ごとに固定の冪等キーを付ける。失敗しても申請は残る。
 */
export function createApplicationNotifier({ db, FieldValue, getSender, isEnabled, recipients, testOnly = () => false, testRecipient = () => "" }) {
  async function notify(ref) {
    const claim = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || (snap.get("notification") || {}).status !== NOTIFY_STATUS.PENDING) return null;
      if (!isEnabled()) { tx.update(ref, { notification: { status: NOTIFY_STATUS.HELD, at: FieldValue.serverTimestamp() } }); return { done: true }; }
      const to = (testOnly() ? [testRecipient()] : recipients()).map(e => String(e || "").trim().toLowerCase()).filter(e => isValidEmail(e));
      if (!to.length) { tx.update(ref, { notification: { status: NOTIFY_STATUS.NOT_CONFIGURED, at: FieldValue.serverTimestamp() } }); return { done: true }; }
      tx.update(ref, { notification: { status: NOTIFY_STATUS.SENDING, at: FieldValue.serverTimestamp() } });
      return { done: false, to, app: snap.data(), test: testOnly() };
    });
    if (!claim || claim.done) return claim ? "settled" : "skipped";
    const mail = buildApplicationMail(claim.app, ms(claim.app.createdAt));
    const key = "iol-app-" + createHash("sha256").update(ref.path).digest("hex").slice(0, 40);
    let r;
    try {
      r = await getSender().send({ to: claim.to, subject: claim.test ? `【テスト】${mail.subject}` : mail.subject, text: mail.text, fromName: "IOL Order",
        replyTo: claim.test ? null : [claim.app.applicant && claim.app.applicant.email].filter(Boolean), idempotencyKey: key });
    } catch (e) { r = { ok: false, error: String((e && e.message) || e).slice(0, 300) }; }
    await ref.update({ notification: r.ok
      ? { status: NOTIFY_STATUS.ACCEPTED, at: FieldValue.serverTimestamp(), providerMessageId: r.id, sentTo: claim.test ? "test" : "operators" }
      : { status: NOTIFY_STATUS.FAILED, at: FieldValue.serverTimestamp(), error: String(r.error || "").slice(0, 300) } });
    return r.ok ? NOTIFY_STATUS.ACCEPTED : NOTIFY_STATUS.FAILED;
  }
  return { notify };
}
