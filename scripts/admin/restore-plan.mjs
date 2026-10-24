// バックアップJSON(移行スクリプトが書き出したもの)から active / status を復元するための「計画」(純粋関数。ネットワーク・書き込みなし)
// 実行本体は restore-from-backup.mjs。
export const PROJECT = "medconf-iol-dev";
const RESTORE_FIELDS = Object.freeze({ orderers: ["active"], facilityDealers: ["active"], members: ["status", "lastAuditId"] });
const KINDS = Object.keys(RESTORE_FIELDS);

/** バックアップの形式を判別し、生のドキュメント一覧と種類を返す */
export function readBackup(json) {
  if (!json || typeof json !== "object") return { error: "バックアップの形式が不正です" };
  if (json.project !== PROJECT) return { error: `対象プロジェクトが ${PROJECT} ではありません(${json.project})` };
  const docs = Array.isArray(json.docs) ? json.docs : Array.isArray(json.members) ? json.members : null;
  const kind = Array.isArray(json.docs) ? json.collection : "members";
  if (!docs) return { error: "バックアップに docs / members がありません" };
  if (!KINDS.includes(kind)) return { error: `未対応の種類です: ${kind}` };
  return { kind, docs };
}

/** "projects/…/documents/facilities/f/orderers/o1" → "facilities/f/orderers/o1" */
export const docPathOf = (raw) => String(raw.name).split("/documents/")[1];

/**
 * @param raws バックアップ内の生ドキュメント(REST形式 {name, fields})
 * @param currentByPath 現在のドキュメント(REST形式) または null(存在しない)。キーは docPathOf
 * @param opts { recreateDeleted }
 * 復元するのは RESTORE_FIELDS のフィールドだけ。他のフィールドには触れない。バックアップに無いフィールドを現在から消すことはしない。
 */
export function planRestore(kind, raws, currentByPath, { recreateDeleted = false } = {}) {
  const fields = RESTORE_FIELDS[kind];
  const ops = [], skipped = [], errors = [];
  for (const raw of raws) {
    const p = docPathOf(raw);
    if (!p) { errors.push(`パスを判別できません: ${raw.name}`); continue; }
    const cur = currentByPath.get(p);
    if (!cur) {
      if (recreateDeleted) ops.push({ type: "recreate", path: p, body: { fields: raw.fields || {} } });
      else skipped.push(`${p}: 現在は存在しません(削除済み)。再作成するなら --recreate-deleted`);
      continue;
    }
    const set = fields.filter(f => raw.fields && f in raw.fields && JSON.stringify(raw.fields[f]) !== JSON.stringify((cur.fields || {})[f]));
    if (!set.length) { skipped.push(`${p}: 復元の必要なし(すでに同じ値、またはバックアップに該当フィールドなし)`); continue; }
    ops.push({ type: "restore", path: p, fields: set, body: { fields: Object.fromEntries(set.map(f => [f, raw.fields[f]])) }, updateTime: cur.updateTime });
  }
  return { ok: errors.length === 0, errors, ops, skipped };
}

/** 実行条件(既定は dry-run)。--backup は常に必須(読み込むファイル)。実行には --execute と --confirm <プロジェクトID> が必要 */
export function parseRestoreArgs(argv) {
  const a = { mode: "dry-run", backup: "", confirm: "", recreateDeleted: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i], val = () => argv[++i];
    if (t === "--execute") a.mode = "execute";
    else if (t === "--backup") a.backup = String(val() || "");
    else if (t === "--confirm") a.confirm = String(val() || "");
    else if (t === "--recreate-deleted") a.recreateDeleted = true;
    else a.errors.push(`不明な引数: ${t}`);
  }
  if (!a.backup) a.errors.push("--backup <バックアップJSON> が必要です");
  if (a.mode === "execute" && a.confirm !== PROJECT) a.errors.push(`実行には --confirm ${PROJECT} が必要です`);
  return a;
}
