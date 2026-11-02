# Upstream API source notes

## Public-directory extension

The separate web service uses the bridge's `PublicProviders()` rather than
publishing account-visible CLI results directly. Additional source reads:

- Sub2API `backend/internal/handler/dto/types.go` (`is_exclusive`,
  `subscription_type`) and `backend/internal/service/api_key_service.go`
  (`GetAvailableGroups`, `canUserBindGroupInternal`): authenticated availability
  includes private authorizations and subscriptions. Only explicitly public
  standard groups and their default multipliers enter the public directory.
- NewAPI `controller/pricing.go` and `service/group.go`: anonymous
  `usable_group` differs from authenticated groups and personalized ratios.
  The bridge uses a fresh empty session for public pricing, without auth headers
  or cookies, and never falls back to account-private data.
- NewAPI `model/pricing.go`, `web/src/features/pricing/lib/price.ts`, and
  `setting/billing_setting/tiered_billing.go`: token prices are model ratio times
  two times group ratio per million tokens; completion/cache ratios multiply
  the input price, request prices multiply model_price by group ratio.
  Expression/plugin billing and automatic groups are not fixed-price estimates.

No upstream server implementation is copied into Cerium. These are API wire
contracts and independently implemented transformations. See `docs/web.md` for
field limitations, safe publication rules, and the signed bridge contract.

## Initial CLI investigation

The initial implementation was derived by cloning and reading these sources,
not by assuming that panel access tokens are gateway API keys. No upstream
server code is imported or required at runtime.

| Repository | Inspected revision |
| --- | --- |
| [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) | `d851a38477597157e78450d30af2d8504764d085` (cloned 2026-11-01) |
| [QuantumNous/new-api](https://github.com/QuantumNous/new-api) | `70e6af6429824f99de98e96e65254c8c2ef7ee0b` (cloned 2026-11-01) |
| NewAPI legacy `v0.10.8` | `e6b43f4279bb20d33f8a6afaafcb7a753bab8c3f` (fetched into the same clone) |

Reproduce the reference checkouts, from the Cerium project directory:

```sh
mkdir -p .reference
git clone https://github.com/Wei-Shaw/sub2api.git .reference/sub2api
git -C .reference/sub2api checkout d851a38477597157e78450d30af2d8504764d085
git clone https://github.com/QuantumNous/new-api.git .reference/new-api
git -C .reference/new-api checkout 70e6af6429824f99de98e96e65254c8c2ef7ee0b
git -C .reference/new-api fetch --depth 1 origin tag v0.10.8
```

## Sub2API

Owning files under `.reference/sub2api/`:

- `backend/internal/server/routes/auth.go`: login and refresh registration.
- `backend/internal/handler/auth_handler.go`: `LoginRequest`, `AuthResponse`,
  `RefreshTokenRequest`, `RefreshTokenResponse`, and interactive 2FA responses.
- `backend/internal/pkg/response/response.go`: `code: 0` success envelope.
- `backend/internal/server/routes/user.go`: authenticated groups, rates, and
  available-channel routes.
- `backend/internal/handler/api_key_handler.go`: `GetAvailableGroups` and
  `GetUserGroupRates`.
- `backend/internal/service/api_key_service.go`: available groups are filtered
  by active status, public/exclusive visibility, and the user's subscriptions;
  personal rates are a separate map indexed by group ID.
- `backend/internal/handler/dto/types.go`: ordinary `Group` exposes
  `rate_multiplier`; administrative allowlists/model routing are in `AdminGroup`
  and must not be assumed present in the ordinary user response.
- `backend/internal/handler/available_channel_handler.go`: opt-in model metadata,
  grouped by `platforms`, then `groups` and `supported_models`. The feature can
  legitimately return an empty array. Composite group references can appear in
  multiple platform sections.
- `frontend/src/api/groups.ts` and `frontend/src/api/channels.ts`: confirm the
  frontend's separate rate lookup and the model metadata DTO shape.

Additional gateway-discovery source reads: `api_key_handler.go` create/delete/list,
`idempotency_helper.go` (`Idempotency-Key`), `api_key_service.go` custom key validation
and creation limits, `routes/gateway.go`, and `gateway_handler.go` `Models`.
The latter returns the gateway's visible `data[].id` list for that key's group;
it can itself contain platform defaults, so it is not a claim that every model
was tested through billable inference.

Contract: discover Turnstile from `/api/v1/settings/public`, send
`email`/`password` and optional one-use `turnstile_token` to login;
save the AT/RT pair; rotate through
`/api/v1/auth/refresh`; use the AT for ordinary panel APIs. Join custom rates by
ID without treating zero as absent. The explicitly requested one-time gateway
probe creates a temporary group key using the ordinary user's API and deletes
it afterward; administrator APIs are never used.

## NewAPI current revision

Owning files under `.reference/new-api/`:

- `router/api-router.go`: password encryption key, login, refresh, protected
  `/api/user/self/groups`, and pricing routes.
- `controller/user.go`: optional encrypted-password login, current auth bundle
  fields (`access_token`, `access_expires_at`, `user`, `session`), and refresh
  Cookie issuance. Interactive login can return `require_verification` instead
  of an auth bundle.
- `common/password_crypto.go`: RSA-OAEP/SHA-256 with SPKI PEM keys; long-password
  `v2` AES-256-GCM envelope, OAEP label `password-v2`, GCM AAD `password-v2:<kid>`.
- `controller/auth_session.go` and `service/auth_session.go`: current refresh
  endpoint, rotated Cookie `new_api_refresh`, path `/api/user/auth`, session ID,
  and `X-Auth-Session` semantics. The refresh token is not returned in JSON.
- `middleware/auth.go`: current protected dashboard requests use a bearer AT.
- `middleware/auth_origin.go`: refresh requires a permitted Origin when secure
  cookie mode is enabled; a CLI request must send the site's origin explicitly.
- `controller/group.go`: user-specific ratio and description map, plus the
  special `"ratio": "auto"` case.
- `controller/pricing.go` and `model/pricing.go`: `model_name`, `enable_groups`,
  top-level `group_ratio`, `usable_group`, and `auto_groups`; `all` applies across
  groups. Pricing can be disabled/restricted through navigation module settings.
- `middleware/header_nav.go`: pricing can use optional or required auth and is
  not a substitute for a protected session validation request.

Contract: fetch encryption settings before password login, retain the complete
session, refresh with the scoped Cookie and Origin, and query protected groups
before optional pricing. Never assign automatic groups a made-up scalar ratio.

## NewAPI legacy `v0.10.8`

### Explicit panel token authentication

The current `middleware/auth.go` accepts dashboard bearer access tokens and
scoped personal access tokens, with per-route grants. The legacy file's
`authHelper` accepts an account access token when no login cookie is present,
then requires `New-Api-User` to match the token owner's ID. These are not model
gateway keys. Cerium's optional configured-token mode supplies both headers,
skips password login and refresh, and verifies `/api/user/self/groups` each run.
Public-directory pricing is still fetched anonymously, not with this token.
Expired or revoked configured tokens require manual replacement.

Read the legacy code without switching the reference clone's working tree:

```sh
git -C .reference/new-api show v0.10.8:controller/user.go
git -C .reference/new-api show v0.10.8:middleware/auth.go
git -C .reference/new-api show v0.10.8:controller/pricing.go
git -C .reference/new-api show v0.10.8:router/api-router.go
git -C .reference/new-api show v0.10.8:router/web-router.go
```

The legacy login returns the user ID and issues a browser session Cookie, not
the current auth bundle. Protected requests also require `New-Api-User` matching
that ID. `require_2fa` is a challenge, not a completed session. There is no
encryption-key route or rotating panel refresh pair in this version; missing API
routes return 404 rather than the SPA HTML page.

Critically, legacy `/api/pricing` uses optional session authentication. A dead
Cookie can still receive HTTP 200 with a guest's groups/ratios. The protected
`/api/user/self/groups` route exists in this tag and is checked first, allowing
one bounded re-login before any pricing result is accepted.

## Validation boundary

The protocol tests reproduce these source-defined response/request shapes with
local HTTP servers and real SQLite storage. Reference clones are read-only inputs
to Cerium development and are not vendored or compiled into the binary. No live
third-party account credentials were supplied, so CAPTCHA/WAF behavior,
deployment-specific forks, and real-site end-to-end login remain unverified.
