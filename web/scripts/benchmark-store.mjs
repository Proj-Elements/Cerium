import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { site } from "../server/validation.mjs";

// Synthetic, isolated data only; timings measure Store.sites(), not HTTP or production load.
const dir = mkdtempSync(join(tmpdir(), "cerium-store-benchmark-")),
  store = new Store(join(dir, "web.db")),
  config = site({
    name: "Benchmark relay",
    url: "https://benchmark.invalid",
    type: "newapi",
    account: "benchmark",
    password: "synthetic-password",
    payment_methods: [],
  }),
  snapshot = JSON.stringify({
    scope: "public",
    groups: Array.from({ length: 5 }, (_, group) => ({
      id: String(group),
      name: `Group ${group}`,
      multiplier: 1,
      models_known: true,
      models: Array.from({ length: 20 }, (_, model) => `model-${model}`),
      prices: [],
    })),
  });

try {
  store.transaction(() => {
    const insert = store.db.prepare(
      "INSERT INTO sites(id,revision,config,snapshot,fetched_at,next_sync) VALUES(?,1,?,?,?,?)",
    );
    for (let i = 0; i < 200; i++)
      insert.run(
        `site-${i}`,
        JSON.stringify({ ...config, url: `https://relay-${i}.invalid` }),
        snapshot,
        new Date().toISOString(),
        Date.now() + 900000,
      );
  });
  for (const queued of [false, true]) {
    if (queued)
      store.transaction(() => {
        for (const row of store.db.prepare("SELECT * FROM sites").all())
          store.enqueue(row);
      });
    for (const admin of [false, true]) {
      for (let i = 0; i < 50; i++) store.sites(admin);
      const times = [];
      for (let i = 0; i < 300; i++) {
        const start = performance.now();
        store.sites(admin);
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          node: process.version,
          sites: 200,
          groups_per_site: 5,
          models_per_group: 20,
          queued,
          admin,
          samples: times.length,
          median_ms: Number(times[Math.floor(times.length / 2)].toFixed(3)),
          p95_ms: Number(times[Math.floor(times.length * 0.95)].toFixed(3)),
        }),
      );
    }
  }
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
