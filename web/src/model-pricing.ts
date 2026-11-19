import type { Price } from "./types";

export type ReferencePrice = {
  provider: string;
  mode: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tiered?: boolean;
};
export type ReferenceCatalog = {
  source: string;
  fetchedAt: string;
  sha256: string;
  models: Record<string, ReferencePrice>;
};
export type ReferenceMatch = {
  model: string;
  price: ReferencePrice;
  kind: "exact" | "normalized";
};

const brands = [
  [
    "openai",
    /^(?:gpt(?:-|\d)|o[1-9](?:-|$)|chatgpt-|codex(?:-|$)|dall-e|text-embedding-|whisper-|tts-)/,
  ],
  ["anthropic", /^claude(?:-|$)/],
  ["google", /^(?:gemini|gemma)(?:-|\d)/],
  ["zai", /^glm(?:-|\d)/],
  ["qwen", /^qwen(?:-|\d)/],
  ["deepseek", /^deepseek(?:-|$)/],
  ["moonshot", /^(?:kimi|moonshot)(?:-|\d|$)/],
  ["minimax", /^minimax(?:-|\d|$)/],
  [
    "mistral",
    /^(?:mistral|mixtral|codestral|pixtral|ministral|devstral|magistral|voxtral)(?:-|\d|$)/,
  ],
  ["xai", /^grok(?:-|\d|$)/],
  ["meta", /^(?:meta-)?llama(?:-|\d|\.)/],
  [
    "cohere",
    /^(?:command|embed-(?:english|multilingual)|rerank-(?:english|multilingual|v\d))(?:-|\d|$)/,
  ],
  ["perplexity", /^sonar(?:-|$)/],
  ["bytedance", /^(?:doubao|seed)(?:-|\d|$)/],
  ["stepfun", /^step(?:-|\d)/],
  ["tencent", /^hunyuan(?:-|\d|$)/],
  ["xiaomi", /^mimo(?:-|\d|$)/],
  ["ai21", /^jamba(?:-|\d|$)/],
] as const;

const namespaces: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  gemini: "google",
  "z-ai": "zai",
  zai: "zai",
  "zai-org": "zai",
  zhipu: "zai",
  bigmodel: "zai",
  qwen: "qwen",
  dashscope: "qwen",
  qwen_ai_platform: "qwen",
  qwencloud: "qwen",
  deepseek: "deepseek",
  "deepseek-ai": "deepseek",
  moonshot: "moonshot",
  moonshotai: "moonshot",
  minimax: "minimax",
  minimaxai: "minimax",
  mistral: "mistral",
  mistralai: "mistral",
  xai: "xai",
  "x-ai": "xai",
  "meta-llama": "meta",
  cohere: "cohere",
  perplexity: "perplexity",
  stepfun: "stepfun",
};
const officialProviders: Record<string, string[]> = {
  openai: ["openai", "text-completion-openai"],
  anthropic: ["anthropic"],
  google: ["gemini"],
  zai: ["zai", "bigmodel"],
  qwen: ["dashscope", "qwen_ai_platform", "qwencloud"],
  deepseek: ["deepseek"],
  moonshot: ["moonshot"],
  minimax: ["minimax"],
  mistral: ["mistral", "codestral", "text-completion-codestral"],
  xai: ["xai"],
  meta: ["meta", "meta_llama"],
  cohere: ["cohere", "cohere_chat"],
  perplexity: ["perplexity"],
  bytedance: ["volcengine"],
  tencent: ["tencent"],
  xiaomi: ["xiaomi_mimo"],
  ai21: ["ai21"],
};
const namespaceProviders: Record<string, string[]> = {
  "z-ai": ["zai"],
  zai: ["zai"],
  "zai-org": ["zai"],
  bigmodel: ["bigmodel"],
  zhipu: ["bigmodel"],
  dashscope: ["dashscope"],
  qwen_ai_platform: ["qwen_ai_platform"],
  qwencloud: ["qwencloud"],
};

function bareBrand(model: string) {
  return brands.find(([, pattern]) => pattern.test(model))?.[0];
}

function canonical(model: string): string | undefined {
  let name = model.trim().toLowerCase();
  if (name.includes("/")) {
    const [prefix, tail, extra] = name.split("/");
    if (
      extra != null ||
      !namespaces[prefix] ||
      bareBrand(tail) !== namespaces[prefix]
    )
      return;
    name = tail;
  }
  // Only Claude's documented decimal spelling is interchangeable; editions,
  // dates, parameter counts and all other suffixes remain part of the identity.
  return name.replace(
    /^(claude-(?:opus|sonnet|haiku)-\d+)[.-](\d+)(?=-|$)/,
    "$1-$2",
  );
}

export function modelBrand(model: string, reference?: ReferenceMatch): string {
  const name = (reference?.model ?? model).toLowerCase();
  const family = name
    .split(/[/:]/)
    .map((part) =>
      bareBrand(
        part.replace(/^(?:global\.|us\.|eu\.)?(?:anthropic|openai)\./, ""),
      ),
    )
    .find(Boolean);
  if (family) return family;
  const provider = reference?.price.provider;
  return (
    Object.entries(officialProviders).find(([, providers]) =>
      provider ? providers.includes(provider) : false,
    )?.[0] ?? "unknown"
  );
}

function signature(price: ReferencePrice) {
  return JSON.stringify([
    price.mode,
    price.input,
    price.output,
    price.cacheRead,
    price.cacheWrite,
    Boolean(price.tiered),
  ]);
}

export function createPriceMatcher(catalog: ReferenceCatalog) {
  const normalized = new Map<string, ReferenceMatch[]>();
  for (const [model, price] of Object.entries(catalog.models)) {
    const key = canonical(model);
    const brand = key && bareBrand(key);
    if (!key || !brand || !officialProviders[brand]?.includes(price.provider))
      continue;
    const candidate: ReferenceMatch = { model, price, kind: "normalized" };
    const candidates = normalized.get(key) ?? [];
    candidates.push(candidate);
    normalized.set(key, candidates);
  }
  return (model: string): ReferenceMatch | undefined => {
    const name = model.trim();
    if (Object.hasOwn(catalog.models, name))
      return { model: name, price: catalog.models[name], kind: "exact" };
    const key = canonical(name);
    if (!key) return;
    const namespace = name.includes("/")
      ? name.split("/")[0].toLowerCase()
      : "";
    // Z.ai's international USD catalog is the bare GLM default; BigModel's
    // regional quote is retained only for an explicit BigModel namespace.
    const providers =
      namespaceProviders[namespace] ??
      (bareBrand(key) === "zai" ? ["zai"] : undefined);
    function choose(key: string) {
      const candidates = (normalized.get(key) ?? []).filter(
        (entry) => !providers || providers.includes(entry.price.provider),
      );
      const first = candidates[0];
      // Conflicting official quotes are ambiguous, not a cheapest-price search.
      return first &&
        candidates.every(
          (entry) => signature(entry.price) === signature(first.price),
        )
        ? first
        : undefined;
    }
    if (normalized.has(key)) return choose(key);
    if (/^claude-(?:opus|sonnet|haiku)-\d[\d.-]*-thinking$/.test(key))
      return choose(key.replace(/-thinking$/, ""));
  };
}

export const validPrice = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Legacy snapshots may contain duplicates; null prevents either quote winning. */
export function indexModelPrices(prices: Price[] = []) {
  const result = new Map<string, Price | null>();
  for (const price of prices) {
    const model = price.model.trim();
    result.set(model, result.has(model) ? null : price);
  }
  return result;
}

export function resolveModelPrice(
  site: Price | undefined,
  match?: ReferenceMatch,
) {
  const reference = match?.price;
  if (site?.mode === "request")
    return {
      mode: "request" as const,
      request: validPrice(site.request) ? site.request : undefined,
    };
  const input =
    site?.mode === "tokens" && validPrice(site.input) ? site.input : undefined;
  const output =
    site?.mode === "tokens" && validPrice(site.output)
      ? site.output
      : undefined;
  return {
    mode: "tokens" as const,
    input:
      input ?? (validPrice(reference?.input) ? reference.input : undefined),
    output:
      output ?? (validPrice(reference?.output) ? reference.output : undefined),
    inputDefault: input == null && validPrice(reference?.input),
    outputDefault: output == null && validPrice(reference?.output),
    dynamic: site?.mode === "dynamic",
    expression: site?.expression,
  };
}
