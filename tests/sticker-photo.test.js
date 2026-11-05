// IOL シール写真(R09)の画面側の純粋な処理と、画面とサーバーの定数の一致
import test from "node:test";
import assert from "node:assert/strict";
import * as client from "../src/domain/sticker-photo.js";
import * as server from "../functions/src/sticker-photo.js";

const TOKEN = "abcdefghijklmnopqrstuv";
const NOW = Date.UTC(2026, 10, 4, 3, 0, 0);   // 2026-11-04 12:00 JST

test("上限・コードの桁数・撮影ページの URL は画面とサーバーで同じ値", () => {
  assert.deepEqual({ ...client.STICKER_LIMITS }, { ...server.STICKER_LIMITS });
  assert.deepEqual({ ...client.ACCESS_CODE_DIGITS }, { ...server.ACCESS_CODE_DIGITS });
  assert.equal(client.SHEET_NOTE_MAX_LENGTH, server.SHEET_NOTE_MAX_LENGTH);
  assert.equal(client.normalizeSheetNote(" a\r\nb\r\n \n"), server.normalizeSheetNote(" a\r\nb\r\n \n"));
  assert.equal(client.STICKER_ENTRY_URL, server.STICKER_ENTRY_URL);
  assert.equal(client.STICKER_LIMITS.imageBytes, 15 * 1024 * 1024);
});

test("形式の判定は画面とサーバーで同じ結果", () => {
  const values = ["123456", "123456789012", "12345", "1234567890123", "12345a", "１２３４５６", 123456, null, TOKEN, "3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b", "3F2B8C1E-4A5D-4E6F-8A9B-0C1D2E3F4A5B", "3f2b8c1e-4a5d-1e6f-8a9b-0c1d2e3f4a5b"];
  for (const value of values) {
    assert.equal(client.isAccessCode(value), server.isAccessCode(value));
    assert.equal(client.isEntryToken(value), server.isEntryToken(value));
    assert.equal(client.isUploadId(value), server.isUploadId(value));
  }
  for (const value of ["2026-11-04", "2026-11-05", "2026-02-30", "2026/11/04", "", null]) {
    assert.equal(client.isLastSurgeryDate(value, NOW), server.isLastSurgeryDate(value, NOW));
  }
  assert.equal(client.buildEntryUrl(TOKEN), server.buildEntryUrl(TOKEN));
});

test("アクセスコードは半角数字6〜12桁", () => {
  assert.equal(client.isAccessCode("123456"), true);
  assert.equal(client.isAccessCode("123456789012"), true);
  assert.equal(client.isAccessCode("12345"), false);
  assert.equal(client.isAccessCode("1234567890123"), false);
  assert.equal(client.isAccessCode("１２３４５６"), false);
  assert.equal(client.isAccessCode(123456), false);
});

test("QR の URL は撮影ページと入口トークンだけで、読み戻せる", () => {
  const url = client.buildEntryUrl(TOKEN);
  assert.equal(url, `https://iol.medconf.jp/sticker.html#f=${TOKEN}`);
  assert.equal(client.parseEntryToken(new URL(url).hash), TOKEN);
  assert.throws(() => client.buildEntryUrl("short"));
  assert.equal(client.parseEntryToken(""), null);
  assert.equal(client.parseEntryToken("#f=short"), null);
  assert.equal(client.parseEntryToken(`#x=${TOKEN}`), null);
  assert.equal(client.parseEntryToken(null), null);
});

test("最終手術日: 未来だけ不可・過去は可・実在しない日は不可(日本時間で判定)", () => {
  assert.equal(client.isLastSurgeryDate("2026-11-04", NOW), true);
  assert.equal(client.isLastSurgeryDate("2020-01-01", NOW), true);
  assert.equal(client.isLastSurgeryDate("2026-11-05", NOW), false);
  assert.equal(client.isLastSurgeryDate("2026-02-30", NOW), false);
  assert.equal(client.isLastSurgeryDate("2026-1-4", NOW), false);
  const justAfterMidnightJst = Date.UTC(2026, 10, 4, 15, 0, 0);   // 2026-11-05 00:00 JST
  assert.equal(client.isLastSurgeryDate("2026-11-05", justAfterMidnightJst), true);
});

test("解像度の注意は長辺で判定する(向きによらない)", () => {
  assert.equal(client.isLowResolution(3060, 4080), false);
  assert.equal(client.isLowResolution(4080, 3060), false);
  assert.equal(client.isLowResolution(1920, 2999), true);
});

test("写真を撮影セッションの枠にまとめる: 枠は現れた順、枠の中は seq 順、時刻の範囲と枚数", () => {
  const photos = [
    { sessionId: "b", seq: 1, takenAt: "2026-11-04T05:05:00.000Z", lastSurgeryDate: null },
    { sessionId: "a", seq: 3, takenAt: "2026-11-04T01:35:00.000Z", lastSurgeryDate: "2026-11-04" },
    { sessionId: "a", seq: 2, takenAt: "2026-11-04T01:33:00.000Z", lastSurgeryDate: "2026-11-04" },
    { sessionId: "a", seq: 1, takenAt: "2026-11-04T01:32:00.000Z", lastSurgeryDate: "2026-11-04" }
  ];
  const groups = client.groupPhotosBySession(photos);
  assert.deepEqual(groups.map(g => g.sessionId), ["b", "a"]);
  assert.deepEqual(groups[1].photos.map(p => p.seq), [1, 2, 3]);
  assert.equal(groups[1].count, 3);
  assert.equal(groups[1].from, "2026-11-04T01:32:00.000Z");
  assert.equal(groups[1].to, "2026-11-04T01:35:00.000Z");
  assert.equal(groups[1].lastSurgeryDate, "2026-11-04");
  assert.equal(groups[0].lastSurgeryDate, null);
  assert.deepEqual(client.groupPhotosBySession([]), []);
});
