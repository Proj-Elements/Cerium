import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../server/index.mjs";

// Synthetic upstreams, never real third-party credentials or prices.
const dir = mkdtempSync(join(tmpdir(), "cerium-integration-"));
const secret = "cerium-browser-test-shared-secret-only";
const counters = {
  login: 0,
  refresh: 0,
  public: 0,
  token: 0,
  keys: 0,
  models: 0,
  deleted: 0,
};
const probeKeys = new Map();
const upstream = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  const path = req.url.replace(/^\/(north|pine|cloud|token)/, "");
  const reply = (value) => res.end(JSON.stringify(value));
  if (path === "/api/v1/settings/public")
    return reply({ code: 0, data: { turnstile_enabled: false } });
  if (path === "/api/v1/keys" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (![1, 2].includes(body.group_id) || !req.headers["idempotency-key"]) {
      res.statusCode = 400;
      return reply({ code: 400 });
    }
    counters.keys++;
    probeKeys.set(body.custom_key, body.group_id);
    return reply({
      code: 0,
      data: {
        id: body.group_id,
        group_id: body.group_id,
        name: body.name,
        key: body.custom_key,
      },
    });
  }
  if (/^\/api\/v1\/keys\/\d+$/.test(path) && req.method === "DELETE") {
    counters.deleted++;
    return reply({ code: 0, data: {} });
  }
  if (path === "/v1/models") {
    const group = probeKeys.get(
      req.headers.authorization?.replace(/^Bearer /, ""),
    );
    if (!group || req.headers.cookie) {
      res.statusCode = 401;
      return reply({ error: "wrong credential" });
    }
    counters.models++;
    return reply({
      object: "list",
      data: (group === 1
        ? ["claude-sonnet-4-5", "claude-opus-4-5"]
        : ["gpt-5.2-codex"]
      ).map((id) => ({ id })),
    });
  }
  if (/^\/(cloud|token)\/api\/user\/(login|auth)/.test(req.url)) {
    res.statusCode = 500;
    return reply({ success: false });
  }
  if (path === "/api/user/self/groups") {
    if (
      req.headers.authorization !== "Bearer fixture-panel-token" ||
      req.headers["new-api-user"] !== "42"
    ) {
      res.statusCode = 401;
      return reply({ success: false });
    }
    counters.token++;
    return reply({
      success: true,
      data: { "PRIVATE-GROUP-NEVER-PUBLISH": { ratio: 0.1 } },
    });
  }
  if (path.endsWith("/encryption-key")) {
    res.statusCode = 404;
    return res.end("{}");
  }
  if (path === "/api/user/login") {
    counters.login++;
    res.setHeader(
      "Set-Cookie",
      "new_api_refresh=fixture-refresh; Path=/; HttpOnly",
    );
    return reply({
      success: true,
      data: {
        access_token: "fixture-access",
        user: { id: 1 },
        session: { sid: "fixture" },
      },
    });
  }
  if (path === "/api/user/auth/refresh") {
    counters.refresh++;
    return reply({
      success: true,
      data: { access_token: "fixture-rotated", user: { id: 1 } },
    });
  }
  if (path === "/api/v1/auth/login" || path === "/api/v1/auth/refresh") {
    if (path.endsWith("login")) counters.login++;
    else counters.refresh++;
    return reply({
      code: 0,
      data: {
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
      },
    });
  }
  if (path === "/api/v1/groups/available")
    return reply({
      code: 0,
      data: [
        {
          id: 1,
          name: "Claude 稳定线路",
          platform: "anthropic",
          is_exclusive: false,
          subscription_type: "standard",
          rate_multiplier: 0.8,
        },
        {
          id: 2,
          name: "Codex 专线",
          platform: "openai",
          is_exclusive: false,
          subscription_type: "standard",
          rate_multiplier: 1.2,
        },
        {
          id: 9,
          name: "PRIVATE-GROUP-NEVER-PUBLISH",
          is_exclusive: true,
          subscription_type: "standard",
          rate_multiplier: 0.1,
        },
      ],
    });
  if (path === "/api/pricing") {
    if (req.headers.authorization || req.headers.cookie) {
      res.statusCode = 500;
      return res.end("{}");
    }
    counters.public++;
    return reply({
      success: true,
      usable_group: {
        default: "日常开发与轻量任务",
        premium: "高品质官方线路",
        economy: "高性价比线路",
        auto: "根据可用线路动态分配",
      },
      group_ratio: { default: 1, premium: 1.5, economy: 0.6 },
      auto_groups: ["default", "premium"],
      data: [
        {
          model_name: "gpt-5.2",
          enable_groups: ["all"],
          quota_type: 0,
          model_ratio: 0.875,
          completion_ratio: 8,
          cache_ratio: 0.1,
        },
        {
          model_name: "claude-sonnet-4-5",
          enable_groups: ["default", "premium"],
          quota_type: 0,
          model_ratio: 1.5,
          completion_ratio: 5,
        },
        {
          model_name: "gemini-3-pro",
          enable_groups: ["all"],
          quota_type: 0,
          model_ratio: 1,
          completion_ratio: 6,
        },
        {
          model_name: "image-preview",
          enable_groups: ["default", "premium"],
          quota_type: 1,
          model_price: 0.04,
        },
        {
          model_name: "video-dynamic",
          enable_groups: ["premium"],
          quota_type: 0,
          billing_mode: "tiered_expr",
          billing_expr: "duration * resolution_factor",
        },
        {
          model_name: "claude-opus-5-5-thinking",
          enable_groups: ["premium"],
          billing_mode: "tiered_expr",
          billing_expr: "input_tokens * 4 + output_tokens * 20",
        },
        ...["z-ai/glm-5.3", "glm-5.3-flash", "qwen3.8-27b"].map(
          (model_name) => ({
            model_name,
            enable_groups: ["premium"],
          }),
        ),
      ],
    });
  }
  res.statusCode = 404;
  res.end("{}");
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
const reserve = createServer();
reserve.listen(0, "127.0.0.1");
await once(reserve, "listening");
const workerPort = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const port = Number(process.env.FIXTURE_PORT ?? 4179);
let logs;
const app = createApp({
  secret,
  origin: `http://localhost:${port}`,
  dbPath: join(dir, "web.db"),
  backendURL: `http://127.0.0.1:${workerPort}`,
  dispatch: false,
  resolveIcon: async () => ({ icons: [] }),
  log: (s) => {
    logs = s;
  },
});
app.server.listen(port, "127.0.0.1");
await once(app.server, "listening");
const binary = join(dir, "cerium");
execFileSync("go", ["build", "-o", binary, "./cmd/cerium"], {
  cwd: resolve(".."),
  stdio: "pipe",
});
const worker = spawn(
  binary,
  [
    "serve",
    "-db",
    join(dir, "worker.db"),
    "-listen",
    `127.0.0.1:${workerPort}`,
  ],
  {
    env: {
      ...process.env,
      CERIUM_WEBHOOK_SECRET: secret,
      CERIUM_WEBHOOK_URL: `http://127.0.0.1:${port}/api/webhooks/sync`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  },
);
await new Promise((resolve, reject) => {
  worker.stderr.once("data", resolve);
  worker.once("error", reject);
  worker.once("exit", (code) => {
    if (code) reject(new Error("fixture worker failed"));
  });
});
const common = {
  icon: "",
  enabled: true,
  account: "fixture-user",
  password: "fixture-password",
  recharge_multiplier: 2,
  recharge_cny: 10,
  recharge_usd: 20,
  payment_methods: ["LDXP", "易支付"],
  payment_note: "",
};
app.store.save({
  ...common,
  name: "北辰 API",
  url: upstreamURL + "/north",
  type: "newapi",
  description: "连接主流大模型，为日常开发提供简洁、稳定的 API 入口。",
});
app.store.save({
  ...common,
  name: "松间模型",
  url: upstreamURL + "/pine",
  type: "sub2api",
  recharge_cny: 7,
  recharge_usd: 10,
  recharge_multiplier: 1.4,
  payment_methods: ["闲鱼", "易支付"],
  description: "专注 Claude 与 Codex，让长上下文与代码任务更从容。",
});
app.store.save({
  ...common,
  name: "云桥 AI",
  url: upstreamURL + "/cloud",
  type: "newapi",
  auth_mode: "token",
  account: "",
  password: "",
  access_token: "fixture-panel-token",
  user_id: 42,
  recharge_cny: 10,
  recharge_usd: 10,
  recharge_multiplier: 1,
  payment_methods: ["LDXP"],
  description: "从文本到图像，一站比较多种模型和计费方式。",
  payment_note: "示例信息，非真实站点报价",
});
app.store.save({
  ...common,
  name: "小岛实验室",
  url: "https://island.example",
  type: "others",
  account: "",
  password: "",
  recharge_cny: null,
  recharge_usd: null,
  recharge_multiplier: null,
  payment_methods: ["闲鱼"],
  description: "小而专注的独立服务，站点信息由管理员手动维护。",
  manual_catalog: {
    groups: [
      {
        id: "lab",
        name: "实验分组",
        multiplier: 1,
        models: ["example-model"],
        models_known: true,
      },
    ],
  },
});
for (let i = 0; i < 3; i++) await app.tick();
if (app.store.sites().some((s) => s.status !== "ok" && s.status !== "manual"))
  throw new Error("real Go to Node integration failed");
if (
  counters.login !== 2 ||
  counters.refresh !== 2 ||
  counters.public !== 2 ||
  counters.token !== 1 ||
  counters.keys !== 2 ||
  counters.models !== 2 ||
  counters.deleted !== 2
)
  throw new Error(
    `incorrect upstream request counts: ${JSON.stringify(counters)}`,
  );
mkdirSync("test-results", { recursive: true });
writeFileSync(
  "test-results/session.json",
  JSON.stringify({
    adminPath: app.adminPath,
    password: logs.split(": ").at(-1),
    counters,
    upstreamURL,
  }),
  { mode: 0o600 },
);
const timer = setInterval(() => {
  void app.tick();
}, 250);
console.log(
  `Fixture ready at http://127.0.0.1:${port}; real Go bridge verified`,
);
async function close() {
  clearInterval(timer);
  await app.close();
  worker.kill("SIGTERM");
  await once(worker, "exit");
  upstream.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGTERM", close);
process.once("SIGINT", close);
