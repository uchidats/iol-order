/**
 * 画像の鮮鋭度(ピンぼけの疑いの判定。R09 の IOL シール写真。docs/iol-sticker-photo-design.md §3-4)。純粋関数。
 * 画像を縮小したグレースケールにして、ラプラシアン(4近傍)の分散を測る。ぼけた画像ほど値が小さい。
 * 値は写っている内容(文字の量・明るさ)にも左右されるため、しきい値は実機の検証(sticker-camera-check.html)で決める。
 */

/** 判定の暫定のしきい値(これ未満を「ピンぼけの疑い」。実機検証の後に見直す) */
export const SHARPNESS_THRESHOLD = 100;

/** 測る前に縮小する長辺(大きな写真でも時間をかけない。細部は残る大きさ) */
export const SHARPNESS_MAX_SIDE = 1024;

/**
 * RGBA の画素(ImageData.data と同じ並び)→ 輝度(0〜255)の配列
 * @param {Uint8ClampedArray|Uint8Array|number[]} rgba
 */
export function toGray(rgba) {
  const n = Math.floor(rgba.length / 4);
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  return g;
}

/**
 * ラプラシアンの分散(端の1画素は除く)
 * @param {Float32Array|number[]} gray 輝度(幅 × 高さ)
 */
export function laplacianVariance(gray, width, height) {
  if (width < 3 || height < 3) return 0;
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += v; sum2 += v * v; n++;
    }
  }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

/** 縮小の寸法(長辺を maxSide 以下に。小さい画像はそのまま) */
export function scaledSize(width, height, maxSide = SHARPNESS_MAX_SIDE) {
  const k = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** 判定: { score, blurry } */
export function judgeSharpness(score, threshold = SHARPNESS_THRESHOLD) {
  return { score: Math.round(score * 10) / 10, blurry: score < threshold };
}
