import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createDealerPortalApi, isPortalUnavailable } from "../src/data/dealer-portal-api.js";
import { facilityFilterOf, selectionFor, scopeLabel, formatJstDateTime, formatDate, dealerEntryUrl, DEALER_ACCESS_NOTICE } from "../src/domain/dealer-portal.js";
import { buildDealerOrderView, ownLinesOf, initialFacilitySelection, jstDayStartMs } from "../functions/src/dealer-portal.js";

test("ディーラー画面 API: 送るのは各操作の選択値だけ(役割・UID・メール・余分な項目は送らない)", async () => {
  const calls = [];
  const api = createDealerPortalApi({ functions: {}, httpsCallable: (f, name) => async (payload) => { calls.push([name, payload]); return { data: {} }; } });
  await api.listOrders({ companyId: "c", from: "2026-10-01", to: "2026-10-27", facilityFilter: { mode: "all" }, role: "companyAdmin", uid: "x", limit: 50 });
  await api.getOrder({ companyId: "c", receiptId: "rcp-1", facilityId: "fB" });
  await api.setMyAssignments({ companyId: "c", facilityIds: ["fA"], staffUid: "other" });
  await api.sendCode({ to: "other@example.jp" });
  await api.verifyCode({ code: "12345678", staffId: "dstf_x" });
  await api.cancelInvitation({ companyId: "c", staffId: "dstf_1", invitationId: "x" });
  await api.updateStaff({ companyId: "c", staffId: "dstf_1", status: "disabled", uid: "u" });
  await api.grant({ facilityId: "fA", localDealerId: "d1", revision: 2, role: "admin" });
  await api.inviteStaff({ companyId: "c", email: "a@b.jp", name: "n", role: "reader", platformAdmin: true });
  assert.deepEqual(calls, [
    ["dealerPortalApi", { action: "list", companyId: "c", from: "2026-10-01", to: "2026-10-27", facilityFilter: { mode: "all" }, limit: 50 }],
    ["dealerPortalApi", { action: "get", companyId: "c", receiptId: "rcp-1" }],
    ["dealerPortalApi", { action: "setAssignments", companyId: "c", facilityIds: ["fA"] }],
    ["dealerPortalApi", { action: "sendCode" }],
    ["dealerPortalApi", { action: "verifyCode", code: "12345678" }],
    ["dealerPortalOperator", { action: "cancelInvitation", companyId: "c", staffId: "dstf_1" }],
    ["dealerPortalOperator", { action: "updateStaff", companyId: "c", staffId: "dstf_1", status: "disabled" }],
    ["facilityDealerPortal", { action: "grant", facilityId: "fA", localDealerId: "d1", revision: 2 }],
    ["dealerPortalOperator", { action: "inviteStaff", companyId: "c", email: "a@b.jp", name: "n", role: "reader" }]]);
});

test("ディーラー画面: 施設の選択・検索範囲の表示・日時", () => {
  const fs2 = [{ id: "fB", name: "B", assigned: true }, { id: "fA", name: "A", assigned: false }];
  assert.deepEqual(selectionFor("assigned", fs2), ["fB"]);
  assert.deepEqual(selectionFor("all", fs2), ["fB", "fA"]);
  assert.deepEqual(selectionFor("none", fs2), []);
  assert.deepEqual(facilityFilterOf(["fA", "fA", "fB"]), { mode: "selected", facilityIds: ["fA", "fB"] });
  assert.equal(scopeLabel(["fB"], fs2), "担当施設(1施設)");
  assert.equal(scopeLabel(["fA", "fB"], fs2), "閲覧可能な全施設(2施設)");
  assert.equal(scopeLabel([], fs2), "施設が選択されていません(0件)");
  assert.equal(scopeLabel(["fA"], fs2), "選択した施設(1施設)");
  assert.equal(scopeLabel([], []), "閲覧できる施設はまだありません");
  assert.equal(formatJstDateTime("2026-10-26T15:30:00.000Z"), "2026/10/27 00:30");
  assert.equal(formatJstDateTime("bad"), "—");
  assert.equal(formatDate("2026-11-06"), "2026/11/06");
  assert.equal(dealerEntryUrl("https://iol.medconf.jp"), "https://iol.medconf.jp/dealer.html");
  assert.match(DEALER_ACCESS_NOTICE, /有効な全担当者.*許可後の新規注文.*自社宛ての明細.*閲覧制限になりません.*共通備考は初期状態では共有しません/);
  assert.equal(isPortalUnavailable({ code: "functions/failed-precondition", message: "ディーラー画面は現在ご利用いただけません" }), true);
  assert.equal(isPortalUnavailable({ code: "functions/not-found", message: "NOT_FOUND" }), true, "未配備");
  assert.equal(isPortalUnavailable({ code: "functions/permission-denied", message: "この施設の管理者・副管理者のみ操作できます" }), false);
});

test("サーバーの抽出(純粋関数): 自社宛ての明細だけ・番号の振り直し・枚数の再集計・自社の通知だけ・共通備考などは返さない", () => {
  const order = {
    facilityId: "fA", facilityName: "A眼科", orderNumber: "IOL-20261027-03", notes: "備考", requestId: "r", contentHash: "h",
    createdBy: { uid: "u", email: "u@x.jp", displayName: "入力者", role: "proxy" }, status: "accepted", lineCount: 3, totalQuantity: 4,
    lines: [
      { lineNo: 1, dealerId: "dY", dealer: { id: "dY", name: "ワイ" }, item: { manufacturer: "J&J", model: "M", power: "+18.0D", quantity: 1 }, surgeryDate: "2026-11-01", doctor: { id: "o1", name: "山田", email: "d@h.jp" } },
      { lineNo: 2, dealerId: "dX", dealer: { id: "dX", name: "エックス" }, item: { manufacturer: "J&J", model: "M", isToric: true, toricModel: "T3", power: "+20.0D", quantity: 2 }, surgeryDate: "2026-11-02", doctor: { id: "o1", name: "山田", email: "d@h.jp" } },
      { lineNo: 3, dealerId: null, dealer: null, item: { power: "+19.0D", quantity: 1 } }],
    notifications: [
      { id: "d_dY", kind: "dealer", dealerId: "dY", dealerName: "ワイ", status: "failed", error: "550 bad" },
      { id: "d_dX", kind: "dealer", dealerId: "dX", dealerName: "エックス", status: "accepted", delivery: "delivered", error: "x" },
      { id: "copy", kind: "copy", dealerName: "注文控え", status: "accepted" }]
  };
  const v = buildDealerOrderView(order, "dX", { receiptId: "rcp-1" });
  assert.deepEqual(v.lines, [{ no: 1, manufacturer: "J&J", model: "M", toricModel: "T3", isToric: true, isMultifocal: false, power: "+20.0D", quantity: 2, surgeryDate: "2026-11-02", doctorName: "山田" }]);
  assert.deepEqual([v.lineCount, v.totalQuantity, v.mail.status, v.mail.delivery.status], [1, 2, "accepted", "delivered"]);
  const json = JSON.stringify(v);
  for (const s of ["備考", "ワイ", "550", "注文控え", "d@h.jp", "入力者", "proxy", "requestId", "contentHash", "+18.0D", "+19.0D", "\"error\""]) assert.ok(!json.includes(s), s);
  assert.equal(buildDealerOrderView(order, "dZ"), null, "自社宛ての明細がなければ返さない");
  assert.equal(ownLinesOf({ lines: [{ dealer: { id: "dX" } }] }, "dX").length, 1, "dealer.id だけでも判定");
  assert.deepEqual(initialFacilitySelection([{ id: "fA", name: "A" }], ["fZ"]).selectedFacilityIds, ["fA"], "許可のない担当施設は無視");
  assert.equal(jstDayStartMs("2026-10-27"), Date.parse("2026-10-26T15:00:00Z"));
  assert.equal(jstDayStartMs("2026-13-01"), null);
});

test("Firestore Rules: ディーラー専用画面の新しい領域は明示的にすべて拒否(読み書き)", () => {
  const rules = fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
  for (const m of ["match /dealerCompanies/{document=**}", "match /dealerStaff/{staffId}", "match /dealerPortalGrants/{id}", "match /dealerPortalAuditLogs/{id}", "match /dealerAuthBindings/{id}", "match /dealerAuthChallenges/{id}", "match /dealerAuthCodeJobs/{id}", "match /dealerPortalLinks/{localDealerId}"]) {
    const i = rules.indexOf(m);
    assert.ok(i > 0, m);
    assert.match(rules.slice(i, i + 120), /allow read, write: if false;/, m);
  }
});

test("ディーラー画面 API: 確認済みの端末の値を担当者の呼び出しに付け、サーバーが返した値は保存して画面には渡さない(施設・運営者の呼び出しには付けない)", async () => {
  const calls = [];
  let saved = "tok-1", persists = true;
  const device = { get: () => saved, set: (t) => { saved = t; return persists; } };
  const api = createDealerPortalApi({ functions: {}, device, httpsCallable: (f, name) => async (payload) => {
    calls.push([name, payload]);
    return { data: payload.action === "verifyCode" ? { ok: true, deviceToken: "tok-2" } : { ok: true } };
  } });
  await api.context({ companyId: "c" });
  assert.deepEqual(await api.verifyCode({ code: "12345678" }), { ok: true, deviceSaved: true }, "値は画面に渡さない(保存できたかだけ)");
  assert.equal(saved, "tok-2");
  await api.sendCode();
  await api.facilityStatus({ facilityId: "fA" });
  assert.deepEqual(calls, [
    ["dealerPortalApi", { action: "context", companyId: "c", deviceToken: "tok-1" }],
    ["dealerPortalApi", { action: "verifyCode", code: "12345678", deviceToken: "tok-1" }],
    ["dealerPortalApi", { action: "sendCode", deviceToken: "tok-2" }],
    ["facilityDealerPortal", { action: "status", facilityId: "fA" }]
  ]);
  // 保存がない(未確認の端末)なら付けない
  saved = null; calls.length = 0;
  await api.companies();
  assert.deepEqual(calls, [["dealerPortalApi", { action: "companies" }]]);
  // 端末に保存できなかったら、そのことを返す(画面はこの間だけメモリの値で使い、案内を出す。AB-04)
  persists = false;
  assert.deepEqual(await api.verifyCode({ code: "12345678" }), { ok: true, deviceSaved: false });
});
