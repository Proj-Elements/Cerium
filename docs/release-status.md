# Release Status

Updated on 2026-11-04 (Asia/Shanghai). The Docker sections describe the earlier
`codex/backend-maintenance` rollout; the branch-integration status is recorded
separately below. No remote CI or new deployment is implied by integration checks.

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
visibility. All seven retained checkpoint refs now match the configured Entire
remote. This resolves the sharing-scope approval, not the historical redaction
limitations; no credentials were rotated and no token values are reproduced here.

- TODO (remote CI): publish the integration candidate to the private GitHub
  repository `Proj-Elements/Cerium` and observe its exact-SHA push and PR checks.
  GitHub Actions is enabled and focused API/data and Solver checks are now in
  `.github/workflows/ci.yml`. Current GitHub DNS/connection failures block code
  synchronization and remote validation. Remove this item after the configured
  runs complete and their results are verified. The earlier Entire checks API
  reported `configured: false` and `runners_enabled: false`; no protection or
  runner settings have been changed to bypass gates.
- TODO (premium frontend CI): configure an authorized HeroUI setup secret before
  adding cache-free frontend builds and browser checks to GitHub CI. The current
  remote workflow intentionally covers dependency-free Node regressions and the
  Solver image only. Remove this item when an isolated secret-aware build and
  the affected browser checks pass remotely, without exposing setup credentials
  to untrusted pull requests.

## Branch Integration

The initial checkout had no staged, unstaged or untracked source changes. Its
only local work branch, `codex/backend-maintenance` at `0047a93`, contains six
commits beyond `main` at `f85a035`. Their application source is retained unchanged
on the isolated `codex/main-integration` worktree; the added changes are focused
GitHub CI and this status update. No version tag or deployment is requested.

Fresh focused verification passes: 55 Node 24 tests in an offline non-root
container, two polling tests in a source-equivalent Solver image, five public
and three admin Playwright tests, the existing frontend TypeScript/Vite build,
seven CI-selector tests, real-diff selection, and workflow formatting. These are
local checks, not remote CI. Browser fixture databases are cleaned up; production
data, containers, credentials and backups are untouched.

GitHub was confirmed as an empty private repository with the owner-authorized
destination `git@github.com:Proj-Elements/Cerium.git`. Code merge/synchronization
and branch deletion remain pending until publication state and applicable
checks are verified. The interrupted Entire upload published the checkpoint
refs, but not the code branch or a discoverable Trail; its local outgoing queue
may still list already-uploaded refs. Do not clear or rewrite checkpoint state
manually to hide this interrupted synchronization.
