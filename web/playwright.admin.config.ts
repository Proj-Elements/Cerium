import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/admin-browser",
  outputDir: "test-results/admin-browser",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:4185",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node test/admin-data-fixture.mjs",
    url: "http://127.0.0.1:4185/healthz",
    timeout: 30000,
    reuseExistingServer: false,
  },
});
