// 注文者の `active` フィールド廃止に伴う移行の「計画」と「引数の検証」(純粋関数。ネットワーク・書き込みなし)
// 実行本体は migrate-orderer-active.mjs。
export const PROJECT = "medconf-iol-dev"; // 開発環境のみ

const key = (o) => `${o.facilityId}/${o.id}`;

/**
 * @param {Array<{facilityId:string, id:string, fields:object, updateTime?:string}>} orderers 現在の注文者ドキュメント(fields は素の値)
 * @param {{keepInactive?:string[], removeInactive?:string[]}} decisions 無効(active=false)の注文者ごとの判断。"施設ID/注文者ID"
 */
export function buildPlan(orderers, { keepInactive = [], removeInactive = [] } = {}) {
  const errors = [];
  const byKey = new Map(orderers.map(o => [key(o), o]));
  const keep = new Set(keepInactive), remove = new Set(removeInactive);

  for (const k of keep) if (remove.has(k)) errors.push(`${k}: 「残す」と「削除」の両方に指定されています`);
  for (const k of [...keep, ...remove]) {
    const o = byKey.get(k);
    if (!o) errors.push(`${k}: 該当する注文者がありません`);
    else if (o.fields.active !== false) errors.push(`${k}: 無効(active=false)の注文者ではありません。判断の対象外です`);
  }

  const inactive = orderers.filter(o => o.fields.active === false);
  for (const o of inactive) {
    if (!keep.has(key(o)) && !remove.has(key(o))) {
      errors.push(`${key(o)} (${o.fields.name}): 無効の注文者です。--keep-inactive か --remove-inactive で、残すか削除するかを指定してください`);
    }
  }
  for (const o of orderers) {
    if ("active" in o.fields && typeof o.fields.active !== "boolean") errors.push(`${key(o)}: active が真偽値ではありません(${JSON.stringify(o.fields.active)})。手動で確認してください`);
  }

  const ops = [];
  for (const o of orderers) {
    const k = key(o);
    if (remove.has(k) && o.fields.active === false) ops.push({ type: "delete", key: k, facilityId: o.facilityId, id: o.id, name: o.fields.name, updateTime: o.updateTime });
    else if ("active" in o.fields) ops.push({ type: "dropActive", key: k, facilityId: o.facilityId, id: o.id, name: o.fields.name, wasActive: o.fields.active, updateTime: o.updateTime });
  }
  const summary = {
    total: orderers.length,
    withActiveField: orderers.filter(o => "active" in o.fields).length,
    inactive: inactive.length,
    activeTrue: orderers.filter(o => o.fields.active === true).length,
    toDelete: ops.filter(o => o.type === "delete").length,
    toDropActive: ops.filter(o => o.type === "dropActive").length,
    alreadyNewFormat: orderers.filter(o => !("active" in o.fields)).length
  };
  return { ok: errors.length === 0, errors, ops, summary };
}

const list = (v) => String(v || "").split(",").map(s => s.trim()).filter(Boolean);

/** 実行できる条件の検証。既定は dry-run。実行には --execute・--backup(新しいファイル)・--confirm <プロジェクトID> がすべて必要 */
export function parseMigrationArgs(argv) {
  const a = { mode: "dry-run", keepInactive: [], removeInactive: [], backup: "", confirm: "", errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const val = () => argv[++i];
    if (t === "--execute") a.mode = "execute";
    else if (t === "--keep-inactive") a.keepInactive.push(...list(val()));
    else if (t === "--remove-inactive") a.removeInactive.push(...list(val()));
    else if (t === "--backup") a.backup = val() || "";
    else if (t === "--confirm") a.confirm = val() || "";
    else if (t === "--project") a.errors.push("--project は指定できません(対象は " + PROJECT + " のみ)");
    else a.errors.push(`不明な引数: ${t}`);
  }
  if (a.mode === "execute") {
    if (!a.backup) a.errors.push("--execute には --backup <新しいファイルのパス> が必要です(実行前に全注文者のバックアップを書き出します)");
    if (a.confirm !== PROJECT) a.errors.push(`--execute には --confirm ${PROJECT} が必要です`);
  } else if (a.backup || a.confirm) {
    a.errors.push("--backup / --confirm は --execute と一緒にだけ指定できます(既定は dry-run で、何も変更しません)");
  }
  return a;
}
