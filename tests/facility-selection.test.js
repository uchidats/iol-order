import test from "node:test";
import assert from "node:assert/strict";
import * as sel from "../src/domain/facility-selection.js";
import { getCurrentPositionOnce, getGeoPermissionState, GeoError, GEO_ERROR } from "../src/ui/geolocation.js";

const mem = () => {
  const d = new Map();
  return {
    getItem: k => d.get(k) ?? null,
    setItem: (k, v) => d.set(k, String(v)),
    removeItem: k => d.delete(k),
    dump: () => [...d.entries()]
  };
};

test("選択した施設は uid とセットで記憶され、他ユーザーには使われない", () => {
  const s = mem();
  assert.equal(sel.readRemembered(s, "u1"), null);
  sel.remember(s, "u1", "fA");
  assert.equal(sel.readRemembered(s, "u1"), "fA");
  assert.equal(sel.readRemembered(s, "u2"), null);
  sel.clearRemembered(s);
  assert.equal(sel.readRemembered(s, "u1"), null);
});

test("記憶値の破損・改ざんは無視する", () => {
  const s = mem();
  s.setItem(sel.SELECTED_FACILITY_KEY, "{not json");
  assert.equal(sel.readRemembered(s, "u1"), null);
  s.setItem(sel.SELECTED_FACILITY_KEY, JSON.stringify({ uid: "u1", facilityId: 123 }));
  assert.equal(sel.readRemembered(s, "u1"), null);
});

test("ストレージ例外でも落ちない", () => {
  const broken = {
    getItem() { throw new Error("x"); },
    setItem() { throw new Error("x"); },
    removeItem() { throw new Error("x"); }
  };
  assert.equal(sel.readRemembered(broken, "u"), null);
  sel.remember(broken, "u", "f");
  sel.clearRemembered(broken);
  assert.equal(sel.hasGeoOptIn(broken), false);
});

test("記憶するのは uid と facilityId のみ（座標を保存しない）", () => {
  const s = mem();
  sel.remember(s, "u1", "fA");
  sel.setGeoOptIn(s);
  const all = JSON.stringify(s.dump());
  assert.ok(!/lat|lng|latitude|longitude|accuracy/i.test(all));
});

test("切替直後フラグは1回だけ有効", () => {
  const ss = mem();
  assert.equal(sel.consumeForceSelect(ss), false);
  sel.setForceSelect(ss);
  assert.equal(sel.consumeForceSelect(ss), true);
  assert.equal(sel.consumeForceSelect(ss), false);
});

test("位置取得は getCurrentPosition を1回だけ呼び、watchPosition は使わない", async () => {
  let watch = 0, once = 0, opts;
  const nav = {
    geolocation: {
      getCurrentPosition: (ok, ng, o) => { once++; opts = o; ok({ coords: { latitude: 1, longitude: 2, accuracy: 7 } }); },
      watchPosition: () => { watch++; }
    }
  };
  const p = await getCurrentPositionOnce(nav);
  assert.deepEqual(p, { lat: 1, lng: 2, accuracyM: 7 });
  assert.equal(once, 1);
  assert.equal(watch, 0);
  assert.equal(opts.maximumAge, 0);
});

test("位置取得エラーの分類", async () => {
  const mk = (code) => ({ geolocation: { getCurrentPosition: (ok, ng) => ng({ code }) } });
  await assert.rejects(getCurrentPositionOnce(mk(1)), (e) => e instanceof GeoError && e.code === GEO_ERROR.DENIED);
  await assert.rejects(getCurrentPositionOnce(mk(3)), (e) => e.code === GEO_ERROR.TIMEOUT);
  await assert.rejects(getCurrentPositionOnce(mk(2)), (e) => e.code === GEO_ERROR.UNAVAILABLE);
  await assert.rejects(getCurrentPositionOnce({}), (e) => e.code === GEO_ERROR.UNSUPPORTED);
});

test("権限状態の取得（非対応は unsupported）", async () => {
  assert.equal(await getGeoPermissionState({}), "unsupported");
  assert.equal(await getGeoPermissionState({ permissions: { query: async () => ({ state: "granted" }) } }), "granted");
  assert.equal(await getGeoPermissionState({ permissions: { query: async () => { throw new Error("x"); } } }), "unsupported");
});
