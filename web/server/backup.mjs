import { backup, DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalog,
  favicon,
  HttpError,
  number,
  site,
  syncInterval,
  text,
} from "./validation.mjs";

export const BACKUP_LIMIT = 64 << 20;
const FORMAT = "cerium-web-backup";
const fail = (message) => {
  throw new HttpError(400, message);
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function uuid(value) {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
  )
    fail("Invalid backup record ID");
  return value.toLowerCase();
}
function timestamp(value, nullable = true) {
  if (nullable && value == null) return null;
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || time < 0 || time > Date.now() + 300000)
    fail("Invalid backup timestamp");
  return new Date(time).toISOString();
}
export function siteIdentity(config) {
  return config.type === "others"
    ? null
    : JSON.stringify([
        config.url,
        config.type,
        config.account,
        config.user_id ?? 0,
      ]);
}
export function validateBackup(input) {
  if (!object(input) || input.format !== FORMAT || input.version !== 1)
    fail("Expected a version 1 Cerium web backup");
  if (
    !object(input.settings) ||
    !Array.isArray(input.sites) ||
    input.sites.length > 200 ||
    !Array.isArray(input.changes) ||
    input.changes.length > 2000
  )
    fail("Invalid backup settings, sites or change records");
  const ids = new Set(),
    identities = new Set();
  const sites = input.sites.map((entry) => {
    if (!object(entry) || !object(entry.config)) fail("Invalid backup site");
    const id = uuid(entry.id);
    if (ids.has(id)) fail("Duplicate backup site ID");
    ids.add(id);
    if (
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 1 ||
      entry.revision >= Number.MAX_SAFE_INTEGER
    )
      fail("Invalid backup site revision");
    if (
      entry.config.enabled != null &&
      typeof entry.config.enabled !== "boolean"
    )
      fail("Invalid backup site visibility");
    const config = site(entry.config),
      identity = siteIdentity(config);
    if (identity !== null && identities.has(identity))
      fail("Duplicate backup site identity");
    if (identity !== null) identities.add(identity);
    const snapshot =
      entry.snapshot == null
        ? null
        : catalog(
            entry.snapshot,
            config.type === "others" ? "manual" : "public",
          );
    if (
      config.type === "others" &&
      JSON.stringify(snapshot) !== JSON.stringify(config.manual_catalog)
    )
      fail("Manual snapshot must match the manual site configuration");
    const fetchedAt = timestamp(entry.fetched_at),
      lastChecked = timestamp(entry.last_checked);
    if (Boolean(snapshot) !== Boolean(fetchedAt))
      fail("Snapshot and fetched timestamp must be supplied together");
    if (!Array.isArray(entry.warnings) || entry.warnings.length > 30)
      fail("Invalid backup warnings");
    return {
      id,
      revision: entry.revision,
      config,
      snapshot,
      fetched_at: fetchedAt,
      last_checked: lastChecked,
      error: entry.error == null ? null : text(entry.error, 2000),
      warnings: entry.warnings.map((warning) => text(warning, 1000)),
      favicon: favicon(entry.favicon, config.url),
    };
  });
  const changeIds = new Set();
  const changes = input.changes.map((entry) => {
    if (!object(entry)) fail("Invalid backup change record");
    const id = uuid(entry.id),
      siteId = uuid(entry.site_id);
    if (changeIds.has(id) || !ids.has(siteId))
      fail("Duplicate or orphaned backup change record");
    changeIds.add(id);
    if (
      typeof entry.dismissed !== "boolean" ||
      !Array.isArray(entry.details) ||
      !entry.details.length ||
      entry.details.length > 1000
    )
      fail("Invalid backup change details");
    const checkedAt = timestamp(entry.checked_at, false),
      previous = timestamp(entry.previous_checked_at);
    if (previous && previous > checkedAt)
      fail("Invalid change comparison timestamps");
    const groupIds = new Set();
    const details = entry.details.map((detail) => {
      if (
        !object(detail) ||
        !["added", "removed", "multiplier"].includes(detail.kind) ||
        typeof detail.before_dynamic !== "boolean" ||
        typeof detail.after_dynamic !== "boolean"
      )
        fail("Invalid group change");
      const groupId = text(detail.group_id, 200, true);
      if (groupIds.has(groupId)) fail("Duplicate group change");
      groupIds.add(groupId);
      return {
        kind: detail.kind,
        group_id: groupId,
        name: text(detail.name, 200, true),
        before: number(detail.before),
        after: number(detail.after),
        before_dynamic: detail.before_dynamic,
        after_dynamic: detail.after_dynamic,
      };
    });
    return {
      id,
      site_id: siteId,
      checked_at: checkedAt,
      previous_checked_at: previous,
      details,
      dismissed: entry.dismissed,
    };
  });
  return {
    format: FORMAT,
    version: 1,
    exported_at: timestamp(input.exported_at, false),
    settings: {
      sync_interval_seconds: syncInterval(input.settings.sync_interval_seconds),
    },
    sites,
    changes,
  };
}
export function backupFormat(value) {
  if (!["json", "sqlite"].includes(value))
    fail("Backup format must be json or sqlite");
  return value;
}
export async function serializeBackup(store, format) {
  backupFormat(format);
  if (format === "json") {
    const bytes = Buffer.from(JSON.stringify(store.exportData(), null, 2));
    if (bytes.length > BACKUP_LIMIT)
      throw new HttpError(413, "Backup exceeds the 64 MiB limit");
    return bytes;
  }
  const dir = mkdtempSync(join(tmpdir(), "cerium-export-")),
    path = join(dir, "backup.db");
  try {
    writeFileSync(path, "", { mode: 0o600, flag: "wx" });
    // The SQLite backup API includes committed WAL data without copying a live .db file.
    await backup(store.db, path);
    const db = new DatabaseSync(path);
    try {
      db.exec(
        "PRAGMA journal_mode=DELETE; DELETE FROM jobs; DELETE FROM settings WHERE key!='sync_interval_seconds';",
      );
      const insert = db.prepare("INSERT INTO settings(key,value) VALUES(?,?)");
      insert.run("backup_format", FORMAT);
      insert.run("backup_version", "1");
      insert.run("backup_exported_at", new Date().toISOString());
      // Remove retired task bodies and the admin route from free-list pages as well.
      db.exec("VACUUM");
    } finally {
      db.close();
    }
    if (statSync(path).size > BACKUP_LIMIT)
      throw new HttpError(413, "Backup exceeds the 64 MiB limit");
    return readFileSync(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
export function parseBackup(bytes, format, defaultInterval = 900) {
  backupFormat(format);
  if (bytes.length > BACKUP_LIMIT)
    throw new HttpError(413, "Backup exceeds the 64 MiB limit");
  if (format === "json") {
    try {
      return validateBackup(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      fail("Invalid JSON backup");
    }
  }
  if (bytes.subarray(0, 16).toString("binary") !== "SQLite format 3\0")
    fail("Expected a SQLite .db file, not a SQL script");
  const dir = mkdtempSync(join(tmpdir(), "cerium-import-")),
    path = join(dir, "backup.db");
  let db;
  try {
    writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    db.enableDefensive?.(true);
    db.exec(
      "PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA cell_size_check=ON;",
    );
    const tables = db.prepare("SELECT name,type,sql FROM sqlite_schema").all();
    if (
      ["settings", "sites", "catalog_changes"].some(
        (name) =>
          !tables.some(
            (table) =>
              table.name === name &&
              table.type === "table" &&
              /^CREATE\s+TABLE\b/i.test(table.sql),
          ),
      ) ||
      tables.some(
        (table) =>
          ["view", "trigger"].includes(table.type) ||
          /^CREATE\s+VIRTUAL\b/i.test(table.sql),
      )
    )
      fail("Expected a Cerium web SQLite database with ordinary tables");
    if (Object.values(db.prepare("PRAGMA quick_check(1)").get())[0] !== "ok")
      fail("SQLite backup is corrupt");
    const settings = Object.fromEntries(
      db
        .prepare(
          "SELECT key,value FROM settings WHERE key IN ('sync_interval_seconds','backup_format','backup_version','backup_exported_at') LIMIT 4",
        )
        .all()
        .map((row) => [row.key, row.value]),
    );
    const hasFavicon = db
      .prepare("PRAGMA table_info(sites)")
      .all()
      .some((column) => column.name === "favicon");
    return validateBackup({
      format: settings.backup_format ?? FORMAT,
      version: Number(settings.backup_version ?? 1),
      exported_at: settings.backup_exported_at ?? new Date().toISOString(),
      settings: {
        sync_interval_seconds: Number(
          settings.sync_interval_seconds ?? defaultInterval,
        ),
      },
      sites: db
        .prepare(
          `SELECT id,revision,config,snapshot,fetched_at,last_checked,error,warnings,${hasFavicon ? "favicon" : "NULL AS favicon"} FROM sites ORDER BY rowid LIMIT 201`,
        )
        .all()
        .map((row) => ({
          ...row,
          config: JSON.parse(row.config),
          snapshot: row.snapshot ? JSON.parse(row.snapshot) : null,
          warnings: JSON.parse(row.warnings || "[]"),
          favicon: row.favicon == null ? null : JSON.parse(row.favicon),
        })),
      changes: db
        .prepare(
          "SELECT id,site_id,checked_at,previous_checked_at,details,dismissed FROM catalog_changes ORDER BY checked_at,rowid LIMIT 2001",
        )
        .all()
        .map((row) => {
          if (![0, 1].includes(row.dismissed))
            fail("Invalid change visibility");
          return {
            ...row,
            details: JSON.parse(row.details),
            dismissed: Boolean(row.dismissed),
          };
        }),
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail("Invalid or incompatible Cerium web SQLite backup");
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
