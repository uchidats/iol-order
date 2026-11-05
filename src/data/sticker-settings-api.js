/**
 * 施設設定「IOLシール写真」の呼び出し(Cloud Functions の stickerPhotoApi)。権限はすべてサーバーが確認する。
 * 受注閲覧の許可(facilityDealerPortal)とは別の呼び出しで、互いに影響しない。
 * @param {(payload:object) => Promise<object>} call stickerPhotoApi の呼び出し
 */
export function createStickerSettingsApi(call) {
  return {
    getSettings: (facilityId) => call({ action: "getSettings", facilityId }),
    setAccessCode: (facilityId, code) => call({ action: "setAccessCode", facilityId, code }),
    setSheetNote: (facilityId, note) => call({ action: "setSheetNote", facilityId, note }),
    getEntryQr: (facilityId) => call({ action: "getEntryQr", facilityId }),
    rotateEntryQr: (facilityId) => call({ action: "rotateEntryQr", facilityId }),
    setDealerShare: (facilityId, localDealerId, shared) => call({ action: "setDealerShare", facilityId, localDealerId, shared })
  };
}
