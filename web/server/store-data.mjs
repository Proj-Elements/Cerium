import { randomUUID } from "node:crypto";
import { HttpError, url, site as validateSite } from "./validation.mjs";
import { validateBackup, siteIdentity, isValidatedBackup } from "./backup.mjs";

export function exportData({ siteIds, includeIcons = true } = {}) {
  return {
    format: "cerium-web-backup",
    version: 1,
    exported_at: new Date().toISOString(),
    settings: {
      sync_interval_seconds: this.interval,
      payment_presets: this.paymentPresets,
    },
    sites: this.db
      .prepare("SELECT * FROM sites ORDER BY rowid")
      .all()
      .filter((row) => !siteIds || siteIds.has(row.id))
      .map((row) => ({
        id: row.id,
        revision: row.revision,
        config: JSON.parse(row.config),
        snapshot: row.snapshot ? JSON.parse(row.snapshot) : null,
        fetched_at: row.fetched_at,
        last_checked: row.last_checked,
        error: row.error,
        warnings: JSON.parse(row.warnings || "[]"),
        favicon:
          includeIcons && row.favicon != null ? JSON.parse(row.favicon) : null,
        favicon_cache:
          includeIcons && row.favicon_blob
            ? {
                type: row.favicon_type,
                data: Buffer.from(row.favicon_blob).toString("base64"),
              }
            : null,
      })),
    changes: this.db
      .prepare("SELECT * FROM catalog_changes ORDER BY checked_at,rowid")
      .all()
      .filter((row) => !siteIds || siteIds.has(row.site_id))
      .map((row) => ({
        ...row,
        details: JSON.parse(row.details),
        dismissed: Boolean(row.dismissed),
      })),
  };
}

export function importData(input, mode = "merge") {
  if (!["merge", "replace"].includes(mode))
    throw new HttpError(400, "Import mode must be merge or replace");
  const data = isValidatedBackup(input) ? input : validateBackup(input);
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
          byId.get(entry.id) ?? byIdentity.get(siteIdentity(entry.config));
        const originalId = old?.id ?? entry.id;
        const outstanding =
          this.db
            .prepare(
              "SELECT MAX(revision) AS revision FROM jobs WHERE site_id=?",
            )
            .get(originalId).revision ?? 0;
        const rotate =
          Math.max(old?.revision ?? 0, old?.sync_revision ?? 0, outstanding) >=
            Number.MAX_SAFE_INTEGER - 1 ||
          (!old && entry.revision >= 1e12);
        const id = rotate ? randomUUID() : originalId;
        if ([...mapping.values()].includes(id))
          throw new HttpError(
            409,
            "Multiple imported sites match the same site",
          );
        mapping.set(entry.id, id);
        return { ...entry, id, old, rotate, originalId };
      }),
      retained = current.filter(
        (row) => !imported.some((entry) => entry.old?.id === row.id),
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
    if (data.settings.payment_presets !== undefined)
      this.db
        .prepare("UPDATE settings SET value=? WHERE key='payment_presets'")
        .run(JSON.stringify(data.settings.payment_presets));
    if (mode === "replace") {
      for (const row of retained) {
        this.retireJobs(row.id);
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
        revision = entry.rotate
          ? 1
          : Math.max(
              entry.revision < 1e12 ? entry.revision : 0,
              entry.old?.revision ?? 0,
              entry.old?.sync_revision ?? 0,
              outstanding,
            ) + 1;
      if (!Number.isSafeInteger(revision))
        throw new HttpError(400, "Site revision is too large");
      if (entry.rotate) {
        this.retireJobs(entry.originalId);
        this.enqueue(
          {
            id: entry.originalId,
            revision: Number.MAX_SAFE_INTEGER,
            sync_revision: Number.MAX_SAFE_INTEGER,
            config: JSON.stringify(
              entry.old ? JSON.parse(entry.old.config) : entry.config,
            ),
          },
          "delete",
        );
        if (entry.old)
          this.db.prepare("DELETE FROM sites WHERE id=?").run(entry.originalId);
      }
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
          `INSERT INTO sites(id,revision,sync_revision,icon_revision,config,snapshot,fetched_at,last_checked,error,warnings,next_sync,favicon,favicon_blob,favicon_type)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,sync_revision=excluded.sync_revision,icon_revision=excluded.icon_revision,
             config=excluded.config,snapshot=excluded.snapshot,fetched_at=excluded.fetched_at,
             last_checked=excluded.last_checked,error=excluded.error,warnings=excluded.warnings,next_sync=excluded.next_sync,
             favicon=excluded.favicon,favicon_blob=excluded.favicon_blob,favicon_type=excluded.favicon_type`,
        )
        .run(
          entry.id,
          revision,
          revision,
          (entry.old?.icon_revision ?? 0) + 1,
          JSON.stringify(entry.config),
          entry.snapshot ? JSON.stringify(entry.snapshot) : null,
          entry.fetched_at,
          entry.last_checked,
          entry.error,
          JSON.stringify(entry.warnings),
          Date.now() + this.interval * 1000,
          entry.favicon ? JSON.stringify(entry.favicon) : null,
          entry.favicon_cache
            ? Buffer.from(entry.favicon_cache.data, "base64")
            : null,
          entry.favicon_cache?.type ?? null,
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

export function recoverRevisionBoundaries() {
  const boundary = Number.MAX_SAFE_INTEGER - 1,
    rows = this.db
      .prepare("SELECT id FROM sites WHERE revision>=? OR sync_revision>=?")
      .all(boundary, boundary);
  if (!rows.length) return;
  const data = exportData.call(this, {
    siteIds: new Set(rows.map((row) => row.id)),
    includeIcons: false,
  });
  importData.call(this, data);
}

export function recoverLegacyURLs() {
  const entries = this.db
      .prepare("SELECT * FROM sites ORDER BY rowid")
      .all()
      .map((row) => {
        const config = JSON.parse(row.config),
          canonical = url(config.url);
        return {
          row,
          config,
          canonical,
          identity: siteIdentity({ ...config, url: canonical }),
        };
      }),
    primary = new Map(),
    migratedIdentities = new Set(
      entries
        .filter((entry) => entry.config.url !== entry.canonical)
        .map((entry) => entry.identity),
    );
  for (const entry of entries) {
    if (entry.identity !== null && !primary.has(entry.identity))
      primary.set(entry.identity, entry.row.id);
  }
  for (const { row, config, canonical, identity } of entries) {
    const owner = identity === null ? row.id : primary.get(identity),
      duplicate = owner !== row.id && migratedIdentities.has(identity);
    if (config.url === canonical && !(duplicate && config.enabled)) continue;
    if (!duplicate && identity === null) {
      this.save({ ...config, url: canonical }, row.id);
      continue;
    }
    this.transaction(() => {
      const normalized = validateSite({
          ...config,
          url: canonical,
          enabled: duplicate ? false : config.enabled,
        }),
        syncRevision = row.sync_revision + 1;
      this.retireJobs(row.id);
      this.db
        .prepare(
          `UPDATE sites SET config=?,revision=revision+1,sync_revision=?,next_sync=?,error=?,
          snapshot=CASE WHEN ? THEN snapshot ELSE NULL END,fetched_at=CASE WHEN ? THEN fetched_at ELSE NULL END,
          last_checked=CASE WHEN ? THEN last_checked ELSE NULL END,warnings=CASE WHEN ? THEN warnings ELSE NULL END,
          favicon=NULL,favicon_blob=NULL,favicon_type=NULL,icon_revision=icon_revision+1 WHERE id=?`,
        )
        .run(
          JSON.stringify(normalized),
          syncRevision,
          Date.now(),
          duplicate
            ? `duplicate_identity: canonical URL duplicates site ${owner}; update URL/account/user ID to re-enable`
            : null,
          Number(duplicate),
          Number(duplicate),
          Number(duplicate),
          Number(duplicate),
          row.id,
        );
      if (duplicate)
        this.enqueue({ ...row, sync_revision: syncRevision }, "delete");
      else if (normalized.enabled) this.enqueue(this.row(row.id));
    });
  }
}

export function sites(admin = false) {
  const interval = this.interval,
    now = Date.now();
  return this.db
    .prepare(
      `SELECT s.id,s.revision,s.sync_revision,s.icon_revision,s.config,s.snapshot,s.fetched_at,s.last_checked,s.error,s.warnings,
         j.state AS job_state,j.attempts AS job_attempts,j.error AS job_error
         FROM sites s LEFT JOIN jobs j ON j.id=(
           SELECT id FROM jobs WHERE site_id=s.id AND revision=COALESCE(s.sync_revision,s.revision) AND state IN ('pending','running')
           ORDER BY created_at DESC,rowid DESC LIMIT 1)
         ORDER BY s.rowid`,
    )
    .all()
    .flatMap((row) => {
      const config = JSON.parse(row.config);
      if (!admin && !config.enabled) return [];
      const job =
        row.job_state === null
          ? undefined
          : {
              state: row.job_state,
              attempts: row.job_attempts,
              error: row.job_error,
            };
      const {
        password,
        account,
        access_token,
        user_id,
        auth_mode,
        manual_catalog,
        recharge_multiplier,
        ...metadata
      } = config;
      return [
        {
          ...metadata,
          id: row.id,
          icon_revision: row.icon_revision,
          fetched_at: row.fetched_at,
          last_checked: row.last_checked,
          catalog: row.snapshot ? JSON.parse(row.snapshot) : null,
          status:
            config.type === "others"
              ? "manual"
              : job
                ? job.attempts > 0 && job.error
                  ? "retrying"
                  : "pending"
                : row.error
                  ? "error"
                  : !row.snapshot
                    ? "waiting"
                    : now - Date.parse(row.fetched_at) > interval * 3000
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
