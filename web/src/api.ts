export class APIError extends Error {
  status: number;
  context?: { category?: string; stage?: string; request_id?: string };
  constructor(
    status: number,
    message: string,
    context?: { category?: string; stage?: string; request_id?: string },
  ) {
    super(message);
    this.status = status;
    this.context = context;
  }
}
type RequestOptions = { signal?: AbortSignal; conditional?: boolean };
type CachedResponse = { etag: string; value: unknown };
const responses = new Map<string, CachedResponse>();
const pending = new Map<string, Promise<unknown>>();
let generation = 0;

export function clearAPICache() {
  generation++;
  responses.clear();
  pending.clear();
}

export function api<T>(
  path: string,
  method = "GET",
  data?: unknown,
  timeout = 15000,
  options: RequestOptions = {},
): Promise<T> {
  const key = `${path}:${timeout}:${options.conditional === true}`;
  if (method !== "GET") clearAPICache();
  if (method !== "GET" || options.signal)
    return request<T>(path, method, data, timeout, options);
  const previous = pending.get(key);
  if (previous) return previous as Promise<T>;
  const result = request<T>(path, method, data, timeout, options);
  pending.set(key, result);
  void result
    .finally(() => {
      if (pending.get(key) === result) pending.delete(key);
    })
    .catch(() => {});
  return result;
}

async function request<T>(
  path: string,
  method: string,
  data: unknown,
  timeout: number,
  options: RequestOptions,
): Promise<T> {
  const epoch = generation,
    cached =
      method === "GET" && options.conditional ? responses.get(path) : undefined,
    signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout);
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    signal,
    headers:
      method === "GET"
        ? cached
          ? { "If-None-Match": cached.etag }
          : {}
        : { "Content-Type": "application/json", "X-Cerium-Admin": "1" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (response.status === 304 && cached) return cached.value as T;
  const parsed = await response.json().catch(() => ({}));
  const result = parsed && typeof parsed === "object" ? parsed : {};
  if (!response.ok)
    throw new APIError(
      response.status,
      result.error === "Invalid origin"
        ? "访问地址与服务配置不匹配，请检查 PUBLIC_ORIGIN；本地访问请使用同端口的 localhost 或 127.0.0.1。"
        : typeof result.error === "string"
          ? result.error
          : `请求失败（HTTP ${response.status}）`,
      {
        category: result.category,
        stage: result.stage,
        request_id: result.request_id,
      },
    );
  const etag = response.headers.get("ETag");
  if (method === "GET" && options.conditional && etag && epoch === generation)
    responses.set(path, { etag, value: result });
  return result as T;
}
export function message(error: unknown) {
  if (error instanceof APIError && error.context?.request_id)
    return `${error.message}（请求编号：${error.context.request_id}）`;
  return error instanceof Error ? error.message : "请求失败，请稍后重试";
}
