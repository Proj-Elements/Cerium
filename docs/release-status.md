# Release Status

Recorded on 2026-11-03 (Asia/Shanghai) for `codex/backend-maintenance`.

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

## Publication Blockers

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
  API currently reports `configured: false`, with no plugins or checks; the
  repository also reports `runners_enabled: false`. No GitHub mirror or CI
  workflow exists in this project. Remove this item after the configured remote
  run completes and its result is verified for the release commit.
- TODO (deployment): after publication and remote checks are resolved, deploy
  the verified images through the existing Compose topology, preserving both
  data volumes and coordinating Web, Go, and Solver. Take a protected backup
  first, retain the previous images for rollback, and verify health, public
  responses, persisted data, and Solver connectivity after rollout. Remove
  this item only after the deployment and post-deployment checks succeed.

At this recording point, no code push, checkpoint upload, remote CI execution,
or production deployment has been performed for these commits. No production
container or data volume has been changed. Branch protection was inspected and
not modified.
