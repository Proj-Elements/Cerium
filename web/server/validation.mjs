export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (message) => {
  throw new HttpError(400, message);
};
export function syncInterval(value) {
  if (!Number.isSafeInteger(value) || value < 60 || value > 31536000)
    fail("Sync interval must be an integer between 60 and 31536000 seconds");
  return value;
}
export function text(value, max = 200, required = false) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    fail("Invalid text field");
  return value.trim();
}
export function number(value, nullable = true) {
  if (nullable && (value === null || value === undefined || value === ""))
    return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1e12
  )
    fail("Invalid numeric field");
  return value;
}
export function url(value, optional = false) {
  if (optional && !value) return "";
  let u;
  try {
    u = new URL(text(value, 2048, true));
  } catch {
    fail("Invalid URL");
  }
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.hash ||
    u.search
  )
    fail("Use an http(s) URL without credentials, query or fragment");
  return u.href.replace(/\/$/, "");
}
export function favicon(input, siteURL) {
  if (input == null) return null;
  if (
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.url !== siteURL ||
    !Array.isArray(input.icons) ||
    input.icons.length > 12 ||
    typeof input.selected !== "string"
  )
    fail("Invalid saved favicon discovery");
  const iconURL = (value) => {
    let candidate;
    try {
      candidate = new URL(text(value, 2048, true));
    } catch {
      fail("Invalid favicon URL");
    }
    if (
      !["http:", "https:"].includes(candidate.protocol) ||
      candidate.username ||
      candidate.password ||
      candidate.hash
    )
      fail("Use an http(s) favicon URL without credentials or fragment");
    return candidate.href;
  };
  const icons = input.icons.map(iconURL),
    selected = input.selected ? iconURL(input.selected) : "";
  if (
    new Set(icons).size !== icons.length ||
    (selected && !icons.includes(selected))
  )
    fail("Selected favicon must be one of the unique candidates");
  if (
    input.checked_at !== undefined &&
    (typeof input.checked_at !== "string" ||
      !Number.isFinite(Date.parse(input.checked_at)) ||
      Date.parse(input.checked_at) > Date.now() + 300000)
  )
    fail("Invalid favicon discovery timestamp");
  return {
    url: siteURL,
    icons,
    selected,
    ...(input.checked_at !== undefined ? { checked_at: input.checked_at } : {}),
  };
}
export function catalog(input, scope = "public") {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.scope !== scope ||
    !Array.isArray(input.groups) ||
    input.groups.length > 500
  )
    fail("Expected an explicitly public catalog");
  const ids = new Set();
  return {
    scope,
    groups: input.groups.map((g) => {
      if (!g || typeof g !== "object" || Array.isArray(g))
        fail("Invalid catalog group");
      const id = text(g.id, 200, true);
      if (ids.has(id)) fail("Duplicate group");
      ids.add(id);
      if (
        g.models != null &&
        (!Array.isArray(g.models) || g.models.length > 10000)
      )
        fail("Too many models");
      if (
        g.prices != null &&
        (!Array.isArray(g.prices) || g.prices.length > 10000)
      )
        fail("Too many prices");
      return {
        id,
        name: text(g.name, 200, true),
        description: text(g.description ?? "", 2000),
        platform: text(g.platform ?? "", 100),
        multiplier: number(g.multiplier),
        multiplier_source: text(g.multiplier_source ?? "unknown", 100),
        models_known: g.models_known === true,
        models_source: g.models_source === "gateway_once" ? "gateway_once" : "",
        models_fetched_at:
          g.models_source === "gateway_once" &&
          Number.isFinite(Date.parse(g.models_fetched_at))
            ? g.models_fetched_at
            : "",
        models: [...new Set((g.models ?? []).map((m) => text(m, 300, true)))],
        prices: (g.prices ?? []).map((p) => {
          if (!p || typeof p !== "object" || Array.isArray(p))
            fail("Invalid model price");
          return {
            model: text(p.model, 300, true),
            mode: ["tokens", "request", "dynamic", "unknown"].includes(p.mode)
              ? p.mode
              : "unknown",
            input: number(p.input),
            output: number(p.output),
            cache_read: number(p.cache_read),
            cache_write: number(p.cache_write),
            request: number(p.request),
            expression: text(p.expression ?? "", 16000),
          };
        }),
      };
    }),
  };
}
export function site(input, previous) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("Invalid site");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    fail("Site visibility must be a boolean");
  if (
    input.monitor_changes != null &&
    typeof input.monitor_changes !== "boolean"
  )
    fail("Invalid change-monitoring setting");
  const type = input.type;
  if (!["newapi", "sub2api", "others"].includes(type))
    fail("Unsupported site type");
  const auth_mode =
    type === "newapi"
      ? (input.auth_mode ?? previous?.auth_mode ?? "password")
      : "password";
  if (
    !["password", "token"].includes(auth_mode) ||
    (type !== "newapi" && input.auth_mode === "token")
  )
    fail("Access-token authentication is only supported for NewAPI");
  let account = "",
    password = "",
    access_token = "",
    user_id = 0;
  if (auth_mode === "token") {
    access_token =
      input.access_token === "" || input.access_token === undefined
        ? (previous?.access_token ?? "")
        : input.access_token;
    access_token = text(access_token, 16384, true).replace(
      /^Bearer(?: +|$)/i,
      "",
    );
    user_id = input.user_id ?? previous?.user_id;
    if (
      !access_token ||
      /[^\x21-\x7e]/.test(access_token) ||
      !Number.isSafeInteger(user_id) ||
      user_id <= 0
    )
      fail("A panel access token and positive integer user ID are required");
  } else if (type !== "others") {
    password =
      input.password === "" || input.password === undefined
        ? (previous?.password ?? "")
        : input.password;
    if (typeof password !== "string" || password.length > 4096)
      fail("Invalid password");
    account = text(input.account ?? "", 320, true);
    if (!password) fail("Account and password are required");
  }
  if (
    !Array.isArray(input.payment_methods) ||
    input.payment_methods.length > 12
  )
    fail("Invalid payment methods");
  const cny = number(input.recharge_cny),
    usd = number(input.recharge_usd);
  if (
    (cny === null) !== (usd === null) ||
    (cny !== null && (cny <= 0 || usd <= 0))
  )
    fail("Recharge CNY and USD must both be positive");
  return {
    name: text(input.name, 100, true),
    url: url(input.url),
    type,
    account,
    password,
    auth_mode,
    access_token,
    user_id,
    icon: url(input.icon, true),
    description: text(input.description ?? "", 600),
    recharge_multiplier: number(input.recharge_multiplier),
    recharge_cny: cny,
    recharge_usd: usd,
    payment_methods: [
      ...new Set(input.payment_methods.map((m) => text(m, 40, true))),
    ],
    payment_note: text(input.payment_note ?? "", 600),
    enabled: input.enabled !== false,
    monitor_changes: input.monitor_changes ?? previous?.monitor_changes ?? true,
    manual_catalog:
      type === "others"
        ? catalog(
            { scope: "manual", groups: input.manual_catalog?.groups ?? [] },
            "manual",
          )
        : null,
  };
}
