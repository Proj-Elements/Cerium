import { test } from "node:test";
import assert from "node:assert/strict";
import { changeSummary, priceDescription } from "../src/change-display.ts";

test("model notices distinguish additions, removals and price changes", () => {
  assert.equal(
    changeSummary({
      kind: "models",
      models_added: ["gpt-6"],
      models_removed: ["gpt-5", "gpt-4"],
    }),
    "新增 1 个模型 · 移除 2 个模型",
  );
  assert.equal(
    changeSummary({ kind: "models", models_removed: ["gpt-4"] }),
    "移除 1 个模型",
  );
  assert.equal(
    changeSummary({ kind: "prices", price_changes: [{ model: "gpt-6" }] }),
    "1 个模型价格调整",
  );
});

test("price notices preserve zero, tiny amounts, billing units and dynamic expressions", () => {
  assert.match(
    priceDescription({ mode: "tokens", input: 0, output: 1e-7 }),
    /输入 \$0 · 输出 \$0\.0000001/,
  );
  assert.match(
    priceDescription({
      mode: "tokens",
      input: null,
      output: 2,
      cache_read: 0.5,
    }),
    /输入 未公开.*缓存读 \$0\.5.*百万 tokens/,
  );
  assert.equal(
    priceDescription({ mode: "request", request: 0.1 }),
    "$0.1 / 次",
  );
  assert.equal(
    priceDescription({ mode: "dynamic", expression: "tokens * 2" }),
    "动态：tokens * 2",
  );
  assert.equal(priceDescription(null), "价格未公开");
  assert.equal(priceDescription({ mode: "unknown" }), "价格未公开");
});
