import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp, sign } from "../server/index.mjs";
import { Dispatcher } from "../server/dispatcher.mjs";
import { Store } from "../server/store.mjs";
import { createRecovery } from "../server/recovery.mjs";
import { gzipSync, gunzipSync } from "node:zlib";
import { request as httpRequest } from "node:http";

const secret = "cerium-operations-test-32-character-secret";
const config = {
  name: "Operations relay",
  url: "https://operations.example",
  type: "newapi",
  account: "PRIVATE-ACCOUNT",
  password: "PRIVATE-PASSWORD",
  payment_methods: [],
  recharge_cny: 1,
  recharge_usd: 1,
};

function storage(t) {
  const dir = mkdtempSync(join(tmpdir(), "cerium-operations-"));
  const store = new Store(join(dir, "web.db"));
  t.after(() => {
    if (store.db.isOpen) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir };
}

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cerium-operations-http-"));
  const logs = [];
  const app = createApp({
    secret,
    dbPath: join(dir, "web.db"),
    dispatch: false,
    log: (value) => logs.push(value),
    ...options,
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const base = `${app.adminPath}/api`;
  let cookie = "";
  async function request(path, method = "GET", value, headers = {}) {
    return fetch(origin + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Cerium-Admin": "1",
        Cookie: cookie,
        ...headers,
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  }
  async function login() {
    const response = await request(`${base}/login`, "POST", {
      password: logs[0].split(": ").at(-1),
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie").split(";")[0];
  }
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    ...app,
    base,
    logs,
    request,
    login,
    origin,
    get cookie() {
      return cookie;
    },
  };
}

function streamedRequest(t, app, path, raw, headers = {}) {
  const started = once(app.server, "request");
  const request = httpRequest(app.origin + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(raw),
      Origin: app.origin,
      Cookie: app.cookie,
      "X-Cerium-Admin": "1",
      ...headers,
    },
  });
  t.after(() => request.destroy());
  const finished = new Promise((resolve, reject) => {
    request.once("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () =>
        resolve({ status: response.statusCode, bytes: Buffer.concat(chunks) }),
      );
    });
    request.once("error", reject);
  });
  request.write(raw.slice(0, 1));
  return { request, started, finished };
}

test(
  "an interrupted import releases maintenance without changing data or leaving dispatch paused",
  { timeout: 15000 },
  async (t) => {
    const app = await fixture(t);
    await app.login();
    app.store.save(config);
    const before = app.store.exportData().sites;
    const raw = JSON.stringify(app.store.exportData());
    const slow = streamedRequest(t, app, `${app.base}/data/import`, raw);
    const interrupted = assert.rejects(slow.finished);
    await slow.started;
    slow.request.destroy();
    await interrupted;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (app.logs.some((entry) => entry.includes('"stage":"backup_import"')))
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(
      app.logs.some((entry) => entry.includes('"stage":"backup_import"')),
    );
    assert.deepEqual(app.store.exportData().sites, before);
    const readiness = await (await app.request("/readyz")).json();
    assert.equal(readiness.maintenance, null);
    assert.equal(readiness.dispatcher.paused, false);
    assert.equal(
      (
        await app.request(`${app.base}/settings`, "PUT", {
          sync_interval_seconds: 120,
        })
      ).status,
      200,
    );
  },
);

test(
  "ordinary export drains a worker delivery before reading and resumes dispatch afterwards",
  { timeout: 15000 },
  async (t) => {
    let release;
    const delivered = new Promise((resolve) => {
      release = resolve;
    });
    const app = await fixture(t, {
      fetchWorker: async () => {
        await delivered;
        return new Response("{}", { status: 200 });
      },
    });
    t.after(() => release());
    await app.login();
    app.store.save(config);
    const dispatch = app.tick();
    const started = once(app.server, "request");
    let completed = false;
    const backup = app
      .request(`${app.base}/data/export`, "POST")
      .then((response) => {
        completed = true;
        return response;
      });
    await started;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const completedBeforeDelivery = completed;
    release();
    await dispatch;
    const response = await backup;
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(completedBeforeDelivery, false);
    const readiness = await (await app.request("/readyz")).json();
    assert.equal(readiness.dispatcher.paused, false);
  },
);

test(
  "a worker already delivering can finish its callback while export waits for it",
  { timeout: 15000 },
  async (t) => {
    let release;
    const proceed = new Promise((resolve) => {
      release = resolve;
    });
    let callbackStatus;
    const app = await fixture(t, {
      fetchWorker: async (_url, options) => {
        const job = JSON.parse(options.body);
        await proceed;
        const result = {
          job_id: job.job_id,
          site_id: job.site_id,
          config_revision: job.config_revision,
          url: job.url,
          type: job.type,
          checked_at: new Date().toISOString(),
          error: "Delivery completed before backup",
        };
        const timestamp = String(Math.floor(Date.now() / 1000));
        const callback = await app.request(
          "/api/webhooks/sync",
          "POST",
          result,
          {
            "X-Cerium-Timestamp": timestamp,
            "X-Cerium-Signature": sign(
              secret,
              timestamp,
              JSON.stringify(result),
            ),
            "X-Cerium-Event": "sync.completed",
          },
        );
        callbackStatus = callback.status;
        return new Response("{}", { status: callback.ok ? 200 : 503 });
      },
    });
    await app.login();
    const id = app.store.save(config);
    const dispatch = app.tick();
    const started = once(app.server, "request");
    const backup = app.request(`${app.base}/data/export`, "POST");
    await started;
    release();
    await dispatch;
    const response = await backup;
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(callbackStatus, 200);
    assert.equal(
      data.sites.find((site) => site.id === id).error,
      "Delivery completed before backup",
    );
  },
);

for (const format of ["json", "sqlite"]) {
  test(
    `ordinary ${format} exports wait for already admitted callback writes`,
    { timeout: 15000 },
    async (t) => {
      const app = await fixture(t);
      await app.login();
      const id = app.store.save(config),
        job = app.store.nextJob(),
        raw = JSON.stringify({
          job_id: job.id,
          site_id: id,
          config_revision: job.revision,
          url: config.url,
          type: config.type,
          checked_at: new Date().toISOString(),
          error: "Callback included before export",
        }),
        timestamp = String(Math.floor(Date.now() / 1000));
      const slow = streamedRequest(t, app, "/api/webhooks/sync", raw, {
        "X-Cerium-Timestamp": timestamp,
        "X-Cerium-Signature": sign(secret, timestamp, raw),
        "X-Cerium-Event": "sync.completed",
      });
      await slow.started;
      const started = once(app.server, "request");
      let settled = false;
      const exported = app
        .request(`${app.base}/data/export?format=${format}`, "POST")
        .then((response) => {
          settled = true;
          return response;
        });
      await started;
      await new Promise((resolve) => setTimeout(resolve, 150));
      const completedBeforeCallback = settled;
      slow.request.end(raw.slice(1));
      assert.equal((await slow.finished).status, 200);
      const response = await exported;
      assert.equal(response.status, 200);
      const { parseBackup } = await import("../server/backup.mjs");
      const data = parseBackup(
        Buffer.from(await response.arrayBuffer()),
        format,
      );
      assert.equal(
        completedBeforeCallback,
        false,
        "export must wait for the incomplete callback",
      );
      assert.equal(data.sites[0].error, "Callback included before export");
    },
  );
}

test(
  "a streamed import blocks new writes, callbacks and discovery and releases maintenance on success or failure",
  { timeout: 15000 },
  async (t) => {
    const app = await fixture(t, { resolveIcon: async () => ({ icons: [] }) });
    await app.login();
    const id = app.store.save(config);
    const raw = JSON.stringify(app.store.exportData());
    const slow = streamedRequest(t, app, `${app.base}/data/import`, raw);
    await slow.started;
    await new Promise((resolve) => setImmediate(resolve));
    const blocked = await app.request(`${app.base}/settings`, "PUT", {
      sync_interval_seconds: 120,
    });
    const intervalDuringImport = app.store.interval;
    const callback = await app.request("/api/webhooks/sync", "POST", {});
    const icon = await app.request(`/api/sites/${id}/icon`);
    const overlappingExport = await app.request(
      `${app.base}/data/export`,
      "POST",
    );
    assert.equal((await app.request("/healthz")).status, 200);
    assert.equal((await app.request("/api/sites")).status, 200);
    slow.request.end(raw.slice(1));
    assert.equal((await slow.finished).status, 200);
    assert.equal(blocked.status, 409);
    assert.equal(intervalDuringImport, 900);
    assert.equal(callback.status, 503);
    assert.equal(icon.status, 503);
    assert.equal(overlappingExport.status, 409);
    assert.equal(
      (await app.request(`${app.base}/data/import`, "POST", {})).status,
      400,
    );
    assert.equal(
      (
        await app.request(`${app.base}/settings`, "PUT", {
          sync_interval_seconds: 120,
        })
      ).status,
      200,
    );
    assert.equal(app.store.interval, 120);
  },
);

test("directory responses negotiate gzip and conditional requests and invalidate on content change", async (t) => {
  const app = await fixture(t);
  const id = app.store.save({
    ...config,
    description: "Large metadata ".repeat(40),
    payment_note: "Large metadata ".repeat(40),
  });
  const first = await app.request("/api/sites", "GET", undefined, {
    "Accept-Encoding": "gzip",
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-encoding"), "gzip");
  assert.equal(first.headers.get("cache-control"), "public, no-cache");
  const tag = first.headers.get("etag");
  assert.match(tag, /^W\/"/);
  assert.equal((await first.json()).sites[0].name, config.name);
  const unchanged = await app.request("/api/sites", "GET", undefined, {
    "If-None-Match": tag,
    "Accept-Encoding": "identity",
  });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");
  app.store.save({ ...config, name: "Updated relay", password: "" }, id);
  const changed = await app.request("/api/sites", "GET", undefined, {
    "If-None-Match": tag,
  });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), tag);
  await app.login();
  const admin = await app.request(`${app.base}/sites`);
  assert.equal(admin.headers.get("cache-control"), "private, no-cache");
});

test("readiness distinguishes a disabled dispatcher from HTTP liveness", async (t) => {
  const app = await fixture(t);
  assert.equal((await app.request("/healthz")).status, 200);
  const response = await app.request("/readyz");
  assert.equal(response.status, 503);
  const state = await response.json();
  assert.equal(state.database.ready, true);
  assert.equal(state.dispatcher.enabled, false);
  assert.equal(state.dispatcher.ready, false);
  assert.equal(state.worker.ready, false);
  assert.ok(!JSON.stringify(state).includes(config.password));
});

test("internal failures expose a safe category, stage and correlation identifier", async (t) => {
  const app = await fixture(t);
  app.store.sites = () => {
    throw Object.assign(new Error("PRIVATE-PASSWORD and SQLite query text"), {
      code: "ERR_SQLITE_ERROR",
    });
  };
  const response = await app.request("/api/sites");
  assert.equal(response.status, 500);
  const value = await response.json();
  assert.equal(value.category, "storage_failure");
  assert.equal(value.request_id, response.headers.get("x-cerium-request-id"));
  assert.ok(!JSON.stringify(value).includes("PRIVATE-PASSWORD"));
  const logged = JSON.parse(app.logs.at(-1));
  assert.equal(logged.request_id, value.request_id);
  assert.equal(logged.category, "storage_failure");
  assert.ok(!JSON.stringify(logged).includes("SQLite query text"));
});

test("admin writes require the latest revision and model refresh requires confirmation", async (t) => {
  const app = await fixture(t);
  await app.login();
  const id = app.store.save(config);
  const initial = app.store.row(id).revision;
  const route = `${app.base}/sites/${id}`;
  assert.equal(
    (await app.request(route, "PUT", { ...config, name: "Missing revision" }))
      .status,
    428,
  );
  assert.equal(
    (
      await app.request(route, "PUT", {
        ...config,
        name: "First edit",
        revision: initial,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await app.request(route, "PUT", {
        ...config,
        name: "Stale edit",
        revision: initial,
      })
    ).status,
    409,
  );
  assert.equal(JSON.parse(app.store.row(id).config).name, "First edit");
  assert.equal(
    (await app.request(`${route}/models/refresh`, "POST", { confirmed: false }))
      .status,
    400,
  );
  assert.equal(
    (await app.request(`${route}/models/refresh`, "POST", { confirmed: true }))
      .status,
    409,
  );
  app.store.db.prepare("UPDATE jobs SET state='done',payload='{}'").run();
  assert.equal(
    (await app.request(`${route}/models/refresh`, "POST", { confirmed: true }))
      .status,
    202,
  );
  const job = app.store.db
    .prepare("SELECT payload FROM jobs WHERE state='pending'")
    .get();
  assert.equal(JSON.parse(job.payload).refresh_models, true);
  const page = await app.request(
    `${app.base}/changes?limit=10&offset=0&q=First`,
  );
  assert.equal(page.status, 200);
  assert.deepEqual(await page.json(), {
    changes: [],
    total: 0,
    offset: 0,
    limit: 10,
  });
});

test("recovery maintenance rejects callback/admin mutations without blocking liveness", async (t) => {
  const app = await fixture(t);
  await app.login();
  app.store.db
    .prepare("INSERT INTO settings(key,value) VALUES('recovery_pending',?)")
    .run(Buffer.from("{}").toString("base64"));
  assert.equal((await app.request("/healthz")).status, 200);
  assert.equal(
    (await app.request(`${app.base}/sites`, "POST", config)).status,
    409,
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await app.request(
    "/api/webhooks/sync",
    "POST",
    {},
    {
      "X-Cerium-Timestamp": timestamp,
      "X-Cerium-Signature": sign(secret, timestamp, "{}"),
      "X-Cerium-Event": "sync.completed",
    },
  );
  assert.equal(response.status, 503);
  const ready = await (await app.request("/readyz")).json();
  assert.equal(ready.maintenance, "recovery_pending");
});

test("recovery drains callbacks whose streamed bodies began before the maintenance barrier", async (t) => {
  let exports = 0;
  const app = await fixture(t, {
    fetchWorker: async (url) => {
      assert.ok(url.endsWith("/v1/recovery/export"));
      exports++;
      const bytes = Buffer.from(
        JSON.stringify({
          format: "cerium-worker-recovery",
          version: 1,
          tables: {},
        }),
      );
      const timestamp = String(Math.floor(Date.now() / 1000));
      return new Response(bytes, {
        headers: {
          "X-Cerium-Timestamp": timestamp,
          "X-Cerium-Signature": sign(secret, timestamp, bytes),
        },
      });
    },
  });
  await app.login();
  const id = app.store.save(config),
    job = app.store.nextJob(),
    raw = JSON.stringify({
      job_id: job.id,
      site_id: id,
      config_revision: job.revision,
      url: config.url,
      type: config.type,
      checked_at: new Date().toISOString(),
      error: "Completed before snapshot",
    }),
    timestamp = String(Math.floor(Date.now() / 1000));
  const callbackStarted = once(app.server, "request");
  const slow = httpRequest(`${app.origin}/api/webhooks/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(raw),
      "X-Cerium-Timestamp": timestamp,
      "X-Cerium-Signature": sign(secret, timestamp, raw),
      "X-Cerium-Event": "sync.completed",
    },
  });
  const callbackFinished = new Promise((resolve, reject) => {
    slow.once("response", (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    slow.once("error", reject);
  });
  slow.write(raw.slice(0, 1));
  await callbackStarted;
  const recoveryStarted = once(app.server, "request");
  const backup = app.request(`${app.base}/data/recovery/export`, "POST");
  await recoveryStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    exports,
    0,
    "the snapshot must wait for the existing callback body",
  );
  slow.end(raw.slice(1));
  assert.equal(await callbackFinished, 200);
  const response = await backup;
  assert.equal(response.status, 200);
  assert.equal(exports, 1);
  assert.equal(app.store.row(id).error, "Completed before snapshot");
  await response.arrayBuffer();
});

test("dispatcher fills bounded slots without serially awaiting unrelated sites", async (t) => {
  const { store } = storage(t);
  for (let index = 0; index < 6; index++)
    store.save({ ...config, url: `https://site-${index}.example` });
  const release = [];
  let peak = 0,
    running = 0;
  const dispatcher = new Dispatcher({
    store,
    backend: "http://worker",
    secret,
    sign,
    log() {},
    concurrency: 3,
    enabled: false,
    fetchWorker: async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => release.push(resolve));
      running--;
      return new Response("{}", { status: 200 });
    },
  });
  dispatcher.fill();
  assert.equal(dispatcher.active.size, 3);
  assert.equal(
    store.db
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE state='running'")
      .get().count,
    3,
  );
  for (const resolve of release.splice(0)) resolve();
  await Promise.all([...dispatcher.active.values()]);
  dispatcher.fill();
  assert.equal(dispatcher.active.size, 3);
  for (const resolve of release.splice(0)) resolve();
  await dispatcher.close();
  assert.equal(peak, 3);
});

test("permanent callback rejection is terminal while transport errors retain replayable payload", async (t) => {
  const { store } = storage(t);
  const failedId = store.save(config);
  const retryId = store.save({ ...config, url: "https://transport.example" });
  const dispatcher = new Dispatcher({
    store,
    backend: "http://worker",
    secret,
    sign,
    log() {},
    enabled: false,
    fetchWorker: async (_, options) =>
      JSON.parse(options.body).site_id === failedId
        ? Response.json(
            { code: "callback_rejected", stage: "callback" },
            { status: 422 },
          )
        : Promise.reject(new TypeError("PRIVATE-PASSWORD in socket error")),
  });
  await dispatcher.tick();
  const failed = store.db
    .prepare("SELECT * FROM jobs WHERE site_id=?")
    .get(failedId);
  assert.equal(failed.state, "failed");
  assert.equal(failed.payload, "{}");
  const retry = store.db
    .prepare("SELECT * FROM jobs WHERE site_id=?")
    .get(retryId);
  assert.equal(retry.state, "pending");
  assert.notEqual(retry.payload, "{}");
  assert.ok(!retry.error.includes("PRIVATE-PASSWORD"));
  await dispatcher.close();
});

test("complete recovery validates checksums before worker writes and restores both durable components", async (t) => {
  const { store } = storage(t);
  const id = store.save(config);
  const state = () => ({
    settings: store.db.prepare("SELECT * FROM settings").all(),
    sites: store.db.prepare("SELECT * FROM sites").all(),
    jobs: store.db.prepare("SELECT * FROM jobs").all(),
    changes: store.db.prepare("SELECT * FROM catalog_changes").all(),
  });
  let snapshot = state(),
    workerState = "saved-key-cleanup",
    workerWrites = 0,
    paused = false;
  const dispatcher = {
    pause: async () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
  };
  const recovery = createRecovery({
    store,
    dispatcher,
    backend: "http://worker",
    secret,
    sign,
    log() {},
    storage: {
      exportRecoveryDatabase: async () => Buffer.from("fake-validated-sqlite"),
      parseRecoveryDatabase: async () => snapshot,
    },
    fetchWorker: async (url, options) => {
      assert.equal(paused, true);
      const path = url.split("/").at(-1);
      assert.equal(
        options.headers["X-Cerium-Signature"],
        sign(
          secret,
          options.headers["X-Cerium-Timestamp"],
          Buffer.concat([
            Buffer.from(`/v1/recovery/${path}\n`),
            Buffer.from(options.body),
          ]),
        ),
      );
      const incoming = JSON.parse(options.body);
      if (path === "import") {
        workerState = incoming.marker;
        workerWrites++;
      }
      const bytes = Buffer.from(
        JSON.stringify(
          path === "export" ? { marker: workerState } : { valid: true },
        ),
      );
      const timestamp = String(Math.floor(Date.now() / 1000));
      return new Response(bytes, {
        headers: {
          "X-Cerium-Timestamp": timestamp,
          "X-Cerium-Signature": sign(secret, timestamp, bytes),
        },
      });
    },
  });
  const archive = await recovery.export();
  const inflated = gunzipSync(archive),
    header = "CERIUM-RECOVERY/2\n",
    manifestEnd = inflated.indexOf(10, header.length),
    broken = JSON.parse(
      inflated.subarray(header.length, manifestEnd).toString("utf8"),
    );
  broken.components.worker.sha256 = "0".repeat(64);
  await assert.rejects(
    recovery.import(
      gzipSync(
        Buffer.concat([
          Buffer.from(header),
          Buffer.from(JSON.stringify(broken) + "\n"),
          inflated.subarray(manifestEnd + 1),
        ]),
      ),
    ),
    {
      status: 400,
    },
  );
  assert.equal(workerWrites, 0);
  store.remove(id);
  workerState = "replacement-state";
  const result = await recovery.import(archive);
  assert.equal(result.restored, true);
  assert.equal(store.row(id).id, id);
  assert.equal(workerState, "saved-key-cleanup");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count,
    1,
  );
  assert.equal(paused, false);

  snapshot = {
    ...snapshot,
    sites: snapshot.sites.map((row) => ({ ...row, config: null })),
  };
  workerState = "before-failed-import";
  await assert.rejects(recovery.import(archive));
  assert.equal(workerState, "before-failed-import");
  assert.equal(store.row(id).id, id);
  assert.equal(
    store.db
      .prepare("SELECT value FROM settings WHERE key='recovery_pending'")
      .get(),
    undefined,
  );
  assert.equal(paused, false);

  store.db
    .prepare("INSERT INTO settings(key,value) VALUES('recovery_pending',?)")
    .run(
      Buffer.from(JSON.stringify({ marker: "original-before-crash" })).toString(
        "base64",
      ),
    );
  workerState = "half-restored-on-crash";
  await recovery.reconcile();
  assert.equal(workerState, "original-before-crash");
  assert.equal(recovery.pending(), false);
});
