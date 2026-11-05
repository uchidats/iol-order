// 施設設定「IOLシール写真」の表示用の処理と、呼び出しの部品
import test from "node:test";
import assert from "node:assert/strict";
import {
  STICKER_SETTINGS_ENABLED, GENERATED_CODE_DIGITS, accessCodeError, accessCodeStatus, generateAccessCode, shareableDealers, qrImageUrl, verifyLockNotice, canManageStickerSettings, showSettingsMenu
} from "../src/domain/sticker-settings.js";
import { isAccessCode } from "../src/domain/sticker-photo.js";
import { createStickerSettingsApi } from "../src/data/sticker-settings-api.js";
import { createDealerPortalApi } from "../src/data/dealer-portal-api.js";
import { createStickerPhotoApi } from "../src/data/sticker-photo-api.js";

test("公開の前は項目を出さない", () => assert.equal(STICKER_SETTINGS_ENABLED, false));

test("コードの形式: 半角数字6〜12桁だけ", () => {
  for (const ok of ["123456", "123456789012"]) assert.equal(accessCodeError(ok), "");
  for (const ng of ["", "12345", "1234567890123", "12345a", "１２３４５６", " 123456"]) assert.match(accessCodeError(ng), /半角数字6〜12桁/);
});

test("自動で作るコード: 形式に合い、毎回違い、偏りの出る値は捨てる", () => {
  const code = generateAccessCode();
  assert.equal(code.length, GENERATED_CODE_DIGITS);
  assert.equal(isAccessCode(code), true);
  assert.notEqual(generateAccessCode(), code);
  // 0xFFFFFFFF は 10 の倍数に収まらない範囲の値なので使わない
  let calls = 0;
  const fill = (a) => { calls += 1; a.fill(calls === 1 ? 0xffffffff : 7); return a; };
  assert.equal(generateAccessCode(fill, 6), "777777");
  assert.equal(calls, 2);
});

test("コードの状態: 未設定・設定済み(変更日は日本時間)。コードそのものは扱わない", () => {
  assert.equal(accessCodeStatus({ accessCodeSet: false, accessCodeUpdatedAt: null }), "未設定");
  assert.equal(accessCodeStatus({ accessCodeSet: true, accessCodeUpdatedAt: "2026-11-02T15:30:00.000Z" }), "設定済み(2026/11/03 変更)");
  assert.equal(accessCodeStatus({ accessCodeSet: true, accessCodeUpdatedAt: null }), "設定済み");
});

test("共有できる発注先は関連付けのあるものだけ", () => {
  assert.deepEqual(shareableDealers([{ localDealerId: "a", linked: true }, { localDealerId: "b", linked: false }]).map(d => d.localDealerId), ["a"]);
  assert.deepEqual(shareableDealers(undefined), []);
});

test("QR は画像の URL にする(文字列として HTML に入れない)", () => {
  assert.equal(qrImageUrl('<svg a="1"></svg>'), "data:image/svg+xml;charset=utf-8,%3Csvg%20a%3D%221%22%3E%3C%2Fsvg%3E");
});

test("呼び出し: すべて stickerPhotoApi へ、必要な項目だけを送る", async () => {
  const sent = [];
  const api = createStickerSettingsApi(async (p) => { sent.push(p); return {}; });
  await api.getSettings("fA");
  await api.setAccessCode("fA", "123456");
  await api.getEntryQr("fA");
  await api.rotateEntryQr("fA");
  await api.setDealerShare("fA", "dA", true);
  assert.deepEqual(sent, [
    { action: "getSettings", facilityId: "fA" }, { action: "setAccessCode", facilityId: "fA", code: "123456" }, { action: "getEntryQr", facilityId: "fA" },
    { action: "rotateEntryQr", facilityId: "fA" }, { action: "setDealerShare", facilityId: "fA", localDealerId: "dA", shared: true }
  ]);
});

test("呼び出しの関数: 写真の設定は stickerPhotoApi で、受注閲覧の関数・API を使わない", async () => {
  const names = [];
  const httpsCallable = (_, name) => async () => { names.push(name); return { data: {} }; };
  const api = createStickerPhotoApi({ functions: {}, httpsCallable, imageUrl: "https://example.invalid/img", getIdToken: async () => "t" });
  await createStickerSettingsApi(api.settingsCall).setDealerShare("fA", "dA", true);
  assert.deepEqual(names, ["stickerPhotoApi"]);
  // 受注閲覧の API は写真の設定の呼び出しを持たない(互いに独立)
  assert.equal("stickerPhotoCall" in createDealerPortalApi({ functions: {}, httpsCallable }), false);
});

test("コードの確認の停止中だけ案内を出し、復旧の方法(コードの変更)を書く", () => {
  assert.equal(verifyLockNotice({ verifyBlockedUntil: null }), "");
  assert.equal(verifyLockNotice({}), "");
  assert.equal(verifyLockNotice(), "");
  const text = verifyLockNotice({ verifyBlockedUntil: "2026-11-06T03:05:00.000Z" });
  assert.match(text, /11\/6 12:05 まで/);
  assert.match(text, /アクセスコードを変更すると、すぐに再開できます/);
});

test("役割: 変更の操作は管理者・副管理者だけ。メニュー「施設設定」は、注文者・代理入力者には欄を使える施設だけに出す", () => {
  assert.deepEqual(["admin", "subadmin", "orderer", "proxy", "dealer", undefined].map(canManageStickerSettings), [true, true, false, false, false, false]);
  // 管理者・副管理者は従来どおり常に出す(公開の設定・施設の対象に関係しない)
  for (const role of ["admin", "subadmin"]) {
    assert.equal(showSettingsMenu({ role, stickerAvailable: false, enabled: false }), true, role);
    assert.equal(showSettingsMenu({ role }), true, role);
  }
  for (const role of ["orderer", "proxy"]) {
    assert.equal(showSettingsMenu({ role, stickerAvailable: true, enabled: true }), true, role);
    assert.equal(showSettingsMenu({ role, stickerAvailable: false, enabled: true }), false, "対象外の施設");
    assert.equal(showSettingsMenu({ role, stickerAvailable: true, enabled: false }), false, "公開の前");
    assert.equal(showSettingsMenu({ role, stickerAvailable: "true", enabled: true }), false, "true そのものだけ");
    assert.equal(showSettingsMenu({ role, stickerAvailable: true }), STICKER_SETTINGS_ENABLED, "既定は公開の設定");
  }
  for (const role of ["dealer", "", null, undefined]) assert.equal(showSettingsMenu({ role, stickerAvailable: true, enabled: true }), false, String(role));
});

test("コードの確認の停止の案内: 操作できない人には、変更の方法ではなく管理者へ知らせる案内にする", () => {
  const lock = { verifyBlockedUntil: "2026-11-06T03:05:00.000Z" };
  const viewer = verifyLockNotice(lock, { canManage: false });
  assert.match(viewer, /11\/6 12:05 まで/);
  assert.match(viewer, /管理者・副管理者にお知らせください/);
  assert.ok(!viewer.includes("変更すると") && !viewer.includes("作り直して"));
  assert.match(verifyLockNotice(lock), /アクセスコードを変更すると、すぐに再開できます/);
  assert.equal(verifyLockNotice({}, { canManage: false }), "");
});
