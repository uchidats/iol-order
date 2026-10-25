/**
 * 施設設定の変更履歴(auditLogs)。担当医(orderers)・採用IOL(adoptedIols)・ディーラー(facilityDealers)は画面から
 * Firestore へ直接書き込まれる(Security Rules で検証)。その変更を Firestore トリガーで受け、操作履歴に記録する。
 *
 * - 変更者: トリガーの認証情報(authType / authId)。画面からの変更は app_user + uid。Cloud Functions など Admin SDK は admin。
 * - 重複実行: トリガーは少なくとも1回の配信(同じイベントが2回届くことがある)。履歴のドキュメントIDをイベントIDから決め、
 *   create で書くため、2回目は「既にある」で何もしない(二重に記録しない)。
 * - 失敗時: 書き込みに失敗したら例外を投げ、再試行(retry: true)させる。上と同じ理由で、再試行しても二重にならない。
 * - 施設が削除済み(施設削除で設定もまとめて消えた)ときは記録しない(削除された施設の下に履歴を作らない)。
 * - 記録は最小限: 変わった項目名と、担当医名・ディーラー名・採用の有無など。メールアドレスは伏せ字(例 a***@example.jp)と
 *   短い指紋(SHA-256 の先頭8桁。同じアドレスかどうかの照合用)だけで、アドレスそのものは記録しない。
 *   並び順(sortOrder)・更新日時(updatedAt)だけの変更は記録しない。
 */
import { createHash } from "node:crypto";

export const AUDITED_COLLECTIONS = Object.freeze(["orderers", "adoptedIols", "facilityDealers"]);
const IGNORED_FIELDS = new Set(["updatedAt", "sortOrder", "facilityId"]);
const EMAIL_LIST_FIELDS = new Set(["orderEmails", "usageReportEmails"]);
const EMAIL_FIELDS = new Set(["email"]);
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

/** 履歴に表示する対象の名前(担当医名・ディーラー名・採用IOLのID) */
const labelOf = (collection, docId, data) => (collection === "adoptedIols" ? docId : text((data && data.name) || "") || docId);

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

    const actorUid = e.authType === "app_user" && e.authId ? e.authId : null;
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
        actorType: e.authType || "unknown",   // app_user(画面) / admin(サーバー処理) / unknown
        actorUid,
        ...(actorName ? { actorName } : {}),
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
