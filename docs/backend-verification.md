# Backend Maintenance Verification

Verified locally on 2026-11-03 (Asia/Shanghai), on branch
`codex/backend-maintenance`, based on
`f85a035515a97c93f0b4ff691b92527c3127aa12` plus the retained working-tree
changes. This report covers that uncommitted candidate, not HEAD alone, remote
CI, a release, or a production deployment.

## Scope And Isolation

- Retained the user's 33 pre-existing modified/untracked files. Changes to five
  of those files are additive maintenance work; the other 28 remain byte-identical
  to the preserved pre-maintenance snapshot.
- Ran tests and builds in an isolated source copy, with temporary SQLite data,
  synthetic credentials, mock upstreams, and existing local dependencies.
- Did not read deployment `.env` files, production databases, production credentials, or
  production logs. Production container IDs, start times, and running states
  remained unchanged.
- Did not stage, commit, push, publish an Entire Trail, or deploy. No dependencies
  were installed or updated for verification.

Local evidence is retained outside Git in
`${TMPDIR}cerium-verification-20261103-_k7bqtg6/` (called `$V` below).
`manifest.json` records the starting source hashes; `final-source-manifest.json`
and `logs/source-preservation.json` identify the delivered source and preservation
checks. Logs and screenshots are local artifacts and may be removed by normal
temporary-directory cleanup.

## Verification Results

Commands ran from the isolated project root unless noted otherwise.

| Check                                                                                                                                      | Result                                                                                          | Evidence under `$V`                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `go test -race -count=1 -json -coverprofile="$V/go-coverage.out" ./...`                                                                    | Passed: 38 top-level tests, 70 including subtests; none skipped; 81.1% total statement coverage | `logs/go-tests-final.jsonl`, `logs/go-test-summary.json`, `go-coverage.out` |
| `go vet ./...`, `go mod verify`, gofmt check                                                                                               | Passed; modules verified; no formatting differences                                             | `logs/go-validation.log`                                                    |
| `CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o "$V/cerium-darwin" ./cmd/cerium`, CLI help                                           | Passed                                                                                          | `logs/go-validation.log`                                                    |
| `cd web && npm test`                                                                                                                       | 77/77 passed on Node 26.7.0                                                                     | `logs/web-final-validation.log`                                             |
| Node 24.22.2: `node --test test/*.test.mjs` in an offline, read-only, non-root container                                                   | 77/77 passed                                                                                    | `logs/node24-tests.log`                                                     |
| `cd web && npm run build && npm run format:check`                                                                                          | TypeScript, Vite, asset precompression, and formatting passed                                   | `logs/web-final-validation.log`                                             |
| `cd web && npm audit --json --ignore-scripts`                                                                                              | Zero reported vulnerabilities; 460 dependencies in audit metadata                               | `logs/npm-audit.json`                                                       |
| `cd web && TMPDIR="$V/fixture-cleanup-public" CI=1 npm run test:ui -- --reporter=list`                                                     | 25/25 passed; no integration fixture directories left                                           | `logs/browser-public-final.log`                                             |
| `cd web && TMPDIR="$V/fixture-cleanup-admin" CI=1 ./node_modules/.bin/playwright test --config=playwright.admin.config.ts --reporter=list` | 3/3 passed; no admin fixture directories left                                                   | `logs/browser-admin-final.log`                                              |
| Solver offline polling regressions in the source-matched cached image                                                                      | 2/2 passed                                                                                      | `logs/solver-polling.log`, `logs/solver-image-equivalence.json`             |
| `git diff --check` and source-preservation comparison                                                                                      | Passed                                                                                          | `logs/source-preservation.json`                                             |

Go was 1.26.7; Playwright was 1.64.1. The browser suite exercised the real
compiled Go bridge and Node service with a mock upstream: signed callbacks,
login/CRUD, tokens, private-group redaction, pricing, announcements, imports,
exports, settings, and desktop/mobile light/dark views. Selected rendered public
and admin screenshots were inspected; screenshots remain in `candidate/artifacts/`.

The final regression tests were also run against the preserved pre-maintenance
backend: 9 passed and 7 failed as expected. The failures cover non-object JSON,
malformed catalog entries, strict boolean visibility, the 401-query read path,
and deterministic active-job selection. The same targeted tests pass on the
candidate. See `logs/regression-baseline.log`.

## Fixture Shutdown Fix

Before the fix, Playwright force-killed its fixture process group, bypassing
temporary-database cleanup even after a successful suite. A controlled admin
run passed all three tests but left one fixture database directory.

Both Playwright configurations now request SIGTERM with a ten-second grace
period. The integration fixture also observes an already-exited Go child and
registers its exit waiter before draining HTTP requests: Playwright may signal
both processes, so registering only after HTTP shutdown can miss the exit event.

A deterministic before/after check exited the Go child first, then signaled
the Node parent. The original fixture exceeded the three-second shutdown bound
and retained its data; the fixed fixture exited successfully and removed its
data. Both final full browser suites then passed without fixture-directory
leftovers. The controlled before-fix reproduction and synthetic session metadata
were removed. See `logs/fixture-lifecycle.json`, `logs/fixture-cleanup-before.log`,
and `logs/local-cleanup.json`.

## Read Performance

Ran `node web/scripts/benchmark-store.mjs` sequentially against the preserved
baseline and candidate on the same machine and Node 26.7.0. Each case uses
200 sites, five groups per site, 20 models per group, 50 warmups, and 300 measured
reads, all in temporary SQLite databases.

| Pending jobs | View   | Median before / after (ms) | p95 before / after (ms) | Median speedup |
| ------------ | ------ | -------------------------- | ----------------------- | -------------- |
| No           | Public | 6.931 / 1.634              | 9.673 / 1.836           | 4.24x          |
| No           | Admin  | 7.230 / 1.717              | 11.064 / 1.898          | 4.21x          |
| Yes          | Public | 6.275 / 1.837              | 6.504 / 1.984           | 3.42x          |
| Yes          | Admin  | 6.360 / 1.924              | 7.101 / 2.072           | 3.31x          |

At the 200-site populated-snapshot boundary, SQL calls per directory read fall
from 401 to two. The query reuses the existing jobs index; no schema migration
or directory cache was added. Visibility, redaction, status precedence, current
revision selection, empty directories, and immediate interval edits have
regression coverage. Timings measure `Store.sites()` only, not HTTP throughput,
production load, or complete synchronization latency.

Raw samples summarized by the benchmark and comparison are in
`logs/benchmark-baseline.jsonl`, `logs/benchmark-final.jsonl`, and
`logs/benchmark-comparison.json`.

## Container Verification

The existing Web and Go Dockerfiles built successfully with the available cache,
using verification-only tags. The Web build reused its required-secret HeroUI
setup layer; it was not a clean credentialed build. Solver's new build failed
before executing Dockerfile steps because Docker Hub's OAuth token endpoint
returned EOF while resolving `python:3.13-slim-bookworm`.

For the permitted fallback, the cached Solver image's `runner.py` and
`requirements.txt` matched the candidate byte-for-byte, and its installed polling
patch was checked before running the two offline regressions and startup test.

| Image                                  | Verified image ID                                                         |
| -------------------------------------- | ------------------------------------------------------------------------- |
| Web, `cerium-verification/web:k7bqtg6` | `sha256:00a74b5d07a6b751935fd1e2840b414342edd9700edd968a12ec998e699f8b51` |
| Go, `cerium-verification/sync:k7bqtg6` | `sha256:eb75acb89c8370c8185cd002a1c643246268b1c82e28af966c19bdcac31daaa3` |
| Cached Solver                          | `sha256:788a86679eb29e8b7d1bad1228e994c4bb1e07e7ba90b8f670bd23ea5f1f8744` |

`python3 "$V/verify-containers.py"` passed with uniquely labeled containers and
volumes, no host ports, and no external network. It checked non-root startup,
the exact candidate Web backend, database mode 0600, CSP and precompressed
assets, signed callbacks, redaction, sync/change flows, validation atomicity,
JSON/SQLite merge and replace, hidden sites, blank-token retention, restart
persistence, password/session rotation, and persisted credential-deletion jobs.
Compose configuration also validated with synthetic environment values and
`--env-file /dev/null`.

Web and Go stopped with exit code zero; Solver stopped on SIGTERM with exit
code 143. All stopped in under 0.1 seconds, without OOM or a forced timeout.
All verification containers and named volumes were removed. Verification image
tags, logs, and screenshots remain; production images/tags were not replaced.
See `logs/container-verification.json` and the Docker build logs.

## Limits And Follow-up

- A fresh Solver build and a cache-free credentialed Web build remain unverified;
  the actionable TODOs are in [the backend verification guide](web.md).
- The existing Vite warning reports a 685.73 kB main chunk. A baseline build
  produced the same warning and all 23 build files were byte-identical; this
  maintenance did not introduce it. See `logs/baseline-build-comparison.json`.
- The npm audit is not a Go or container/OS vulnerability scan. `govulncheck`
  was unavailable and was not installed just to satisfy verification.
- Real third-party availability, CAPTCHA/WAF challenges, and production data
  migrations were not exercised. No remote CI, independent approval, release,
  or deployment is implied by these local results.
