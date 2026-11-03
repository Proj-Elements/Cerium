# Release Status

Updated on 2026-11-04 (Asia/Shanghai) for `codex/backend-maintenance`.
Local Docker deployment is verified; no publication or remote CI was performed.

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

These unresolved items retain the 2026-11-03 publication audit. Remote CI
configuration and retained checkpoint contents were not re-audited during the
local Docker rollout; this deployment does not establish remote release readiness.

- TODO (checkpoint privacy): obtain approval for a supported code-only push or
  an explicitly authorized cleanup of the outgoing Entire checkpoints. Local
  transcript inspection found unredacted provider-token strings in retained
  history, including earlier sessions. No matched values are reproduced here.
  Do not publish that history based only on automatic redaction metadata, and
  do not bypass Git hooks. Remove this item after the approved push scope is
  enforced and verified. The affected initialization credentials should be
  rotated separately by their owner.
- TODO (remote CI): select and connect the intended CI service or runner, then
  run the documented checks against the exact pushed head. The Entire checks
  API reported `configured: false`, with no plugins or checks; the
  repository also reported `runners_enabled: false`. No GitHub mirror or CI
  workflow was configured in this project. Remove this item after the configured remote
  run completes and its result is verified for the release commit.

As of this update, local Docker deployment has completed, but no code push,
checkpoint upload, remote CI execution, or release publication has been
performed for these commits. Branch protection has not been modified.
