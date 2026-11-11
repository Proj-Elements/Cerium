import { parentPort, workerData } from "node:worker_threads";
import { backup, DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BACKUP_LIMIT,
  RECOVERY_LIMIT,
  parseBackup,
  readDatabaseData,
} from "./backup.mjs";
import { parseRecoverySnapshot } from "./backup-recovery.mjs";
import { HttpError } from "./validation.mjs";

async function snapshot(sourcePath, run) {
  const dir = mkdtempSync(join(tmpdir(), "cerium-backup-worker-")),
    path = join(dir, "snapshot.db");
  let source;
  try {
    writeFileSync(path, "", { mode: 0o600, flag: "wx" });
    source = new DatabaseSync(sourcePath, {
      readOnly: true,
      allowExtension: false,
    });
    source.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;");
    await backup(source, path);
    source.close();
    source = undefined;
    return await run(path);
  } finally {
    source?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function serialize(path, format, cache) {
  const db = new DatabaseSync(path, { allowExtension: false });
  let omitted = cache === "omit";
  try {
    if (format === "json") {
      let data = readDatabaseData(db, { cache }),
        bytes = Buffer.from(JSON.stringify(data));
      if (!omitted && bytes.length > BACKUP_LIMIT) {
        omitted = true;
        data = readDatabaseData(db, { cache: "omit" });
      }
      if (omitted) {
        data.cache_policy = {
          favicon_cache: "omitted",
          reason: cache === "omit" ? "requested" : "size_limit",
        };
        bytes = Buffer.from(JSON.stringify(data));
      }
      if (bytes.length > BACKUP_LIMIT)
        throw new HttpError(413, "Backup without icon caches exceeds 64 MiB");
      return { bytes, cacheOmitted: omitted };
    }
    db.exec(
      "PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; DELETE FROM jobs; DELETE FROM settings WHERE key NOT IN ('sync_interval_seconds','payment_presets');",
    );
    const insert = db.prepare("INSERT INTO settings(key,value) VALUES(?,?)");
    insert.run("backup_format", "cerium-web-backup");
    insert.run("backup_version", "1");
    insert.run("backup_exported_at", new Date().toISOString());
    const omitIcons = (reason) => {
      db.exec("UPDATE sites SET favicon_blob=NULL,favicon_type=NULL");
      insert.run("backup_icon_cache", "omitted");
      insert.run("backup_icon_cache_reason", reason);
      omitted = true;
    };
    if (omitted) omitIcons("requested");
    db.exec("VACUUM");
    if (!omitted && statSync(path).size > BACKUP_LIMIT) {
      omitIcons("size_limit");
      db.exec("VACUUM");
    }
    if (statSync(path).size > BACKUP_LIMIT)
      throw new HttpError(413, "Backup without icon caches exceeds 64 MiB");
    return { bytes: readFileSync(path), cacheOmitted: omitted };
  } finally {
    db.close();
  }
}

try {
  let result;
  if (workerData.operation === "serialize")
    result = await snapshot(workerData.path, (path) =>
      serialize(path, workerData.format, workerData.cache),
    );
  else if (workerData.operation === "parse")
    result = {
      data: parseBackup(
        Buffer.from(workerData.bytes),
        workerData.format,
        workerData.defaultInterval,
      ),
    };
  else if (workerData.operation === "recovery-export")
    result = await snapshot(workerData.path, (path) => {
      const db = new DatabaseSync(path, { allowExtension: false });
      try {
        db.exec(
          "PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; VACUUM",
        );
      } finally {
        db.close();
      }
      if (statSync(path).size > RECOVERY_LIMIT)
        throw new HttpError(413, "Recovery database exceeds 512 MiB");
      return { bytes: readFileSync(path) };
    });
  else if (workerData.operation === "recovery-parse")
    result = { data: parseRecoverySnapshot(Buffer.from(workerData.bytes)) };
  else throw new Error("Unsupported backup operation");
  if (result.bytes) {
    const bytes = Uint8Array.from(result.bytes);
    parentPort.postMessage({ ...result, bytes }, [bytes.buffer]);
  } else parentPort.postMessage(result);
} catch (error) {
  parentPort.postMessage({
    error: {
      status: error instanceof HttpError ? error.status : 500,
      message:
        error instanceof HttpError ? error.message : "Backup processing failed",
    },
  });
}
