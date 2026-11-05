// IOL シール写真(R09)の閲覧の表示用データと、呼び出しの部品
import test from "node:test";
import assert from "node:assert/strict";
import {
  STICKER_VIEWER_ENABLED, defaultPeriod, dayLabel, timeLabel, surgeryLabel, sessionLabel, groupForView, jstDate
} from "../src/domain/sticker-photo-view.js";
import { createStickerPhotoApi, stickerImageUrl } from "../src/data/sticker-photo-api.js";

const NOW = Date.parse("2026-11-05T01:00:00Z");   // 日本時間 11/5 10:00
const photo = (sessionId, seq, takenAt, over = {}) => ({ photoId: `${sessionId}${seq}`, sessionId, seq, takenAt, lastSurgeryDate: null, facilityId: "fA", facilityName: "A眼科", ...over });

test("公開の前は閲覧のメニューを出さない", () => assert.equal(STICKER_VIEWER_ENABLED, false));

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
