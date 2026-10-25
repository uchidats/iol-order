/**
 * 画面・データへのアクセス可否の判定（純粋関数）
 *
 * 認証済みであることと、施設へ所属していることは別。
 * 所属が確認できない限り、注文・施設情報へはアクセスさせない。
 * 端末に記憶された施設ID（selectedFacilityId）は「選択の候補」に過ぎず、
 * Firestoreで検証済みの有効な所属に含まれる場合にのみ採用する。
 * 位置情報（GPS）は施設の「選択」を補助するだけで、アクセス権限の根拠にはしない。
 */
import { MEMBER_ROLES } from "./member-admin.js";

export const ACCESS = Object.freeze({
  LEGACY: "legacy",               // Firebase未設定: 従来の静的モード
  LOADING: "loading",             // 認証状態 / 所属を確認中
  SIGNED_OUT: "signed-out",       // 未ログイン
  NO_MEMBERSHIP: "no-membership", // ログイン済みだが有効な所属なし
  SELECT_FACILITY: "select-facility", // 複数所属: 施設の選択が必要
  GRANTED: "granted"              // 所属確認済み・施設確定
});

/** 所属(role が admin / subadmin / orderer / proxy のもの)を facilityId 昇順で返す。所属に有効/無効の状態はない(削除された所属は存在しない) */
export function validMemberships(memberships) {
  return (memberships || [])
    .filter(m => m && MEMBER_ROLES.includes(m.role) && m.facilityId)
    .sort((a, b) => a.facilityId.localeCompare(b.facilityId));
}

/**
 * @param {{configured:boolean, authReady:boolean, user:{uid:string}|null,
 *          membershipsLoaded:boolean, memberships:Array<{facilityId:string, role:string}>,
 *          selectedFacilityId?:string|null}} s
 */
export function decideAccess(s) {
  if (!s.configured) return { state: ACCESS.LEGACY };
  if (!s.authReady) return { state: ACCESS.LOADING };
  if (!s.user) return { state: ACCESS.SIGNED_OUT };
  if (!s.membershipsLoaded) return { state: ACCESS.LOADING };

  const active = validMemberships(s.memberships);
  if (active.length === 0) return { state: ACCESS.NO_MEMBERSHIP };

  // 所属が1つなら自動選択
  if (active.length === 1) {
    return { state: ACCESS.GRANTED, facilityId: active[0].facilityId, role: active[0].role, memberships: active };
  }

  // 複数所属: 検証済みの所属に含まれる選択のみ採用
  const chosen = s.selectedFacilityId && active.find(m => m.facilityId === s.selectedFacilityId);
  if (chosen) {
    return { state: ACCESS.GRANTED, facilityId: chosen.facilityId, role: chosen.role, memberships: active };
  }
  return { state: ACCESS.SELECT_FACILITY, memberships: active };
}
