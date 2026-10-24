/**
 * 画面・データへのアクセス可否の判定（純粋関数）
 *
 * 認証済みであることと、施設へ所属していることは別。
 * 有効な所属（status === "active"）が確認できない限り、注文・施設情報へはアクセスさせない。
 */
export const ACCESS = Object.freeze({
  LEGACY: "legacy",             // Firebase未設定: 従来の静的モード
  LOADING: "loading",           // 認証状態 / 所属を確認中
  SIGNED_OUT: "signed-out",     // 未ログイン
  NO_MEMBERSHIP: "no-membership", // ログイン済みだが有効な所属なし
  GRANTED: "granted"            // 所属確認済み
});

/**
 * @param {{configured:boolean, authReady:boolean, user:{uid:string}|null,
 *          membershipsLoaded:boolean, memberships:Array<{facilityId:string, role:string, status:string}>}} s
 */
export function decideAccess(s) {
  if (!s.configured) return { state: ACCESS.LEGACY };
  if (!s.authReady) return { state: ACCESS.LOADING };
  if (!s.user) return { state: ACCESS.SIGNED_OUT };
  if (!s.membershipsLoaded) return { state: ACCESS.LOADING };

  const active = (s.memberships || []).filter(
    m => m && m.status === "active" && (m.role === "admin" || m.role === "orderer") && m.facilityId
  );
  if (active.length === 0) return { state: ACCESS.NO_MEMBERSHIP };

  // 複数施設に所属する場合は facilityId の昇順で先頭（施設切替UIは今後）
  const sorted = [...active].sort((a, b) => a.facilityId.localeCompare(b.facilityId));
  return { state: ACCESS.GRANTED, facilityId: sorted[0].facilityId, role: sorted[0].role, memberships: sorted };
}
