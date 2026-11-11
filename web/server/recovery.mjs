import { Worker } from "node:worker_threads";
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "./validation.mjs";
import { RECOVERY_LIMIT, RECOVERY_WORKER_LIMIT } from "./recovery-limits.mjs";

export { RECOVERY_LIMIT };
const columns = {
  settings: ["key", "value"],
  sites: [
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
  ],
  jobs: [
    "id",
    "site_id",
    "revision",
    "payload",
    "state",
    "attempts",
    "due",
    "error",
    "created_at",
  ],
  catalog_changes: [
    "id",
    "site_id",
    "checked_at",
    "previous_checked_at",
    "details",
    "dismissed",
  ],
};

function processArchive(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./recovery-worker.mjs", import.meta.url),
      { workerData: data },
    );
    worker.once("error", reject);
    worker.once("message", (result) => {
      if (result.error) reject(new HttpError(400, result.error));
      else resolve(result);
    });
    worker.once("exit", (code) => {
      if (code !== 0)
        reject(
          new HttpError(500, "Recovery archive worker stopped unexpectedly"),
        );
    });
  });
}

function restoreWeb(store, data) {
  const adminPath = store.adminPath;
  return store.transaction(() => {
    store.db.exec(
      "DELETE FROM jobs; DELETE FROM catalog_changes; DELETE FROM sites; DELETE FROM settings;",
    );
    for (const [table, rows] of [
      ["settings", data.settings],
      ["sites", data.sites],
      ["jobs", data.jobs],
      ["catalog_changes", data.changes],
    ]) {
      const available = new Set(
        store.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => column.name),
      );
      const selected = columns[table].filter((column) => available.has(column));
      const insert = store.db.prepare(
        `INSERT INTO ${table}(${selected.join(",")}) VALUES(${selected.map(() => "?").join(",")})`,
      );
      for (const row of rows) {
        if (table === "settings" && row.key === "recovery_pending") continue;
        insert.run(
          ...selected.map((column) => {
            if (
              table === "settings" &&
              row.key === "admin_path" &&
              column === "value"
            )
              return adminPath;
            if (
              table === "jobs" &&
              column === "state" &&
              row.state === "running"
            )
              return "pending";
            if (column === "favicon_blob" && row[column] != null)
              return Buffer.from(row[column]);
            return row[column] ?? null;
          }),
        );
      }
    }
    store.db
      .prepare(
        "INSERT OR REPLACE INTO settings(key,value) VALUES('admin_path',?)",
      )
      .run(adminPath);
    return {
      restored: true,
      sites: data.sites.length,
      jobs: data.jobs.length,
      admin_path: adminPath,
    };
  });
}

export function createRecovery({
  store,
  dispatcher,
  backend,
  secret,
  sign,
  storage,
  log,
  fetchWorker = fetch,
}) {
  let reconciling = false;
  const pending = () =>
    Boolean(
      store.db
        .prepare(
          "SELECT 1 AS pending FROM settings WHERE key='recovery_pending'",
        )
        .get(),
    );
  const readPending = () =>
    store.db
      .prepare("SELECT value FROM settings WHERE key='recovery_pending'")
      .get()?.value;
  const clearPending = () =>
    store.db.prepare("DELETE FROM settings WHERE key='recovery_pending'").run();
  if (pending()) dispatcher.paused = true;
  async function workerRequest(path, body = Buffer.from("{}")) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const requestPath = `/v1/recovery/${path}`;
    const response = await fetchWorker(
      `${backend.replace(/\/+$/, "")}${requestPath}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          "Content-Type": "application/json",
          "X-Cerium-Timestamp": timestamp,
          "X-Cerium-Signature": sign(
            secret,
            timestamp,
            Buffer.concat([Buffer.from(`${requestPath}\n`), body]),
          ),
        },
        body,
      },
    );
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > RECOVERY_WORKER_LIMIT)
        throw new HttpError(413, "Worker recovery snapshot exceeds 256 MiB");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (!response.ok)
      throw new HttpError(
        response.status < 500 ? response.status : 502,
        `Worker recovery ${path} returned HTTP ${response.status}`,
      );
    const signedAt = response.headers.get("x-cerium-timestamp"),
      signature = response.headers.get("x-cerium-signature"),
      expected = sign(secret, signedAt, bytes);
    if (
      !/^\d+$/.test(signedAt ?? "") ||
      Math.abs(Date.now() / 1000 - Number(signedAt)) > 300 ||
      typeof signature !== "string" ||
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      throw new HttpError(502, "Worker recovery response signature is invalid");
    return bytes;
  }

  return {
    pending,
    async reconcile() {
      if (!pending() || reconciling) return;
      reconciling = true;
      await dispatcher.pause();
      try {
        await workerRequest("import", Buffer.from(readPending(), "base64"));
        clearPending();
        log(
          JSON.stringify({
            event: "recovery_rollback_completed",
            stage: "startup_recovery",
          }),
        );
      } finally {
        reconciling = false;
        if (!pending()) dispatcher.resume();
      }
    },
    async export() {
      if (pending())
        throw new HttpError(
          409,
          "An interrupted recovery must be repaired before exporting",
        );
      await dispatcher.pause();
      try {
        const worker = await workerRequest("export");
        const web = await storage.exportRecoveryDatabase(store);
        const result = await processArchive({
          operation: "encode",
          web,
          worker,
        });
        const bytes = Buffer.from(result.bytes);
        if (bytes.length > RECOVERY_LIMIT)
          throw new HttpError(413, "Recovery archive exceeds 512 MiB");
        return bytes;
      } finally {
        dispatcher.resume();
      }
    },
    async import(bytes) {
      if (reconciling)
        throw new HttpError(
          409,
          "Interrupted recovery rollback is in progress; retry afterward",
        );
      const files = await processArchive({ operation: "decode", bytes });
      const data = await storage.parseRecoveryDatabase(Buffer.from(files.web));
      await dispatcher.pause();
      try {
        const incoming = Buffer.from(files.worker);
        await workerRequest("validate", incoming);
        const previous = pending()
          ? Buffer.from(readPending(), "base64")
          : await workerRequest("export");
        store.db
          .prepare(
            "INSERT OR REPLACE INTO settings(key,value) VALUES('recovery_pending',?)",
          )
          .run(previous.toString("base64"));
        try {
          await workerRequest("import", incoming);
          return restoreWeb(store, data);
        } catch (error) {
          try {
            await workerRequest("import", previous);
            clearPending();
          } catch {
            log(
              JSON.stringify({
                event: "recovery_rollback_failed",
                category: "recovery_inconsistent",
                stage: "worker_restore",
              }),
            );
            throw new HttpError(
              503,
              "Worker rollback failed; dispatcher stopped. Retry complete recovery before resuming synchronization",
            );
          }
          throw error;
        }
      } finally {
        if (!pending()) dispatcher.resume();
      }
    },
  };
}
