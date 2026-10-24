import test from "node:test";
import assert from "node:assert/strict";
import { distanceMeters, facilityGeo, decideFacilityByLocation, GEO_RESULT, isValidLatLng } from "../src/domain/geo.js";

// テスト専用の架空の座標（実在施設の位置ではない）。経度方向に移動して距離を作る。
const ORIGIN = { lat: 10, lng: 20 };
const metersEast = (m) => ({ lat: ORIGIN.lat, lng: ORIGIN.lng + m / (111195 * Math.cos((ORIGIN.lat * Math.PI) / 180)) });
const fac = (id, atMeters, radiusM) => ({ id, location: metersEast(atMeters), geoRadiusM: radiusM });
const here = (atMeters, accuracyM) => ({ ...metersEast(atMeters), accuracyM });

test("距離計算は概ね正しい（赤道上の経度1度 ≒ 111km）", () => {
  const d = distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
  assert.ok(Math.abs(d - 111195) < 200);
  assert.equal(Math.round(distanceMeters(ORIGIN, ORIGIN)), 0);
});

test("座標の妥当性検証", () => {
  assert.equal(isValidLatLng({ lat: 0, lng: 0 }), true);
  for (const bad of [null, {}, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: "1", lng: 0 }, { lat: NaN, lng: 0 }]) {
    assert.equal(isValidLatLng(bad), false);
  }
});

test("座標または判定距離が未登録の施設は判定対象外（推測で補わない）", () => {
  assert.equal(facilityGeo({ id: "a" }), null);
  assert.equal(facilityGeo({ id: "a", location: { lat: 1, lng: 1 } }), null);
  assert.equal(facilityGeo({ id: "a", geoRadiusM: 100 }), null);
  assert.equal(facilityGeo({ id: "a", location: { lat: 1, lng: 1 }, geoRadiusM: 0 }), null);
  assert.equal(decideFacilityByLocation(here(0, 5), [{ id: "a" }, { id: "b" }]).status, GEO_RESULT.NO_GEO_DATA);
});

test("精度が十分で1施設だけの近くにいれば自動選択", () => {
  const facilities = [fac("A", 0, 200), fac("B", 5000, 200)];
  const r = decideFacilityByLocation(here(20, 10), facilities);
  assert.deepEqual(r, { status: GEO_RESULT.SELECTED, facilityId: "A" });
});

test("どの施設の近くでもなければ手動選択", () => {
  assert.equal(decideFacilityByLocation(here(2000, 10), [fac("A", 0, 200), fac("B", 5000, 200)]).status, GEO_RESULT.OUT_OF_RANGE);
});

test("測位精度が不十分（誤差円が判定円に収まらない）なら自動選択しない", () => {
  // 距離は施設内だが、誤差が判定距離以上
  assert.equal(decideFacilityByLocation(here(10, 250), [fac("A", 0, 200)]).status, GEO_RESULT.LOW_ACCURACY);
  // 境界付近: d + accuracy > radius
  assert.equal(decideFacilityByLocation(here(150, 80), [fac("A", 0, 200)]).status, GEO_RESULT.LOW_ACCURACY);
});

test("複数の施設が該当し得る場合は自動選択しない", () => {
  const two = [fac("A", 0, 300), fac("B", 100, 300)];
  assert.equal(decideFacilityByLocation(here(50, 10), two).status, GEO_RESULT.AMBIGUOUS);
  // 1施設は確実に内側でも、もう一方も誤差次第で該当し得る
  const near = [fac("A", 0, 100), fac("B", 160, 100)];
  assert.equal(decideFacilityByLocation(here(10, 60), near).status, GEO_RESULT.AMBIGUOUS);
});

test("無効な測位結果は拒否", () => {
  for (const bad of [{ lat: NaN, lng: 0, accuracyM: 5 }, { ...ORIGIN, accuracyM: -1 }, { ...ORIGIN, accuracyM: NaN }, null]) {
    assert.equal(decideFacilityByLocation(bad, [fac("A", 0, 200)]).status, GEO_RESULT.INVALID_POSITION);
  }
});
