# Release Status

Updated on 2026-11-04 (Asia/Shanghai). The Docker sections describe the earlier
`codex/backend-maintenance` rollout; the branch-integration status is recorded
separately below. Linked GitHub runs establish remote CI; the integration does
not perform a new deployment, release, or version-tag push.

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
