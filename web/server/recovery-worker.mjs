import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  RECOVERY_WEB_LIMIT,
  RECOVERY_WORKER_LIMIT,
  RECOVERY_INFLATED_LIMIT,
  RECOVERY_HEADER,
} from "./recovery-limits.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const components = [
  ["web", "sqlite", RECOVERY_WEB_LIMIT],
  ["worker", "cerium-worker-recovery", RECOVERY_WORKER_LIMIT],
];
try {
  if (workerData.operation === "encode") {
    const web = Buffer.from(workerData.web),
      worker = Buffer.from(workerData.worker);
    if (
      web.length > RECOVERY_WEB_LIMIT ||
      worker.length > RECOVERY_WORKER_LIMIT
    )
      throw new Error("Recovery component exceeds its size limit");
    const manifest = {
      format: "cerium-recovery",
      version: 2,
      created_at: new Date().toISOString(),
      components: {
        web: { format: "sqlite", size: web.length, sha256: digest(web) },
        worker: {
          format: "cerium-worker-recovery",
          size: worker.length,
          sha256: digest(worker),
        },
      },
    };
    const raw = Buffer.concat([
      Buffer.from(RECOVERY_HEADER),
      Buffer.from(JSON.stringify(manifest) + "\n"),
      web,
      worker,
    ]);
    if (raw.length > RECOVERY_INFLATED_LIMIT)
      throw new Error("Recovery archive exceeds the uncompressed limit");
    parentPort.postMessage({ bytes: gzipSync(raw) });
  } else {
    const raw = gunzipSync(Buffer.from(workerData.bytes), {
      maxOutputLength: RECOVERY_INFLATED_LIMIT,
    });
    let manifest,
      offset = 0;
    if (
      raw.subarray(0, RECOVERY_HEADER.length).toString("utf8") ===
      RECOVERY_HEADER
    ) {
      const end = raw.indexOf(10, RECOVERY_HEADER.length);
      if (end < 0 || end - RECOVERY_HEADER.length > 65536)
        throw new Error("Invalid recovery manifest");
      manifest = JSON.parse(
        raw.subarray(RECOVERY_HEADER.length, end).toString("utf8"),
      );
      if (manifest.version !== 2)
        throw new Error("Invalid recovery manifest version");
      offset = end + 1;
    } else {
      manifest = JSON.parse(raw.toString("utf8"));
      if (manifest.version !== 1)
        throw new Error("Invalid recovery archive version");
    }
    if (manifest.format !== "cerium-recovery" || !manifest.components)
      throw new Error("Expected a Cerium recovery archive");
    const files = {};
    for (const [name, format, limit] of components) {
      const entry = manifest.components[name];
      if (
        entry?.format !== format ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > limit ||
        typeof entry.sha256 !== "string" ||
        !/^[\da-f]{64}$/.test(entry.sha256)
      )
        throw new Error(`Invalid ${name} recovery component`);
      let bytes;
      if (manifest.version === 2) {
        bytes = raw.subarray(offset, offset + entry.size);
        offset += entry.size;
      } else {
        if (
          typeof entry.data !== "string" ||
          entry.data.length > Math.ceil(limit / 3) * 4
        )
          throw new Error(`Invalid ${name} recovery component`);
        bytes = Buffer.from(entry.data, "base64");
        if (bytes.toString("base64") !== entry.data)
          throw new Error(`Invalid ${name} recovery encoding`);
      }
      if (bytes.length !== entry.size || digest(bytes) !== entry.sha256)
        throw new Error(`Recovery ${name} checksum or size does not match`);
      files[name] = bytes;
    }
    if (manifest.version === 2 && offset !== raw.length)
      throw new Error("Unexpected trailing recovery data");
    parentPort.postMessage(files);
  }
} catch (error) {
  parentPort.postMessage({
    error:
      error instanceof SyntaxError || error.code
        ? "Invalid or oversized recovery archive"
        : error.message,
  });
}
