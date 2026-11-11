import { test } from "node:test";
import assert from "node:assert/strict";
import { formatNumber } from "../src/number-format.ts";

test("tiny positive prices remain visibly nonzero and retain meaningful precision", () => {
  for (const price of [0.0000001, 0.0000001234567, 1e-20, Number.MIN_VALUE]) {
    const formatted = formatNumber(price);
    assert.notEqual(formatted, "0");
    assert.ok(Number(formatted.replaceAll(",", "")) > 0);
  }
  assert.equal(formatNumber(0.0000001), "0.0000001");
  assert.equal(formatNumber(0.0000001234567), "0.000000123457");
  assert.equal(formatNumber(-0.0000001), "-0.0000001");
  assert.equal(formatNumber(-1e-20), "-1E-20");
});

test("zero and ordinary prices retain the established display while nonfinite values stay unknown", () => {
  assert.equal(formatNumber(0), "0");
  assert.equal(formatNumber(1.23456789), "1.234568");
  assert.equal(formatNumber(1000), "1,000");
  assert.equal(formatNumber(NaN), "—");
  assert.equal(formatNumber(Infinity), "—");
  assert.equal(formatNumber(null), "—");
});
