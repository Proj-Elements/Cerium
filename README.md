# Cerium

轻量的 AI 中转站聚合目录：公开前台 + 随机入口的密码管理后台 + 独立 Go 同步器。
前台采用 React / HeroUI Pro，Node 服务使用内置 HTTP 与 SQLite，**运行时没有第三方 Node 依赖**。
网站与同步器分别持久化，两个镜像、两个容器，不在 Node 容器内执行 Go。

## 网站部署（Docker）

```sh
cp .env.example .env
# 将 .env 中 CERIUM_WEBHOOK_SECRET 替换为 openssl rand -hex 32 的结果。
# 使用自己的 HeroUI Pro 初始化凭据；通过 BuildKit secret 传入，不写入镜像。
read -s HEROUI_SETUP_TOKEN; export HEROUI_SETUP_TOKEN
docker compose up -d --build
docker compose logs web
```

访问 `http://localhost:3000`。首次启动为空目录，不插入演示站点。
日志中的 `Cerium admin path` 为管理入口，`Cerium admin password` 为本次启动的密码。
**入口持久化；密码每次启动重新生成，旧登录会话失效。** 前台不包含管理入口链接。
无需先编辑 Go 凭据文件：在后台添加站点即可排队同步，账号密码或访问令牌留在本地 SQLite。
NewAPI 可选择「账号密码」或「访问令牌 + 用户 ID」，后者适用于第三方登录账号。
填写的是面板访问令牌，不是模型调用 API Key；令牌失效后需手动更换，编辑时留空保留原令牌。

- 支持图标、名称、链接、简介、充值倍率、CNY/USD 额度兑换与支付方式。
- 展示公开分组与倍率；NewAPI 可展开查看模型输入、输出、缓存与按次价格。
- Sub2API 每个分组仅探测一次网关模型：创建短期 Key、请求 `/v1/models`、缓存结果并删除 Key；后续同步不重复创建。
- `others` 可手动填写分组 JSON，不会假装自动抓取；隐藏站点不自动同步。
- 默认每 15 分钟同步一次，后台可调整周期并持久化，前台每 15 秒读取快照；后台可手动触发。
- 后台「同步与数据」支持 JSON / SQLite (.db) 导入导出，可合并或替换目录；备份包含明文凭据，须妥善保管。见 [后台数据迁移](docs/admin-data.md)。
- Go 连接/回调失败时，SQLite 任务队列退避重试；站点抓取失败保留上次成功数据并标注异常。
- 桌面、手机与浅/深色主题；模型列表渐进展开和分页。

Compose 通过 `network_mode: service:web` **只共享网络命名空间**，因此两个独立容器
可以通过 `127.0.0.1` 双向调用。Go 端口不对宿主机公开，网页只绑定宿主机回环地址。
改变部署拓扑时必须修改双向地址；普通独立容器的 `localhost` 并不互通。

部署变量、HTTPS、备份、开发和协议见 [网站部署与协议](docs/web.md)。

需要 Sub2API Turnstile 登录时，额外启动独立浏览器容器：

```sh
docker compose --profile solver up -d --build
```

启用本地 solver 后，在 `.env` 设置 `COMPOSE_PROFILES=solver`，让后续普通部署也协调第三个容器。
否则重建 web 时，已运行的 solver 可能仍共享旧容器的网络，显示 healthy 但同步器无法连接。

Solver 不接收账号密码、不开放外部端口。引用的 Theyka 实现采用 **CC BY-NC 4.0**，
商用需取得授权；只用于获准访问的账号/站点，不保证通过上游验证。见 [Solver 说明](solver/README.md)。

## Go CLI（仍可独立使用）

A small, one-shot Go CLI for collecting the groups, multipliers, and published
model metadata visible to ordinary Sub2API and NewAPI accounts. Credentials,
access/refresh tokens, cookies, and the last good catalog live in local SQLite.
The one-shot Go runtime needs no daemon, ORM, Redis, browser automation, or CGO. An
optional separate Turnstile browser service is used only when login requires it. The
only direct dependency is the pure-Go `modernc.org/sqlite` driver. An optional
`serve` command connects it to the separate Node website using signed webhooks.

## Quick start

Requires Go 1.26 or later.

```sh
go build -trimpath -ldflags='-s -w' -o cerium ./cmd/cerium
cp credentials.example.json credentials.json
# Edit the site URLs and accounts; set the referenced password environment variables.
./cerium import -config credentials.json
./cerium run
./cerium show
```

Without building, use `go run ./cmd/cerium` in place of `./cerium`.

`import` only writes SQLite; it never contacts a site. Environment variables are
resolved during import, so subsequent runs do not require the configuration
file or password environment variables. The default database is
`data/cerium.db`; all commands accept `-db PATH` after the command name.

## Configuration

`credentials.example.json` shows the configuration shape. Each credential has:

| Field | Meaning |
| --- | --- |
| `url` | Site root, optionally with a reverse-proxy path prefix; not an API endpoint |
| `type` | `sub2api` or `newapi` (`new-api` is an alias) |
| `account` | Sub2API login email, or NewAPI username |
| `password` | Literal password; use this OR `password_env` |
| `password_env` | Name of an environment variable containing the password |
| `access_token` | NewAPI panel access token, instead of account/password; an optional `Bearer ` prefix is accepted |
| `access_token_env` | Name of an environment variable containing the token; use this OR `access_token` |
| `user_id` | Positive NewAPI user ID, required with an access token |
| `name` | Optional display label; also included in webhook results |

Credentials use either account/password or NewAPI access_token/user_id, not both.
They are identified by normalized `(url, type, account, user_id)` (user_id is zero
for password authentication). Imports are
atomic and do not remove credentials omitted from the file. An identical import
preserves sessions; a password or configured-token change invalidates that credential's session and
cached snapshot. Changing a URL, type, account, or user ID adds a different credential;
remove the old entry explicitly if it is no longer needed. Password whitespace
is preserved. Unknown configuration fields and duplicate identities are rejected.

```sh
./cerium import -config credentials.json -db data/sites.db
./cerium import -config - -db data/sites.db < credentials.json
./cerium list -db data/sites.db
./cerium remove -id 2 -db data/sites.db
```

## One run, one synchronization round

```sh
./cerium run -db data/sites.db -request-timeout 20s -site-timeout 2m
```

For each stored credential, in order:

1. Load its saved session, or log in once if there is none.
2. Attempt one refresh when the session supports it, including immediately after
   a first login. Save replacement tokens before making any catalog request.
3. Fetch the authenticated user's groups and optional model metadata.
4. Save the latest attempt and replace the catalog only on success. An error does
   not erase the last good catalog or a successfully rotated refresh token.
5. Optionally publish a public result to the configured sinks/webhook.

"Once" means one synchronization round, not one HTTP request: login, refresh,
group retrieval, and optional metadata retrieval are separate API operations.
There is no periodic loop. Schedule invocations externally if required.

There is at most one password login per credential per run and no retry of a
rotating refresh request. A definitively rejected saved session can trigger one
login and a protected group fetch retry. Transient refresh failures are reported
as warnings; the existing access token is still tried. Legacy NewAPI cookie-only
sessions have no refresh endpoint and report `refresh: "unsupported"`.

A per-credential SQLite lease prevents overlapping processes from using the
same refresh token. It expires after the site timeout plus 30 seconds following
a crash. A rejected overlapping attempt makes no network request and does not
overwrite the active run's saved state. Changed/deleted credentials cannot accept
an in-flight worker's stale session.

The CLI prints JSON. Site failures do not stop the remaining credentials; any
fatal site, persistence, or webhook delivery failure produces a nonzero exit.
Optional metadata or refresh warnings alone do not fail an otherwise successful
catalog fetch. `show` separates `last_run`, `fetched_at`, and the last good
`snapshot`, so stale data is not presented as a newly successful fetch.

## Provider behavior

### Sub2API

- Login: `POST /api/v1/auth/login` with `email` and `password`.
- First reads `/api/v1/settings/public`. When Turnstile is enabled, requests a
  one-use proof from `CERIUM_TURNSTILE_SOLVER_URL` and includes `turnstile_token`.
  No solver request is made for sites without Turnstile. Other CAPTCHA providers
  and MFA are not treated as solved by Turnstile.
- Refresh: `POST /api/v1/auth/refresh` with the saved `refresh_token`.
- Groups: `GET /api/v1/groups/available` using the panel access token.
- Personal multipliers: `GET /api/v1/groups/rates`; explicit zero is preserved
  and a user-specific multiplier overrides the group's default.
- Model metadata: one-time `/v1/models` request using a temporary key created
  specifically for the group. SQLite tracks creation, reconciliation, model
  retrieval, and deletion across restarts. Keys request a one-day expiry and a
  tiny positive spending cap; Cerium never calls a billable inference endpoint.
- At most four new groups are probed per synchronization (`CERIUM_MODEL_PROBES_PER_RUN`,
  range 1-20). Later rounds continue remaining groups. Successful or failed
  attempts are retained; neither automatic retries nor restarts recreate keys
  or repeat completed/interrupted model requests. Deletion retries are allowed.

The ordinary group DTO deliberately does not expose the administrative model
allowlist. Cerium does not guess models from platform names, use admin APIs,
or send panel access tokens to `/v1/models`. Public mode never probes private or
subscription-only groups. The UI labels this model list as a dated, one-time
gateway snapshot, not continuously refreshed model availability.
Unavailable personal-rate metadata is explicitly marked `group_fallback` with
a warning; it is not claimed to be the user's confirmed effective multiplier.

### NewAPI

- Accepts a manually configured panel access token plus user ID, including for
  third-party-login accounts. Sends `Authorization: Bearer <token>` and
  `New-Api-User: <id>`, without password login, encryption discovery, or refresh.
  These tokens have no refresh credential; expired/revoked tokens must be replaced.
  Newer scoped personal access tokens need permission to read `/api/user/self/groups`.
- Supports current access-token + `new_api_refresh` Cookie authentication, and
  the `v0.10.8` cookie-only session shape with `New-Api-User`.
- Discovers `/api/user/login/encryption-key`; uses RSA-OAEP/SHA-256 when enabled
  and the current hybrid v2 format for long passwords. Only 404/405 permits the
  legacy plaintext-login fallback; other discovery failures fail closed.
- Logs in through `POST /api/user/login`. Current sessions refresh once through
  `/api/user/auth/refresh`, with the correct Cookie path, `Origin`, and session ID.
- Always reads protected `/api/user/self/groups` first. This is important:
  legacy `/api/pricing` can silently return guest prices for an expired Cookie.
- Uses `/api/pricing` model entries' `enable_groups`, including `all`, to associate
  models. Automatic groups aggregate their published `auto_groups`; `auto` is
  never assigned an invented numeric multiplier. Disabled pricing is a warning,
  not loss of the successfully fetched groups.

These are panel login sessions, not upstream provider OAuth accounts managed by
an administrator. MFA, passkeys, non-Turnstile CAPTCHAs, and WAF/browser challenges
are not handled by the optional embedded-Turnstile integration. MFA responses
are reported explicitly; sites requiring an
interactive login cannot be initialized by the unattended password flow. For
NewAPI, an authorized panel token obtained from the site can be supplied instead.

Safe read requests retry once after EOF, truncated response, or connection reset.
Login, refresh, key creation, solver submission and one-time gateway model
discovery are never automatically replayed. HTTP authentication failures are
not classified as transient transport errors.

## Understanding a group

```json
{
  "id": "12",
  "name": "standard",
  "platform": "openai",
  "multiplier": 0.8,
  "default_multiplier": 1.0,
  "multiplier_source": "user",
  "models": ["example-model"],
  "models_known": true
}
```

`default_multiplier` is exposed for Sub2API; NewAPI's protected endpoint returns
effective user ratios, not a separate global default, so its default is `null`.
`multiplier: null` means unknown or dynamic (for example NewAPI `auto`), not 1x.
The multiplier is the basic group/user ratio, not a calculation of time-dependent
peak rates, special image/video rates, per-model prices, or final billable cost.

`models_known: false` means the upstream did not publish a complete usable
mapping. `models: null` means unknown, while `[]` with `models_known: true` means
an explicitly empty published list. A partially usable pricing response can
include observed models with `models_known: false`. All models are advertised
metadata, not a live inference probe or a guarantee of routing availability.

## SQLite and security

- `credentials`: site identity and reusable password; monotonically increasing IDs.
- `sessions`: access token, refresh token, expiry, user/session IDs, persisted cookies.
- `snapshots`: JSON catalog, its successful fetch timestamp, and latest run result.
- `leases`: short-lived per-credential synchronization ownership.

New database files use mode `0600` and newly created parent directories use
`0700`. Passwords/tokens are **not encrypted at rest**; protect the database and
its backups like a password file. Removing records is not secure erasure of
SQLite pages or backups. No passwords or tokens are printed in normal CLI
output or included as credential/session fields in webhook payloads. Upstream
error messages and response bodies are not copied into errors or snapshots.
`list`/`show` include account names; keep that output private when necessary.

TLS certificates are verified. Redirects are rejected rather than replaying
credentials at a different URL. Plain HTTP is supported for trusted local/dev
endpoints; it sends credentials in cleartext and should not be used for public
sites. Configuration is limited to 1 MiB; API responses to 8 MiB each.

## Optional webhook

```sh
./cerium run -webhook https://receiver.example.com/cerium
```

Alternatively set `CERIUM_WEBHOOK_URL`. Set `CERIUM_WEBHOOK_SECRET` to enable
HMAC-SHA256 signing. Each processed credential emits its public `Result` JSON
once, after the local synchronization attempt, with these headers:

- `X-Cerium-Event: sync.completed`
- `X-Cerium-Timestamp: <Unix seconds>`
- `X-Cerium-Signature: sha256=<hex digest>` when a secret is configured

Sign the exact bytes `timestamp + "\n" + HTTP_request_body`. Receivers should
check the signature in constant time and reject stale timestamps. Webhooks never
receive a `Credential` or `Session`; the public result contains the site URL and
display label, groups, refresh outcome, warnings, and any sanitized error.
Only 2xx is accepted. Delivery failure does not roll back local state. There is
no retry, durable outbox, or delivery guarantee in this initial version.

## Extension points

Implement `Provider` (`Login`, `Refresh`, `Fetch`) and add its factory to the
`Registry`. `DefaultProviders()` returns a fresh map. Implement `Sink.Publish`
to add another webhook format, event bus, or durable delivery mechanism.
Providers update the supplied `Session`; the runner owns persistence and error
isolation. Neither interface requires changes to the SQLite schema.

```go
providers := cerium.DefaultProviders()
providers["another"] = NewAnotherProvider
syncer := cerium.Syncer{
    Store: store,
    Providers: providers,
    Sinks: []cerium.Sink{customSink},
}
results, err := syncer.Run(ctx)
```

## Development

```sh
go test ./...
go test -race ./...
go vet ./...
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o cerium ./cmd/cerium
```

Tests use real temporary SQLite files and local `httptest` servers: token
rotation before a failed fetch, cancellation, protected vs guest pricing, old
and new NewAPI authentication, encrypted passwords, personal zero multipliers,
unknown models, overlapping runs, snapshot retention, webhook signing, and CLI
flows. They do not log in to real third-party accounts.

See [upstream-api.md](docs/upstream-api.md) for the cloned source revisions and
the exact owning files used to derive the API contracts. Local reference clones
are in `.reference/` and are deliberately ignored by Git.
