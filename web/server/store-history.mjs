import { randomUUID } from "node:crypto";
import { compareCatalogs } from "./changes.mjs";
import { HttpError } from "./validation.mjs";

function notice(row, admin = false) {
  const config = JSON.parse(row.config);
  return {
    id: row.id,
    site_id: row.site_id,
    site_name: config.name,
    checked_at: row.checked_at,
    previous_checked_at: row.previous_checked_at,
    details: JSON.parse(row.details),
    ...(admin
      ? {
          dismissed: Boolean(row.dismissed),
          enabled: config.enabled,
          monitor_changes: config.monitor_changes !== false,
        }
      : {}),
  };
}

export function recordChanges(row, current, checkedAt) {
  if (!row.snapshot || JSON.parse(row.config).monitor_changes === false) return;
  const details = compareCatalogs(JSON.parse(row.snapshot), current);
  if (!details.length) return;
  this.db
    .prepare(
      "INSERT INTO catalog_changes(id,site_id,checked_at,previous_checked_at,details) VALUES(?,?,?,?,?)",
    )
    .run(
      randomUUID(),
      row.id,
      checkedAt,
      row.fetched_at,
      JSON.stringify(details),
    );
  this.db
    .prepare(
      "DELETE FROM catalog_changes WHERE id IN (SELECT id FROM catalog_changes ORDER BY checked_at DESC,rowid DESC LIMIT -1 OFFSET 2000)",
    )
    .run();
}

export function changes(admin = false) {
  return this.db
    .prepare(
      `SELECT c.*,s.config FROM catalog_changes c JOIN sites s ON c.site_id=s.id
       ${admin ? "" : "WHERE c.dismissed=0 AND json_extract(s.config,'$.enabled') != 0 AND COALESCE(json_extract(s.config,'$.monitor_changes'),1) != 0 AND c.checked_at >= ?"}
       ORDER BY c.checked_at DESC,c.rowid DESC LIMIT ${admin ? 200 : 20}`,
    )
    .all(...(admin ? [] : [new Date(Date.now() - 7 * 86400000).toISOString()]))
    .map((row) => notice(row, admin));
}

export function getChangesPage({ limit = 50, offset = 0, q = "" } = {}) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 2000 ||
    typeof q !== "string" ||
    q.length > 200
  )
    throw new HttpError(400, "Invalid history pagination or search");
  const query = q.trim().toLowerCase();
  const condition =
    "FROM catalog_changes c JOIN sites s ON c.site_id=s.id WHERE (?='' OR instr(lower(json_extract(s.config,'$.name') || char(10) || c.details),?)>0)";
  const total = this.db
    .prepare(`SELECT COUNT(*) AS total ${condition}`)
    .get(query, query).total;
  const rows = this.db
    .prepare(
      `SELECT c.*,s.config ${condition} ORDER BY c.checked_at DESC,c.rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(query, query, limit, offset);
  return {
    changes: rows.map((row) => notice(row, true)),
    total,
    offset,
    limit,
  };
}

export function changeVisibility(id, visible) {
  if (typeof visible !== "boolean")
    throw new HttpError(400, "Visibility must be a boolean");
  const result = this.db
    .prepare("UPDATE catalog_changes SET dismissed=? WHERE id=?")
    .run(visible ? 0 : 1, id);
  if (!result.changes) throw new HttpError(404, "Change not found");
}
