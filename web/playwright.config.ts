import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  // Keep fixture login metadata outside Playwright's auto-cleaned output.
  outputDir: "test-results/browser",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:4179",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node test/fixture-server.mjs",
    url: "http://127.0.0.1:4179/healthz",
    timeout: 120000,
    reuseExistingServer: !process.env.CI,
  },
});
