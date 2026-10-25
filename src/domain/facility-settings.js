/**
 * 施設設定（担当医・採用IOL・ディーラー）の入力検証と書き込み計画（純粋関数）
 *
 * ここでの検証は画面でのエラー表示用。最終的な強制は Firestore Security Rules（firestore.rules）が行う。
 * 両者の制限値は同じにしてある（変更時は rules とテストも更新すること）。
 */
import { isValidEmail } from "./order-validation.js";
import { MAIL_SETTINGS_LIMITS } from "./order-mail-profiles.js";

export const LIMITS = Object.freeze({
  ordererNameMax: 50,
  dealerNameMax: 100,
  emailMax: 254,
  emailsPerList: 5,
  sortStep: 10
});

const norm = (s) => String(s ?? "").normalize("NFKC").trim();
const keyOf = (s) => norm(s).toLowerCase();

/**
 * メールアドレスの一覧（改行・カンマ・セミコロン・空白区切り）を解析する
 * @returns {{emails:string[], errors:string[]}}
 */
export function parseEmailList(text) {
  const errors = [];
  const emails = [];
  const seen = new Set();
  const tokens = String(text ?? "").split(/[\s,;、，]+/).map(t => t.trim()).filter(Boolean);
  for (const t of tokens) {
    if (t.length > LIMITS.emailMax || !isValidEmail(t)) {
      errors.push(`メールアドレスの形式が正しくありません: ${t.length > 40 ? t.slice(0, 40) + "…" : t}`);
      continue;
    }
    const k = t.toLowerCase();
    if (seen.has(k)) continue; // 重複は1件にまとめる
    seen.add(k);
    emails.push(t);
  }
  if (emails.length > LIMITS.emailsPerList) {
    errors.push(`メールアドレスは${LIMITS.emailsPerList}件までです`);
  }
  return { emails, errors };
}

// ---------- 担当医(旧「注文者」。コレクション名・関数名は互換性のため orderers のまま) ----------
/**
 * @param {Array<{id?:string|null, name:string, email?:string}>} rows 画面の並び順
 */
export function validateOrderers(rows) {
  const errors = [];
  const cleaned = [];
  const names = new Map();
  rows.forEach((r, index) => {
    const name = norm(r.name);
    const email = String(r.email ?? "").trim();
    if (!name) errors.push({ index, field: "name", message: "氏名を入力してください" });
    else if (name.length > LIMITS.ordererNameMax) errors.push({ index, field: "name", message: `氏名は${LIMITS.ordererNameMax}文字までです` });
    else if (names.has(keyOf(name))) errors.push({ index, field: "name", message: `氏名が重複しています: ${name}` });
    else names.set(keyOf(name), index);

    if (email && (email.length > LIMITS.emailMax || !isValidEmail(email))) {
      errors.push({ index, field: "email", message: "メールアドレスの形式が正しくありません" });
    }
    cleaned.push({ id: r.id || null, name, email });
  });
  return { ok: errors.length === 0, errors, cleaned };
}

/** 並び順 = 配列順。変更・新規のみを書き込み対象にする(注文者に有効/無効はない。ドキュメントは name / email / sortOrder だけ) */
export function planOrdererWrites(original, cleaned, facilityId) {
  const byId = new Map(original.map(o => [o.id, o]));
  const writes = [];
  cleaned.forEach((c, i) => {
    const sortOrder = (i + 1) * LIMITS.sortStep;
    const data = { facilityId, name: c.name, sortOrder };
    if (c.email) data.email = c.email;
    const o = c.id ? byId.get(c.id) : null;
    const changed = !o || o.name !== c.name || (o.email || "") !== c.email || o.sortOrder !== sortOrder;
    if (changed) writes.push({ id: c.id, data });
  });
  return writes;
}

// ---------- 採用IOL ----------
/** 共通IOLマスターに存在するIDだけを許可する */
export function validateAdoption(selectedIds, masters) {
  const valid = new Set(masters.map(m => m.id));
  const unknown = [...selectedIds].filter(id => !valid.has(id));
  return { ok: unknown.length === 0, unknown };
}

/**
 * 採用IOLの書き込み計画。ドキュメントIDはマスターID（重複採用を構造的に防ぐ）。
 * 採用解除は削除せず enabled=false にする。既存の dealerId は保持する。
 */
export function planAdoptedWrites(masters, existing, selectedIds, facilityId) {
  const selected = new Set(selectedIds);
  const byId = new Map(existing.map(e => [e.id, e]));
  const writes = [];
  for (const m of masters) {
    const ex = byId.get(m.id);
    const want = selected.has(m.id);
    if ((want && (!ex || !ex.enabled)) || (!want && ex && ex.enabled)) {
      const data = { facilityId, catalogIolId: m.id, enabled: want };
      if (ex && ex.dealerId) data.dealerId = ex.dealerId;
      writes.push({ id: m.id, data });
    }
  }
  return writes;
}

// ---------- ディーラー ----------
/**
 * 発注用メールと使用報告用メールは別々に管理する（送信は未実装）。
 * @param {Array<{id?:string|null, name:string, orderEmailsText:string, usageEmailsText:string}>} rows
 */
export function validateDealers(rows) {
  const errors = [];
  const cleaned = [];
  const names = new Map();
  rows.forEach((r, index) => {
    const name = norm(r.name);
    if (!name) errors.push({ index, field: "name", message: "ディーラー名を入力してください" });
    else if (name.length > LIMITS.dealerNameMax) errors.push({ index, field: "name", message: `ディーラー名は${LIMITS.dealerNameMax}文字までです` });
    else if (names.has(keyOf(name))) errors.push({ index, field: "name", message: `ディーラー名が重複しています: ${name}` });
    else names.set(keyOf(name), index);

    const mailName = norm(r.mailName);   // 注文メールの宛名(正式表記。任意。未入力ならディーラー名)
    if (mailName.length > MAIL_SETTINGS_LIMITS.mailNameMax) errors.push({ index, field: "mailName", message: `メールの宛名は${MAIL_SETTINGS_LIMITS.mailNameMax}文字までです` });

    const order = parseEmailList(r.orderEmailsText);
    const usage = parseEmailList(r.usageEmailsText);
    order.errors.forEach(message => errors.push({ index, field: "orderEmails", message: `発注用: ${message}` }));
    usage.errors.forEach(message => errors.push({ index, field: "usageEmails", message: `使用報告用: ${message}` }));

    cleaned.push({
      id: r.id || null, name, mailName,
      orderEmails: order.emails, usageReportEmails: usage.emails
    });
  });
  return { ok: errors.length === 0, errors, cleaned };
}

const sameList = (a = [], b = []) => a.length === b.length && a.every((v, i) => v === b[i]);

export function planDealerWrites(original, cleaned, facilityId) {
  const byId = new Map(original.map(o => [o.id, o]));
  const writes = [];
  cleaned.forEach((c, i) => {
    const sortOrder = (i + 1) * LIMITS.sortStep;
    const o = c.id ? byId.get(c.id) : null;
    const data = {
      facilityId, name: c.name, sortOrder,
      orderEmails: c.orderEmails, usageReportEmails: c.usageReportEmails
    };
    if (o && o.dealerId) data.dealerId = o.dealerId; // 将来のグローバルディーラー連携用IDは保持
    if (c.mailName) data.mailName = c.mailName;      // 宛名の正式表記(空なら保存しない = ディーラー名を使う)
    const changed = !o || o.name !== c.name || o.sortOrder !== sortOrder || (o.mailName || "") !== (c.mailName || "")
      || !sameList(o.orderEmails, c.orderEmails) || !sameList(o.usageReportEmails, c.usageReportEmails);
    if (changed) writes.push({ id: c.id, data });
  });
  return writes;
}

/** 配列内の要素を1つ上下に移動した新しい配列を返す（範囲外は変更なし） */
export function moveItem(list, index, direction) {
  const to = index + direction;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const copy = [...list];
  [copy[index], copy[to]] = [copy[to], copy[index]];
  return copy;
}

/**
 * 施設のメール設定(settings/mail)の検証: 注文控えメール(ON/OFF・送信先1件)と署名。
 * ON のときは送信先が必須。OFF のときに入力済みの送信先は残す(次に ON にしたときに使う)。
 */
export function validateMailSettings({ copyEnabled, copyEmail, signature }) {
  const errors = [];
  const email = norm(copyEmail).toLowerCase();
  const sig = String(signature ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (copyEnabled && !email) errors.push("注文控えの送信先メールアドレスを入力してください");
  else if (email && (email.length > LIMITS.emailMax || !isValidEmail(email))) errors.push(`メールアドレスの形式が正しくありません: ${email}`);
  if (sig.length > MAIL_SETTINGS_LIMITS.signatureMax) errors.push(`署名は${MAIL_SETTINGS_LIMITS.signatureMax}文字までです`);
  if (sig.split("\n").length > MAIL_SETTINGS_LIMITS.signatureLines) errors.push(`署名は${MAIL_SETTINGS_LIMITS.signatureLines}行までです`);
  return { ok: errors.length === 0, errors, cleaned: { copyEnabled: Boolean(copyEnabled), copyEmail: email, signature: sig } };
}

/** 保存する内容(変更がなければ null) */
export function planMailSettingsWrite(original, cleaned) {
  const o = original || {};
  const same = (o.copyEnabled === true) === cleaned.copyEnabled && (o.copyEmail || "") === cleaned.copyEmail && (o.signature || "") === cleaned.signature;
  return same && original ? null : { copyEnabled: cleaned.copyEnabled, copyEmail: cleaned.copyEmail, signature: cleaned.signature };
}
