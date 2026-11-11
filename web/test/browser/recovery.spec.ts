import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { Directory } from "../../src/types";

function decodeArchive(bytes: Buffer) {
  const raw = gunzipSync(bytes);
  const prefix = Buffer.from("CERIUM-RECOVERY/2\n");
  expect(raw.subarray(0, prefix.length).equals(prefix)).toBe(true);
  const manifestEnd = raw.indexOf(10, prefix.length);
  expect(manifestEnd).toBeGreaterThan(prefix.length);
  const manifest = JSON.parse(
    raw.subarray(prefix.length, manifestEnd).toString("utf8"),
  );
  const webEnd = manifestEnd + 1 + manifest.components.web.size;
  return {
    manifest,
    web: raw.subarray(manifestEnd + 1, webEnd),
    worker: raw.subarray(webEnd),
  };
}

test("complete recovery preserves the real worker probe state and resumes synchronization", async ({
  request,
}) => {
  test.setTimeout(90000);
  const session = JSON.parse(
    readFileSync(resolve("test-results/session.json"), "utf8"),
  );
  const base = `${session.adminPath}/api`;
  const headers = {
    Origin: "http://127.0.0.1:4179",
    "X-Cerium-Admin": "1",
  };
  const login = await request.post(`${base}/login`, {
    headers,
    data: { password: session.password },
  });
  expect(login.status()).toBe(200);
  const directory = async (): Promise<Directory> =>
    (await request.get(`${base}/sites`)).json();
  const initial = await directory();
  const gateway = initial.sites.find((site) => site.type === "sub2api")!;
  expect(gateway).toBeTruthy();
  const exported = await request.post(`${base}/data/recovery/export`, {
    headers,
  });
  expect(exported.status()).toBe(200);
  const archiveBytes = await exported.body();
  const archive = decodeArchive(archiveBytes);
  expect(archive.manifest.format).toBe("cerium-recovery");
  const workerBefore = JSON.parse(archive.worker.toString("utf8"));
  expect(workerBefore.tables.model_probes.rows.length).toBeGreaterThan(0);
  const created = await request.post(`${base}/sites`, {
    headers,
    data: {
      name: "Recovery temporary site",
      url: "https://recovery-browser.example",
      type: "others",
      payment_methods: [],
      manual_catalog: { groups: [] },
    },
  });
  expect(created.status()).toBe(201);
  const temporaryID = (await created.json()).id;
  try {
    expect((await directory()).sites).toHaveLength(initial.sites.length + 1);
    const corrupt = structuredClone(archive.manifest);
    corrupt.components.web.sha256 = "0".repeat(64);
    const rejected = await request.post(`${base}/data/recovery/import`, {
      headers: { ...headers, "Content-Type": "application/gzip" },
      data: gzipSync(
        Buffer.concat([
          Buffer.from(`CERIUM-RECOVERY/2\n${JSON.stringify(corrupt)}\n`),
          archive.web,
          archive.worker,
        ]),
      ),
    });
    expect(rejected.status()).toBe(400);
    expect((await directory()).sites).toHaveLength(initial.sites.length + 1);
    const restored = await request.post(`${base}/data/recovery/import`, {
      headers: { ...headers, "Content-Type": "application/gzip" },
      data: archiveBytes,
    });
    expect(restored.status()).toBe(200);
    expect((await restored.json()).restored).toBe(true);
    expect((await request.get(`${base}/sites`)).status()).toBe(401);
    expect(
      (
        await request.post(`${base}/login`, {
          headers,
          data: { password: session.password },
        })
      ).status(),
    ).toBe(200);
    expect((await directory()).sites.map((site) => site.id).sort()).toEqual(
      initial.sites.map((site) => site.id).sort(),
    );
    const queued = await request.post(`${base}/sites/${gateway.id}/sync`, {
      headers,
      data: {},
    });
    expect(queued.status()).toBe(202);
    await expect
      .poll(
        async () => {
          const current = (await directory()).sites.find(
            (site) => site.id === gateway.id,
          );
          return (
            current?.status === "ok" &&
            current.fetched_at !== gateway.fetched_at
          );
        },
        { timeout: 30000 },
      )
      .toBe(true);
    const afterExport = await request.post(`${base}/data/recovery/export`, {
      headers,
    });
    expect(afterExport.status()).toBe(200);
    const after = decodeArchive(await afterExport.body());
    const workerAfter = JSON.parse(after.worker.toString("utf8"));
    expect(workerAfter.tables.model_probes).toEqual(
      workerBefore.tables.model_probes,
    );
    expect(workerAfter.tables.bridge_sites).toEqual(
      workerBefore.tables.bridge_sites,
    );
  } finally {
    const response = await request.get(`${base}/sites`);
    if (response.ok()) {
      const current: Directory = await response.json();
      if (current.sites.some((site) => site.id === temporaryID))
        await request.delete(`${base}/sites/${temporaryID}`, { headers });
    }
  }
});
