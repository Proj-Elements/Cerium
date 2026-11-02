import { test } from "node:test";
import assert from "node:assert/strict";
import { modelDisplayName } from "../src/model-display.ts";

test("model labels show readable family, version and edition names", () => {
  for (const [id, expected] of [
    ["gpt-6.1-terra", "GPT 6.1 Terra"],
    ["codex-auto-review", "Codex Auto Review"],
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["anthropic/claude-opus-5-5-thinking", "Claude Opus 5.5 Thinking"],
    ["claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet 20241022"],
    ["z-ai/glm-5.3-flash", "GLM 5.3 Flash"],
    ["qwen3.8-27b", "Qwen 3.8 27B"],
    ["gpt-4o-mini", "GPT 4o Mini"],
    ["deepseek-v4-flash", "DeepSeek V4 Flash"],
    ["o3-mini", "o3 Mini"],
  ]) {
    assert.equal(modelDisplayName(id), expected);
  }
});

test("display names never discard meaningful model variants or dates", () => {
  assert.notEqual(
    modelDisplayName("glm-5.3"),
    modelDisplayName("glm-5.3-flash"),
  );
  assert.notEqual(modelDisplayName("qwen3.8"), modelDisplayName("qwen3.8-27b"));
  assert.notEqual(
    modelDisplayName("gpt-6-sol"),
    modelDisplayName("gpt-6.1-sol"),
  );
  assert.match(modelDisplayName("custom-model-20261102"), /20261102$/);
});
