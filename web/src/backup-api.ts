import { APIError } from "./api";

export type BackupFormat = "json" | "sqlite";
export type ImportMode = "merge" | "replace";
export type ImportResult = {
  imported: number;
  removed: number;
  interval: number;
};
export const BACKUP_LIMIT = 64 << 20;

async function request(path: string, format: BackupFormat, file?: File) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    signal: AbortSignal.timeout(60000),
    headers: {
      "X-Cerium-Admin": "1",
      "Content-Type":
        format === "json" ? "application/json" : "application/vnd.sqlite3",
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
export async function downloadBackup(base: string, format: BackupFormat) {
  const response = await request(
      `${base}/data/export?format=${format}`,
      format,
    ),
    blob = await response.blob(),
    url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download =
    response.headers
      .get("Content-Disposition")
      ?.match(/filename="([\w.-]+)"/)?.[1] ??
    `cerium-web.${format === "json" ? "json" : "db"}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      format,
      file,
    )
  ).json();
}
