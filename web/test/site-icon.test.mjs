import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedIconSources } from "../src/site-icon.ts";

test("icon revisions change the image request while retaining only the exact local cache endpoint", () => {
  const site = {
    id: "site-id",
    enabled: true,
    url: "https://provider.example",
    icon_revision: 1,
  };
  const local = "/api/sites/site-id/icon/image";
  assert.deepEqual(
    cachedIconSources(site, [local, "https://provider.example/favicon.ico"]),
    [local + "?v=1"],
  );
  assert.deepEqual(cachedIconSources({ ...site, icon_revision: 2 }, [local]), [
    local + "?v=2",
  ]);
  for (const value of [
    [local + "?evil=1"],
    ["//evil.example/icon"],
    ["/api/sites/other/icon/image"],
    null,
    "icons",
  ])
    assert.deepEqual(cachedIconSources(site, value), []);
  assert.deepEqual(
    cachedIconSources({ ...site, icon_revision: undefined }, [local]),
    [local],
  );
});
