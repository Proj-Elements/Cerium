import { test } from "node:test";
import assert from "node:assert/strict";
import { matchCatalogSite } from "../src/catalog-filter.ts";

const site = {
  name: "Relay",
  url: "https://relay.example",
  description: "Public service",
  catalog: {
    groups: [
      {
        id: "expensive",
        name: "Premium",
        multiplier: 5,
        models: ["gpt-6.1-sol"],
        models_known: true,
      },
      {
        id: "cheap",
        name: "Economy",
        multiplier: 0.1,
        models: ["claude-sonnet-5-5"],
        models_known: true,
      },
    ],
  },
};

test("model search and multiplier range must be satisfied by the same group", () => {
  const result = matchCatalogSite(site, {
    family: "all",
    range: [0, 1],
    query: "GPT",
  });
  assert.equal(result.matches, false);
  assert.deepEqual(result.groups, []);
  const matching = matchCatalogSite(site, {
    family: "all",
    range: [0, 1],
    query: "Claude Sonnet 5.5",
  });
  assert.equal(matching.matches, true);
  assert.deepEqual(
    matching.groups.map((group) => group.id),
    ["cheap"],
  );
});

test("model and family searches stay in the same group, including descriptions and IDs", () => {
  assert.equal(
    matchCatalogSite(site, {
      family: "anthropic",
      range: null,
      query: "gpt-6.1-sol",
    }).matches,
    false,
  );
  const result = matchCatalogSite(site, {
    family: "all",
    range: [4, 6],
    query: "premium",
  });
  assert.equal(result.matches, true);
  assert.deepEqual(
    result.groups.map((group) => group.id),
    ["expensive"],
  );
  assert.equal(result.groupFiltering, true);
});

test("site metadata may match independently while rate and platform bind together", () => {
  const result = matchCatalogSite(site, {
    family: "anthropic",
    range: [0, 1],
    query: "RELAY",
  });
  assert.equal(result.matches, true);
  assert.deepEqual(
    result.groups.map((group) => group.id),
    ["cheap"],
  );
  assert.equal(
    matchCatalogSite(site, {
      family: "openai",
      range: [0, 1],
      query: "relay",
    }).matches,
    false,
  );
});

test("sites without models remain findable through metadata until group filters activate", () => {
  const empty = { ...site, catalog: null };
  assert.equal(
    matchCatalogSite(empty, { family: "all", range: null, query: "relay" })
      .matches,
    true,
  );
  assert.equal(
    matchCatalogSite(empty, { family: "all", range: [0, 1], query: "relay" })
      .matches,
    false,
  );
});
