import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { url } from "../server/validation.mjs";
import { validateBackup } from "../server/backup.mjs";

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

test("legacy malformed percent escapes are repaired and disabled without preventing startup or backups", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cerium-url-escape-restart-")),
    path = join(dir, "web.db");
  let store = new Store(path);
  t.after(() => {
    if (store.db.isOpen) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = store.save(config),
    initial = store.db.prepare("SELECT * FROM jobs WHERE site_id=?").get(id),
    legacy = {
      ...JSON.parse(store.row(id).config),
      url: "https://relay.example/%zz",
    };
  store.db
    .prepare("UPDATE sites SET config=? WHERE id=?")
    .run(JSON.stringify(legacy), id);
  store.db
    .prepare("UPDATE jobs SET payload=? WHERE id=?")
    .run(
      JSON.stringify({ ...JSON.parse(initial.payload), url: legacy.url }),
      initial.id,
    );
  store.close();
  store = new Store(path);
  const row = store.row(id),
    repaired = JSON.parse(row.config);
  assert.equal(repaired.url, "https://relay.example/%25zz");
  assert.equal(repaired.enabled, false);
  assert.equal(repaired.password, config.password);
  assert.match(row.error, /^legacy_url_repair:/);
  assert.equal(store.sites().length, 0);
  assert.equal(
    store.db.prepare("SELECT state FROM jobs WHERE id=?").get(initial.id).state,
    "superseded",
  );
  assert.equal(JSON.parse(store.nextJob().payload).operation, "delete");
  assert.equal(validateBackup(store.exportData()).sites.length, 1);
  store.close();
  store = new Store(path);
  assert.equal(store.row(id).revision, row.revision);
  store.save(
    { ...repaired, enabled: true, url: "https://relay.example/repaired" },
    id,
  );
  assert.equal(store.sites().length, 1);
  assert.equal(store.row(id).error, null);
});

test("startup canonicalizes legacy provider URLs and supersedes incompatible queued payloads", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cerium-url-restart-")),
    path = join(dir, "web.db");
  let store = new Store(path);
  t.after(() => {
    if (store.db.isOpen) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = store.save(config),
    initial = store.db.prepare("SELECT * FROM jobs WHERE site_id=?").get(id),
    legacy = {
      ...JSON.parse(store.row(id).config),
      url: "https://relay.example/prefix/",
    },
    payload = { ...JSON.parse(initial.payload), url: legacy.url };
  store.db
    .prepare("UPDATE sites SET config=? WHERE id=?")
    .run(JSON.stringify(legacy), id);
  store.db
    .prepare("UPDATE jobs SET payload=? WHERE id=?")
    .run(JSON.stringify(payload), initial.id);
  store.close();
  store = new Store(path);
  assert.equal(
    JSON.parse(store.row(id).config).url,
    "https://relay.example/prefix",
  );
  assert.equal(store.row(id).sync_revision, 2);
  assert.equal(store.row(id).revision, 2);
  assert.equal(
    store.db.prepare("SELECT state FROM jobs WHERE id=?").get(initial.id).state,
    "superseded",
  );
  const current = store.nextJob();
  assert.notEqual(current.id, initial.id);
  assert.equal(JSON.parse(current.payload).url, "https://relay.example/prefix");
  store.accept(result(current));
  assert.equal(store.sites(true)[0].status, "ok");
  store.close();
  store = new Store(path);
  assert.equal(store.row(id).revision, 2);
  assert.equal(store.nextJob(), undefined);
});

test("URL migration and revision exhaustion recover together before dispatch", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cerium-url-boundary-restart-")),
    path = join(dir, "web.db");
  let store = new Store(path);
  t.after(() => {
    if (store.db.isOpen) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = store.save(config),
    legacy = {
      ...JSON.parse(store.row(id).config),
      url: "https://relay.example/%zz",
    };
  store.db
    .prepare("UPDATE sites SET config=?,revision=?,sync_revision=? WHERE id=?")
    .run(
      JSON.stringify(legacy),
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      id,
    );
  store.close();
  store = new Store(path);
  const repaired = store.sites(true)[0];
  assert.notEqual(repaired.id, id);
  assert.equal(repaired.revision, 1);
  assert.equal(repaired.enabled, false);
  assert.equal(repaired.url, "https://relay.example/%25zz");
  assert.equal(validateBackup(store.exportData()).sites.length, 1);
  assert.ok(
    store.db
      .prepare("SELECT revision FROM jobs WHERE state='pending'")
      .all()
      .every((job) => Number.isSafeInteger(job.revision)),
  );
});

test("conflicting canonical URLs preserve legacy records without blocking startup", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cerium-url-conflict-")),
    path = join(dir, "web.db");
  let store = new Store(path);
  t.after(() => {
    if (store.db.isOpen) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const canonicalId = store.save(config),
    legacyId = store.save({
      ...config,
      url: "https://temporary.example",
      description: "Retain this note",
    }),
    legacy = {
      ...JSON.parse(store.row(legacyId).config),
      url: "https://relay.example/prefix/",
    };
  const firstLegacy = {
    ...JSON.parse(store.row(canonicalId).config),
    url: "https://relay.example/prefix//",
  };
  store.db
    .prepare("UPDATE sites SET config=? WHERE id=?")
    .run(JSON.stringify(firstLegacy), canonicalId);
  store.db
    .prepare("UPDATE sites SET config=? WHERE id=?")
    .run(JSON.stringify(legacy), legacyId);
  store.close();
  store = new Store(path);
  const canonical = store.row(canonicalId),
    recovered = store.row(legacyId),
    recoveredConfig = JSON.parse(recovered.config);
  assert.equal(JSON.parse(canonical.config).enabled, true);
  assert.equal(canonical.revision, 2);
  assert.equal(JSON.parse(canonical.config).url, url(config.url));
  assert.equal(recoveredConfig.enabled, false);
  assert.equal(recoveredConfig.url, url(config.url));
  assert.equal(recoveredConfig.description, "Retain this note");
  assert.equal(
    recovered.error,
    `duplicate_identity: canonical URL duplicates site ${canonicalId}; update URL/account/user ID to re-enable`,
  );
  assert.equal(store.sites(true).length, 2);
  assert.equal(recoveredConfig.password, config.password);
  const restored = fixture(t);
  restored.importData(store.exportData(), "replace");
  assert.equal(restored.sites(true).length, 2);
  assert.equal(restored.sites().length, 1);
  store.save({ ...config, name: "Primary remains editable" }, canonicalId);
  assert.equal(
    JSON.parse(store.row(canonicalId).config).name,
    "Primary remains editable",
  );
  assert.throws(
    () => store.save({ ...recoveredConfig, enabled: true }, legacyId),
    { status: 409 },
  );
  const cleanup = store.db
    .prepare("SELECT payload FROM jobs WHERE site_id=? AND state='pending'")
    .get(legacyId);
  assert.equal(JSON.parse(cleanup.payload).operation, "delete");
  store.save(
    { ...recoveredConfig, url: "https://resolved.example", enabled: true },
    legacyId,
  );
  assert.equal(JSON.parse(store.row(legacyId).config).enabled, true);
});

test("URL migration keeps distinct provider accounts and ordinary manual sites enabled", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cerium-url-identities-")),
    path = join(dir, "web.db");
  let store = new Store(path);
  t.after(() => {
    if (store.db.isOpen) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const first = store.save(config),
    second = store.save({ ...config, account: "other-account" }),
    manual = { ...config, type: "others", manual_catalog: { groups: [] } },
    manualFirst = store.save(manual),
    manualSecond = store.save(manual);
  for (const id of [first, second, manualFirst, manualSecond]) {
    const current = JSON.parse(store.row(id).config);
    current.url += "/";
    store.db
      .prepare("UPDATE sites SET config=? WHERE id=?")
      .run(JSON.stringify(current), id);
  }
  store.close();
  store = new Store(path);
  assert.equal(store.sites().length, 4);
  assert.ok(
    store
      .sites(true)
      .every((site) => site.enabled && site.url === url(config.url)),
  );
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

test("successful model refresh clears failed-job suppression for scheduled sync", (t) => {
  const store = fixture(t),
    id = store.save(config),
    failed = store.nextJob();
  store.reject(failed, "callback_rejected: invalid upstream catalog");
  const refreshId = store.refreshModels(id),
    refresh = store.nextJob();
  assert.equal(refresh.id, refreshId);
  assert.equal(
    store.db.prepare("SELECT state FROM jobs WHERE id=?").get(failed.id).state,
    "superseded",
  );
  store.accept(result(refresh));
  store.db.prepare("UPDATE sites SET next_sync=0 WHERE id=?").run(id);
  store.schedule();
  const scheduled = store.nextJob();
  assert.equal(scheduled.site_id, id);
  assert.notEqual(scheduled.id, refreshId);
  assert.equal(JSON.parse(scheduled.payload).refresh_models, undefined);
});

test("startup recovers legacy revision boundaries without exporting or trusting icon caches", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cerium-boundary-restart-")),
    path = join(dir, "web.db");
  let store = new Store(path);
  t.after(() => {
    if (store.db.isOpen) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const ids = [
    store.save(config),
    store.save({ ...config, url: "https://second-boundary.example" }),
  ];
  const unaffected = store.save({
    ...config,
    url: "https://unaffected.example",
  });
  const unchangedJob = store.db
    .prepare("SELECT id FROM jobs WHERE site_id=?")
    .get(unaffected).id;
  const checkedAt = new Date().toISOString(),
    detail = [
      {
        kind: "multiplier",
        group_id: "g",
        name: "Group",
        before: 1,
        after: 2,
        before_dynamic: false,
        after_dynamic: false,
      },
    ],
    changeId = randomUUID();
  store.db
    .prepare(
      "INSERT INTO catalog_changes(id,site_id,checked_at,details) VALUES(?,?,?,?)",
    )
    .run(changeId, ids[0], checkedAt, JSON.stringify(detail));
  store.db
    .prepare(
      "UPDATE sites SET revision=?,sync_revision=?,favicon=?,favicon_blob=?,favicon_type=? WHERE id=?",
    )
    .run(
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      "invalid legacy icon state",
      Buffer.from("invalid"),
      "image/png",
      ids[0],
    );
  store.db
    .prepare("UPDATE sites SET sync_revision=? WHERE id=?")
    .run(Number.MAX_SAFE_INTEGER - 1, ids[1]);
  store.close();
  store = new Store(path);
  for (const id of ids) {
    assert.equal(store.row(id), undefined);
    const cleanup = store.db
      .prepare(
        "SELECT payload,revision FROM jobs WHERE site_id=? AND state='pending'",
      )
      .get(id);
    assert.equal(cleanup.revision, Number.MAX_SAFE_INTEGER);
    assert.equal(JSON.parse(cleanup.payload).operation, "delete");
  }
  const replacement = store
    .sites(true)
    .find((site) => site.url === url(config.url));
  assert.equal(replacement.revision, 1);
  assert.equal(store.row(replacement.id).favicon, null);
  assert.equal(store.row(replacement.id).favicon_blob, null);
  assert.equal(store.changes(true)[0].id, changeId);
  assert.equal(store.changes(true)[0].site_id, replacement.id);
  store.save(
    { ...config, revision: 1, name: "Editable after restart" },
    replacement.id,
  );
  assert.equal(store.row(replacement.id).revision, 2);
  assert.equal(store.row(unaffected).revision, 1);
  assert.equal(
    store.db.prepare("SELECT state FROM jobs WHERE id=?").get(unchangedJob)
      .state,
    "pending",
  );
  const recoveredIds = store.sites(true).map((site) => site.id);
  store.close();
  store = new Store(path);
  assert.deepEqual(
    store.sites(true).map((site) => site.id),
    recoveredIds,
  );
});

test("replace safely queues deletion for a legacy exhausted revision", (t) => {
  const store = fixture(t),
    id = store.save(config),
    backup = store.exportData();
  backup.sites = [];
  backup.changes = [];
  store.db
    .prepare("UPDATE sites SET revision=?,sync_revision=? WHERE id=?")
    .run(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, id);
  store.importData(backup, "replace");
  assert.equal(store.sites(true).length, 0);
  const cleanup = store.nextJob();
  assert.equal(cleanup.site_id, id);
  assert.equal(cleanup.revision, Number.MAX_SAFE_INTEGER);
  assert.equal(
    JSON.parse(cleanup.payload).config_revision,
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(JSON.parse(cleanup.payload).operation, "delete");
});

test("legacy password configs keep their snapshot after cosmetic edits", (t) => {
  const store = fixture(t),
    id = store.save(config),
    job = store.nextJob();
  store.accept(result(job));
  const saved = JSON.parse(store.row(id).config);
  delete saved.auth_mode;
  store.db
    .prepare("UPDATE sites SET config=? WHERE id=?")
    .run(JSON.stringify(saved), id);
  const snapshot = store.row(id).snapshot;
  store.save({ ...config, name: "Cosmetic legacy edit" }, id);
  assert.equal(store.row(id).sync_revision, 1);
  assert.equal(store.row(id).snapshot, snapshot);
  assert.equal(store.nextJob(), undefined);
});

test("manual-site cosmetic edits retain a single pending provider deletion", (t) => {
  const store = fixture(t),
    id = store.save(config),
    manual = { ...config, type: "others", manual_catalog: { groups: [] } };
  store.save(manual, id);
  const cleanup = store.db
    .prepare("SELECT id FROM jobs WHERE site_id=? AND state='pending'")
    .get(id);
  store.save({ ...manual, name: "Cosmetic manual edit" }, id);
  assert.deepEqual(
    store.db
      .prepare("SELECT id FROM jobs WHERE site_id=? AND state='pending'")
      .all(id),
    [cleanup],
  );
  assert.equal(store.row(id).sync_revision, 2);
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
