/**
 * Firestore を使う FacilityRepository 実装と、所属（membership）の取得。
 * データ構造は docs/firestore-data-model.md を参照。
 * Firestore関数は依存として注入する（テスト容易性と遅延読み込みのため）。
 *
 * @param {object} db  Firestore インスタンス
 * @param {object} fs  firebase-firestore のモジュラー関数群
 */
// 並び順: sortOrder の昇順（未設定は末尾）→ 名前
const bySortOrder = (a, b) =>
  (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
  || String(a.name || "").localeCompare(String(b.name || ""), "ja");

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
    listOrderers: async (facilityId) => (await listSub(facilityId, "orderers")).sort(bySortOrder),
    listAdoptedIols: (facilityId) => listSub(facilityId, "adoptedIols"),
    /** 注文履歴(閲覧のみ)。新しい順に最大 limit 件。読めるのは自施設の所属メンバーと運営者(Rules) */
    async listOrders(facilityId, limit = 50) {
      const q = fs.query(fs.collection(db, "facilities", facilityId, "orders"), fs.orderBy("createdAt", "desc"), fs.limit(limit));
      const snap = await fs.getDocs(q);
      return snap.docs.map(d => ({ id: d.id, facilityId, ...d.data() }));
    },
    /** 注文1件(サーバーが保存した内容)。なければ null。完了画面と、受付結果が未確定の注文の照会に使う */
    async getOrder(facilityId, orderId) {
      const snap = await fs.getDoc(fs.doc(db, "facilities", facilityId, "orders", orderId));
      return snap.exists() ? { id: snap.id, facilityId, ...snap.data() } : null;
    },
    /**
     * 施設ごとのIOLモデルの表示順(未設定は null)。順番だけの設定なので、読めない・壊れている場合も null にして標準の順番で動かす
     * (注文フォームを止めない)
     */
    async getIolOrder(facilityId) {
      try {
        const snap = await fs.getDoc(fs.doc(db, "facilities", facilityId, "displaySettings", "iolOrder"));
        return snap.exists() ? snap.data() : null;
      } catch (e) {
        console.warn("IOLの表示順を読み込めませんでした。標準の順番で表示します:", e);
        return null;
      }
    },
    listDealers: async (facilityId) => (await listSub(facilityId, "facilityDealers")).sort(bySortOrder),
    /** 所属ユーザー（管理者・副管理者のみ読める）。id = uid */
    listMembers: async (facilityId) => (await listSub(facilityId, "members")).map(m => ({ ...m, uid: m.uid || m.id })),
    /** 利用者管理の表示順(管理者・副管理者のみ読める)。未設定は null */
    async getMemberOrder(facilityId) {
      const snap = await fs.getDoc(fs.doc(db, "facilities", facilityId, "displaySettings", "memberOrder"));
      return snap.exists() && Array.isArray(snap.data().order) ? snap.data().order : null;
    },
    /** 参加待ち(事前登録。管理者・副管理者のみ読める。施設で絞った問い合わせだけが Rules で許可される) */
    async listPendingMembers(facilityId) {
      const snap = await fs.getDocs(fs.query(fs.collection(db, "pendingMembers"), fs.where("facilityId", "==", facilityId)));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
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
    role: d.data().role
  }));
}

/**
 * 施設設定の書き込みAPI（施設管理者のみ。実際の権限は Security Rules が検証する）
 * writes: [{ id: string|null, data: object }]（id が null なら新規ドキュメント）
 * 1回の保存を writeBatch で原子的に反映する。
 */
export function createFirestoreSettingsApi(db, fs) {
  const commit = async (facilityId, sub, writes) => {
    if (!writes.length) return;
    const batch = fs.writeBatch(db);
    for (const w of writes) {
      const ref = w.id
        ? fs.doc(db, "facilities", facilityId, sub, w.id)
        : fs.doc(fs.collection(db, "facilities", facilityId, sub));
      batch.set(ref, { ...w.data, updatedAt: fs.serverTimestamp() });
    }
    await batch.commit();
  };
  return {
    saveOrderers: (facilityId, writes) => commit(facilityId, "orderers", writes),
    saveAdoptedIols: (facilityId, writes) => commit(facilityId, "adoptedIols", writes),
    saveDealers: (facilityId, writes) => commit(facilityId, "facilityDealers", writes),
    /** 担当医マスター(コレクション orderers)の削除（所属・認証ユーザー・注文履歴には触れない） */
    /** IOLモデルの表示順の保存(施設管理者のみ。Rules が検証する)。採用状態・注文内容には影響しない */
    saveIolOrder: (facilityId, { makerOrder, modelOrder }) => fs.setDoc(
      fs.doc(db, "facilities", facilityId, "displaySettings", "iolOrder"),
      { makerOrder, modelOrder, updatedAt: fs.serverTimestamp() }),
    /** 利用者管理の表示順の保存(管理者・副管理者のみ。Rules が検証する)。所属・参加待ち・権限には影響しない */
    saveMemberOrder: (facilityId, order) => fs.setDoc(
      fs.doc(db, "facilities", facilityId, "displaySettings", "memberOrder"),
      { order, updatedAt: fs.serverTimestamp() }),
    deleteOrderer: (facilityId, id) => fs.deleteDoc(fs.doc(db, "facilities", facilityId, "orderers", id)),
    /** ディーラーの削除(以後の注文の発注先として使えなくなる。過去の注文に保存されたディーラー情報には触れない) */
    deleteDealer: (facilityId, id) => fs.deleteDoc(fs.doc(db, "facilities", facilityId, "facilityDealers", id)),
  };
}
