import { test } from "node:test";
import assert from "node:assert/strict";
import { catalog, site } from "../server/validation.mjs";

const config = {
  name: "Validation relay",
  url: "https://validation.example",
  type: "others",
  payment_methods: [],
};
const group = {
  id: "default",
  name: "Default",
  multiplier: 0,
  models: [],
  models_known: true,
};

test("site visibility accepts only booleans and defaults to enabled", () => {
  assert.equal(site(config).enabled, true);
  assert.equal(site({ ...config, enabled: true }).enabled, true);
  assert.equal(site({ ...config, enabled: false }).enabled, false);
  for (const enabled of [null, "false", "true", 0, 1, [], {}])
    assert.throws(() => site({ ...config, enabled }), { status: 400 });
});

test("catalog group and price entries reject non-objects with client errors", () => {
  for (const value of [null, [], false, 0, "invalid"]) {
    assert.throws(() => catalog({ scope: "public", groups: [value] }), {
      status: 400,
    });
    assert.throws(
      () =>
        catalog({
          scope: "public",
          groups: [{ ...group, prices: [value] }],
        }),
      { status: 400 },
    );
  }
  const result = catalog({
    scope: "public",
    groups: [
      {
        ...group,
        prices: [{ model: "zero-priced", mode: "tokens", input: 0 }],
      },
    ],
  });
  assert.equal(result.groups[0].multiplier, 0);
  assert.deepEqual(result.groups[0].models, []);
  assert.equal(result.groups[0].prices[0].input, 0);
  assert.equal(result.groups[0].prices[0].output, null);
  assert.deepEqual(catalog({ scope: "public", groups: [] }).groups, []);
});
