// 画像の鮮鋭度(R09 のピンぼけの疑いの判定)の純粋な処理
import test from "node:test";
import assert from "node:assert/strict";
import { toGray, laplacianVariance, scaledSize, judgeSharpness, SHARPNESS_THRESHOLD } from "../src/domain/image-sharpness.js";

/** 合成画像: 細かい白黒の縞(文字の代わり)。blur > 0 で横方向に平均してぼかす */
function stripes(w, h, period = 4, blur = 0) {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = Math.floor((x + y) / period) % 2 ? 255 : 0;
  if (!blur) return g;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let d = -blur; d <= blur; d++) { const xx = Math.min(w - 1, Math.max(0, x + d)); s += g[y * w + xx]; n++; }
    for (let d = -blur; d <= blur; d++) { const yy = Math.min(h - 1, Math.max(0, y + d)); s += g[yy * w + x]; n++; }
    out[y * w + x] = s / n;
  }
  return out;
}

test("鮮鋭度: くっきりした画像はぼかした画像より大きい。ぼかすほど小さくなる。均一な画像は 0", () => {
  const w = 120, h = 80;
  const sharp = laplacianVariance(stripes(w, h), w, h);
  const soft = laplacianVariance(stripes(w, h, 4, 2), w, h);
  const softer = laplacianVariance(stripes(w, h, 4, 6), w, h);
  assert.ok(sharp > soft && soft > softer, `${sharp} > ${soft} > ${softer}`);
  assert.equal(laplacianVariance(new Float32Array(w * h).fill(128), w, h), 0);
  assert.equal(laplacianVariance(new Float32Array(4), 2, 2), 0, "小さすぎる画像は 0");
  assert.equal(judgeSharpness(sharp).blurry, false);
  assert.equal(judgeSharpness(softer).blurry, softer < SHARPNESS_THRESHOLD);
  assert.deepEqual(judgeSharpness(12.345, 50), { score: 12.3, blurry: true });
});

test("鮮鋭度: RGBA → 輝度、縮小の寸法(長辺 1024 以下。小さい画像はそのまま)", () => {
  assert.deepEqual([...toGray([255, 255, 255, 255, 0, 0, 0, 255])].map(Math.round), [255, 0]);
  assert.equal(Math.round(toGray([255, 0, 0, 255])[0]), 76);
  assert.deepEqual(scaledSize(4000, 3000), { width: 1024, height: 768 });
  assert.deepEqual(scaledSize(3000, 4000), { width: 768, height: 1024 });
  assert.deepEqual(scaledSize(800, 600), { width: 800, height: 600 });
});
