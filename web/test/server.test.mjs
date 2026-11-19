import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp, sign } from "../server/index.mjs";
import { Store } from "../server/store.mjs";

const secret = "cerium-test-shared-secret-32-characters";
const config = {
  name: "Test relay",
  url: "https://relay.example",
  type: "newapi",
  account: "PRIVATE-ACCOUNT",
  password: "PRIVATE-PASSWORD",
  description: "A test relay",
  icon: "",
  payment_methods: ["LDXP", "闲鱼"],
  recharge_cny: 10,
  recharge_usd: 20,
  recharge_multiplier: 2,
};
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "cerium-web-"));
  let logs;
  const app = createApp({
    secret,
    dbPath: join(dir, "web.db"),
    dispatch: false,
    log: (s) => {
      logs = s;
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const password = logs.split(": ").at(-1),
    base = app.adminPath + "/api";
  let cookie = "";
  async function request(path, method = "GET", data, extra = {}) {
    const siteId = path.match(/\/sites\/([\da-f-]{36})$/)?.[1];
    if (
      method === "PUT" &&
      siteId &&
      data &&
      typeof data === "object" &&
      !Array.isArray(data)
    )
      data = { revision: app.store.row(siteId)?.revision, ...data };
    const response = await fetch(origin + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Cerium-Admin": "1",
        Cookie: cookie,
        ...extra,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return response;
  }
  async function login() {
    const response = await request(base + "/login", "POST", { password });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie").split(";")[0];
    return response;
  }
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...app, request, login, base, password, origin, dir };
}
test("random admin route, authentication, CSRF, rate limit and credential redaction", async (t) => {
  const f = await fixture(t);
  assert.match(f.adminPath, /^\/manage-[a-f0-9]{36}$/);
  assert.equal((await f.request("/admin")).status, 404);
  assert.equal((await f.request(f.base + "/sites")).status, 401);
  assert.equal(
    (
      await f.request(
        f.base + "/login",
        "POST",
        { password: f.password },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const login = await f.login();
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal(
    (await f.request(f.base + "/sites", "POST", config)).status,
    201,
  );
  const pub = await (await f.request("/api/sites")).text();
  assert.ok(
    !pub.includes(config.account) &&
      !pub.includes(config.password) &&
      !pub.includes(f.adminPath),
  );
  const admin = await (await f.request(f.base + "/sites")).json();
  assert.equal(admin.sites[0].has_password, true);
  assert.equal(admin.sites[0].password, undefined);
  assert.equal((await f.request(f.base + "/logout", "POST")).status, 200);
  assert.equal((await f.request(f.base + "/sites")).status, 401);
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await f.request(f.base + "/login", "POST", { password: "wrong" }))
        .status,
      401,
    );
  assert.equal(
    (await f.request(f.base + "/login", "POST", { password: "wrong" })).status,
    429,
  );
});
test("validation, unchanged password, manual sites and disabled visibility", async (t) => {
  const f = await fixture(t);
  await f.login();
  assert.equal(
    (
      await f.request(f.base + "/sites", "POST", {
        ...config,
        url: "javascript:alert(1)",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(f.base + "/sites", "POST", {
        ...config,
        recharge_usd: null,
      })
    ).status,
    400,
  );
  const { id } = await (
    await f.request(f.base + "/sites", "POST", config)
  ).json();
  assert.equal(
    (await f.request(f.base + "/sites", "POST", config)).status,
    409,
  );
  assert.equal(
    (
      await f.request(`${f.base}/sites/${id}`, "PUT", {
        ...config,
        password: "",
        enabled: false,
      })
    ).status,
    200,
  );
  assert.equal(JSON.parse(f.store.row(id).config).password, config.password);
  assert.equal((await (await f.request("/api/sites")).json()).sites.length, 0);
  const manual = {
    ...config,
    name: "Manual",
    type: "others",
    account: "",
    password: "",
    manual_catalog: {
      groups: [
        {
          id: "g",
          name: "Public",
          multiplier: 0,
          models: [],
          models_known: true,
        },
      ],
    },
  };
  assert.equal(
    (await f.request(f.base + "/sites", "POST", manual)).status,
    201,
  );
  const data = await (await f.request("/api/sites")).json();
  assert.equal(data.sites[0].status, "manual");
  assert.equal(data.sites[0].catalog.groups[0].multiplier, 0);
});
test("manual sync advances a backed-off job without replaying a running job", async (t) => {
  const f = await fixture(t);
  await f.login();
  const id = f.store.save(config),
    job = f.store.nextJob();
  f.store.retry(job, "Worker temporarily unreachable");
  assert.equal(f.store.nextJob(), undefined);
  const before = f.store.db
    .prepare("SELECT * FROM jobs WHERE id=?")
    .get(job.id);
  assert.equal(before.state, "pending");
  const response = await f.request(`${f.base}/sites/${id}/sync`, "POST");
  assert.equal(response.status, 202);
  const next = f.store.nextJob();
  assert.equal(next?.id, job.id);
  assert.equal(next.payload, before.payload);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1);
  await f.request(`${f.base}/sites/${id}/sync`, "POST");
  assert.equal(f.store.nextJob(), undefined);
  assert.equal(
    f.store.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id).state,
    "running",
  );
});
test("a fresh manual retry takes status precedence over the last failed attempt", async (t) => {
  const f = await fixture(t);
  await f.login();
  const id = f.store.save(config),
    job = f.store.nextJob();
  f.store.accept({
    job_id: job.id,
    site_id: id,
    config_revision: job.revision,
    url: config.url,
    type: config.type,
    checked_at: new Date().toISOString(),
    error: "Provider temporarily unavailable",
  });
  assert.equal(f.store.sites(true)[0].status, "error");
  await f.request(`${f.base}/sites/${id}/sync`, "POST");
  assert.equal(f.store.sites(true)[0].status, "pending");
  assert.equal(
    f.store.sites(true)[0].error,
    "Provider temporarily unavailable",
  );
});
test("change announcements require successful comparisons and authenticated moderation", async (t) => {
  const f = await fixture(t);
  await f.login();
  const manual = {
    ...config,
    name: "Notice relay",
    type: "others",
    account: "",
    password: "",
    manual_catalog: {
      groups: [
        {
          id: "base",
          name: "Base",
          multiplier: 1,
          models: [],
          models_known: true,
        },
      ],
    },
  };
  const { id } = await (
    await f.request(f.base + "/sites", "POST", manual)
  ).json();
  assert.deepEqual((await (await f.request("/api/sites")).json()).changes, []);
  assert.equal(
    (
      await f.request(`${f.base}/sites/${id}`, "PUT", {
        ...manual,
        manual_catalog: {
          groups: [
            {
              id: "base",
              name: "Base",
              multiplier: 0.5,
              models: [],
              models_known: true,
            },
            {
              id: "new",
              name: "New",
              multiplier: 2,
              models: [],
              models_known: true,
            },
          ],
        },
      })
    ).status,
    200,
  );
  const publicData = await (await f.request("/api/sites")).json();
  assert.equal(publicData.changes.length, 1);
  assert.deepEqual(
    publicData.changes[0].details.map((change) => change.kind),
    ["multiplier", "added"],
  );
  const noticeId = publicData.changes[0].id;
  const route = `${f.base}/changes/${noticeId}/visibility`;
  assert.equal(
    (await f.request(route, "POST", { visible: false }, { Cookie: "" })).status,
    401,
  );
  assert.equal(
    (
      await f.request(
        route,
        "POST",
        { visible: false },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.request(route, "POST", { visible: "false" })).status,
    400,
  );
  assert.equal(
    (await f.request(route, "POST", { visible: false })).status,
    200,
  );
  assert.deepEqual((await (await f.request("/api/sites")).json()).changes, []);
  const admin = await (await f.request(f.base + "/sites")).json();
  assert.equal(admin.changes[0].dismissed, true);
  assert.equal((await f.request(route, "POST", { visible: true })).status, 200);
  assert.equal(
    (await (await f.request("/api/sites")).json()).changes.length,
    1,
  );
});
test("signed callbacks, stale revisions, replay idempotency and last-good snapshots", async (t) => {
  const f = await fixture(t);
  const id = f.store.save(config);
  let job = f.store.nextJob();
  const result = (j) => ({
    job_id: j.id,
    site_id: id,
    config_revision: j.revision,
    checked_at: new Date().toISOString(),
    url: config.url,
    type: config.type,
    catalog: {
      scope: "public",
      groups: [
        {
          id: "default",
          name: "default",
          multiplier: 1,
          models: ["gpt-test"],
          models_known: true,
        },
      ],
    },
  });
  async function publish(
    value,
    timestamp = String(Math.floor(Date.now() / 1000)),
  ) {
    const body = JSON.stringify(value);
    return f.request("/api/webhooks/sync", "POST", value, {
      "X-Cerium-Timestamp": timestamp,
      "X-Cerium-Signature": sign(secret, timestamp, body),
      "X-Cerium-Event": "sync.completed",
    });
  }
  assert.equal(
    (await f.request("/api/webhooks/sync", "POST", result(job))).status,
    401,
  );
  assert.equal((await publish(result(job), "1000")).status, 401);
  assert.equal(
    (
      await publish({
        ...result(job),
        catalog: { scope: "account", groups: [] },
      })
    ).status,
    400,
  );
  for (const groups of [
    [null],
    [{ id: "default", name: "Default", prices: [null] }],
  ]) {
    const before = f.store.row(id);
    assert.equal(
      (
        await publish({
          ...result(job),
          catalog: { scope: "public", groups },
        })
      ).status,
      400,
    );
    assert.deepEqual(f.store.row(id), before);
    assert.equal(
      f.store.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id).state,
      "running",
    );
  }
  assert.equal((await publish(result(job))).status, 200);
  assert.equal((await publish(result(job))).status, 200);
  const original = f.store.row(id).snapshot;
  f.store.queue(id);
  job = f.store.nextJob();
  assert.equal(
    (
      await publish({
        ...result(job),
        error: "Login failed",
        catalog: undefined,
      })
    ).status,
    200,
  );
  assert.equal(f.store.row(id).snapshot, original);
  assert.equal(f.store.sites()[0].status, "error");
  f.store.queue(id);
  job = f.store.nextJob();
  f.store.save({ ...config, url: "https://changed.example", password: "" }, id);
  assert.equal((await publish(result(job))).status, 200);
  assert.equal(
    f.store.row(id).snapshot,
    null,
    "old result must not restore invalid snapshot",
  );
});
test("worker failure retains a retryable job, deletion keeps cleanup task", async (t) => {
  const f = await fixture(t);
  const id = f.store.save(config);
  await f.tick();
  const pending = f.store.db
    .prepare("SELECT * FROM jobs WHERE state='pending'")
    .get();
  assert.equal(pending.attempts, 1);
  assert.ok(pending.due > Date.now());
  f.store.remove(id);
  assert.equal(f.store.sites().length, 0);
  const job = f.store.db
    .prepare("SELECT * FROM jobs WHERE state='pending'")
    .get();
  assert.equal(JSON.parse(job.payload).operation, "delete");
});
test("restart preserves route and configuration, rotates password and invalidates session", async (t) => {
  const f = await fixture(t);
  f.store.save(config);
  let logs;
  const second = createApp({
    secret,
    dbPath: join(f.dir, "web.db"),
    dispatch: false,
    log: (s) => {
      logs = s;
    },
  });
  assert.equal(second.adminPath, f.adminPath);
  assert.equal(second.store.sites(true).length, 1);
  assert.notEqual(logs.split(": ").at(-1), f.password);
  await second.close();
});

test("cosmetic editing preserves in-flight jobs and identity editing retains credential cleanup", async (t) => {
  const f = await fixture(t);
  const id = f.store.save(config);
  const oldJob = f.store.nextJob();
  f.store.save({ ...config, name: "Renamed", password: "" }, id);
  assert.equal(
    f.store.db.prepare("SELECT state FROM jobs WHERE id=?").get(oldJob.id)
      .state,
    "running",
  );
  f.store.save({ ...config, account: "REPLACEMENT-ACCOUNT", password: "" }, id);
  f.store.retry(oldJob, "late connection failure");
  assert.equal(
    f.store.db.prepare("SELECT state FROM jobs WHERE id=?").get(oldJob.id)
      .state,
    "superseded",
  );
  const manual = {
    ...config,
    type: "others",
    account: "",
    password: "",
    manual_catalog: { groups: [] },
  };
  f.store.save(manual, id);
  f.store.save({ ...manual, description: "Another manual edit" }, id);
  const jobs = f.store.db
    .prepare("SELECT payload FROM jobs WHERE state IN ('pending','running')")
    .all();
  assert.equal(jobs.length, 1);
  assert.equal(JSON.parse(jobs[0].payload).operation, "delete");
  assert.equal(f.store.sites()[0].status, "manual");
});

const tokenConfig = {
  ...config,
  auth_mode: "token",
  account: "",
  password: "",
  access_token: "PRIVATE-PANEL-TOKEN",
  user_id: 42,
};
test("NewAPI token authentication persists, redacts secrets and retains a blank token", async (t) => {
  const f = await fixture(t);
  await f.login();
  const response = await f.request(f.base + "/sites", "POST", {
    ...tokenConfig,
    access_token: " Bearer " + tokenConfig.access_token + " ",
  });
  assert.equal(response.status, 201);
  const { id } = await response.json();
  const payload = JSON.parse(f.store.nextJob().payload);
  assert.equal(payload.access_token, tokenConfig.access_token);
  assert.equal(payload.user_id, 42);
  assert.equal(payload.account, "");
  assert.equal(payload.password, "");
  const adminText = await (await f.request(f.base + "/sites")).text();
  assert.ok(!adminText.includes(tokenConfig.access_token));
  const site = JSON.parse(adminText).sites[0];
  assert.equal(site.auth_mode, "token");
  assert.equal(site.has_access_token, true);
  assert.equal(site.has_password, false);
  assert.equal(site.user_id, 42);
  const publicText = await (await f.request("/api/sites")).text();
  for (const field of [
    "access_token",
    "user_id",
    "auth_mode",
    tokenConfig.access_token,
  ])
    assert.ok(!publicText.includes(field), `public response leaked ${field}`);
  assert.equal(
    (
      await f.request(`${f.base}/sites/${id}`, "PUT", {
        ...tokenConfig,
        name: "Renamed",
        access_token: "",
      })
    ).status,
    200,
  );
  const restarted = new Store(join(f.dir, "web.db"));
  assert.equal(
    JSON.parse(restarted.row(id).config).access_token,
    tokenConfig.access_token,
  );
  assert.equal(restarted.sites(true)[0].user_id, 42);
  restarted.close();
});

test("token validation, identity changes and switching authentication modes", async (t) => {
  const f = await fixture(t);
  await f.login();
  for (const invalid of [
    { access_token: "" },
    { access_token: "Bearer " },
    { access_token: "bad\nheader" },
    { access_token: "x".repeat(16385) },
    { user_id: 0 },
    { user_id: -1 },
    { user_id: 1.5 },
    { user_id: "42" },
    { user_id: Number.MAX_SAFE_INTEGER + 1 },
    { type: "sub2api" },
    { auth_mode: "unknown" },
  ]) {
    assert.equal(
      (
        await f.request(f.base + "/sites", "POST", {
          ...tokenConfig,
          ...invalid,
        })
      ).status,
      400,
    );
  }
  const id = f.store.save(tokenConfig);
  assert.throws(
    () => f.store.save(tokenConfig),
    (error) => error.status === 409 && error.code === "duplicate_identity",
  );
  const other = f.store.save({ ...tokenConfig, user_id: 43 });
  f.store.remove(other);
  const oldJob = f.store.nextJob();
  f.store.db
    .prepare("UPDATE sites SET snapshot=?,fetched_at=? WHERE id=?")
    .run('{"scope":"public","groups":[]}', new Date().toISOString(), id);
  f.store.save({ ...tokenConfig, access_token: "REPLACEMENT-TOKEN" }, id);
  assert.equal(f.store.row(id).snapshot, null);
  assert.equal(
    f.store.db.prepare("SELECT state FROM jobs WHERE id=?").get(oldJob.id)
      .state,
    "superseded",
  );
  f.store.save({ ...config, auth_mode: "password" }, id);
  let current = JSON.parse(f.store.row(id).config);
  assert.equal(current.access_token, "");
  assert.equal(current.user_id, 0);
  assert.equal(current.password, config.password);
  assert.throws(() => f.store.save({ ...tokenConfig, access_token: "" }, id), {
    status: 400,
  });
  f.store.save(tokenConfig, id);
  current = JSON.parse(f.store.row(id).config);
  assert.equal(current.account, "");
  assert.equal(current.password, "");
  f.store.save({ ...config, type: "others", account: "", password: "" }, id);
  assert.equal(JSON.parse(f.store.row(id).config).access_token, "");
  assert.equal(JSON.parse(f.store.nextJob().payload).operation, "delete");
});

test("duplicate identities and stale edits return distinct conflict codes without changing data", async (t) => {
  const f = await fixture(t);
  await f.login();
  const id = f.store.save(config);
  const duplicate = await f.request(f.base + "/sites", "POST", config);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, "duplicate_identity");
  f.store.save({ ...config, name: "Newer title" }, id);
  const outdated = await f.request(`${f.base}/sites/${id}`, "PUT", {
    ...config,
    revision: 1,
  });
  assert.equal(outdated.status, 409);
  assert.equal((await outdated.json()).code, "stale_revision");
  assert.equal(f.store.sites(true).length, 1);
  assert.equal(f.store.sites(true)[0].name, "Newer title");
});

test("legacy password configs remain editable without discarding their snapshot", async (t) => {
  const f = await fixture(t);
  const id = f.store.save(config);
  f.store.db
    .prepare("UPDATE sites SET config=?,snapshot=? WHERE id=?")
    .run(
      JSON.stringify({ ...config, enabled: true }),
      '{"scope":"public","groups":[]}',
      id,
    );
  assert.equal(f.store.sites(true)[0].auth_mode, "password");
  f.store.save({ ...config, password: "", description: "Updated" }, id);
  assert.notEqual(f.store.row(id).snapshot, null);
  assert.equal(JSON.parse(f.store.row(id).config).password, config.password);
});

test("non-object JSON bodies return 400 without mutating persisted state", async (t) => {
  const f = await fixture(t);
  for (const value of [null, [], true, "invalid"]) {
    const response = await f.request(f.base + "/login", "POST", value);
    assert.equal(response.status, 400, `login body: ${JSON.stringify(value)}`);
  }
  await f.login();
  const id = f.store.save(config),
    before = f.store.row(id);
  for (const [path, method] of [
    [f.base + "/sites", "POST"],
    [`${f.base}/sites/${id}`, "PUT"],
    [f.base + "/settings", "PUT"],
    [`${f.base}/changes/${id}/visibility`, "POST"],
  ]) {
    for (const value of [null, [], true, "invalid"]) {
      const response = await f.request(path, method, value);
      assert.equal(response.status, 400, `${method} ${path}`);
      assert.equal(typeof (await response.json()).error, "string");
    }
  }
  for (const value of [null, [], true, "invalid"]) {
    const timestamp = String(Math.floor(Date.now() / 1000)),
      raw = JSON.stringify(value),
      response = await f.request("/api/webhooks/sync", "POST", value, {
        "X-Cerium-Timestamp": timestamp,
        "X-Cerium-Signature": sign(secret, timestamp, raw),
        "X-Cerium-Event": "sync.completed",
      });
    assert.equal(response.status, 400, `callback body: ${raw}`);
  }
  assert.deepEqual(f.store.row(id), before);
  assert.equal(f.store.sites(true).length, 1);
  assert.equal((await f.request("/healthz")).status, 200);
});

test("invalid manual catalogs and visibility never publish a partially saved site", async (t) => {
  const f = await fixture(t);
  await f.login();
  const id = f.store.save(config),
    before = f.store.row(id);
  for (const change of [
    { enabled: "false" },
    { type: "others", manual_catalog: { groups: [null] } },
    {
      type: "others",
      manual_catalog: {
        groups: [{ id: "g", name: "Group", prices: [null] }],
      },
    },
  ]) {
    const response = await f.request(`${f.base}/sites/${id}`, "PUT", {
      ...config,
      ...change,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(f.store.row(id), before);
  }
});
