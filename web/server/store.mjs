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
  paymentPresets,
  DEFAULT_PAYMENT_PRESETS,
  syncResult,
} from "./validation.mjs";
import {
  exportData,
  importData,
  recoverRevisionBoundaries,
  recoverLegacyURLs,
  sites,
} from "./store-data.mjs";
import {
  recordChanges,
  changes,
  getChangesPage,
  changeVisibility,
} from "./store-history.mjs";
import { iconType } from "./icon-content.mjs";
import { siteIdentity } from "./backup.mjs";

export class Store {
  constructor(path, interval = 900) {
    this.path = path;
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
    this.transaction(() => {
      const columns = new Set(
        this.db
          .prepare("PRAGMA table_info(sites)")
          .all()
          .map((column) => column.name),
      );
      for (const [name, type] of [
        ["favicon", "TEXT"],
        ["favicon_blob", "BLOB"],
        ["favicon_type", "TEXT"],
        ["sync_revision", "INTEGER"],
        ["icon_revision", "INTEGER NOT NULL DEFAULT 0"],
      ])
        if (!columns.has(name))
          this.db.exec(`ALTER TABLE sites ADD COLUMN ${name} ${type}`);
      this.db.exec(
        "UPDATE sites SET sync_revision=revision WHERE sync_revision IS NULL",
      );
    });
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
    this.db
      .prepare("INSERT OR IGNORE INTO settings VALUES(?,?)")
      .run("payment_presets", JSON.stringify(DEFAULT_PAYMENT_PRESETS));
    this.db.exec("UPDATE jobs SET state='pending' WHERE state='running'");
    recoverLegacyURLs.call(this);
    recoverRevisionBoundaries.call(this);
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
  get paymentPresets() {
    return JSON.parse(
      this.db
        .prepare("SELECT value FROM settings WHERE key='payment_presets'")
        .get().value,
    );
  }
  setSettings(input) {
    const interval =
      input.sync_interval_seconds === undefined
        ? undefined
        : syncInterval(input.sync_interval_seconds);
    const presets = Object.hasOwn(input, "payment_presets")
      ? paymentPresets(input.payment_presets)
      : undefined;
    if (interval === undefined && presets === undefined)
      throw new HttpError(400, "No supported settings supplied");
    return this.transaction(() => {
      if (interval !== undefined) this.writeInterval(interval);
      if (presets !== undefined)
        this.db
          .prepare("UPDATE settings SET value=? WHERE key='payment_presets'")
          .run(JSON.stringify(presets));
      return {
        sync_interval_seconds: this.interval,
        payment_presets: this.paymentPresets,
      };
    });
  }
  exportData(options) {
    return exportData.call(this, options);
  }
  importData(input, mode = "merge") {
    return importData.call(this, input, mode);
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
  // Store bytes and discovery state atomically without replacing newer results.
  saveFavicon(id, revision, input, previous = null, image = null) {
    const row = this.row(id);
    if (!row || row.revision !== revision || row.favicon !== previous)
      return false;
    const state = favicon(input, JSON.parse(row.config).url);
    if (!state) throw new HttpError(400, "Expected saved favicon discovery");
    if (
      image &&
      (!state.selected ||
        !image.type ||
        iconType(image.body, image.type) !== image.type)
    )
      throw new HttpError(400, "Invalid cached favicon image");
    return Boolean(
      this.db
        .prepare(
          "UPDATE sites SET favicon=?,favicon_blob=?,favicon_type=?,icon_revision=icon_revision+1 WHERE id=? AND revision=? AND favicon IS ?",
        )
        .run(
          JSON.stringify(state),
          image?.body ?? null,
          image?.type ?? null,
          id,
          revision,
          previous,
        ).changes,
    );
  }
  enqueue(row, operation = "sync", refreshModels = false) {
    const config = JSON.parse(row.config);
    const jobId = randomUUID(),
      now = Date.now();
    const payload = {
      job_id: jobId,
      site_id: row.id,
      config_revision: row.sync_revision ?? row.revision,
      operation,
      name: config.name,
      url: config.url,
      type: config.type,
      account: config.account,
      password: config.password,
      access_token: config.access_token ?? "",
      user_id: config.user_id ?? 0,
      ...(refreshModels ? { refresh_models: true } : {}),
    };
    this.db
      .prepare(
        "INSERT INTO jobs(id,site_id,revision,payload,state,due,created_at) VALUES(?,?,?,?,'pending',?,?)",
      )
      .run(
        jobId,
        row.id,
        payload.config_revision,
        JSON.stringify(payload),
        now,
        now,
      );
    this.db
      .prepare("UPDATE sites SET next_sync=? WHERE id=?")
      .run(now + this.interval * 1000, row.id);
    return jobId;
  }
  save(input, id) {
    return this.transaction(() => {
      const old = id ? this.row(id) : null;
      if (id && !old) throw new HttpError(404, "Site not found");
      if (
        old &&
        Object.hasOwn(input ?? {}, "revision") &&
        input.revision !== old.revision
      )
        throw new HttpError(
          409,
          "Site changed since it was opened; load the latest version before saving",
        );
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
        .prepare("SELECT id,config,error FROM sites WHERE id != ?")
        .all(id ?? "")
        .some((r) => {
          return (
            config.type !== "others" &&
            siteIdentity(JSON.parse(r.config), r.error) === siteIdentity(config)
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
        [
          "url",
          "type",
          "account",
          "password",
          "access_token",
          "user_id",
          "auth_mode",
        ].some(
          (key) =>
            (previous[key] ??
              (key === "auth_mode"
                ? "password"
                : key === "user_id"
                  ? 0
                  : "")) !== config[key],
        );
      const syncChanged =
        !old || identityChanged || previous.enabled !== config.enabled;
      const syncRevision = old
        ? (old.sync_revision ?? old.revision) + (syncChanged ? 1 : 0)
        : 1;
      if (
        !Number.isSafeInteger(revision) ||
        !Number.isSafeInteger(syncRevision)
      )
        throw new HttpError(
          409,
          "Site revision exhausted; export and reimport this site with a new ID",
        );
      this.db
        .prepare(
          `INSERT INTO sites(id,revision,sync_revision,config,next_sync) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        revision=excluded.revision,sync_revision=excluded.sync_revision,config=excluded.config,next_sync=excluded.next_sync`,
        )
        .run(
          id,
          revision,
          syncRevision,
          JSON.stringify(config),
          syncChanged ? Date.now() : old.next_sync,
        );
      if (
        previous &&
        ["url", "icon"].some((key) => (previous[key] ?? "") !== config[key])
      )
        this.db
          .prepare(
            "UPDATE sites SET favicon=NULL,favicon_blob=NULL,favicon_type=NULL,icon_revision=icon_revision+1 WHERE id=?",
          )
          .run(id);
      if (syncChanged)
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
        if (cleanupNeeded && syncChanged) this.enqueue(row, "delete");
      } else if (config.enabled && syncChanged) this.enqueue(row);
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
      this.enqueue(
        {
          ...row,
          sync_revision: Math.min(
            Number.MAX_SAFE_INTEGER,
            (row.sync_revision ?? row.revision) + 1,
          ),
        },
        "delete",
      );
      this.db.prepare("DELETE FROM sites WHERE id=?").run(id);
    });
  }
  queue(id, manual = false) {
    const row = this.row(id);
    if (!row) throw new HttpError(404, "Site not found");
    if (JSON.parse(row.config).type === "others")
      throw new HttpError(400, "Manual sites do not use a provider");
    if (manual)
      this.db
        .prepare(
          "UPDATE jobs SET state='superseded' WHERE site_id=? AND revision=? AND state='failed'",
        )
        .run(id, row.sync_revision ?? row.revision);
    const job = this.db
      .prepare(
        "SELECT id,state FROM jobs WHERE site_id=? AND revision=? AND state IN ('pending','running')",
      )
      .get(id, row.sync_revision ?? row.revision);
    if (job) {
      // Redelivery must reuse the same job ID so a saved Go result cannot rotate
      // tokens again. A manual retry only shortens the pending job's backoff.
      if (manual && job.state === "pending")
        this.db
          .prepare(
            "UPDATE jobs SET due=?,error=NULL WHERE id=? AND state='pending'",
          )
          .run(Date.now(), job.id);
      return;
    }
    this.enqueue(row);
  }
  refreshModels(id) {
    return this.transaction(() => {
      const row = this.row(id);
      if (!row) throw new HttpError(404, "Site not found");
      const config = JSON.parse(row.config);
      if (config.type === "others" || !config.enabled)
        throw new HttpError(
          400,
          "Model discovery requires an enabled provider site",
        );
      const active = this.db
        .prepare(
          "SELECT id,state,payload FROM jobs WHERE site_id=? AND state IN ('pending','running') ORDER BY created_at DESC LIMIT 1",
        )
        .get(id);
      if (active && JSON.parse(active.payload).refresh_models !== true)
        throw new HttpError(
          409,
          "Wait for the current sync to finish before refreshing model discovery",
        );
      this.db
        .prepare(
          "UPDATE jobs SET state='superseded' WHERE site_id=? AND revision=? AND state='failed'",
        )
        .run(id, row.sync_revision ?? row.revision);
      return active?.id ?? this.enqueue(row, "sync", true);
    });
  }
  schedule() {
    for (const row of this.db
      .prepare("SELECT * FROM sites WHERE next_sync<=?")
      .all(Date.now())) {
      const c = JSON.parse(row.config);
      const failed = this.db
        .prepare(
          "SELECT id FROM jobs WHERE site_id=? AND revision=? AND state='failed' LIMIT 1",
        )
        .get(row.id, row.sync_revision ?? row.revision);
      if (c.enabled && c.type !== "others" && !failed) this.queue(row.id);
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
        "SELECT j.* FROM jobs j WHERE j.state='pending' AND j.due<=? AND NOT EXISTS(SELECT 1 FROM jobs active WHERE active.site_id=j.site_id AND active.state='running') ORDER BY j.created_at,j.rowid LIMIT 1",
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
  reject(job, message) {
    this.db
      .prepare(
        "UPDATE jobs SET state='failed',payload='{}',error=? WHERE id=? AND state='running'",
      )
      .run(message, job.id);
    this.db
      .prepare(
        "UPDATE sites SET error=? WHERE id=? AND COALESCE(sync_revision,revision)=?",
      )
      .run(message, job.site_id, job.revision);
  }
  accept(result) {
    syncResult(result);
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
        (row.sync_revision ?? row.revision) === job.revision &&
        payload.operation === "sync"
      ) {
        syncResult(result, true);
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
    return recordChanges.call(this, row, current, checkedAt);
  }
  changes(admin = false) {
    return changes.call(this, admin);
  }
  getChangesPage(options) {
    return getChangesPage.call(this, options);
  }
  changeVisibility(id, visible) {
    return changeVisibility.call(this, id, visible);
  }
  sites(admin = false) {
    return sites.call(this, admin);
  }
}
