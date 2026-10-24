import test from "node:test";
import assert from "node:assert/strict";
import { buildOrderMailPreview, orderRecipients, buildSubject, TEMPLATE_STATUS, isTemplateConfirmed } from "../src/domain/order-mail.js";

const item = (over = {}) => ({ manufacturer: "J&J", model: "DIB00V", displayName: "J&J / DIB00V", isToric: false, isMultifocal: false, toricModel: "", power: "+20.0D", quantity: 1, ...over });
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });
const line = (n, dealer, over = {}) => ({
  lineNo: n, item: item(over.item), surgeryDate: over.surgeryDate || "2026-11-10", doctor: { id: "o1", name: over.doctor || "山田" },
  dealerId: dealer ? dealer.id : null, dealer, dispatch: over.dispatch || { allowed: Boolean(dealer), reason: dealer ? null : "dealer-unset" }
});
const A = { id: "dA", name: "A商会" }, B = { id: "dB", name: "B医療" };
const order = (lines, over = {}) => ({
  id: "x", orderNumber: "IOL-20261025-0001", facilityName: "テスト眼科", createdAt: ts("2026-10-25T05:30:00Z"),
  createdBy: { email: "login@example.jp", displayName: "ログイン太郎" }, notes: "備考テキスト", lines, ...over
});
const settings = {
  dA: { name: "A商会", orderEmails: ["order-a@example.jp"], usageReportEmails: ["report-a@example.jp"] },
  dB: { name: "B医療", orderEmails: ["order-b1@example.jp", "ORDER-B2@example.jp"], usageReportEmails: ["report-b@example.jp"] }
};

test("複数ディーラー: 明細をディーラーごとに振り分け、ディーラーごとに1通。担当医・手術日が違う明細も対応付く", () => {
  const p = buildOrderMailPreview(order([
    line(1, A), line(2, B, { doctor: "佐藤", surgeryDate: "2026-11-12", item: { quantity: 2, power: "+18.5D" } }), line(3, A, { surgeryDate: "2026-11-20" })
  ]), { dealers: settings });
  assert.equal(p.templateStatus, TEMPLATE_STATUS);
  assert.deepEqual(p.mails.map(m => [m.dealerId, m.lineNos, m.totalQuantity, m.status]), [["dA", [1, 3], 2, "ready"], ["dB", [2], 2, "ready"]]);
  assert.equal(p.allReady, true);
  assert.deepEqual(p.mails[0].to, ["order-a@example.jp"]);
  assert.match(p.mails[0].subject, /テスト眼科.*IOL-20261025-0001.*A商会宛 2件・合計2枚/);
  assert.match(p.mails[0].body, /\[レンズ1\] J&J DIB00V \+20\.0D 1枚\n\s+手術日: 2026-11-10 {2}担当医: 山田/);
  assert.match(p.mails[0].body, /\[レンズ3\].*\n\s+手術日: 2026-11-20/);
  assert.ok(!p.mails[0].body.includes("レンズ2"), "他のディーラーの明細は含めない");
  assert.match(p.mails[1].body, /\[レンズ2\] J&J DIB00V \+18\.5D 2枚\n\s+手術日: 2026-11-12 {2}担当医: 佐藤/);
  assert.match(p.mails[0].body, /発注者: ログイン太郎/);
  assert.match(p.mails[0].body, /備考: 備考テキスト/);
});

test("宛先は発注用メールだけ。使用報告用メールは宛先にも本文にも出ない。重複・大文字小文字・不正な形式を整理", () => {
  const p = buildOrderMailPreview(order([line(1, B)]), { dealers: settings });
  assert.deepEqual(p.mails[0].to, ["order-b1@example.jp", "order-b2@example.jp"]);
  assert.ok(!JSON.stringify(p).includes("report-b@example.jp"));
  assert.deepEqual(orderRecipients({ orderEmails: ["a@example.jp", "A@example.jp", "bad", "", "x@y", null], usageReportEmails: ["u@example.jp"] }), ["a@example.jp"]);
  assert.deepEqual(orderRecipients({ usageReportEmails: ["u@example.jp"] }), [], "使用報告用だけでは宛先にならない");
  assert.deepEqual(orderRecipients(null), []);
});

test("生成時点の検証: 発注先が削除済み・発注用メール未登録は送信不可(宛先なし)。他のディーラーの分は生成できる", () => {
  const p = buildOrderMailPreview(order([line(1, A), line(2, B)]), { dealers: { dA: { name: "A商会", usageReportEmails: ["report-a@example.jp"] } } });
  assert.deepEqual(p.mails.map(m => [m.dealerId, m.status, m.blockedReason, m.to]), [["dA", "blocked", "no-order-email", []], ["dB", "blocked", "dealer-deleted", []]]);
  assert.equal(p.allReady, false);
  const mixed = buildOrderMailPreview(order([line(1, A), line(2, B)]), { dealers: { dA: settings.dA } });
  assert.deepEqual(mixed.mails.map(m => m.status), ["ready", "blocked"]);
  assert.equal(mixed.allReady, false, "1通でも送れなければ、注文全体は ready にしない");
});

test("dispatch.allowed は参考情報: 発注時と現在の設定が食い違うと警告を出し、判定は現在の設定で行う", () => {
  const stale = line(1, A, { dispatch: { allowed: false, reason: "no-order-email" } });   // 発注時は送れなかったが、その後メールが登録された
  const p1 = buildOrderMailPreview(order([stale]), { dealers: settings });
  assert.equal(p1.mails[0].status, "ready");
  assert.match(p1.mails[0].warnings.join("\n"), /発注時は送信不可/);
  const ok = line(1, A);                                                                    // 発注時は送れたが、その後メールが消えた
  const p2 = buildOrderMailPreview(order([ok]), { dealers: { dA: { name: "A商会", orderEmails: [] } } });
  assert.equal(p2.mails[0].status, "blocked");
  assert.match(p2.mails[0].warnings.join("\n"), /発注時は送信可/);
  const renamed = buildOrderMailPreview(order([line(1, A)]), { dealers: { dA: { ...settings.dA, name: "新A商会" } } });
  assert.match(renamed.mails[0].warnings.join("\n"), /A商会.*新A商会/);
  assert.match(renamed.mails[0].subject, /新A商会宛/, "宛名は現在の名称");
});

test("発注先未設定の明細はメールにしない(unrouted)。旧形式の注文(発注先の記録なし)は送信対象にならない", () => {
  const p = buildOrderMailPreview(order([line(1, A), line(2, null)]), { dealers: settings });
  assert.deepEqual(p.unrouted, [{ lineNo: 2, reason: "dealer-unset" }]);
  assert.deepEqual(p.mails.map(m => m.lineNos), [[1]]);
  assert.equal(p.allReady, false, "未設定の明細が残る注文は ready にしない");
  const legacy = buildOrderMailPreview({ id: "o", orderNumber: "IOL-1", createdAt: ts("2026-08-01T00:00:00Z"), item: item(), surgeryDate: "2026-09-01", orderer: { name: "最古" } }, { dealers: settings });
  assert.deepEqual([legacy.mails.length, legacy.unrouted.length, legacy.allReady], [0, 1, false]);
});

test("件名・宛先に改行を入れさせない(ヘッダー注入の防止)", () => {
  assert.ok(!/[\r\n]/.test(buildSubject({ facilityName: "A\r\nBcc: evil@example.jp", orderNumber: "1", dealerName: "B\nC", lineCount: 1, totalQuantity: 1 })));
  const p = buildOrderMailPreview(order([line(1, A)]), { facilityName: "眼科\nBcc: evil@example.jp", dealers: { dA: { name: "A商会\nX", orderEmails: ["ok@example.jp", "evil@example.jp\nBcc: z@example.jp"] } } });
  assert.ok(!/[\r\n]/.test(p.mails[0].subject));
  assert.deepEqual(p.mails[0].to, ["ok@example.jp"]);
});

test("トーリック・多焦点の表記と合計。メール送信の関数は存在しない(プレビューのみ)", async () => {
  const p = buildOrderMailPreview(order([line(1, A, { item: { isToric: true, toricModel: "DIW300", model: "DIWxxx", displayName: "J&J / DIWxxx (トーリック)" } })]), { dealers: settings });
  assert.match(p.mails[0].body, /DIW300\(トーリック\)/);
  const mod = await import("../src/domain/order-mail.js");
  assert.ok(!Object.keys(mod).some(k => /send|smtp|post/i.test(k)));
});

test("暫定テンプレートは正式版として扱わない: 各メールに draft-unconfirmed と reviewRequired が付き、備考は本文とは別にも返す。確認済みフラグは false", () => {
  const p = buildOrderMailPreview(order([line(1, A)], { notes: "  備考テキスト  " }), { dealers: settings });
  assert.equal(p.templateStatus, "draft-unconfirmed");
  assert.deepEqual([p.mails[0].templateStatus, p.mails[0].reviewRequired, p.mails[0].notes], ["draft-unconfirmed", true, "  備考テキスト  "]);   // 備考は整形しない
  assert.equal(isTemplateConfirmed(), false, "確認済みになるまで、実送信の処理から使ってはいけない");
});

// ================= 現行GAS(立川病院)形式の再現 =================
import { TACHIKAWA_GAS_PROFILE, GENERIC_DRAFT_PROFILE, DEFAULT_GAS_PROFILE, createGasProfile, resolveMailProfile } from "../src/domain/order-mail-profiles.js";

const KURIHARA = { id: "dK", name: "栗原医療器械店" };
const gasSettings = { dK: { name: "栗原医療器械店", orderEmails: ["kurihara-order@example.jp"], usageReportEmails: ["kurihara-report@example.jp"] } };
const gasOpts = { profile: TACHIKAWA_GAS_PROFILE, confirmationEmails: ["confirm@example.jp"], dealers: gasSettings, facilityName: "立川病院" };

test("GAS形式: 件名は「【施設名】IOL注文：…」、宛名は「ディーラー名御中」、本文は「質問名: 回答」を入力順に列挙し、定型文と署名で終わる", () => {
  const p = buildOrderMailPreview(order([
    line(1, KURIHARA, { item: { displayName: "ALCON / CNA0T0", manufacturer: "ALCON", model: "CNA0T0", power: "+18.0D" } }),
    line(2, KURIHARA, { item: { displayName: "J&J / DIWxxx (トーリック)", isToric: true, toricModel: "DIW300", power: "+18.5D", quantity: 2 }, doctor: "佐藤", surgeryDate: "2026-11-12" })
  ], { notes: "備考テキスト" }), gasOpts);
  assert.equal(p.templateStatus, "gas-compatible");
  const m = p.mails[0];
  assert.equal(m.subject, "【立川病院】IOL注文：ご確認のほどよろしくお願いします");
  assert.equal(m.body, [
    "栗原医療器械店御中",
    "",
    "レンズ1",
    "メーカー名 / IOLモデル: ALCON / CNA0T0",
    "IOLパワー (ディオプター): +18.0D",
    "枚数: 1 枚",
    "手術日: 2026-11-10",
    "担当医: 山田",
    "",
    "レンズ2",
    "メーカー名 / IOLモデル: J&J / DIWxxx (トーリック)",
    "トーリックの場合は型番を選択: DIW300",
    "IOLパワー (ディオプター): +18.5D",
    "枚数: 2 枚",
    "手術日: 2026-11-12",
    "担当医: 佐藤",
    "",
    "発注者: ログイン太郎",
    "メールアドレス: login@example.jp",
    "備考: 備考テキスト",
    "",
    "大変お世話になっております。",
    "上記の眼内レンズを注文させていただきたく存じます。",
    "お忙しいところ大変恐縮ですが、何卒よろしくお願い申し上げます。",
    "",
    "〒190-8531 東京都立川市錦町4-2-22",
    "国家公務員共済組合連合会　立川病院　眼科"
  ].join("\n"));
});

test("GAS形式の宛先: ディーラーの発注用 + 固定の確認先 + 発注者 をすべて To に。CC・BCC は使わない。使用報告用メールは入らない", () => {
  const m = buildOrderMailPreview(order([line(1, KURIHARA)]), gasOpts).mails[0];
  assert.deepEqual(m.to, ["kurihara-order@example.jp", "confirm@example.jp", "login@example.jp"]);
  assert.deepEqual(m.recipients, { dealer: ["kurihara-order@example.jp"], confirmation: ["confirm@example.jp"], orderer: ["login@example.jp"] });
  assert.deepEqual([m.cc, m.bcc], [[], []]);
  assert.ok(!JSON.stringify(m).includes("kurihara-report@example.jp"));
  // 重複する宛先は1つにまとめる(発注者が確認先と同じ場合など)
  const dup = buildOrderMailPreview(order([line(1, KURIHARA)], { createdBy: { email: "CONFIRM@example.jp", displayName: "x" } }), gasOpts).mails[0];
  assert.deepEqual(dup.to, ["kurihara-order@example.jp", "confirm@example.jp"]);
});

test("確認先・発注者は、ディーラー宛とは別の概念: ディーラーの発注用メールがなければ、確認先・発注者がいても送信不可(宛先なし)", () => {
  const p = buildOrderMailPreview(order([line(1, KURIHARA)]), { ...gasOpts, dealers: { dK: { name: "栗原医療器械店", usageReportEmails: ["kurihara-report@example.jp"] } } });
  assert.deepEqual([p.mails[0].status, p.mails[0].blockedReason, p.mails[0].to], ["blocked", "no-order-email", []]);
  assert.equal(p.allReady, false);
  // 確認先が未設定でも、ディーラー宛と発注者宛は生成できる(確認先はコードに固定しない)
  const noConfirm = buildOrderMailPreview(order([line(1, KURIHARA)]), { ...gasOpts, confirmationEmails: [] }).mails[0];
  assert.deepEqual(noConfirm.to, ["kurihara-order@example.jp", "login@example.jp"]);
});

test("GAS形式: 発注者のメールが記録されていない場合は警告。複数ディーラーの注文は、ディーラーごとに同じ件名・別の宛名と明細", () => {
  const p = buildOrderMailPreview(order([line(1, KURIHARA), line(2, B)], { createdBy: { displayName: "メールなし" } }),
    { ...gasOpts, dealers: { ...gasSettings, dB: settings.dB } });
  assert.deepEqual(p.mails.map(m => m.subject), Array(2).fill("【立川病院】IOL注文：ご確認のほどよろしくお願いします"));
  assert.ok(p.mails[0].body.startsWith("栗原医療器械店御中") && p.mails[1].body.startsWith("B医療御中"));
  assert.ok(p.mails[0].body.includes("レンズ1") && !p.mails[0].body.includes("レンズ2"));
  assert.match(p.mails[0].warnings.join("\n"), /発注者のメールアドレスが記録されていない/);
  assert.deepEqual(p.mails[1].recipients.orderer, []);
});

test("形式は施設ごと: 立川病院の署名は立川病院だけ。他の施設は署名なしのGAS形式。形式の定義にメールアドレスは含まれない", () => {
  assert.equal(resolveMailProfile("tachikawa-hospital"), TACHIKAWA_GAS_PROFILE);
  assert.equal(resolveMailProfile("other-facility"), DEFAULT_GAS_PROFILE);
  assert.deepEqual(DEFAULT_GAS_PROFILE.signature, []);
  assert.equal(isTemplateConfirmed(TACHIKAWA_GAS_PROFILE), true);
  assert.equal(isTemplateConfirmed(GENERIC_DRAFT_PROFILE), false);
  assert.equal(isTemplateConfirmed(), false);
  assert.ok(!/@/.test(JSON.stringify(TACHIKAWA_GAS_PROFILE)), "no e-mail address in the profile");
  // 暫定形式は従来どおり(確認先・発注者は宛先に入らない)
  const g = buildOrderMailPreview(order([line(1, A)]), { dealers: settings, confirmationEmails: ["confirm@example.jp"] }).mails[0];
  assert.deepEqual(g.to, ["order-a@example.jp", "confirm@example.jp"]);
  assert.equal(g.templateStatus, "draft-unconfirmed");
});

test("他の施設: 件名は自施設名、立川病院の住所・署名は出ない(署名未設定の警告)。施設ごとの署名を設定できる", () => {
  const other = buildOrderMailPreview(order([line(1, A)]), { dealers: settings, facilityName: "みどり眼科", profile: resolveMailProfile("fac-other") }).mails[0];
  assert.equal(other.subject, "【みどり眼科】IOL注文：ご確認のほどよろしくお願いします");
  assert.ok(other.body.startsWith("A商会御中"));
  assert.ok(other.body.includes("上記の眼内レンズを注文させていただきたく存じます。"));
  assert.ok(!other.body.includes("立川") && !other.body.includes("190-8531"));
  assert.match(other.warnings.join("\n"), /署名が設定されていない/);
  const own = createGasProfile({ id: "x", signature: ["〒100-0001 東京都千代田区1-1", "みどり眼科"] });
  const m = buildOrderMailPreview(order([line(1, A)]), { dealers: settings, facilityName: "みどり眼科", profile: own }).mails[0];
  assert.ok(m.body.endsWith("〒100-0001 東京都千代田区1-1\nみどり眼科"));
  assert.deepEqual(m.warnings, []);
});

test("備考は省略・要約・整形せず、改行を含めて正確に本文へ。空白だけ・未入力は空欄。発注者は担当医と別の項目", () => {
  const notes = "右眼 白内障手術用\n\n  2行目(先頭に空白)\n3行目: 「特記」&<>";
  const m = buildOrderMailPreview(order([line(1, KURIHARA)], { notes }), gasOpts).mails[0];
  assert.ok(m.body.includes("備考: " + notes + "\n"), "備考が一字一句そのまま(改行・空行・空白を含む)");
  assert.equal(m.notes, notes);
  const lines = m.body.split("\n");
  assert.ok(lines.indexOf("担当医: 山田") >= 0 && lines.indexOf("発注者: ログイン太郎") > lines.indexOf("担当医: 山田"));
  for (const empty of ["", "   ", undefined]) assert.ok(buildOrderMailPreview(order([line(1, KURIHARA)], { notes: empty }), gasOpts).mails[0].body.includes("\n備考: \n"));
});

test("トーリック型番は該当する明細だけ表示(空欄の項目は出さない)", () => {
  const m = buildOrderMailPreview(order([line(1, KURIHARA), line(2, KURIHARA, { item: { isToric: true, toricModel: "DIW300" } })]), gasOpts).mails[0];
  assert.equal(m.body.split("トーリックの場合は型番を選択").length - 1, 1);
  assert.ok(m.body.includes("トーリックの場合は型番を選択: DIW300"));
});

// ================= 立川病院の実際のID・正式表記・本文の欠落/混入 =================
test("立川病院: 実際の施設ID(tachikawa-hospital)とディーラーID(登録データ)に紐付く。宛名は正式表記「栗原医療器械店」(登録名「機械」は変更しない)", () => {
  const profile = resolveMailProfile("tachikawa-hospital");
  assert.equal(profile, TACHIKAWA_GAS_PROFILE);
  const REAL_DEALER = { id: "1Fc1MIFpWjR6bwjuG1sS", name: "栗原医療機械店" };   // Firestore の登録(読み取りで確認した値)
  const p = buildOrderMailPreview(order([line(1, REAL_DEALER)]), {
    facilityName: "立川病院", profile, confirmationEmails: ["confirm@example.jp"],
    dealers: { [REAL_DEALER.id]: { name: "栗原医療機械店", orderEmails: ["kurihara@example.jp"] } }
  });
  const m = p.mails[0];
  assert.equal(m.subject, "【立川病院】IOL注文：ご確認のほどよろしくお願いします");
  assert.ok(m.body.startsWith("栗原医療器械店御中\n"), "宛名は正式表記");
  assert.ok(!m.body.includes("栗原医療機械店"), "登録名の表記は本文に出ない");
  assert.match(m.warnings.join("\n"), /正式表記「栗原医療器械店」.*登録名は「栗原医療機械店」.*未変更/);
  assert.equal(m.dealerName, "栗原医療器械店");
  assert.equal(m.status, "ready");
  // 他の施設・他のディーラーには、立川病院の署名も正式表記も使われない
  const other = buildOrderMailPreview(order([line(1, { id: "x1", name: "別商会" })]), { facilityName: "別眼科", profile: resolveMailProfile("fac-other"), dealers: { x1: { name: "別商会", orderEmails: ["o@example.jp"] } } }).mails[0];
  assert.ok(other.body.startsWith("別商会御中") && !other.body.includes("立川") && !other.body.includes("器械"));
});

test("本文に必要な情報の欠落がない: 全明細の モデル・パワー・枚数・手術日・担当医、発注者、メールアドレス、備考、定型文、署名。「undefined」「null」が出ない", () => {
  const lines = [
    line(1, KURIHARA, { item: { displayName: "ALCON / CNA0T0", power: "+18.0D", quantity: 1 }, doctor: "山田", surgeryDate: "2026-11-10" }),
    line(2, KURIHARA, { item: { displayName: "J&J / DIWxxx (トーリック)", isToric: true, toricModel: "DIW300", power: "+18.5D", quantity: 2 }, doctor: "佐藤", surgeryDate: "2026-11-12" }),
    line(3, KURIHARA, { item: { displayName: "HOYA / XY1", power: "-5.0D", quantity: 1 }, doctor: "鈴木", surgeryDate: "2026-12-01" })
  ];
  const m = buildOrderMailPreview(order(lines, { notes: "備考あり" }), gasOpts).mails[0];
  const blocks = m.body.split("\n\n");
  for (const [n, model, power, qty, date, doctor] of [[1, "ALCON / CNA0T0", "+18.0D", 1, "2026-11-10", "山田"], [2, "J&J / DIWxxx (トーリック)", "+18.5D", 2, "2026-11-12", "佐藤"], [3, "HOYA / XY1", "-5.0D", 1, "2026-12-01", "鈴木"]]) {
    const b = blocks.find(x => x.startsWith(`レンズ${n}\n`));
    assert.ok(b, `レンズ${n}のブロックがある`);
    for (const need of [`メーカー名 / IOLモデル: ${model}`, `IOLパワー (ディオプター): ${power}`, `枚数: ${qty} 枚`, `手術日: ${date}`, `担当医: ${doctor}`]) assert.ok(b.includes(need), `${n}: ${need}`);
  }
  for (const need of ["発注者: ログイン太郎", "メールアドレス: login@example.jp", "備考: 備考あり", "大変お世話になっております。", "何卒よろしくお願い申し上げます。", "国家公務員共済組合連合会　立川病院　眼科"]) assert.ok(m.body.includes(need), need);
  assert.ok(!/undefined|null|\[object|NaN/.test(m.body + m.subject), "未定義値が本文・件名に出ない");
  assert.equal(m.totalQuantity, 4);
});

test("複数ディーラー: 明細・宛先が他のディーラーのメールに混入しない(3社・6明細)", () => {
  const D = ["dX", "dY", "dZ"].map((id, i) => ({ id, name: `商会${"XYZ"[i]}` }));
  const set = Object.fromEntries(D.map((d, i) => [d.id, { name: d.name, orderEmails: [`order-${"xyz"[i]}@example.jp`], usageReportEmails: [`report-${"xyz"[i]}@example.jp`] }]));
  const mk = (n, d, power, doctor, date) => line(n, d, { item: { power, quantity: 1 }, doctor, surgeryDate: date });
  const p = buildOrderMailPreview(order([
    mk(1, D[0], "+10.0D", "医師一", "2026-11-01"), mk(2, D[1], "+11.0D", "医師二", "2026-11-02"), mk(3, D[2], "+12.0D", "医師三", "2026-11-03"),
    mk(4, D[0], "+13.0D", "医師四", "2026-11-04"), mk(5, D[1], "+14.0D", "医師五", "2026-11-05"), mk(6, D[2], "+15.0D", "医師六", "2026-11-06")
  ]), { profile: resolveMailProfile("fac-other"), facilityName: "テスト眼科", dealers: set, confirmationEmails: ["confirm@example.jp"] });
  assert.equal(p.mails.length, 3);
  const mine = { dX: [1, 4], dY: [2, 5], dZ: [3, 6] };
  const marks = { 1: ["+10.0D", "医師一", "2026-11-01"], 2: ["+11.0D", "医師二", "2026-11-02"], 3: ["+12.0D", "医師三", "2026-11-03"], 4: ["+13.0D", "医師四", "2026-11-04"], 5: ["+14.0D", "医師五", "2026-11-05"], 6: ["+15.0D", "医師六", "2026-11-06"] };
  for (const m of p.mails) {
    assert.deepEqual(m.lineNos, mine[m.dealerId]);
    for (let n = 1; n <= 6; n++) for (const mark of marks[n]) assert.equal(m.body.includes(mark), mine[m.dealerId].includes(n), `${m.dealerId} / レンズ${n} / ${mark}`);
    assert.ok(m.body.startsWith(`${m.dealerName}御中`));
    // 宛先: 自社の発注用メール + 確認先 + 発注者のみ。他社の発注用・どの使用報告用も入らない
    const own = `order-${m.dealerId.slice(1).toLowerCase()}@example.jp`;
    assert.deepEqual(m.to, [own, "confirm@example.jp", "login@example.jp"]);
    assert.ok(!JSON.stringify(m).includes("report-"), "使用報告用メールは出ない");
    assert.equal(m.totalQuantity, 2);
  }
});
