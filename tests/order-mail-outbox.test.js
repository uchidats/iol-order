import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  buildOrderOutbox, buildCopyContent, overallOrderStatus, createResendSender, verifyWebhookSignature,
  idempotencyKey, copyRecipient, senderName, senderAddress, formatFrom, replyToList, MAIL_STATUS
} from "../functions/src/order-mail-outbox.js";
import { validateMailSettings, planMailSettingsWrite, validateDealers, planDealerWrites } from "../src/domain/facility-settings.js";

const item = (o = {}) => ({ modelId: "jj-dib00v", manufacturer: "J&J", model: "DIB00V", displayName: "J&J / DIB00V", isToric: false, isMultifocal: false, toricModel: "", power: "+20.0D", quantity: 1, ...o });
const line = (n, dealer, o = {}) => ({ lineNo: n, item: item(), surgeryDate: "2026-11-10", doctor: { id: "o1", name: "山田" }, dealerId: dealer ? dealer.id : null, dealer: dealer ? { id: dealer.id, name: dealer.name } : null, ...o });
const A = { id: "dA", name: "A商会", orderEmails: ["order-a@example.jp"], mailName: "株式会社A商会" };
const B = { id: "dB", name: "B医療", orderEmails: [] };
const order = (lines, o = {}) => ({ facilityName: "テスト眼科", orderNumber: "IOL-20261026-0001", notes: "右眼", createdBy: { uid: "u1", email: "nurse@example.jp", displayName: "入力 花子" }, lines, testOrder: false, ...o });

test("注文時のメール: 発注先ごとに1通(注文時点の宛先・件名・本文)。発注用メールがない・発注先未設定は送信対象外として記録", () => {
  const ob = buildOrderOutbox({ facilityId: "f1", orderId: "o1", order: order([line(1, A), line(2, B), line(3, null)]), dealers: [A, B], mailSettings: { signature: "〒100-0001 東京\nテスト眼科" } });
  assert.equal(ob.mails.length, 1);
  const m = ob.mails[0];
  assert.equal(m.id, "d_dA");
  assert.deepEqual(m.data.to, ["order-a@example.jp"]);
  assert.equal(m.data.subject, "【テスト眼科】IOL注文：ご確認のほどよろしくお願いします", "既存の件名の形式");
  assert.ok(m.data.text.startsWith("株式会社A商会御中\n"), "宛名は施設設定の正式表記");
  assert.ok(m.data.text.endsWith("〒100-0001 東京\nテスト眼科"), "署名は施設設定");
  assert.ok(m.data.text.includes("備考: 右眼") && m.data.text.includes("発注者: 入力 花子"));
  assert.deepEqual(m.data.replyTo, ["nurse@example.jp"], "注文控えOFF: 返信先は入力者本人だけ");
  assert.equal(m.data.fromName, "テスト眼科（IOL Order）", "送信元の表示名は「施設名（IOL Order）」");
  assert.equal(m.data.status, MAIL_STATUS.PENDING);
  assert.equal(m.data.idempotencyKey, idempotencyKey("f1", "o1", "d_dA"));
  assert.deepEqual(ob.notifications.map(n => [n.id, n.status, n.reason || null]), [["d_dA", "pending", null], ["d_dB", "not_sent", "no-order-email"], ["unrouted", "not_sent", "dealer-unset"]]);
  assert.ok(!JSON.stringify(ob.notifications).includes("@"), "注文の要約(全員が読める)にアドレスを含めない");
});

test("注文控え: 初期はOFF。ONで有効な送信先1件のときだけ。ディーラー宛てがあれば、その結果が出るまで待つ", () => {
  assert.equal(copyRecipient(null), null);
  assert.equal(copyRecipient({ copyEnabled: false, copyEmail: "info@example.jp" }), null);
  assert.equal(copyRecipient({ copyEnabled: true, copyEmail: " Info@Example.jp " }), "info@example.jp");
  assert.equal(copyRecipient({ copyEnabled: true, copyEmail: "bad" }), null);
  const settings = { copyEnabled: true, copyEmail: "info@senju.example.jp" };
  const ob = buildOrderOutbox({ facilityId: "f1", orderId: "o1", order: order([line(1, A)]), dealers: [A], mailSettings: settings });
  const copy = ob.mails.find(m => m.id === "copy");
  assert.deepEqual([copy.data.status, copy.data.to, copy.data.subject], ["waiting", ["info@senju.example.jp"], undefined]);
  assert.deepEqual(ob.mails[0].data.replyTo, ["nurse@example.jp", "info@senju.example.jp"], "注文控えON: 返信先は入力者本人と施設共通アドレス");
  assert.deepEqual([copy.data.replyTo, copy.data.fromName], [null, "テスト眼科（IOL Order）"], "注文控えには返信先を付けない");
  // ディーラー宛てがない(発注用メール未登録)ときは、すぐに送る控えに「送信していない」と書く
  const none = buildOrderOutbox({ facilityId: "f1", orderId: "o2", order: order([line(1, B)]), dealers: [B], mailSettings: settings });
  const c2 = none.mails.find(m => m.id === "copy").data;
  assert.equal(c2.status, "pending");
  assert.match(c2.subject, /^【注文控え・未送信あり】/);
  assert.match(c2.text, /B医療: 発注用メールが登録されていないため送信していません/);
});

test("返信先(Reply-To): 同じアドレスは1件(大文字小文字も同一視)。入力者のアドレスが無効なら施設共通アドレスだけ", () => {
  const same = buildOrderOutbox({ facilityId: "f1", orderId: "o1", order: order([line(1, A)]), dealers: [A], mailSettings: { copyEnabled: true, copyEmail: "Nurse@Example.jp" } });
  assert.deepEqual(same.mails[0].data.replyTo, ["nurse@example.jp"]);
  assert.deepEqual(replyToList({ createdBy: { email: "bad" } }, "info@example.jp"), ["info@example.jp"]);
  assert.deepEqual(replyToList({ createdBy: null }, null), []);
});

test("送信元: 表示名は「施設名（IOL Order）」(施設名がなければ IOL Order)。アドレスは MAIL_FROM の認証済みアドレス", () => {
  assert.equal(senderName("テスト眼科"), "テスト眼科（IOL Order）");
  assert.equal(senderName(""), "IOL Order");
  assert.equal(senderName('悪い"<x@evil.jp>\\\r\n眼科'), "悪いx@evil.jp 眼科（IOL Order）", "改行は空白に、引用符・山括弧・バックスラッシュは除く");
  assert.equal(senderAddress("IOL Order <Order@Mail.example.jp>"), "order@mail.example.jp");
  assert.equal(senderAddress("order@mail.example.jp"), "order@mail.example.jp");
  assert.equal(senderAddress("IOL Order"), null);
  assert.equal(formatFrom("テスト眼科（IOL Order）", "order@mail.example.jp"), "テスト眼科（IOL Order） <order@mail.example.jp>");
  assert.equal(formatFrom("Dr. 眼科(本院)（IOL Order）", "order@mail.example.jp"), '"Dr. 眼科(本院)（IOL Order）" <order@mail.example.jp>', "区切り記号があれば引用符で囲む");
});

test("注文控えの本文: 受付・失敗・停止中を区別し、受付は「配信の完了ではない」と書く。送ったメールの内容を載せる", () => {
  const ns = [{ id: "d_dA", kind: "dealer", dealerName: "A商会" }, { id: "d_dC", kind: "dealer", dealerName: "C商会" }, { id: "d_dD", kind: "dealer", dealerName: "D商会" }];
  const mails = [
    { id: "d_dA", dealerName: "A商会", status: "accepted", subject: "件名A", text: "本文A" },
    { id: "d_dC", dealerName: "C商会", status: "failed", subject: "件名C", text: "本文C" },
    { id: "d_dD", dealerName: "D商会", status: "held", subject: "件名D", text: "本文D" }];
  const c = buildCopyContent(order([]), "要約", mails, ns);
  assert.match(c.subject, /未送信あり/);
  assert.match(c.text, /A商会: 配信サービスが送信を受け付けました\(ディーラーへの配信の完了は、注文履歴で確認してください\)/);
  assert.match(c.text, /C商会: 送信に失敗しました。ディーラーには届いていません/);
  assert.match(c.text, /D商会: メール送信が停止中のため、送信していません/);
  assert.ok(c.text.includes("本文A") && !c.text.includes("本文C"), "送ったメールの内容だけを載せる");
  const ok = buildCopyContent(order([]), "要約", [mails[0]], [ns[0]]);
  assert.doesNotMatch(ok.subject, /未送信/);
});

test("注文の状態: 全発注先が受付済み → notified、失敗・不達あり → notification_failed、送信中 → pending、停止中・対象外のみ → accepted", () => {
  const d = (status, extra = {}) => ({ kind: "dealer", status, ...extra });
  assert.equal(overallOrderStatus([]), "accepted");
  assert.equal(overallOrderStatus([d("not_sent"), { kind: "copy", status: "pending" }]), "accepted");
  assert.equal(overallOrderStatus([d("held")]), "accepted");
  assert.equal(overallOrderStatus([d("pending")]), "notification_pending");
  assert.equal(overallOrderStatus([d("accepted"), d("retry")]), "notification_pending");
  assert.equal(overallOrderStatus([d("accepted"), d("not_sent")]), "notified");
  assert.equal(overallOrderStatus([d("accepted", { delivery: "delivered" })]), "notified");
  assert.equal(overallOrderStatus([d("accepted", { delivery: "bounced" })]), "notification_failed");
  assert.equal(overallOrderStatus([d("accepted"), d("failed")]), "notification_failed");
});

test("Resend への送信: 冪等キーを付ける。成功は受付のID。429・5xx・通信断は再試行、それ以外の4xxは再試行しない。キー未設定は送らない", async () => {
  const calls = [];
  const fake = (status, body) => async (url, init) => { calls.push({ url, init }); return { ok: status < 300, status, json: async () => body }; };
  const s = createResendSender({ apiKey: "re_test", from: "IOL <order@mail.example.jp>", fetchImpl: fake(200, { id: "msg_1" }) });
  assert.deepEqual(await s.send({ to: ["a@example.jp"], subject: "件名", text: "本文", replyTo: "r@example.jp", idempotencyKey: "iol-k1" }), { ok: true, id: "msg_1" });
  const { init } = calls[0];
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(init.headers["Idempotency-Key"], "iol-k1");
  assert.equal(init.headers.Authorization, "Bearer re_test");
  assert.deepEqual(JSON.parse(init.body), { from: "IOL <order@mail.example.jp>", to: ["a@example.jp"], subject: "件名", text: "本文", reply_to: ["r@example.jp"] });
  // 表示名は施設ごと(アドレスは MAIL_FROM のまま)。Reply-To は配列で複数(重複は除く)
  await s.send({ to: ["a@example.jp"], subject: "件名", text: "本文", fromName: "テスト眼科（IOL Order）", replyTo: ["u@example.jp", "info@example.jp", "U@example.jp"], idempotencyKey: "iol-k2" });
  const b2 = JSON.parse(calls[1].init.body);
  assert.deepEqual([b2.from, b2.reply_to], ["テスト眼科（IOL Order） <order@mail.example.jp>", ["u@example.jp", "info@example.jp"]]);
  await s.send({ to: ["a@example.jp"], subject: "件名", text: "本文", replyTo: null, idempotencyKey: "iol-k3" });
  assert.ok(!("reply_to" in JSON.parse(calls[2].init.body)), "返信先がなければ付けない");
  for (const [status, retryable] of [[429, true], [500, true], [503, true], [422, false], [401, false], [409, false]]) {
    const r = await createResendSender({ apiKey: "k", from: "f@x.jp", fetchImpl: fake(status, { message: "m" }) }).send({ to: ["a@x.jp"], subject: "s", text: "t", idempotencyKey: "k" });
    assert.deepEqual([r.ok, r.retryable], [false, retryable], String(status));
    assert.ok(!JSON.stringify(r).includes("Bearer"), "エラーにAPIキーを含めない");
  }
  const net = await createResendSender({ apiKey: "k", from: "f@x.jp", fetchImpl: async () => { throw new TypeError("fetch failed"); } }).send({ to: ["a@x.jp"], subject: "s", text: "t", idempotencyKey: "k" });
  assert.deepEqual([net.ok, net.retryable], [false, true]);
  const notConfigured = await createResendSender({ apiKey: "", from: "f@x.jp", fetchImpl: fake(200, { id: "x" }) }).send({ to: ["a@x.jp"], subject: "s", text: "t", idempotencyKey: "k" });
  assert.deepEqual([notConfigured.ok, notConfigured.error], [false, "not-configured"]);
  const badFrom = await createResendSender({ apiKey: "k", from: "IOL Order", fetchImpl: fake(200, { id: "x" }) }).send({ to: ["a@x.jp"], subject: "s", text: "t", idempotencyKey: "k" });
  assert.deepEqual([badFrom.ok, badFrom.error], [false, "not-configured"], "MAIL_FROM にアドレスがなければ送らない");
});

test("Webhook の署名(Svix): 正しい署名だけ受理。改ざん・別の秘密鍵・5分より古い・署名なしは拒否。複数の署名のどれかが一致すればよい", () => {
  const secret = "whsec_" + Buffer.from("test-secret-key-123").toString("base64");
  const key = Buffer.from("test-secret-key-123");
  const now = 1_800_000_000_000, ts = String(now / 1000);
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "msg_1" } });
  const sig = (b, t = ts, k = key) => "v1," + createHmac("sha256", k).update(`msg_x.${t}.${b}`).digest("base64");
  const ok = { secret, id: "msg_x", timestamp: ts, rawBody: Buffer.from(body), nowMs: now };
  assert.equal(verifyWebhookSignature({ ...ok, signature: sig(body) }), true);
  assert.equal(verifyWebhookSignature({ ...ok, signature: `v1,AAAA ${sig(body)}` }), true);
  assert.equal(verifyWebhookSignature({ ...ok, signature: sig(body.replace("delivered", "bounced")) }), false);
  assert.equal(verifyWebhookSignature({ ...ok, rawBody: body.replace("delivered", "bounced"), signature: sig(body) }), false);
  assert.equal(verifyWebhookSignature({ ...ok, signature: sig(body, ts, Buffer.from("other")) }), false);
  const old = String(now / 1000 - 600);
  assert.equal(verifyWebhookSignature({ ...ok, timestamp: old, signature: sig(body, old) }), false);
  assert.equal(verifyWebhookSignature({ ...ok, signature: "" }), false);
  assert.equal(verifyWebhookSignature({ ...ok, secret: "", signature: sig(body) }), false);
});

test("施設のメール設定の検証: ONなら送信先が必須(1件)。OFFでも入力済みの送信先は残す。署名は500文字・10行まで。変更がなければ保存しない", () => {
  assert.deepEqual(validateMailSettings({ copyEnabled: true, copyEmail: "" }).errors, ["注文控えの送信先メールアドレスを入力してください"]);
  assert.equal(validateMailSettings({ copyEnabled: true, copyEmail: "a@b" }).ok, false);
  assert.equal(validateMailSettings({ copyEnabled: true, copyEmail: "a@b.jp,c@d.jp" }).ok, false, "複数は不可");
  assert.equal(validateMailSettings({ copyEnabled: false, copyEmail: "" }).ok, true, "OFFなら送信先なしでよい");
  assert.equal(validateMailSettings({ copyEnabled: false, copyEmail: "", signature: "x".repeat(501) }).ok, false);
  assert.equal(validateMailSettings({ copyEnabled: false, copyEmail: "", signature: "a\n".repeat(11) + "a" }).ok, false);
  const v = validateMailSettings({ copyEnabled: false, copyEmail: "Info@Senju-Eye-Clinic.jp", signature: "署名  \n" });
  assert.deepEqual(v.cleaned, { copyEnabled: false, copyEmail: "info@senju-eye-clinic.jp", signature: "署名" });
  assert.equal(planMailSettingsWrite({ copyEnabled: false, copyEmail: "info@senju-eye-clinic.jp", signature: "署名" }, v.cleaned), null);
  assert.deepEqual(planMailSettingsWrite(null, v.cleaned), v.cleaned, "未設定からは保存する");
});

test("ディーラーの宛名(正式表記・任意): 保存され、変更も検出される。未入力なら保存しない(登録名を使う)", () => {
  const v = validateDealers([{ id: "d1", name: "栗原医療機械店", mailName: " 栗原医療器械店 ", orderEmailsText: "o@example.jp", usageEmailsText: "" }]);
  assert.equal(v.cleaned[0].mailName, "栗原医療器械店");
  const w = planDealerWrites([{ id: "d1", name: "栗原医療機械店", sortOrder: 10, orderEmails: ["o@example.jp"], usageReportEmails: [] }], v.cleaned, "f1");
  assert.equal(w[0].data.mailName, "栗原医療器械店");
  const same = planDealerWrites([{ id: "d1", name: "栗原医療機械店", mailName: "栗原医療器械店", sortOrder: 10, orderEmails: ["o@example.jp"], usageReportEmails: [] }], v.cleaned, "f1");
  assert.deepEqual(same, []);
  const empty = validateDealers([{ id: "d1", name: "A", mailName: "", orderEmailsText: "", usageEmailsText: "" }]);
  assert.equal("mailName" in planDealerWrites([], empty.cleaned, "f1")[0].data, false);
  assert.equal(validateDealers([{ id: null, name: "A", mailName: "x".repeat(101), orderEmailsText: "", usageEmailsText: "" }]).ok, false);
});
