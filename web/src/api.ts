export class APIError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    signal: AbortSignal.timeout(15000),
    headers:
      method === "GET"
        ? {}
        : { "Content-Type": "application/json", "X-Cerium-Admin": "1" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok)
    throw new APIError(
      response.status,
      result.error === "Invalid origin"
        ? "访问地址与服务配置不匹配，请检查 PUBLIC_ORIGIN；本地访问请使用同端口的 localhost 或 127.0.0.1。"
        : (result.error ?? "请求失败"),
    );
  return result;
}
export function message(error: unknown) {
  return error instanceof Error ? error.message : "请求失败，请稍后重试";
}
