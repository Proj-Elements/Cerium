# Reliability Repair Acceptance

This work starts at `66d45f71187702ea0bf58acd49ed0ed8f59e4bbd` and covers
review findings 1–25, 28, 30–35, and 37. Findings 26, 27, 29, and 36 are
outside the change. It does not authorize a deployment or a version release.

Independent implementation groups use separate worktrees. Each group verifies
its affected behavior; the complete local check is reserved for the integrated
candidate, after all implementation groups finish.

| Finding | Required behavior and acceptance evidence |
| --- | --- |
| 1 | Core Go, CLI, frontend, contracts and container paths select their owning checks; invalid diff history fails selection. |
| 2 | Permanent callback rejection cannot trap manual retries in a saved invalid result; transient delivery errors still reuse a saved result. |
| 3 | Go and Node agree on canonical URLs, including trailing slashes and escaped path characters. |
| 4 | Removing or replacing credentials retains pending remote-key deletion and the information needed to finish it. |
| 5 | A failed key deletion for one group permits discovery of unrelated groups. |
| 6 | An outdated editor receives a conflict; it cannot silently overwrite a newer configuration. |
| 7 | Model or group search and multiplier filters must be satisfied by the same group. |
| 8 | Truncated image files are rejected; invalid persisted images become eligible for rediscovery. |
| 9 | Finished Solver tasks release active capacity while their results remain readable. |
| 10 | Overlapping polling, refresh and mutation requests cannot apply stale results. |
| 11 | Changing icon configuration or cache state refreshes an already mounted icon. |
| 12 | Missing or malformed signed callback identifiers return 400 without database changes. |
| 13 | Admins can search and paginate all retained change announcements. |
| 14 | A finite nonzero price never rounds to a displayed zero. |
| 15 | Imported revision boundaries remain editable and do not permit stale callbacks. |
| 16 | Independent sites make bounded concurrent progress without rotating a credential concurrently. |
| 17 | Saved bridge result payloads have a byte budget and bounded retention. |
| 18 | Unchanged public reads use conditional responses; changed payloads support compression and clients back off while idle. |
| 19 | Backup serialization, parsing and compaction run outside the HTTP event loop; administrative data operations are serialized. |
| 20 | A valid directory can be backed up without retaining optional icon image bytes. |
| 21 | A coordinated recovery archive includes both databases and preserves cleanup, probe, session and mapping state; failures restore the previous state. |
| 22 | Cosmetic edits preserve active collection; identity or authentication changes invalidate it. |
| 23 | Readiness checks distinguish database, queue, callback and browser capability from HTTP liveness. |
| 24 | Errors expose safe categories, stages and correlation identifiers without credentials or upstream response bodies. |
| 25 | Recreating Web does not strand Sync or Solver in an old container network namespace. |
| 28 | An explicit admin action can refresh model discovery; ordinary syncs retain the one-time default. |
| 30 | Direct frontend dependencies match actual imports and verified peer requirements. |
| 31 | Shared contract definitions and cross-language fixtures detect incompatible field and normalization changes. |
| 32 | Admin, catalog, storage and CSS responsibilities move to focused modules without changing unrelated behavior. |
| 33 | Base images, Python transitive dependencies and system package sources are pinned. |
| 34 | Site, group and filter URLs survive refresh and browser back/forward navigation. |
| 35 | Price comparison uses known site prices and explicit exchange rates; unknown, reference and dynamic values cannot masquerade as fixed offers. |
| 37 | Known model additions/removals and material price or expression changes produce retained announcements. |

The final delivery records actual local results and remote CI separately.
Unavailable clean credentialed builds, real upstream access and production
deployment must not be represented as verified.

## Integrated local verification

The complete Go, Node, contract, frontend and browser checks ran after the
implementation groups were integrated. The final integrated candidate passed
every suite below without focused reruns or skipped cases.

- `go test -race ./... -count=1` passed all 181 tests across three packages;
  `go vet ./...` also passed.
- `npm test --prefix web` passed all 175 tests, including storage, HTTP, backup,
  recovery and the legacy fixtures updated for current callback contracts and
  diagnostic logging.
- `python3 contracts/generate.py --check`, 45 Node contract vectors and the Go
  contract package passed. The CI selector's 15 tests cover source ownership,
  renames, generated filenames and invalid history; frontend syntax, CSS and
  local-import checks also passed.
- `npm run build --prefix web` and `npm run format:check --prefix web` passed.
  The production build used the existing authorized HeroUI artifact cache and
  verified its locked SHA256 before installation. Vite still reports its
  existing large-chunk advisory.
- All 33 public browser cases and all 13 admin browser cases passed in complete
  runs. Admin cases cover editing conflicts, history pagination, data migration,
  icons, responsive themes and deliberate model refresh for both provider types.
  Screenshots were inspected on desktop and narrow light/dark layouts; the model
  comparison table keeps its estimated cost visible on mobile.
- The real Go/Node browser fixture exported and restored the v2 recovery archive,
  rejected a corrupt checksum, invalidated the admin session, resumed sync and
  retained the same one-time model probes.
- Eight Solver admission/readiness and upstream polling tests passed in the
  existing Solver image with the current runner mounted, without network access.
  Compose configuration and the Solver Dockerfile check passed.

Late integrated regressions also cover 500 groups producing 1500 change details,
the 20000-model union of two disjoint price catalogs, snapshot-only compaction of
SQLite free pages, canonical duplicate quarantine, combined malformed legacy URLs
and exhausted revisions, and cross-connection credential/recovery lease guards.

Clean local Sync and Solver image builds were attempted. Docker Hub resolution
blocked the former; GitHub upstream access blocked the latter after pinned Debian
packages installed. These attempts do not establish clean image-build success.
Remote CI must report its own exact candidate results. The repository has no
HeroUI setup secret, so its remote frontend check explicitly distinguishes source
validation from the credentialed production build verified locally.

Entire reports `worktree_path_not_discovered` for the managed checkout. Existing
hook records are retained; no checkpoint trailer or session association was
fabricated to conceal this traceability gap.
