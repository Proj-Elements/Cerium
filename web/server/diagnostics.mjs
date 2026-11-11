import { randomUUID } from "node:crypto";

const token = (value) =>
  typeof value === "string" && /^[a-z][a-z\d_-]{0,79}$/i.test(value)
    ? value
    : undefined;

export function diagnostic(error, stage, requestId = randomUUID()) {
  const code = token(error?.code);
  const status = error?.status ?? (code === "ENOENT" ? 404 : 500);
  const category =
    token(error?.category) ??
    (status < 500
      ? "request_rejected"
      : code?.startsWith("SQLITE") || code?.startsWith("ERR_SQLITE")
        ? "storage_failure"
        : error?.name === "TimeoutError" || error?.name === "AbortError"
          ? "upstream_timeout"
          : error instanceof TypeError
            ? "upstream_unavailable"
            : "internal_failure");
  return { request_id: requestId, category, stage, ...(code ? { code } : {}) };
}

export function workerDiagnostic(status, value, jobId) {
  return {
    category:
      token(value?.code) ??
      (status >= 500 ? "worker_failure" : "worker_rejected"),
    stage: token(value?.stage) ?? "worker_response",
    job_id: jobId,
    status,
  };
}
