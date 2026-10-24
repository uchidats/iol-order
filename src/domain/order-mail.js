/**
 * 発注メールの dry-run 生成(プレビュー専用。メールの送信はしない・この関数群に送信処理はない)。
 *
 * 1回の注文を、明細の発注先ディーラーごとに振り分けて、メールの 件名・本文・宛先(発注用メールだけ)を作る。
 *  - 宛先は、生成時点の施設のディーラー設定の「発注用メール(orderEmails)」だけ。使用報告用メール(usageReportEmails)は使わない。
 *  - 発注時に保存した dispatch.allowed は参考情報。生成時点のディーラー設定(存在・発注用メール)を改めて検証する。
 *  - 発注先が未設定の明細は、メールにしない(blocked: dealer-unset)。
 *
 * 形式(件名・宛名・本文・署名)は「メール形式の設定(profile。order-mail-profiles.js)」で決まる。
 *  - 立川病院: 現行 Google Forms + GAS の形式を再現(件名固定・「質問名: 回答」の列挙・定型文・署名)。
 *  - 設定のない施設: 暫定の下書き(draft-unconfirmed)。実送信には使えない。
 * 宛先は3種類の別の概念: ①ディーラー(発注用メール) ②固定の確認先(設定から渡す。コードに書かない) ③発注者(ログインしたユーザー)。
 * すべて To に指定し、CC・BCC は使わない(常に空)。①が1件もなければ、②③があっても送信不可。担当医への確認メールは対象外。
 */
import { GENERIC_DRAFT_PROFILE } from "./order-mail-profiles.js";
import { orderLinesOf, describeLine, formatDateTimeJst, orderedByLabel } from "./order-history.js";
import { isValidEmail } from "./order-validation.js";

export const TEMPLATE_STATUS = "draft-unconfirmed"; // 現行GASの形式が未確認の暫定テンプレート(正式版として扱わない)

/** 形式が、現行GASの形式で確認済みか。**false の間は、実送信の処理から使ってはいけない**(引数なし・暫定の既定は false) */
export const isTemplateConfirmed = (profile = GENERIC_DRAFT_PROFILE) => Boolean(profile && profile.confirmed === true);

const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim(); // 件名・宛先にヘッダー注入(改行)を入れない

/** 件名(暫定): 【IOL発注】施設名 注文番号(ディーラー名宛 n件・合計m枚) */
export function buildSubject({ facilityName, orderNumber, dealerName, lineCount, totalQuantity }) {
  return oneLine(`【IOL発注】${facilityName} ${orderNumber}(${dealerName}宛 ${lineCount}件・合計${totalQuantity}枚)`);
}

/** 本文(暫定)。患者情報は含めない。備考は注文時に入力された自由記述をそのまま載せる */
export function buildBody({ facilityName, orderNumber, orderedAtLabel, orderedBy, dealerName, lines, totalQuantity, notes }) {
  const rows = lines.map(l => [
    `[レンズ${l.lineNo}] ${l.maker} ${l.model}${l.isToric ? "(トーリック)" : ""}${l.isMultifocal ? "(多焦点)" : ""} ${l.power} ${l.quantity}枚`,
    `    手術日: ${l.surgeryDate}  担当医: ${l.doctorName}`
  ].join("\n"));
  return [
    `${dealerName} 御中`,
    "",
    "下記のIOLを発注します。",
    "",
    `施設: ${facilityName}`,
    `注文番号: ${orderNumber}`,
    `注文日時: ${orderedAtLabel}`,
    `発注者: ${orderedBy}`,
    "",
    ...rows,
    "",
    `合計: ${lines.length}件・合計${totalQuantity}枚`,
    `備考: ${notes ? String(notes).trim() : "（なし）"}`
  ].join("\n");
}

/** 現行GAS形式の本文: Google Forms の質問名と回答を入力順に「質問名: 回答」で列挙し、定型文・署名を付ける。複数レンズはレンズごとに1ブロック */
export function buildGasStyleBody({ dealerName, lines, ordererName, ordererEmail, notes, profile }) {
  const out = [`${dealerName}${profile.salutationSuffix}`, ""];
  for (const l of lines) {
    out.push(`レンズ${l.lineNo}`, `メーカー名 / IOLモデル: ${l.displayName}`);
    if (l.toricModel) out.push(`トーリックの場合は型番を選択: ${l.toricModel}`);
    out.push(`IOLパワー (ディオプター): ${l.power}`, `枚数: ${l.quantity} 枚`, `手術日: ${l.surgeryDate}`, `担当医: ${l.doctorName}`, "");
  }
  // 発注者(Googleログイン情報)は、明細ごとの担当医とは別の項目。備考は省略・要約・整形せず、改行を含めてそのまま載せる
  out.push(`発注者: ${ordererName}`, `メールアドレス: ${ordererEmail || "（なし）"}`, `備考: ${typeof notes === "string" && notes.trim() ? notes : ""}`, "");
  out.push(...profile.closing, "", ...profile.signature);
  return out.join("\n");
}

/** 確認先・発注者などの宛先を整理する(小文字・重複・不正な形式を除く) */
export function cleanEmails(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    const v = oneLine(e).toLowerCase();
    if (v && isValidEmail(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** 発注用メールの一覧(重複・不正な形式を除く)。使用報告用メールは見ない */
export function orderRecipients(dealerSetting) {
  const list = Array.isArray(dealerSetting && dealerSetting.orderEmails) ? dealerSetting.orderEmails : [];
  const out = [];
  for (const e of list) {
    const v = oneLine(e).toLowerCase();
    if (v && isValidEmail(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * @param {object} order 保存された注文(新旧どちらの形式でも可)
 * @param {{facilityName?:string, dealers: Record<string,{name?:string, orderEmails?:string[], usageReportEmails?:string[]}>}} ctx
 *        dealers: 生成時点の施設のディーラー設定(キーは facilityDealers のID)
 * @returns {{templateStatus:string, orderNumber:string, mails:Array<object>, unrouted:Array<object>, allReady:boolean}}
 */
export function buildOrderMailPreview(order, { facilityName = order.facilityName || "", dealers = {}, profile = GENERIC_DRAFT_PROFILE, confirmationEmails = [] } = {}) {
  const lines = orderLinesOf(order).map((l, i) => ({ raw: l, view: describeLine(l, i) }));
  const orderNumber = order.orderNumber || "";
  const groups = new Map();   // dealerId → 明細
  const unrouted = [];
  for (const l of lines) {
    const dealerId = (l.raw.dealer && l.raw.dealer.id) || l.raw.dealerId || null;
    if (!dealerId) { unrouted.push({ lineNo: l.view.lineNo, reason: "dealer-unset" }); continue; }
    if (!groups.has(dealerId)) groups.set(dealerId, []);
    groups.get(dealerId).push(l);
  }
  const mails = [...groups.entries()].map(([dealerId, ls]) => {
    const current = dealers[dealerId] || null;
    const snapshotName = ls[0].raw.dealer && ls[0].raw.dealer.name;
    const registeredName = oneLine((current && current.name) || snapshotName || "");
    const formalName = oneLine(profile.dealerDisplayNames && profile.dealerDisplayNames[dealerId]);   // 宛名の正式表記(あれば登録名より優先)
    const dealerName = formalName || registeredName;
    const dealerTo = current ? orderRecipients(current) : [];   // ① ディーラーの発注用メール
    const confirmTo = cleanEmails(confirmationEmails);            // ② 固定の確認先(設定から渡す。コードに固定しない)
    const ordererEmail = oneLine(order.createdBy && order.createdBy.email).toLowerCase();
    const ordererTo = profile.sendToOrderer ? cleanEmails([ordererEmail]) : [];   // ③ 発注者(サーバーが記録したログイン情報)
    const warnings = [];
    let blocked = null;
    if (!current) blocked = "dealer-deleted";               // 発注後にディーラーが削除された
    else if (!dealerTo.length) blocked = "no-order-email";        // 発注用メールがない(使用報告用だけの場合を含む)
    if (formalName && formalName !== registeredName) warnings.push(`宛名は正式表記「${formalName}」を使用しています(登録名は「${registeredName}」。登録データは未変更)`);
    if (current && snapshotName && current.name && snapshotName !== current.name) warnings.push(`発注時のディーラー名「${snapshotName}」から「${current.name}」に変更されています`);
    // 発注時の判定(参考)と、生成時点の判定が食い違うとき
    const snapAllowed = ls.every(l => !l.raw.dispatch || l.raw.dispatch.allowed === true);
    if (!blocked && !snapAllowed) warnings.push("発注時は送信不可と判定された明細を含みます(その後ディーラー設定が変わりました)");
    if (blocked && snapAllowed && ls.some(l => l.raw.dispatch)) warnings.push("発注時は送信可と判定されましたが、現在のディーラー設定では送信できません");
    const lineViews = ls.map(l => l.view);
    const totalQuantity = lineViews.reduce((s, l) => s + l.quantity, 0);
    if (profile.sendToOrderer && !ordererTo.length) warnings.push("発注者のメールアドレスが記録されていないため、発注者宛の確認は含まれません");
    if (profile.format === "gas-questions" && !profile.signatureConfigured) warnings.push("この施設の住所・署名が設定されていないため、署名なしで生成しています");
    const gas = profile.format === "gas-questions";
    const subject = gas ? oneLine(profile.subjectTemplate.replace("{facility}", oneLine(facilityName))) : buildSubject({ facilityName, orderNumber, dealerName, lineCount: lineViews.length, totalQuantity });
    const body = gas ? buildGasStyleBody({ dealerName, lines: lineViews, ordererName: orderedByLabel(order), ordererEmail: ordererTo[0] || ordererEmail, notes: order.notes, profile }) : buildBody({
      facilityName, orderNumber, orderedAtLabel: formatDateTimeJst(order.createdAt), orderedBy: orderedByLabel(order),
      dealerName, lines: lineViews, totalQuantity, notes: order.notes
    });
    // 備考は注文時の自由記述。実送信の前に人が内容を確認できるよう、本文とは別にも返す(reviewRequired: 実送信の前に必ず確認する)
    const to = blocked ? [] : [...new Set([...dealerTo, ...confirmTo, ...ordererTo])];   // すべて To。CC・BCC は使わない
    return { dealerId, dealerName, templateStatus: profile.confirmed ? "gas-compatible" : TEMPLATE_STATUS, profileId: profile.id, reviewRequired: true, notes: typeof order.notes === "string" && order.notes.trim() ? order.notes : "", status: blocked ? "blocked" : "ready", blockedReason: blocked, to, cc: [], bcc: [], recipients: blocked ? { dealer: [], confirmation: [], orderer: [] } : { dealer: dealerTo, confirmation: confirmTo, orderer: ordererTo }, subject, body, lineNos: lineViews.map(l => l.lineNo), totalQuantity, warnings };
  });
  return { templateStatus: profile.confirmed ? "gas-compatible" : TEMPLATE_STATUS, profileId: profile.id, orderNumber, mails, unrouted, allReady: mails.length > 0 && unrouted.length === 0 && mails.every(m => m.status === "ready") };
}
