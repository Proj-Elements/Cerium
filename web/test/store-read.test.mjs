import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";

const config = {
  name: "Read test",
  url: "https://read.example",
  type: "newapi",
  account: "PRIVATE-ACCOUNT",
  password: "PRIVATE-PASSWORD",
  payment_methods: [],
};
const snapshot = JSON.stringify({ scope: "public", groups: [] });
function fixture(t, interval = 900) {
  const dir = mkdtempSync(join(tmpdir(), "cerium-store-read-")),
    store = new Store(join(dir, "web.db"), interval);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

test("directory reads keep SQLite query counts constant at the 200-site limit", (t) => {
  const store = fixture(t);
  assert.deepEqual(store.sites(), []);
  assert.deepEqual(store.sites(true), []);
  store.transaction(() => {
    const insert = store.db.prepare(
      "INSERT INTO sites(id,revision,config,snapshot,fetched_at,next_sync) VALUES(?,1,?,?,?,?)",
    );
    for (let i = 0; i < 200; i++)
      insert.run(
        `site-${i}`,
        JSON.stringify({ ...config, enabled: true }),
        snapshot,
        new Date().toISOString(),
        Date.now() + 900000,
      );
  });
  const prepare = store.db.prepare.bind(store.db),
    queries = [];
  t.mock.method(store.db, "prepare", (sql) => {
    queries.push(sql);
    return prepare(sql);
  });
  for (const admin of [false, true]) {
    queries.length = 0;
    const sites = store.sites(admin);
    assert.equal(sites.length, 200);
    assert.ok(sites.every((site) => site.status === "ok"));
    assert.ok(queries.length <= 2, `executed ${queries.length} queries`);
    if (!admin) {
      const json = JSON.stringify(sites);
      for (const secret of [config.account, config.password, "job", "revision"])
        assert.ok(!json.includes(secret), `public response leaked ${secret}`);
    }
  }
});

test("directory reads preserve ordering, visibility, job selection and status precedence", (t) => {
  const store = fixture(t),
    cases = [
      { expected: "pending" },
      { expected: "pending", running: true },
      { expected: "retrying", retry: true },
      { expected: "error", error: "Saved failure", retry: true },
      { expected: "waiting", done: true },
      { expected: "ok", done: true, age: 1000 },
      { expected: "stale", done: true, age: 3600000 },
      { expected: "waiting", enabled: false },
      { expected: "manual", type: "others", error: "Ignored for manual" },
    ],
    ids = cases.map((entry, i) => {
      const id = store.save({
        ...config,
        url: `https://read-${i}.example`,
        enabled: entry.enabled ?? true,
        type: entry.type ?? config.type,
      });
      if (entry.done)
        store.db
          .prepare("UPDATE jobs SET state='done',payload='{}' WHERE site_id=?")
          .run(id);
      if (entry.running || entry.retry)
        store.db
          .prepare("UPDATE jobs SET state=?,attempts=1,error=? WHERE site_id=?")
          .run(
            entry.running ? "running" : "pending",
            entry.retry ? "Worker unavailable" : null,
            id,
          );
      if (entry.age)
        store.db
          .prepare("UPDATE sites SET snapshot=?,fetched_at=? WHERE id=?")
          .run(snapshot, new Date(Date.now() - entry.age).toISOString(), id);
      if (entry.error)
        store.db
          .prepare("UPDATE sites SET error=? WHERE id=?")
          .run(entry.error, id);
      return id;
    });
  const publicSites = store.sites(),
    adminSites = store.sites(true);
  assert.deepEqual(
    adminSites.map((site) => site.id),
    ids,
  );
  assert.deepEqual(
    adminSites.map((site) => site.status),
    cases.map((entry) => entry.expected),
  );
  assert.deepEqual(
    publicSites.map((site) => site.id),
    ids.filter((_, i) => i !== 7),
  );
  assert.equal(adminSites[3].error, "Saved failure");
  assert.equal(adminSites[4].job, undefined);
  assert.deepEqual(
    { ...adminSites[2].job },
    {
      state: "pending",
      attempts: 1,
      error: "Worker unavailable",
    },
  );

  const row = store.row(ids[0]);
  store.enqueue(row);
  const active = store.db
    .prepare("SELECT id FROM jobs WHERE site_id=? ORDER BY rowid")
    .all(row.id);
  store.db
    .prepare("UPDATE jobs SET created_at=1,error=NULL WHERE site_id=?")
    .run(row.id);
  store.db
    .prepare("UPDATE jobs SET attempts=2,error='Newest active job' WHERE id=?")
    .run(active.at(-1).id);
  store.enqueue({ ...row, revision: row.revision + 1 });
  store.enqueue(row);
  store.db
    .prepare(
      "UPDATE jobs SET state='superseded' WHERE rowid=(SELECT MAX(rowid) FROM jobs)",
    )
    .run();
  assert.equal(store.sites(true)[0].job.error, "Newest active job");

  store.setInterval(3600);
  assert.equal(
    store.sites()[6].status,
    "ok",
    "interval edits apply on the next read",
  );
  store.setInterval(60);
  assert.equal(store.sites()[6].status, "stale");
  store.remove(ids[6]);
  assert.ok(!store.sites(true).some((site) => site.id === ids[6]));
});
