/**
 * 注文メールの送信(アウトボックス方式)。docs/order-mail.md。
 *
 * - 注文の保存と送信を分ける: createOrder は注文と同じトランザクションで、送るメール(件名・本文・宛先のスナップショット)を
 *   `facilities/{fid}/orders/{orderId}/mails/{mailId}` に「送信待ち」として保存するだけ。送信はその後、別の処理(トリガー・定期実行)が行う。
 *   送信に失敗しても、注文は失われない。後から施設設定(ディーラーの宛先・署名)が変わっても、保存済みのメールは変わらない。
 * - 二重送信の防止: ①送信前にトランザクションで「送信中」に切り替え(同時に2つの処理が送らない) ②配信サービスへ
 *   冪等キー(メールごとに固定)を付ける(処理が途中で止まって再送しても、配信サービス側で1通にまとまる)。
 * - 状態: pending(送信待ち) → sending(送信中) → accepted(配信サービスが受け付けた) / retry(一時的なエラー。後で再送) / failed。
 *   accepted の後の実際の配信結果(delivered / delayed / bounced / complained / failed)は、配信サービスの Webhook で記録する(受付と配信を区別する)。
 *   held: 送信機能が停止中(MAIL_SENDING_ENABLED=false など)で送らなかった。自動では送らない(後から有効にしても、過去の注文を突然送らない)。
 *   skipped_test: 開発用受付のテスト注文。テスト用の宛先(MAIL_TEST_RECIPIENT)がなければ送らない。ある場合はその宛先だけに送る(ディーラーには送らない)。
 * - 注文控え(copy): ディーラー宛ての送信がすべて決着してから、その結果(受付・失敗・未送信)を書いて送る(送信状態を誤認させない)。
 * - 注文ドキュメントの notifications に、発注先ごとの状態の要約(アドレス・本文は含めない)を反映する。注文の status も更新する。
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { buildOrderMailPreview } from "./shared/order-mail.js";
import { profileFromSettings } from "./shared/order-mail-profiles.js";
import { orderLinesOf, describeLine, orderedByLabel } from "./shared/order-history.js";
import { isValidEmail } from "./shared/order-validation.js";

export const MAIL_STATUS = Object.freeze({
  WAITING: "waiting", PENDING: "pending", SENDING: "sending", RETRY: "retry", ACCEPTED: "accepted",
  FAILED: "failed", HELD: "held", SKIPPED_TEST: "skipped_test", NOT_SENT: "not_sent"
});
export const DELIVERY = Object.freeze({ DELIVERED: "delivered", DELAYED: "delayed", BOUNCED: "bounced", COMPLAINED: "complained", FAILED: "failed" });
export const MAIL_LIMITS = Object.freeze({ maxAttempts: 5, leaseMs: 5 * 60 * 1000, backoffMs: Object.freeze([5, 15, 60, 180].map(m => m * 60 * 1000)), errorMax: 300 });

// API の段階で決着した状態(注文控えは、ディーラー宛てがすべてこのどれかになってから送る)
const SETTLED = new Set([MAIL_STATUS.ACCEPTED, MAIL_STATUS.FAILED, MAIL_STATUS.HELD, MAIL_STATUS.SKIPPED_TEST]);
const DELIVERY_RANK = { delayed: 1, delivered: 2, bounced: 3, complained: 3, failed: 3 };
const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();
const cleanEmail = (v) => { const e = oneLine(v).toLowerCase(); return e && isValidEmail(e) ? e : null; };
const short = (s) => String(s ?? "").slice(0, MAIL_LIMITS.errorMax);

/** メールごとに固定の冪等キー(配信サービスへの再送が1通にまとまる) */
export const idempotencyKey = (facilityId, orderId, mailId) => "iol-" + createHash("sha256").update(`${facilityId}/${orderId}/${mailId}`).digest("hex").slice(0, 40);

/** 注文控えの送信先(施設設定。ON で有効な形式のときだけ、1件) */
export function copyRecipient(mailSettings) {
  if (!mailSettings || mailSettings.copyEnabled !== true) return null;
  return cleanEmail(mailSettings.copyEmail);
}

/** 送信元の表示名「施設名（IOL Order）」。施設名がなければ「IOL Order」 */
export function senderName(facilityName) {
  const name = oneLine(facilityName).replace(/[\u0000-\u001f"\\<>]/g, "").slice(0, 60).trim();
  return name ? `${name}（IOL Order）` : "IOL Order";
}

/** ディーラー宛ての返信先: 入力者本人。注文控えが ON なら施設共通アドレス(控えの宛先)も。同じアドレスは1件にする */
export function replyToList(order, copyTo) {
  const list = [cleanEmail(order.createdBy && order.createdBy.email), copyTo].filter(Boolean);
  return [...new Set(list)];
}

/** 注文の要約(注文控えに載せる。患者情報は含まない) */
export function orderSummaryText(order) {
  const lines = orderLinesOf(order).map(describeLine);
  return [
    `施設: ${oneLine(order.facilityName)}`,
    `注文番号: ${oneLine(order.orderNumber)}`,
    `入力者: ${orderedByLabel(order)}`,
    "",
    ...lines.map(l => `レンズ${l.lineNo}: ${[l.maker, l.model].filter(Boolean).join(" / ")} ${l.power} ${l.quantity}枚 / 手術日 ${l.surgeryDate} / 担当医 ${l.doctorName} / 発注先 ${l.dealerName || "未設定"}`),
    "",
    `備考: ${typeof order.notes === "string" && order.notes.trim() ? order.notes : "（なし）"}`
  ].join("\n");
}

/**
 * 注文の作成時に保存する、送信待ちのメールと状態の要約(純粋関数。createOrder のトランザクション内で使う)。
 * @param {object} p
 * @param {object} p.order 保存する注文(lines・notes・createdBy・orderNumber・facilityName・testOrder)
 * @param {Array<{id:string,name:string,orderEmails?:string[],mailName?:string}>} p.dealers 注文時点の登録ディーラー
 * @param {{copyEnabled?:boolean, copyEmail?:string, signature?:string}|null} p.mailSettings 注文時点の施設のメール設定
 * @returns {{notifications:Array<object>, mails:Array<{id:string, data:object}>}}
 */
export function buildOrderOutbox({ facilityId, orderId, order, dealers, mailSettings }) {
  const profile = profileFromSettings(mailSettings, dealers);
  const preview = buildOrderMailPreview(order, { facilityName: order.facilityName, dealers: Object.fromEntries(dealers.map(d => [d.id, d])), profile });
  const copyTo = copyRecipient(mailSettings);
  const replyTo = replyToList(order, copyTo);
  const fromName = senderName(order.facilityName);   // 送信元のアドレスは MAIL_FROM(認証済み)。表示名だけ施設ごと
  const testOrder = order.testOrder === true;
  const notifications = [], mails = [];
  for (const m of preview.mails) {
    const id = `d_${m.dealerId}`;
    const base = { id, kind: "dealer", dealerId: m.dealerId, dealerName: m.dealerName, lineNos: m.lineNos };
    if (m.status !== "ready") { notifications.push({ ...base, status: MAIL_STATUS.NOT_SENT, reason: m.blockedReason }); continue; }
    notifications.push({ ...base, status: MAIL_STATUS.PENDING });
    mails.push({ id, data: { ...base, to: m.to, replyTo, fromName, subject: m.subject, text: m.body, status: MAIL_STATUS.PENDING, attempts: 0, testOrder, idempotencyKey: idempotencyKey(facilityId, orderId, id) } });
  }
  if (preview.unrouted.length) {
    notifications.push({ id: "unrouted", kind: "dealer", dealerId: null, dealerName: "（発注先未設定）", lineNos: preview.unrouted.map(u => u.lineNo), status: MAIL_STATUS.NOT_SENT, reason: "dealer-unset" });
  }
  if (copyTo) {
    const waiting = mails.length > 0;   // ディーラー宛てがあれば、その結果が出てから送る
    const data = { id: "copy", kind: "copy", dealerName: "注文控え", to: [copyTo], replyTo: null, fromName, summary: orderSummaryText(order), status: waiting ? MAIL_STATUS.WAITING : MAIL_STATUS.PENDING, attempts: 0, testOrder, idempotencyKey: idempotencyKey(facilityId, orderId, "copy") };
    if (!waiting) Object.assign(data, buildCopyContent(order, data.summary, [], notifications));
    notifications.push({ id: "copy", kind: "copy", dealerName: "注文控え", status: data.status });
    mails.push({ id: "copy", data });
  }
  return { notifications, mails };
}

const REASON_TEXT = { "dealer-unset": "発注先が未設定のため送信していません", "no-order-email": "発注用メールが登録されていないため送信していません", "dealer-deleted": "発注先が削除されたため送信していません" };
function dealerResultText(n, mail) {
  if (n.status === MAIL_STATUS.NOT_SENT) return REASON_TEXT[n.reason] || "送信していません";
  if (!mail) return "状態を確認できません";
  if (mail.status === MAIL_STATUS.ACCEPTED) return "配信サービスが送信を受け付けました(ディーラーへの配信の完了は、注文履歴で確認してください)";
  if (mail.status === MAIL_STATUS.FAILED) return "送信に失敗しました。ディーラーには届いていません。電話などで直接ご連絡ください";
  if (mail.status === MAIL_STATUS.HELD) return "メール送信が停止中のため、送信していません。ディーラーには届いていません";
  if (mail.status === MAIL_STATUS.SKIPPED_TEST) return "テスト注文のため、ディーラーには送信していません";
  return "送信中です(結果は注文履歴で確認してください)";
}

/** 注文控えの件名・本文。ディーラー宛ての結果をそのまま書く(送信成功・失敗を誤認させない) */
export function buildCopyContent(order, summary, dealerMails, notifications) {
  const byId = new Map(dealerMails.map(m => [m.id, m]));
  const dealerNs = notifications.filter(n => n.kind === "dealer");
  const results = dealerNs.map(n => ({ n, mail: byId.get(n.id) }));
  const problem = results.some(({ n, mail }) => n.status === MAIL_STATUS.NOT_SENT || !mail || mail.status !== MAIL_STATUS.ACCEPTED);
  const subject = oneLine(`【注文控え${problem ? "・未送信あり" : ""}】${order.facilityName} ${order.orderNumber}`);
  const text = [
    "このメールは、IOL Order の注文控えです(このメールへの返信はディーラーには届きません)。",
    "",
    "■ ディーラーへの送信状況",
    ...(results.length ? results.map(({ n, mail }) => `・${n.dealerName}: ${dealerResultText(n, mail)}`) : ["・送信するディーラー宛てのメールはありません"]),
    "",
    "■ 注文内容",
    summary,
    ...dealerMails.filter(m => m.status === MAIL_STATUS.ACCEPTED).flatMap(m => ["", `■ ${m.dealerName} 宛てに送信したメール`, `件名: ${m.subject}`, "", m.text])
  ].join("\n");
  return { subject, text };
}

/** 注文全体の状態(ORDER_STATUS の値)。ディーラー宛ての状態から決める */
export function overallOrderStatus(notifications) {
  const ns = notifications.filter(n => n.kind === "dealer" && n.status !== MAIL_STATUS.NOT_SENT);
  if (!ns.length || ns.every(n => [MAIL_STATUS.HELD, MAIL_STATUS.SKIPPED_TEST].includes(n.status))) return "accepted";
  if (ns.some(n => n.status === MAIL_STATUS.FAILED || ["bounced", "complained", "failed"].includes(n.delivery))) return "notification_failed";
  if (ns.every(n => n.status === MAIL_STATUS.ACCEPTED || n.status === MAIL_STATUS.HELD || n.status === MAIL_STATUS.SKIPPED_TEST)) return "notified";
  return "notification_pending";
}

// ---------------- 配信サービス(Resend) ----------------
/** MAIL_FROM(`IOL Order <order@...>` またはアドレスのみ)から、認証済みの送信元アドレスを取り出す */
export function senderAddress(from) {
  const m = String(from ?? "").match(/<([^<>]*)>\s*$/);
  return cleanEmail(m ? m[1] : from);
}

/** From ヘッダー。表示名に区切り記号があれば引用符で囲む */
export function formatFrom(name, address) {
  const n = oneLine(name).replace(/["\\<>]/g, "");
  if (!n) return address;
  return `${/[()[\]:;@,.]/.test(n) ? `"${n}"` : n} <${address}>`;
}

/**
 * Resend の送信API。成功は「配信サービスが受け付けた」だけで、配信の完了ではない(配信結果は Webhook)。
 * From のアドレスは MAIL_FROM(認証済み)、表示名は fromName(なければ MAIL_FROM のまま)。Reply-To は複数可(Resend は配列で受け付ける)。
 * @returns {{send: (msg:{to:string[], subject:string, text:string, fromName?:string|null, replyTo?:string[]|string|null, idempotencyKey:string}) => Promise<{ok:true,id:string}|{ok:false,retryable:boolean,error:string}>}}
 */
export function createResendSender({ apiKey, from, fetchImpl = globalThis.fetch, endpoint = "https://api.resend.com/emails", timeoutMs = 15000 }) {
  return {
    async send({ to, subject, text, fromName, replyTo, idempotencyKey: key }) {
      const address = senderAddress(from);
      if (!apiKey || !address) return { ok: false, retryable: false, error: "not-configured" };
      const replies = [...new Set((Array.isArray(replyTo) ? replyTo : [replyTo]).map(cleanEmail).filter(Boolean))];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: "POST", signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": key },
          body: JSON.stringify({ from: fromName ? formatFrom(fromName, address) : from, to, subject, text, ...(replies.length ? { reply_to: replies } : {}) })
        });
      } catch (e) {
        return { ok: false, retryable: true, error: short(`network: ${e && e.name === "AbortError" ? "timeout" : (e && e.message) || e}`) };
      } finally { clearTimeout(timer); }
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (res.ok && body && typeof body.id === "string") return { ok: true, id: body.id };
      const msg = short(`HTTP ${res.status}${body && body.message ? `: ${body.message}` : ""}`);
      return { ok: false, retryable: res.status === 429 || res.status >= 500 || (res.ok && !(body && body.id)), error: msg };
    }
  };
}

/**
 * Resend の Webhook(Svix 形式)の署名の検証。secret は "whsec_..."。改ざん・古いイベント(5分超)は拒否
 * @returns {boolean}
 */
export function verifyWebhookSignature({ secret, id, timestamp, signature, rawBody, nowMs = Date.now(), toleranceSec = 300 }) {
  if (!secret || !id || !timestamp || !signature || rawBody === undefined || rawBody === null) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSec) return false;
  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody}`).digest();
  return String(signature).split(" ").some(part => {
    const [ver, sig] = part.split(",");
    if (ver !== "v1" || !sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

// Resend のイベントの種類 → 配信結果
const EVENT_DELIVERY = { "email.delivered": "delivered", "email.delivery_delayed": "delayed", "email.bounced": "bounced", "email.complained": "complained", "email.failed": "failed" };

// ---------------- 送信処理 ----------------
/**
 * @param {object} deps
 * @param {import("firebase-admin/firestore").Firestore} deps.db
 * @param {typeof import("firebase-admin/firestore").FieldValue} deps.FieldValue
 * @param {typeof import("firebase-admin/firestore").Timestamp} deps.Timestamp
 * @param {() => ({send:Function})} deps.getSender
 * @param {() => boolean} deps.isEnabled 送信の有効/無効(キルスイッチ)。false なら送らず held
 * @param {() => string} [deps.testRecipient] テスト注文の送信先(空なら送らない)
 * @param {() => number} [deps.now]
 */
export function createMailDispatchService({ db, FieldValue, Timestamp, getSender, isEnabled, testRecipient = () => "", testOnly = () => false, now = Date.now }) {
  // testOnly(MAIL_TEST_ONLY): true の間は、テスト注文でなくても、すべてのメールをテスト用の宛先だけに送る(ディーラー・注文控えの宛先には送らない)
  const asTest = (m) => m.testOrder === true || testOnly() === true;
  const ms = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : 0);
  const orderRefOf = (mailRef) => mailRef.parent.parent;

  /** 送信する(送信待ち・再送の時刻を過ぎた・送信中のまま止まったもの)。他の処理が送信中なら何もしない */
  async function processMail(mailRef) {
    const t = now();
    const claim = await db.runTransaction(async (tx) => {
      const snap = await tx.get(mailRef);
      if (!snap.exists) return null;
      const m = snap.data();
      const due = m.status === MAIL_STATUS.PENDING
        || (m.status === MAIL_STATUS.RETRY && ms(m.nextAttemptAt) <= t)
        || (m.status === MAIL_STATUS.SENDING && ms(m.leaseUntil) <= t);   // 送信中のまま処理が止まった(冪等キーで二重送信にならない)
      if (!due) return null;
      if (!isEnabled()) { tx.update(mailRef, { status: MAIL_STATUS.HELD, statusAt: FieldValue.serverTimestamp() }); return { m, done: MAIL_STATUS.HELD }; }
      if (asTest(m) && !testRecipient()) { tx.update(mailRef, { status: MAIL_STATUS.SKIPPED_TEST, statusAt: FieldValue.serverTimestamp() }); return { m, done: MAIL_STATUS.SKIPPED_TEST }; }
      const attempts = (m.attempts || 0) + 1;
      tx.update(mailRef, { status: MAIL_STATUS.SENDING, attempts, leaseUntil: Timestamp.fromMillis(t + MAIL_LIMITS.leaseMs), lastAttemptAt: FieldValue.serverTimestamp(), statusAt: FieldValue.serverTimestamp() });
      return { m: { ...m, attempts }, done: null, test: asTest(m) };
    });
    if (!claim) return "skipped";
    if (claim.done) { await syncOrder(orderRefOf(mailRef)); return claim.done; }

    const m = claim.m;
    const test = claim.test;
    const msg = test
      ? { to: [testRecipient()], subject: `【テスト】${m.subject}`, text: `(テスト注文の送信です。本来の宛先 ${m.to.length} 件には送信していません)\n\n${m.text}`, fromName: m.fromName || null, replyTo: null, idempotencyKey: `${m.idempotencyKey}-test` }
      : { to: m.to, subject: m.subject, text: m.text, fromName: m.fromName || null, replyTo: m.replyTo || null, idempotencyKey: m.idempotencyKey };
    let r;
    try { r = await getSender().send(msg); } catch (e) { r = { ok: false, retryable: true, error: short(e && e.message) }; }

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(mailRef);
      if (!snap.exists || snap.get("status") !== MAIL_STATUS.SENDING) return;   // 別の処理が先に結果を書いた
      if (r.ok) {
        tx.update(mailRef, { status: MAIL_STATUS.ACCEPTED, providerMessageId: r.id, acceptedAt: FieldValue.serverTimestamp(), statusAt: FieldValue.serverTimestamp(), lastError: FieldValue.delete(), leaseUntil: FieldValue.delete(), sentTo: test ? "test" : "recipients" });
        tx.set(db.doc(`mailIndex/${r.id}`), { path: mailRef.path, createdAt: FieldValue.serverTimestamp() });   // Webhook から元のメールを探す
      } else if (r.retryable && m.attempts < MAIL_LIMITS.maxAttempts) {
        const wait = MAIL_LIMITS.backoffMs[Math.min(m.attempts - 1, MAIL_LIMITS.backoffMs.length - 1)];
        tx.update(mailRef, { status: MAIL_STATUS.RETRY, nextAttemptAt: Timestamp.fromMillis(now() + wait), lastError: short(r.error), statusAt: FieldValue.serverTimestamp(), leaseUntil: FieldValue.delete() });
      } else {
        tx.update(mailRef, { status: MAIL_STATUS.FAILED, lastError: short(r.error), statusAt: FieldValue.serverTimestamp(), leaseUntil: FieldValue.delete() });
      }
    });
    await syncOrder(orderRefOf(mailRef));
    return r.ok ? "accepted" : (r.retryable && m.attempts < MAIL_LIMITS.maxAttempts ? "retry" : "failed");
  }

  /** 注文の notifications・status を、メールの状態に合わせる。ディーラー宛てが決着したら注文控えを送信待ちにする */
  async function syncOrder(orderRef) {
    const copyRef = await db.runTransaction(async (tx) => {
      const [orderSnap, mailsSnap] = await Promise.all([tx.get(orderRef), tx.get(orderRef.collection("mails"))]);
      if (!orderSnap.exists) return null;
      const order = orderSnap.data();
      const mails = mailsSnap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));
      const byId = new Map(mails.map(m => [m.id, m]));
      let release = null;
      const dealerMails = mails.filter(m => m.kind === "dealer");
      const copy = byId.get("copy");
      const notifications = (Array.isArray(order.notifications) ? order.notifications : []).map(n => {
        const m = byId.get(n.id);
        if (!m) return n;
        const next = { ...n, status: m.status, attempts: m.attempts || 0 };
        if (m.statusAt) next.statusAt = m.statusAt;
        if (m.lastError && m.status !== MAIL_STATUS.ACCEPTED) next.error = m.lastError; else delete next.error;
        if (m.delivery) { next.delivery = m.delivery; if (m.deliveryAt) next.deliveryAt = m.deliveryAt; }
        return next;
      });
      if (copy && copy.status === MAIL_STATUS.WAITING && dealerMails.every(m => SETTLED.has(m.status))) {
        const content = buildCopyContent(order, copy.summary, dealerMails, notifications);
        tx.update(copy.ref, { ...content, status: MAIL_STATUS.PENDING, statusAt: FieldValue.serverTimestamp() });
        const i = notifications.findIndex(n => n.id === "copy");
        if (i >= 0) notifications[i] = { ...notifications[i], status: MAIL_STATUS.PENDING };
        release = copy.ref;
      }
      tx.update(orderRef, { notifications, status: overallOrderStatus(notifications), statusUpdatedAt: FieldValue.serverTimestamp() });
      return release;
    });
    if (copyRef) await processMail(copyRef);
  }

  /** 定期実行: 送信待ち・再送待ち・送信中のまま止まったメールと、送信できる状態の注文控えを処理する */
  async function processDue(limit = 100) {
    const snap = await db.collectionGroup("mails").where("status", "in", [MAIL_STATUS.PENDING, MAIL_STATUS.RETRY, MAIL_STATUS.SENDING, MAIL_STATUS.WAITING]).limit(limit).get();
    const results = [];
    for (const d of snap.docs) {
      if (d.get("status") === MAIL_STATUS.WAITING) { await syncOrder(orderRefOf(d.ref)); results.push("synced"); }
      else results.push(await processMail(d.ref));
    }
    return results;
  }

  /** 配信結果(Webhook)。弱い結果で強い結果を上書きしない(例: 不達の後に遅延は記録しない)。知らないメールは無視 */
  async function handleDeliveryEvent(event) {
    const delivery = EVENT_DELIVERY[event && event.type];
    const emailId = event && event.data && event.data.email_id;
    if (!delivery || typeof emailId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(emailId)) return "ignored";
    const idx = await db.doc(`mailIndex/${emailId}`).get();
    if (!idx.exists) return "ignored";
    const mailRef = db.doc(idx.get("path"));
    const changed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(mailRef);
      if (!snap.exists || snap.get("providerMessageId") !== emailId) return false;
      if ((DELIVERY_RANK[snap.get("delivery")] || 0) > DELIVERY_RANK[delivery]) return false;
      const detail = event.data.bounce && event.data.bounce.message ? short(event.data.bounce.message) : null;
      tx.update(mailRef, { delivery, deliveryAt: event.created_at || null, ...(detail ? { deliveryDetail: detail } : {}) });
      return true;
    });
    if (changed) await syncOrder(orderRefOf(mailRef));
    return changed ? "recorded" : "ignored";
  }

  return { processMail, syncOrder, processDue, handleDeliveryEvent };
}
