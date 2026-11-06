// IOL シール写真(R09)の閲覧の表示用データと、呼び出しの部品
import test from "node:test";
import assert from "node:assert/strict";
import {
  STICKER_VIEWER_ENABLED, createStickerAvailability, defaultPeriod, dayLabel, timeLabel, surgeryLabel, sessionLabel, groupForView, jstDate
} from "../src/domain/sticker-photo-view.js";
import { createStickerPhotoApi, stickerImageUrl } from "../src/data/sticker-photo-api.js";

const NOW = Date.parse("2026-11-05T01:00:00Z");   // 日本時間 11/5 10:00
const photo = (sessionId, seq, takenAt, over = {}) => ({ photoId: `${sessionId}${seq}`, sessionId, seq, takenAt, lastSurgeryDate: null, facilityId: "fA", facilityName: "A眼科", ...over });

test("閲覧のメニューの公開の設定は true(試験運用。出す施設・会社はサーバーの答えで決まる)", () => assert.equal(STICKER_VIEWER_ENABLED, true));

test("既定の期間は今日を含む直近4週(日本時間)", () => {
  assert.deepEqual(defaultPeriod(NOW), { from: "2026-10-09", to: "2026-11-05" });
  assert.equal(defaultPeriod(Date.parse("2026-11-04T15:30:00Z")).to, "2026-11-05", "UTC では前日でも日本時間の日付");
});

test("見出しの文言: 日付・時刻は日本時間。今年以外は年を付ける", () => {
  assert.equal(dayLabel("2026-11-04", NOW), "11/4(水)");
  assert.equal(dayLabel("2025-12-31", NOW), "2025/12/31(水)");
  assert.equal(timeLabel("2026-11-04T01:32:00Z"), "10:32");
  assert.equal(surgeryLabel("2026-11-04", NOW), "11/4の手術分まで");
  assert.equal(surgeryLabel("2025-11-04", NOW), "2025/11/4の手術分まで");
  assert.equal(surgeryLabel(null, NOW), "");
});

test("セッションの見出し: 時刻の範囲・枚数・最終手術日(入力があるときだけ)", () => {
  assert.equal(sessionLabel({ from: "2026-11-04T01:32:00Z", to: "2026-11-04T01:35:00Z", count: 3, lastSurgeryDate: "2026-11-04" }, NOW), "10:32〜10:35 3枚 ・ 11/4の手術分まで");
  assert.equal(sessionLabel({ from: "2026-11-04T05:05:00Z", to: "2026-11-04T05:05:30Z", count: 1, lastSurgeryDate: null }, NOW), "14:05 1枚");
});

test("一覧のまとまり: 送信日 → 医療機関 → セッション。新しい順で、セッションの中は送信順", () => {
  const days = groupForView([
    photo("s1", 1, "2026-11-03T01:00:00Z"),
    photo("s2", 2, "2026-11-04T05:01:00Z"),
    photo("s2", 1, "2026-11-04T05:00:00Z"),
    photo("s3", 1, "2026-11-04T01:00:00Z"),
    photo("s4", 1, "2026-11-04T02:00:00Z", { facilityId: "fB", facilityName: "B眼科" })
  ]);
  assert.deepEqual(days.map(d => d.date), ["2026-11-04", "2026-11-03"]);
  assert.deepEqual(days[0].facilities.map(f => [f.facilityName, f.sessions.map(s => s.sessionId)]), [["A眼科", ["s2", "s3"]], ["B眼科", ["s4"]]]);
  assert.deepEqual(days[0].facilities[0].sessions[0].photos.map(p => p.seq), [1, 2]);
  assert.deepEqual(groupForView([]), []);
});

test("一覧のまとまり: 日付は日本時間で分ける", () => {
  assert.equal(groupForView([photo("s1", 1, "2026-11-03T15:30:00Z")])[0].date, "2026-11-04");
  assert.equal(jstDate(Date.parse("2026-11-03T15:30:00Z")), "2026-11-04");
});

// ---------- 呼び出し ----------
const fakeApi = (over = {}) => {
  const calls = [], fetches = [];
  const api = createStickerPhotoApi({
    functions: {}, imageUrl: "https://example.test/image", getIdToken: async () => "tok",
    httpsCallable: (_, name) => async (payload) => { calls.push([name, payload]); return { data: { facilities: [{ facilityId: "fA", name: "A" }], photos: [], nextCursor: null } }; },
    fetchImpl: async (url, init) => { fetches.push([url, init]); return over.response || { status: 200, ok: true, blob: async () => "BLOB" }; },
    ...over.deps
  });
  return { api, calls, fetches };
};

test("画像の URL は Functions の第2世代の形", () => {
  assert.equal(stickerImageUrl("medconf-iol-dev"), "https://asia-northeast1-medconf-iol-dev.cloudfunctions.net/stickerPhotoImage");
});

test("医療機関用: 一覧は施設と条件だけを送り、管理者だけ削除の処理を持つ。画像は ID トークンをヘッダーで送り、キャッシュしない", async () => {
  const { api, calls, fetches } = fakeApi();
  const src = api.facilitySource({ facilityId: "fA", facilityName: "A眼科", canDelete: true });
  assert.deepEqual(await src.loadFacilities(), [{ facilityId: "fA", name: "A眼科" }]);
  await src.listPage("fA", { from: "2026-11-01", to: "2026-11-05", cursor: undefined });
  assert.deepEqual(calls[0], ["stickerPhotoApi", { action: "list", facilityId: "fA", from: "2026-11-01", to: "2026-11-05" }]);
  await src.deletePhoto("fA", "p1");
  assert.deepEqual(calls[1][1], { action: "delete", facilityId: "fA", photoId: "p1" });
  assert.equal(await src.readImage({ facilityId: "fA", photoId: "p1", size: "thumb" }), "BLOB");
  assert.equal(fetches[0][0], "https://example.test/image?facility=fA&photo=p1&size=thumb");
  assert.deepEqual(fetches[0][1], { method: "GET", headers: { Authorization: "Bearer tok" }, cache: "no-store" });
  assert.equal(api.facilitySource({ facilityId: "fA", facilityName: "A", canDelete: false }).deletePhoto, null);
});

test("ディーラー用: 一覧・画像に会社と確認済みの端末の値を付け、削除の処理を持たない", async () => {
  const { api, calls, fetches } = fakeApi({ deps: { device: { get: () => "dev" } } });
  const src = api.dealerSource({ companyId: "cX" });
  assert.equal(src.deletePhoto, null);
  assert.deepEqual(await src.loadFacilities(), [{ facilityId: "fA", name: "A" }]);
  assert.deepEqual(calls[0][1], { action: "dealerList", companyId: "cX", deviceToken: "dev" });
  await src.listPage("fA", { cursor: "c1" });
  assert.deepEqual(calls[1][1], { action: "dealerList", companyId: "cX", deviceToken: "dev", facilityId: "fA", cursor: "c1" });
  await src.readImage({ facilityId: "fA", photoId: "p1", size: "full" });
  assert.deepEqual(fetches[0][1].headers, { Authorization: "Bearer tok", "X-Dealer-Company": "cX", "X-Dealer-Device": "dev" });
});

test("画像: 見えないものは null、それ以外の失敗は例外", async () => {
  const hidden = fakeApi({ response: { status: 404, ok: false } }).api.facilitySource({ facilityId: "fA", facilityName: "A" });
  assert.equal(await hidden.readImage({ facilityId: "fA", photoId: "p", size: "full" }), null);
  const broken = fakeApi({ response: { status: 503, ok: false } }).api.facilitySource({ facilityId: "fA", facilityName: "A" });
  await assert.rejects(broken.readImage({ facilityId: "fA", photoId: "p", size: "full" }));
});

// ---------- メニューを出す対象(サーバーの許可の設定に基づく) ----------
const tick = () => new Promise(r => setTimeout(r, 0));

test("メニューの表示: 公開の設定が false の間は、問い合わせもせず出さない", async () => {
  const asked = [];
  const a = createStickerAvailability({ active: false, check: async (t) => { asked.push(t); return true; } });
  assert.equal(a.of("fA"), false);
  await tick();
  assert.deepEqual([a.of("fA"), asked], [false, []]);
});

test("メニューの表示: サーバーが使えると答えた施設だけに出す。答えが届くまでは出さず、施設が変わると確かめ直す", async () => {
  const asked = [], changes = [];
  const a = createStickerAvailability({ active: true, check: async (t) => { asked.push(t); return t === "tachikawa"; }, onChange: () => changes.push(1) });
  assert.equal(a.of("tachikawa"), false, "答えが届く前");
  await tick();
  assert.deepEqual([a.of("tachikawa"), changes.length, asked], [true, 1, ["tachikawa"]], "同じ施設は問い合わせ直さない");
  // 別の施設へ切り替え → すぐに消し、確かめ直す
  assert.equal(a.of("other"), false);
  await tick();
  assert.deepEqual([a.of("other"), changes.length, asked], [false, 1, ["tachikawa", "other"]]);
  // 元の施設へ戻る → もう一度確かめる(前の答えを使い回さない)
  assert.equal(a.of("tachikawa"), false);
  await tick();
  assert.deepEqual([a.of("tachikawa"), asked.length], [true, 3]);
  // 対象なし(ログアウト・施設に入る前)
  assert.equal(a.of(null), false);
  assert.equal(a.of("tachikawa"), false, "入り直したら確かめ直す");
});

test("メニューの表示: 切り替えの前の施設への答えが遅れて届いても、今の施設には出さない。確かめられないときも出さない", async () => {
  const pending = {};
  const a = createStickerAvailability({ active: true, check: (t) => new Promise((resolve, reject) => { pending[t] = { resolve, reject }; }) });
  a.of("tachikawa");
  await tick();
  a.of("other");
  await tick();
  pending.tachikawa.resolve(true);   // 古い施設への答え
  await tick();
  assert.equal(a.of("other"), false);
  pending.other.reject(new Error("network"));
  await tick();
  assert.equal(a.of("other"), false);
  // true 以外の答えは出さない
  const b = createStickerAvailability({ active: true, check: async () => "yes" });
  b.of("x");
  await tick();
  assert.equal(b.of("x"), false);
  // reset の後は確かめ直す
  const asked = [];
  const c = createStickerAvailability({ active: true, check: async (t) => { asked.push(t); return true; } });
  c.of("x"); await tick();
  c.reset();
  assert.equal(c.of("x"), false);
  await tick();
  assert.deepEqual([c.of("x"), asked.length], [true, 2]);
});

test("呼び出し: 利用できるかは status、ディーラーは dealerList の施設の有無。失敗は「出さない」", async () => {
  const calls = [];
  let answer = { enabled: true };
  const api = createStickerPhotoApi({
    functions: {}, httpsCallable: (_, name) => async (p) => { calls.push([name, p]); if (answer instanceof Error) throw answer; return { data: answer }; },
    imageUrl: "https://example.invalid/i", getIdToken: async () => "t", device: { get: () => "dev-1" }
  });
  assert.equal(await api.facilityEnabled("fA"), true);
  assert.deepEqual(calls.pop(), ["stickerPhotoApi", { action: "status", facilityId: "fA" }]);
  answer = { enabled: "true" };
  assert.equal(await api.facilityEnabled("fA"), false, "true そのものだけ");
  answer = { facilities: [{ facilityId: "fA", name: "A" }], photos: [] };
  assert.equal(await api.dealerHasShares({ companyId: "cX" }), true);
  assert.deepEqual(calls.pop(), ["stickerPhotoApi", { action: "dealerList", companyId: "cX", deviceToken: "dev-1" }]);
  answer = { facilities: [] };
  assert.equal(await api.dealerHasShares({ companyId: "cX" }), false);
  answer = new Error("failed-precondition");
  assert.deepEqual([await api.facilityEnabled("fA"), await api.dealerHasShares({ companyId: "cX" })], [false, false]);
});

test("一覧の並び: 送信日は新しい順。その中は最終手術日の新しい順で、同じ手術日は撮影の新しい順。未入力は下", () => {
  const p = (sessionId, takenAt, lastSurgeryDate) => ({ ...photo(sessionId, 1, takenAt), lastSurgeryDate });
  const days = groupForView([
    p("a", "2026-11-06T01:00:00Z", "2026-11-02"),   // 11/6 送信・11/2 の手術分
    p("b", "2026-11-05T01:00:00Z", "2026-11-05"),   // 11/5 送信・11/5 の手術分
    p("c", "2026-11-05T03:00:00Z", "2026-11-05"),   // 同じ手術日で、撮影が新しい
    p("d", "2026-11-05T05:00:00Z", "2026-11-03"),
    p("e", "2026-11-06T05:00:00Z", null),           // 未入力
    p("f", "2026-11-04T01:00:00Z", null)
  ]);
  const flat = days.map(d => [d.date, d.facilities.flatMap(f => f.sessions.map(s => s.sessionId))]);
  assert.deepEqual(flat, [["2026-11-06", ["a", "e"]], ["2026-11-05", ["c", "b", "d"]], ["2026-11-04", ["f"]]]);
});
