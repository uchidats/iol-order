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

test("明細・リクエスト: 発注先IDだけをサーバーへ送る(名前・メールは送らない)。0社なら dealerId: null。発注先が違えば別の明細", () => {
  const options = buildLensOptions(IOL_MODELS);
  const v = (dealer) => ({ lens: findLensOption(options, "jj-dib00v"), power: "+20.0D", quantity: 1, surgeryDate: "2026-11-10", doctor: { id: "o1", name: "山田" }, dealer });
  const lines = toOrderLines([v(A), v(null)]);
  assert.deepEqual([lines[0].dealerId, lines[0].dealerName, lines[1].dealerId], ["dA", "A商会", ""]);
  const req = buildCreateOrderRequest({ facilityId: "f", clientRequestId: "req-0123456789abcdef", lines, notes: "" });
  assert.equal(req.lines[0].dealerId, "dA");
  assert.equal(req.lines[1].dealerId, null, "発注先なしで確認したことを明示する");
  // 1社の自動選択も、確認画面に表示した発注先のIDを送る(確認後にディーラー設定が変わったら、サーバーは切り替えずに拒否する)
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

import { summarizeDealers } from "../src/domain/dealer-selection.js";

test("確認画面の発注先カード: 1社は1回だけ(allSame)・複数社は発注先ごとにレンズ番号をまとめる・未設定/メール未登録の警告", () => {
  const ln = (lineNo, d) => ({ lineNo, dealerId: d ? d.id : "", dealerName: d ? d.name : "", dealerOrderEmails: d ? d.orderEmails : [] });
  // 1社(全明細が同じ): 名称は1つだけ
  const one = summarizeDealers([ln(1, A), ln(2, A), ln(3, A)]);
  assert.deepEqual([one.allSame, one.groups.length, one.groups[0].name, one.groups[0].lineNos, one.groups[0].warning], [true, 1, "A商会", [1, 2, 3], null]);
  // 複数社: 最初に出た順。ディーラーごとにレンズ番号をまとめる(明細の順序が入り混じっても)
  const multi = summarizeDealers([ln(1, A), ln(2, B), ln(3, A), ln(4, B)]);
  assert.equal(multi.allSame, false);
  assert.deepEqual(multi.groups.map(g => [g.name, g.lineNos, g.warning]), [["A商会", [1, 3], null], ["B医療", [2, 4], "発注用メール未登録のため自動送信不可"]]);
  // 発注先未設定(0社): 警告は「発注先未設定」。複数社と未設定の混在もまとめる
  const none = summarizeDealers([ln(1, null), ln(2, null)]);
  assert.deepEqual([none.allSame, none.groups[0].name, none.groups[0].lineNos, none.groups[0].warning], [true, null, [1, 2], "発注先未設定"]);
  const mixed = summarizeDealers([ln(1, A), ln(2, null)]);
  assert.deepEqual(mixed.groups.map(g => [g.name, g.lineNos]), [["A商会", [1]], [null, [2]]]);
  // 発注用メールが有効なら警告なし(判定は dealerDispatch と同じ)
  assert.equal(summarizeDealers([ln(1, C)]).groups[0].warning, null);
});

test("メールアドレスの判定: サーバー(発注用メールの送信可否)・画面/メールプレビュー(isValidEmail)・Rules が同じ入力を受理・拒否する", async () => {
  const fs = await import("node:fs");
  const { isValidEmail } = await import("../src/domain/order-validation.js");
  const { cleanEmails } = await import("../src/domain/order-mail.js");
  const m = fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8").match(/v\.matches\('([^']+)'\)/);
  const rulesRe = new RegExp(m[1].replace(/\\\\/g, "\\")); // ルール内の '\\s' は文字列エスケープ後に '\s' になる
  const cases = {
    "sales@example.jp": true, "s@s.jp": true, "a.b+c@sub.example.co.jp": true, "user@shop.jp": true,
    "user@examplejp": false, "a@b": false, "@example.jp": false, "a b@example.jp": false, "a@@example.jp": false, "a	@example.jp": false, "": false
  };
  for (const [v, ok] of Object.entries(cases)) {
    assert.equal(serverDispatch({ id: "d", orderEmails: [v] }).allowed, ok, `server ${JSON.stringify(v)}`);
    assert.equal(isValidEmail(v), ok, `client ${JSON.stringify(v)}`);
    assert.equal(rulesRe.test(v), ok, `rules ${JSON.stringify(v)}`);
    assert.equal(cleanEmails([v]).length === 1, ok, `mail preview ${JSON.stringify(v)}`);
  }
});

// ---------- 採用IOLごとの既定ディーラー ----------
import { defaultDealerIdOf } from "../src/domain/dealer-selection.js";
import { resolveAdoptedModels } from "../src/data/static-repository.js";
import { planAdoptedWrites } from "../src/domain/facility-settings.js";

test("既定ディーラー: 採用IOLの dealerId は系列に付き、ノントーリック・トーリックの各型番の選択肢から参照できる。登録に無い・未設定は \"\"", () => {
  const adopted = [
    { catalogIolId: "jj-dib00v", enabled: true, dealerId: "dA" },
    { catalogIolId: "jj-diwxxx-toric", enabled: true, dealerId: "dB" },
    { catalogIolId: "alcon-cna0t0", enabled: true },
    { catalogIolId: "hoya-xy1", enabled: false, dealerId: "dA" }
  ];
  const models = resolveAdoptedModels(adopted);
  assert.deepEqual(models.map(m => m.id), ["jj-dib00v", "jj-diwxxx-toric", "alcon-cna0t0"]);
  assert.equal(IOL_MODELS.find(m => m.id === "jj-dib00v").dealerId, undefined, "マスター自体は変えない");
  const opts = buildLensOptions(models);
  const dealers = [{ id: "dA", name: "A" }, { id: "dB", name: "B" }];
  assert.equal(defaultDealerIdOf(findLensOption(opts, "jj-dib00v"), dealers), "dA");
  assert.equal(defaultDealerIdOf(findLensOption(opts, "jj-diwxxx-toric|DIW150"), dealers), "dB");
  assert.equal(defaultDealerIdOf(findLensOption(opts, "jj-diwxxx-toric|DIW600"), dealers), "dB", "同じ系列のどの型番でも");
  assert.equal(defaultDealerIdOf(findLensOption(opts, "alcon-cna0t0"), dealers), "", "未設定");
  assert.equal(defaultDealerIdOf(findLensOption(opts, "jj-dib00v"), [{ id: "dB", name: "B" }]), "", "削除済みのディーラーは使わない");
  assert.equal(defaultDealerIdOf(null, dealers), "");
});

test("既定ディーラー: 採用IOLの書き込み計画(設定・変更・既定なしへ戻す・削除済みの除去・未変更は書かない・従来の呼び出しは同じ結果)", () => {
  const F = "fac1";
  const existing = [
    { id: "jj-dib00v", catalogIolId: "jj-dib00v", enabled: true },
    { id: "alcon-cna0t0", catalogIolId: "alcon-cna0t0", enabled: true, dealerId: "dA" },
    { id: "hoya-xy1", catalogIolId: "hoya-xy1", enabled: false, dealerId: "dGone" }
  ];
  const sel = ["jj-dib00v", "alcon-cna0t0"];
  const valid = new Set(["dA", "dB"]);
  // 従来の呼び出し(既定ディーラーの指定なし): 採用の変更だけ。既存の dealerId は維持
  assert.deepEqual(planAdoptedWrites(IOL_MODELS, existing, sel, F), []);
  assert.deepEqual(planAdoptedWrites(IOL_MODELS, existing, ["jj-dib00v"], F), [{ id: "alcon-cna0t0", data: { facilityId: F, catalogIolId: "alcon-cna0t0", enabled: false, dealerId: "dA" } }]);
  // 設定・変更・既定なし
  assert.deepEqual(planAdoptedWrites(IOL_MODELS, existing, sel, F, { "jj-dib00v": "dB", "alcon-cna0t0": "dA" }, valid),
    [{ id: "jj-dib00v", data: { facilityId: F, catalogIolId: "jj-dib00v", enabled: true, dealerId: "dB" } },
     { id: "hoya-xy1", data: { facilityId: F, catalogIolId: "hoya-xy1", enabled: false } }], "未変更(alcon)は書かない。削除済み(hoya の dGone)は外す");
  const cleared = planAdoptedWrites(IOL_MODELS, existing, sel, F, { "jj-dib00v": "", "alcon-cna0t0": "" }, valid);
  assert.deepEqual(cleared.find(w => w.id === "alcon-cna0t0").data, { facilityId: F, catalogIolId: "alcon-cna0t0", enabled: true }, "既定なしは dealerId を書かない");
  assert.equal(cleared.some(w => w.id === "jj-dib00v"), false);
  // 登録に無いディーラーを指定しても保存しない
  assert.equal(planAdoptedWrites(IOL_MODELS, existing, sel, F, { "jj-dib00v": "dX" }, valid).some(w => w.id === "jj-dib00v"), false);
  // 新しく採用したモデルに既定ディーラー
  assert.deepEqual(planAdoptedWrites(IOL_MODELS, existing, [...sel, "hoya-py-60ad"], F, { "hoya-py-60ad": "dA" }, valid).find(w => w.id === "hoya-py-60ad").data,
    { facilityId: F, catalogIolId: "hoya-py-60ad", enabled: true, dealerId: "dA" });
});
