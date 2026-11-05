import { INITIAL_VIEW, TAP, clampPan, isDoubleTap, pinchView, toggleZoom, wheelFactor, zoomAround } from "../domain/image-zoom.js";

/**
 * 画像の拡大・移動の操作(スマートフォンの写真アプリに近い操作)。ライブラリを使わず Pointer Events で扱う。
 * タッチ: 2本指で拡大・縮小、ドラッグで移動、ダブルタップで拡大と元に戻す。
 * PC: ホイールで拡大・縮小、ドラッグで移動、ダブルクリックで拡大と元に戻す。
 * 操作は表示領域の中だけで受ける(CSS の touch-action: none も領域の中だけ)。ページ全体のズームは禁止しない。
 * @param {{stage:HTMLElement, img:HTMLImageElement}} deps
 */
export function createImageZoom({ stage, img }) {
  let view = { ...INITIAL_VIEW };
  let rotation = 0;
  let gesture = null;
  let lastTap = null;
  const pointers = new Map();

  /** 倍率 1 の大きさは小数まで使う(offsetWidth の丸めで端に隙間が出ないように) */
  const box = () => {
    const size = getComputedStyle(img);
    return { width: parseFloat(size.width) || 0, height: parseFloat(size.height) || 0, stageWidth: stage.clientWidth, stageHeight: stage.clientHeight, rotation };
  };
  const ready = () => img.naturalWidth > 0;

  function render() {
    const parts = [];
    if (view.x || view.y) parts.push(`translate(${view.x}px, ${view.y}px)`);
    if (view.scale !== 1) parts.push(`scale(${view.scale})`);
    if (rotation) parts.push(`rotate(${rotation}deg)`);
    img.style.transform = parts.join(" ");
    stage.classList.toggle("is-zoomed", view.scale > 1);
    stage.classList.toggle("is-dragging", gesture !== null);
  }
  const apply = (next) => { view = next; render(); };

  /** 表示領域の中心を原点とする座標 */
  const pointOf = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };

  /** 今の指の数で操作を始め直す。指が増減しても画像が飛ばない */
  function begin(moved) {
    const [a, b] = [...pointers.values()];
    if (b) gesture = { pinch: true, moved: true, view, center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
    else if (a) gesture = { pinch: false, moved, view, start: a };
    else gesture = null;
    render();
  }

  function onDown(e) {
    if (!ready() || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    try { stage.setPointerCapture(e.pointerId); } catch { /* 取れなくても操作はできる */ }
    pointers.set(e.pointerId, pointOf(e));
    begin(pointers.size > 1);
  }

  function onMove(e) {
    if (!gesture || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, pointOf(e));
    const [a, b] = [...pointers.values()];
    if (gesture.pinch && b) {
      apply(pinchView(gesture.view, gesture.center, gesture.distance, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, Math.hypot(a.x - b.x, a.y - b.y), box()));
    } else if (!gesture.pinch) {
      const dx = a.x - gesture.start.x, dy = a.y - gesture.start.y;
      if (Math.hypot(dx, dy) > TAP.slop) gesture.moved = true;
      if (gesture.moved) apply(clampPan({ ...gesture.view, x: gesture.view.x + dx, y: gesture.view.y + dy }, box()));
    }
  }

  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    const point = pointers.get(e.pointerId);
    const tapped = e.type === "pointerup" && gesture && !gesture.moved && pointers.size === 1;
    pointers.delete(e.pointerId);
    begin(true);
    if (!tapped) { lastTap = null; return; }
    const tap = { time: e.timeStamp, x: point.x, y: point.y };
    if (isDoubleTap(lastTap, tap)) { lastTap = null; apply(toggleZoom(view, point, box())); } else lastTap = tap;
  }

  function onWheel(e) {
    if (!ready()) return;
    e.preventDefault();
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1;
    apply(zoomAround(view, pointOf(e), view.scale * wheelFactor(e.deltaY * lines), box()));
  }

  const onResize = () => apply(clampPan(view, box()));
  const stopGesture = (e) => e.preventDefault();   // Safari のトラックパッド・古い iOS の画面のズーム(領域の中だけ)

  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("gesturestart", stopGesture);
  window.addEventListener("resize", onResize);

  return {
    /** 初期表示(画像全体が収まる倍率)へ戻す。回転は指定の角度にする */
    reset(nextRotation = 0) {
      rotation = nextRotation;
      pointers.clear();
      gesture = null;
      lastTap = null;
      apply(clampPan({ ...INITIAL_VIEW }, box()));
    },
    get rotation() { return rotation; },
    dispose() { window.removeEventListener("resize", onResize); }
  };
}
