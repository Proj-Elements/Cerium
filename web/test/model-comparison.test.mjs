import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareModelCosts,
  comparisonModels,
} from "../src/model-comparison.ts";

const model = "gpt-6.1-sol";
const scenario = {
  model,
  mode: "tokens",
  currency: "CNY",
  inputTokens: 1000000,
  outputTokens: 1000000,
  requests: 1,
};
const site = (id, price, extra = {}, group = {}) => ({
  id,
  name: id,
  enabled: true,
  recharge_cny: 7,
  recharge_usd: 1,
  status: "ok",
  fetched_at: "2026-11-11T00:00:00Z",
  catalog: {
    groups: [
      {
        id: "default",
        name: "Default",
        multiplier: 99,
        models_known: true,
        models: [model],
        prices: price ? [{ model, ...price }] : [],
        ...group,
      },
    ],
  },
  ...extra,
});

test("published effective prices are weighted by usage and recharge conversion without multiplying twice", () => {
  const sites = [
    site("a", { mode: "tokens", input: 1, output: 10 }),
    site("b", { mode: "tokens", input: 3, output: 4 }, { recharge_cny: 5 }),
  ];
  const result = compareModelCosts(sites, scenario);
  assert.deepEqual(
    result.map((row) => [row.siteId, row.cost]),
    [
      ["b", 35],
      ["a", 77],
    ],
  );
  const inputHeavy = compareModelCosts(sites, {
    ...scenario,
    outputTokens: 0,
    inputTokens: 2000000,
  });
  assert.equal(inputHeavy[0].siteId, "a");
  assert.equal(inputHeavy[0].cost, 14);
});

test("legacy duplicate quotes cannot enter the cost ranking in either order", () => {
  const prices = [
    { model, mode: "tokens", input: 1, output: 1 },
    { model, mode: "tokens", input: 100, output: 100 },
  ];
  for (const quotes of [prices, [...prices].reverse()]) {
    const rows = compareModelCosts(
      [site("duplicates", undefined, {}, { prices: quotes })],
      scenario,
    );
    assert.equal(rows[0].cost, undefined);
    assert.match(rows[0].reason, /重复报价/);
  }
});

test("dynamic, missing price, missing exchange and billing-unit differences remain explicit", () => {
  const rows = compareModelCosts(
    [
      site("dynamic", { mode: "dynamic", expression: "tokens * factor" }),
      site(
        "automatic",
        { mode: "tokens", input: 1, output: 1 },
        {},
        {
          multiplier_source: "auto",
        },
      ),
      site("unknown", undefined),
      site(
        "exchange",
        { mode: "tokens", input: 1, output: 2 },
        {
          recharge_cny: null,
        },
      ),
      site("request", { mode: "request", request: 0.1 }),
      site("partial", { mode: "tokens", input: 1 }),
    ],
    scenario,
  );
  assert.ok(rows.every((row) => row.cost === undefined));
  assert.match(rows.find((row) => row.siteId === "dynamic").reason, /动态/);
  assert.match(rows.find((row) => row.siteId === "unknown").reason, /未公开/);
  assert.match(rows.find((row) => row.siteId === "exchange").reason, /兑换/);
  assert.match(rows.find((row) => row.siteId === "request").reason, /按次/);
  assert.match(rows.find((row) => row.siteId === "partial").reason, /方向/);
});

test("zero prices remain free while unused missing directions do not block calculation", () => {
  const rows = compareModelCosts([site("free", { mode: "tokens", input: 0 })], {
    ...scenario,
    outputTokens: 0,
  });
  assert.equal(rows[0].cost, 0);
  const request = compareModelCosts(
    [site("request", { mode: "request", request: 0.25 })],
    { ...scenario, mode: "request", requests: 4 },
  );
  assert.equal(request[0].cost, 7);
});

test("USD credits can compare missing exchanges but never imply a cash conversion", () => {
  const rows = compareModelCosts(
    [
      site(
        "credits",
        { mode: "tokens", input: 1, output: 2 },
        {
          recharge_cny: null,
          recharge_usd: null,
        },
      ),
    ],
    { ...scenario, currency: "USD" },
  );
  assert.equal(rows[0].cost, 3);
  assert.equal(rows[0].exchange, undefined);
});

test("only complete raw model IDs compare; hidden sites and unrelated variants stay excluded", () => {
  const sites = [
    site("normal", { mode: "tokens", input: 1, output: 2 }),
    site("hidden", { mode: "tokens", input: 0, output: 0 }, { enabled: false }),
    site("variant", undefined, {}, { models: ["gpt-6.1-terra"] }),
  ];
  assert.deepEqual(comparisonModels(sites), ["gpt-6.1-sol", "gpt-6.1-terra"]);
  assert.deepEqual(
    compareModelCosts(sites, scenario).map((row) => row.siteId),
    ["normal"],
  );
  assert.deepEqual(
    compareModelCosts(sites, { ...scenario, model: "gpt-6.1" }),
    [],
  );
});

test("invalid or overflowing usage cannot silently become zero and stale snapshots are identified", () => {
  const sites = [
    site(
      "stale",
      { mode: "tokens", input: 1, output: 2 },
      {
        status: "error",
      },
    ),
  ];
  assert.equal(compareModelCosts(sites, scenario)[0].stale, true);
  for (const value of [NaN, -1, Infinity]) {
    const result = compareModelCosts(sites, {
      ...scenario,
      inputTokens: value,
    });
    assert.equal(result[0].cost, undefined);
    assert.match(result[0].reason, /有效/);
  }
  assert.equal(
    compareModelCosts(sites, {
      ...scenario,
      inputTokens: 0,
      outputTokens: 0,
    })[0].cost,
    undefined,
  );
  assert.equal(
    compareModelCosts(
      [
        site("overflow", {
          mode: "tokens",
          input: Number.MAX_VALUE,
          output: 1,
        }),
      ],
      { ...scenario, inputTokens: Number.MAX_VALUE },
    )[0].cost,
    undefined,
  );
});

test("current pricing cannot make an older one-time model snapshot fresh", () => {
  const now = Date.parse("2026-11-14T03:00:00Z");
  const rows = compareModelCosts(
    [
      site(
        "old-models",
        { mode: "tokens", input: 1, output: 2 },
        {
          fetched_at: new Date(now).toISOString(),
        },
        {
          models_source: "gateway_once",
          models_fetched_at: "2020-01-01T00:00:00Z",
        },
      ),
      site(
        "recent-models",
        { mode: "tokens", input: 1, output: 2 },
        {
          fetched_at: new Date(now).toISOString(),
        },
        {
          models_source: "gateway_once",
          models_fetched_at: new Date(now - 60000).toISOString(),
        },
      ),
      site(
        "undated-models",
        undefined,
        { fetched_at: new Date(now).toISOString() },
        {
          models_source: "gateway_once",
        },
      ),
    ],
    scenario,
    900,
    now,
  );
  const old = rows.find((row) => row.siteId === "old-models");
  assert.equal(old.stale, true);
  assert.equal(old.modelsStale, true);
  assert.equal(old.modelsSnapshotAt, "2020-01-01T00:00:00Z");
  assert.equal(old.snapshotAt, new Date(now).toISOString());
  assert.equal(rows.find((row) => row.siteId === "recent-models").stale, false);
  assert.equal(
    rows.find((row) => row.siteId === "undated-models").modelsStale,
    true,
  );
});

test("model freshness respects the configured sync interval and current time", () => {
  const now = Date.parse("2026-11-14T03:00:00Z");
  const sites = [
    site(
      "models",
      { mode: "tokens", input: 1, output: 2 },
      {
        fetched_at: new Date(now).toISOString(),
      },
      {
        models_source: "gateway_once",
        models_fetched_at: new Date(now - 3600000).toISOString(),
      },
    ),
  ];
  assert.equal(
    compareModelCosts(sites, scenario, 900, now)[0].modelsStale,
    true,
  );
  assert.equal(
    compareModelCosts(sites, scenario, 3600, now)[0].modelsStale,
    false,
  );
  assert.equal(
    compareModelCosts(sites, scenario, 3600, now + 3 * 3600000)[0].modelsStale,
    true,
  );
});
