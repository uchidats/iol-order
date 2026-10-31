// 標準リンクのIDは名称・URLの変更後も維持する。
export const STANDARD_LINKS = Object.freeze([
  { id: "std-tecnis", name: "TECNIS Eyhance Toric Calculator", url: "https://tecnistoriccalc.com" },
  { id: "std-alcon", name: "Alcon Online Toric IOL Calculator", url: "https://www.myalcon-toriccalc.com" },
  { id: "std-teleon", name: "LENTIS Toric Lens Configulator", url: "https://www.teleon-toric.com" },
  { id: "std-santen", name: "レンティス コンフォート トーリック カリキュレーター", url: "https://www.santen-iol.jp/SantenSite/" },
  { id: "std-escrs", name: "ESCRS IOL calculator", url: "https://iolcalculator.escrs.org" }
].map(Object.freeze));

export function validateRelatedLink(value) {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const url = typeof value.url === "string" ? value.url : "";
  const errors = [];
  if (!name || name.length > 100) errors.push("名前は1〜100文字で入力してください。");
  let valid = url.length <= 2048 && /^https:\/\/[^\s\\\u0000-\u001f\u007f]+$/i.test(url)
    && /^https:\/\/[^/?#]+(?:[/?#]|$)/i.test(url);
  try {
    const u = new URL(url);
    valid = valid && u.protocol === "https:" && Boolean(u.hostname) && (u.hostname.startsWith("[") || u.hostname.replace(/\.$/, "").split(".").every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) && !u.username && !u.password
      && !url.slice(8).split(/[/?#]/)[0].includes("@");
  } catch { valid = false; }
  if (!valid) errors.push("URLは認証情報を含まない有効なHTTPS URLで入力してください（2048文字以内）。");
  return { ok: errors.length === 0, errors, cleaned: { name, url, enabled: value.enabled === true, sortOrder: value.sortOrder } };
}

export function relatedLinkRows(documents, standards = STANDARD_LINKS) {
  const byId = new Map(documents.map(d => [d.id, d]));
  const standard = standards.map(s => ({ ...s, enabled: byId.get(s.id)?.enabled !== false, standard: true }));
  const custom = documents.filter(d => !d.id.startsWith("std-") && validateRelatedLink(d).ok)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));
  return [...standard, ...custom];
}

export const visibleRelatedLinks = (documents, standards) => relatedLinkRows(documents, standards).filter(d => d.enabled);

export function relatedLinkData(row) {
  return row.id.startsWith("std-") ? { enabled: row.enabled } : {
    name: row.name.trim(), url: row.url, enabled: row.enabled, sortOrder: row.sortOrder
  };
}

export function planRelatedLinkWrites(original, rows, deletes = []) {
  const old = new Map(original.map(d => [d.id, JSON.stringify(relatedLinkData(d))]));
  return { upserts: rows.filter(r => !deletes.includes(r.id) && (r.id.startsWith("std-") || validateRelatedLink(r).ok))
    .map(r => ({ id: r.id, data: relatedLinkData(r) }))
    .filter(w => old.get(w.id) !== JSON.stringify(w.data) && !(w.id.startsWith("std-") && !old.has(w.id) && w.data.enabled)), deletes };
}
