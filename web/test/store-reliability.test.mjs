import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { url } from "../server/validation.mjs";

const config = {
  name: "Reliability relay",
  url: "https://relay.example/prefix//",
  type: "newapi",
  account: "account",
  password: "secret",
  payment_methods: [],
};
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "cerium-store-reliability-"));
  const store = new Store(join(dir, "web.db"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}
function result(job) {
  const payload = JSON.parse(job.payload);
  return {
    job_id: job.id,
    site_id: job.site_id,
    config_revision: job.revision,
    url: payload.url,
    type: payload.type,
    checked_at: new Date().toISOString(),
    catalog: { scope: "public", groups: [] },
  };
}

test("canonical provider URLs strip all trailing slashes", () => {
  assert.equal(url(config.url), "https://relay.example/prefix");
  assert.equal(url("https://relay.example////"), "https://relay.example");
});

test("concurrent admin drafts reject stale writes without changing data or jobs", (t) => {
  const store = fixture(t),
    id = store.save(config);
  const revision = store.sites(true)[0].revision;
  store.save({ ...config, revision, name: "First editor" }, id);
  const before = store.exportData();
  const jobs = store.db.prepare("SELECT * FROM jobs").all();
  assert.throws(
    () => store.save({ ...config, revision, description: "Stale editor" }, id),
    { status: 409 },
  );
  assert.deepEqual(store.exportData().sites, before.sites);
  assert.deepEqual(store.db.prepare("SELECT * FROM jobs").all(), jobs);
});

test("cosmetic edits preserve in-flight synchronization while credentials invalidate it", (t) => {
  const store = fixture(t),
    id = store.save(config);
  const job = store.nextJob();
  const nextSync = store.row(id).next_sync;
  store.save(
    {
      ...config,
      name: "Cosmetic edit",
      payment_methods: ["Card"],
      description: "New note",
    },
    id,
  );
  assert.equal(store.row(id).revision, 2);
  assert.equal(store.row(id).sync_revision, 1);
  assert.equal(store.row(id).next_sync, nextSync);
  assert.equal(
    store.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id).state,
    "running",
  );
  store.accept(result(job));
  assert.equal(store.sites(true)[0].status, "ok");
  store.queue(id);
  const outdated = store.nextJob();
  store.save({ ...config, password: "new secret" }, id);
  assert.equal(store.row(id).sync_revision, 2);
  assert.equal(store.row(id).snapshot, null);
  store.accept(result(outdated));
  assert.equal(store.row(id).snapshot, null);
  assert.equal(
    store.db.prepare("SELECT state FROM jobs WHERE id=?").get(outdated.id)
      .state,
    "superseded",
  );
});

test("malformed callback identifiers fail with 400 before querying SQLite", (t) => {
  const store = fixture(t);
  const valid = {
    job_id: randomUUID(),
    site_id: randomUUID(),
    config_revision: 1,
  };
  for (const input of [
    null,
    [],
    {},
    { ...valid, job_id: {} },
    { ...valid, site_id: 1 },
    { ...valid, config_revision: "1" },
    { ...valid, config_revision: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const prepare = store.db.prepare.bind(store.db);
    let calls = 0;
    store.db.prepare = (...args) => {
      calls++;
      return prepare(...args);
    };
    assert.throws(() => store.accept(input), { status: 400 });
    store.db.prepare = prepare;
    assert.equal(calls, 0);
  }
});

test("import normalizes untrusted revision boundaries so later edits remain possible", (t) => {
  const store = fixture(t),
    id = store.save(config);
  const backup = store.exportData();
  backup.sites[0].id = randomUUID();
  backup.sites[0].config.url = "https://imported.example";
  backup.sites[0].revision = Number.MAX_SAFE_INTEGER - 1;
  store.importData(backup);
  const imported = store
    .sites(true)
    .find((entry) => entry.url === "https://imported.example").id;
  assert.notEqual(imported, backup.sites[0].id);
  assert.equal(store.row(imported).revision, 1);
  store.save(
    {
      ...config,
      url: "https://imported.example",
      revision: 1,
      name: "Editable",
    },
    imported,
  );
  assert.equal(store.row(imported).revision, 2);
  assert.equal(store.row(id).revision, 1);
});

test("failed callback jobs require deliberate recollection and fresh job IDs", (t) => {
  const store = fixture(t),
    id = store.save(config);
  const failed = store.nextJob();
  store.reject(failed, "callback_rejected: invalid upstream catalog");
  store.db.prepare("UPDATE sites SET next_sync=0 WHERE id=?").run(id);
  store.schedule();
  assert.equal(store.nextJob(), undefined);
  store.queue(id, true);
  const retry = store.nextJob();
  assert.notEqual(retry.id, failed.id);
  assert.equal(retry.revision, failed.revision);
  assert.equal(
    store.db.prepare("SELECT payload FROM jobs WHERE id=?").get(failed.id)
      .payload,
    "{}",
  );
  store.accept(result(retry));
  store.db.prepare("UPDATE sites SET next_sync=0 WHERE id=?").run(id);
  store.schedule();
  assert.equal(store.nextJob().site_id, id);
});

test("legacy exhausted revisions rotate identities while preserving cleanup and editable state", (t) => {
  const store = fixture(t),
    id = store.save(config);
  store.db
    .prepare("UPDATE sites SET revision=?,sync_revision=? WHERE id=?")
    .run(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, id);
  const backup = store.exportData();
  backup.sites[0].config.description = "Recovered";
  store.importData(backup);
  assert.equal(store.row(id), undefined);
  const replacement = store.sites(true)[0];
  assert.notEqual(replacement.id, id);
  assert.equal(replacement.revision, 1);
  const cleanup = store.db
    .prepare(
      "SELECT payload,revision FROM jobs WHERE site_id=? AND state='pending'",
    )
    .get(id);
  assert.equal(cleanup.revision, Number.MAX_SAFE_INTEGER);
  assert.equal(JSON.parse(cleanup.payload).operation, "delete");
  store.save(
    { ...config, revision: 1, name: "Editable recovery" },
    replacement.id,
  );
  assert.equal(store.row(replacement.id).revision, 2);
});

test("dispatcher selection preserves per-site exclusivity and unrelated throughput", (t) => {
  const store = fixture(t),
    id = store.save(config);
  store.enqueue(store.row(id));
  const other = store.save({ ...config, url: "https://other.example" });
  assert.equal(store.nextJob().site_id, id);
  const second = store.nextJob();
  assert.equal(second.site_id, other);
  assert.equal(store.nextJob(), undefined);
});

test("model refresh is explicit, deduplicated and excludes ordinary active work", (t) => {
  const store = fixture(t),
    id = store.save(config);
  assert.throws(() => store.refreshModels(id), { status: 409 });
  const initial = store.nextJob();
  store.accept(result(initial));
  const refresh = store.refreshModels(id);
  assert.equal(store.refreshModels(id), refresh);
  assert.equal(
    JSON.parse(
      store.db.prepare("SELECT payload FROM jobs WHERE id=?").get(refresh)
        .payload,
    ).refresh_models,
    true,
  );
});

test("history pagination reaches retained records past the first 200 and supports search", (t) => {
  const store = fixture(t),
    id = store.save(config);
  const insert = store.db.prepare(
    "INSERT INTO catalog_changes(id,site_id,checked_at,details) VALUES(?,?,?,?)",
  );
  for (let index = 0; index < 245; index++)
    insert.run(
      randomUUID(),
      id,
      new Date(Date.now() + index).toISOString(),
      JSON.stringify([
        {
          kind: "multiplier",
          group_id: `group-${index}`,
          name: `Group ${index}`,
          before: 1,
          after: 2,
          before_dynamic: false,
          after_dynamic: false,
        },
      ]),
    );
  assert.equal(store.changes(true).length, 200);
  const page = store.getChangesPage({ limit: 50, offset: 200 });
  assert.equal(page.total, 245);
  assert.equal(page.changes.length, 45);
  assert.equal(page.changes.at(-1).details[0].group_id, "group-0");
  assert.equal(store.getChangesPage({ q: "group-244" }).total, 1);
  assert.equal(store.getChangesPage({ q: "RELIABILITY RELAY" }).total, 245);
  assert.throws(() => store.getChangesPage({ limit: 201 }), { status: 400 });
});
