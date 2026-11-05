import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store.mjs";
import { createApp, sign } from "../server/index.mjs";
import { createPersistentIconResolver } from "../server/icons.mjs";
import { parseBackup, serializeBackup } from "../server/backup.mjs";

const config = {
  name: "Icon relay",
  url: "https://icon.example",
  type: "newapi",
  account: "PRIVATE-ACCOUNT",
  password: "PRIVATE-PASSWORD",
  icon: "",
  payment_methods: [],
};
const savedIcon = {
  url: config.url,
  icons: [
    "https://icon.example/missing.ico",
    "https://icon.example/brand.svg?v=1",
  ],
  selected: "https://icon.example/brand.svg?v=1",
};
function storage(t) {
  const dir = mkdtempSync(join(tmpdir(), "cerium-icon-test-")),
    path = join(dir, "web.db");
  let store = new Store(path);
  t.after(() => {
    if (store.db.isOpen) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new Store(path);
      return store;
    },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function complete(store, id, extra = {}) {
  const job = store.nextJob(),
    row = store.row(id);
  const value = {
    job_id: job.id,
    site_id: id,
    config_revision: row.revision,
    url: JSON.parse(row.config).url,
    type: JSON.parse(row.config).type,
    checked_at: new Date().toISOString(),
    catalog: {
      scope: "public",
      groups: [{ id: "g", name: "Group", multiplier: 1 }],
    },
    ...extra,
  };
  store.accept(value);
  return value;
}

test("coalesces discovery and preserves selection through sync, edits, hiding and restart", async (t) => {
  const fixture = storage(t),
    { store } = fixture,
    id = store.save(config);
  let calls = 0;
  const discover = async (site) => {
    assert.deepEqual(site, { url: config.url });
    calls++;
    return savedIcon;
  };
  const resolve = createPersistentIconResolver(store, discover);
  complete(store, id);
  assert.equal(calls, 0);
  const originalRevision = store.row(id).revision,
    originalJobs = store.db.prepare("SELECT * FROM jobs").all();
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => resolve(id)),
  );
  assert.equal(calls, 1);
  assert.ok(responses.every((value) => value.icons[0] === savedIcon.selected));
  assert.deepEqual(JSON.parse(store.row(id).favicon), savedIcon);
  assert.equal(store.row(id).revision, originalRevision);
  assert.deepEqual(store.db.prepare("SELECT * FROM jobs").all(), originalJobs);

  store.setInterval(60);
  store.db.prepare("UPDATE sites SET next_sync=0 WHERE id=?").run(id);
  store.schedule();
  complete(store, id, {
    icon: "https://icon.example/changed.svg",
    favicon: { selected: "changed" },
  });
  store.queue(id);
  complete(store, id, { error: "Provider temporarily unavailable" });
  store.save({ ...config, name: "Edited name", password: "NEW-PASSWORD" }, id);
  store.save({ ...config, enabled: false }, id);
  await assert.rejects(resolve(id), { status: 404 });
  store.save(config, id);
  assert.deepEqual(await resolve(id), { icons: [savedIcon.selected] });
  assert.equal(calls, 1);

  const restarted = fixture.restart();
  assert.deepEqual(JSON.parse(restarted.row(id).favicon), savedIcon);
  assert.deepEqual(
    await createPersistentIconResolver(restarted, () => {
      throw new Error("Must not rediscover");
    })(id),
    { icons: [savedIcon.selected] },
  );
});

test("caches unavailable icons briefly and retries after the network recovers", async (t) => {
  const fixture = storage(t),
    id = fixture.store.save(config);
  let calls = 0;
  const discover = () => {
    calls++;
    throw new Error("Upstream unavailable");
  };
  const resolve = createPersistentIconResolver(fixture.store, discover);
  assert.deepEqual(await resolve(id), { icons: [] });
  assert.deepEqual(await resolve(id), { icons: [] });
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(fixture.store.row(id).favicon), {
    url: config.url,
    icons: [],
    selected: "",
    checked_at: JSON.parse(fixture.store.row(id).favicon).checked_at,
  });
  assert.ok(
    Number.isFinite(
      Date.parse(JSON.parse(fixture.store.row(id).favicon).checked_at),
    ),
  );
  assert.deepEqual(
    await createPersistentIconResolver(fixture.restart(), discover)(id),
    { icons: [] },
  );
  assert.equal(calls, 1);
  const row = fixture.store.row(id),
    state = JSON.parse(row.favicon);
  state.checked_at = new Date(Date.now() - 16 * 60000).toISOString();
  fixture.store.db
    .prepare("UPDATE sites SET favicon=? WHERE id=?")
    .run(JSON.stringify(state), id);
  assert.deepEqual(
    await createPersistentIconResolver(fixture.store, () => {
      calls++;
      return savedIcon;
    })(id),
    { icons: [savedIcon.selected] },
  );
  assert.equal(calls, 2);
});

test("old permanently cached failures are rediscovered once without changing selected icons", async (t) => {
  const { store } = storage(t),
    id = store.save(config);
  store.saveFavicon(id, store.row(id).revision, {
    url: config.url,
    icons: [],
    selected: "",
  });
  let calls = 0;
  const resolver = createPersistentIconResolver(store, () => {
    calls++;
    return savedIcon;
  });
  assert.deepEqual(await resolver(id), { icons: [savedIcon.selected] });
  assert.deepEqual(await resolver(id), { icons: [savedIcon.selected] });
  assert.equal(calls, 1);
});

test("URL changes invalidate selection and late discoveries cannot restore the old URL", async (t) => {
  const { store } = storage(t),
    id = store.save(config),
    started = deferred(),
    pending = deferred(),
    nextURL = "https://next-icon.example";
  let calls = 0;
  const resolve = createPersistentIconResolver(store, (site) => {
    calls++;
    if (site.url === config.url) {
      started.resolve();
      return pending.promise;
    }
    return {
      icons: [`${nextURL}/favicon.ico`],
      selected: `${nextURL}/favicon.ico`,
    };
  });
  const response = resolve(id);
  await started.promise;
  store.save({ ...config, url: nextURL }, id);
  pending.resolve(savedIcon);
  assert.deepEqual(await response, { icons: [`${nextURL}/favicon.ico`] });
  assert.equal(calls, 2);
  assert.equal(JSON.parse(store.row(id).favicon).url, nextURL);
  store.save({ ...config, url: "https://third-icon.example" }, id);
  assert.equal(store.row(id).favicon, null);
});

test("late discovery neither overwrites restored icons nor recreates deleted sites", async (t) => {
  const { store } = storage(t),
    id = store.save(config),
    started = deferred(),
    pending = deferred();
  const resolve = createPersistentIconResolver(store, () => {
    started.resolve();
    return pending.promise;
  });
  const response = resolve(id);
  await started.promise;
  const data = store.exportData(),
    restored = {
      url: config.url,
      icons: ["https://icon.example/restored.svg"],
      selected: "https://icon.example/restored.svg",
    };
  data.sites[0].favicon = restored;
  store.importData(data);
  pending.resolve(savedIcon);
  assert.deepEqual(await response, { icons: [restored.selected] });
  assert.deepEqual(JSON.parse(store.row(id).favicon), restored);

  const other = store.save({ ...config, url: "https://deleted-icon.example" }),
    deletionStarted = deferred(),
    deletionPending = deferred();
  const deletedResponse = createPersistentIconResolver(store, () => {
    deletionStarted.resolve();
    return deletionPending.promise;
  })(other);
  await deletionStarted.promise;
  store.remove(other);
  deletionPending.resolve({
    icons: ["https://deleted-icon.example/favicon.ico"],
  });
  await assert.rejects(deletedResponse, { status: 404 });
  assert.equal(store.row(other), undefined);
});

test("preserves explicit legacy icons without making server-side requests", async (t) => {
  const { store } = storage(t),
    id = store.save({ ...config, icon: "https://legacy-icon.example" });
  const resolve = createPersistentIconResolver(store, () => {
    throw new Error("No network request allowed");
  });
  assert.deepEqual(await resolve(id), {
    icons: ["https://legacy-icon.example/"],
  });
  assert.equal(
    JSON.parse(store.row(id).favicon).selected,
    "https://legacy-icon.example/",
  );
});

for (const format of ["json", "sqlite"]) {
  test(`${format} backups retain selected candidates and the saved fallback`, async (t) => {
    const { store: source } = storage(t),
      { store: destination } = storage(t),
      id = source.save(config),
      hidden = source.save({
        ...config,
        url: "https://hidden-icon.example",
        enabled: false,
      });
    source.saveFavicon(id, source.row(id).revision, savedIcon);
    const fallback = {
      url: "https://hidden-icon.example",
      icons: ["https://hidden-icon.example/favicon.ico"],
      selected: "",
    };
    source.saveFavicon(hidden, source.row(hidden).revision, fallback);
    const bytes = await serializeBackup(source, format);
    destination.importData(parseBackup(bytes, format), "replace");
    assert.deepEqual(JSON.parse(destination.row(id).favicon), savedIcon);
    assert.deepEqual(JSON.parse(destination.row(hidden).favicon), fallback);
    let calls = 0;
    assert.deepEqual(
      await createPersistentIconResolver(destination, () => {
        calls++;
        return { icons: [] };
      })(id),
      { icons: [savedIcon.selected] },
    );
    assert.equal(calls, 0);
  });

  test(`${format} backups without favicon metadata remain importable`, async (t) => {
    const { store: source } = storage(t),
      { store: destination } = storage(t),
      id = source.save(config);
    let bytes;
    if (format === "json") {
      const data = source.exportData();
      delete data.sites[0].favicon;
      bytes = Buffer.from(JSON.stringify(data));
    } else {
      source.db.exec("ALTER TABLE sites DROP COLUMN favicon");
      bytes = await serializeBackup(source, format);
    }
    destination.importData(parseBackup(bytes, format));
    assert.equal(destination.row(id).favicon, null);
    assert.deepEqual(
      await createPersistentIconResolver(
        destination,
        async () => savedIcon,
      )(id),
      { icons: [savedIcon.selected] },
    );
  });
}

test("migrates old databases and validates favicon metadata before imports", (t) => {
  const fixture = storage(t),
    id = fixture.store.save(config),
    adminPath = fixture.store.adminPath;
  fixture.store.db.exec("ALTER TABLE sites DROP COLUMN favicon");
  const store = fixture.restart();
  assert.equal(store.adminPath, adminPath);
  assert.equal(store.row(id).favicon, null);
  const original = store.exportData();
  for (const favicon of [
    { ...savedIcon, url: "https://wrong.example" },
    { ...savedIcon, selected: "https://not-a-candidate.example/icon.svg" },
    {
      ...savedIcon,
      icons: Array.from(
        { length: 13 },
        (_, n) => `https://icon.example/${n}.ico`,
      ),
    },
    { ...savedIcon, icons: [savedIcon.selected, savedIcon.selected] },
    {
      url: config.url,
      icons: ["file:///etc/passwd"],
      selected: "file:///etc/passwd",
    },
    {
      url: config.url,
      icons: ["https://user:password@icon.example/i.svg"],
      selected: "",
    },
  ]) {
    const data = structuredClone(original);
    data.sites[0].favicon = favicon;
    data.settings.sync_interval_seconds = 120;
    assert.throws(() => store.importData(data), { status: 400 });
    assert.deepEqual(store.exportData().sites, original.sites);
    assert.equal(store.interval, 900);
  }
});

test("SQLite imports reject malformed saved favicon JSON instead of clearing the selection", async (t) => {
  const { store, dir } = storage(t),
    id = store.save(config),
    path = join(dir, "malformed.db"),
    original = await serializeBackup(store, "sqlite");
  for (const value of ["", "0", "false", "[]"]) {
    writeFileSync(path, original, { mode: 0o600 });
    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE sites SET favicon=? WHERE id=?").run(value, id);
    } finally {
      db.close();
    }
    assert.throws(() => parseBackup(readFileSync(path), "sqlite"), {
      status: 400,
    });
  }
});

test("the public icon endpoint persists independently of signed sync callbacks", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cerium-icon-http-")),
    secret = "cerium-icon-test-secret-32-characters";
  let calls = 0;
  const app = createApp({
    secret,
    dbPath: join(dir, "web.db"),
    dispatch: false,
    resolveIcon: async () => {
      calls++;
      return savedIcon;
    },
    log: () => {},
  });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const origin = `http://127.0.0.1:${app.server.address().port}`,
    id = app.store.save(config),
    path = `${origin}/api/sites/${id}/icon`;
  assert.equal(calls, 0);
  const response = await fetch(path);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { icons: [savedIcon.selected] });
  const job = app.store.nextJob(),
    timestamp = String(Math.floor(Date.now() / 1000)),
    body = JSON.stringify({
      job_id: job.id,
      site_id: id,
      config_revision: job.revision,
      url: config.url,
      type: config.type,
      checked_at: new Date().toISOString(),
      catalog: { scope: "public", groups: [] },
      icon: "https://icon.example/worker-must-not-change.svg",
    });
  const synced = await fetch(`${origin}/api/webhooks/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cerium-Event": "sync.completed",
      "X-Cerium-Timestamp": timestamp,
      "X-Cerium-Signature": sign(secret, timestamp, body),
    },
    body,
  });
  assert.equal(synced.status, 200);
  await synced.body?.cancel();
  assert.deepEqual(await (await fetch(path)).json(), {
    icons: [savedIcon.selected],
  });
  assert.equal(calls, 1);
  app.store.save({ ...config, enabled: false }, id);
  const hidden = await fetch(path);
  assert.equal(hidden.status, 404);
  await hidden.body?.cancel();
  assert.equal(calls, 1);
});
