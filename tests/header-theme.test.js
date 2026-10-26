import test from "node:test";
import assert from "node:assert/strict";
import {
  HEADER_THEME_PALETTE, READABLE_CONTRAST, normalizeHex, contrastWithWhite, contrastRatio, darken, validateHeaderTheme, readHeaderTheme, headerBackground, isReadable
} from "../src/domain/header-theme.js";
import { cachedHeaderTheme, cacheHeaderTheme } from "../src/ui/header-theme.js";

test("色見本: 10色×2行(1行目=白文字向けの濃い色、2行目=黒文字向けの明るい色)で重複しない。各行の文字色で、グラデーションの両端とも読みやすい", () => {
  assert.deepEqual(HEADER_THEME_PALETTE.map(r => [r.label, r.darkText, r.colors.length]), [["白文字向け", false, 10], ["黒文字向け", true, 10]]);
  const all = HEADER_THEME_PALETTE.flatMap(r => r.colors);
  assert.equal(new Set(all).size, 20);
  for (const row of HEADER_THEME_PALETTE) for (const color of row.colors) {
    for (const gradient of [true, false]) assert.ok(isReadable({ color, gradient, darkText: row.darkText }), `${row.label} ${color} gradient=${gradient}`);
  }
  for (const c of HEADER_THEME_PALETTE[0].colors) assert.ok(contrastWithWhite(c) >= READABLE_CONTRAST, c);
});

test("色の検証: 形式だけを確認(#RRGGBB・#RGB を #rrggbb に)。明るい色も選べる。グラデーションの初期値は ON、文字の初期値は白", () => {
  assert.equal(normalizeHex(" #1D4ED8 "), "#1d4ed8");
  assert.equal(normalizeHex("#abc"), "#aabbcc");
  for (const bad of ["1d4ed8", "#12345", "blue", "", null]) assert.equal(normalizeHex(bad), null, String(bad));
  assert.deepEqual(validateHeaderTheme({ color: "#15803D" }), { ok: true, theme: { color: "#15803d", gradient: true, darkText: false } });
  assert.deepEqual(validateHeaderTheme({ color: "#fde047", gradient: false, darkText: true }).theme, { color: "#fde047", gradient: false, darkText: true });
  assert.deepEqual(validateHeaderTheme({ color: "#ffffff" }).theme, { color: "#ffffff", gradient: true, darkText: false }, "読みにくい組み合わせも検証は通す");
  assert.match(validateHeaderTheme({ color: "red" }).error, /#RRGGBB/);
});

test("読みやすさの案内: 白い文字は暗い背景、黒い文字は明るい背景で読みやすい。グラデーションは両端で確認。未設定(標準)は読みやすい", () => {
  assert.equal(isReadable(null), true);
  assert.equal(isReadable({ color: "#15803d", gradient: true, darkText: false }), true);
  assert.equal(isReadable({ color: "#fde047", gradient: false, darkText: false }), false, "明るい黄色に白い文字");
  assert.equal(isReadable({ color: "#fde047", gradient: false, darkText: true }), true, "明るい黄色に黒い文字");
  assert.equal(isReadable({ color: "#15803d", gradient: false, darkText: true }), false, "濃い緑に黒い文字");
  // 明るい色のグラデーションは濃い側も確認する(黒い文字が濃い側で読みにくければ案内)
  const c = "#fbbf24";
  assert.equal(isReadable({ color: c, gradient: true, darkText: true }), contrastRatio("#000000", darken(c)) >= READABLE_CONTRAST && contrastRatio("#000000", c) >= READABLE_CONTRAST);
});

test("ヘッダーの背景: 未設定は null(標準の青のまま)。グラデーションは濃い側→選んだ色、OFF は単色", () => {
  assert.equal(headerBackground(null), null);
  assert.equal(headerBackground({ color: "#15803d", gradient: false }), "#15803d");
  assert.equal(headerBackground({ color: "#15803d", gradient: true }), `linear-gradient(135deg, ${darken("#15803d")} 0%, #15803d 100%)`);
});

test("保存値の読み込み: 既存の設定(黒い文字の項目なし)は白い文字。明るい色もそのまま。壊れている値は未設定", () => {
  assert.equal(readHeaderTheme(null), null);
  assert.equal(readHeaderTheme({ color: 123 }), null);
  assert.deepEqual(readHeaderTheme({ color: "#7e22ce", gradient: false, updatedAt: {} }), { color: "#7e22ce", gradient: false, darkText: false });
  assert.deepEqual(readHeaderTheme({ color: "#ffff00", gradient: true, darkText: true }), { color: "#ffff00", gradient: true, darkText: true });
});

test("端末に覚える設定: 施設ごと。初期設定に戻すと消える。ストレージが使えなくても例外にしない", () => {
  const m = new Map();
  const storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  cacheHeaderTheme("f1", { color: "#fde047", gradient: true, darkText: true }, storage);
  assert.deepEqual(cachedHeaderTheme("f1", storage), { color: "#fde047", gradient: true, darkText: true });
  assert.equal(cachedHeaderTheme("f2", storage), null);
  cacheHeaderTheme("f1", null, storage);
  assert.equal(cachedHeaderTheme("f1", storage), null);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
  assert.equal(cachedHeaderTheme("f1", broken), null);
  assert.doesNotThrow(() => cacheHeaderTheme("f1", { color: "#15803d", gradient: true }, broken));
});
