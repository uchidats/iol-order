/**
 * 施設設定の変更履歴(auditLogs)。担当医(orderers)・採用IOL(adoptedIols)・ディーラー(facilityDealers)は画面から
 * Firestore へ直接書き込まれる(Security Rules で検証)。その変更を Firestore トリガーで受け、操作履歴に記録する。
 *
 * - 変更者(resolveActor): Rules が検証した値を優先する。
 *   ① 作成・更新: updatedBy(Rules が「本人の uid」かつ「updatedAt = この書き込みの時刻」を検証)。この書き込みで updatedAt が
 *      新しくなった場合だけ使う(Admin SDK が updatedAt を変えずに書いた場合、古い updatedBy を使わない)。
 *   ② 削除: 同じ一括書き込みで書かれた削除の記録(deletionMarks。Rules が本人の uid・時刻を検証)。削除の時刻に近いものだけ使う。
 *   ③ Auth Context(authType / authId)は補助。service_account / system はサーバー処理。①②がなく authType が app_user で、
 *      authId がこの施設の所属の uid と一致するときだけ、未検証(actorVerified: false)の変更者として記録する。
 *   authId は、サービスアカウント(個人ではない)のときだけ記録する。それ以外は「変更者と一致したか」だけを残す。
 * - 重複実行: トリガーは少なくとも1回の配信(同じイベントが2回届くことがある)。履歴のドキュメントIDをイベントIDから決め、
 *   create で書くため、2回目は「既にある」で何もしない(二重に記録しない)。
 * - 失敗時: 書き込みに失敗したら例外を投げ、再試行(retry: true)させる。上と同じ理由で、再試行しても二重にならない。
 * - 施設が削除済み(施設削除で設定もまとめて消えた)ときは記録しない(削除された施設の下に履歴を作らない)。
 * - 記録は最小限: 変わった項目名と、担当医名・ディーラー名・採用の有無など。メールアドレスは伏せ字(例 a***@example.jp)と
 *   短い指紋(SHA-256 の先頭8桁。同じアドレスかどうかの照合用)だけで、アドレスそのものは記録しない。
 *   並び順(sortOrder)・更新日時(updatedAt)だけの変更は記録しない。
 */
import { createHash } from "node:crypto";

export const AUDITED_COLLECTIONS = Object.freeze(["orderers", "adoptedIols", "facilityDealers", "settings"]);
const IGNORED_FIELDS = new Set(["updatedAt", "updatedBy", "sortOrder", "facilityId"]);
const EMAIL_LIST_FIELDS = new Set(["orderEmails", "usageReportEmails"]);
const EMAIL_FIELDS = new Set(["email", "copyEmail"]);
const TEXT_MAX = 100;

const text = (v) => (typeof v === "string" ? v.slice(0, TEXT_MAX) : v === undefined ? null : v);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** メールアドレスを伏せ字と指紋にする(アドレスそのものは返さない)。形式が不正なものは指紋だけ */
export function maskEmail(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return null;
  const fp = createHash("sha256").update(v).digest("hex").slice(0, 8);
  const at = v.lastIndexOf("@");
  return { masked: at > 0 ? `${v[0]}***@${v.slice(at + 1)}`.slice(0, TEXT_MAX) : "***", fp };
}

const emailList = (v) => (Array.isArray(v) ? v : []).map(maskEmail).filter(Boolean);

/** 1件の変更内容(変わった項目だけ)。記録する必要がなければ null */
export function describeSettingChange(before, after) {
  const b = before || {}, a = after || {};
  const action = !before ? "create" : !after ? "delete" : "update";
  const changes = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (IGNORED_FIELDS.has(k) || same(b[k], a[k])) continue;
    if (EMAIL_LIST_FIELDS.has(k)) {
      const bs = emailList(b[k]), as = emailList(a[k]);
      const bf = new Set(bs.map(x => x.fp)), af = new Set(as.map(x => x.fp));
      const added = as.filter(x => !bf.has(x.fp)), removed = bs.filter(x => !af.has(x.fp));
      if (!added.length && !removed.length && bs.length === as.length) continue;   // 大文字小文字・前後の空白だけの違い
      changes[k] = { added, removed, countBefore: bs.length, countAfter: as.length };
    } else if (EMAIL_FIELDS.has(k)) {
      const x = maskEmail(b[k]), y = maskEmail(a[k]);
      if (same(x, y)) continue;
      changes[k] = { before: x, after: y };
    } else {
      changes[k] = { before: text(b[k]), after: text(a[k]) };
    }
  }
  if (action === "update" && !Object.keys(changes).length) return null;
  return { action, changes };
}

const SERVER_AUTH_TYPES = new Set(["service_account", "system"]);
const MARK_WINDOW_MS = 2 * 60 * 1000;   // 削除の記録と削除イベントの時刻の許容差
const UID = /^[A-Za-z0-9_-]{1,128}$/;
const millis = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : null);

/** この書き込みで updatedAt が新しくなったか(Rules を通した画面の書き込みは必ず新しくなる) */
function freshlyStamped(before, after) {
  const a = millis(after && after.updatedAt);
  if (a === null) return false;
  const b = millis(before && before.updatedAt);
  return b === null || a !== b;
}

/**
 * 変更者を決める(純粋関数)。mark は削除の記録(deletionMarks のデータ。なければ null)、isMember(uid) は所属の確認。
 * @returns {Promise<{actorType:"user"|"server"|"unknown", actorUid:string|null, actorSource:string|null, actorVerified:boolean}>}
 */
export async function resolveActor({ before, after, authType, authId, time, mark = null, isMember = async () => false }) {
  const user = (uid, source, verified = true) => ({ actorType: "user", actorUid: uid, actorSource: source, actorVerified: verified });
  if (SERVER_AUTH_TYPES.has(authType)) return { actorType: "server", actorUid: null, actorSource: "authContext", actorVerified: true };
  if (after) {
    if (typeof after.updatedBy === "string" && UID.test(after.updatedBy) && freshlyStamped(before, after)) return user(after.updatedBy, "updatedBy");
  } else if (mark && typeof mark.deletedBy === "string" && UID.test(mark.deletedBy)) {
    const at = millis(mark.deletedAt), t = Date.parse(time || "");
    const prev = millis(before && before.updatedAt);
    if (at !== null && Number.isFinite(t) && Math.abs(at - t) <= MARK_WINDOW_MS && (prev === null || at >= prev)) return user(mark.deletedBy, "deletionMark");
  }
  if (authType === "app_user" && typeof authId === "string" && UID.test(authId) && await isMember(authId)) return user(authId, "authContext", false);
  return { actorType: "unknown", actorUid: null, actorSource: null, actorVerified: false };
}

/** 診断用の認証情報。authId はサービスアカウントのときだけ(個人の識別情報は残さない) */
export function authDiagnostics(authType, authId, actorUid) {
  const d = { type: authType || "unknown" };
  if (authType === "service_account" && typeof authId === "string") d.id = authId.slice(0, TEXT_MAX);
  if (actorUid && typeof authId === "string") d.idMatchesActor = authId === actorUid;
  return d;
}

/** 履歴に表示する対象の名前(担当医名・ディーラー名・採用IOLのID) */
const labelOf = (collection, docId, data) => (collection === "adoptedIols" || collection === "settings" ? docId : text((data && data.name) || "") || docId);

/**
 * @param {object} deps
 * @param {import("firebase-admin/firestore").Firestore} deps.db
 * @param {typeof import("firebase-admin/firestore").FieldValue} deps.FieldValue
 */
export function createSettingsAuditService({ db, FieldValue }) {
  /**
   * @param {{eventId:string, collection:string, facilityId:string, docId:string, before:object|null, after:object|null,
   *          authType?:string, authId?:string, time?:string}} e
   * @returns {Promise<"recorded"|"duplicate"|"skipped">}
   */
  async function recordSettingChange(e) {
    if (!AUDITED_COLLECTIONS.includes(e.collection)) return "skipped";
    const diff = describeSettingChange(e.before, e.after);
    if (!diff) return "skipped";
    const fac = await db.doc(`facilities/${e.facilityId}`).get();
    if (!fac.exists) return "skipped";   // 施設の削除に伴う設定の削除

    const mark = !e.after ? await db.doc(`facilities/${e.facilityId}/deletionMarks/${e.collection}_${e.docId}`).get() : null;
    const actor = await resolveActor({
      before: e.before, after: e.after, authType: e.authType, authId: e.authId, time: e.time,
      mark: mark && mark.exists ? mark.data() : null,
      isMember: async (uid) => (await db.doc(`facilities/${e.facilityId}/members/${uid}`).get()).exists
    });
    const actorUid = actor.actorUid;
    let actorName = null;
    if (actorUid) {
      const m = await db.doc(`facilities/${e.facilityId}/members/${actorUid}`).get();
      actorName = m.exists && m.get("displayName") ? String(m.get("displayName")).slice(0, TEXT_MAX) : null;
    }
    const id = "s_" + String(e.eventId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
    try {
      await db.doc(`facilities/${e.facilityId}/auditLogs/${id}`).create({
        action: `settings.${e.collection}.${diff.action}`,
        target: { collection: e.collection, id: e.docId, label: labelOf(e.collection, e.docId, e.after || e.before) },
        changes: diff.changes,
        actorType: actor.actorType,           // user(利用者) / server(サーバー処理) / unknown(不明)
        actorUid,
        ...(actorName ? { actorName } : {}),
        actorSource: actor.actorSource,       // updatedBy / deletionMark(Rules で検証済み) / authContext / null
        actorVerified: actor.actorVerified,
        auth: authDiagnostics(e.authType, e.authId, actorUid),
        changedAt: e.time || null,            // 変更の時刻(イベントの時刻)
        at: FieldValue.serverTimestamp(),     // 記録した時刻
        eventId: String(e.eventId)
      });
      return "recorded";
    } catch (err) {
      if (err && (err.code === 6 || err.code === "already-exists")) return "duplicate";   // 同じイベントの再配信
      throw err;   // 再試行させる
    }
  }
  return { recordSettingChange };
}
