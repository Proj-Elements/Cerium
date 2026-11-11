import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDatabaseData, validateBackup } from "./backup.mjs";
import { HttpError, text, url } from "./validation.mjs";

const reject = () => {
  throw new HttpError(400, "Invalid Cerium recovery database");
};
const integer = (value, minimum = 0) =>
  Number.isSafeInteger(value) && value >= minimum;
const uuid = (value) =>
  typeof value === "string" &&
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const nullableText = (value, limit) =>
  value === null || (typeof value === "string" && value.length <= limit);

export function parseRecoverySnapshot(bytes) {
  if (bytes.subarray(0, 16).toString("binary") !== "SQLite format 3\0")
    reject();
  const dir = mkdtempSync(join(tmpdir(), "cerium-recovery-validate-")),
    path = join(dir, "snapshot.db");
  let db;
  try {
    writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    db.enableDefensive?.(true);
    db.exec(
      "PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA cell_size_check=ON;",
    );
    const schema = db.prepare("SELECT name,type,sql FROM sqlite_schema").all();
    if (
      ["settings", "sites", "jobs", "catalog_changes"].some(
        (name) =>
          !schema.some(
            (entry) =>
              entry.name === name &&
              entry.type === "table" &&
              /^CREATE\s+TABLE\b/i.test(entry.sql),
          ),
      ) ||
      schema.some(
        (entry) =>
          ["view", "trigger"].includes(entry.type) ||
          /^CREATE\s+VIRTUAL\b/i.test(entry.sql),
      ) ||
      Object.values(db.prepare("PRAGMA quick_check(1)").get())[0] !== "ok"
    )
      reject();
    const normalized = validateBackup(readDatabaseData(db));
    const settings = db
      .prepare("SELECT key,value FROM settings LIMIT 101")
      .all();
    if (
      settings.length > 100 ||
      settings.some(
        (entry) =>
          typeof entry.key !== "string" ||
          !entry.key.length ||
          entry.key.length > 100 ||
          typeof entry.value !== "string" ||
          entry.value.length > 65536,
      )
    )
      reject();
    const adminPath = settings.find(
      (entry) => entry.key === "admin_path",
    )?.value;
    if (
      typeof adminPath !== "string" ||
      !/^\/manage-[\da-f]{36}$/.test(adminPath)
    )
      reject();
    const originals = db
      .prepare("SELECT * FROM sites ORDER BY rowid LIMIT 201")
      .all();
    const allowedSite = new Set([
      "id",
      "revision",
      "sync_revision",
      "icon_revision",
      "config",
      "snapshot",
      "fetched_at",
      "last_checked",
      "error",
      "warnings",
      "next_sync",
      "favicon",
      "favicon_blob",
      "favicon_type",
    ]);
    const sites = originals.map((row, index) => {
      const valid = normalized.sites[index];
      if (
        Object.keys(row).some((key) => !allowedSite.has(key)) ||
        !integer(row.next_sync) ||
        (row.sync_revision !== undefined && !integer(row.sync_revision, 1)) ||
        (row.icon_revision !== undefined && !integer(row.icon_revision))
      )
        reject();
      return {
        ...row,
        config: JSON.stringify(valid.config),
        snapshot: valid.snapshot ? JSON.stringify(valid.snapshot) : null,
        favicon: valid.favicon ? JSON.stringify(valid.favicon) : null,
        warnings: JSON.stringify(valid.warnings),
      };
    });
    const byId = new Map(sites.map((row) => [row.id, row]));
    const jobs = db
      .prepare("SELECT * FROM jobs ORDER BY rowid LIMIT 100001")
      .all();
    const allowedJob = new Set([
      "id",
      "site_id",
      "revision",
      "payload",
      "state",
      "attempts",
      "due",
      "error",
      "created_at",
    ]);
    if (jobs.length > 100000) reject();
    const jobIds = new Set();
    for (const job of jobs) {
      if (
        Object.keys(job).some((key) => !allowedJob.has(key)) ||
        !uuid(job.id) ||
        jobIds.has(job.id) ||
        !uuid(job.site_id) ||
        !integer(job.revision, 1) ||
        !["pending", "running", "done", "failed", "superseded"].includes(
          job.state,
        ) ||
        !integer(job.attempts) ||
        !integer(job.due) ||
        !integer(job.created_at) ||
        !nullableText(job.error, 2000) ||
        typeof job.payload !== "string" ||
        job.payload.length > 8 << 20
      )
        reject();
      jobIds.add(job.id);
      const payload = JSON.parse(job.payload);
      if (["done", "failed", "superseded"].includes(job.state)) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          reject();
        job.payload = "{}";
        continue;
      }
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        payload.job_id !== job.id ||
        payload.site_id !== job.site_id ||
        payload.config_revision !== job.revision ||
        !["sync", "delete"].includes(payload.operation) ||
        !["newapi", "sub2api", "others"].includes(payload.type) ||
        typeof payload.url !== "string" ||
        typeof payload.account !== "string" ||
        payload.account.length > 320 ||
        typeof payload.password !== "string" ||
        payload.password.length > 4096 ||
        (payload.access_token !== undefined &&
          (typeof payload.access_token !== "string" ||
            payload.access_token.length > 16384)) ||
        (payload.user_id !== undefined && !integer(payload.user_id)) ||
        (payload.refresh_models !== undefined &&
          typeof payload.refresh_models !== "boolean")
      )
        reject();
      text(payload.name, 100, true);
      url(payload.url);
      const current = byId.get(job.site_id);
      if (payload.operation === "sync") {
        if (
          !current ||
          (current.sync_revision ?? current.revision) !== job.revision
        )
          reject();
        const config = JSON.parse(current.config);
        if (
          config.url !== payload.url ||
          config.type !== payload.type ||
          config.account !== payload.account ||
          config.password !== payload.password ||
          (config.access_token ?? "") !== (payload.access_token ?? "") ||
          (config.user_id ?? 0) !== (payload.user_id ?? 0)
        )
          reject();
      }
      const allowedPayload = new Set([
        "job_id",
        "site_id",
        "config_revision",
        "operation",
        "name",
        "url",
        "type",
        "account",
        "password",
        "access_token",
        "user_id",
        "refresh_models",
      ]);
      if (Object.keys(payload).some((key) => !allowedPayload.has(key)))
        reject();
    }
    const changes = normalized.changes.map((entry) => ({
      ...entry,
      details: JSON.stringify(entry.details),
      dismissed: entry.dismissed ? 1 : 0,
    }));
    return { settings, sites, jobs, changes };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    reject();
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
