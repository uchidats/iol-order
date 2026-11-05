// 画像の拡大・移動の計算(純粋関数)
import test from "node:test";
import assert from "node:assert/strict";
import { ZOOM, TAP, INITIAL_VIEW, clampScale, clampPan, zoomAround, pinchView, toggleZoom, isDoubleTap, wheelFactor } from "../src/domain/image-zoom.js";

const BOX = { width: 300, height: 400, stageWidth: 300, stageHeight: 400, rotation: 0 };

test("倍率は 1〜5 倍の範囲", () => {
  assert.deepEqual([ZOOM.min, ZOOM.max], [1, 5]);
  assert.deepEqual([clampScale(0.2), clampScale(3), clampScale(50)], [1, 3, 5]);
});

test("移動の制限: 初期の倍率では動かず、拡大すると画像の端が領域の端より内側へ入らない", () => {
  assert.deepEqual(clampPan({ scale: 1, x: 100, y: -100 }, BOX), { scale: 1, x: 0, y: 0 });
  assert.deepEqual(clampPan({ scale: 2, x: 1000, y: -1000 }, BOX), { scale: 2, x: 150, y: -200 });
  assert.deepEqual(clampPan({ scale: 2, x: 20, y: 30 }, BOX), { scale: 2, x: 20, y: 30 });
});

test("移動の制限: 領域より小さい方向は中央のまま。回転は向きに合わせて幅と高さを入れ替える", () => {
  const wide = { ...BOX, stageWidth: 1000 };
  assert.deepEqual(clampPan({ scale: 2, x: 50, y: 50 }, wide), { scale: 2, x: 0, y: 50 });
  assert.deepEqual(clampPan({ scale: 2, x: 1000, y: 1000 }, { ...BOX, rotation: 90 }), { scale: 2, x: 250, y: 100 });
  assert.deepEqual(clampPan({ scale: 2, x: 1000, y: 1000 }, { ...BOX, rotation: 180 }), { scale: 2, x: 150, y: 200 });
  assert.deepEqual(clampPan({ scale: 2, x: 1000, y: 1000 }, { ...BOX, rotation: 270 }), { scale: 2, x: 250, y: 100 });
});

test("指定の位置の下の画像を保って拡大する。上限を超えず、1 倍で中央へ戻る", () => {
  const v = zoomAround(INITIAL_VIEW, { x: 100, y: 0 }, 2, BOX);
  assert.deepEqual(v, { scale: 2, x: -100, y: 0 });
  const imagePoint = (view, p) => (p - view.x) / view.scale;
  assert.equal(imagePoint(v, 100), imagePoint(INITIAL_VIEW, 100));
  assert.equal(zoomAround(v, { x: 0, y: 0 }, 99, BOX).scale, 5);
  assert.deepEqual(zoomAround(v, { x: 0, y: 0 }, 0.1, BOX), { scale: 1, x: 0, y: 0 });
});

test("2本指: 距離の比で拡大し、中心の移動で画像も動く", () => {
  const start = { scale: 2, x: 0, y: 0 };
  assert.equal(pinchView(start, { x: 0, y: 0 }, 100, { x: 0, y: 0 }, 150, BOX).scale, 3);
  assert.equal(pinchView(start, { x: 0, y: 0 }, 100, { x: 0, y: 0 }, 10, BOX).scale, 1);
  assert.equal(pinchView(start, { x: 0, y: 0 }, 100, { x: 0, y: 0 }, 10000, BOX).scale, 5);
  assert.deepEqual(pinchView(start, { x: 0, y: 0 }, 100, { x: 30, y: -20 }, 100, BOX), { scale: 2, x: 30, y: -20 });
});

test("ダブルタップ: 初期の倍率なら拡大し、拡大中なら元に戻す", () => {
  const zoomed = toggleZoom(INITIAL_VIEW, { x: 0, y: 0 }, BOX);
  assert.equal(zoomed.scale, ZOOM.doubleTap);
  assert.deepEqual(toggleZoom({ ...zoomed, x: 40 }, { x: 0, y: 0 }, BOX), { scale: 1, x: 0, y: 0 });
});

test("ダブルタップの判定: 時間と距離の両方が近いときだけ", () => {
  const first = { time: 1000, x: 0, y: 0 };
  assert.equal(isDoubleTap(null, first), false);
  assert.equal(isDoubleTap(first, { time: 1000 + TAP.intervalMs, x: 10, y: 10 }), true);
  assert.equal(isDoubleTap(first, { time: 1001 + TAP.intervalMs, x: 0, y: 0 }), false);
  assert.equal(isDoubleTap(first, { time: 1100, x: TAP.distance + 1, y: 0 }), false);
});

test("ホイール: 手前で縮小、奥で拡大", () => {
  assert.ok(wheelFactor(-100) > 1 && wheelFactor(100) < 1);
  assert.equal(wheelFactor(0), 1);
});
