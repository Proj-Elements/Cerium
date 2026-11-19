import type { Directory } from "./types";

export class APIError extends Error {
  status: number;
  context?: {
    category?: string;
    stage?: string;
    request_id?: string;
    code?: string;
  };
  constructor(
    status: number,
    message: string,
    context?: {
      category?: string;
      stage?: string;
      request_id?: string;
      code?: string;
    },
  ) {
    super(message);
    this.status = status;
    this.context = context;
  }
}
type RequestOptions = {
  signal?: AbortSignal;
  conditional?: boolean;
  validate?: (value: unknown) => void;
};
type CachedResponse = { etag: string; value: unknown };
const responses = new Map<string, CachedResponse>();
const pending = new Map<
  string,
  { validate: RequestOptions["validate"]; promise: Promise<unknown> }
>();
let generation = 0;

const invalidResponse = () =>
  new APIError(502, "服务返回了结构不完整的数据，请稍后重试。", {
    category: "invalid_response",
    stage: "response_shape",
  });

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Check the directory envelope before it can replace or enter the API cache. */
export function assertDirectory(value: unknown): asserts value is Directory {
  if (
    !object(value) ||
    !Array.isArray(value.sites) ||
    !value.sites.every(object) ||
    !Array.isArray(value.changes) ||
    !value.changes.every(object) ||
    !Number.isSafeInteger(value.interval) ||
    (value.interval as number) < 60
  )
    throw invalidResponse();
}

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
  if (previous && previous.validate === options.validate)
    return previous.promise as Promise<T>;
  const result = request<T>(path, method, data, timeout, options);
  pending.set(key, { validate: options.validate, promise: result });
  void result
    .finally(() => {
      if (pending.get(key)?.promise === result) pending.delete(key);
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
  if (response.status === 304 && cached) {
    try {
      options.validate?.(cached.value);
    } catch (error) {
      if (responses.get(path) === cached) responses.delete(path);
      throw error;
    }
    return cached.value as T;
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (response.ok)
      throw new APIError(502, "服务返回了无法解析的数据，请稍后重试。", {
        category: "invalid_response",
        stage: "response_body",
      });
    parsed = null;
  }
  const result = object(parsed) ? parsed : {};
  const textValue = (value: unknown) =>
    typeof value === "string" ? value : undefined;
  if (!response.ok)
    throw new APIError(
      response.status,
      result.error === "Invalid origin"
        ? "访问地址与服务配置不匹配，请检查 PUBLIC_ORIGIN；本地访问请使用同端口的 localhost 或 127.0.0.1。"
        : typeof result.error === "string"
          ? result.error
          : `请求失败（HTTP ${response.status}）`,
      {
        category: textValue(result.category),
        stage: textValue(result.stage),
        request_id: textValue(result.request_id),
        code: textValue(result.code),
      },
    );
  if (!object(parsed)) throw invalidResponse();
  options.validate?.(parsed);
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
