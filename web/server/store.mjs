import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  site as validateSite,
  catalog,
  favicon,
  HttpError,
  syncInterval,
} from "./validation.mjs";
import { compareCatalogs } from "./changes.mjs";
import { validateBackup, siteIdentity } from "./backup.mjs";

export class Store {
  constructor(path, interval = 900) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, config TEXT NOT NULL,
        snapshot TEXT, fetched_at TEXT, last_checked TEXT, error TEXT, warnings TEXT, next_sync INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, revision INTEGER NOT NULL,
        payload TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL,
        error TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state,due);
      CREATE INDEX IF NOT EXISTS jobs_site ON jobs(site_id,revision,state);
      CREATE TABLE IF NOT EXISTS catalog_changes (
        id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        checked_at TEXT NOT NULL, previous_checked_at TEXT, details TEXT NOT NULL,
        dismissed INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS changes_recent ON catalog_changes(checked_at DESC);`);
    if (
      !this.db
        .prepare("PRAGMA table_info(sites)")
        .all()
        .some((column) => column.name === "favicon")
    )
      this.db.exec("ALTER TABLE sites ADD COLUMN favicon TEXT");
    this.db
      .prepare("INSERT OR IGNORE INTO settings VALUES(?,?)")
      .run("admin_path", `/manage-${randomBytes(18).toString("hex")}`);
    this.adminPath = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get("admin_path").value;
    this.db
      .prepare("INSERT OR IGNORE INTO settings VALUES(?,?)")
      .run("sync_interval_seconds", String(syncInterval(interval)));
    syncInterval(this.interval);
    this.db.exec("UPDATE jobs SET state='pending' WHERE state='running'");
  }
  get interval() {
    return Number(
      this.db
        .prepare("SELECT value FROM settings WHERE key='sync_interval_seconds'")
        .get().value,
    );
  }
  writeInterval(value) {
    const interval = syncInterval(value),
      delta = (interval - this.interval) * 1000;
    this.db
      .prepare("UPDATE settings SET value=? WHERE key='sync_interval_seconds'")
      .run(String(interval));
    // Keep elapsed time since the last queued sync instead of restarting the wait.
    this.db
      .prepare(
        "UPDATE sites SET next_sync=MAX(0,next_sync+?) WHERE json_extract(config,'$.enabled')=1 AND json_extract(config,'$.type')!='others'",
      )
      .run(delta);
    return interval;
  }
  setInterval(value) {
    return this.transaction(() => this.writeInterval(value));
  }
  exportData() {
    return {
      format: "cerium-web-backup",
      version: 1,
      exported_at: new Date().toISOString(),
      settings: { sync_interval_seconds: this.interval },
      sites: this.db
        .prepare("SELECT * FROM sites ORDER BY rowid")
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
        })),
      changes: this.db
        .prepare("SELECT * FROM catalog_changes ORDER BY checked_at,rowid")
        .all()
        .map((row) => ({
          ...row,
          details: JSON.parse(row.details),
          dismissed: Boolean(row.dismissed),
        })),
    };
  }
  importData(input, mode = "merge") {
    if (!["merge", "replace"].includes(mode))
      throw new HttpError(400, "Import mode must be merge or replace");
    const data = validateBackup(input);
    return this.transaction(() => {
      const current = this.db.prepare("SELECT * FROM sites").all(),
        byId = new Map(current.map((row) => [row.id, row])),
        byIdentity = new Map(
          current
            .filter((row) => siteIdentity(JSON.parse(row.config)) !== null)
            .map((row) => [siteIdentity(JSON.parse(row.config)), row]),
        ),
        mapping = new Map(),
        imported = data.sites.map((entry) => {
          const old =
              byId.get(entry.id) ?? byIdentity.get(siteIdentity(entry.config)),
            id = old?.id ?? entry.id;
          if ([...mapping.values()].includes(id))
            throw new HttpError(
              409,
              "Multiple imported sites match the same site",
            );
          mapping.set(entry.id, id);
          return { ...entry, id, old };
        }),
        retained = current.filter(
          (row) => ![...mapping.values()].includes(row.id),
        );
      if (imported.length + (mode === "merge" ? retained.length : 0) > 200)
        throw new HttpError(400, "Maximum 200 sites");
      const identities = new Set();
      for (const config of [
        ...(mode === "merge"
          ? retained.map((row) => JSON.parse(row.config))
          : []),
        ...imported.map((entry) => entry.config),
      ]) {
        const identity = siteIdentity(config);
        if (identity !== null && identities.has(identity))
          throw new HttpError(
            409,
            "This URL, provider and account or user ID already exist",
          );
        if (identity !== null) identities.add(identity);
      }
      this.writeInterval(data.settings.sync_interval_seconds);
      if (mode === "replace") {
        for (const row of retained) {
          this.retireJobs(row.id);
          this.enqueue({ ...row, revision: row.revision + 1 }, "delete");
          this.db.prepare("DELETE FROM sites WHERE id=?").run(row.id);
        }
      }
      for (const entry of imported) {
        const outstanding =
            this.db
              .prepare(
                "SELECT MAX(revision) AS revision FROM jobs WHERE site_id=?",
              )
              .get(entry.id).revision ?? 0,
          revision =
            Math.max(entry.revision, entry.old?.revision ?? 0, outstanding) + 1;
        if (!Number.isSafeInteger(revision))
          throw new HttpError(400, "Site revision is too large");
        const cleanup =
          entry.config.type === "others" &&
          ((entry.old && JSON.parse(entry.old.config).type !== "others") ||
            this.db
              .prepare(
                "SELECT id FROM jobs WHERE site_id=? AND state IN ('pending','running') AND json_extract(payload,'$.operation')='delete'",
              )
              .get(entry.id));
        this.retireJobs(entry.id);
        if (
          mode === "replace" ||
          (entry.old &&
            ["url", "type"].some(
              (key) => JSON.parse(entry.old.config)[key] !== entry.config[key],
            ))
        )
          this.db
            .prepare("DELETE FROM catalog_changes WHERE site_id=?")
            .run(entry.id);
        this.db
          .prepare(
            `INSERT INTO sites(id,revision,config,snapshot,fetched_at,last_checked,error,warnings,next_sync,favicon)
             VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,
             config=excluded.config,snapshot=excluded.snapshot,fetched_at=excluded.fetched_at,
             last_checked=excluded.last_checked,error=excluded.error,warnings=excluded.warnings,next_sync=excluded.next_sync,
             favicon=excluded.favicon`,
          )
          .run(
            entry.id,
            revision,
            JSON.stringify(entry.config),
            entry.snapshot ? JSON.stringify(entry.snapshot) : null,
            entry.fetched_at,
            entry.last_checked,
            entry.error,
            JSON.stringify(entry.warnings),
            Date.now() + this.interval * 1000,
            entry.favicon ? JSON.stringify(entry.favicon) : null,
          );
        if (cleanup) this.enqueue(this.row(entry.id), "delete");
        else if (entry.config.enabled && entry.config.type !== "others")
          this.enqueue(this.row(entry.id));
      }
      for (const change of data.changes) {
        const siteId = mapping.get(change.site_id),
          old = this.db
            .prepare("SELECT site_id FROM catalog_changes WHERE id=?")
            .get(change.id);
        if (old && old.site_id !== siteId)
          throw new HttpError(409, "Change record belongs to a different site");
        this.db
          .prepare(
            `INSERT INTO catalog_changes(id,site_id,checked_at,previous_checked_at,details,dismissed)
             VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,
             previous_checked_at=excluded.previous_checked_at,details=excluded.details,dismissed=excluded.dismissed`,
          )
          .run(
            change.id,
            siteId,
            change.checked_at,
            change.previous_checked_at,
            JSON.stringify(change.details),
            change.dismissed ? 1 : 0,
          );
      }
      this.db.exec(
        "DELETE FROM catalog_changes WHERE id IN (SELECT id FROM catalog_changes ORDER BY checked_at DESC,rowid DESC LIMIT -1 OFFSET 2000)",
      );
      return {
        imported: imported.length,
        removed: mode === "replace" ? retained.length : 0,
        interval: this.interval,
      };
    });
  }
  retireJobs(id) {
    this.db
      .prepare(
        "UPDATE jobs SET state='superseded',payload='{}' WHERE site_id=? AND state IN ('pending','running')",
      )
      .run(id);
  }
  close() {
    this.db.close();
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  row(id) {
    return this.db.prepare("SELECT * FROM sites WHERE id=?").get(id);
  }
  saveFavicon(id, revision, input) {
    const row = this.row(id);
    if (!row || row.revision !== revision || row.favicon !== null) return false;
    const state = favicon(input, JSON.parse(row.config).url);
    if (!state) throw new HttpError(400, "Expected saved favicon discovery");
    return Boolean(
      this.db
        .prepare(
          "UPDATE sites SET favicon=? WHERE id=? AND revision=? AND favicon IS NULL",
        )
        .run(JSON.stringify(state), id, revision).changes,
    );
  }
  enqueue(row, operation = "sync") {
    const config = JSON.parse(row.config);
    const jobId = randomUUID(),
      now = Date.now();
    const payload = {
      job_id: jobId,
      site_id: row.id,
      config_revision: row.revision,
      operation,
      name: config.name,
      url: config.url,
      type: config.type,
      account: config.account,
      password: config.password,
      access_token: config.access_token ?? "",
      user_id: config.user_id ?? 0,
    };
    this.db
      .prepare(
        "INSERT INTO jobs(id,site_id,revision,payload,state,due,created_at) VALUES(?,?,?,?,'pending',?,?)",
      )
      .run(jobId, row.id, row.revision, JSON.stringify(payload), now, now);
    this.db
      .prepare("UPDATE sites SET next_sync=? WHERE id=?")
      .run(now + this.interval * 1000, row.id);
    return jobId;
  }
  save(input, id) {
    return this.transaction(() => {
      const old = id ? this.row(id) : null;
      if (id && !old) throw new HttpError(404, "Site not found");
      const previous = old && JSON.parse(old.config),
        config = validateSite(input, previous);
      const cleanupNeeded =
        config.type === "others" &&
        previous &&
        (previous.type !== "others" ||
          this.db
            .prepare(
              "SELECT id FROM jobs WHERE site_id=? AND state IN ('pending','running') AND json_extract(payload,'$.operation')='delete'",
            )
            .get(id));
      if (
        !old &&
        this.db.prepare("SELECT COUNT(*) AS n FROM sites").get().n >= 200
      )
        throw new HttpError(400, "Maximum 200 sites");
      const duplicate = this.db
        .prepare("SELECT id,config FROM sites WHERE id != ?")
        .all(id ?? "")
        .some((r) => {
          const c = JSON.parse(r.config);
          return (
            c.type !== "others" &&
            c.url === config.url &&
            c.type === config.type &&
            c.account === config.account &&
            (c.user_id ?? 0) === config.user_id
          );
        });
      if (duplicate)
        throw new HttpError(
          409,
          "This URL, provider and account or user ID already exist",
        );
      id ??= randomUUID();
      const revision = (old?.revision ?? 0) + 1;
      const identityChanged =
        previous &&
        ["url", "type", "account", "password", "access_token", "user_id"].some(
          (k) => (previous[k] ?? (k === "user_id" ? 0 : "")) !== config[k],
        );
      this.db
        .prepare(
          `INSERT INTO sites(id,revision,config,next_sync) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        revision=excluded.revision,config=excluded.config,next_sync=excluded.next_sync`,
        )
        .run(id, revision, JSON.stringify(config), Date.now());
      if (
        previous &&
        ["url", "icon"].some((key) => (previous[key] ?? "") !== config[key])
      )
        this.db.prepare("UPDATE sites SET favicon=NULL WHERE id=?").run(id);
      this.db
        .prepare(
          "UPDATE jobs SET state='superseded',payload='{}' WHERE site_id=? AND state IN ('pending','running')",
        )
        .run(id);
      if (identityChanged)
        this.db
          .prepare(
            "UPDATE sites SET snapshot=NULL,fetched_at=NULL,last_checked=NULL,error=NULL,warnings=NULL WHERE id=?",
          )
          .run(id);
      if (
        previous &&
        ["url", "type"].some((key) => previous[key] !== config[key])
      )
        this.db.prepare("DELETE FROM catalog_changes WHERE site_id=?").run(id);
      const row = this.row(id);
      if (config.type === "others") {
        this.recordChanges(
          row,
          config.manual_catalog,
          new Date().toISOString(),
        );
        this.db
          .prepare(
            "UPDATE sites SET snapshot=?,fetched_at=?,error=NULL WHERE id=?",
          )
          .run(
            JSON.stringify(config.manual_catalog),
            new Date().toISOString(),
            id,
          );
        if (cleanupNeeded) this.enqueue(row, "delete");
      } else if (config.enabled) this.enqueue(row);
      return id;
    });
  }
  remove(id) {
    this.transaction(() => {
      const row = this.row(id);
      if (!row) throw new HttpError(404, "Site not found");
      this.db
        .prepare(
          "UPDATE jobs SET state='superseded',payload='{}' WHERE site_id=? AND state IN ('pending','running')",
        )
        .run(id);
      this.enqueue({ ...row, revision: row.revision + 1 }, "delete");
      this.db.prepare("DELETE FROM sites WHERE id=?").run(id);
    });
  }
  queue(id) {
    const row = this.row(id);
    if (!row) throw new HttpError(404, "Site not found");
    if (JSON.parse(row.config).type === "others")
      throw new HttpError(400, "Manual sites do not use a provider");
    if (
      this.db
        .prepare(
          "SELECT id FROM jobs WHERE site_id=? AND revision=? AND state IN ('pending','running')",
        )
        .get(id, row.revision)
    )
      return;
    this.enqueue(row);
  }
  schedule() {
    for (const row of this.db
      .prepare("SELECT * FROM sites WHERE next_sync<=?")
      .all(Date.now())) {
      const c = JSON.parse(row.config);
      if (c.enabled && c.type !== "others") this.queue(row.id);
    }
    this.db
      .prepare(
        "DELETE FROM jobs WHERE state IN ('done','superseded') AND created_at<?",
      )
      .run(Date.now() - 30 * 86400000);
    this.db
      .prepare("DELETE FROM catalog_changes WHERE checked_at<?")
      .run(new Date(Date.now() - 30 * 86400000).toISOString());
  }
  nextJob() {
    const job = this.db
      .prepare(
        "SELECT * FROM jobs WHERE state='pending' AND due<=? ORDER BY created_at LIMIT 1",
      )
      .get(Date.now());
    if (job)
      this.db
        .prepare(
          "UPDATE jobs SET state='running',attempts=attempts+1 WHERE id=?",
        )
        .run(job.id);
    return job;
  }
  retry(job, message) {
    this.db
      .prepare(
        "UPDATE jobs SET state='pending',due=?,error=? WHERE id=? AND state='running'",
      )
      .run(
        Date.now() + Math.min(900000, 5000 * 2 ** Math.min(job.attempts, 8)),
        message,
        job.id,
      );
  }
  accept(result) {
    return this.transaction(() => {
      const job = this.db
        .prepare("SELECT * FROM jobs WHERE id=?")
        .get(result.job_id);
      if (!job) throw new HttpError(404, "Unknown job");
      if (
        result.site_id !== job.site_id ||
        result.config_revision !== job.revision
      )
        throw new HttpError(409, "Job mismatch");
      if (["done", "superseded"].includes(job.state)) return;
      const payload = JSON.parse(job.payload),
        row = this.row(job.site_id);
      if (
        row &&
        row.revision === job.revision &&
        payload.operation === "sync"
      ) {
        if (result.url !== payload.url || result.type !== payload.type)
          throw new HttpError(409, "Site mismatch");
        const time = Date.parse(result.checked_at);
        if (!Number.isFinite(time) || time > Date.now() + 300000)
          throw new HttpError(400, "Invalid check timestamp");
        // Delayed callbacks must never roll back a more recent comparison baseline.
        if (row.last_checked && time < Date.parse(row.last_checked)) {
          this.db
            .prepare(
              "UPDATE jobs SET state='done',payload='{}',error=NULL WHERE id=?",
            )
            .run(job.id);
          return;
        }
        const error =
          typeof result.error === "string" ? result.error.slice(0, 2000) : "";
        const snapshot = !error
          ? JSON.stringify(catalog(result.catalog))
          : null;
        if (snapshot)
          this.recordChanges(row, JSON.parse(snapshot), result.checked_at);
        const warnings = [
          ...(Array.isArray(result.warnings) ? result.warnings : []),
          ...(Array.isArray(result.catalog?.warnings)
            ? result.catalog.warnings
            : []),
        ]
          .filter((w) => typeof w === "string")
          .slice(0, 30)
          .map((w) => w.slice(0, 1000));
        this.db
          .prepare(
            `UPDATE sites SET snapshot=COALESCE(?,snapshot),fetched_at=CASE WHEN ? IS NOT NULL THEN ? ELSE fetched_at END,
          last_checked=?,error=?,warnings=? WHERE id=?`,
          )
          .run(
            snapshot,
            snapshot,
            result.checked_at,
            result.checked_at,
            error,
            JSON.stringify(warnings),
            row.id,
          );
      }
      this.db
        .prepare(
          "UPDATE jobs SET state='done',payload='{}',error=NULL WHERE id=?",
        )
        .run(job.id);
    });
  }
  recordChanges(row, current, checkedAt) {
    if (!row.snapshot || JSON.parse(row.config).monitor_changes === false)
      return;
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
  changes(admin = false) {
    return this.db
      .prepare(
        `SELECT c.*,s.config FROM catalog_changes c JOIN sites s ON c.site_id=s.id
       ${admin ? "" : "WHERE c.dismissed=0 AND json_extract(s.config,'$.enabled') != 0 AND COALESCE(json_extract(s.config,'$.monitor_changes'),1) != 0 AND c.checked_at >= ?"}
       ORDER BY c.checked_at DESC,c.rowid DESC LIMIT ${admin ? 200 : 20}`,
      )
      .all(
        ...(admin ? [] : [new Date(Date.now() - 7 * 86400000).toISOString()]),
      )
      .map((row) => {
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
      });
  }
  changeVisibility(id, visible) {
    if (typeof visible !== "boolean")
      throw new HttpError(400, "Visibility must be a boolean");
    const result = this.db
      .prepare("UPDATE catalog_changes SET dismissed=? WHERE id=?")
      .run(visible ? 0 : 1, id);
    if (!result.changes) throw new HttpError(404, "Change not found");
  }
  sites(admin = false) {
    return this.db
      .prepare("SELECT * FROM sites ORDER BY rowid")
      .all()
      .flatMap((row) => {
        const c = JSON.parse(row.config);
        if (!admin && !c.enabled) return [];
        const job = this.db
          .prepare(
            "SELECT state,attempts,error FROM jobs WHERE site_id=? AND revision=? AND state IN ('pending','running') ORDER BY created_at DESC LIMIT 1",
          )
          .get(row.id, row.revision);
        const {
          password,
          account,
          access_token,
          user_id,
          auth_mode,
          manual_catalog,
          ...metadata
        } = c;
        return [
          {
            ...metadata,
            id: row.id,
            fetched_at: row.fetched_at,
            last_checked: row.last_checked,
            catalog: row.snapshot ? JSON.parse(row.snapshot) : null,
            status:
              c.type === "others"
                ? "manual"
                : row.error
                  ? "error"
                  : job
                    ? job.attempts > 0 && job.error
                      ? "retrying"
                      : "pending"
                    : !row.snapshot
                      ? "waiting"
                      : Date.now() - Date.parse(row.fetched_at) >
                          this.interval * 3000
                        ? "stale"
                        : "ok",
            ...(admin
              ? {
                  account,
                  has_password: Boolean(password),
                  auth_mode: auth_mode ?? "password",
                  user_id: user_id ?? 0,
                  has_access_token: Boolean(access_token),
                  manual_catalog,
                  revision: row.revision,
                  error: row.error || job?.error || "",
                  warnings: JSON.parse(row.warnings || "[]"),
                  job,
                }
              : {}),
          },
        ];
      });
  }
}
