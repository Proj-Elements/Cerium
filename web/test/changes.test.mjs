import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { compareCatalogs } from "../server/changes.mjs";

const group = (id, multiplier, extra = {}) => ({
  id,
  name: id,
  multiplier,
  models: [],
  models_known: true,
  ...extra,
});
const catalog = (...groups) => ({ scope: "public", groups });
const config = {
  name: "Change test",
  url: "https://relay.example",
  type: "newapi",
  account: "private-account",
  password: "private-password",
  payment_methods: [],
};
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "cerium-changes-"));
  const store = new Store(join(dir, "web.db"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = store.save(config);
  function publish(snapshot, extra = {}) {
    store.queue(id);
    const job = store.nextJob();
    const result = {
      job_id: job.id,
      site_id: id,
      config_revision: job.revision,
      url: config.url,
      type: config.type,
      checked_at: new Date().toISOString(),
      ...(snapshot === undefined ? {} : { catalog: snapshot }),
      ...extra,
    };
    store.accept(result);
    return result;
  }
  return { store, id, dir, publish };
}
test("compare ignores order and floating-point noise; tracks zero, dynamic and unknown rates", () => {
  const before = catalog(
    group("zero", 0),
    group("stable", 0.3),
    group("auto", null, { multiplier_source: "auto" }),
  );
  assert.deepEqual(compareCatalogs(null, before), []);
  assert.deepEqual(
    compareCatalogs(
      before,
      catalog(
        group("auto", null, { multiplier_source: "auto" }),
        group("stable", 0.1 + 0.2),
        group("zero", 0),
      ),
    ),
    [],
  );
  const changes = compareCatalogs(
    before,
    catalog(
      group("zero", 0.1),
      group("stable", null),
      group("auto", null),
      group("new", 0),
    ),
  );
  assert.deepEqual(
    changes.map((item) => item.kind),
    ["multiplier", "multiplier", "multiplier", "added"],
  );
  assert.equal(changes[0].before, 0);
  assert.equal(changes[1].after, null);
  assert.equal(changes[2].before_dynamic, true);
  assert.equal(changes[3].after, 0);
  assert.equal(compareCatalogs(before, catalog()).length, 3);
});
test("successful snapshots create durable, idempotent notices; failures never erase the baseline", (t) => {
  const f = fixture(t);
  f.publish(catalog(group("default", 1), group("old", 2)));
  assert.equal(f.store.changes().length, 0);
  f.publish(undefined, { error: "upstream unavailable" });
  assert.equal(f.store.changes().length, 0);
  const result = f.publish(catalog(group("default", 0.5), group("new", 0)));
  f.store.accept(result);
  assert.equal(f.store.changes().length, 1);
  assert.deepEqual(
    f.store.changes()[0].details.map((item) => item.kind),
    ["multiplier", "added", "removed"],
  );
  const restored = new Store(join(f.dir, "web.db"));
  assert.equal(restored.changes().length, 1);
  restored.close();
  f.publish(
    catalog(
      group("new", 0),
      group("default", 0.5, { models: ["fresh-model"] }),
    ),
  );
  assert.equal(f.store.changes().length, 2);
  assert.equal(f.store.changes()[0].details[0].kind, "models");
  assert.deepEqual(f.store.changes()[0].details[0].models_added, [
    "fresh-model",
  ]);
  const json = JSON.stringify(f.store.changes());
  for (const secret of [
    "private-account",
    "private-password",
    "account",
    "password",
  ])
    assert.ok(!json.includes(secret));
});
test("model notices compare known sets, sort their deltas and ignore discovery transitions", () => {
  const before = catalog(group("g", 1, { models: ["keep", "old-b", "old-a"] })),
    current = catalog(
      group("g", 1, { models: ["new-b", "keep", "new-a", "new-a"] }),
    ),
    [change] = compareCatalogs(before, current);
  assert.equal(change.kind, "models");
  assert.deepEqual(change.models_added, ["new-a", "new-b"]);
  assert.deepEqual(change.models_removed, ["old-a", "old-b"]);
  assert.deepEqual(
    compareCatalogs(
      before,
      catalog(group("g", 1, { models: ["old-a", "keep", "old-b"] })),
    ),
    [],
  );
  for (const modelsKnown of [false, undefined]) {
    assert.deepEqual(
      compareCatalogs(
        catalog(group("g", 1, { models_known: modelsKnown })),
        current,
      ),
      [],
    );
    assert.deepEqual(
      compareCatalogs(
        before,
        catalog(group("g", 1, { models_known: modelsKnown })),
      ),
      [],
    );
  }
});
test("price notices retain bounded public facts and compare modes, expressions and every numeric field", () => {
  const price = {
      model: "model",
      mode: "tokens",
      input: 1,
      output: 2,
      request: null,
      cache_read: 0.1,
      cache_write: 0.2,
      expression: "",
    },
    before = catalog(group("g", 1, { prices: [price] }));
  for (const update of [
    { input: 3 },
    { output: 4 },
    { request: 0 },
    { cache_read: 0 },
    { cache_write: 0.3 },
    { mode: "dynamic" },
    { expression: "input * 2" },
  ]) {
    const [change] = compareCatalogs(
      before,
      catalog(
        group("g", 1, {
          prices: [{ ...price, ...update, password: "private-password" }],
        }),
      ),
    );
    assert.equal(change.kind, "prices");
    assert.equal(change.price_changes[0].model, "model");
    assert.equal(change.price_changes[0].before.input, 1);
    assert.deepEqual(change.price_changes[0].after, { ...price, ...update });
    assert.ok(!JSON.stringify(change).includes("password"));
  }
  assert.deepEqual(
    compareCatalogs(
      before,
      catalog(
        group("g", 1, {
          prices: [{ ...price, input: 1 + 1e-12, expression: "  " }],
        }),
      ),
    ),
    [],
  );
  assert.equal(
    compareCatalogs(
      catalog(group("g", 1, { prices: [{ ...price, input: 1e-20 }] })),
      catalog(group("g", 1, { prices: [{ ...price, input: 2e-20 }] })),
    )[0].kind,
    "prices",
  );
});
test("new and missing model prices are explicit, deterministic deltas without redundant group notices", () => {
  const old = { model: "old", mode: "request", request: 0.5 },
    added = { model: "added", mode: "dynamic", expression: "tokens * rate" },
    previous = catalog(group("g", 1, { prices: [old] })),
    current = catalog(group("g", 1, { prices: [added] })),
    [change] = compareCatalogs(previous, current);
  assert.deepEqual(
    change.price_changes.map(({ model }) => model),
    ["added", "old"],
  );
  assert.equal(change.price_changes[0].before, null);
  assert.equal(change.price_changes[1].after, null);
  assert.deepEqual(
    compareCatalogs(
      catalog(group("g", 1, { prices: [old, added] })),
      catalog(
        group("g", 1, {
          prices: [{ ...added, expression: " tokens * rate " }, old],
        }),
      ),
    ),
    [],
  );
  assert.deepEqual(
    compareCatalogs(catalog(), current).map(({ kind }) => kind),
    ["added"],
  );
  assert.deepEqual(
    compareCatalogs(previous, catalog()).map(({ kind }) => kind),
    ["removed"],
  );
});
test("model and price changes persist together and redelivered callbacks create no duplicate", (t) => {
  const f = fixture(t),
    before = catalog(
      group("g", 1, {
        models: ["old"],
        prices: [{ model: "old", mode: "tokens", input: 1 }],
      }),
    ),
    after = catalog(
      group("g", 2, {
        models: ["new"],
        prices: [{ model: "new", mode: "dynamic", expression: "input * 2" }],
      }),
    );
  f.publish(before);
  f.publish(undefined, { error: "temporary failure" });
  const result = f.publish(after);
  f.store.accept(result);
  assert.equal(f.store.changes().length, 1);
  assert.deepEqual(
    f.store.changes()[0].details.map(({ kind }) => kind),
    ["multiplier", "models", "prices"],
  );
  const restored = new Store(join(f.dir, "web.db"));
  try {
    assert.deepEqual(restored.changes(), f.store.changes());
  } finally {
    restored.close();
  }
  f.publish(after);
  assert.equal(f.store.changes().length, 1);
});
test("manual changes, monitoring toggle, hide, withdraw, restore, and deletion", (t) => {
  const f = fixture(t);
  const manual = {
    ...config,
    type: "others",
    manual_catalog: { groups: [group("manual", 1)] },
  };
  f.store.save(manual, f.id);
  assert.equal(f.store.changes().length, 0);
  f.store.save(
    { ...manual, manual_catalog: { groups: [group("manual", 2)] } },
    f.id,
  );
  const notice = f.store.changes()[0];
  assert.equal(notice.details[0].after, 2);
  f.store.changeVisibility(notice.id, false);
  assert.equal(f.store.changes().length, 0);
  assert.equal(f.store.changes(true)[0].dismissed, true);
  f.store.changeVisibility(notice.id, true);
  assert.equal(f.store.changes().length, 1);
  assert.throws(() => f.store.changeVisibility(notice.id, "true"), {
    status: 400,
  });
  f.store.save({ ...manual, enabled: false }, f.id);
  assert.equal(f.store.changes().length, 0);
  f.store.save(
    {
      ...manual,
      monitor_changes: false,
      manual_catalog: { groups: [group("manual", 3)] },
    },
    f.id,
  );
  const count = f.store.changes(true).length;
  f.store.save(
    { ...manual, manual_catalog: { groups: [group("manual", 4)] } },
    f.id,
  );
  assert.equal(
    f.store.changes(true).length,
    count,
    "omitted monitor setting retains previous false",
  );
  f.store.save(
    {
      ...manual,
      monitor_changes: true,
      manual_catalog: { groups: [group("manual", 4)] },
    },
    f.id,
  );
  assert.equal(
    f.store.changes(true).length,
    count,
    "resume compares against latest baseline",
  );
  f.store.remove(f.id);
  assert.equal(f.store.changes(true).length, 0);
});
test("late callbacks and identity changes cannot create bogus notices", (t) => {
  const f = fixture(t);
  f.publish(catalog(group("g", 1)));
  f.publish(catalog(group("g", 8)), {
    checked_at: new Date(Date.now() - 60000).toISOString(),
  });
  assert.equal(f.store.changes().length, 0);
  assert.equal(f.store.sites()[0].catalog.groups[0].multiplier, 1);
  f.publish(catalog(group("g", 2)));
  assert.equal(f.store.changes().length, 1);
  f.store.save({ ...config, url: "https://replacement.example" }, f.id);
  assert.equal(f.store.changes(true).length, 0);
  assert.equal(f.store.row(f.id).snapshot, null);
});
test("public notices expire at seven days, admin history retains thirty days", (t) => {
  const f = fixture(t);
  f.publish(catalog(group("g", 1)));
  f.publish(catalog(group("g", 2)));
  f.store.db
    .prepare("UPDATE catalog_changes SET checked_at=?")
    .run(new Date(Date.now() - 8 * 86400000).toISOString());
  assert.equal(f.store.changes().length, 0);
  assert.equal(f.store.changes(true).length, 1);
  f.store.db
    .prepare("UPDATE catalog_changes SET checked_at=?")
    .run(new Date(Date.now() - 31 * 86400000).toISOString());
  f.store.schedule();
  assert.equal(f.store.changes(true).length, 0);
});
