import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/index.mjs";

// Isolated functional fixture; no real provider, worker, or production database.
const dir = mkdtempSync(join(tmpdir(), "cerium-admin-browser-"));
let password;
const app = createApp({
  secret: "cerium-admin-browser-secret-32-characters",
  origin: "http://127.0.0.1:4185",
  dbPath: join(dir, "web.db"),
  dispatch: false,
  resolveIcon: async () => ({ icons: [] }),
  log: (value) => {
    password = value.split(": ").at(-1);
  },
});
const config = {
  name: "测试自动站",
  url: "https://fixture-relay.example",
  type: "newapi",
  account: "PRIVATE-FIXTURE-ACCOUNT",
  password: "PRIVATE-FIXTURE-PASSWORD",
  icon: "",
  payment_methods: [],
};
app.store.save(config);
app.store.save({
  ...config,
  name: "测试令牌站",
  url: "https://fixture-token.example",
  auth_mode: "token",
  access_token: "PRIVATE-FIXTURE-TOKEN",
  user_id: 42,
  account: "",
  password: "",
});
app.store.save({
  ...config,
  name: "测试手动站",
  url: "https://fixture-manual.example",
  type: "others",
  account: "",
  password: "",
  manual_catalog: { groups: [{ id: "g", name: "Manual", multiplier: 1 }] },
});
app.server.listen(4185, "127.0.0.1");
await once(app.server, "listening");
mkdirSync("test-results", { recursive: true });
writeFileSync(
  "test-results/admin-data-session.json",
  JSON.stringify({ adminPath: app.adminPath, password }),
  { mode: 0o600 },
);
async function close() {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGTERM", close);
process.once("SIGINT", close);
