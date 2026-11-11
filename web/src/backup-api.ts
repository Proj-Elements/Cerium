import { APIError, clearAPICache } from "./api.ts";

export type BackupFormat = "json" | "sqlite";
export type ImportMode = "merge" | "replace";
export type ImportResult = {
  imported: number;
  removed: number;
  interval: number;
};
export const BACKUP_LIMIT = 64 << 20;
export const RECOVERY_LIMIT = 512 << 20;
export type RecoveryResult = {
  restored: boolean;
  sites: number;
  jobs: number;
  admin_path: string;
};

async function request(path: string, contentType: string, file?: File) {
  if (file) clearAPICache();
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    signal: AbortSignal.timeout(
      contentType === "application/gzip" ? 180000 : 60000,
    ),
    headers: {
      "X-Cerium-Admin": "1",
      "Content-Type": contentType,
    },
    body: file,
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new APIError(
      response.status,
      result.error ?? "备份操作失败，请稍后重试",
    );
  }
  return response;
}
async function download(response: Response, fallbackName: string) {
  const blob = await response.blob(),
    url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download =
    response.headers
      .get("Content-Disposition")
      ?.match(/filename="([\w.-]+)"/)?.[1] ?? fallbackName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function downloadBackup(
  base: string,
  format: BackupFormat,
  includeCache = true,
) {
  const response = await request(
    `${base}/data/export?format=${format}${includeCache ? "" : "&cache=omit"}`,
    format === "json" ? "application/json" : "application/vnd.sqlite3",
  );
  await download(response, `cerium-web.${format === "json" ? "json" : "db"}`);
  return {
    cacheOmitted: response.headers.get("X-Cerium-Backup-Cache") === "omitted",
  };
}
export async function uploadBackup(
  base: string,
  format: BackupFormat,
  mode: ImportMode,
  file: File,
): Promise<ImportResult> {
  if (file.size > BACKUP_LIMIT) throw new Error("备份文件不能超过 64 MiB");
  if (!file.size) throw new Error("备份文件为空");
  return (
    await request(
      `${base}/data/import?format=${format}&mode=${mode}`,
      format === "json" ? "application/json" : "application/vnd.sqlite3",
      file,
    )
  ).json();
}
export async function downloadRecovery(base: string) {
  const response = await request(
    `${base}/data/recovery/export`,
    "application/gzip",
  );
  await download(response, "cerium-recovery.json.gz");
}
export async function uploadRecovery(
  base: string,
  file: File,
): Promise<RecoveryResult> {
  if (!file.size) throw new Error("恢复文件为空");
  if (file.size > RECOVERY_LIMIT) throw new Error("恢复文件不能超过 512 MiB");
  return (
    await request(`${base}/data/recovery/import`, "application/gzip", file)
  ).json();
}
