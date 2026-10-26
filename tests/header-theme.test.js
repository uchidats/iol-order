import test from "node:test";
import assert from "node:assert/strict";
import {
  HEADER_THEME_PALETTE, MIN_CONTRAST_WITH_WHITE, normalizeHex, contrastWithWhite, darken, validateHeaderTheme, readHeaderTheme, headerBackground
} from "../src/domain/header-theme.js";
import { cachedHeaderTheme, cacheHeaderTheme } from "../src/ui/header-theme.js";

test("色見本: 10色×3段の格子。すべて白い文字が読める濃さ(コントラスト比 4.5 以上)で、重複しない", () => {
  assert.deepEqual(HEADER_THEME_PALETTE.map(r => r.length), [10, 10, 10]);
  const all = HEADER_THEME_PALETTE.flat();
  assert.equal(new Set(all).size, all.length);
  for (const c of all) assert.ok(contrastWithWhite(c) >= MIN_CONTRAST_WITH_WHITE, c);
});

test("色の検証: #RRGGBB・#RGB を小文字の #rrggbb にそろえる。形式違い・明るすぎる色は拒否。グラデーションの初期値は ON", () => {
  assert.equal(normalizeHex(" #1D4ED8 "), "#1d4ed8");
  assert.equal(normalizeHex("#abc"), "#aabbcc");
  for (const bad of ["1d4ed8", "#12345", "blue", "", null]) assert.equal(normalizeHex(bad), null, String(bad));
  assert.deepEqual(validateHeaderTheme({ color: "#15803D" }), { ok: true, theme: { color: "#15803d", gradient: true } });
  assert.deepEqual(validateHeaderTheme({ color: "#15803d", gradient: false }).theme, { color: "#15803d", gradient: false });
  assert.match(validateHeaderTheme({ color: "#fde047" }).error, /明るすぎて白い文字が読みにくい/);
  assert.match(validateHeaderTheme({ color: "#ffffff" }).error, /明るすぎ/);
  assert.match(validateHeaderTheme({ color: "red" }).error, /#RRGGBB/);
});

test("ヘッダーの背景: 未設定は null(標準の青のまま)。グラデーションは濃い側→選んだ色、OFF は単色。濃い側も白い文字が読める", () => {
  assert.equal(headerBackground(null), null);
  assert.equal(headerBackground({ color: "#15803d", gradient: false }), "#15803d");
  assert.equal(headerBackground({ color: "#15803d", gradient: true }), `linear-gradient(135deg, ${darken("#15803d")} 0%, #15803d 100%)`);
  for (const c of HEADER_THEME_PALETTE.flat()) assert.ok(contrastWithWhite(darken(c)) >= contrastWithWhite(c), c);
});

test("保存値の読み込み: 壊れている・明るすぎる値は未設定として扱う", () => {
  assert.equal(readHeaderTheme(null), null);
  assert.equal(readHeaderTheme({ color: "#ffff00", gradient: true }), null);
  assert.equal(readHeaderTheme({ color: 123 }), null);
  assert.deepEqual(readHeaderTheme({ color: "#7e22ce", gradient: false, updatedAt: {} }), { color: "#7e22ce", gradient: false });
});

test("端末に覚える設定: 施設ごと。初期設定に戻すと消える。ストレージが使えなくても例外にしない", () => {
  const m = new Map();
  const storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  cacheHeaderTheme("f1", { color: "#15803d", gradient: true }, storage);
  assert.deepEqual(cachedHeaderTheme("f1", storage), { color: "#15803d", gradient: true });
  assert.equal(cachedHeaderTheme("f2", storage), null);
  cacheHeaderTheme("f1", null, storage);
  assert.equal(cachedHeaderTheme("f1", storage), null);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
  assert.equal(cachedHeaderTheme("f1", broken), null);
  assert.doesNotThrow(() => cacheHeaderTheme("f1", { color: "#15803d", gradient: true }, broken));
});
