import test from "node:test";
import assert from "node:assert/strict";
import { buildOrderMailPreview, orderRecipients, buildSubject, TEMPLATE_STATUS, isTemplateConfirmed } from "../src/domain/order-mail.js";

const item = (over = {}) => ({ manufacturer: "J&J", model: "DIB00V", displayName: "J&J / DIB00V", isToric: false, isMultifocal: false, toricModel: "", power: "+20.0D", quantity: 1, ...over });
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });
const line = (n, dealer, over = {}) => ({
  lineNo: n, item: item(over.item), surgeryDate: over.surgeryDate || "2026-11-10", doctor: { id: "o1", name: over.doctor || "山田" },
  dealerId: dealer ? dealer.id : null, dealer, dispatch: over.dispatch || { allowed: Boolean(dealer), reason: dealer ? null : "dealer-unset" }
});
const A = { id: "dA", name: "A商会" }, B = { id: "dB", name: "B医療" };
const order = (lines, over = {}) => ({
  id: "x", orderNumber: "IOL-20261025-0001", facilityName: "テスト眼科", createdAt: ts("2026-10-25T05:30:00Z"),
  createdBy: { email: "login@example.jp", displayName: "ログイン太郎" }, notes: "備考テキスト", lines, ...over
});
const settings = {
  dA: { name: "A商会", orderEmails: ["order-a@example.jp"], usageReportEmails: ["report-a@example.jp"] },
  dB: { name: "B医療", orderEmails: ["order-b1@example.jp", "ORDER-B2@example.jp"], usageReportEmails: ["report-b@example.jp"] }
};

test("複数ディーラー: 明細をディーラーごとに振り分け、ディーラーごとに1通。担当医・手術日が違う明細も対応付く", () => {
  const p = buildOrderMailPreview(order([
    line(1, A), line(2, B, { doctor: "佐藤", surgeryDate: "2026-11-12", item: { quantity: 2, power: "+18.5D" } }), line(3, A, { surgeryDate: "2026-11-20" })
  ]), { dealers: settings });
  assert.equal(p.templateStatus, TEMPLATE_STATUS);
  assert.deepEqual(p.mails.map(m => [m.dealerId, m.lineNos, m.totalQuantity, m.status]), [["dA", [1, 3], 2, "ready"], ["dB", [2], 2, "ready"]]);
  assert.equal(p.allReady, true);
  assert.deepEqual(p.mails[0].to, ["order-a@example.jp"]);
  assert.match(p.mails[0].subject, /テスト眼科.*IOL-20261025-0001.*A商会宛 2件・合計2枚/);
  assert.match(p.mails[0].body, /\[レンズ1\] J&J DIB00V \+20\.0D 1枚\n\s+手術日: 2026-11-10 {2}担当医: 山田/);
  assert.match(p.mails[0].body, /\[レンズ3\].*\n\s+手術日: 2026-11-20/);
  assert.ok(!p.mails[0].body.includes("レンズ2"), "他のディーラーの明細は含めない");
  assert.match(p.mails[1].body, /\[レンズ2\] J&J DIB00V \+18\.5D 2枚\n\s+手術日: 2026-11-12 {2}担当医: 佐藤/);
  assert.match(p.mails[0].body, /発注者: ログイン太郎/);
  assert.match(p.mails[0].body, /備考: 備考テキスト/);
});

test("宛先は発注用メールだけ。使用報告用メールは宛先にも本文にも出ない。重複・大文字小文字・不正な形式を整理", () => {
  const p = buildOrderMailPreview(order([line(1, B)]), { dealers: settings });
  assert.deepEqual(p.mails[0].to, ["order-b1@example.jp", "order-b2@example.jp"]);
  assert.ok(!JSON.stringify(p).includes("report-b@example.jp"));
  assert.deepEqual(orderRecipients({ orderEmails: ["a@example.jp", "A@example.jp", "bad", "", "x@y", null], usageReportEmails: ["u@example.jp"] }), ["a@example.jp"]);
  assert.deepEqual(orderRecipients({ usageReportEmails: ["u@example.jp"] }), [], "使用報告用だけでは宛先にならない");
  assert.deepEqual(orderRecipients(null), []);
});

test("生成時点の検証: 発注先が削除済み・発注用メール未登録は送信不可(宛先なし)。他のディーラーの分は生成できる", () => {
  const p = buildOrderMailPreview(order([line(1, A), line(2, B)]), { dealers: { dA: { name: "A商会", usageReportEmails: ["report-a@example.jp"] } } });
  assert.deepEqual(p.mails.map(m => [m.dealerId, m.status, m.blockedReason, m.to]), [["dA", "blocked", "no-order-email", []], ["dB", "blocked", "dealer-deleted", []]]);
  assert.equal(p.allReady, false);
  const mixed = buildOrderMailPreview(order([line(1, A), line(2, B)]), { dealers: { dA: settings.dA } });
  assert.deepEqual(mixed.mails.map(m => m.status), ["ready", "blocked"]);
  assert.equal(mixed.allReady, false, "1通でも送れなければ、注文全体は ready にしない");
});

test("dispatch.allowed は参考情報: 発注時と現在の設定が食い違うと警告を出し、判定は現在の設定で行う", () => {
  const stale = line(1, A, { dispatch: { allowed: false, reason: "no-order-email" } });   // 発注時は送れなかったが、その後メールが登録された
  const p1 = buildOrderMailPreview(order([stale]), { dealers: settings });
  assert.equal(p1.mails[0].status, "ready");
  assert.match(p1.mails[0].warnings.join("\n"), /発注時は送信不可/);
  const ok = line(1, A);                                                                    // 発注時は送れたが、その後メールが消えた
  const p2 = buildOrderMailPreview(order([ok]), { dealers: { dA: { name: "A商会", orderEmails: [] } } });
  assert.equal(p2.mails[0].status, "blocked");
  assert.match(p2.mails[0].warnings.join("\n"), /発注時は送信可/);
  const renamed = buildOrderMailPreview(order([line(1, A)]), { dealers: { dA: { ...settings.dA, name: "新A商会" } } });
  assert.match(renamed.mails[0].warnings.join("\n"), /A商会.*新A商会/);
  assert.match(renamed.mails[0].subject, /新A商会宛/, "宛名は現在の名称");
});

test("発注先未設定の明細はメールにしない(unrouted)。旧形式の注文(発注先の記録なし)は送信対象にならない", () => {
  const p = buildOrderMailPreview(order([line(1, A), line(2, null)]), { dealers: settings });
  assert.deepEqual(p.unrouted, [{ lineNo: 2, reason: "dealer-unset" }]);
  assert.deepEqual(p.mails.map(m => m.lineNos), [[1]]);
  assert.equal(p.allReady, false, "未設定の明細が残る注文は ready にしない");
  const legacy = buildOrderMailPreview({ id: "o", orderNumber: "IOL-1", createdAt: ts("2026-08-01T00:00:00Z"), item: item(), surgeryDate: "2026-09-01", orderer: { name: "最古" } }, { dealers: settings });
  assert.deepEqual([legacy.mails.length, legacy.unrouted.length, legacy.allReady], [0, 1, false]);
});

test("件名・宛先に改行を入れさせない(ヘッダー注入の防止)", () => {
  assert.ok(!/[\r\n]/.test(buildSubject({ facilityName: "A\r\nBcc: evil@example.jp", orderNumber: "1", dealerName: "B\nC", lineCount: 1, totalQuantity: 1 })));
  const p = buildOrderMailPreview(order([line(1, A)]), { facilityName: "眼科\nBcc: evil@example.jp", dealers: { dA: { name: "A商会\nX", orderEmails: ["ok@example.jp", "evil@example.jp\nBcc: z@example.jp"] } } });
  assert.ok(!/[\r\n]/.test(p.mails[0].subject));
  assert.deepEqual(p.mails[0].to, ["ok@example.jp"]);
});

test("トーリック・多焦点の表記と合計。メール送信の関数は存在しない(プレビューのみ)", async () => {
  const p = buildOrderMailPreview(order([line(1, A, { item: { isToric: true, toricModel: "DIW300", model: "DIWxxx", displayName: "J&J / DIWxxx (トーリック)" } })]), { dealers: settings });
  assert.match(p.mails[0].body, /DIW300\(トーリック\)/);
  const mod = await import("../src/domain/order-mail.js");
  assert.ok(!Object.keys(mod).some(k => /send|smtp|post/i.test(k)));
});

test("暫定テンプレートは正式版として扱わない: 各メールに draft-unconfirmed と reviewRequired が付き、備考は本文とは別にも返す。確認済みフラグは false", () => {
  const p = buildOrderMailPreview(order([line(1, A)], { notes: "  備考テキスト  " }), { dealers: settings });
  assert.equal(p.templateStatus, "draft-unconfirmed");
  assert.deepEqual([p.mails[0].templateStatus, p.mails[0].reviewRequired, p.mails[0].notes], ["draft-unconfirmed", true, "備考テキスト"]);
  assert.equal(isTemplateConfirmed(), false, "確認済みになるまで、実送信の処理から使ってはいけない");
});
