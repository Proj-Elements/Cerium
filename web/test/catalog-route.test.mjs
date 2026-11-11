import { test } from "node:test";
import assert from "node:assert/strict";
import {
  catalogRouteURL,
  readCatalogRoute,
  updateCatalogRoute,
} from "../src/catalog-route.ts";

test("catalog links restore site, group and both layers of filters", () => {
  const state = readCatalogRoute(
    "?q=GPT&type=newapi&payment=%E6%94%AF%E4%BB%98%E5%AE%9D&sort=rate&family=openai&rate_min=0&rate_max=0.3&site=s1&group=fast&group_q=fast&group_family=openai&group_rate_min=0.1&group_rate_max=0.2",
  );
  assert.deepEqual(state, {
    query: "GPT",
    type: "newapi",
    payment: "支付宝",
    sort: "rate",
    family: "openai",
    range: [0, 0.3],
    site: "s1",
    group: "fast",
    groupQuery: "fast",
    groupFamily: "openai",
    groupRange: [0.1, 0.2],
    modelQuery: "",
  });
  const href = catalogRouteURL(
    "https://cerium.example/?campaign=x#directory",
    state,
  );
  const url = new URL(href, "https://cerium.example");
  assert.equal(url.searchParams.get("campaign"), "x");
  assert.equal(url.hash, "#directory");
  assert.deepEqual(readCatalogRoute(url.search), state);
});

test("malformed ranges and choices cannot poison directory controls", () => {
  for (const search of [
    "?rate_min=&rate_max=1",
    "?rate_min=-1&rate_max=2",
    "?rate_min=3&rate_max=2",
    "?rate_min=NaN&rate_max=Infinity",
    "?rate_min=0&rate_max=1000000000001",
  ])
    assert.equal(readCatalogRoute(search).range, null);
  const state = readCatalogRoute(
    "?type=malformed&sort=bad&family=bad&group=orphan",
  );
  assert.equal(state.type, "all");
  assert.equal(state.sort, "default");
  assert.equal(state.family, "all");
  assert.equal(state.group, null);
});

test("opening another site resets its detail filters while preserving directory filters", () => {
  const state = readCatalogRoute(
    "?q=GPT&site=old&group=g1&group_q=old&group_family=openai",
  );
  const next = updateCatalogRoute(state, { site: "new" });
  assert.equal(next.query, "GPT");
  assert.equal(next.site, "new");
  assert.equal(next.group, null);
  assert.equal(next.groupQuery, "");
  assert.equal(next.groupFamily, "all");
  const closed = updateCatalogRoute(next, { site: null });
  assert.equal(catalogRouteURL("https://cerium.example/", closed), "/?q=GPT");
});
