import test from "node:test";
import assert from "node:assert/strict";
import { dealerMode, resolveLineDealer, dealerDispatch, dealerLabel } from "../src/domain/dealer-selection.js";
import { resolveLineDealer as serverResolve, dealerDispatch as serverDispatch } from "../functions/src/orders.js";
import { toOrderLines, lineKey } from "../src/domain/order-lines.js";
import { buildCreateOrderRequest } from "../src/domain/order-request.js";
import { buildLensOptions, findLensOption } from "../src/domain/lens-options.js";
import { IOL_MODELS } from "../src/data/iol-models.js";
import { buildOrderMailPreview } from "../src/domain/order-mail.js";

const A = { id: "dA", name: "A商会", orderEmails: ["a@example.jp"] };
const B = { id: "dB", name: "B医療", orderEmails: [] };
const C = { id: "dC", name: "C商会", orderEmails: ["bad", " c@example.jp "] };

test("入力欄の種類: 0社=none / 1社=auto / 2社以上=choose", () => {
  assert.deepEqual([[], [A], [A, B], [A, B, C]].map(dealerMode), ["none", "auto", "choose", "choose"]);
});

test("画面とサーバーの判定が一致する(全ての組み合わせ): 発注先の決定と、実送信の可否", () => {
  const sets = [[], [A], [B], [A, B], [A, B, C]];
  const wants = [undefined, null, "", "dA", "dB", "dC", "nope"];
  for (const dealers of sets) for (const want of wants) {
    assert.deepEqual(resolveLineDealer(dealers, want), serverResolve(dealers, want), JSON.stringify([dealers.map(d => d.id), want]));
  }
  for (const d of [null, undefined, A, B, C, { id: "x" }, { id: "y", orderEmails: ["not-an-email"] }, { id: "z", orderEmails: [null, 3] }]) {
    assert.deepEqual(dealerDispatch(d), serverDispatch(d));
  }
});

test("規則: 0社=発注先なし、1社=自動(指定は一致のみ)、2社以上=選択必須(未選択はエラー)", () => {
  assert.deepEqual(resolveLineDealer([], ""), { ok: true, dealer: null });
  assert.equal(resolveLineDealer([], "dA").ok, false);
  assert.deepEqual(resolveLineDealer([A], ""), { ok: true, dealer: A });
  assert.equal(resolveLineDealer([A], "dB").ok, false);
  assert.deepEqual(resolveLineDealer([A, B], ""), { ok: false, error: "select" });
  assert.deepEqual(resolveLineDealer([A, B], "dB"), { ok: true, dealer: B });
  assert.deepEqual(resolveLineDealer([A, B], "zz"), { ok: false, error: "not-found" });
});

test("確認画面の文言: 発注先未設定 / 発注先 名前 / 発注用メール未登録は自動送信不可を明示", () => {
  assert.equal(dealerLabel(null), "発注先未設定");
  assert.equal(dealerLabel(A), "発注先 A商会");
  assert.match(dealerLabel(B), /発注先 B医療.*発注用メール未登録.*自動送信不可/);
  assert.equal(dealerLabel(C), "発注先 C商会", "有効な発注用メールが1件あれば送信可");
});

test("明細・リクエスト: 発注先IDだけをサーバーへ送る(名前・メールは送らない)。0社ならdealerIdなし。発注先が違えば別の明細", () => {
  const options = buildLensOptions(IOL_MODELS);
  const v = (dealer, dealerExplicit = true) => ({ lens: findLensOption(options, "jj-dib00v"), power: "+20.0D", quantity: 1, surgeryDate: "2026-11-10", doctor: { id: "o1", name: "山田" }, dealer, dealerExplicit });
  const lines = toOrderLines([v(A), v(null)]);
  assert.deepEqual([lines[0].dealerId, lines[0].dealerName, lines[1].dealerId], ["dA", "A商会", ""]);
  const req = buildCreateOrderRequest({ facilityId: "f", clientRequestId: "req-0123456789abcdef", lines, notes: "" });
  assert.equal(req.lines[0].dealerId, "dA");
  assert.equal("dealerId" in req.lines[1], false);
  // 1社の自動選択(利用者が選んだものではない)は、IDを送らない(サーバーが決める。確認画面には名前を出す)
  const auto = toOrderLines([v(A, false)])[0];
  assert.deepEqual([auto.dealerId, auto.dealerName], ["dA", "A商会"]);
  assert.equal("dealerId" in buildCreateOrderRequest({ facilityId: "f", clientRequestId: "req-0123456789abcdef", lines: [auto], notes: "" }).lines[0], false);
  assert.ok(!JSON.stringify(req).includes("a@example.jp") && !JSON.stringify(req).includes("A商会"));
  assert.notEqual(lineKey(v(A)), lineKey(v(B)));
});

test("メールdry-run との一致: 注文時に決まった発注先・送信可否が、メール生成の振り分け・ブロックと同じ", () => {
  const lines = [
    { lineNo: 1, item: { displayName: "J&J / DIB00V", manufacturer: "J&J", model: "DIB00V", power: "+20.0D", quantity: 1 }, surgeryDate: "2026-11-10", doctor: { id: "o1", name: "山田" } },
    { lineNo: 2, item: { displayName: "J&J / DIB00V", manufacturer: "J&J", model: "DIB00V", power: "+21.0D", quantity: 1 }, surgeryDate: "2026-11-10", doctor: { id: "o1", name: "山田" } }
  ];
  const dealers = { dA: A, dB: B };
  const stamped = lines.map((l, i) => { const d = i === 0 ? A : B; return { ...l, dealerId: d.id, dealer: { id: d.id, name: d.name }, dispatch: serverDispatch(d) }; });
  const p = buildOrderMailPreview({ id: "o", orderNumber: "IOL-1", createdBy: { email: "u@example.jp" }, lines: stamped }, { dealers });
  assert.deepEqual(p.mails.map(m => [m.dealerId, m.status, m.blockedReason]), [["dA", "ready", null], ["dB", "blocked", "no-order-email"]]);
  assert.deepEqual(stamped.map(l => l.dispatch.allowed), p.mails.map(m => m.status === "ready"), "注文時の dispatch と、メール生成時の判定が一致");
});
