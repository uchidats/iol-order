import test from "node:test";
import assert from "node:assert/strict";
import { orderLinesOf, summarizeOrder, sortOrdersNewestFirst, formatDateTimeJst, toMillis, describeLine } from "../src/domain/order-history.js";
import { summarizeHistoryOrder, visibleOrders, groupHistoryLinesByDealer } from "../src/domain/order-history-view.js";
import { orderLinesOf as serverOrderLinesOf } from "../functions/src/orders.js";

const item = (over = {}) => ({ modelId: "jj-dib00v", manufacturer: "J&J", model: "DIB00V", displayName: "J&J / DIB00V", isToric: false, isMultifocal: false, toricModel: "", power: "+20.0D", quantity: 1, ...over });
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });

// 現行(schemaVersion 3): 明細ごとに担当医・ディーラー。担当医・手術日・ディーラーが異なる明細を含む
const v3 = {
  id: "a", schemaVersion: 3, orderNumber: "IOL-20261025-0001", createdAt: ts("2026-10-25T05:30:00Z"), testOrder: true,
  createdBy: { uid: "u1", email: "login@example.jp", displayName: "ログイン太郎" },
  lines: [
    { lineNo: 1, item: item(), surgeryDate: "2026-11-10", doctor: { id: "o1", name: "山田" }, dealerId: "d1", dealer: { id: "d1", name: "A商会" } },
    { lineNo: 2, item: item({ modelId: "jj-diwxxx-toric", model: "DIWxxx (トーリック)", displayName: "J&J / DIWxxx (トーリック)", isToric: true, toricModel: "DIW300", power: "+18.5D", quantity: 2 }),
      surgeryDate: "2026-11-12", doctor: { id: "o2", name: "佐藤" }, dealerId: null, dealer: null }
  ]
};
// 旧 schemaVersion 2: 明細に担当医なし・注文全体の orderer
const v2 = { id: "b", orderNumber: "IOL-20260901-0002", createdAt: ts("2026-09-01T00:00:00Z"), orderer: { id: "o9", name: "旧注文者" }, createdBy: { email: "x@example.jp" },
  lines: [{ lineNo: 1, item: item({ quantity: 2 }), surgeryDate: "2026-10-01", dealerId: null, dealer: null }] };
// 旧 schemaVersion 1: トップレベルの item
const v1 = { id: "c", orderNumber: "IOL-20260801-0001", createdAt: ts("2026-08-01T00:00:00Z"), item: item(), surgeryDate: "2026-09-01", orderer: { id: "o9", name: "最古注文者" }, createdBy: null };

test("一覧: 注文日時(日本時間)・発注者(ログイン情報)・件数・合計枚数。担当医は発注者ではない", () => {
  const s = summarizeOrder(v3);
  assert.equal(s.createdAtLabel, "2026/10/25 14:30");
  assert.equal(s.orderedBy, "ログイン太郎");
  assert.equal(s.lineCount, 2);
  assert.equal(s.totalQuantity, 3);
  assert.equal(s.testOrder, true);
  assert.equal(summarizeOrder(v2).orderedBy, "x@example.jp", "氏名がなければメール");
  assert.equal(summarizeOrder(v1).orderedBy, "（不明）");
});

test("入力者の役割(createdBy.role): 代行入力者の注文を区別する。旧注文(役割なし)は従来どおり", () => {
  const proxy = summarizeOrder({ ...v3, createdBy: { ...v3.createdBy, role: "proxy" } });
  assert.deepEqual([proxy.isProxyEntry, proxy.enteredByRole, proxy.orderedBy], [true, "代行入力者", "ログイン太郎"]);
  assert.ok(proxy.lines.every(l => l.doctorName && l.doctorName !== "ログイン太郎"), "担当医は入力者とは別");
  const ord = summarizeOrder({ ...v3, createdBy: { ...v3.createdBy, role: "orderer" } });
  assert.deepEqual([ord.isProxyEntry, ord.enteredByRole], [false, "注文者"]);
  for (const old of [v3, v2, v1]) assert.deepEqual([summarizeOrder(old).isProxyEntry, summarizeOrder(old).enteredByRole], [false, null]);
  assert.equal(summarizeOrder({ ...v3, createdBy: { role: "viewer" } }).enteredByRole, null);
});

test("詳細: 明細ごとのメーカー・モデル・度数・枚数・手術日・担当医・発注先。トーリックは型番を表示、発注先なしは null", () => {
  const [a, b] = summarizeOrder(v3).lines;
  assert.deepEqual([a.maker, a.model, a.power, a.quantity, a.surgeryDate, a.doctorName, a.dealerName], ["J&J", "DIB00V", "+20.0D", 1, "2026-11-10", "山田", "A商会"]);
  assert.deepEqual([b.model, b.isToric, b.power, b.quantity, b.surgeryDate, b.doctorName, b.dealerName], ["DIW300", true, "+18.5D", 2, "2026-11-12", "佐藤", null]);
});

test("旧形式(orderer を持つ過去データ)も同じ形で読める。担当医は orderer、発注先は未設定", () => {
  const l2 = summarizeOrder(v2).lines[0];
  assert.deepEqual([l2.doctorName, l2.dealerName, l2.quantity], ["旧注文者", null, 2]);
  const s1 = summarizeOrder(v1);
  assert.deepEqual([s1.lineCount, s1.totalQuantity, s1.lines[0].doctorName, s1.lines[0].surgeryDate], [1, 1, "最古注文者", "2026-09-01"]);
  assert.equal(describeLine({ item: item() }).doctorName, "（記録なし）");
  assert.deepEqual(summarizeOrder({ id: "z" }).lines, [], "明細が読めない注文でも落ちない");
});

test("サーバー(functions)の orderLinesOf と同じ結果を返す(新旧の読み取りを共通化)", () => {
  for (const o of [v3, v2, v1, { id: "z" }]) assert.deepEqual(orderLinesOf(o), serverOrderLinesOf(o));
});

test("新しい順。作成日時が読めない注文は末尾。Timestamp / seconds / ISO を読める", () => {
  const list = [v1, { id: "n", createdAt: null }, v3, v2].map(summarizeOrder);
  assert.deepEqual(sortOrdersNewestFirst(list).map(o => o.id), ["a", "b", "c", "n"]);
  assert.equal(toMillis({ seconds: 10, nanoseconds: 5e6 }), 10005);
  assert.equal(toMillis("2026-10-25T00:00:00Z"), Date.parse("2026-10-25T00:00:00Z"));
  assert.equal(formatDateTimeJst(null), "—");
  assert.equal(formatDateTimeJst(ts("2026-12-31T15:00:00Z")), "2027/01/01 00:00");
});

test("詳細: 保存済みの備考と注文状態。メール送信結果(将来の notifications)は記録があるときだけ読む", async () => {
  const { ORDER_STATUS } = await import("../functions/src/orders.js");
  const { orderStatusLabel } = await import("../src/domain/order-history.js");
  const o = summarizeOrder({ id: "x", status: "accepted", notes: "午前の手術分\n2行目", lines: [] });
  assert.deepEqual([o.status, o.statusLabel, o.notes, o.notifications], ["accepted", "受付済み（ディーラー未通知）", "午前の手術分\n2行目", []]);
  assert.equal(summarizeOrder({ id: "t", status: "notified", testOrder: true, lines: [] }).statusLabel, "テスト注文（ディーラー未通知）", "テスト注文はディーラーへ通知したように見せない");
  const old = summarizeOrder({ id: "y", item: { quantity: 1 } });
  assert.deepEqual([old.statusLabel, old.notes], ["（記録なし）", ""]);
  for (const s of Object.values(ORDER_STATUS).filter(s => s !== "draft")) assert.ok(!orderStatusLabel(s).includes(s), `サーバーの状態 ${s} に表示名がある`);
  const n = summarizeOrder({ id: "z", status: "notification_failed", notifications: [
    { dealerId: "d1", dealerName: "A商会", status: "sent", at: "2026-10-25T05:30:00Z" },
    { dealerId: "d2", dealerName: "B医療", status: "failed", error: "宛先エラー" }] });
  assert.deepEqual(n.notifications, [
    { kind: "dealer", dealerName: "A商会", statusLabel: "送信済み", atLabel: "2026/10/25 14:30", error: "" },
    { kind: "dealer", dealerName: "B医療", statusLabel: "送信失敗（届いていません）", atLabel: "", error: "宛先エラー" }]);
});

test("メール送信の状態: 配信サービスの受付と、実際の配信結果を区別して表示する。送信対象外は理由を出す。注文控えも表示する", async () => {
  const { MAIL_STATUS } = await import("../functions/src/order-mail-outbox.js");
  const { describeNotifications } = await import("../src/domain/order-history.js");
  const ts = (iso) => ({ toMillis: () => Date.parse(iso) });
  const ns = describeNotifications({ notifications: [
    { kind: "dealer", dealerName: "A商会", status: "accepted", statusAt: ts("2026-10-25T05:30:00Z") },
    { kind: "dealer", dealerName: "B医療", status: "accepted", delivery: "delivered", deliveryAt: "2026-10-25T05:31:00Z" },
    { kind: "dealer", dealerName: "C商会", status: "accepted", delivery: "bounced" },
    { kind: "dealer", dealerName: "D商会", status: "not_sent", reason: "no-order-email" },
    { kind: "dealer", dealerName: "（発注先未設定）", status: "not_sent", reason: "dealer-unset" },
    { kind: "dealer", dealerName: "E商会", status: "held" },
    { kind: "copy", dealerName: "注文控え", status: "waiting" },
    { kind: "dealer", dealerName: "F商会", status: "accepted", sentTo: "test" },
    { kind: "dealer", dealerName: "G商会", status: "accepted", sentTo: "test", delivery: "delivered" }] });
  assert.deepEqual(ns.map(n => n.statusLabel), [
    "送信受付済み（配信の確認待ち）", "配信済み", "配信失敗（宛先エラー）", "送信対象外（発注用メール未登録）", "送信対象外（発注先未設定）",
    "未送信（メール送信は停止中）", "送信待ち（ディーラーへの送信の後）",
    "テスト用の宛先に送信（ディーラーには未送信）", "テスト用の宛先に送信・配信済み（ディーラーには未送信）"]);
  assert.deepEqual(ns.slice(0, 2).map(n => n.atLabel), ["2026/10/25 14:30", "2026/10/25 14:31"]);
  assert.equal(ns[6].kind, "copy");
  for (const st of Object.values(MAIL_STATUS)) {
    const label = describeNotifications({ notifications: [{ status: st }] })[0].statusLabel;
    assert.notEqual(label, st, `サーバーの状態 ${st} に表示名がある`);
  }
});

test("論理削除: deleted の注文は通常の一覧に出さない(注文データはそのまま読める)", () => {
  const list = [v3, { ...v2, deleted: true, deletedBy: { uid: "adminA", role: "admin" } }, v1].map(summarizeHistoryOrder);
  assert.deepEqual(list.map(o => o.deleted), [false, true, false]);
  assert.deepEqual(visibleOrders(list).map(o => o.id), ["a", "c"]);
  assert.deepEqual(visibleOrders(null), []);
});

test("詳細の表示用のまとめ: 担当医・発注先のキー(ID、なければ名称)。発注先ごとに最初に登場した順(未設定は1つ)", () => {
  const [a, b] = summarizeHistoryOrder(v3).lines;
  assert.deepEqual([a.doctorKey, a.dealerKey, b.doctorKey, b.dealerKey], ["o1", "d1", "o2", ""]);
  assert.deepEqual([a.doctorName, a.model, b.model], ["山田", "DIB00V", "DIW300"], "ほかの項目は summarizeOrder と同じ");
  assert.equal(summarizeHistoryOrder(v2).lines[0].doctorKey, "o9", "旧形式は注文全体の orderer");
  assert.equal(summarizeHistoryOrder({ id: "z", item: item() }).lines[0].doctorKey, "", "担当医の記録なし");
  assert.equal("deleted" in summarizeOrder(v3), false, "注文メールと共通の summarizeOrder は変えない");
  const lines = [{ lineNo: 1, dealerKey: "d2", dealerName: "B商会" }, { lineNo: 2, dealerKey: "", dealerName: null }, { lineNo: 3, dealerKey: "d2", dealerName: "B商会" }, { lineNo: 4, dealerKey: "", dealerName: "旧名称" }];
  assert.deepEqual(groupHistoryLinesByDealer(lines).map(g => [g.dealerName, g.lines.map(l => l.lineNo)]), [["B商会", [1, 3]], [null, [2]], ["旧名称", [4]]]);
  assert.equal(groupHistoryLinesByDealer(summarizeHistoryOrder(v2).lines).length, 1);
});
