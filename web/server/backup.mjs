import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ICON_LIMIT, iconType } from "./icon-content.mjs";
import {
  catalog,
  favicon,
  HttpError,
  number,
  site,
  syncInterval,
  text,
  paymentPresets,
} from "./validation.mjs";

export const BACKUP_LIMIT = 64 << 20;
export const RECOVERY_LIMIT = 512 << 20;
let activeWorkers = 0;
const validatedBackups = new WeakSet();
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
function iconCache(value, state) {
  if (value == null) return null;
  if (
    !object(value) ||
    !state?.selected ||
    typeof value.type !== "string" ||
    !value.type ||
    typeof value.data !== "string" ||
    value.data.length > Math.ceil(ICON_LIMIT / 3) * 4
  )
    fail("Invalid cached favicon image");
  const bytes = Buffer.from(value.data, "base64");
  if (
    bytes.toString("base64") !== value.data ||
    iconType(bytes, value.type) !== value.type
  )
    fail("Invalid cached favicon image");
  return { type: value.type, data: value.data };
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
    if (!Number.isSafeInteger(entry.revision) || entry.revision < 1)
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
    const savedFavicon = favicon(entry.favicon, config.url);
    return {
      id,
      revision: entry.revision,
      config,
      snapshot,
      fetched_at: fetchedAt,
      last_checked: lastChecked,
      error: entry.error == null ? null : text(entry.error, 2000),
      warnings: entry.warnings.map((warning) => text(warning, 1000)),
      favicon: savedFavicon,
      favicon_cache: iconCache(entry.favicon_cache, savedFavicon),
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
      entry.details.length > 2000
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
        !["added", "removed", "multiplier", "models", "prices"].includes(
          detail.kind,
        ) ||
        typeof detail.before_dynamic !== "boolean" ||
        typeof detail.after_dynamic !== "boolean"
      )
        fail("Invalid group change");
      const groupId = text(detail.group_id, 200, true);
      const detailKey = `${groupId}:${detail.kind}`;
      if (groupIds.has(detailKey)) fail("Duplicate group change");
      groupIds.add(detailKey);
      const normalized = {
        kind: detail.kind,
        group_id: groupId,
        name: text(detail.name, 200, true),
        before: number(detail.before),
        after: number(detail.after),
        before_dynamic: detail.before_dynamic,
        after_dynamic: detail.after_dynamic,
      };
      if (detail.kind === "models") {
        const names = (value) => {
          if (!Array.isArray(value) || value.length > 10000)
            fail("Invalid model changes");
          const models = value.map((model) => text(model, 300, true));
          if (new Set(models).size !== models.length)
            fail("Duplicate changed model");
          return models;
        };
        normalized.models_added = names(detail.models_added);
        normalized.models_removed = names(detail.models_removed);
        if (
          !normalized.models_added.length &&
          !normalized.models_removed.length
        )
          fail("Expected changed models");
        if (
          normalized.models_added.some((model) =>
            normalized.models_removed.includes(model),
          )
        )
          fail("Model cannot be both added and removed");
      }
      if (detail.kind === "prices") {
        if (
          !Array.isArray(detail.price_changes) ||
          !detail.price_changes.length ||
          detail.price_changes.length > 10000
        )
          fail("Invalid price changes");
        const models = new Set();
        normalized.price_changes = detail.price_changes.map((change) => {
          if (!object(change)) fail("Invalid price change");
          const model = text(change.model, 300, true);
          if (models.has(model)) fail("Duplicate changed model price");
          models.add(model);
          const price = (value) => {
            if (value == null) return null;
            if (!object(value) || value.model !== model)
              fail("Invalid changed model price");
            return catalog({
              scope: "public",
              groups: [{ id: "price", name: "Price", prices: [value] }],
            }).groups[0].prices[0];
          };
          const before = price(change.before),
            after = price(change.after);
          if (before === null && after === null)
            fail("Expected changed model price");
          return { model, before, after };
        });
      }
      return normalized;
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
  const policy = input.cache_policy;
  if (
    policy !== undefined &&
    (!object(policy) ||
      policy.favicon_cache !== "omitted" ||
      !["requested", "size_limit"].includes(policy.reason))
  )
    fail("Invalid backup cache policy");
  return {
    format: FORMAT,
    version: 1,
    exported_at: timestamp(input.exported_at, false),
    settings: {
      sync_interval_seconds: syncInterval(input.settings.sync_interval_seconds),
      ...(Object.hasOwn(input.settings, "payment_presets")
        ? { payment_presets: paymentPresets(input.settings.payment_presets) }
        : {}),
    },
    sites,
    changes,
    ...(policy === undefined ? {} : { cache_policy: { ...policy } }),
  };
}
export function backupFormat(value) {
  if (!["json", "sqlite"].includes(value))
    fail("Backup format must be json or sqlite");
  return value;
}
function workerTask(operation, input) {
  if (activeWorkers >= 1)
    throw new HttpError(503, "Backup processing is busy; try again shortly");
  activeWorkers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      activeWorkers--;
      if (error) reject(error);
      else resolve(value);
    };
    let worker;
    try {
      worker = new Worker(new URL("./backup-worker.mjs", import.meta.url), {
        workerData: { operation, ...input },
      });
    } catch (error) {
      finish(error);
      return;
    }
    worker.once("message", (response) => {
      if (response.error)
        finish(
          new HttpError(response.error.status ?? 500, response.error.message),
        );
      else if (response.bytes) {
        const bytes = Buffer.from(
          response.bytes.buffer,
          response.bytes.byteOffset,
          response.bytes.byteLength,
        );
        bytes.cacheOmitted = response.cacheOmitted === true;
        finish(null, bytes);
      } else finish(null, response.data);
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (!settled)
        finish(new Error(`Backup worker exited before completing (${code})`));
    });
  });
}
export async function serializeBackup(store, format, options = {}) {
  backupFormat(format);
  const cache = options.cache ?? "include";
  if (!["include", "omit"].includes(cache))
    fail("Backup cache policy must be include or omit");
  return workerTask("serialize", {
    path: store.path ?? store.db.location(),
    format,
    cache,
  });
}
export async function parseBackupAsync(bytes, format, defaultInterval = 900) {
  backupFormat(format);
  if (bytes.length > BACKUP_LIMIT)
    throw new HttpError(413, "Backup exceeds the 64 MiB limit");
  const data = await workerTask("parse", { bytes, format, defaultInterval });
  validatedBackups.add(data);
  return data;
}
export function isValidatedBackup(input) {
  return validatedBackups.has(input);
}
export async function exportRecoveryDatabase(store) {
  return workerTask("recovery-export", {
    path: store.path ?? store.db.location(),
  });
}
export async function parseRecoveryDatabase(bytes) {
  if (bytes.length > RECOVERY_LIMIT)
    throw new HttpError(413, "Recovery database exceeds the 512 MiB limit");
  return workerTask("recovery-parse", { bytes });
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
    return validateBackup(readDatabaseData(db, { defaultInterval }));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail("Invalid or incompatible Cerium web SQLite backup");
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readDatabaseData(
  db,
  { defaultInterval = 900, cache = "include" } = {},
) {
  const settings = Object.fromEntries(
    db
      .prepare("SELECT key,value FROM settings")
      .all()
      .map((row) => [row.key, row.value]),
  );
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(sites)")
      .all()
      .map((column) => column.name),
  );
  const hasFavicon = columns.has("favicon"),
    hasIconCache =
      cache === "include" &&
      columns.has("favicon_blob") &&
      columns.has("favicon_type");
  return {
    format: settings.backup_format ?? FORMAT,
    version: Number(settings.backup_version ?? 1),
    exported_at: settings.backup_exported_at ?? new Date().toISOString(),
    settings: {
      sync_interval_seconds: Number(
        settings.sync_interval_seconds ?? defaultInterval,
      ),
      ...(settings.payment_presets !== undefined
        ? { payment_presets: JSON.parse(settings.payment_presets) }
        : {}),
    },
    sites: db
      .prepare(
        `SELECT id,revision,config,snapshot,fetched_at,last_checked,error,warnings,${hasFavicon ? "favicon" : "NULL AS favicon"},${hasIconCache ? "favicon_blob,favicon_type" : "NULL AS favicon_blob,NULL AS favicon_type"} FROM sites ORDER BY rowid LIMIT 201`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        revision: row.revision,
        config: JSON.parse(row.config),
        snapshot: row.snapshot ? JSON.parse(row.snapshot) : null,
        fetched_at: row.fetched_at,
        last_checked: row.last_checked,
        error: row.error,
        warnings: JSON.parse(row.warnings || "[]"),
        favicon: row.favicon == null ? null : JSON.parse(row.favicon),
        favicon_cache:
          row.favicon_blob == null
            ? null
            : {
                type: row.favicon_type,
                data: Buffer.from(row.favicon_blob).toString("base64"),
              },
      })),
    changes: db
      .prepare(
        "SELECT id,site_id,checked_at,previous_checked_at,details,dismissed FROM catalog_changes ORDER BY checked_at,rowid LIMIT 2001",
      )
      .all()
      .map((row) => {
        if (![0, 1].includes(row.dismissed)) fail("Invalid change visibility");
        return {
          ...row,
          details: JSON.parse(row.details),
          dismissed: Boolean(row.dismissed),
        };
      }),
    ...(settings.backup_icon_cache === "omitted"
      ? {
          cache_policy: {
            favicon_cache: "omitted",
            reason: settings.backup_icon_cache_reason ?? "requested",
          },
        }
      : {}),
  };
}
