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
    /**
     * 注文履歴の1ページ(注文日の新しい順)。cursor は前のページの最後の文書(続きから読む)。論理削除した注文も含む(除くのは画面)
     * @returns {Promise<{orders:Array<object>, cursor:object|null, hasMore:boolean}>}
     */
    async listOrdersPage(facilityId, { limit = 20, cursor = null } = {}) {
      const q = fs.query(fs.collection(db, "facilities", facilityId, "orders"), fs.orderBy("createdAt", "desc"), ...(cursor ? [fs.startAfter(cursor)] : []), fs.limit(limit));
      const snap = await fs.getDocs(q);
      return { orders: snap.docs.map(d => ({ id: d.id, facilityId, ...d.data() })), cursor: snap.docs.length ? snap.docs[snap.docs.length - 1] : cursor, hasMore: snap.docs.length === limit };
    },
    /**
     * 手術日順の1ページ(手術日の新しい順、同じ日は注文日の新しい順)。索引(orderSurgeryIndex)は注文ID×手術日なので、手術日が複数の注文は日ごとに出る。
     * 論理削除した注文の索引は除く(削除済みで枠が埋まらない)
     * @returns {Promise<{entries:Array<{orderId:string, surgeryDate:string, lineNos:number[]}>, cursor:object|null, hasMore:boolean}>}
     */
    async listSurgeryIndexPage(facilityId, { limit = 20, cursor = null } = {}) {
      const q = fs.query(fs.collection(db, "facilities", facilityId, "orderSurgeryIndex"), fs.where("deleted", "==", false),
        fs.orderBy("surgeryDate", "desc"), fs.orderBy("createdAt", "desc"), ...(cursor ? [fs.startAfter(cursor)] : []), fs.limit(limit));
      const snap = await fs.getDocs(q);
      return { entries: snap.docs.map(d => ({ id: d.id, ...d.data() })), cursor: snap.docs.length ? snap.docs[snap.docs.length - 1] : cursor, hasMore: snap.docs.length === limit };
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
    /** 代行入力時の担当医の初期選択(所属者が読める)。未設定は null(OFF として扱う) */
    async getProxyDoctor(facilityId) {
      const snap = await fs.getDoc(fs.doc(db, "facilities", facilityId, "displaySettings", "proxyDoctor"));
      return snap.exists() ? snap.data() : null;
    },
    /** ヘッダーのテーマカラー(所属者が読める)。未設定は null */
    async getHeaderTheme(facilityId) {
      const snap = await fs.getDoc(fs.doc(db, "facilities", facilityId, "displaySettings", "headerTheme"));
      return snap.exists() ? snap.data() : null;
    },
    listDealers: async (facilityId) => (await listSub(facilityId, "facilityDealers")).sort(bySortOrder),
    /** 施設のメール設定(注文控え・署名)。管理者・副管理者だけが読める。未設定は null */
    async getMailSettings(facilityId) {
      const snap = await fs.getDoc(fs.doc(db, "facilities", facilityId, "settings", "mail"));
      return snap.exists() ? snap.data() : null;
    },
    /** 所属ユーザー（管理者・副管理者のみ読める）。id = uid */
    listMembers: async (facilityId) => (await listSub(facilityId, "members")).map(m => ({ ...m, uid: m.uid || m.id })),
    /** 利用者管理の表示順(管理者・副管理者のみ読める)。未設定は null */
    async getMemberOrder(facilityId) {
      const snap = await fs.getDoc(fs.doc(db, "facilities", facilityId, "displaySettings", "memberOrder"));
      return snap.exists() && Array.isArray(snap.data().order) ? snap.data().order : null;
    },
    /** サービス紹介「IOL Orderについて」の本文(Rules で platformAdmin だけが読める)。未登録は null */
    async getServiceIntroduction() {
      const snap = await fs.getDoc(fs.doc(db, "platformContent", "serviceIntroduction"));
      return snap.exists() ? snap.data() : null;
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
 * 施設設定の変更者の記録(updatedBy・削除の記録)を送るか。Rules(firestore.rules の actorOk / deletionMarks。移行用の設定)は
 * 2026-10-25 に medconf-iol-dev へデプロイ済みのため true。手順は docs/settings-audit.md。
 */
export const SETTINGS_ACTOR_TRACKING = true;

/**
 * 施設設定の書き込みAPI（施設管理者のみ。実際の権限は Security Rules が検証する）
 * writes: [{ id: string|null, data: object }]（id が null なら新規ドキュメント）
 * 1回の保存を writeBatch で原子的に反映する。
 * 変更者の記録が有効なら、作成・更新に updatedBy(ログイン中の uid)を付け、担当医・ディーラーの削除は
 * 同じ一括書き込みで削除の記録(deletionMarks)を書く。どちらも Rules が本人の uid・この書き込みの時刻であることを検証する。
 * @param {{getUid?: () => (string|null), trackActor?: boolean}} [opts]
 */
export function createFirestoreSettingsApi(db, fs, { getUid = () => null, trackActor = SETTINGS_ACTOR_TRACKING } = {}) {
  const actorUid = () => {
    const uid = getUid();
    if (!uid) throw new Error("ログイン情報を確認できません。ページを再読み込みしてください");
    return uid;
  };
  const commit = async (facilityId, sub, writes) => {
    if (!writes.length) return;
    const batch = fs.writeBatch(db);
    const by = trackActor ? { updatedBy: actorUid() } : {};
    for (const w of writes) {
      const ref = w.id
        ? fs.doc(db, "facilities", facilityId, sub, w.id)
        : fs.doc(fs.collection(db, "facilities", facilityId, sub));
      batch.set(ref, { ...w.data, updatedAt: fs.serverTimestamp(), ...by });
    }
    await batch.commit();
  };
  // extra: 同じ一括書き込みで書く追加の内容 [[ref, data]](担当医の削除と同時に、代行入力時の担当医の設定を解除するなど)
  const remove = async (facilityId, sub, id, extra = []) => {
    const ref = fs.doc(db, "facilities", facilityId, sub, id);
    if (!trackActor && !extra.length) return fs.deleteDoc(ref);
    const batch = fs.writeBatch(db);
    batch.delete(ref);
    if (trackActor) batch.set(fs.doc(db, "facilities", facilityId, "deletionMarks", `${sub}_${id}`),
      { collection: sub, docId: id, deletedBy: actorUid(), deletedAt: fs.serverTimestamp() });
    for (const [r, data] of extra) batch.set(r, data);
    await batch.commit();
  };
  const proxyDoctorRef = (facilityId) => fs.doc(db, "facilities", facilityId, "displaySettings", "proxyDoctor");
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
    /** ヘッダーのテーマカラーの保存(管理者・副管理者のみ。Rules が検証する)。初期設定に戻すときは削除する */
    saveHeaderTheme: (facilityId, { color, gradient, darkText }) => fs.setDoc(
      fs.doc(db, "facilities", facilityId, "displaySettings", "headerTheme"),
      { color, gradient, darkText: darkText === true, updatedAt: fs.serverTimestamp() }),
    resetHeaderTheme: (facilityId) => fs.deleteDoc(fs.doc(db, "facilities", facilityId, "displaySettings", "headerTheme")),
    /** 施設のメール設定の保存(管理者・副管理者のみ。Rules が検証する)。変更者の記録(updatedBy)も付ける */
    saveMailSettings: async (facilityId, data) => {
      const by = trackActor ? { updatedBy: actorUid() } : {};
      await fs.setDoc(fs.doc(db, "facilities", facilityId, "settings", "mail"), { ...data, updatedAt: fs.serverTimestamp(), ...by });
    },
    /** clearProxyDoctor: この担当医が代行入力時の初期選択なら、同じ一括書き込みで設定を解除(OFF)する */
    deleteOrderer: (facilityId, id, { clearProxyDoctor = false } = {}) => remove(facilityId, "orderers", id,
      clearProxyDoctor ? [[proxyDoctorRef(facilityId), { enabled: false, doctorId: "", updatedAt: fs.serverTimestamp() }]] : []),
    /** 代行入力時の担当医の初期選択の保存(管理者・副管理者のみ。Rules が形式と担当医の存在を検証する) */
    saveProxyDoctor: (facilityId, { enabled, doctorId }) => fs.setDoc(proxyDoctorRef(facilityId),
      { enabled: enabled === true, doctorId: enabled === true ? doctorId : "", updatedAt: fs.serverTimestamp() }),
    /** ディーラーの削除(以後の注文の発注先として使えなくなる。過去の注文に保存されたディーラー情報には触れない) */
    deleteDealer: (facilityId, id) => remove(facilityId, "facilityDealers", id),
  };
}
