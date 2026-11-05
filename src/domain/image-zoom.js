/**
 * 画像の拡大・移動の計算(純粋関数)。座標はすべて表示領域の中心を原点とする px。
 * view は { scale, x, y }(x・y は画像の中心のずれ)。box は { width, height, stageWidth, stageHeight, rotation }(width・height は倍率 1 の大きさ)。
 */

/** 倍率の範囲。1 が画像全体の収まる初期表示 */
export const ZOOM = Object.freeze({ min: 1, max: 5, doubleTap: 2.5 });

/** ダブルタップとみなす時間(ms)と距離(px)。タップとみなす指の動きの上限(px) */
export const TAP = Object.freeze({ intervalMs: 300, distance: 30, slop: 10 });

export const INITIAL_VIEW = Object.freeze({ scale: 1, x: 0, y: 0 });

export const clampScale = (scale) => Math.min(ZOOM.max, Math.max(ZOOM.min, scale));

/** 移動を制限する。表示領域より大きい方向だけ動かせて、画像の端は領域の端より内側へ入らない(画像が画面の外へ消えない) */
export function clampPan(view, box) {
  const sideways = (((box.rotation ?? 0) % 180) + 180) % 180 === 90;
  const shownWidth = (sideways ? box.height : box.width) * view.scale;
  const shownHeight = (sideways ? box.width : box.height) * view.scale;
  const maxX = Math.max(0, (shownWidth - box.stageWidth) / 2);
  const maxY = Math.max(0, (shownHeight - box.stageHeight) / 2);
  return { scale: view.scale, x: Math.min(maxX, Math.max(-maxX, view.x)) + 0, y: Math.min(maxY, Math.max(-maxY, view.y)) + 0 };
}

/** point の下にある画像の位置を保ったまま、倍率を変える */
export function zoomAround(view, point, nextScale, box) {
  const scale = clampScale(nextScale);
  const ratio = scale / view.scale;
  return clampPan({ scale, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio }, box);
}

/** 2本指の操作。始めの中心の下にあった画像の位置を、今の中心へ合わせる */
export function pinchView(start, startCenter, startDistance, center, distance, box) {
  const scale = clampScale(start.scale * (distance / startDistance));
  const ratio = scale / start.scale;
  return clampPan({ scale, x: center.x - (startCenter.x - start.x) * ratio, y: center.y - (startCenter.y - start.y) * ratio }, box);
}

/** ダブルタップ: 初期の倍率なら拡大、拡大中なら元に戻す */
export function toggleZoom(view, point, box) {
  return view.scale > ZOOM.min ? clampPan({ ...INITIAL_VIEW }, box) : zoomAround(view, point, ZOOM.doubleTap, box);
}

/** 2回のタップがダブルタップか。tap は { time, x, y } */
export function isDoubleTap(previous, tap) {
  if (!previous) return false;
  return tap.time - previous.time <= TAP.intervalMs && Math.hypot(tap.x - previous.x, tap.y - previous.y) <= TAP.distance;
}

/** ホイールの量を倍率の比にする */
export const wheelFactor = (deltaY) => Math.exp(-deltaY * 0.002);
