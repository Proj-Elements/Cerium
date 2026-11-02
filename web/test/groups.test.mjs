import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fixedRate,
  groupFamilies,
  matchesGroup,
  minimumRate,
  rateMaximum,
} from "../src/groups.ts";

const group = (id, multiplier, extra = {}) => ({
  id,
  name: id,
  multiplier,
  models: [],
  models_known: true,
  ...extra,
});

test("upstream platforms are authoritative; model evidence identifies mixed NewAPI groups", () => {
  assert.deepEqual(
    groupFamilies(
      group("GPT 名称", 1, { platform: "anthropic", models: ["gpt-5"] }),
    ),
    ["anthropic"],
  );
  assert.deepEqual(
    groupFamilies(
      group("Claude 名称", 1, {
        platform: "openai",
        models: ["claude-sonnet"],
      }),
    ),
    ["openai"],
  );
  assert.deepEqual(
    groupFamilies(
      group("mixed", 1, {
        models: ["claude-sonnet-4-5", "gpt-5.2", "gemini-3-pro", "gpt-4"],
      }),
    ),
    ["anthropic", "openai", "gemini"],
  );
  assert.deepEqual(groupFamilies(group("Codex 专线", 1)), ["openai"]);
  assert.deepEqual(groupFamilies(group("undocumented", 1)), ["other"]);
  assert.deepEqual(
    groupFamilies(group("Claude label", 1, { platform: "composite" })),
    ["other"],
  );
});

test("inclusive rate filters preserve zero and handle dynamic, unknown and decimal bounds", () => {
  assert.equal(matchesGroup(group("zero", 0), "all", [0, 0]), true);
  assert.equal(matchesGroup(group("g", 0.1 + 0.2), "all", [0.3, 0.3]), true);
  assert.equal(matchesGroup(group("unknown", null), "all", [0, 2]), false);
  assert.equal(matchesGroup(group("unknown", null), "all", null), true);
  assert.equal(
    matchesGroup(
      group("auto", 0.5, { multiplier_source: "auto" }),
      "all",
      [0, 2],
    ),
    false,
  );
  assert.equal(fixedRate(group("nan", Number.NaN)), null);
});

test("platform and rate must match the same group, with independent group-name search", () => {
  const groups = [
    group("GPT 高价", 3, { platform: "openai" }),
    group("Claude 低价", 0.4, { platform: "anthropic" }),
  ];
  assert.equal(
    groups.some((g) => matchesGroup(g, "openai", [0, 1])),
    false,
  );
  assert.equal(
    matchesGroup(groups[1], "anthropic", [0.4, 0.4], "  CLAUDE  "),
    true,
  );
  assert.equal(matchesGroup(groups[1], "anthropic", [0, 1], "missing"), false);
});

test("range domains cover live values and active bounds without large spread calls", () => {
  assert.equal(rateMaximum([group("g", 2.01)]), 3);
  assert.equal(rateMaximum([], [0, 8]), 8);
  assert.equal(
    rateMaximum(Array.from({ length: 100000 }, () => group("g", 2.8))),
    3,
  );
  assert.equal(
    minimumRate([
      group("zero", 0),
      group("auto", 0, { multiplier_source: "auto" }),
    ]),
    0,
  );
  assert.equal(minimumRate([group("unknown", null)]), null);
  assert.equal(
    minimumRate(Array.from({ length: 200000 }, () => group("g", 0.8))),
    0.8,
  );
});
