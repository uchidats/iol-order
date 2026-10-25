import test from "node:test";
import assert from "node:assert/strict";
import { createFirestoreSettingsApi, SETTINGS_ACTOR_TRACKING } from "../src/data/firestore-repository.js";

/** 書き込みを記録する偽の firebase-firestore */
function fakeFs() {
  const ops = [];
  let n = 0;
  const fs = {
    serverTimestamp: () => "SERVER_TS",
    doc: (a, ...path) => (a && a.coll ? { path: `${a.coll}/auto${++n}` } : { path: path.join("/") }),
    collection: (db, ...path) => ({ coll: path.join("/") }),
    writeBatch: () => { const b = []; return { set: (r, d) => b.push(["set", r.path, d]), delete: (r) => b.push(["delete", r.path]), commit: async () => ops.push(b) }; },
    deleteDoc: async (r) => ops.push([["deleteDoc", r.path]]),
    setDoc: async (r, d) => ops.push([["setDoc", r.path, d]])
  };
  return { fs, ops };
}

test("Rules をデプロイするまでは、変更者の記録を送らない(現在のRulesで保存・削除を止めない)", async () => {
  assert.equal(SETTINGS_ACTOR_TRACKING, false);
  const { fs, ops } = fakeFs();
  const api = createFirestoreSettingsApi({}, fs, { getUid: () => "adminA" });
  await api.saveOrderers("f1", [{ id: "o1", data: { facilityId: "f1", name: "山田", sortOrder: 10 } }]);
  await api.deleteDealer("f1", "d1");
  assert.deepEqual(ops, [[["set", "facilities/f1/orderers/o1", { facilityId: "f1", name: "山田", sortOrder: 10, updatedAt: "SERVER_TS" }]], [["deleteDoc", "facilities/f1/facilityDealers/d1"]]]);
});

test("変更者の記録が有効: 作成・更新・並び替え(同じ一括保存)のすべてに updatedBy。削除は削除の記録と同じ一括書き込み", async () => {
  const { fs, ops } = fakeFs();
  const api = createFirestoreSettingsApi({}, fs, { getUid: () => "adminA", trackActor: true });
  await api.saveOrderers("f1", [{ id: "o1", data: { name: "山田", sortOrder: 20 } }, { id: "o2", data: { name: "佐藤", sortOrder: 10 } }, { id: null, data: { name: "新任", sortOrder: 30 } }]);
  assert.deepEqual(ops[0].map(o => [o[1], o[2].updatedBy, o[2].updatedAt]), [
    ["facilities/f1/orderers/o1", "adminA", "SERVER_TS"], ["facilities/f1/orderers/o2", "adminA", "SERVER_TS"], ["facilities/f1/orderers/auto1", "adminA", "SERVER_TS"]]);
  await api.saveAdoptedIols("f1", [{ id: "jj-dib00v", data: { catalogIolId: "jj-dib00v", enabled: false } }]);
  await api.saveDealers("f1", [{ id: "d1", data: { name: "A商会", orderEmails: ["z@other.jp"] } }]);
  assert.equal(ops[1][0][2].updatedBy, "adminA");
  assert.equal(ops[2][0][2].updatedBy, "adminA");
  await api.deleteOrderer("f1", "o1");
  await api.deleteDealer("f1", "d1");
  assert.deepEqual(ops[3], [["delete", "facilities/f1/orderers/o1"], ["set", "facilities/f1/deletionMarks/orderers_o1", { collection: "orderers", docId: "o1", deletedBy: "adminA", deletedAt: "SERVER_TS" }]]);
  assert.deepEqual(ops[4][1][1], "facilities/f1/deletionMarks/facilityDealers_d1");
  // 表示順は対象外(従来どおり)
  await api.saveIolOrder("f1", { makerOrder: [], modelOrder: [] });
  assert.equal("updatedBy" in ops[5][0][2], false);
});

test("変更者の記録が有効でログイン情報がない場合は、書き込まずにエラー(他人の名前で記録しない)", async () => {
  const { fs, ops } = fakeFs();
  const api = createFirestoreSettingsApi({}, fs, { getUid: () => null, trackActor: true });
  await assert.rejects(api.saveDealers("f1", [{ id: "d1", data: { name: "A" } }]), /ログイン情報を確認できません/);
  await assert.rejects(api.deleteOrderer("f1", "o1"), /ログイン情報/);
  assert.deepEqual(ops, []);
});
