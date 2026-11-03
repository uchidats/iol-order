// サブテーマカラー(主要ボタン・選択中の表示などの色)の純粋な処理: 元の色の検証、表示のときの濃さの調整、CSS 変数の値
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SUB_THEME_VARS, validateSubTheme, readSubTheme, readablePrimary, subThemeVars, mix } from "../src/domain/sub-theme.js";
import { HEADER_THEME_PALETTE, contrastRatio } from "../src/domain/header-theme.js";
import { applySubTheme, cachedSubTheme, cacheSubTheme } from "../src/ui/sub-theme.js";

const PALETTE = HEADER_THEME_PALETTE.flatMap(r => r.colors);

test("サブテーマカラー: 元の色の検証と読み込み(#rrggbb にそろえる。壊れた値・未設定は null = 従来の青)", () => {
  assert.deepEqual(validateSubTheme({ color: "#ABC" }), { ok: true, theme: { color: "#aabbcc" } });
  assert.deepEqual(validateSubTheme({ color: " #93C5FD " }), { ok: true, theme: { color: "#93c5fd" } });
  assert.equal(validateSubTheme({ color: "red" }).ok, false);
  assert.equal(validateSubTheme({}).ok, false);
  assert.deepEqual(readSubTheme({ color: "#93c5fd", updatedAt: {} }), { color: "#93c5fd" }, "保存されている元の色をそのまま読む(調整後の色ではない)");
  assert.equal(readSubTheme(null), null);
  assert.equal(readSubTheme({ color: "x" }), null);
  assert.equal(subThemeVars(null), null, "未設定は上書きしない");
});

test("サブテーマカラー: 色見本20色と極端な色で、主色は白い文字・薄い背景の上の文字ともコントラスト比4.5以上。十分に濃い色はそのまま、明るい色は色合いを保って濃くする", () => {
  for (const c of [...PALETTE, "#ffffff", "#ffff00", "#00ff00", "#000000", "#777777"]) {
    const v = subThemeVars({ color: c });
    assert.deepEqual(Object.keys(v).sort(), [...SUB_THEME_VARS].sort(), c);
    const p = v["--primary"];
    assert.ok(contrastRatio(p, "#ffffff") >= 4.5, `${c} → ${p}: 白い文字(主要ボタン)`);
    for (const bg of ["--primary-light", "--primary-tint", "--primary-select", "--info-bg"]) assert.ok(contrastRatio(p, v[bg]) >= 4.5, `${c} → ${p} on ${bg} ${v[bg]}`);
    for (const k of SUB_THEME_VARS) assert.match(v[k], /^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, 0\.2\))$/, `${c} ${k}: 単色(グラデーションなし)`);
  }
  // もともと十分に濃い色(標準の青・白文字向けの多く)はそのまま
  for (const c of ["#1d4ed8", "#1e3a8a", "#7e22ce", "#be185d", "#b91c1c", "#0f766e", "#0e7490", "#475569"]) assert.equal(readablePrimary(c), c);
  // 明るい色は色合い(色相)を保って濃くする(黒を混ぜてくすませない)。例: 明るい青 → 濃い青、明るいピンク → 濃いピンク
  const hue = (hex) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); return [r, g, b].indexOf(Math.max(r, g, b)); };
  for (const c of ["#93c5fd", "#f9a8d4", "#86efac", "#fdba74"]) {
    const p = readablePrimary(c);
    assert.notEqual(p, c);
    assert.equal(hue(p), hue(c), `${c} → ${p}: いちばん強い色の成分が同じ(色合いを保つ)`);
  }
  assert.equal(readablePrimary("x"), null);
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
});

test("サブテーマカラー: 未設定の値は styles.css の従来の値(上書きする変数はすべて :root に既定値がある)。エラー・警告・成功の色は対象外", () => {
  const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  for (const k of SUB_THEME_VARS) assert.match(root, new RegExp(`${k}:\\s*[^;]+;`), `${k} の既定値`);
  assert.match(root, /--primary:\s*#1d4ed8;/);
  for (const k of ["--danger", "--warning", "--success"]) assert.ok(!SUB_THEME_VARS.includes(k), k);
});

test("サブテーマカラー: 反映(<html> の変数を上書き、未設定で外す)と端末の記憶(施設ごと)", () => {
  const props = new Map();
  const root = { style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } };
  applySubTheme({ color: "#93c5fd" }, root);
  assert.equal(props.size, SUB_THEME_VARS.length);
  assert.equal(props.get("--primary"), readablePrimary("#93c5fd"));
  applySubTheme(null, root);
  assert.equal(props.size, 0, "未設定に戻すと上書きを外す(従来の青)");
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  cacheSubTheme("fA", { color: "#be185d" }, storage);
  cacheSubTheme("fB", { color: "#15803d" }, storage);
  assert.deepEqual([cachedSubTheme("fA", storage), cachedSubTheme("fB", storage), cachedSubTheme("fC", storage)], [{ color: "#be185d" }, { color: "#15803d" }, null]);
  cacheSubTheme("fA", null, storage);
  assert.equal(cachedSubTheme("fA", storage), null);
  assert.equal(cachedSubTheme("fA", { getItem: () => { throw new Error("x"); } }), null, "記憶が使えない環境でも動く");
});

test("サブテーマカラー: ディーラー画面(dealer.html・src/dealer)は読み込まない(会社別のテーマカラーと独立。ディーラー画面は従来の青のまま)", () => {
  const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const dealerFiles = fs.readdirSync(new URL("../src/dealer/", import.meta.url)).filter(f => f.endsWith(".js")).map(f => `src/dealer/${f}`);
  // ディーラーの画面のコードは、サブテーマカラーを反映・読み込みしない(色見本の部品が色の検証だけを共有するのは可)
  for (const p of dealerFiles) assert.ok(!/applySubTheme|loadSubTheme|ui\/sub-theme/.test(read(p)), `${p} はサブテーマカラーを反映しない`);
  // dealer.html は import map(全モジュールの版の対応表。読み込みはしない)以外でサブテーマカラーに触れない
  const html = read("dealer.html").replace(/<script type="importmap">[\s\S]*?<\/script>/, "");
  assert.ok(!/sub-theme/.test(html), "dealer.html");
  assert.match(read("src/main.js"), /loadSubTheme\(access\.facilityId, ctx\.repository\)/, "注文画面は施設に入ったときに読み込む");
});
