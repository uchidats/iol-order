// 所属(members)の `status` フィールド廃止に伴う移行の「計画」と「引数の検証」(純粋関数。ネットワーク・書き込みなし)
// 実行本体は migrate-member-status.mjs。
//
// 2段階で行う(権限が意図せず変わらないように):
//   phase 1 (新Rules・新画面のデプロイの「前」): 無効(status=disabled)の所属ごとに、削除するか、明示的に有効に戻すかを決めて反映する。
//           有効(status=active)の所属・role には触れない。
//   phase 2 (新Rules・新画面のデプロイの「後」): 残った所属から status / lastAuditId フィールドを取り除く。
//           無効の所属が1件でも残っていれば実行できない(取り除くと有効になってしまうため)。
export const PROJECT = "medconf-iol-dev"; // 開発環境のみ

const key = (m) => `${m.facilityId}/${m.id}`;

/**
 * @param {Array<{facilityId:string, id:string, fields:object, updateTime?:string}>} members
 * @param {{phase:1|2, removeDisabled?:string[], restoreDisabled?:string[]}} opts  "施設ID/uid"
 */
export function buildMemberPlan(members, { phase, removeDisabled = [], restoreDisabled = [] } = {}) {
  const errors = [];
  const byKey = new Map(members.map(m => [key(m), m]));
  const remove = new Set(removeDisabled), restore = new Set(restoreDisabled);

  for (const m of members) {
    const st = m.fields.status;
    if (st !== undefined && st !== "active" && st !== "disabled") errors.push(`${key(m)}: status が想定外の値です(${JSON.stringify(st)})。手動で確認してください`);
    if (m.fields.role !== "admin" && m.fields.role !== "orderer") errors.push(`${key(m)}: role が想定外の値です(${JSON.stringify(m.fields.role)})。手動で確認してください`);
  }
  for (const k of remove) if (restore.has(k)) errors.push(`${k}: 「削除」と「有効に戻す」の両方に指定されています`);
  for (const k of [...remove, ...restore]) {
    const m = byKey.get(k);
    if (!m) errors.push(`${k}: 該当する所属がありません`);
    else if (m.fields.status !== "disabled") errors.push(`${k}: 無効(status=disabled)の所属ではありません。判断の対象外です`);
    else if (m.fields.role === "admin" && remove.has(k)) {
      const otherAdmins = members.filter(x => x.facilityId === m.facilityId && x.fields.role === "admin" && x.fields.status !== "disabled" && key(x) !== k);
      if (!otherAdmins.length) errors.push(`${k}: この施設の有効な管理者が居なくなるため、削除できません`);
    }
  }

  const disabled = members.filter(m => m.fields.status === "disabled");
  const ops = [];
  if (phase === 1) {
    for (const m of disabled) {
      const k = key(m);
      if (remove.has(k)) ops.push({ type: "delete", key: k, facilityId: m.facilityId, id: m.id, role: m.fields.role, name: m.fields.displayName, updateTime: m.updateTime });
      else if (restore.has(k)) ops.push({ type: "restore", key: k, facilityId: m.facilityId, id: m.id, role: m.fields.role, name: m.fields.displayName, updateTime: m.updateTime });
      else errors.push(`${k} (${m.fields.displayName || "氏名なし"} / ${m.fields.role}): 無効の所属です。--remove-disabled(所属を削除) か --restore-disabled(明示的に有効に戻す) を指定してください。勝手には有効にしません`);
    }
  } else if (phase === 2) {
    for (const m of disabled) errors.push(`${key(m)}: 無効の所属が残っています。status を取り除くと有効になるため、先に phase 1 で削除するか有効に戻してください`);
    for (const m of members) {
      if ("status" in m.fields || "lastAuditId" in m.fields) {
        ops.push({ type: "dropFields", key: key(m), facilityId: m.facilityId, id: m.id, role: m.fields.role, fields: ["status", "lastAuditId"].filter(f => f in m.fields), updateTime: m.updateTime });
      }
    }
  } else {
    errors.push("--phase 1 または --phase 2 を指定してください");
  }

  const summary = {
    total: members.length,
    admins: members.filter(m => m.fields.role === "admin").length,
    orderers: members.filter(m => m.fields.role === "orderer").length,
    statusActive: members.filter(m => m.fields.status === "active").length,
    statusDisabled: disabled.length,
    noStatus: members.filter(m => !("status" in m.fields)).length,
    ops: ops.length
  };
  return { ok: errors.length === 0, errors, ops, summary };
}

const list = (v) => String(v || "").split(",").map(s => s.trim()).filter(Boolean);

/** 実行条件の検証。既定は dry-run。実行には --execute・--backup(新しいファイル)・--confirm <プロジェクトID> がすべて必要 */
export function parseMemberArgs(argv) {
  const a = { mode: "dry-run", phase: 0, removeDisabled: [], restoreDisabled: [], backup: "", confirm: "", errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const val = () => argv[++i];
    if (t === "--execute") a.mode = "execute";
    else if (t === "--phase") a.phase = Number(val());
    else if (t === "--remove-disabled") a.removeDisabled.push(...list(val()));
    else if (t === "--restore-disabled") a.restoreDisabled.push(...list(val()));
    else if (t === "--backup") a.backup = val() || "";
    else if (t === "--confirm") a.confirm = val() || "";
    else if (t === "--project") a.errors.push("--project は指定できません(対象は " + PROJECT + " のみ)");
    else a.errors.push(`不明な引数: ${t}`);
  }
  if (![1, 2].includes(a.phase)) a.errors.push("--phase 1 または --phase 2 を指定してください(順序は docs/member-status-removal.md)");
  if (a.mode === "execute") {
    if (!a.backup) a.errors.push("--execute には --backup <新しいファイルのパス> が必要です(実行前に全所属のバックアップを書き出します)");
    if (a.confirm !== PROJECT) a.errors.push(`--execute には --confirm ${PROJECT} が必要です`);
  } else if (a.backup || a.confirm) {
    a.errors.push("--backup / --confirm は --execute と一緒にだけ指定できます(既定は dry-run で、何も変更しません)");
  }
  return a;
}
