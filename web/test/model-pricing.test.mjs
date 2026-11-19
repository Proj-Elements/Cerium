import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createPriceMatcher,
  indexModelPrices,
  modelBrand,
  resolveModelPrice,
} from "../src/model-pricing.ts";
import { compactCatalog } from "../scripts/update-model-prices.mjs";

const record = (provider, input = 1, output = 5, extra = {}) => ({
  provider,
  mode: "chat",
  input,
  output,
  ...extra,
});
const catalog = (models) => ({
  models,
  source: "test",
  fetchedAt: "2026-11-02",
  sha256: "test",
});

test("legacy site prices expose duplicates without selecting the first or last quote", () => {
  const normal = { model: "normal", mode: "tokens", input: 0 };
  const prices = [
    { model: "dup", mode: "tokens", input: 1 },
    { model: " dup ", mode: "tokens", input: 100 },
    { model: "dup", mode: "request", request: 3 },
    normal,
  ];
  const indexed = indexModelPrices(prices);
  assert.equal(indexed.get("dup"), null);
  assert.equal(indexed.get("normal"), normal);
  assert.equal(indexed.get("missing"), undefined);
});

test("complete model and provider-route exact matches always win", () => {
  const match = createPriceMatcher(
    catalog({
      "claude-opus-5-5": record("anthropic", 4, 20),
      "claude-opus-5-5-thinking": record("anthropic", 6, 30),
      "host/claude-opus-5-5": record("host", 2, 10),
    }),
  );
  assert.equal(match("claude-opus-5-5-thinking").price.input, 6);
  assert.equal(match("host/claude-opus-5-5").price.input, 2);
  assert.equal(match("host/claude-opus-5-5").kind, "exact");
});

test("only approved namespaces and Claude thinking/decimal spelling normalize", () => {
  const match = createPriceMatcher(
    catalog({
      "claude-opus-5-5": record("anthropic", 4, 20),
      "zai/glm-5.3": record("zai", 1.4, 4.4),
    }),
  );
  for (const name of [
    "claude-opus-5-5-thinking",
    "Claude-Opus-5.5-thinking",
    "anthropic/claude-opus-5.5",
  ])
    assert.equal(match(name).model, "claude-opus-5-5");
  for (const name of ["z-ai/glm-5.3", "glm-5.3", "ZAI/GLM-5.3"])
    assert.equal(match(name).model, "zai/glm-5.3");
  assert.equal(match("random/glm-5.3"), undefined);
  assert.equal(match("anthropic/glm-5.3"), undefined);
  assert.equal(match("host/zai/glm-5.3"), undefined);
});

test("never drop editions, model sizes, dates, versions or arbitrary suffixes", () => {
  const match = createPriceMatcher(
    catalog({
      "zai/glm-5.3": record("zai"),
      "qwen_ai_platform/qwen3.8": record("qwen_ai_platform"),
      "gpt-6.1-sol": record("openai"),
      "claude-opus-5-5": record("anthropic"),
    }),
  );
  for (const name of [
    "glm-5.3-flash",
    "z-ai/glm-5.3-flash",
    "glm-5.3v",
    "glm-5.4",
    "qwen3.8-27b",
    "qwen/qwen3.8-27b",
    "qwen3.8-a3b",
    "qwen3.8-instruct",
    "gpt-6.1-terra",
    "gpt-6.1",
    "gpt-6.1-sol-2026-09-29",
    "auto/gpt-6.1-sol",
    "claude-opus-5-5-thinking-fast",
    "claude-opus-5-5-thinking-20261101",
    "claude-opus-5-5-1m",
  ])
    assert.equal(match(name), undefined, name);
});

test("ambiguous official quotes and hosted-only prices never become generic defaults", () => {
  const match = createPriceMatcher(
    catalog({
      "dashscope/qwen3.8-max": record("dashscope", 2, 6),
      "qwen_ai_platform/qwen3.8-max": record("qwen_ai_platform", 3, 9),
      "host/qwen3.8-27b": record("host"),
    }),
  );
  assert.equal(match("qwen3.8-max"), undefined);
  assert.equal(match("qwen3.8-27b"), undefined);
  assert.equal(match("dashscope/qwen3.8-max").price.input, 2);
});

test("equivalent official aliases agree, with deterministic selection", () => {
  const match = createPriceMatcher(
    catalog({
      "dashscope/qwen3.8-max": record("dashscope", 2, 6),
      "qwen_ai_platform/qwen3.8-max": record("qwen_ai_platform", 2, 6),
    }),
  );
  assert.equal(match("qwen3.8-max").price.input, 2);
});

test("Z.ai and BigModel retain distinct regional price namespaces", () => {
  const match = createPriceMatcher(
    catalog({
      "zai/glm-5.3": record("zai", 1.4, 4.4),
      "bigmodel/glm-5.3": record("bigmodel", 1.14, 4),
    }),
  );
  assert.equal(match("glm-5.3").price.input, 1.4);
  assert.equal(match("z-ai/glm-5.3").price.input, 1.4);
  assert.equal(match("BigModel/GLM-5.3").price.input, 1.14);
});

test("site prices including zero take precedence; missing sides fall back independently", () => {
  const match = {
    model: "gpt-test",
    kind: "exact",
    price: record("openai", 4, 20),
  };
  const result = resolveModelPrice(
    { mode: "tokens", input: 0, output: null },
    match,
  );
  assert.equal(result.input, 0);
  assert.equal(result.inputDefault, false);
  assert.equal(result.output, 20);
  assert.equal(result.outputDefault, true);
  const reverse = resolveModelPrice(
    { mode: "tokens", input: null, output: 1 },
    match,
  );
  assert.equal(reverse.input, 4);
  assert.equal(reverse.inputDefault, true);
  assert.equal(reverse.output, 1);
  assert.equal(reverse.outputDefault, false);
});

test("dynamic billing keeps its expression and displays defaults, without applying group rates", () => {
  const result = resolveModelPrice(
    { mode: "dynamic", expression: "tokens * factor" },
    {
      model: "claude-opus-5-5",
      kind: "normalized",
      price: record("anthropic", 4, 20),
    },
  );
  assert.equal(result.input, 4);
  assert.equal(result.output, 20);
  assert.equal(result.dynamic, true);
  assert.equal(result.expression, "tokens * factor");
  assert.equal(result.inputDefault, true);
});

test("per-request units never mix with reference token prices; unknown remains unknown", () => {
  assert.deepEqual(
    resolveModelPrice(
      { mode: "request", request: 0 },
      {
        model: "test",
        kind: "exact",
        price: record("openai"),
      },
    ),
    { mode: "request", request: 0 },
  );
  const result = resolveModelPrice({ mode: "dynamic" });
  assert.equal(result.input, undefined);
  assert.equal(result.output, undefined);
  assert.equal(result.dynamic, true);
  assert.equal(result.inputDefault, false);
});

test("reference ingestion preserves zero and missing costs, excluding image/video unit conversions", () => {
  const result = compactCatalog(
    JSON.stringify({
      sample_spec: { litellm_provider: "sample" },
      chat: {
        litellm_provider: "openai",
        mode: "chat",
        input_cost_per_token: 0,
        output_cost_per_token: 2e-6,
        input_cost_per_token_above_200k_tokens: 4e-6,
      },
      invalid: {
        litellm_provider: "openai",
        mode: "chat",
        input_cost_per_token: -1,
        output_cost_per_token: "0.01",
      },
      image: {
        litellm_provider: "openai",
        mode: "image_generation",
        input_cost_per_token: 20,
        output_cost_per_image: 0.1,
      },
    }),
    "2026-11-02",
  );
  assert.equal(result.models.chat.input, 0);
  assert.equal(result.models.chat.output, 2);
  assert.equal(result.models.chat.tiered, true);
  assert.equal(result.models.invalid.input, undefined);
  assert.equal(result.models.invalid.output, undefined);
  assert.equal(result.models.image.input, undefined);
  assert.equal(result.models.sample_spec, undefined);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test("invalid numbers are never displayed as prices", () => {
  for (const bad of [-1, NaN, Infinity, "2"]) {
    const result = resolveModelPrice(
      { mode: "tokens", input: bad },
      { model: "x", kind: "exact", price: record("openai", bad, 1) },
    );
    assert.equal(result.input, undefined);
    assert.equal(result.inputDefault, false);
  }
});

test("matched metadata identifies manufacturers; unmatched families get icons but no inferred prices", () => {
  assert.equal(modelBrand("glm-5.3-flash"), "zai");
  assert.equal(modelBrand("qwen3.8-27b"), "qwen");
  assert.equal(modelBrand("codex-auto-review"), "openai");
  assert.equal(
    modelBrand("custom", {
      model: "zai/glm-5.3",
      price: record("zai"),
      kind: "exact",
    }),
    "zai",
  );
  assert.equal(modelBrand("unknown-custom"), "unknown");
});

test("checked-in LiteLLM snapshot matches the requested real examples without dropping variants", () => {
  const data = JSON.parse(
    readFileSync(new URL("../src/data/model-prices.json", import.meta.url)),
  );
  const match = createPriceMatcher(data);
  assert.ok(Object.keys(data.models).length > 4000);
  assert.equal(match("claude-opus-5-5-thinking").model, "claude-opus-5-5");
  assert.equal(match("z-ai/glm-5.3").model, "zai/glm-5.3");
  assert.notEqual(match("glm-5.3-flash")?.model, "zai/glm-5.3");
  assert.equal(match("qwen3.8-27b"), undefined);
  assert.equal(match("gpt-6.1-sol").kind, "exact");
});
