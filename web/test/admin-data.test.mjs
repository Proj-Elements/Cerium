import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/index.mjs";
import { Store } from "../server/store.mjs";
import {
  BACKUP_LIMIT,
  parseBackup,
  serializeBackup,
} from "../server/backup.mjs";

const config = {
  name: "Backup relay",
  url: "https://backup.example",
  type: "newapi",
  account: "PRIVATE-ACCOUNT",
  password: " PRIVATE-PASSWORD ",
  icon: "",
  payment_methods: ["Card"],
  recharge_cny: 10,
  recharge_usd: 20,
  recharge_multiplier: 2,
};
const manual = {
  ...config,
  type: "others",
  account: "",
  password: "",
  manual_catalog: {
    groups: [
      {
        id: "g",
        name: "Group",
        multiplier: 1,
        models: ["model"],
        models_known: true,
      },
    ],
  },
};
function storage(t, interval = 900) {
  const dir = mkdtempSync(join(tmpdir(), "cerium-data-test-")),
    path = join(dir, "web.db"),
    store = new Store(path, interval);
  t.after(() => {
    if (store.db.isOpen) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, path, dir };
}
function complete(store, id, rate, time = Date.now()) {
  const row = store.row(id),
    c = JSON.parse(row.config),
    job = store.db
      .prepare(
        "SELECT id FROM jobs WHERE site_id=? AND revision=? AND state IN ('pending','running')",
      )
      .get(id, row.revision);
  const result = {
    job_id: job.id,
    site_id: id,
    config_revision: row.revision,
    url: c.url,
    type: c.type,
    checked_at: new Date(time).toISOString(),
    warnings: ["A saved diagnostic"],
    catalog: {
      scope: "public",
      groups: [
        {
          id: "g",
          name: "Group",
          multiplier: rate,
          models: ["model"],
          models_known: true,
          prices: [{ model: "model", mode: "tokens", input: 1, output: 2 }],
        },
      ],
    },
  };
  store.accept(result);
  return result;
}
function seed(store) {
  const id = store.save(config);
  complete(store, id, 1);
  store.queue(id);
  complete(store, id, 2, Date.now() + 1);
  store.changeVisibility(store.changes(true)[0].id, false);
  store.save({
    ...config,
    name: "Token relay",
    url: "https://token.example",
    auth_mode: "token",
    account: "",
    password: "",
    access_token: "PRIVATE-PANEL-TOKEN",
    user_id: 42,
  });
  store.save(manual);
  store.save({
    ...config,
    name: "Hidden relay",
    url: "https://hidden.example",
    enabled: false,
  });
  return id;
}
function content(store) {
  const { exported_at, ...value } = store.exportData();
  return value;
}
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "cerium-data-http-"));
  let password;
  const app = createApp({
    secret: "cerium-data-test-secret-32-characters",
    dbPath: join(dir, "web.db"),
    dispatch: false,
    log: (value) => {
      password = value.split(": ").at(-1);
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const origin = `http://127.0.0.1:${app.server.address().port}`,
    base = app.adminPath + "/api";
  let cookie = "";
  async function request(path, method = "GET", data, headers = {}) {
    return fetch(origin + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        "X-Cerium-Admin": "1",
        "Content-Type": "application/json",
        ...headers,
      },
      body:
        data === undefined
          ? undefined
          : Buffer.isBuffer(data)
            ? data
            : JSON.stringify(data),
    });
  }
  async function login() {
    const response = await request(base + "/login", "POST", { password });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie").split(";")[0];
  }
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...app, request, login, base };
}

test("sync settings reschedule elapsed waits, retain pending tasks and survive restart", (t) => {
  const { store, path } = storage(t, 900),
    id = store.save(config),
    hidden = store.save({
      ...config,
      url: "https://hidden.example",
      enabled: false,
    });
  const manualId = store.save(manual),
    job = store.nextJob(),
    before = store.row(id).next_sync,
    hiddenNext = store.row(hidden).next_sync,
    manualNext = store.row(manualId).next_sync;
  assert.equal(store.setInterval(90), 90);
  assert.equal(store.row(id).next_sync, before - 810000);
  assert.equal(store.row(hidden).next_sync, hiddenNext);
  assert.equal(store.row(manualId).next_sync, manualNext);
  assert.equal(
    store.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id).state,
    "running",
  );
  for (const value of [
    null,
    "60",
    0,
    59,
    60.5,
    Infinity,
    Number.MAX_SAFE_INTEGER,
    31536001,
  ]) {
    assert.throws(() => store.setInterval(value), { status: 400 });
    assert.equal(store.interval, 90);
  }
  store.close();
  const restarted = new Store(path, 1800);
  try {
    assert.equal(restarted.interval, 90);
    assert.equal(restarted.row(id).next_sync, before - 810000);
    assert.equal(
      restarted.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id)
        .state,
      "pending",
    );
    restarted.setInterval(60);
    restarted.db.prepare("UPDATE jobs SET state='done',payload='{}'").run();
    restarted.db
      .prepare("UPDATE sites SET next_sync=? WHERE id=?")
      .run(Date.now() + 10000, id);
    restarted.setInterval(900);
    assert.ok(restarted.row(id).next_sync > Date.now());
    restarted.setInterval(60);
    restarted.db
      .prepare("UPDATE sites SET next_sync=? WHERE id=?")
      .run(Date.now() - 1, id);
    restarted.schedule();
    assert.equal(restarted.nextJob().site_id, id);
  } finally {
    restarted.close();
  }
});

test("existing databases initialize sync settings only once", (t) => {
  const { store, path } = storage(t);
  const adminPath = store.adminPath;
  store.db
    .prepare("DELETE FROM settings WHERE key='sync_interval_seconds'")
    .run();
  store.close();
  const migrated = new Store(path, 120);
  try {
    assert.equal(migrated.interval, 120);
    assert.equal(migrated.adminPath, adminPath);
  } finally {
    migrated.close();
  }
});

for (const format of ["json", "sqlite"]) {
  test(`${format} round-trip preserves credentials, snapshots, hidden sites, moderation and sync interval`, async (t) => {
    const { store: source } = storage(t),
      { store: destination, dir } = storage(t);
    seed(source);
    source.setInterval(120);
    const original = source.exportData(),
      adminPath = destination.adminPath,
      bytes = await serializeBackup(source, format);
    assert.ok(!bytes.includes(Buffer.from(source.adminPath)));
    if (format === "sqlite") {
      assert.equal(
        bytes.subarray(0, 16).toString("binary"),
        "SQLite format 3\0",
      );
      const path = join(dir, "export.db");
      writeFileSync(path, bytes, { mode: 0o600 });
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
        assert.equal(
          db.prepare("SELECT value FROM settings WHERE key='admin_path'").get(),
          undefined,
        );
        assert.equal(
          db.prepare("PRAGMA journal_mode").get().journal_mode,
          "delete",
        );
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sites").get().n, 4);
      } finally {
        db.close();
      }
    }
    const parsed = parseBackup(bytes, format),
      result = destination.importData(parsed, "replace");
    assert.deepEqual(result, { imported: 4, removed: 0, interval: 120 });
    assert.equal(destination.adminPath, adminPath);
    for (const entry of original.sites) {
      const row = destination
        .exportData()
        .sites.find((site) => site.id === entry.id);
      assert.deepEqual(row, { ...entry, revision: entry.revision + 1 });
    }
    assert.deepEqual(destination.exportData().changes, original.changes);
    const jobs = destination.db.prepare("SELECT * FROM jobs").all();
    assert.equal(jobs.length, 2);
    assert.ok(
      jobs.every(
        (job) =>
          job.state === "pending" && JSON.parse(job.payload).job_id === job.id,
      ),
    );
    assert.ok(
      jobs.every(
        (job) =>
          !source.db.prepare("SELECT id FROM jobs WHERE id=?").get(job.id),
      ),
    );
    const publicData = JSON.stringify(destination.sites());
    assert.ok(!/PRIVATE-(ACCOUNT|PASSWORD|PANEL-TOKEN)/.test(publicData));
    assert.equal(destination.sites().length, 3);
    assert.equal(destination.sites(true).length, 4);
    assert.equal(destination.changes().length, 0);
  });
}

test("merge remaps matching identities, preserves unrelated sites and never replays retired callbacks", (t) => {
  const { store: source } = storage(t),
    { store: destination } = storage(t),
    sourceId = seed(source),
    existingId = destination.save(config),
    oldJob = destination.nextJob(),
    retainedId = destination.save({
      ...manual,
      name: "Retain me",
      url: "https://retain.example",
    }),
    oldRevision = destination.row(existingId).revision;
  const data = source.exportData();
  data.sites.find((site) => site.id === sourceId).config.name = "Restored name";
  destination.importData(data);
  assert.equal(destination.sites(true).length, 5);
  assert.ok(destination.row(retainedId));
  assert.equal(destination.row(sourceId), undefined);
  assert.equal(
    JSON.parse(destination.row(existingId).config).name,
    "Restored name",
  );
  assert.ok(destination.row(existingId).revision > oldRevision);
  assert.equal(destination.changes(true)[0].site_id, existingId);
  assert.equal(
    destination.db
      .prepare("SELECT state,payload FROM jobs WHERE id=?")
      .get(oldJob.id).state,
    "superseded",
  );
  const before = destination.row(existingId).snapshot;
  destination.accept({
    job_id: oldJob.id,
    site_id: existingId,
    config_revision: oldRevision,
    error: "late failure",
  });
  assert.equal(destination.row(existingId).snapshot, before);
  assert.equal(destination.row(existingId).error, "");
});

test("replace retains destination cleanup jobs and uses revisions newer than pending deletes", (t) => {
  const { store: source } = storage(t),
    { store: destination } = storage(t),
    id = source.save(config);
  const destinationId = destination.save({
    ...config,
    url: "https://removed.example",
  });
  destination.remove(destinationId);
  const cleanup = destination.db
    .prepare("SELECT id FROM jobs WHERE site_id=? AND state='pending'")
    .get(destinationId).id;
  const removed = destination.save({
    ...manual,
    url: "https://manual-removed.example",
  });
  destination.importData(source.exportData(), "replace");
  assert.equal(
    destination.db.prepare("SELECT state FROM jobs WHERE id=?").get(cleanup)
      .state,
    "pending",
  );
  assert.equal(destination.row(removed), undefined);
  assert.equal(
    JSON.parse(
      destination.db
        .prepare("SELECT payload FROM jobs WHERE site_id=? AND state='pending'")
        .get(removed).payload,
    ).operation,
    "delete",
  );
  destination.remove(id);
  const deleteRevision = destination.db
    .prepare("SELECT MAX(revision) AS r FROM jobs WHERE site_id=?")
    .get(id).r;
  destination.importData(source.exportData());
  assert.ok(destination.row(id).revision > deleteRevision);
});

test("provider-to-manual restores still clean up worker credentials", (t) => {
  const { store: source } = storage(t),
    { store: destination } = storage(t),
    id = destination.save(config);
  source.save(manual);
  const data = source.exportData();
  data.sites[0].id = id;
  destination.importData(data);
  assert.equal(destination.sites(true)[0].status, "manual");
  const job = destination.db
    .prepare("SELECT * FROM jobs WHERE site_id=? AND state='pending'")
    .get(id);
  assert.equal(JSON.parse(job.payload).operation, "delete");
});

test("invalid imports and late transactional conflicts leave all data, jobs and settings unchanged", (t) => {
  const { store: source } = storage(t),
    { store: destination } = storage(t);
  seed(source);
  const target = destination.save(manual);
  destination.save(
    {
      ...manual,
      manual_catalog: { groups: [{ id: "g", name: "Group", multiplier: 2 }] },
    },
    target,
  );
  const original = content(destination),
    jobs = destination.db.prepare("SELECT * FROM jobs").all();
  for (const mutate of [
    (data) => {
      data.version = 2;
    },
    (data) => {
      data.settings.sync_interval_seconds = 59;
    },
    (data) => {
      data.sites[0].config.password = "";
    },
    (data) => {
      data.sites[1].config.url = "javascript:alert(1)";
    },
    (data) => {
      data.sites.push(data.sites[0]);
    },
    (data) => {
      data.changes[0].site_id = randomUUID();
    },
    (data) => {
      data.changes[0].details[0].after = -1;
    },
  ]) {
    const data = source.exportData();
    mutate(data);
    assert.throws(() => destination.importData(data), { status: 400 });
    assert.deepEqual(content(destination), original);
    assert.deepEqual(destination.db.prepare("SELECT * FROM jobs").all(), jobs);
  }
  const conflict = source.exportData();
  conflict.settings.sync_interval_seconds = 60;
  conflict.changes[0].id = destination.changes(true)[0].id;
  assert.throws(() => destination.importData(conflict), { status: 409 });
  assert.deepEqual(content(destination), original);
  assert.deepEqual(destination.db.prepare("SELECT * FROM jobs").all(), jobs);
});

test("SQLite import rejects foreign schemas, views, SQL scripts and corrupt files", (t) => {
  const { store, dir } = storage(t),
    original = content(store);
  for (const bytes of [
    Buffer.from("DROP TABLE sites;"),
    Buffer.from("SQLite format 3\0malformed"),
  ])
    assert.throws(() => parseBackup(bytes, "sqlite"), { status: 400 });
  const path = join(dir, "foreign.db"),
    db = new DatabaseSync(path);
  db.exec("CREATE TABLE credentials(id INTEGER PRIMARY KEY)");
  db.close();
  assert.throws(() => parseBackup(readFileSync(path), "sqlite"), {
    status: 400,
  });
  const viewPath = join(dir, "view.db"),
    view = new DatabaseSync(viewPath);
  view.exec(
    "CREATE TABLE settings(key TEXT,value TEXT); CREATE TABLE catalog_changes(id TEXT); CREATE VIEW sites AS SELECT 'invalid' AS config;",
  );
  view.close();
  assert.throws(() => parseBackup(readFileSync(viewPath), "sqlite"), {
    status: 400,
  });
  assert.deepEqual(content(store), original);
});

test("settings and both backup formats require authentication and same-origin CSRF checks", async (t) => {
  const f = await fixture(t);
  for (const [path, method] of [
    ["/settings", "GET"],
    ["/settings", "PUT"],
    ["/data/export", "POST"],
    ["/data/import", "POST"],
  ])
    assert.equal(
      (
        await f.request(
          f.base + path,
          method,
          method === "GET" ? undefined : {},
        )
      ).status,
      401,
    );
  await f.login();
  for (const path of ["/settings", "/data/export", "/data/import"]) {
    const method = path === "/settings" ? "PUT" : "POST";
    assert.equal(
      (
        await f.request(
          f.base + path,
          method,
          {},
          { Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.request(f.base + path, method, {}, { "X-Cerium-Admin": "" }))
        .status,
      403,
    );
  }
  assert.equal(
    (
      await f.request(f.base + "/settings", "PUT", {
        sync_interval_seconds: 90,
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await f.request(f.base + "/settings")).json())
      .sync_interval_seconds,
    90,
  );
  assert.equal((await (await f.request("/api/sites")).json()).interval, 90);
  assert.equal(
    (await (await f.request(f.base + "/sites")).json()).interval,
    90,
  );
  assert.equal(
    (await f.request(f.base + "/settings", "PUT", null)).status,
    400,
  );
  seed(f.store);
  for (const format of ["json", "sqlite"]) {
    const response = await f.request(
      `${f.base}/data/export?format=${format}`,
      "POST",
    );
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-disposition"),
      new RegExp(
        `attachment; filename="cerium-web-.*\\.${format === "json" ? "json" : "db"}"`,
      ),
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(parseBackup(bytes, format).sites.length, 4);
    const imported = await f.request(
      `${f.base}/data/import?format=${format}`,
      "POST",
      bytes,
      {
        "Content-Type":
          format === "json" ? "application/json" : "application/vnd.sqlite3",
      },
    );
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).imported, 4);
  }
  const before = content(f.store);
  assert.equal(
    (await f.request(f.base + "/data/export?format=sql", "POST")).status,
    400,
  );
  assert.equal(
    (await f.request(f.base + "/data/import?mode=unknown", "POST", {})).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        f.base + "/data/import?format=sqlite",
        "POST",
        Buffer.from("DROP TABLE sites;"),
        { "Content-Type": "application/vnd.sqlite3" },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        f.base + "/data/import?format=sqlite",
        "POST",
        {},
        { "Content-Type": "application/json" },
      )
    ).status,
    415,
  );
  assert.equal(
    (await f.request(f.base + "/data/import", "POST", Buffer.from("not-json")))
      .status,
    400,
  );
  assert.equal(
    (
      await f.request(
        f.base + "/data/import",
        "POST",
        Buffer.alloc(BACKUP_LIMIT + 1),
      )
    ).status,
    413,
  );
  assert.deepEqual(content(f.store), before);
  assert.equal((await f.request(f.base + "/data/export")).status, 404);
  const publicText = await (await f.request("/api/sites")).text();
  assert.ok(!/PRIVATE-(ACCOUNT|PASSWORD|PANEL-TOKEN)/.test(publicText));
  assert.ok(!publicText.includes(f.adminPath));
  assert.equal(BACKUP_LIMIT, 64 * 1024 * 1024);
});
