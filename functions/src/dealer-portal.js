/**
 * ディーラー専用画面(第1段階: 閲覧)。設計は docs/design/dealer-portal.md、実装の説明は docs/dealer-portal.md。
 *
 * 3条件でアクセスを限る: 会社の担当者所属(staff) × 施設が明示的に許可した取引(grant) × 自社宛ての明細。
 * - 元の注文ドキュメントはブラウザへ渡さない。API が自社宛ての明細だけを列挙して組み立てて返す(buildDealerOrderView)。
 * - 新しい領域(dealerCompanies など)は Firestore Rules でクライアントの直接の読み書きをすべて拒否し、ここだけが扱う。
 *   Admin SDK は Rules を通らないため、取得のたびにここで認可を確認する(キャッシュしない)。
 * - 施設の members にディーラーの担当者を入れない。担当者の所属は dealerCompanies/{companyId}/staff/{uid}
 *   (名前を "members" にしない: 既存の collectionGroup("members") と Rules の /{path=**}/members に巻き込まれないため)。
 * - 担当施設(staff.facilityAssignments)は表示の初期選択だけに使い、閲覧権限の判定には使わない。
 * - 閲覧の対象は、許可の後(effectiveFrom 以降)の新規注文だけ。テスト注文は除く。注文全体の共通備考は返さない。
 * - 受信の索引(receipts)は、注文の作成をきっかけに別の処理(トリガー)で作る。注文の受付・メール送信には関与しない
 *   (ここが失敗しても注文・メールは止まらない)。
 */
import { createHash, randomBytes } from "node:crypto";
import { RegistrationError, assertVerifiedUser, normalizeName } from "./registration.js";
import { isManagerRole } from "./roles.js";
import { isValidEmail } from "./shared/order-validation.js";

export const PORTAL_POLICY = Object.freeze({ accessMode: "companyWide", policyVersion: 1 });
export const STAFF_ROLES = Object.freeze(["reader", "companyAdmin"]);
export const PORTAL_LIMITS = Object.freeze({
  nameMax: 100, staffNameMax: 50, assignmentsMax: 100, facilityFilterMax: 100,
  pageDefault: 50, pageMax: 100, scanBatch: 100, scanMax: 500, rangeDaysMax: 366,
  invitationTtlMs: 30 * 24 * 60 * 60 * 1000, cursorTtlMs: 60 * 60 * 1000, reindexMax: 2000,
  // 所属の一覧(dealerStaffIndex.companyIds)の上限。参加の時点で超えるなら理由を示して止める(黙って古い所属を削らない)。確認は20件ずつ全件
  affiliationsMax: 2000, affiliationsBatch: 20,
  // 検索時点に固定した読み取り(readTime)ができる時間(Firestore は過去1時間以内)。時刻差の余裕を引く。続きのカーソルはこれを超えて使えない
  pinnedReadWindowMs: 59.5 * 60 * 1000, lateCheckMax: 200, indexRetryMaxAgeMs: 24 * 60 * 60 * 1000
});
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_MS = 9 * 60 * 60 * 1000;

const badInput = (msg = "入力内容を確認してください") => new RegistrationError("invalid-argument", msg);
/** 他社・未許可・存在しない対象を区別しない(存在が分かる情報を返さない) */
const notVisible = () => new RegistrationError("not-found", "対象を表示できません");
const noAffiliation = () => new RegistrationError("permission-denied", "ディーラー画面の利用登録が確認できません。運営者にお問い合わせください");
const disabled = () => new RegistrationError("failed-precondition", "ディーラー画面は現在ご利用いただけません");
const hash = (s, n = 32) => createHash("sha256").update(s).digest("hex").slice(0, n);
const normEmail = (e) => (typeof e === "string" ? e.trim().toLowerCase() : "");
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const isId = (v) => typeof v === "string" && ID_RE.test(v);
const REQUEST_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** data のキーを限定する(未知のキーは拒否) */
function strict(data, allowed) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw badInput();
  for (const k of Object.keys(data)) if (!allowed.includes(k)) throw badInput();
  return data;
}

export const companyIdOf = (uid, requestId) => "dco-" + hash(`${uid}:${requestId}`, 24);
export const branchIdOf = (companyId, name) => "br-" + hash(`${companyId}:${name}`, 20);
export const invitationIdOf = (companyId, email) => "dinv-" + hash(`${companyId}:${normEmail(email)}`, 32);
export const receiptIdOf = (grantId, facilityId, orderId) => "rcp-" + hash(`${grantId}|${facilityId}|${orderId}`, 32);
const newGrantId = () => "dgr-" + randomBytes(12).toString("hex");

const millisOf = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : null);

const normEmails = (v) => [...new Set((Array.isArray(v) ? v : []).map(normEmail).filter(Boolean))].sort();
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** 許可した時点の発注先の記録(名称と発注用メール)。注文時点の発注先との照合に使う */
export function dealerSnapshotOf(snap) {
  if (!snap || !snap.exists) return null;
  const d = snap.data() || {};
  return { name: String(d.name || ""), emails: normEmails(d.orderEmails) };
}

/**
 * 注文時点の発注先が、許可した時点の発注先と同じか。注文に保存された発注先名(明細の dealer.name)と、
 * 注文と同じトランザクションで作られた注文メールの宛先(mails/d_{発注先ID} の to。発注用メールが無ければメールは作られない)で確かめる。
 * 現在の発注先の値ではなく注文時点の値を見るので、発注先を別の会社へ変えて戻しても、その間の注文は旧会社に公開しない。
 */
export function orderMatchesGrant(order, mailSnap, localDealerId, grant) {
  const snap = grant && grant.dealerSnapshot;
  if (!snap || typeof snap.name !== "string" || !Array.isArray(snap.emails)) return false;   // 記録のない許可は公開しない
  const own = ownLinesOf(order, localDealerId);
  if (!own || !own.length) return false;
  if (own.some(l => !l.dealer || l.dealer.id !== localDealerId || l.dealer.name !== snap.name)) return false;
  const to = mailSnap && mailSnap.exists ? normEmails(mailSnap.get("to")) : [];
  return sameList(to, normEmails(snap.emails));
}

/**
 * 許可した施設別発注先の実体の指紋。作成時刻(削除・同じ ID での再作成を検知)と、名称・宛名・発注用メール・連携ID
 * (同じ文書のまま別の会社へ切り替えたことを検知)から作る。並び順・使用報告用メールの変更では変わらない。
 * 許可(grant)に保存し、認可と索引の作成のたびに現在の発注先と照合する。一致しなければ、施設が取消・再許可するまで公開しない。
 * @param {FirebaseFirestore.DocumentSnapshot} snap facilities/{fid}/facilityDealers/{lid}
 * @returns {string|null}
 */
export function dealerFingerprintOf(snap) {
  if (!snap || !snap.exists) return null;
  const d = snap.data() || {};
  const ct = snap.createTime;
  const emails = Array.isArray(d.orderEmails) ? d.orderEmails.map(normEmail).sort() : [];
  return "dfp-" + hash(JSON.stringify([ct ? `${ct.seconds}.${ct.nanoseconds}` : "", String(d.name || ""), String(d.mailName || ""), emails, String(d.dealerId || "")]), 32);
}

/** 日本時間の日付(YYYY-MM-DD)の 00:00 の時刻(ms) */
export function jstDayStartMs(date) {
  if (typeof date !== "string" || !DATE_RE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) return null;
  return ms - JST_MS;
}
export const jstDateOf = (ms) => new Date(ms + JST_MS).toISOString().slice(0, 10);

/**
 * 注文から、指定の施設別発注先(localDealerId)宛ての明細を取り出す。
 * dealerId と dealer.id が両方あって食い違う明細が1つでもあれば、推測で割り当てずに null(公開しない)。
 * @returns {Array<object>|null} 原明細(順番どおり)。旧形式など発注先を特定できない明細は含めない
 */
export function ownLinesOf(order, localDealerId) {
  const lines = Array.isArray(order && order.lines) ? order.lines : [];
  const out = [];
  for (const l of lines) {
    if (!l || typeof l !== "object") continue;
    const a = typeof l.dealerId === "string" ? l.dealerId : null;
    const b = l.dealer && typeof l.dealer.id === "string" ? l.dealer.id : null;
    if (a && b && a !== b) return null;
    if ((a || b) === localDealerId) out.push(l);
  }
  return out;
}

const MAIL_LABELS = Object.freeze({
  pending: "送信待ち", sending: "送信処理中", retry: "送信処理中(再試行待ち)", accepted: "送信済み(配信サービスが受付)",
  failed: "送信できませんでした", held: "送信停止中", not_sent: "未送信(発注用メールアドレスの未登録など)"
});
const DELIVERY_LABELS = Object.freeze({ delivered: "配信済み", delayed: "配信遅延", bounced: "配信できませんでした", complained: "配信できませんでした", failed: "配信できませんでした" });
const isoOf = (v) => { const ms = millisOf(v); return ms === null ? null : new Date(ms).toISOString(); };

/**
 * ディーラーへ返す注文の表示データ(一覧・詳細で共通)。返してよい項目だけを列挙して組み立てる。
 * 返さないもの: 他社の明細・名称・宛先・通知、注文控え、共通備考(notes)、入力者(createdBy)、担当医のメール、
 * requestId・contentHash・注文全体の status / lineCount / totalQuantity / 手術日の範囲、配信サービスのID・エラー原文。
 * 明細番号は自社分だけで 1 から付け直す(原番号から他社の明細数が分からないように)。
 * @returns {object|null} 自社宛ての明細がなければ null
 */
export function buildDealerOrderView(order, localDealerId, { receiptId, facilityId } = {}) {
  const own = ownLinesOf(order, localDealerId);
  if (!own || own.length === 0) return null;
  const lines = own.map((l, i) => {
    const it = l.item || {};
    return {
      no: i + 1,
      manufacturer: String(it.manufacturer || ""), model: String(it.model || ""),
      toricModel: it.isToric ? String(it.toricModel || "") : "",
      isToric: it.isToric === true, isMultifocal: it.isMultifocal === true,
      power: String(it.power || ""), quantity: Number(it.quantity) || 0,
      surgeryDate: String(l.surgeryDate || ""),
      doctorName: String((l.doctor && l.doctor.name) || "")
    };
  });
  const n = (Array.isArray(order.notifications) ? order.notifications : [])
    .find(x => x && x.kind === "dealer" && x.dealerId === localDealerId && x.id === `d_${localDealerId}`);
  const mail = n ? {
    status: Object.prototype.hasOwnProperty.call(MAIL_LABELS, n.status) ? n.status : "unknown",
    label: MAIL_LABELS[n.status] || "状態を確認できません",
    at: isoOf(n.statusAt),
    delivery: n.delivery && DELIVERY_LABELS[n.delivery] ? { status: n.delivery, label: DELIVERY_LABELS[n.delivery], at: isoOf(n.deliveryAt) } : null
  } : null;
  return {
    receiptId: receiptId || null,
    facilityId: facilityId || order.facilityId || null,
    facilityName: String(order.facilityName || ""),
    orderNumber: String(order.orderNumber || ""),
    orderedAt: isoOf(order.createdAt),
    lineCount: lines.length,
    totalQuantity: lines.reduce((s, l) => s + l.quantity, 0),
    lines,
    mail
  };
}

/**
 * 初期表示の施設の選択: 有効な担当施設(保存済み ∩ 現在許可されている施設)があればそれ、なければ許可済みの全施設。
 * 候補の並びは、担当施設を先頭に、それ以外は施設名順。
 */
export function initialFacilitySelection(allowedFacilities, assignedIds) {
  const allowed = new Set(allowedFacilities.map(f => f.id));
  const effective = [...new Set((assignedIds || []).filter(id => allowed.has(id)))];
  const assigned = new Set(effective);
  const ordered = [...allowedFacilities].sort((a, b) =>
    (assigned.has(b.id) - assigned.has(a.id)) || String(a.name).localeCompare(String(b.name), "ja") || a.id.localeCompare(b.id));
  return {
    facilities: ordered.map(f => ({ id: f.id, name: f.name, assigned: assigned.has(f.id) })),
    assignedFacilityIds: effective,
    selectedFacilityIds: effective.length ? effective : ordered.map(f => f.id),
    selection: effective.length ? "assigned" : (ordered.length ? "all-unassigned" : "none")
  };
}

/**
 * @param {object} deps
 * @param {FirebaseFirestore.Firestore} deps.db
 * @param {object} deps.FieldValue
 * @param {object} deps.Timestamp
 * @param {object} deps.FieldPath
 * @param {() => boolean} [deps.isEnabled] ディーラー画面の機能スイッチ(注文受付・メールのスイッチとは別)。false なら API・索引作成を止める
 * @param {() => number} [deps.now]
 */
export function createDealerPortalService({ db, FieldValue, Timestamp, FieldPath, isEnabled = () => true, now = Date.now }) {
  const audit = (tx, entry) => tx.create(db.collection("dealerPortalAuditLogs").doc(), { ...entry, at: FieldValue.serverTimestamp() });
  const companyRef = (cid) => db.doc(`dealerCompanies/${cid}`);
  const staffRef = (cid, uid) => db.doc(`dealerCompanies/${cid}/staff/${uid}`);
  const staffIndexRef = (uid) => db.doc(`dealerStaffIndex/${uid}`);
  const linkRef = (fid, lid) => db.doc(`facilities/${fid}/dealerPortalLinks/${lid}`);
  const grantRef = (gid) => db.doc(`dealerPortalGrants/${gid}`);
  const policyOk = (c) => c && c.status === "active" && c.accessMode === PORTAL_POLICY.accessMode && c.policyVersion === PORTAL_POLICY.policyVersion;

  function assertOn() { if (!isEnabled()) throw disabled(); }
  function assertOperator(auth) {
    const user = assertVerifiedUser(auth);
    if (user.isPlatformAdmin !== true) throw new RegistrationError("permission-denied", "この操作は運営者のみ行えます");
    return user;
  }

  // ======================= ディーラー担当者の認可 =======================

  /**
   * 担当者の認可: メール確認済み・会社が有効で方針が既知(companyWide v1)・担当者が有効・ログインのメールが承認済みのメールと一致。
   * 毎回 Firestore から読み直す(取消・無効化の後は次の要求から拒否)。
   */
  async function authorizeStaff(auth, companyId) {
    const user = assertVerifiedUser(auth);
    if (companyId !== undefined && companyId !== null && !isId(companyId)) throw badInput();
    if (!companyId) {
      // 会社の指定なし: 所属の一覧のうち、いま有効な所属だけから選ぶ(旧会社の無効化・停止が残っていても、有効な1社なら進める)
      const valid = await validAffiliations(user);
      if (valid.length === 1) return valid[0];
      if (valid.length > 1) throw new RegistrationError("failed-precondition", "会社を選択してください");
      throw noAffiliation();
    }
    const idx = await staffIndexRef(user.uid).get();
    const companies = idx.exists && Array.isArray(idx.get("companyIds")) ? idx.get("companyIds") : [];
    if (!companies.includes(companyId)) throw noAffiliation();
    const a = await affiliationOf(user, companyId);
    if (!a) throw noAffiliation();
    return a;
  }

  /** 1社分の所属の確認(会社が有効で方針が既知・担当者が有効・承認済みのメールと一致)。無効なら null */
  async function affiliationOf(user, cid) {
    const [c, s] = await Promise.all([companyRef(cid).get(), staffRef(cid, user.uid).get()]);
    if (!c.exists || !policyOk(c.data())) return null;
    if (!s.exists || s.get("status") !== "active" || !STAFF_ROLES.includes(s.get("role")) || normEmail(s.get("approvedEmail")) !== user.email) return null;
    return { user, companyId: cid, company: c.data(), staff: s.data() };
  }

  /** 本人の有効な所属(会社名の順)。所属の一覧に載っていても、無効化・停止・メール不一致の会社は含めない */
  async function validAffiliations(user) {
    const idx = await staffIndexRef(user.uid).get();
    // 無効な旧所属が多く残っていても、有効な所属を見落とさない: 一覧をすべて、20件ずつ順に確かめてから選ぶ(件数で切らない)
    const ids = [...new Set((idx.exists && Array.isArray(idx.get("companyIds")) ? idx.get("companyIds") : []).filter(isId))];
    const found = [];
    for (let i = 0; i < ids.length; i += PORTAL_LIMITS.affiliationsBatch) {
      found.push(...(await Promise.all(ids.slice(i, i + PORTAL_LIMITS.affiliationsBatch).map(cid => affiliationOf(user, cid)))).filter(Boolean));
    }
    return found.sort((a, b) => String(a.company.name || "").localeCompare(String(b.company.name || ""), "ja") || a.companyId.localeCompare(b.companyId));
  }

  /** 会社の選択肢(本人の有効な所属だけ。会社名とIDの最小限) */
  async function myCompanies(auth, data) {
    strict(data || {}, []);
    const user = assertVerifiedUser(auth);
    return { companies: (await validAffiliations(user)).map(a => ({ companyId: a.companyId, name: String(a.company.name || "") })) };
  }

  /**
   * 会社が現在閲覧できる施設(許可が active・関連付けの currentGrantId が一致・施設が有効・施設別発注先が存在)。
   * @returns {Map<string, {facilityId, facilityName, grantId, localDealerId, effectiveFromMs}>}
   */
  async function allowedScope(companyId) {
    const grants = await db.collection("dealerPortalGrants").where("companyId", "==", companyId).where("status", "==", "active").get();
    const out = new Map();
    await Promise.all(grants.docs.map(async (g) => {
      const d = g.data();
      if (!isId(d.facilityId) || !isId(d.localDealerId) || d.audienceMode !== PORTAL_POLICY.accessMode) return;
      const [link, fac, fd] = await Promise.all([
        linkRef(d.facilityId, d.localDealerId).get(), db.doc(`facilities/${d.facilityId}`).get(),
        db.doc(`facilities/${d.facilityId}/facilityDealers/${d.localDealerId}`).get()
      ]);
      if (!link.exists || link.get("status") !== "active" || link.get("currentGrantId") !== g.id || link.get("companyId") !== companyId) return;
      if (!fac.exists || fac.get("status") !== "active" || !fd.exists) return;
      // 許可した時点と同じ発注先か(削除・再作成、別の会社への切り替えの後は、施設が取消・再許可するまで公開しない)
      if (typeof d.dealerFingerprint !== "string" || d.dealerFingerprint !== dealerFingerprintOf(fd)) return;
      const effectiveFromMs = millisOf(d.effectiveFrom);
      if (effectiveFromMs === null) return;
      if (out.has(d.facilityId)) { out.set(d.facilityId, null); return; }   // 同じ施設に有効な許可が複数ある(想定外): その施設は公開しない
      out.set(d.facilityId, { facilityId: d.facilityId, facilityName: String(fac.get("name") || ""), grantId: g.id, localDealerId: d.localDealerId, effectiveFromMs, grant: d });
    }));
    for (const [k, v] of out) if (!v) out.delete(k);
    return out;
  }

  /** 担当者の画面の初期情報。会社名・支店・閲覧できる施設(最小限)・担当施設・初期選択 */
  async function getContext(auth, data) {
    strict(data, ["companyId"]);
    const a = await authorizeStaff(auth, data.companyId);
    const scope = await allowedScope(a.companyId);
    let branch = null;
    if (isId(a.staff.branchId)) {
      const b = await db.doc(`dealerCompanies/${a.companyId}/branches/${a.staff.branchId}`).get();
      if (b.exists && b.get("status") === "active") branch = { id: b.id, name: String(b.get("name") || "") };
    }
    const sel = initialFacilitySelection([...scope.values()].map(s => ({ id: s.facilityId, name: s.facilityName })), a.staff.facilityAssignments);
    const today = jstDateOf(now());
    return {
      company: { id: a.companyId, name: String(a.company.name || "") },
      me: { name: String(a.staff.name || ""), role: a.staff.role, branch },
      ...sel,
      defaultRange: { from: jstDateOf(now() - 29 * DAY_MS), to: today },
      limits: { rangeDaysMax: PORTAL_LIMITS.rangeDaysMax, pageMax: PORTAL_LIMITS.pageMax }
    };
  }

  /** 自分の担当施設(表示用)の保存。候補は現在許可されている施設だけ。権限・許可は変わらない */
  async function setMyAssignments(auth, data) {
    strict(data, ["companyId", "facilityIds"]);
    const a = await authorizeStaff(auth, data.companyId);
    const ids = parseFacilityIds(data.facilityIds);
    const scope = await allowedScope(a.companyId);
    if (ids.some(id => !scope.has(id))) throw badInput("選択できない施設が含まれています。画面を開き直してください");
    await db.runTransaction(async (tx) => {
      const s = await tx.get(staffRef(a.companyId, a.user.uid));
      if (!s.exists || s.get("status") !== "active") throw noAffiliation();
      tx.update(s.ref, { facilityAssignments: ids, assignmentsUpdatedAt: FieldValue.serverTimestamp(), assignmentsUpdatedBy: a.user.uid });
      audit(tx, { action: "staff.assignments", companyId: a.companyId, targetUid: a.user.uid, actorUid: a.user.uid, by: "self", facilityIds: ids });
    });
    return { ok: true, assignedFacilityIds: ids };
  }

  function parseFacilityIds(v) {
    if (!Array.isArray(v) || v.length > PORTAL_LIMITS.assignmentsMax || v.some(x => !isId(x))) throw badInput();
    return [...new Set(v)];
  }

  /** 検索条件の正規化: 期間(日本時間の日付・最大366日)・施設(selected/all)・注文番号(完全一致) */
  function parseQuery(data, scope) {
    const fromMs = jstDayStartMs(data.from), toStart = jstDayStartMs(data.to);
    if (fromMs === null || toStart === null) throw badInput("期間を確認してください");
    const toMs = toStart + DAY_MS;
    if (toMs <= fromMs || (toMs - fromMs) / DAY_MS > PORTAL_LIMITS.rangeDaysMax) throw badInput(`期間は${PORTAL_LIMITS.rangeDaysMax}日以内で指定してください`);
    const ff = data.facilityFilter;
    if (!ff || typeof ff !== "object" || Array.isArray(ff)) throw badInput("施設を選択してください");
    strict(ff, ["mode", "facilityIds"]);
    let facilities;
    if (ff.mode === "all" && ff.facilityIds === undefined) facilities = [...scope.keys()];
    else if (ff.mode === "selected" && Array.isArray(ff.facilityIds) && ff.facilityIds.length <= PORTAL_LIMITS.facilityFilterMax && ff.facilityIds.every(isId)) {
      facilities = [...new Set(ff.facilityIds)];
      if (facilities.some(id => !scope.has(id))) throw badInput("選択できない施設が含まれています。施設を選び直してください");
    } else throw badInput("施設を選択してください");
    let orderNumber = null;
    if (data.orderNumber !== undefined && data.orderNumber !== null && data.orderNumber !== "") {
      if (typeof data.orderNumber !== "string" || data.orderNumber.trim().length > 40) throw badInput("注文番号を確認してください");
      orderNumber = data.orderNumber.trim();
    }
    const limit = data.limit === undefined ? PORTAL_LIMITS.pageDefault : data.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > PORTAL_LIMITS.pageMax) throw badInput();
    return { fromMs, toMs, facilities: facilities.sort(), orderNumber, limit, mode: ff.mode };
  }

  // 継続カーソル: 会社・UID・検索条件に結び付け、有効期限を付ける(位置は改ざんされても、各行を毎回認可するので範囲は広がらない)。
  // 検索時点(as: 最初のページを読んだ時点)も持ち、続きのページを同じ時点の内容で読む(listOrders)
  const queryKey = (cid, uid, q) => hash(JSON.stringify([cid, uid, q.fromMs, q.toMs, q.facilities, q.orderNumber, q.mode]), 24);
  const encodeCursor = (c) => Buffer.from(JSON.stringify(c)).toString("base64url");
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const pinnedMs = (as) => as[0] * 1000 + Math.floor(as[1] / 1e6);
  function decodeCursor(s, expect) {
    if (s === undefined || s === null) return null;
    let c;
    try { c = JSON.parse(Buffer.from(String(s), "base64url").toString("utf8")); } catch { throw badInput("検索をやり直してください"); }
    if (!c || c.v !== 2 || c.k !== expect || !isNum(c.s) || !isNum(c.n) || !isId(c.id) || !isNum(c.exp)
      || !Array.isArray(c.as) || c.as.length !== 2 || !isNum(c.as[0]) || !isNum(c.as[1])) {
      throw badInput("検索をやり直してください");
    }
    // 検索時点から読み取り可能な時間を過ぎた続きは使えない(カーソルの期限を延ばしても、固定した時点の読み取りはできない)
    if (c.exp < now() || now() - pinnedMs(c.as) > PORTAL_LIMITS.pinnedReadWindowMs) throw badInput("検索から時間が経ったため、続きを表示できません。先頭から検索し直してください");
    return c;
  }

  /** 受信一覧(自社宛て・許可済み施設・期間・施設の複数選択・注文番号)。新しい順。各行を毎回認可する */
  async function listOrders(auth, data) {
    strict(data, ["companyId", "from", "to", "facilityFilter", "orderNumber", "limit", "cursor"]);
    const a = await authorizeStaff(auth, data.companyId);
    const scope = await allowedScope(a.companyId);
    const q = parseQuery(data, scope);
    const key = queryKey(a.companyId, a.user.uid, q);
    const cursor = decodeCursor(data.cursor, key);
    const selected = new Set(q.facilities);
    const items = [];
    if (selected.size === 0) return { items, nextCursor: null, complete: true };
    const receipts = db.collection(`dealerCompanies/${a.companyId}/receipts`);
    const matches = (r) => {
      const s = scope.get(r.facilityId);
      const t = millisOf(r.orderedAt);
      return Boolean(s && selected.has(r.facilityId) && r.grantId === s.grantId && r.localDealerId === s.localDealerId
        && t !== null && t >= q.fromMs && t < q.toMs && t >= s.effectiveFromMs && (!q.orderNumber || r.orderNumber === q.orderNumber));
    };
    // 検索時点(最初のページを読んだ時点)を固定し、続きのページも同じ時点の内容を読む(読み取り専用トランザクションの readTime)。
    // 検索中に索引が追加されても、ページの間で欠けたり重なったりしない。検索時点より後に反映された注文は、newSinceSearch で知らせる(再検索で表示)
    const pinned = cursor ? new Timestamp(cursor.as[0], cursor.as[1]) : null;
    const base = receipts
      .where("orderedAt", ">=", Timestamp.fromMillis(q.fromMs)).where("orderedAt", "<", Timestamp.fromMillis(q.toMs))
      .orderBy("orderedAt", "desc").orderBy(FieldPath.documentId(), "desc");
    const { asOf, last, exhausted } = await db.runTransaction(async (tx) => {
      let after = cursor ? [new Timestamp(cursor.s, cursor.n), cursor.id] : null;
      // 走査: 新しい順に少しずつ読み、各行を認可・絞り込み。読み終えた位置をカーソルにする(走査の上限に達したら続きを返す)
      let scanned = 0, lastDoc = null, done = false, readAt = pinned;
      items.length = 0;
      scan: while (scanned < PORTAL_LIMITS.scanMax) {
        const take = Math.min(PORTAL_LIMITS.scanBatch, PORTAL_LIMITS.scanMax - scanned);
        let query = base.limit(take);
        if (after) query = query.startAfter(...after);
        const snap = await tx.get(query);
        if (!readAt) readAt = snap.readTime;   // 最初のページを読んだ時点(索引の createdAt と同じサーバーの時刻)
        for (const d of snap.docs) {
          scanned++;
          lastDoc = d;
          const r = d.data();
          if (matches(r)) {
            items.push({
              receiptId: d.id, facilityId: r.facilityId, facilityName: scope.get(r.facilityId).facilityName,
              orderNumber: String(r.orderNumber || ""), orderedAt: isoOf(r.orderedAt),
              lineCount: Number(r.lineCount) || 0, totalQuantity: Number(r.totalQuantity) || 0
            });
            if (items.length >= q.limit) break scan;
          }
        }
        if (snap.size < take) { done = true; break; }
        after = [lastDoc.get("orderedAt"), lastDoc.id];
      }
      return { asOf: readAt, last: lastDoc, exhausted: done };
    }, pinned ? { readOnly: true, readTime: pinned } : { readOnly: true });
    // 検索時点より後に反映された、この条件に合う注文があるか(あれば「再検索で最新を表示」と案内する)
    let newSinceSearch = false;
    if (asOf) {
      const late = await receipts.where("createdAt", ">", asOf).orderBy("createdAt").limit(PORTAL_LIMITS.lateCheckMax).get();
      newSinceSearch = late.size >= PORTAL_LIMITS.lateCheckMax || late.docs.some(d => matches(d.data()));
    }
    const more = !exhausted && last !== null;
    const nextCursor = more ? encodeCursor({ v: 2, k: key, s: last.get("orderedAt").seconds, n: last.get("orderedAt").nanoseconds, id: last.id, as: [asOf.seconds, asOf.nanoseconds],
      exp: Math.min(now() + PORTAL_LIMITS.cursorTtlMs, pinnedMs([asOf.seconds, asOf.nanoseconds]) + PORTAL_LIMITS.pinnedReadWindowMs) }) : null;   // 期限は検索時点の読み取り可能時間まで
    return { items, nextCursor, complete: !more, asOf: asOf ? isoOf(asOf) : null, newSinceSearch };
  }

  /** 受信の詳細(自社宛ての明細だけ)。許可・関連付け・施設・元注文を毎回確認する */
  async function getOrder(auth, data) {
    strict(data, ["companyId", "receiptId"]);
    if (!isId(data.receiptId)) throw badInput();
    const a = await authorizeStaff(auth, data.companyId);
    const rs = await db.doc(`dealerCompanies/${a.companyId}/receipts/${data.receiptId}`).get();
    if (!rs.exists) throw notVisible();
    const r = rs.data();
    const scope = await allowedScope(a.companyId);
    const s = scope.get(r.facilityId);
    if (!s || r.grantId !== s.grantId || r.localDealerId !== s.localDealerId || !isId(r.sourceOrderId)) throw notVisible();
    const os = await db.doc(`facilities/${r.facilityId}/orders/${r.sourceOrderId}`).get();
    if (!os.exists) throw notVisible();
    const order = os.data();
    const orderedMs = millisOf(order.createdAt);
    if (order.testOrder === true || order.facilityId !== r.facilityId || orderedMs === null || orderedMs < s.effectiveFromMs) throw notVisible();
    // 注文時点の発注先が、許可した時点と同じか(現在の発注先の値が同じでも、途中で別の会社宛てだった注文は返さない)
    const mail = await db.doc(`facilities/${r.facilityId}/orders/${r.sourceOrderId}/mails/d_${s.localDealerId}`).get();
    if (!orderMatchesGrant(order, mail, s.localDealerId, s.grant)) throw notVisible();
    const view = buildDealerOrderView(order, s.localDealerId, { receiptId: rs.id, facilityId: r.facilityId });
    if (!view) throw notVisible();
    view.facilityName = s.facilityName || view.facilityName;
    return view;
  }

  // ======================= 招待・参加(担当者本人) =======================

  /** 自分のメールアドレス宛ての、有効な参加待ち(会社名と役割だけ) */
  async function myInvitations(auth, data) {
    strict(data || {}, []);
    const user = assertVerifiedUser(auth);
    const snap = await db.collection("dealerCompanyInvitations").where("email", "==", user.email).where("status", "==", "pending").get();
    const out = [];
    for (const d of snap.docs) {
      const exp = millisOf(d.get("expiresAt"));
      if (exp === null || exp <= now()) continue;
      const c = await companyRef(d.get("companyId")).get();
      if (!c.exists || c.get("status") !== "active") continue;
      out.push({ invitationId: d.id, companyName: String(c.get("name") || ""), role: d.get("role") });
    }
    return { invitations: out };
  }

  /** 参加の承諾・辞退(招待先のメールアドレスでログインした本人だけ)。承諾で会社の担当者になる */
  async function respondInvitation(auth, data) {
    strict(data, ["invitationId", "accept"]);
    if (!isId(data.invitationId) || typeof data.accept !== "boolean") throw badInput();
    const user = assertVerifiedUser(auth);
    return db.runTransaction(async (tx) => {
      const inv = await tx.get(db.doc(`dealerCompanyInvitations/${data.invitationId}`));
      const exp = inv.exists ? millisOf(inv.get("expiresAt")) : null;
      if (!inv.exists || inv.get("email") !== user.email || inv.get("status") !== "pending" || exp === null || exp <= now()) {
        throw new RegistrationError("failed-precondition", "この参加の案内は利用できません(期限切れ・取り消し・使用済みの可能性があります)");
      }
      const cid = inv.get("companyId");
      const [c, idx, s, sameEmail] = await Promise.all([tx.get(companyRef(cid)), tx.get(staffIndexRef(user.uid)), tx.get(staffRef(cid, user.uid)),
        tx.get(companyRef(cid).collection("staff").where("approvedEmail", "==", user.email))]);
      if (!c.exists || c.get("status") !== "active") throw new RegistrationError("failed-precondition", "この参加の案内は利用できません");
      // 無効化(退職など)された担当者は、無効化の後に運営者が発行した案内でだけ復帰できる(無効化の前の案内が残っていても使えない)。
      // 同じ会社で同じメールの無効化済み担当者(別のアカウントを含む)すべてと照合する
      if (data.accept) {
        const issued = millisOf(inv.get("createdAt"));
        const disabled = [s, ...sameEmail.docs].filter(d => d.exists && d.get("status") !== "active");
        if (disabled.some(d => { const at = millisOf(d.get("disabledAt")); return issued === null || at === null || issued <= at; })) {
          throw new RegistrationError("failed-precondition", "この参加の案内は利用できません(期限切れ・取り消し・使用済みの可能性があります)");
        }
      }
      if (!data.accept) {
        tx.update(inv.ref, { status: "declined", respondedAt: FieldValue.serverTimestamp(), respondedUid: user.uid });
        audit(tx, { action: "staff.decline", companyId: cid, actorUid: user.uid, invitationId: inv.id });
        return { ok: true, accepted: false };
      }
      tx.set(staffRef(cid, user.uid), {
        uid: user.uid, approvedEmail: user.email, name: String(inv.get("name") || ""), role: inv.get("role"),
        branchId: inv.get("branchId") || null, status: "active",
        facilityAssignments: Array.isArray(inv.get("facilityAssignments")) ? inv.get("facilityAssignments") : (s.exists && Array.isArray(s.get("facilityAssignments")) ? s.get("facilityAssignments") : []),
        revision: (s.exists ? Number(s.get("revision")) || 0 : 0) + 1,
        joinedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), invitationId: inv.id
      });
      const ids = idx.exists && Array.isArray(idx.get("companyIds")) ? idx.get("companyIds") : [];
      const next = [...new Set([cid, ...ids])];   // 新しい所属を先頭に。古い所属は(有効かどうかにかかわらず)削らない
      if (next.length > PORTAL_LIMITS.affiliationsMax) throw new RegistrationError("failed-precondition", "所属の記録が上限を超えています。運営者にお問い合わせください");
      tx.set(staffIndexRef(user.uid), { companyIds: next, updatedAt: FieldValue.serverTimestamp() });
      tx.update(inv.ref, { status: "accepted", respondedAt: FieldValue.serverTimestamp(), respondedUid: user.uid });
      audit(tx, { action: "staff.join", companyId: cid, actorUid: user.uid, invitationId: inv.id });
      return { ok: true, accepted: true, companyId: cid };
    });
  }

  /** ディーラー画面の呼び出し(担当者・招待先本人) */
  async function portal({ auth, data }) {
    assertOn();
    const d = data && typeof data === "object" && !Array.isArray(data) ? data : null;
    if (!d || typeof d.action !== "string") throw badInput();
    const { action, ...rest } = d;
    switch (action) {
      case "context": return getContext(auth, rest);
      case "setAssignments": return setMyAssignments(auth, rest);
      case "list": return listOrders(auth, rest);
      case "get": return getOrder(auth, rest);
      case "companies": return myCompanies(auth, rest);
      case "invitations": return myInvitations(auth, rest);
      case "respond": return respondInvitation(auth, rest);
      default: throw badInput();
    }
  }

  // ======================= 施設側(管理者・副管理者): 閲覧の許可・取消 =======================

  async function assertFacilityManager(tx, user, facilityId) {
    const get = (ref) => (tx ? tx.get(ref) : ref.get());
    const [m, f] = await Promise.all([get(db.doc(`facilities/${facilityId}/members/${user.uid}`)), get(db.doc(`facilities/${facilityId}`))]);
    if (!m.exists || !isManagerRole(m.get("role"))) throw new RegistrationError("permission-denied", "この施設の管理者・副管理者のみ操作できます");
    if (!f.exists || f.get("status") !== "active") throw new RegistrationError("permission-denied", "この施設の管理者・副管理者のみ操作できます");
    return { role: m.get("role"), facility: f };
  }

  /** 施設のディーラーごとの関連付け・閲覧許可の状態(管理者・副管理者) */
  async function facilityStatus(user, data) {
    strict(data, ["facilityId"]);
    if (!isId(data.facilityId)) throw badInput();
    await assertFacilityManager(null, user, data.facilityId);
    const [dealers, links] = await Promise.all([
      db.collection(`facilities/${data.facilityId}/facilityDealers`).get(),
      db.collection(`facilities/${data.facilityId}/dealerPortalLinks`).get()
    ]);
    const linkBy = new Map(links.docs.map(d => [d.id, d.data()]));
    const out = [];
    for (const d of dealers.docs) {
      const l = linkBy.get(d.id);
      let link = null;
      if (l && isId(l.companyId)) {
        const c = await companyRef(l.companyId).get();
        let grant = null;
        if (l.status === "active" && isId(l.currentGrantId)) {
          const g = await grantRef(l.currentGrantId).get();
          // stale: 許可の後に発注先の名称・宛先が変わった・削除して作り直した(公開を止めている。取消して許可し直す)
          if (g.exists && g.get("status") === "active") grant = { effectiveFrom: isoOf(g.get("effectiveFrom")), grantedByRole: g.get("grantedByRole") || null, stale: g.get("dealerFingerprint") !== dealerFingerprintOf(d) || !g.get("dealerSnapshot") };
        }
        link = {
          companyName: c.exists ? String(c.get("name") || "") : "", companyActive: c.exists && policyOk(c.data()),
          status: l.status, revision: Number(l.revision) || 0, grant
        };
      }
      out.push({ localDealerId: d.id, dealerName: String(d.get("name") || ""), link });
    }
    out.sort((a, b) => a.dealerName.localeCompare(b.dealerName, "ja"));
    return { dealers: out };
  }

  /** 閲覧の許可・取消(管理者・副管理者)。許可は運営者が作った関連付け案に対してだけ。許可以前の注文は対象にしない */
  async function setGrant(user, data, action) {
    strict(data, ["facilityId", "localDealerId", "revision"]);
    if (!isId(data.facilityId) || !isId(data.localDealerId) || !Number.isInteger(data.revision) || data.revision < 0) throw badInput();
    const { facilityId, localDealerId } = data;
    return db.runTransaction(async (tx) => {
      const { role } = await assertFacilityManager(tx, user, facilityId);
      const [link, fd] = await Promise.all([tx.get(linkRef(facilityId, localDealerId)), tx.get(db.doc(`facilities/${facilityId}/facilityDealers/${localDealerId}`))]);
      if (!link.exists || !fd.exists) throw notVisible();
      if ((Number(link.get("revision")) || 0) !== data.revision) throw new RegistrationError("failed-precondition", "状態が変更されています。画面を開き直して確認してください");
      const cid = link.get("companyId");
      if (action === "grant") {
        if (link.get("status") === "active") throw new RegistrationError("failed-precondition", "すでに閲覧を許可しています");
        const c = await tx.get(companyRef(cid));
        if (!c.exists || !policyOk(c.data())) throw new RegistrationError("failed-precondition", "このディーラーは現在、閲覧を許可できません。運営者にお問い合わせください");
        // 同じ施設・同じ会社の有効な許可は1件まで(初版)
        const dup = await tx.get(db.collection("dealerPortalGrants").where("companyId", "==", cid).where("facilityId", "==", facilityId).where("status", "==", "active"));
        if (!dup.empty) throw new RegistrationError("failed-precondition", "この会社には、この施設の別の発注先で閲覧を許可しています");
        const gid = newGrantId();
        tx.create(grantRef(gid), {
          companyId: cid, facilityId, localDealerId, status: "active", effectiveFrom: FieldValue.serverTimestamp(),
          dealerFingerprint: dealerFingerprintOf(fd),   // 許可した時点の発注先(名称・宛先・作成時刻)。変わったら公開を止める
          dealerSnapshot: dealerSnapshotOf(fd),          // 許可した時点の名称・発注用メール。注文時点の発注先と照合する(変えて戻しても途中の注文は出さない)
          audienceMode: PORTAL_POLICY.accessMode, disclosure: { orderNotes: false, orderedBy: false },
          grantedBy: user.uid, grantedByRole: role, createdAt: FieldValue.serverTimestamp(), revision: 1
        });
        tx.update(link.ref, { status: "active", currentGrantId: gid, revision: data.revision + 1, updatedAt: FieldValue.serverTimestamp(), updatedBy: user.uid });
        audit(tx, { action: "grant.activate", companyId: cid, facilityId, localDealerId, grantId: gid, actorUid: user.uid, actorRole: role });
        return { ok: true, status: "active" };
      }
      if (link.get("status") !== "active") throw new RegistrationError("failed-precondition", "閲覧を許可していません");
      const gid = link.get("currentGrantId");
      if (isId(gid)) {
        const g = await tx.get(grantRef(gid));
        if (g.exists && g.get("status") === "active") tx.update(g.ref, { status: "revoked", revokedAt: FieldValue.serverTimestamp(), revokedBy: user.uid, revokedByRole: role, revision: (Number(g.get("revision")) || 1) + 1 });
      }
      tx.update(link.ref, { status: "revoked", currentGrantId: null, revision: data.revision + 1, updatedAt: FieldValue.serverTimestamp(), updatedBy: user.uid });
      audit(tx, { action: "grant.revoke", companyId: cid, facilityId, localDealerId, grantId: isId(gid) ? gid : null, actorUid: user.uid, actorRole: role });
      return { ok: true, status: "revoked" };
    });
  }

  /** 施設側の呼び出し */
  /**
   * 施設側の呼び出し。機能の停止中も、状態の確認と閲覧の取消だけは受け付ける(許可中の発注先は Rules で名称・メールの変更を止めているため、
   * 停止中でも施設が取消してから発注先を変更できるようにする)。許可・担当者の閲覧・索引の作成は停止中は行わない。
   */
  async function facility({ auth, data }) {
    const user = assertVerifiedUser(auth);
    const d = data && typeof data === "object" && !Array.isArray(data) ? data : null;
    if (!d || typeof d.action !== "string") throw badInput();
    const { action, ...rest } = d;
    if (action === "status") return { ...(await facilityStatus(user, rest)), portalEnabled: isEnabled() };
    if (action === "revoke") return setGrant(user, rest, action);
    if (action === "grant") { assertOn(); return setGrant(user, rest, action); }
    throw badInput();
  }

  // ======================= 運営者: 会社・支店・担当者・関連付け =======================

  async function createCompany(user, data) {
    strict(data, ["name", "requestId"]);
    const name = typeof data.name === "string" ? normalizeName(data.name) : "";
    if (!name || name.length > PORTAL_LIMITS.nameMax || typeof data.requestId !== "string" || !REQUEST_ID_RE.test(data.requestId)) throw badInput();
    const cid = companyIdOf(user.uid, data.requestId);
    return db.runTransaction(async (tx) => {
      const c = await tx.get(companyRef(cid));
      if (c.exists) return { companyId: cid, status: "exists" };
      tx.create(companyRef(cid), { name, status: "active", ...PORTAL_POLICY, createdBy: user.uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      audit(tx, { action: "company.create", companyId: cid, actorUid: user.uid, operator: true });
      return { companyId: cid, status: "created" };
    });
  }

  async function updateCompany(user, data) {
    strict(data, ["companyId", "name", "status"]);
    if (!isId(data.companyId)) throw badInput();
    const patch = {};
    if (data.name !== undefined) { const n = typeof data.name === "string" ? normalizeName(data.name) : ""; if (!n || n.length > PORTAL_LIMITS.nameMax) throw badInput(); patch.name = n; }
    if (data.status !== undefined) { if (!["active", "suspended"].includes(data.status)) throw badInput(); patch.status = data.status; }
    if (!Object.keys(patch).length) throw badInput();
    return db.runTransaction(async (tx) => {
      const c = await tx.get(companyRef(data.companyId));
      if (!c.exists) throw notVisible();
      tx.update(c.ref, { ...patch, updatedAt: FieldValue.serverTimestamp() });
      audit(tx, { action: "company.update", companyId: data.companyId, actorUid: user.uid, operator: true, fields: Object.keys(patch) });
      return { ok: true };
    });
  }

  async function upsertBranch(user, data) {
    strict(data, ["companyId", "branchId", "name", "status"]);
    if (!isId(data.companyId) || (data.branchId !== undefined && !isId(data.branchId))) throw badInput();
    const name = typeof data.name === "string" ? normalizeName(data.name) : "";
    if (!name || name.length > PORTAL_LIMITS.nameMax) throw badInput();
    if (data.status !== undefined && !["active", "inactive"].includes(data.status)) throw badInput();
    const bid = data.branchId || branchIdOf(data.companyId, name);
    return db.runTransaction(async (tx) => {
      const c = await tx.get(companyRef(data.companyId));
      if (!c.exists) throw notVisible();
      const ref = db.doc(`dealerCompanies/${data.companyId}/branches/${bid}`);
      const b = await tx.get(ref);
      if (data.branchId && !b.exists) throw notVisible();
      tx.set(ref, { name, status: data.status || (b.exists ? b.get("status") : "active"), updatedAt: FieldValue.serverTimestamp(), ...(b.exists ? {} : { createdAt: FieldValue.serverTimestamp() }) }, { merge: true });
      audit(tx, { action: "branch.upsert", companyId: data.companyId, branchId: bid, actorUid: user.uid, operator: true });
      return { branchId: bid };
    });
  }

  /** 支店は同じ会社の有効な支店だけ(null は支店なし) */
  async function checkBranch(tx, companyId, branchId) {
    if (branchId === undefined || branchId === null || branchId === "") return null;
    if (!isId(branchId)) throw badInput();
    const b = await tx.get(db.doc(`dealerCompanies/${companyId}/branches/${branchId}`));
    if (!b.exists || b.get("status") !== "active") throw badInput("支店を確認してください");
    return branchId;
  }

  async function inviteStaff(user, data) {
    strict(data, ["companyId", "email", "name", "role", "branchId"]);
    const email = normEmail(data.email);
    const name = typeof data.name === "string" ? normalizeName(data.name) : "";
    if (!isId(data.companyId) || !isValidEmail(email) || name.length > PORTAL_LIMITS.staffNameMax || !STAFF_ROLES.includes(data.role)) throw badInput();
    const iid = invitationIdOf(data.companyId, email);
    return db.runTransaction(async (tx) => {
      const c = await tx.get(companyRef(data.companyId));
      if (!c.exists || c.get("status") !== "active") throw notVisible();
      const branchId = await checkBranch(tx, data.companyId, data.branchId);
      // 同じ会社・同じメールの案内は1件(参加済み・辞退・取り消し済みでも、新しい案内として作り直す。無効化からの復帰を含む)
      tx.set(db.doc(`dealerCompanyInvitations/${iid}`), {
        companyId: data.companyId, email, name, role: data.role, branchId, status: "pending",
        expiresAt: Timestamp.fromMillis(now() + PORTAL_LIMITS.invitationTtlMs),
        createdBy: user.uid, createdAt: FieldValue.serverTimestamp()
      });
      audit(tx, { action: "staff.invite", companyId: data.companyId, invitationId: iid, actorUid: user.uid, operator: true, role: data.role });
      return { invitationId: iid };
    });
  }

  async function cancelInvitation(user, data) {
    strict(data, ["invitationId"]);
    if (!isId(data.invitationId)) throw badInput();
    return db.runTransaction(async (tx) => {
      const inv = await tx.get(db.doc(`dealerCompanyInvitations/${data.invitationId}`));
      if (!inv.exists) throw notVisible();
      if (inv.get("status") !== "pending") throw new RegistrationError("failed-precondition", "取り消せる参加待ちではありません");
      tx.update(inv.ref, { status: "cancelled", cancelledBy: user.uid, cancelledAt: FieldValue.serverTimestamp() });
      audit(tx, { action: "staff.inviteCancel", companyId: inv.get("companyId"), invitationId: inv.id, actorUid: user.uid, operator: true });
      return { ok: true };
    });
  }

  /** 担当者の無効化・再有効化・役割・支店・氏名・担当施設(運営者の代行)。所属会社・メールは変えない */
  async function updateStaff(user, data) {
    strict(data, ["companyId", "uid", "status", "role", "branchId", "name", "facilityIds"]);
    if (!isId(data.companyId) || !isId(data.uid)) throw badInput();
    return db.runTransaction(async (tx) => {
      const s = await tx.get(staffRef(data.companyId, data.uid));
      if (!s.exists) throw notVisible();
      const patch = {};
      if (data.status !== undefined) { if (!["active", "disabled"].includes(data.status)) throw badInput(); patch.status = data.status; }
      if (data.role !== undefined) { if (!STAFF_ROLES.includes(data.role)) throw badInput(); patch.role = data.role; }
      if (data.branchId !== undefined) patch.branchId = await checkBranch(tx, data.companyId, data.branchId);
      if (data.name !== undefined) { const n = typeof data.name === "string" ? normalizeName(data.name) : null; if (n === null || n.length > PORTAL_LIMITS.staffNameMax) throw badInput(); patch.name = n; }
      if (data.facilityIds !== undefined) patch.facilityAssignments = parseFacilityIds(data.facilityIds);
      if (!Object.keys(patch).length) throw badInput();
      // 無効化: 同じ会社・承認済みのメール宛ての参加待ちも同時に取り消す(無効化の前の案内で本人が復帰できないように)。時刻は承諾時の照合に使う
      const disabling = patch.status === "disabled" && s.get("status") !== "disabled";
      const inv = disabling ? await tx.get(db.doc(`dealerCompanyInvitations/${invitationIdOf(data.companyId, s.get("approvedEmail"))}`)) : null;
      if (disabling) patch.disabledAt = FieldValue.serverTimestamp();
      tx.update(s.ref, { ...patch, revision: (Number(s.get("revision")) || 0) + 1, updatedAt: FieldValue.serverTimestamp(), updatedBy: user.uid });
      if (inv && inv.exists && inv.get("status") === "pending") {
        tx.update(inv.ref, { status: "cancelled", cancelledBy: user.uid, cancelledAt: FieldValue.serverTimestamp(), cancelledReason: "staffDisabled" });
      }
      audit(tx, { action: "staff.update", companyId: data.companyId, targetUid: data.uid, actorUid: user.uid, operator: true, fields: Object.keys(patch).filter(k => k !== "disabledAt"), ...(inv && inv.exists && inv.get("status") === "pending" ? { invitationCancelled: inv.id } : {}) });
      return { ok: true };
    });
  }

  /** 施設別発注先と会社の関連付け案(この時点では閲覧は始まらない。施設の管理者・副管理者の許可が必要) */
  async function proposeLink(user, data) {
    strict(data, ["facilityId", "localDealerId", "companyId"]);
    if (!isId(data.facilityId) || !isId(data.localDealerId) || !isId(data.companyId)) throw badInput();
    return db.runTransaction(async (tx) => {
      const [f, fd, c, link] = await Promise.all([
        tx.get(db.doc(`facilities/${data.facilityId}`)), tx.get(db.doc(`facilities/${data.facilityId}/facilityDealers/${data.localDealerId}`)),
        tx.get(companyRef(data.companyId)), tx.get(linkRef(data.facilityId, data.localDealerId))
      ]);
      if (!f.exists || !fd.exists || !c.exists) throw notVisible();
      if (link.exists && link.get("status") === "active") throw new RegistrationError("failed-precondition", "閲覧を許可中の関連付けは変更できません。施設で取消してから変更してください");
      tx.set(linkRef(data.facilityId, data.localDealerId), {
        companyId: data.companyId, status: "proposed", currentGrantId: null,
        revision: (link.exists ? Number(link.get("revision")) || 0 : 0) + 1,
        proposedBy: user.uid, updatedAt: FieldValue.serverTimestamp(), updatedBy: user.uid
      });
      audit(tx, { action: "link.propose", companyId: data.companyId, facilityId: data.facilityId, localDealerId: data.localDealerId, actorUid: user.uid, operator: true });
      return { ok: true };
    });
  }

  /** 運営者の一覧: 会社・支店・担当者・参加待ち・関連付け(施設と発注先の名称) */
  async function overview() {
    const [companies, invitations, grants] = await Promise.all([
      db.collection("dealerCompanies").get(), db.collection("dealerCompanyInvitations").where("status", "==", "pending").get(),
      db.collection("dealerPortalGrants").where("status", "==", "active").get()
    ]);
    const out = [];
    for (const c of companies.docs) {
      const [branches, staff] = await Promise.all([c.ref.collection("branches").get(), c.ref.collection("staff").get()]);
      out.push({
        companyId: c.id, name: c.get("name"), status: c.get("status"),
        branches: branches.docs.map(b => ({ branchId: b.id, name: b.get("name"), status: b.get("status") })),
        staff: staff.docs.map(s => ({ uid: s.id, name: s.get("name") || "", email: s.get("approvedEmail"), role: s.get("role"), status: s.get("status"), branchId: s.get("branchId") || null, facilityIds: s.get("facilityAssignments") || [] })),
        invitations: invitations.docs.filter(i => i.get("companyId") === c.id).map(i => ({ invitationId: i.id, email: i.get("email"), name: i.get("name") || "", role: i.get("role"), expiresAt: isoOf(i.get("expiresAt")) })),
        grants: grants.docs.filter(g => g.get("companyId") === c.id).map(g => ({ facilityId: g.get("facilityId"), localDealerId: g.get("localDealerId"), effectiveFrom: isoOf(g.get("effectiveFrom")) }))
      });
    }
    out.sort((a, b) => String(a.name).localeCompare(String(b.name), "ja"));
    // 関連付けの候補: 有効な施設と、その施設別発注先(名称)・現在の関連付け
    const facilities = await db.collection("facilities").where("status", "==", "active").get();
    const facs = [];
    for (const f of facilities.docs) {
      const [dealers, links] = await Promise.all([f.ref.collection("facilityDealers").get(), f.ref.collection("dealerPortalLinks").get()]);
      const linkBy = new Map(links.docs.map(l => [l.id, l.data()]));
      facs.push({
        facilityId: f.id, name: f.get("name") || "",
        dealers: dealers.docs.map(d => { const l = linkBy.get(d.id); return { localDealerId: d.id, name: d.get("name") || "", link: l ? { companyId: l.companyId, status: l.status } : null }; })
      });
    }
    facs.sort((a, b) => String(a.name).localeCompare(String(b.name), "ja"));
    return { companies: out, facilities: facs };
  }

  /** 運営者の呼び出し */
  async function operator({ auth, data }) {
    const user = assertOperator(auth);
    const d = data && typeof data === "object" && !Array.isArray(data) ? data : null;
    if (!d || typeof d.action !== "string") throw badInput();
    const { action, ...rest } = d;
    switch (action) {
      case "overview": strict(rest, []); return overview();
      case "createCompany": return createCompany(user, rest);
      case "updateCompany": return updateCompany(user, rest);
      case "upsertBranch": return upsertBranch(user, rest);
      case "inviteStaff": return inviteStaff(user, rest);
      case "cancelInvitation": return cancelInvitation(user, rest);
      case "updateStaff": return updateStaff(user, rest);
      case "proposeLink": return proposeLink(user, rest);
      case "reindex": return reindex(user, rest);
      default: throw badInput();
    }
  }

  // ======================= 受信の索引(注文の作成をきっかけに作る) =======================

  /**
   * 1つの注文から、許可済みの会社ごとの受信の索引を作る(冪等。同じ注文を何度処理しても同じ ID)。
   * 注文・メールは変更しない。許可の後(effectiveFrom 以降)の注文・テストでない注文・発注先の矛盾がない注文だけ。
   * @returns {{created:number, skipped:number}}
   */
  async function indexOrder(facilityId, orderId) {
    if (!isEnabled()) return { created: 0, skipped: 0, disabled: true };
    const os = await db.doc(`facilities/${facilityId}/orders/${orderId}`).get();
    if (!os.exists) return { created: 0, skipped: 0 };
    const order = os.data();
    if (order.testOrder === true || millisOf(order.createdAt) === null) return { created: 0, skipped: 1 };
    const dealerIds = new Set();
    for (const l of Array.isArray(order.lines) ? order.lines : []) {
      const id = (l && (l.dealerId || (l.dealer && l.dealer.id))) || null;
      if (isId(id)) dealerIds.add(id);
    }
    let created = 0, skipped = 0;
    const errors = [];
    for (const lid of dealerIds) {
      const own = ownLinesOf(order, lid);
      if (!own || !own.length) { skipped++; continue; }   // 発注先の矛盾(推測で公開しない)
      // 1社の失敗で残りの会社を止めない。失敗は最後にまとめて投げ、トリガーの再試行に任せる(ID が冪等なので、作成済みの会社は重複しない)
      const ok = await db.runTransaction(async (tx) => {
        const [link, fd, mail] = await Promise.all([tx.get(linkRef(facilityId, lid)), tx.get(db.doc(`facilities/${facilityId}/facilityDealers/${lid}`)),
          tx.get(db.doc(`facilities/${facilityId}/orders/${orderId}/mails/d_${lid}`))]);
        if (!link.exists || link.get("status") !== "active" || !isId(link.get("currentGrantId"))) return false;
        const g = await tx.get(grantRef(link.get("currentGrantId")));
        if (!g.exists || g.get("status") !== "active" || g.get("facilityId") !== facilityId || g.get("localDealerId") !== lid || g.get("companyId") !== link.get("companyId")) return false;
        // 許可した時点と同じ発注先のときだけ(別の会社へ切り替えた・作り直した発注先宛ての注文を、旧会社に索引しない)
        if (typeof g.get("dealerFingerprint") !== "string" || g.get("dealerFingerprint") !== dealerFingerprintOf(fd)) return false;
        // 注文時点の発注先(注文に保存された名称・注文メールの宛先)が、許可した時点と同じときだけ(変えて戻した場合の途中の注文を索引しない)
        if (!orderMatchesGrant(order, mail, lid, g.data())) return false;
        const from = millisOf(g.get("effectiveFrom"));
        if (from === null || millisOf(order.createdAt) < from) return false;   // 許可の前の注文は対象外
        const cid = g.get("companyId");
        const rid = receiptIdOf(g.id, facilityId, orderId);
        const ref = db.doc(`dealerCompanies/${cid}/receipts/${rid}`);
        const r = await tx.get(ref);
        if (r.exists) return false;
        tx.create(ref, {
          grantId: g.id, facilityId, localDealerId: lid, sourceOrderId: orderId,
          orderNumber: String(order.orderNumber || ""), orderedAt: order.createdAt,
          lineNos: own.map(l => l.lineNo).filter(n => Number.isInteger(n)),
          lineCount: own.length, totalQuantity: own.reduce((s, l) => s + (Number(l.item && l.item.quantity) || 0), 0),
          projectionVersion: 1, createdAt: FieldValue.serverTimestamp()
        });
        return true;
      }).catch((e) => { errors.push(e); return null; });
      if (ok) created++; else if (ok === false) skipped++;
    }
    if (errors.length) {
      const e = new Error(`dealer receipt indexing failed for ${errors.length} dealer(s)`);
      e.cause = errors[0];
      e.partial = { created, skipped, failed: errors.length };
      throw e;
    }
    return { created, skipped };
  }

  /** 索引の作り直し(運営者。既定は確認のみ)。施設・期間の注文に indexOrder を当て直す(メールは送らない) */
  async function reindex(user, data) {
    strict(data, ["facilityId", "from", "to", "apply", "limit", "cursor"]);
    if (!isId(data.facilityId) || (data.apply !== undefined && typeof data.apply !== "boolean")) throw badInput();
    const fromMs = jstDayStartMs(data.from), toStart = jstDayStartMs(data.to);
    if (fromMs === null || toStart === null || toStart + DAY_MS <= fromMs || (toStart + DAY_MS - fromMs) / DAY_MS > PORTAL_LIMITS.rangeDaysMax) throw badInput("期間を確認してください");
    const limit = data.limit === undefined ? PORTAL_LIMITS.reindexMax : data.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > PORTAL_LIMITS.reindexMax) throw badInput();
    // 続きの位置(同じ施設・期間の、前回の最後の注文)。同じ日に上限を超える注文があっても、続きから最後まで到達できる
    const key = hash(JSON.stringify([data.facilityId, fromMs, toStart]), 24);
    let after = null;
    if (data.cursor !== undefined) {
      let c;
      try { c = JSON.parse(Buffer.from(String(data.cursor), "base64url").toString("utf8")); } catch { throw badInput("続きの位置を確認してください"); }
      if (!c || c.k !== key || !isNum(c.s) || !isNum(c.n) || !isId(c.id)) throw badInput("続きの位置を確認してください");
      after = [new Timestamp(c.s, c.n), c.id];
    }
    let query = db.collection(`facilities/${data.facilityId}/orders`)
      .where("createdAt", ">=", Timestamp.fromMillis(fromMs)).where("createdAt", "<", Timestamp.fromMillis(toStart + DAY_MS))
      .orderBy("createdAt").orderBy(FieldPath.documentId()).limit(limit);
    if (after) query = query.startAfter(...after);
    const snap = await query.get();
    const last = snap.docs[snap.docs.length - 1];
    const truncated = snap.size >= limit;
    const nextCursor = truncated ? Buffer.from(JSON.stringify({ k: key, s: last.get("createdAt").seconds, n: last.get("createdAt").nanoseconds, id: last.id })).toString("base64url") : null;
    if (data.apply !== true) return { dryRun: true, orders: snap.size, truncated, nextCursor };
    let created = 0, failed = 0;
    for (const d of snap.docs) {
      try { created += (await indexOrder(data.facilityId, d.id)).created; }
      catch (e) { failed++; created += (e.partial && e.partial.created) || 0; }   // 失敗した注文は数えて続ける(もう一度実行すれば、作成済みは重複しない)
    }
    await db.collection("dealerPortalAuditLogs").add({ action: "receipts.reindex", facilityId: data.facilityId, actorUid: user.uid, operator: true, orders: snap.size, created, failed, at: FieldValue.serverTimestamp() });
    return { dryRun: false, orders: snap.size, created, failed, truncated, nextCursor };
  }

  /**
   * トリガーからの索引作成。一時的な失敗は例外を投げて再試行させる(注文の受付・メールとは別のトリガーなので、それらは止まらない)。
   * 再試行が続いても、イベントから一定時間を過ぎたら打ち切ってログに残す(運営者が reindex で補う)。
   */
  async function indexOrderEvent({ facilityId, orderId, eventTime }) {
    const at = Date.parse(eventTime);
    if (Number.isFinite(at) && now() - at > PORTAL_LIMITS.indexRetryMaxAgeMs) {
      console.error("dealer receipt indexing gave up (event too old; use reindex):", facilityId, orderId, eventTime);
      return { expired: true };
    }
    return indexOrder(facilityId, orderId);
  }

  return { portal, facility, operator, indexOrder, indexOrderEvent, authorizeStaff, allowedScope };
}
