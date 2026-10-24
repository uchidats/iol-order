/**
 * Firestore を使う FacilityRepository 実装と、所属（membership）の取得。
 * データ構造は docs/firestore-data-model.md を参照。
 * Firestore関数は依存として注入する（テスト容易性と遅延読み込みのため）。
 *
 * @param {object} db  Firestore インスタンス
 * @param {object} fs  firebase-firestore のモジュラー関数群
 */
export function createFirestoreRepository(db, fs) {
  const listSub = async (facilityId, name) => {
    const snap = await fs.getDocs(fs.collection(db, "facilities", facilityId, name));
    return snap.docs.map(d => ({ id: d.id, facilityId, ...d.data() }));
  };

  return {
    async getFacility(facilityId) {
      const snap = await fs.getDoc(fs.doc(db, "facilities", facilityId));
      if (!snap.exists()) throw new Error("施設情報を取得できません");
      return { id: snap.id, ...snap.data() };
    },
    listOrderers: (facilityId) => listSub(facilityId, "orderers"),
    listAdoptedIols: (facilityId) => listSub(facilityId, "adoptedIols"),
    listDealers: (facilityId) => listSub(facilityId, "facilityDealers")
  };
}

/**
 * ログインユーザー自身の所属一覧を取得する。
 * members サブコレクションへの collectionGroup クエリ（uid == 自分）。
 * ルール上、自分の所属ドキュメント以外は読めない。
 */
export async function fetchMemberships(db, fs, uid) {
  const q = fs.query(fs.collectionGroup(db, "members"), fs.where("uid", "==", uid));
  const snap = await fs.getDocs(q);
  return snap.docs.map(d => ({
    facilityId: d.ref.parent.parent.id,
    role: d.data().role,
    status: d.data().status
  }));
}
