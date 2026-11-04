import { createServer } from "node:http";
import {
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.mjs";
import { HttpError, syncInterval } from "./validation.mjs";
import { parseOrigin, validOrigin } from "./origin.mjs";
import { createPersistentIconResolver } from "./icons.mjs";
import {
  BACKUP_LIMIT,
  backupFormat,
  parseBackup,
  serializeBackup,
} from "./backup.mjs";

export const sign = (secret, timestamp, body) =>
  "sha256=" +
  createHmac("sha256", secret)
    .update(`${timestamp}\n`)
    .update(body)
    .digest("hex");
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function createApp(options = {}) {
  const secret = options.secret ?? process.env.CERIUM_WEBHOOK_SECRET;
  if (!secret || secret.length < 32)
    throw new Error(
      "Set CERIUM_WEBHOOK_SECRET to a shared random value of at least 32 characters",
    );
  const interval = Number(
    options.interval ?? process.env.SYNC_INTERVAL_SECONDS ?? 900,
  );
  syncInterval(interval);
  const store = new Store(
    options.dbPath ??
      join(process.env.DATA_DIR ?? join(root, "data"), "cerium-web.db"),
    interval,
  );
  const password = randomBytes(24).toString("base64url");
  const salt = randomBytes(32),
    passwordHash = scryptSync(password, salt, 32);
  const sessions = new Map(),
    failures = new Map();
  const secure = options.secure ?? process.env.COOKIE_SECURE === "true";
  const rawOrigin = options.origin ?? process.env.PUBLIC_ORIGIN;
  const origin = parseOrigin(rawOrigin);
  if (rawOrigin?.trim() && !origin)
    throw new Error(
      "PUBLIC_ORIGIN must be an http(s) origin without a path, query or credentials",
    );
  const backend =
    options.backendURL ??
    process.env.CERIUM_BACKEND_URL ??
    "http://127.0.0.1:8091";
  const backendURL = new URL(backend);
  if (
    !["http:", "https:"].includes(backendURL.protocol) ||
    backendURL.username ||
    backendURL.password ||
    backendURL.search ||
    backendURL.hash
  )
    throw new Error("Invalid backend URL");
  const base = `${store.adminPath}/api`;
  const resolveIcon = createPersistentIconResolver(store, options.resolveIcon);
  let busy = false,
    stopped = false,
    timer,
    active;
  const log = options.log ?? console.log;
  log(
    `Cerium admin path: ${store.adminPath}\nCerium admin password (rotates on restart): ${password}`,
  );
  const cookie = (token, age) =>
    `cerium_session=${token}; Path=${store.adminPath}; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? "; Secure" : ""}`;
  const send = (res, code, data) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  };
  async function body(req, limit = 1 << 20, types = ["application/json"]) {
    const type = req.headers["content-type"]
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    if (!types.includes(type))
      throw new HttpError(415, `Expected ${types.join(" or ")}`);
    if (Number(req.headers["content-length"]) > limit) {
      req.resume();
      throw new HttpError(413, "Request too large");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > limit) {
        req.resume();
        throw new HttpError(413, "Request too large");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  function json(buffer) {
    let value;
    try {
      value = JSON.parse(buffer);
    } catch {
      throw new HttpError(400, "Invalid JSON");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new HttpError(400, "Expected a JSON object");
    return value;
  }
  function csrf(req) {
    if (
      !validOrigin(req.headers.origin, req.headers.host, origin, secure) ||
      req.headers["x-cerium-admin"] !== "1"
    )
      throw new HttpError(403, "Invalid origin");
  }
  function session(req) {
    const token = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("cerium_session="))
      ?.slice(15);
    const key = token && hash(token),
      expires = key && sessions.get(key);
    if (!expires || expires < Date.now())
      throw new HttpError(401, "Login required");
    return key;
  }
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      store.schedule();
      const job = store.nextJob();
      if (!job) return;
      try {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const response = await fetch(`${backend.replace(/\/$/, "")}/v1/sync`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(165000),
          headers: {
            "Content-Type": "application/json",
            "X-Cerium-Timestamp": timestamp,
            "X-Cerium-Signature": sign(secret, timestamp, job.payload),
          },
          body: job.payload,
        });
        await response.body?.cancel();
        const state = store.db
          .prepare("SELECT state FROM jobs WHERE id=?")
          .get(job.id)?.state;
        if (state === "running")
          store.retry(
            job,
            response.ok
              ? "Worker has not delivered its signed result"
              : `Worker returned HTTP ${response.status}`,
          );
      } catch {
        store.retry(job, "Worker unreachable or timed out; retry scheduled");
      }
    } catch {
      log("Cerium dispatcher failed; queued jobs remain persisted");
    } finally {
      busy = false;
    }
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      const target = new URL(req.url, "http://localhost"),
        path = target.pathname;
      const method = req.method;
      if (path === "/healthz" && method === "GET")
        return send(res, 200, { ok: true });
      if (path === "/api/sites" && method === "GET")
        return send(res, 200, {
          sites: store.sites(),
          changes: store.changes(),
          interval: store.interval,
        });
      const iconMatch = path.match(/^\/api\/sites\/([\da-f-]{36})\/icon$/);
      if (iconMatch && method === "GET") {
        return send(res, 200, await resolveIcon(iconMatch[1]));
      }
      if (path === "/api/webhooks/sync" && method === "POST") {
        const raw = await body(req, 8 << 20),
          timestamp = req.headers["x-cerium-timestamp"];
        if (
          !/^\d+$/.test(timestamp ?? "") ||
          Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
          req.headers["x-cerium-event"] !== "sync.completed" ||
          !equal(
            req.headers["x-cerium-signature"],
            sign(secret, timestamp, raw),
          )
        )
          throw new HttpError(401, "Invalid signature");
        store.accept(json(raw));
        return send(res, 200, { accepted: true });
      }
      if (path.startsWith(`${base}/`)) {
        if (method !== "GET") csrf(req);
        if (path === `${base}/login` && method === "POST") {
          const now = Date.now(),
            ip = req.socket.remoteAddress;
          for (const [key, value] of failures)
            if (value.until <= now) failures.delete(key);
          const f = failures.get(ip) ?? { count: 0, until: now + 60000 };
          const total = [...failures.values()].reduce((n, v) => n + v.count, 0);
          if (f.count >= 5 || total >= 30) {
            res.setHeader("Retry-After", "60");
            throw new HttpError(429, "Too many attempts; wait one minute");
          }
          f.count++;
          failures.set(ip, f);
          const input = json(await body(req, 4096));
          if (
            typeof input.password !== "string" ||
            input.password.length > 256 ||
            !timingSafeEqual(scryptSync(input.password, salt, 32), passwordHash)
          )
            throw new HttpError(401, "Incorrect management password");
          failures.delete(ip);
          for (const [key, expiry] of sessions)
            if (expiry <= now) sessions.delete(key);
          if (sessions.size >= 100)
            sessions.delete(sessions.keys().next().value);
          const token = randomBytes(32).toString("base64url");
          sessions.set(hash(token), now + 8 * 3600000);
          res.setHeader("Set-Cookie", cookie(token, 8 * 3600));
          return send(res, 200, { ok: true });
        }
        const key = session(req);
        if (path === `${base}/logout` && method === "POST") {
          sessions.delete(key);
          res.setHeader("Set-Cookie", cookie("", 0));
          return send(res, 200, { ok: true });
        }
        if (path === `${base}/settings` && method === "GET")
          return send(res, 200, { sync_interval_seconds: store.interval });
        if (path === `${base}/settings` && method === "PUT")
          return send(res, 200, {
            sync_interval_seconds: store.setInterval(
              json(await body(req, 4096))?.sync_interval_seconds,
            ),
          });
        if (path === `${base}/data/export` && method === "POST") {
          const format = backupFormat(
              target.searchParams.get("format") ?? "json",
            ),
            bytes = await serializeBackup(store, format),
            stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
          res.writeHead(200, {
            "Content-Type":
              format === "json"
                ? "application/json; charset=utf-8"
                : "application/vnd.sqlite3",
            "Content-Disposition": `attachment; filename="cerium-web-${stamp}.${format === "json" ? "json" : "db"}"`,
            "Content-Length": bytes.length,
          });
          res.end(bytes);
          return;
        }
        if (path === `${base}/data/import` && method === "POST") {
          const format = backupFormat(
              target.searchParams.get("format") ?? "json",
            ),
            mode = target.searchParams.get("mode") ?? "merge";
          if (!["merge", "replace"].includes(mode))
            throw new HttpError(400, "Import mode must be merge or replace");
          const raw = await body(
              req,
              BACKUP_LIMIT,
              format === "json"
                ? ["application/json"]
                : ["application/vnd.sqlite3", "application/octet-stream"],
            ),
            data = parseBackup(raw, format, store.interval);
          return send(res, 200, store.importData(data, mode));
        }
        if (path === `${base}/sites` && method === "GET")
          return send(res, 200, {
            sites: store.sites(true),
            changes: store.changes(true),
            interval: store.interval,
          });
        const changeMatch = path
          .slice(base.length)
          .match(/^\/changes\/([\da-f-]{36})\/visibility$/);
        if (changeMatch && method === "POST") {
          store.changeVisibility(
            changeMatch[1],
            json(await body(req, 4096)).visible,
          );
          return send(res, 200, { ok: true });
        }
        if (path === `${base}/sites` && method === "POST")
          return send(res, 201, { id: store.save(json(await body(req))) });
        const match = path
          .slice(base.length)
          .match(/^\/sites\/([\da-f-]{36})(\/sync)?$/);
        if (match) {
          const id = match[1];
          if (match[2] && method === "POST") {
            store.queue(id, true);
            return send(res, 202, { queued: true });
          }
          if (!match[2] && method === "PUT")
            return send(res, 200, {
              id: store.save(json(await body(req)), id),
            });
          if (!match[2] && method === "DELETE") {
            store.remove(id);
            return send(res, 200, { deleted: true });
          }
        }
        throw new HttpError(404, "Not found");
      }
      if (method === "GET" && (path === "/" || path === store.adminPath)) {
        let html = readFileSync(join(root, "dist/index.html"), "utf8");
        html = html.replace(
          'data-mode="public"',
          `data-mode="${path === "/" ? "public" : "admin"}"`,
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (method === "GET" && /^\/assets\/[\w.-]+$/.test(path)) {
        const file = join(root, "dist", path);
        const types = {
          ".js": "text/javascript",
          ".css": "text/css",
          ".woff2": "font/woff2",
          ".woff": "font/woff",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ico": "image/x-icon",
        };
        const gzip =
          /\.(js|css)$/.test(path) &&
          (req.headers["accept-encoding"] ?? "")
            .split(",")
            .some((v) =>
              /^\s*gzip\s*(;\s*q=(1(\.0*)?|0\.\d*[1-9]\d*))?\s*$/.test(v),
            );
        let data;
        if (gzip) {
          try {
            data = readFileSync(`${file}.gz`);
            res.setHeader("Content-Encoding", "gzip");
          } catch {
            /* Development builds may not be compressed. */
          }
        }
        data ??= readFileSync(file);
        res.setHeader("Vary", "Accept-Encoding");
        res.writeHead(200, {
          "Content-Type": types[extname(file)] ?? "application/octet-stream",
          "Cache-Control": "public,max-age=31536000,immutable",
        });
        res.end(data);
        return;
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      if (!res.headersSent)
        send(res, error.status ?? (error.code === "ENOENT" ? 404 : 500), {
          error: error.status ? error.message : "Request failed",
        });
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  function dispatch() {
    if (!busy && !stopped) active = tick();
    return active;
  }
  if (options.dispatch !== false) {
    timer = setInterval(dispatch, 2000);
    timer.unref();
    dispatch();
  }
  return {
    server,
    store,
    tick: dispatch,
    adminPath: store.adminPath,
    async close() {
      stopped = true;
      clearInterval(timer);
      await active;
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.umask(0o077);
  const app = createApp();
  const port = Number(process.env.PORT ?? 3000);
  app.server.listen(port, process.env.HOST ?? "0.0.0.0", () =>
    console.log(`Cerium web listening on :${port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await app.close();
      process.exit(0);
    });
}
