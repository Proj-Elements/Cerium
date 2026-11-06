import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/index.mjs";
import { Store } from "../server/store.mjs";
import { parseBackup, serializeBackup } from "../server/backup.mjs";
import { createPersistentIconResolver } from "../server/icons.mjs";
import { ICON_LIMIT } from "../server/icon-content.mjs";

const config = {
  name: "Cached icon",
  url: "https://cache.example",
  type: "others",
  manual_catalog: { groups: [] },
  payment_methods: [],
};
const iconURL = `${config.url}/logo.svg`;
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M0 0h16v16H0z"/></svg>',
);
const discovered = {
  icons: [iconURL],
  selected: iconURL,
  image: { body: svg, type: "image/svg+xml" },
};
const imagePath = (id) => `/api/sites/${id}/icon/image`;

test("serves cached image bytes from the same origin after restart and through both backup formats", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cerium-icon-cache-"));
  const dbPath = join(dir, "web.db"),
    secret = "cerium-icon-cache-test-secret-32-characters";
  let calls = 0;
  let app = createApp({
    secret,
    dbPath,
    dispatch: false,
    resolveIcon: async () => {
      calls++;
      return discovered;
    },
    log: () => {},
  });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  let origin = `http://127.0.0.1:${app.server.address().port}`;
  const id = app.store.save(config);
  const result = await (await fetch(`${origin}/api/sites/${id}/icon`)).json();
  assert.deepEqual(result, { icons: [imagePath(id)] });
  const image = await fetch(`${origin}${result.icons[0]}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/svg+xml");
  assert.match(image.headers.get("content-security-policy"), /sandbox/);
  assert.match(
    image.headers.get("content-security-policy"),
    /default-src 'none'/,
  );
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), svg);
  for (const format of ["json", "sqlite"]) {
    const destination = new Store(join(dir, `${format}.db`));
    try {
      const backup = await serializeBackup(app.store, format);
      destination.importData(parseBackup(backup, format));
      const resolve = createPersistentIconResolver(destination, () => {
        throw new Error("Restored icon should not need a network request");
      });
      assert.deepEqual(await resolve(id), { icons: [imagePath(id)] });
      assert.deepEqual(Buffer.from(destination.row(id).favicon_blob), svg);
    } finally {
      destination.close();
    }
  }
  await app.close();
  app = createApp({
    secret,
    dbPath,
    dispatch: false,
    resolveIcon: () => {
      throw new Error("Restart must not refetch a cached icon");
    },
    log: () => {},
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  origin = `http://127.0.0.1:${app.server.address().port}`;
  assert.deepEqual(
    await (await fetch(`${origin}/api/sites/${id}/icon`)).json(),
    {
      icons: [imagePath(id)],
    },
  );
  assert.deepEqual(
    Buffer.from(await (await fetch(`${origin}${imagePath(id)}`)).arrayBuffer()),
    svg,
  );
  assert.equal(calls, 1);
  app.store.save({ ...config, enabled: false }, id);
  assert.equal((await fetch(`${origin}${imagePath(id)}`)).status, 404);
  app.store.save(config, id);
  assert.equal((await fetch(`${origin}${imagePath(id)}`)).status, 200);
  app.store.save({ ...config, url: "https://changed-cache.example" }, id);
  assert.equal(app.store.row(id).favicon_blob, null);
  assert.equal(app.store.row(id).favicon_type, null);
  assert.equal((await fetch(`${origin}${imagePath(id)}`)).status, 404);
  await resolveIconForTest(app.store, id);
  app.store.remove(id);
  assert.equal((await fetch(`${origin}${imagePath(id)}`)).status, 404);
});

async function resolveIconForTest(store, id) {
  const url = JSON.parse(store.row(id).config).url;
  return createPersistentIconResolver(store, () => ({
    ...discovered,
    icons: [`${url}/logo.svg`],
    selected: `${url}/logo.svg`,
  }))(id);
}

test("migrates an existing saved URL to bytes without returning the remote URL", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cerium-icon-migrate-")),
    store = new Store(join(dir, "web.db")),
    id = store.save(config);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.saveFavicon(id, store.row(id).revision, {
    url: config.url,
    icons: [iconURL],
    selected: iconURL,
  });
  let input;
  const resolve = createPersistentIconResolver(store, async (site) => {
    input = site;
    return discovered;
  });
  assert.deepEqual(await resolve(id), { icons: [imagePath(id)] });
  assert.equal(input.preferred, iconURL);
  assert.deepEqual(Buffer.from(store.row(id).favicon_blob), svg);
});

test("failed legacy downloads return no remote URL and retry after the failure window", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cerium-icon-retry-")),
    store = new Store(join(dir, "web.db")),
    id = store.save(config),
    state = { url: config.url, icons: [iconURL], selected: iconURL };
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.saveFavicon(id, store.row(id).revision, state);
  let calls = 0;
  const resolve = createPersistentIconResolver(store, (site) => {
    calls++;
    assert.equal(site.preferred, iconURL);
    return calls === 1 ? { icons: [], selected: "" } : discovered;
  });
  assert.deepEqual(await resolve(id), { icons: [] });
  assert.deepEqual(await resolve(id), { icons: [] });
  assert.equal(calls, 1);
  assert.equal(JSON.parse(store.row(id).favicon).selected, iconURL);
  const failed = JSON.parse(store.row(id).favicon);
  failed.checked_at = new Date(Date.now() - 16 * 60000).toISOString();
  store.db
    .prepare("UPDATE sites SET favicon=? WHERE id=?")
    .run(JSON.stringify(failed), id);
  assert.deepEqual(await resolve(id), { icons: [imagePath(id)] });
  assert.equal(calls, 2);
});

test("invalid or oversized imported image bytes leave settings and existing icons unchanged", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cerium-icon-validation-")),
    store = new Store(join(dir, "web.db")),
    id = store.save(config);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await resolveIconForTest(store, id);
  const original = store.exportData();
  for (const invalid of [
    {
      type: "text/html",
      data: Buffer.from("<script>alert(1)</script>").toString("base64"),
    },
    {
      type: "image/png",
      data: Buffer.from("<html>Not an image</html>").toString("base64"),
    },
    { type: "image/png", data: svg.toString("base64") },
    { type: "image/svg+xml", data: "?" + svg.toString("base64") },
    {
      type: "image/svg+xml",
      data: Buffer.concat([svg, Buffer.alloc(ICON_LIMIT)]).toString("base64"),
    },
    { type: "image/svg+xml", data: "" },
  ]) {
    const data = structuredClone(original);
    data.settings.sync_interval_seconds = 60;
    data.sites[0].favicon_cache = invalid;
    assert.throws(() => store.importData(data), { status: 400 });
    assert.equal(store.interval, 900);
    assert.deepEqual(Buffer.from(store.row(id).favicon_blob), svg);
  }
  const missingSelection = structuredClone(original);
  missingSelection.sites[0].favicon = null;
  assert.throws(() => store.importData(missingSelection), { status: 400 });
});
