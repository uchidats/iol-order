// 注文メールの送信(アウトボックス)のテスト(Firestoreエミュレータ。実際のメールは送らない: 送信は偽の配信サービス)
//   npm run test:functions
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, collection, setDoc, serverTimestamp } from "firebase/firestore";
import { createOrderService } from "../../functions/src/orders.js";
import { createMailDispatchService, MAIL_LIMITS } from "../../functions/src/order-mail-outbox.js";

const PROJECT = "demo-iol-functions";
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8185").split(":");
const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../firestore.rules");
const F = "fM";
let env, db, orders, clock, sent, behavior, enabled, testTo, dispatch;

before(async () => {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  db = getFirestore();
  clock = { t: Date.parse("2026-10-26T00:00:00Z") };
  orders = createOrderService({ db, FieldValue, now: () => clock.t });
  dispatch = createMailDispatchService({
    db, FieldValue, Timestamp, now: () => clock.t,
    isEnabled: () => enabled, testRecipient: () => testTo,
    getSender: () => ({ send: async (msg) => { sent.push(msg); return behavior(msg, sent.length); } })
  });
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(rulesPath, "utf8"), host, port: Number(port) } });
});
after(async () => { await env.clearFirestore(); await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  clock.t = Date.parse("2026-10-26T00:00:00Z");
  sent = []; enabled = true; testTo = ""; behavior = (msg, n) => ({ ok: true, id: `msg_${n}` });
  await db.doc(`facilities/${F}`).set({ name: "テスト眼科", status: "active" });
  await db.doc(`facilities/${F}/members/adm`).set({ uid: "adm", role: "admin" });
  await db.doc(`facilities/${F}/members/ord`).set({ uid: "ord", role: "orderer" });
  await db.doc(`facilities/${F}/adoptedIols/jj-dib00v`).set({ facilityId: F, catalogIolId: "jj-dib00v", enabled: true });
  await db.doc(`facilities/${F}/orderers/o1`).set({ facilityId: F, name: "山田" });
  await db.doc(`facilities/${F}/facilityDealers/dA`).set({ facilityId: F, name: "A商会", mailName: "株式会社A商会", orderEmails: ["order-a@example.jp"] });
  await db.doc(`facilities/${F}/facilityDealers/dB`).set({ facilityId: F, name: "B医療", orderEmails: ["order-b@example.jp"] });
  await db.doc(`facilities/${F}/settings/mail`).set({ copyEnabled: true, copyEmail: "info@clinic.example.jp", signature: "〒100-0001 東京都\nテスト眼科" });
});

const user = (uid) => ({ uid, token: { email: `${uid}@login.jp`, email_verified: true, name: `ログイン-${uid}` } });
const line = (over = {}) => ({ modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: "2026-11-10", doctorId: "o1", dealerId: "dA", ...over });
const place = (lines = [line(), line({ dealerId: "dB", power: "+21.0D" })], over = {}) =>
  orders.createOrder({ auth: user("ord"), data: { facilityId: F, requestId: crypto.randomUUID(), notes: "右眼", lines, ...over } });
const mailsOf = async (orderId) => Object.fromEntries((await db.collection(`facilities/${F}/orders/${orderId}/mails`).get()).docs.map(d => [d.id, d.data()]));
const orderOf = async (orderId) => (await db.doc(`facilities/${F}/orders/${orderId}`).get()).data();
const ref = (orderId, mailId) => db.doc(`facilities/${F}/orders/${orderId}/mails/${mailId}`);
const sendAll = async (orderId) => { for (const id of ["d_dA", "d_dB"]) await dispatch.processMail(ref(orderId, id)); };

test("注文の保存と同時に、発注先ごとの送信待ちメールを保存する(注文時点の宛先・件名・本文)。送信はまだしない", async () => {
  const r = await place();
  const mails = await mailsOf(r.orderId);
  assert.deepEqual(Object.keys(mails).sort(), ["copy", "d_dA", "d_dB"]);
  assert.deepEqual([mails.d_dA.status, mails.d_dA.to, mails.copy.status], ["pending", ["order-a@example.jp"], "waiting"]);
  assert.ok(mails.d_dA.text.startsWith("株式会社A商会御中") && mails.d_dA.text.endsWith("〒100-0001 東京都\nテスト眼科"));
  assert.deepEqual(mails.d_dA.replyTo, ["ord@login.jp", "info@clinic.example.jp"], "返信先は入力者本人と施設共通アドレス(注文控えON)");
  assert.deepEqual([mails.d_dA.fromName, mails.copy.replyTo], ["テスト眼科（IOL Order）", null]);
  assert.equal(sent.length, 0);
  const o = await orderOf(r.orderId);
  assert.equal(o.status, "accepted");
  assert.deepEqual(o.notifications.map(n => [n.id, n.status]), [["d_dA", "pending"], ["d_dB", "pending"], ["copy", "waiting"]]);
  assert.ok(!JSON.stringify(o.notifications).includes("@"), "注文(全員が読める)にはアドレスを含めない");
  // 後から施設設定が変わっても、保存済みのメールは変わらない
  await db.doc(`facilities/${F}/facilityDealers/dA`).update({ orderEmails: ["changed@example.jp"], mailName: "改名" });
  await db.doc(`facilities/${F}/settings/mail`).update({ signature: "別の署名" });
  await sendAll(r.orderId);
  assert.deepEqual(sent[0].to, ["order-a@example.jp"]);
  assert.ok(sent[0].text.startsWith("株式会社A商会御中") && !sent[0].text.includes("別の署名"));
});

test("送信: 配信サービスが受け付けたら accepted。全発注先が決着してから注文控えを送り、控えに結果を書く。注文の状態は notified", async () => {
  const r = await place();
  await sendAll(r.orderId);
  assert.equal(sent.length, 3, "ディーラー2通 + 控え1通");
  assert.deepEqual(sent.map(m => m.to[0]), ["order-a@example.jp", "order-b@example.jp", "info@clinic.example.jp"]);
  assert.equal(sent[0].idempotencyKey, (await mailsOf(r.orderId)).d_dA.idempotencyKey, "冪等キーを付けて送る");
  assert.deepEqual([sent[0].fromName, sent[0].replyTo], ["テスト眼科（IOL Order）", ["ord@login.jp", "info@clinic.example.jp"]]);
  assert.deepEqual([sent[2].fromName, sent[2].replyTo], ["テスト眼科（IOL Order）", null], "注文控えは返信先なし");
  assert.match(sent[2].subject, /^【注文控え】テスト眼科 IOL-/);
  assert.match(sent[2].text, /株式会社A商会: 配信サービスが送信を受け付けました/);
  const mails = await mailsOf(r.orderId);
  assert.deepEqual([mails.d_dA.status, mails.d_dA.providerMessageId, mails.copy.status], ["accepted", "msg_1", "accepted"]);
  const o = await orderOf(r.orderId);
  assert.equal(o.status, "notified");
  assert.deepEqual(o.notifications.map(n => n.status), ["accepted", "accepted", "accepted"]);
  assert.equal((await db.doc("mailIndex/msg_1").get()).get("path"), ref(r.orderId, "d_dA").path);
});

test("二重送信の防止: 同じメールを同時・何度処理しても1回だけ送る。送信中のまま止まったものは、同じ冪等キーで送り直す", async () => {
  const r = await place([line()]);
  let release;
  behavior = (msg, n) => (n === 1 ? new Promise(res => { release = () => res({ ok: true, id: "msg_slow" }); }) : { ok: true, id: `msg_${n}` });   // 最初の1通だけ遅い
  const first = dispatch.processMail(ref(r.orderId, "d_dA"));
  await new Promise(res => setTimeout(res, 300));
  assert.equal(await dispatch.processMail(ref(r.orderId, "d_dA")), "skipped", "送信中は他の処理が送らない");
  release();
  assert.equal(await first, "accepted");
  assert.equal(await dispatch.processMail(ref(r.orderId, "d_dA")), "skipped", "送信済みは送らない");
  assert.equal(sent.filter(m => m.to[0] === "order-a@example.jp").length, 1);
  // 送信中のまま止まった(処理が落ちた)メール → 期限後に同じ冪等キーで再送(配信サービス側で1通にまとまる)
  const r2 = await place([line({ surgeryDate: "2026-11-11" })]);
  await ref(r2.orderId, "d_dA").update({ status: "sending", attempts: 1, leaseUntil: Timestamp.fromMillis(clock.t + 1000) });
  assert.equal(await dispatch.processMail(ref(r2.orderId, "d_dA")), "skipped");
  clock.t += MAIL_LIMITS.leaseMs + 1;
  behavior = () => ({ ok: true, id: "msg_again" });
  const before = sent.length;
  assert.equal(await dispatch.processMail(ref(r2.orderId, "d_dA")), "accepted");
  assert.equal(sent[before].idempotencyKey, (await mailsOf(r2.orderId)).d_dA.idempotencyKey);
});

test("失敗時: 一時的なエラーは再送待ち(間隔をあけて再送)。上限回数で failed。再送しない失敗は即 failed。注文は残り、控えに失敗を書く", async () => {
  const r = await place();
  behavior = (msg) => (msg.to[0] === "order-b@example.jp" ? { ok: false, retryable: false, error: "HTTP 422: invalid" } : { ok: false, retryable: true, error: "HTTP 503" });
  await sendAll(r.orderId);
  let mails = await mailsOf(r.orderId);
  assert.deepEqual([mails.d_dA.status, mails.d_dA.attempts, mails.d_dA.lastError, mails.d_dB.status], ["retry", 1, "HTTP 503", "failed"]);
  assert.equal(mails.copy.status, "waiting", "再送待ちがある間は控えを送らない");
  assert.equal(await dispatch.processMail(ref(r.orderId, "d_dA")), "skipped", "再送の時刻の前は送らない");
  for (let i = 0; i < MAIL_LIMITS.maxAttempts; i++) { clock.t += 4 * 60 * 60 * 1000; await dispatch.processDue(); }
  mails = await mailsOf(r.orderId);
  assert.deepEqual([mails.d_dA.status, mails.d_dA.attempts], ["failed", MAIL_LIMITS.maxAttempts]);
  assert.equal(sent.filter(m => m.to[0] === "order-a@example.jp").length, MAIL_LIMITS.maxAttempts, "上限まで再送");
  assert.ok(["retry", "failed"].includes(mails.copy.status), "控えは送信を試みた(偽の配信サービスは常に失敗するため、再送待ちか失敗)");
  const copySent = sent.find(m => m.to[0] === "info@clinic.example.jp");
  assert.match(copySent.subject, /未送信あり/);
  assert.match(copySent.text, /B医療: 送信に失敗しました。ディーラーには届いていません/);
  const o = await orderOf(r.orderId);
  assert.equal(o.status, "notification_failed");
  assert.ok(o.lines.length === 2 && o.orderNumber, "注文データは残る");
});

test("送信停止中(MAIL_SENDING_ENABLED=false): 送らずに held。自動では送らない(後から有効にしても過去の注文を送らない)", async () => {
  enabled = false;
  const r = await place();
  await sendAll(r.orderId);
  await dispatch.processDue();
  assert.equal(sent.length, 0);
  const mails = await mailsOf(r.orderId);
  assert.deepEqual([mails.d_dA.status, mails.d_dB.status, mails.copy.status], ["held", "held", "held"]);
  enabled = true;
  await dispatch.processDue();
  assert.equal(sent.length, 0, "有効にしても held は送らない");
  assert.equal((await orderOf(r.orderId)).status, "accepted");
});

test("テスト注文(開発用受付): テスト用の宛先がなければ送らない。あればその宛先だけに送り、ディーラーには送らない", async () => {
  const testOrders = createOrderService({ db, FieldValue, now: () => clock.t, getPolicy: () => ({ facilityIds: [F], uids: ["ord"] }) });
  const r = await testOrders.createOrder({ auth: user("ord"), data: { facilityId: F, requestId: crypto.randomUUID(), lines: [line()] } });
  await dispatch.processMail(ref(r.orderId, "d_dA"));
  assert.equal(sent.length, 0);
  assert.equal((await mailsOf(r.orderId)).d_dA.status, "skipped_test");
  testTo = "dev@example.jp";
  const r2 = await testOrders.createOrder({ auth: user("ord"), data: { facilityId: F, requestId: crypto.randomUUID(), lines: [line({ surgeryDate: "2026-11-12" })] } });
  await dispatch.processMail(ref(r2.orderId, "d_dA"));
  assert.deepEqual(sent.map(m => m.to), [["dev@example.jp"], ["dev@example.jp"]], "ディーラー宛て・控えとも、テスト用の宛先だけ");
  assert.match(sent[0].subject, /^【テスト】/);
  assert.match(sent[0].text, /本来の宛先 1 件には送信していません/);
  assert.equal(sent[0].replyTo, null, "テスト送信はディーラー向けの返信先を付けない");
  const o2 = await orderOf(r2.orderId);
  assert.equal(o2.status, "accepted", "テスト用の宛先への送信は、ディーラーへの通知(notified)にしない");
  assert.deepEqual(o2.notifications.filter(n => n.kind === "dealer").map(n => n.sentTo), ["test"]);
});

test("本番(テスト注文でない・MAIL_TEST_ONLY=false): テスト用の宛先が設定されていても、ディーラーの発注用メールと注文控えの宛先に送る", async () => {
  testTo = "dev@example.jp";
  const r = await place();
  await sendAll(r.orderId);
  assert.deepEqual(sent.map(m => m.to), [["order-a@example.jp"], ["order-b@example.jp"], ["info@clinic.example.jp"]]);
  assert.ok(sent.every(m => !m.subject.startsWith("【テスト】") && !m.to.includes("dev@example.jp")));
  assert.deepEqual(sent[0].replyTo, ["ord@login.jp", "info@clinic.example.jp"]);
  assert.deepEqual((await orderOf(r.orderId)).notifications.map(n => n.sentTo), ["recipients", "recipients", "recipients"]);
});

test("MAIL_TEST_ONLY: テスト注文でなくても、ディーラー宛て・注文控えともテスト用の宛先だけに送る。宛先がなければ送らない", async () => {
  const guarded = createMailDispatchService({
    db, FieldValue, Timestamp, now: () => clock.t, isEnabled: () => enabled, testRecipient: () => testTo, testOnly: () => true,
    getSender: () => ({ send: async (msg) => { sent.push(msg); return behavior(msg, sent.length); } })
  });
  const r = await place();
  for (const id of ["d_dA", "d_dB"]) await guarded.processMail(ref(r.orderId, id));
  assert.equal(sent.length, 0);
  assert.deepEqual(Object.values(await mailsOf(r.orderId)).map(m => m.status).sort(), ["skipped_test", "skipped_test", "skipped_test"]);
  testTo = "dev@example.jp";
  const r2 = await place(undefined, { notes: "2件目" });
  for (const id of ["d_dA", "d_dB"]) await guarded.processMail(ref(r2.orderId, id));
  assert.deepEqual(sent.map(m => m.to), [["dev@example.jp"], ["dev@example.jp"], ["dev@example.jp"]], "ディーラー2通・控え1通とも、テスト用の宛先だけ");
  assert.ok(sent.every(m => m.subject.startsWith("【テスト】") && m.replyTo === null));
});

test("配信結果(Webhook): 受付の後の配信済み・不達を記録する。弱い結果で上書きしない。知らないメールは無視", async () => {
  const r = await place([line()]);
  await dispatch.processMail(ref(r.orderId, "d_dA"));
  const id = (await mailsOf(r.orderId)).d_dA.providerMessageId;
  assert.equal(await dispatch.handleDeliveryEvent({ type: "email.delivered", created_at: "2026-10-26T00:01:00Z", data: { email_id: id } }), "recorded");
  let o = await orderOf(r.orderId);
  assert.deepEqual([o.notifications[0].status, o.notifications[0].delivery, o.status], ["accepted", "delivered", "notified"]);
  assert.equal(await dispatch.handleDeliveryEvent({ type: "email.delivery_delayed", data: { email_id: id } }), "ignored", "配信済みを遅延で上書きしない");
  assert.equal(await dispatch.handleDeliveryEvent({ type: "email.bounced", data: { email_id: id, bounce: { message: "mailbox not found" } } }), "recorded");
  o = await orderOf(r.orderId);
  assert.deepEqual([o.notifications[0].delivery, o.status], ["bounced", "notification_failed"]);
  assert.equal((await mailsOf(r.orderId)).d_dA.deliveryDetail, "mailbox not found");
  assert.equal(await dispatch.handleDeliveryEvent({ type: "email.delivered", data: { email_id: "msg_unknown" } }), "ignored");
  assert.equal(await dispatch.handleDeliveryEvent({ type: "email.opened", data: { email_id: id } }), "ignored");
  assert.equal(await dispatch.handleDeliveryEvent({ type: "email.delivered", data: { email_id: "../../x" } }), "ignored");
});

test("注文控えOFF・発注用メールなし: 控えは作らない。送れない発注先は送信対象外として記録し、注文は受け付ける", async () => {
  await db.doc(`facilities/${F}/settings/mail`).set({ copyEnabled: false, copyEmail: "info@clinic.example.jp" });
  await db.doc(`facilities/${F}/facilityDealers/dB`).set({ facilityId: F, name: "B医療", orderEmails: [] });
  const r = await place();
  const mails = await mailsOf(r.orderId);
  assert.deepEqual(Object.keys(mails), ["d_dA"]);
  const o = await orderOf(r.orderId);
  assert.deepEqual(o.notifications.map(n => [n.id, n.status, n.reason || null]), [["d_dA", "pending", null], ["d_dB", "not_sent", "no-order-email"]]);
  await dispatch.processMail(ref(r.orderId, "d_dA"));
  assert.equal((await orderOf(r.orderId)).status, "notified");
});

test("Rules: 送信待ち・送信結果(宛先・本文)は管理者・副管理者だけが読める。メール設定は管理者・副管理者だけが読み書きできる", async () => {
  const r = await place([line()]);
  const adm = env.authenticatedContext("adm").firestore();
  const ord = env.authenticatedContext("ord").firestore();
  await assertSucceeds(getDoc(doc(adm, `facilities/${F}/orders/${r.orderId}/mails/d_dA`)));
  await assertFails(getDoc(doc(ord, `facilities/${F}/orders/${r.orderId}/mails/d_dA`)));
  await assertFails(getDocs(collection(ord, `facilities/${F}/orders/${r.orderId}/mails`)));
  await assertSucceeds(getDoc(doc(ord, `facilities/${F}/orders/${r.orderId}`)), "注文(送信状態の要約を含む)は所属者が読める");
  await assertFails(setDoc(doc(adm, `facilities/${F}/orders/${r.orderId}/mails/x`), { status: "pending" }), "クライアントは送信待ちを作れない");
  await assertFails(getDoc(doc(adm, "mailIndex/msg_1")));
  await assertFails(getDoc(doc(ord, `facilities/${F}/settings/mail`)));
  await assertSucceeds(getDoc(doc(adm, `facilities/${F}/settings/mail`)));
  const w = (db2, data) => setDoc(doc(db2, `facilities/${F}/settings/mail`), { updatedAt: serverTimestamp(), ...data });
  await assertSucceeds(w(adm, { copyEnabled: true, copyEmail: "info@senju-eye-clinic.jp", signature: "署名", updatedBy: "adm" }));
  await assertSucceeds(w(adm, { copyEnabled: false, copyEmail: "", signature: "" }));
  await assertFails(w(adm, { copyEnabled: true, copyEmail: "" }), "ONなら送信先が必須");
  await assertFails(w(adm, { copyEnabled: true, copyEmail: "a@b.jp,c@d.jp" }), "1件だけ");
  await assertFails(w(adm, { copyEnabled: false, copyEmail: "", signature: "x".repeat(501) }));
  await assertFails(w(adm, { copyEnabled: false, copyEmail: "", extra: 1 }));
  await assertFails(w(adm, { copyEnabled: false, copyEmail: "", updatedBy: "ord" }), "他人の uid では保存できない");
  await assertFails(w(ord, { copyEnabled: false, copyEmail: "" }), "注文者は変更できない");
  await assertFails(setDoc(doc(adm, `facilities/${F}/settings/other`), { copyEnabled: false }), "mail 以外の設定は作れない");
  // ディーラーの宛名(任意・100文字まで)
  await assertSucceeds(setDoc(doc(adm, `facilities/${F}/facilityDealers/dA`), { facilityId: F, name: "A商会", mailName: "株式会社A商会", orderEmails: ["order-a@example.jp"] }));
  await assertFails(setDoc(doc(adm, `facilities/${F}/facilityDealers/dA`), { facilityId: F, name: "A商会", mailName: "x".repeat(101) }));
});
