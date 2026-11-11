import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store.mjs";
import {
  BACKUP_LIMIT,
  exportRecoveryDatabase,
  parseBackup,
  parseBackupAsync,
  parseRecoveryDatabase,
  serializeBackup,
  validateBackup,
} from "../server/backup.mjs";
import { ICON_LIMIT } from "../server/icon-content.mjs";

const manual = {
  name: "Backup worker",
  url: "https://backup.example",
  type: "others",
  payment_methods: [],
  manual_catalog: { groups: [] },
};
const provider = {
  ...manual,
  type: "newapi",
  account: "backup-user",
  password: "private-backup-password",
};

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "cerium-backup-reliability-")),
    path = join(dir, "web.db"),
    store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, path, dir };
}

function saveIcon(store, id, image) {
  const row = store.row(id),
    siteURL = JSON.parse(row.config).url,
    selected = siteURL + "/icon.svg";
  store.saveFavicon(
    id,
    row.revision,
    { url: siteURL, icons: [selected], selected },
    null,
    { body: image, type: "image/svg+xml" },
  );
}

test("backup workers read committed WAL data without touching request-thread exportData", async (t) => {
  const { store } = fixture(t),
    id = store.save(provider),
    job = store.nextJob();
  store.exportData = () => {
    throw new Error("exportData must not execute on the request thread");
  };
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const bytes = await serializeBackup(store, "json"),
      data = await parseBackupAsync(bytes, "json");
    assert.equal(data.sites[0].id, id);
    assert.equal(data.sites[0].config.password, provider.password);
    assert.ok(ticks > 0);
    assert.equal(
      store.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id).state,
      "running",
    );
  } finally {
    clearInterval(timer);
  }
});

test("backup work is bounded and a failed import releases the worker slot", async (t) => {
  const { store } = fixture(t);
  store.save(manual);
  const exportPromise = serializeBackup(store, "json");
  await assert.rejects(serializeBackup(store, "json"), { status: 503 });
  await exportPromise;
  await assert.rejects(parseBackupAsync(Buffer.from("bad-json"), "json"), {
    status: 400,
  });
  assert.equal(
    (await parseBackupAsync(await serializeBackup(store, "json"), "json")).sites
      .length,
    1,
  );
});

test("requested cache omission keeps configured icon source and reports its policy in both formats", async (t) => {
  const { store } = fixture(t),
    id = store.save(manual),
    image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  saveIcon(store, id, image);
  for (const format of ["json", "sqlite"]) {
    const bytes = await serializeBackup(store, format, { cache: "omit" }),
      data = parseBackup(bytes, format);
    assert.equal(bytes.cacheOmitted, true);
    assert.deepEqual(data.cache_policy, {
      favicon_cache: "omitted",
      reason: "requested",
    });
    assert.equal(data.sites[0].favicon_cache, null);
    assert.equal(data.sites[0].favicon.selected, manual.url + "/icon.svg");
    assert.deepEqual(Buffer.from(store.row(id).favicon_blob), image);
  }
});

test("valid icon-heavy databases automatically produce restorable reduced-cache backups", async (t) => {
  const { store } = fixture(t),
    opening = '<svg xmlns="http://www.w3.org/2000/svg">',
    ending = "</svg>",
    image = Buffer.from(
      opening +
        " ".repeat(ICON_LIMIT - opening.length - ending.length) +
        ending,
    );
  for (let index = 0; index < 66; index++) {
    const id = store.save({
      ...manual,
      name: `Relay ${index}`,
      url: `https://relay-${index}.example`,
    });
    saveIcon(store, id, image);
  }
  for (const format of ["json", "sqlite"]) {
    const bytes = await serializeBackup(store, format),
      data = await parseBackupAsync(bytes, format);
    assert.ok(bytes.length < BACKUP_LIMIT);
    assert.equal(bytes.cacheOmitted, true);
    assert.deepEqual(data.cache_policy, {
      favicon_cache: "omitted",
      reason: "size_limit",
    });
    assert.equal(data.sites.length, 66);
    assert.ok(data.sites.every((entry) => entry.favicon_cache === null));
  }
  assert.equal(
    store.db
      .prepare("SELECT COUNT(*) AS n FROM sites WHERE favicon_blob IS NOT NULL")
      .get().n,
    66,
  );
});

test("recovery snapshots preserve durable jobs and reject mismatched payload credentials", async (t) => {
  const { store, dir } = fixture(t),
    id = store.save(provider),
    job = store.nextJob(),
    bytes = await exportRecoveryDatabase(store),
    state = await parseRecoveryDatabase(bytes);
  assert.equal(state.sites[0].id, id);
  assert.equal(state.jobs[0].id, job.id);
  assert.equal(state.jobs[0].state, "running");
  assert.equal(JSON.parse(state.jobs[0].payload).password, provider.password);
  assert.ok(state.settings.some((entry) => entry.key === "admin_path"));
  const path = join(dir, "tampered.db");
  writeFileSync(path, bytes, { mode: 0o600 });
  const db = new DatabaseSync(path);
  const payload = JSON.parse(job.payload);
  payload.password = "wrong-password";
  db.prepare("UPDATE jobs SET payload=? WHERE id=?").run(
    JSON.stringify(payload),
    job.id,
  );
  db.close();
  const { readFileSync } = await import("node:fs");
  await assert.rejects(parseRecoveryDatabase(readFileSync(path)), {
    status: 400,
  });
});

test("maximum safe imported revisions and model/price change records validate", (t) => {
  const { store } = fixture(t);
  store.save(manual);
  const data = store.exportData();
  data.sites[0].revision = Number.MAX_SAFE_INTEGER;
  data.changes = [
    {
      id: crypto.randomUUID(),
      site_id: data.sites[0].id,
      checked_at: new Date().toISOString(),
      previous_checked_at: null,
      dismissed: false,
      details: [
        {
          kind: "models",
          group_id: "g",
          name: "Group",
          before: 1,
          after: 1,
          before_dynamic: false,
          after_dynamic: false,
          models_added: ["gpt-new"],
          models_removed: ["gpt-old"],
        },
        {
          kind: "prices",
          group_id: "g",
          name: "Group",
          before: 1,
          after: 1,
          before_dynamic: false,
          after_dynamic: false,
          price_changes: [
            {
              model: "gpt-new",
              before: null,
              after: {
                model: "gpt-new",
                mode: "dynamic",
                expression: "p * 2",
              },
            },
          ],
        },
      ],
    },
  ];
  const validated = validateBackup(data);
  assert.equal(validated.sites[0].revision, Number.MAX_SAFE_INTEGER);
  assert.equal(
    validated.changes[0].details[1].price_changes[0].after.expression,
    "p * 2",
  );
  data.changes[0].details.push(data.changes[0].details[0]);
  assert.throws(() => validateBackup(data), { status: 400 });
});
