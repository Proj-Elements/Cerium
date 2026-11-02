import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const source =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const tokenModes = new Set([
  "chat",
  "responses",
  "completion",
  "embedding",
  "moderation",
]);
const fields = {
  input: "input_cost_per_token",
  output: "output_cost_per_token",
  cacheRead: "cache_read_input_token_cost",
  cacheWrite: "cache_creation_input_token_cost",
};

export function compactCatalog(raw, fetchedAt = new Date().toISOString()) {
  const upstream = JSON.parse(raw);
  if (!upstream || typeof upstream !== "object" || Array.isArray(upstream))
    throw new Error("Invalid LiteLLM catalog");
  const models = Object.create(null);
  for (const name of Object.keys(upstream).sort()) {
    const record = upstream[name];
    if (
      name === "sample_spec" ||
      !record ||
      typeof record !== "object" ||
      !record.litellm_provider
    )
      continue;
    const price = {
      provider: record.litellm_provider,
      mode: record.mode ?? "unknown",
    };
    if (tokenModes.has(record.mode)) {
      for (const [target, field] of Object.entries(fields)) {
        const value = record[field];
        if (
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= 0 &&
          Number.isFinite(value * 1e6)
        )
          price[target] = Number((value * 1e6).toPrecision(12));
      }
      if (Object.keys(record).some((key) => /cost.*above_/.test(key)))
        price.tiered = true;
    }
    models[name] = price;
  }
  return {
    source,
    fetchedAt,
    sha256: createHash("sha256").update(raw).digest("hex"),
    models,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const input = process.argv[2];
  let raw;
  if (input) raw = await readFile(input, "utf8");
  else {
    const response = await fetch(source, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`LiteLLM returned HTTP ${response.status}`);
    raw = await response.text();
  }
  if (Buffer.byteLength(raw) > 10 << 20)
    throw new Error("LiteLLM catalog exceeds 10 MiB");
  const catalog = compactCatalog(raw);
  if (Object.keys(catalog.models).length < 1000)
    throw new Error("Incomplete LiteLLM catalog; existing snapshot preserved");
  const output = new URL("../src/data/", import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(
    new URL("model-prices.json", output),
    JSON.stringify(catalog) + "\n",
  );
  console.log(
    `Saved ${Object.keys(catalog.models).length} LiteLLM records (${catalog.sha256.slice(0, 12)})`,
  );
}
