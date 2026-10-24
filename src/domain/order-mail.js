/**
 * 発注メールの dry-run 生成(プレビュー専用。メールの送信はしない・この関数群に送信処理はない)。
 *
 * 1回の注文を、明細の発注先ディーラーごとに振り分けて、メールの 件名・本文・宛先(発注用メールだけ)を作る。
 *  - 宛先は、生成時点の施設のディーラー設定の「発注用メール(orderEmails)」だけ。使用報告用メール(usageReportEmails)は使わない。
 *  - 発注時に保存した dispatch.allowed は参考情報。生成時点のディーラー設定(存在・発注用メール)を改めて検証する。
 *  - 発注先が未設定の明細は、メールにしない(blocked: dealer-unset)。
 *
 * 【未確定】現行 Google Forms + GAS が送っているメールの件名・本文の形式は、このリポジトリの資料・コードには無い
 * (GAS側のコードは管理外)。ここでの件名・本文は暫定の下書き(TEMPLATE_STATUS)。形式が確定したら、
 * buildSubject / buildBody だけを差し替える。宛先の決定・振り分け・検証のロジックは形式に依存しない。
 */
import { orderLinesOf, describeLine, formatDateTimeJst, orderedByLabel } from "./order-history.js";
import { isValidEmail } from "./order-validation.js";

export const TEMPLATE_STATUS = "draft-unconfirmed"; // 現行GASの形式が未確認の暫定テンプレート(正式版として扱わない)

/** 件名・本文のテンプレートが、現行GASの形式で確認済みか。**false の間は、実送信の処理から使ってはいけない**(将来の送信処理はここを必ず確認する) */
export const isTemplateConfirmed = () => false;

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
export function buildOrderMailPreview(order, { facilityName = order.facilityName || "", dealers = {} } = {}) {
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
    const dealerName = oneLine((current && current.name) || snapshotName || "");
    const to = current ? orderRecipients(current) : [];
    const warnings = [];
    let blocked = null;
    if (!current) blocked = "dealer-deleted";               // 発注後にディーラーが削除された
    else if (!to.length) blocked = "no-order-email";        // 発注用メールがない(使用報告用だけの場合を含む)
    if (current && snapshotName && current.name && snapshotName !== current.name) warnings.push(`発注時のディーラー名「${snapshotName}」から「${current.name}」に変更されています`);
    // 発注時の判定(参考)と、生成時点の判定が食い違うとき
    const snapAllowed = ls.every(l => !l.raw.dispatch || l.raw.dispatch.allowed === true);
    if (!blocked && !snapAllowed) warnings.push("発注時は送信不可と判定された明細を含みます(その後ディーラー設定が変わりました)");
    if (blocked && snapAllowed && ls.some(l => l.raw.dispatch)) warnings.push("発注時は送信可と判定されましたが、現在のディーラー設定では送信できません");
    const lineViews = ls.map(l => l.view);
    const totalQuantity = lineViews.reduce((s, l) => s + l.quantity, 0);
    const subject = buildSubject({ facilityName, orderNumber, dealerName, lineCount: lineViews.length, totalQuantity });
    const body = buildBody({
      facilityName, orderNumber, orderedAtLabel: formatDateTimeJst(order.createdAt), orderedBy: orderedByLabel(order),
      dealerName, lines: lineViews, totalQuantity, notes: order.notes
    });
    // 備考は注文時の自由記述。実送信の前に人が内容を確認できるよう、本文とは別にも返す(reviewRequired: 実送信の前に必ず確認する)
    return { dealerId, dealerName, templateStatus: TEMPLATE_STATUS, reviewRequired: true, notes: order.notes ? String(order.notes).trim() : "", status: blocked ? "blocked" : "ready", blockedReason: blocked, to: blocked ? [] : to, subject, body, lineNos: lineViews.map(l => l.lineNo), totalQuantity, warnings };
  });
  return { templateStatus: TEMPLATE_STATUS, orderNumber, mails, unrouted, allReady: mails.length > 0 && unrouted.length === 0 && mails.every(m => m.status === "ready") };
}
