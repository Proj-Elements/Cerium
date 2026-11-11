# Release Status

Updated on 2026-11-11 (Asia/Shanghai). The current deployment and CI credential
verification are recorded first. The subsequent sections retain the earlier
`codex/backend-maintenance` rollout and branch-integration history.

## Current Deployment (2026-11-11)

At the owner's explicit request, replaced the existing Docker Desktop Compose
deployment with application source `d38644eb7906ed801013fffe8b46be3fb7bddc6a`
from [PR #4](https://github.com/Proj-Elements/Cerium/pull/4). The website remains
available at `http://localhost:3080`. No release, version tag, image publication,
or change to unrelated Compose projects was made.

- Built Web with `docker compose build --no-cache web`, injecting the supplied
  key through a BuildKit secret. The private artifact was downloaded anew,
  verified against its pinned SHA256, and passed TypeScript, Vite and static
  precompression. `hpsetup@latest` resolved to 4.8.0 and separately downloaded
  the same artifact in isolated staging. Its additional peer-install phase hit
  npm's `EALLOWSCRIPTS` restriction; the deployed build uses the existing checked
  lockfile and does not depend on that phase or its staging-directory changes.
- Built Sync and Solver from the current Dockerfiles. The new Solver started
  as UID 10002, reported one connected browser and capacity four, and passed
  `/healthz` and `/readyz`. A separate instance stopped promptly on SIGTERM
  with exit 143 and no OOM or forced-kill exit. All three deployed services are
  healthy and use independent network namespaces on the private Compose network.
- Stopped old Sync before Web, then archived both named data volumes while
  stopped. Verified archive readability and SHA256 before replacing containers.
  Retained 24 sites, 24 credentials, 23 sessions, 415 one-time model probes and
  their site mappings. Credential, probe and mapping fingerprints matched after
  startup; sessions subsequently continue normal scheduled refreshes. Both
  databases pass `PRAGMA quick_check` and `PRAGMA foreign_key_check`.
- The old `bridge_jobs` table had no delivery-state column. Its migration
  initialized historical results as pending and exposed false callback backlog
  in readiness. Compared all 12,271 old job identities, site IDs and revisions
  with Web's durable `done` or `superseded` receipts, then transactionally marked
  only those confirmed identities delivered. No synchronization or model probe
  was replayed. The normal retention policy then removed completed history.
  The original databases and reconciliation audit are retained in the backup.
- Web `/readyz` returns 200 with database, dispatcher, worker and Solver ready;
  stale/pending callbacks and cleanup queues are zero. A signed idempotent
  callback from the Sync container reached Web through service DNS. The normal
  scheduler also completed due jobs and delivered real callbacks. Two sites,
  稳 Token and 闪耀模型, still report upstream failures; both already had saved
  errors in the stopped baseline. Service readiness does not imply every
  third-party site succeeds or prove a real Turnstile solve.
- Public assets and gzip decoding pass. Actual management login, authenticated
  directory/settings reads and the data-settings dialog pass. Inspected desktop
  and mobile public screenshots in light/dark modes plus management screenshots;
  no page exceptions or horizontal overflow occurred. No full local regression
  suite was repeated for this deployment.
- Saved the key as repository Actions secret `HEROUI_SETUP_TOKEN`. The existing
  push-only injection guard remains in place, excluding PR events. Reran the
  frontend job of the main push; GitHub also reran its dependency/downstream
  checks. [Attempt 2](https://github.com/Proj-Elements/Cerium/actions/runs/43039104018/attempts/2)
  passed. Its frontend log confirms fresh premium installation, `tsc --noEmit`
  and the production build, rather than the no-secret source-validation branch.
  The token is absent from source, deployment evidence and image metadata/history.

Private archives, image references, rollback Compose configuration, reconciliation
audit, build/CI logs and screenshots are retained outside Git at
`../cerium-backups/20261111-d38644e/` (directory 0700, files 0600). Previous image
tags are `cerium-<service>:rollback-d38644e-20261111`; candidate tags are
`cerium-<service>:deploy-d38644e-20261111`. Image identities:

| Service | Candidate image SHA256 |
| --- | --- |
| Web | `cf0b1d9ea37af26d2e69f740633349f7692cf866dc71b929b3134ab8873ad531` |
| Sync | `9238a3ded14bd3a44b6992e0bc95119478a9f49511d6d79dd84226dbf3766d67` |
| Solver | `1f7e415b758ffd33f679f1de40ba03f69224461e3ab43d43c0a9589c18f3e69f` |

The repair/rollout checks supersede the historical missing-field callback and
premium-build limitations below. Remote browser tests were not added by this
deployment; the integrated local browser suites and live-deployment checks remain
separate evidence.

- TODO (legacy delivery-state migration): make the cross-database completion
  reconciliation reusable for other deployments upgrading from a `bridge_jobs`
  table without `state`. This deployment used verified Web receipts and a
  stopped-database transaction; initializing all historical results as pending
  otherwise causes false stale-callback readiness failures. Remove this item
  after an upgrade path and focused fixtures preserve confirmed completions
  without dropping genuinely undelivered results or replaying upstream work.

## Local Commits

- `cc7e80b`: extend Solver polling within the existing task deadline.
- `26acfd8`: persist admin settings, backups, and favicon selections, with the
  retained responsive interface improvements and regression tests.
- `d9cc434`: harden JSON validation, reduce catalog reads to two SQL calls,
  fix browser-fixture shutdown, and record local verification.

The complete source at `d9cc434` matches the previously verified candidate.
The intermediate retained-feature commit also passed its existing Node tests,
frontend build, and formatting checks in a separate source archive. Full local
verification and its remaining clean-build limits are documented in
[backend-verification.md](backend-verification.md).

## Local Docker Deployment

At the user's explicit request, deployed application source
`e56c0ba6b734401ac71965529146f0f420723b28` to the existing local Docker Desktop
Compose project. Verification completed at 02:03:43 on 2026-11-04
(Asia/Shanghai), with the website available at `http://localhost:3080`.

- Web, Go sync, and Solver are healthy, run as non-root users, and carry the
  exact source revision label. Sync and Solver share the new Web container's
  network namespace; their health endpoints and signed non-object rejection
  checks pass from the running services.
- Retained `cerium_web-data` and `cerium_sync-data` in place. No production
  import, credential reset, volume replacement, or volume deletion occurred.
  Complete-row fingerprints after startup match the stopped-volume backups:
  four sites, four credentials, four sessions, four worker snapshots, 144
  one-time model-probe records, 28 change records, 561 Web jobs, and 561 saved
  bridge results.
  SQLite integrity and foreign-key checks pass for both databases.
- Backups, configuration, source archive, business JSON/SQLite exports, image
  references, and the deployment receipt are outside Git at
  `../cerium-backups/20261104-014734-e56c0ba/`. The directory is mode `0700`;
  database archives and credential-bearing files are mode `0600`. Archive
  SHA256 checks pass. Do not publish these backups or their plaintext secrets.
- Restored both volume archives into isolated temporary volumes and opened
  each with the candidate twice. All existing rows remain unchanged; the
  current databases already have the compatible schema. Removed only these
  task-created test volumes after verification. The first copy audit needed
  writable WAL sidecars on the isolated copy; the original services were
  restored before correcting that audit and taking a fresh two-volume backup.
- Retained previous images as
  `cerium-<service>:rollback-20261104-014734`, plus an image-only rollback
  Compose override beside the backups. Candidate tags are
  `cerium-<service>:deploy-e56c0ba-20261104-014734`; normal Compose image tags
  now point to the verified candidates. No backup is restored automatically.
- Focused checks pass: one Go legacy-migration test, 26 Node 24 data/settings,
  favicon, validation and directory-read tests, and two Solver polling tests.
  Public assets, credential redaction, authenticated settings, and JSON/SQLite
  exports pass against the running deployment. The admin path and 900-second
  interval persist; restarting Web rotates its password and invalidates old
  login sessions. Builds reuse dependency layers, so this is not evidence of
  a cache-free HeroUI credential installation.

## Known Runtime Follow-up

- TODO (callback validation): validate the callback `job_id` before binding it
  to SQLite in `web/server/store.mjs` (`Store.accept`). A correctly HMAC-signed
  `{}` callback returns 500 instead of a client-validation error in both the
  previous and deployed images. Isolated reproductions leave sites and jobs
  unchanged; this is not a rollout regression or a normal sync failure. Remove
  this item once focused missing/invalid-field tests return 400 without changing
  data. Business code was not changed as part of this deployment.

## Publication Follow-up

The 2026-11-03 publication audit found unredacted token strings in retained
sessions; the Docker rollout did not re-audit that history. On 2026-11-04 the
owner explicitly authorized uploading project session logs to the existing
private organization repository, without deleting checkpoints or changing
visibility. All seven previously retained checkpoint refs match the configured
Entire remote, and the outgoing queue is empty after normal pushes. This resolves
the sharing-scope approval and that synchronization, not the historical redaction
limitations; no credentials were rotated and no token values are reproduced here.

GitHub publication and the integration CI checks are complete; the exact source
and run links are recorded below. HTTPS Git transport was used per command because
SSH remained unavailable. Repository visibility, account configuration, branch
protections, and runner settings were not changed to bypass failures or gates.

- TODO (premium frontend CI): configure an authorized HeroUI setup secret before
  adding cache-free frontend builds and browser checks to GitHub CI. The current
  remote workflow intentionally covers dependency-free Node regressions and the
  Solver image only. Remove this item when an isolated secret-aware build and
  the affected browser checks pass remotely, without exposing setup credentials
  to untrusted pull requests.
- TODO (Entire Trail access): restore supported control-plane connectivity and
  cell discovery before using native Trails for subsequent review work. Repository
  and project resolution through `us.auth.entire.io` fails with EOF or TLS timeout;
  the explicit existing-cell API fallback also rejects missing trusted-login
  discovery. Remove this item when normal Trail listing, showing, and gate reads
  succeed. No native Trail creation, approval, or current Entire CI result is
  claimed. The initial checks audit reported `configured: false` and
  `runners_enabled: false`, but current API state cannot be refreshed. Native Git
  code and checkpoint synchronization nevertheless succeeds.
- TODO (managed Codex hook discovery): resolve the managed-worktree hook path
  under explicit setup authorization before relying on automatic associations
  there. Status reports `worktree_path_not_discovered`, with the original checkout
  as the discovered project path; CI commit `6c9ee17` has no automatic checkpoint
  association. Remove this item after a normal tracked commit in a managed
  worktree automatically receives its checkpoint association. No manual
  checkpoint, fabricated trailer, amendment, or hook reinstall was used to hide
  the historical gap.

## Branch Integration

The initial checkout had no staged, unstaged or untracked source changes. Its
local work branch, `codex/backend-maintenance` at `0047a93`, contained six
commits beyond `main` at `f85a035`. Candidate `6c9ee17` retained their application
source unchanged and added focused GitHub CI plus the integration status. All
142 tracked-file hashes matched the verified candidate before merging. During
retry, the owner explicitly requested discarding the unrelated uncommitted
`web/server/icons.mjs` patch; only that worktree change was restored.

Focused local candidate verification passes: 55 Node 24 tests in an offline non-root
container, two polling tests in a source-equivalent Solver image, five public
and three admin Playwright tests, the existing frontend TypeScript/Vite build,
seven CI-selector tests, real-diff selection, and workflow formatting. Browser
fixture databases are cleaned up; production data, containers, credentials and
backups are untouched.

The initially empty private GitHub repository received baseline `f85a035` and
the integration candidate without replacing Git history. [PR #1](https://github.com/Proj-Elements/Cerium/pull/1)
was created with `gh` CLI and merged once, using GitHub's authenticated native
merge identity. The merge is `96cb4900c9859c9f3287ad70d00217b6086ba56b`; its tree
matches `6c9ee17`, and all existing commit IDs and authors are retained. Local
`main` was fast-forwarded to that result, and the same commit was pushed to
Entire. Both remote `main` refs were verified equal after the integration merge;
this docs-only completion record continues that shared history.

### Verified Remote CI

- [Candidate push](https://github.com/Proj-Elements/Cerium/actions/runs/41844969275):
  `6c9ee17894815e0dd948133c859db9dea017a62e`, `push`, `codex/main-integration`.
- [PR checks](https://github.com/Proj-Elements/Cerium/actions/runs/41848215295):
  the same candidate SHA, `pull_request`, PR #1.
- [Merged main push](https://github.com/Proj-Elements/Cerium/actions/runs/41853552622):
  `96cb4900c9859c9f3287ad70d00217b6086ba56b`, `push`, `main`.

Each run completed successfully with all four declared jobs: change selection,
Node API/data regressions, Solver image/polling regressions, and the explicit
aggregate gate. There were no failed, cancelled, or skipped jobs. The remote
Solver checks built the pinned image and ran its two offline polling regressions;
normal service startup, health, and shutdown for that newly built image remain
separate from the earlier source-equivalent cached-image verification. No global
suite, release tag, image publication, or deployment was triggered.

No unresolved review threads or required independent review blocked the merge.
Copilot could not review because its requester had insufficient quota; this is
not presented as an independent review or approval.

### Completed Cleanup

- Deleted local `codex/backend-maintenance` and `codex/main-integration` only after
  ancestry checks proved they had no unique commits outside integrated `main`.
- Deleted remote `codex/main-integration` from GitHub and Entire with exact-SHA
  deletion leases, protecting against concurrent branch updates. Both remotes
  and the local repository retain only `main` as an ordinary branch.
- Returned the original checkout to `main`; the integration checkout is clean
  and detached. The app refused its archival because it is this task's primary
  checkout, so it was retained rather than removed through another tool.
- Preserved all `refs/entire/checkpoints/*`, ignored original dependencies,
  deployment configuration, databases, backups, and containers. Task verification
  logs, screenshots, and necessary ignored integration artifacts remain outside
  Git in the integration verification directory; no checkpoint state was cleared
  or rewritten manually.
