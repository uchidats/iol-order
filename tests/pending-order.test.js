import test from "node:test";
import assert from "node:assert/strict";
import { pendingOrderKey, deriveOrderId, sameRequestContent, isDefinitiveRejection, createPendingOrderStore, reconcilePendingOrder } from "../src/domain/pending-order.js";
import { deriveOrderId as serverDeriveOrderId } from "../functions/src/orders.js";
import { buildCreateOrderRequest } from "../src/domain/order-request.js";

const memStorage = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; };
const pending = (requestId, notes = "") => ({
  facilityId: "f1", clientRequestId: requestId, notes,
  lines: [{ lineNo: 1, modelId: "jj-dib00v", power: "+20.0D", quantity: 1, surgeryDate: "2026-11-10", doctorId: "o1", dealerId: "d1" }]
});
const req = (id, notes) => buildCreateOrderRequest(pending(id, notes));

test("注文ドキュメントIDの導出がサーバー(deriveOrderId)と一致する(受付状況の照会に使う)", async () => {
  for (const [uid, rid] of [["u1", "req-0123456789abcdef"], ["uidXYZ", "5b0c2f1e-9a1d-4c7e-8f00-123456789abc"]]) {
    assert.equal(await deriveOrderId(uid, rid), serverDeriveOrderId(uid, rid));
  }
});

test("同じ確認内容は、requestId が違っても同じ送信内容と判定する。内容(備考・発注先など)が違えば別", () => {
  assert.ok(sameRequestContent(req("a".repeat(16)), req("b".repeat(16))));
  assert.ok(!sameRequestContent(req("a".repeat(16)), req("a".repeat(16), "変更")));
  const other = pending("c".repeat(16)); other.lines[0].dealerId = "d2";
  assert.ok(!sameRequestContent(req("a".repeat(16)), buildCreateOrderRequest(other)));
  // 重複の了承は注文の内容ではない(了承して送った注文と、確認画面へ進む前の同じ内容は、同じ注文の再送として扱う=二重発注を防ぐ)
  assert.ok(sameRequestContent({ ...req("a".repeat(16)), duplicateAcknowledged: true }, req("b".repeat(16))));
});

test("保存・読み込み・削除(利用者・施設ごと)。保存できない・壊れた値でも画面を止めない", () => {
  const s = memStorage();
  const store = createPendingOrderStore(s, pendingOrderKey("u1", "f1"));
  assert.equal(store.load(), null);
  assert.equal(store.save(req("a".repeat(16))), true);
  assert.equal(store.load().requestId, "a".repeat(16));
  assert.equal(createPendingOrderStore(s, pendingOrderKey("u1", "f2")).load(), null, "施設が違えば別");
  store.clear();
  assert.equal(store.load(), null);
  s.setItem(pendingOrderKey("u1", "f1"), "{broken");
  assert.equal(store.load(), null);
  const throwing = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); }, removeItem() { throw new Error("x"); } };
  const t = createPendingOrderStore(throwing, "k");
  assert.equal(t.save(req("a".repeat(16))), false);
  assert.equal(t.load(), null);
  t.clear();
});

test("未確定の注文の扱い: 照会の結果と内容の一致で決める", async () => {
  const saved = { requestId: "a".repeat(16), request: req("a".repeat(16)) };
  const same = req("n".repeat(16)), changed = req("n".repeat(16), "変更");
  const asked = [];
  const none = async (id) => { asked.push(id); return null; };
  const found = async () => ({ id: "o1", orderNumber: "IOL-20261025-0001" });
  const fail = async () => { throw new Error("offline"); };
  assert.deepEqual(await reconcilePendingOrder(null, same, none), { action: "new" });
  assert.deepEqual(asked, [], "未確定の注文がなければ照会しない");
  // 再読み込み・戻る操作のあと同じ内容 → 同じ requestId で再送(サーバーで冪等)
  assert.deepEqual(await reconcilePendingOrder(saved, same, none), { action: "reuse", requestId: "a".repeat(16) });
  assert.deepEqual(asked, ["a".repeat(16)]);
  assert.deepEqual(await reconcilePendingOrder(saved, changed, none), { action: "new" });
  assert.deepEqual(await reconcilePendingOrder(saved, same, found), { action: "accepted", order: { id: "o1", orderNumber: "IOL-20261025-0001" }, same: true });
  assert.equal((await reconcilePendingOrder(saved, changed, found)).same, false);
  // 照会できない: 同じ内容なら同じ requestId で安全に再送できる。内容を変えた場合は、結果を確認できるまで進ませない
  assert.deepEqual(await reconcilePendingOrder(saved, same, fail), { action: "reuse", requestId: "a".repeat(16) });
  assert.deepEqual(await reconcilePendingOrder(saved, changed, fail), { action: "unknown" });
});

test("サーバーが明確に拒否したエラーだけを「注文は作られていない」とみなす(通信断・タイムアウト・不明は未確定)", () => {
  for (const code of ["functions/invalid-argument", "permission-denied", "functions/failed-precondition", "functions/resource-exhausted", "functions/unauthenticated"]) assert.ok(isDefinitiveRejection({ code }), code);
  for (const code of ["functions/unavailable", "functions/deadline-exceeded", "functions/internal", "functions/already-exists", "", undefined]) assert.ok(!isDefinitiveRejection({ code }), String(code));
  assert.ok(!isDefinitiveRejection(new TypeError("net")));
});
