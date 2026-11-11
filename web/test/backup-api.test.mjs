import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_LIMIT,
  RECOVERY_LIMIT,
  downloadBackup,
  downloadRecovery,
  uploadBackup,
  uploadRecovery,
} from "../src/backup-api.ts";

function fixture(t, handler) {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const downloads = [];
  globalThis.fetch = handler;
  globalThis.document = {
    createElement() {
      const link = {
        click() {
          downloads.push(link.download);
        },
        remove() {},
      };
      return link;
    },
    body: { append() {} },
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalDocument) globalThis.document = originalDocument;
    else delete globalThis.document;
  });
  return downloads;
}

test("reduced-cache export preserves the chosen format and reports omissions", async (t) => {
  const downloads = fixture(t, async (path, options) => {
    assert.equal(path, "/admin/api/data/export?format=sqlite&cache=omit");
    assert.equal(options.headers["Content-Type"], "application/vnd.sqlite3");
    assert.equal(options.headers["X-Cerium-Admin"], "1");
    return new Response("backup", {
      headers: {
        "Content-Disposition": 'attachment; filename="backup.db"',
        "X-Cerium-Backup-Cache": "omitted",
      },
    });
  });
  assert.deepEqual(await downloadBackup("/admin/api", "sqlite", false), {
    cacheOmitted: true,
  });
  assert.deepEqual(downloads, ["backup.db"]);
});

test("full recovery export and import use the coordinated gzip endpoints", async (t) => {
  let requests = 0;
  const file = new File(["gzip archive"], "backup.json.gz");
  const downloads = fixture(t, async (path, options) => {
    requests++;
    assert.equal(options.headers["Content-Type"], "application/gzip");
    assert.equal(options.method, "POST");
    if (requests === 1) {
      assert.equal(path, "/admin/api/data/recovery/export");
      assert.equal(options.body, undefined);
      return new Response("archive");
    }
    assert.equal(path, "/admin/api/data/recovery/import");
    assert.equal(options.body, file);
    return Response.json({
      restored: true,
      sites: 4,
      jobs: 2,
      admin_path: "/admin",
    });
  });
  await downloadRecovery("/admin/api");
  assert.deepEqual(downloads, ["cerium-recovery.cerium.gz"]);
  assert.deepEqual(await uploadRecovery("/admin/api", file), {
    restored: true,
    sites: 4,
    jobs: 2,
    admin_path: "/admin",
  });
});

test("empty and oversized imports are rejected before uploading", async (t) => {
  let requests = 0;
  fixture(t, async () => {
    requests++;
    return Response.json({});
  });
  await assert.rejects(
    uploadBackup("/admin/api", "json", "merge", { size: BACKUP_LIMIT + 1 }),
    /64 MiB/,
  );
  await assert.rejects(
    uploadBackup("/admin/api", "json", "merge", { size: 0 }),
    /为空/,
  );
  await assert.rejects(
    uploadRecovery("/admin/api", { size: RECOVERY_LIMIT + 1 }),
    /512 MiB/,
  );
  await assert.rejects(uploadRecovery("/admin/api", { size: 0 }), /为空/);
  assert.equal(requests, 0);
});
