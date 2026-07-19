# Stage 1 implementation guide: make safety evidence trustworthy

**Status:** Repository implementation and controlled evidence complete; repository-external branch-protection administration remains pending
**Parent plan:** [`2026-07-18-post-fork-maintainability-implementation-guide.md`](2026-07-18-post-fork-maintainability-implementation-guide.md) — Roadmap → Stage 1
**Entry condition:** Stage 0 is complete at `HEAD@7da4411` plus the current uncommitted working tree. The build, 10-consecutive-run Windows Vitest gate, protocol generator check, package check, compile-only Enforce validator, and controlled V10 real-addon mailbox suite are the closeout gates. Their structured records live under `docs/validation/`.

## Purpose

The parent plan's own baseline assessment is the reason this stage exists:

> Those green results are useful, but they overstate behavioral coverage. CI runs only on Ubuntu, `test:package` is not in CI, Enforce `.c` code is not compiled by the normal test command, live Workbench/runtime tests are opt-in, and several contract suites inspect source strings instead of executing behavior.

Stage 1 does not add user-facing product behavior. It closes the gap between "tests pass locally on Windows" and "CI evidence can be trusted to gate a merge of Windows process code." Concretely, that means: a second CI job that actually runs on Windows, a package check that actually installs the tarball instead of only inspecting its file list, a test-vs-reality mismatch in the launch-argument ceiling, and a first baseline of operational timings. Task 4 adds only count-only diagnostic surfaces and actual-exit bookkeeping in `ChildSupervisor`, `WorkbenchClient`, `OwnedRuntimeManager`, and `ObserverCoordinator`; it does not add reusable production timing hooks or begin any Stage 2 consolidation.

## Relationship to V10

Stage 0's roadmap exit criteria says Stage 1 should make "Stage 0 generator and Enforce acceptance evidence... reproducible in CI or a controlled environment." V10 now satisfies the controlled-environment half: a packaged runner launches an isolated Steam-initialized Workbench, compiles Game and WorkbenchGame, executes five cases, and emits a fail-closed artifact. Stage 1's job is to carry that evidence model into required CI tiers and installed-package smoke testing; it does not need to turn the Tier 3 Workbench run into per-commit GitHub Actions.

The evidence pattern is now a pair: `docs/validation/2026-07-18-observer-enforce-compile.json` records the compile-only gate and explicitly leaves behavior `not_run`, while `docs/validation/2026-07-18-observer-enforce-mailbox-acceptance.json` records source and host-module identity, compiled-module diagnostics, exact case metrics, real exclusive-lock handshakes, exactly-once host delivery, and process vacancy. Task 4 extends this structured, hashed format to timing/process-count evidence.

## Resolved findings: flaky lifecycle evidence behind "Complete" claims

While re-validating Stage 0 for this guide, the full Vitest suite was run five times consecutively (`npm test -- --reporter=dot`, then three more with `--reporter=verbose`, all on Windows, all against the current working tree). It failed **twice out of five runs**, always on the same test:

```
FAIL tests/observer/private-child-owned-runtime-recovery.test.ts
  > actual private-child owned-runtime recovery boundary
  > keeps release-required authority pinned past retention when release is lost before delivery

Error: ENOENT: no such file or directory, open
  '...\owned-runtime-authorities-v1\rt-00000000-0000-4000-8000-000000000002.json'
  at tests/observer/private-child-owned-runtime-recovery.test.ts:558:23
```

This is one of the tests the parent doc cites as evidence for **F2/V2 = Complete** ("Real coordinator-to-forked-child tests repeatedly kill and replace the child... Release loss before delivery and response loss after application both preserve the exact generation until durable acknowledgement"). It spawns a real private-child process, not a fake backend.

Tracing the assertion at [private-child-owned-runtime-recovery.test.ts:551-560](../../tests/observer/private-child-owned-runtime-recovery.test.ts#L551-L560): after a retried `start()` rejects with `START_UNVERIFIABLE`, the test does an unguarded `readFileSync` against two separate durable records and expects both already at `release_acknowledged`:

1. `pending.path` — the main process's own pending-start record, written by [`owned-runtime-manager.ts`](../../src/observer/owned-runtime-manager.ts)'s `retryPendingStartLifecycleReleaseForKey`, which `start()` does `await` (with errors swallowed) before it rethrows — see [owned-runtime-manager.ts:1405-1413](../../src/observer/owned-runtime-manager.ts#L1405-L1413). This read did not fail in the reproduced failure.
2. `authorityPath(...)` — a *separate* record under `owned-runtime-authorities-v1`, owned by [`observer/agent/owned-runtime-authority.ts`](../../observer/agent/owned-runtime-authority.ts), which lives in the **real forked private-child process**, not the main process. This is the read that threw `ENOENT`.

The root cause was confirmed as a test-retention race, not a production durability gap. The private child synchronously persists `release_acknowledged` before sending its IPC response, but this fixture configured terminal-record retention to zero and swept every 100 ms. The proof could therefore be written correctly and then legitimately removed before the parent test's unguarded read.

A second independent five-run full-suite pass then found a different failure once in five runs:

```
FAIL tests/observer/owned-runtime-manager.test.ts
  > OwnedRuntimeManager
  > reports one bounded inventory remainder after the aggregate shutdown deadline

OwnedRuntimeError: Owned runtime stop exceeded its total wall-clock deadline;
  exact durable state was preserved for retry
```

This was also a fixture race, not a V5/F6 product failure. The test assigned 100 ms each to lock, inspection, and termination while performing six successful prepare/start/stop setup cycles before testing `close()`. Under parallel filesystem and scheduler load, a setup stop could correctly exhaust its 300 ms aggregate deadline. The fail-closed result was the intended production behavior, but it occurred before the assertion's target scenario.

### Task 0: stabilize and verify repeated lifecycle evidence (complete)

**Priority:** Complete — the 10-consecutive-full-suite evidence bar is recorded in [`2026-07-18-phase-0-vitest-repetition.json`](../validation/2026-07-18-phase-0-vitest-repetition.json).

**Implemented diagnosis and fixes:**

- Traced the private-child release path and confirmed that the authority write completes before the child sends its IPC response.
- Added a `sessionTerminalRetentionMs` option to the boundary harness and gave the release-evidence case a 1,000 ms terminal-retention window, preserving the unguarded read while preventing the cleanup sweep from racing it.
- Gave the six-cycle inventory fixture ample setup headroom, then deterministically advanced its mocked wall clock by one shutdown budget after the first successful lifecycle release. It now proves exactly one release and one bounded remainder for exactly five uninspected runtimes without relying on scheduler speed.
- Converted the sibling completion-pending and lifecycle-release deadline cases to controlled timers, and restored the artifact-intake fixture's successful-path stability timeout to the 2-second production default.

**Validation and acceptance:**

- The real-private-child case passed 10/10 focused repetitions.
- All three repaired deadline scenarios passed 20/20 fresh Vitest processes while a full 981-test suite ran in parallel; that full suite also passed.
- Ten consecutive shuffled Windows full-suite runs passed with retries disabled and seeds 1-10. Each run completed 262 suites with 977 passed, 4 skipped, and 0 failed.
- F2/V2 and F6/V5 remain correctly classified as complete because both failures were test-fixture timing assumptions; no production change was required.
- The append-only [`2026-07-19-stage-0-evidence-provenance-review.json`](../validation/2026-07-19-stage-0-evidence-provenance-review.json) independently verified the retained hashes/counts and records the historical result as `internally_consistent_provenance_limited`. It explicitly preserves the missing full-tree/revision binding, non-durable raw reports, unretained focused-repetition evidence, closeout-only evaluator hashes, and non-retained diagnostics as limitations rather than implying they were reconstructed.

## Stage 1 tasks

Tasks 1-4 below are the parent doc's engineering work. Task 5 is the formal image-evidence review added during implementation. Numbering is preserved for traceability; Task 0 above is evidence-integrity work, not a renumbering of the roadmap.

### Task 1: add the Windows CI job and require the generator dirty-diff check

**Status:** Repository implementation complete; branch-protection administration pending. [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) now has symmetric Ubuntu and Windows Node 20/22 jobs. Both run the protocol check, generator, generated-output dirty diff, build, and full tests; Ubuntu Node 20 also runs the installed-tarball smoke. The checkout cannot configure or verify the repository's `main` branch rule, so an administrator must still require the applicable Ubuntu and Windows check contexts.

**Initial state:** [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) had exactly one job, `build-and-test`, matrixed over Node 20/22 on `ubuntu-latest`. It already ran `protocol:check`, `protocol:generate`, and `git diff --exit-code -- observer/protocol` — the generator dirty-diff requirement was already satisfied, just not on Windows. The remaining repository gap was the missing Windows job.

That gap is not cosmetic. `describe.skipIf(process.platform !== "win32")` in [`tests/observer/integration/owned-runtime-windows.test.ts:38`](../../tests/observer/integration/owned-runtime-windows.test.ts#L38) — real native-handle inspection/termination against an exact-owned fixture — silently skips on the Ubuntu runner today. So do the exact-process, mutex, and multiprocess-lifecycle suites under `tests/workbench/` that depend on Windows process semantics. None of that currently runs in CI at all; it only ran because this validation pass happened to run on a Windows machine.

**Implementation:**

- Add a second job to `ci.yml` — e.g. `build-and-test-windows`, `runs-on: windows-latest`, matrixed over the same Node versions (or just the minimum supported, 20, if runner minutes are a concern).
- Run at least: `npm ci`, `npm run build`, `npm test`. Do not run `protocol:generate`/dirty-diff twice for its own sake, but do not skip it either — keep both jobs symmetric so a Windows-only regression in generated output cannot slip through by accident.
- Give the Windows job a longer timeout than the default; the local run of the full suite took 106-113s per run in this validation pass, and CI runners are typically slower than a local dev machine.
- Make both jobs required status checks on the branch protection rule for `main` (this is a repo-settings change, not a file change — call it out to whoever has admin access; it cannot be verified from inside this repo checkout).

**Acceptance:**

- A PR that only touches a file under `src/workbench/` or `src/observer/owned-runtime-manager.ts` cannot merge with only the Ubuntu job green.
- `describe.skipIf(process.platform !== "win32")` suites report as executed (not skipped) in the Windows job's output.

### Task 2: add installed-tarball smoke testing; remove or compile published harnesses (F12)

**Status:** Complete. The three TypeScript acceptance-harness files are repository-only, and their npm commands are explicitly `dev:`-prefixed. [`scripts/check-package.mjs`](../../scripts/check-package.mjs) creates a real tarball, installs it into a fresh project with `--omit=dev`, and executes both advertised binaries without a shell. The final smoke passed with 690 packed files and is wired into Ubuntu Node 20 CI.

**Initial state:** [`scripts/check-package.mjs`](../../scripts/check-package.mjs) verified the *file list* `npm pack --dry-run` would produce (required files, forbidden paths, handler manifests) and ran one executable check — `node dist/observer/agent/index.js --version` — against the **repo's own `dist/`**, not an installed package. It never ran `npm install` from the packed tarball, so it could not catch a missing runtime dependency or an entry point that only failed once resolved from `node_modules`.

The specific gap the parent doc's F12 describes is real and confirmed in `package.json`:

- `files` (package.json:50-72) publishes `scripts/run-workbench-observer-acceptance.ts`, `scripts/run-runtime-observer-acceptance.ts`, and `scripts/observer-live-acceptance-support.ts` as raw TypeScript source.
- The corresponding npm scripts (`observer:acceptance:workbench`, `observer:acceptance:runtime`) invoke them via `tsx`.
- `tsx` is a `devDependency` (package.json:43), not a `dependency`.
- The root `tsconfig.build.json` explicitly excludes `scripts/**/*` (and `tests/**/*`), so these files are never compiled into `dist` either.

A production install via `npm install reforger-forge-mcp` (or any install with `--omit=dev`) ships these two scripts as advertised commands that cannot run — there is no `tsx` to run them with, and no compiled JS to run instead.

**Implementation:**

- Adopt the parent doc's own recommendation for F12: keep the acceptance harnesses repository-only. Remove `scripts/run-workbench-observer-acceptance.ts`, `scripts/run-runtime-observer-acceptance.ts`, and `scripts/observer-live-acceptance-support.ts` from `package.json`'s `files` array, and remove or clearly re-scope the `observer:acceptance:workbench` / `observer:acceptance:runtime` npm scripts as dev-only (they remain runnable from a repo checkout with `npm run`, which already has devDependencies installed; they simply stop being part of the published contract).
- If a maintainer instead wants these to be real product commands, the alternative is: move them under `src/`, compile them via the existing `tsc` build (or a project-reference-based build if that's cleaner), expose them as additional `bin` entries, and move any runtime-only dependencies out of `devDependencies`. Given the parent doc already picked a default, treat "compile and ship" as an explicit opt-in decision rather than the default path for this task.
- Extend `scripts/check-package.mjs` (or add a sibling script invoked by the same `test:package` run) to:
  1. Run the real `npm pack` (not `--dry-run`) into a temp directory.
  2. `npm install <tarball> --omit=dev` into a fresh temp project (mirroring the `REFORGER_FORGE_NPM_CACHE` pattern already used at check-package.mjs:21-25 to keep this hermetic and fast in CI).
  3. Execute each advertised `bin` entry (`reforger-forge-mcp`, `reforger-forge-workbench`) with a safe no-op/status invocation and assert a clean exit with no `MODULE_NOT_FOUND`/`ERR_MODULE_NOT_FOUND`.
  4. Fail loudly and specifically (name the missing module/bin) rather than just asserting exit code 0, so a future regression here is diagnosable from CI logs alone.
- Add `npm run test:package` as a required step in `ci.yml`. It is not there today — `ci.yml`'s job runs `protocol:check`, `protocol:generate`, `git diff`, `build`, and `test`, but never `test:package`. This is the single highest-leverage line to add: the check already exists and passes locally, it is just not gating merges.

**Acceptance:**

- `npm run test:package` fails if either acceptance-harness script is present in a packed tarball without a working runtime.
- `npm run test:package` fails if a fresh `--omit=dev` install of the tarball cannot execute either published `bin`.
- `ci.yml` runs `test:package` on at least one platform (Ubuntu is sufficient for this specific check, since it's about Node module resolution, not Windows process semantics — though running it on both is harmless).

### Task 3: replace the 128 MiB prepared-descriptor ceiling with a real command-line-aligned limit

**Status:** Complete. Prepared descriptors now have a symmetric read/write cap of 402,034 bytes, derived in source from the 32,767-unit Windows command-line boundary, bounded path/session text, worst-case JSON escaping, array structure, and a fixed envelope. The generic 128 MiB configurable record ceiling remains available to unrelated lifecycle record types. Boundary tests cover a near-cap worst-case escaping payload and over-cap rejection without poisoning later preparation.

**Initial state:** Two different limits coexisted and were easy to confuse with each other:

1. **The real boundary**, correctly implemented: `assertWindowsCommandLineFits()` at [owned-runtime-manager.ts:645-655](../../src/observer/owned-runtime-manager.ts#L645-L655) reconstructs the actual quoted Windows command line and rejects with `ARGUMENT_CONFLICT` above 32,767 UTF-16 units (`CreateProcess`'s real limit). This is correct today and Task 3 does not need to touch it.
2. **A generic, much looser storage ceiling**: `PREPARED_DESCRIPTOR_MAX_BYTES = 128 * 1024 * 1024` (128 MiB) at [owned-runtime-manager.ts:52](../../src/observer/owned-runtime-manager.ts#L52), reused as `DEFAULT_MAX_RECORD_BYTES` at line 53 and applied via `Math.min(PREPARED_DESCRIPTOR_MAX_BYTES, this.maxRecordBytes)` when reading any prepared-launch descriptor back off disk ([line 3839-3845](../../src/observer/owned-runtime-manager.ts#L3839-L3845)). Its sizing rationale is a comment, not a real requirement: `// 519 strings × 32,768 UTF-16 code units, including worst-case JSON escaping.`

No test exercises the 128 MiB ceiling itself — a repo-wide search found none. What the ceiling actually exists to accommodate is one specific test, [`owned-runtime-manager.test.ts:584-594`](../../tests/observer/owned-runtime-manager.test.ts#L584-L594), `"can reopen the largest public prepared-argument payload without poisoning later preparation"`. That test builds 512 arguments of 32,768 `"x"` characters each (16+ MiB of raw argument text, confirmed to serialize past 4 MiB on disk via its own `statSync(...).size` assertion), stores it successfully, and only *then* proves `start()` correctly rejects it with `ARGUMENT_CONFLICT` and that a subsequent unrelated `prepare()` isn't poisoned. That is a legitimate and worth-keeping test — it proves the store doesn't choke on an oversized-but-storable payload and that rejection doesn't corrupt later state — but 512×32,768 characters is not derived from any real launcher boundary, and neither is 128 MiB. No real Workbench/runtime launch can legitimately need anywhere near that: the actual ceiling on total argument text is ~32,767 UTF-16 units (~64 KB), plus JSON envelope overhead of at most a few hundred bytes per argument (quoting, key names, array syntax).

**Implementation:**

- Derive a named constant from the real boundary instead of an arbitrary round number, e.g. `MAX_REALISTIC_PREPARED_DESCRIPTOR_BYTES`, sized as the true worst case: `WINDOWS_COMMAND_LINE_MAX_UTF16_UNITS (32_767) * 2 bytes * worst-case-quoting-expansion-factor + fixed JSON envelope overhead`, with the arithmetic shown in a comment (not just asserted) so the next person doesn't have to reverse-engineer it the way this guide had to.
- Decide, explicitly, whether `DEFAULT_MAX_RECORD_BYTES` (the production default, currently 128 MiB) should shrink to track this new realistic bound, or whether it stays as generous headroom for unrelated record types that share the same `readParsed`/store-budget machinery. If other record kinds (runtime receipts, camera obligations, etc.) go through the same per-record byte budget, don't silently tighten their ceiling as a side effect of fixing this one — scope the new tighter constant to prepared-launch descriptors specifically if the budget machinery is shared.
- Rewrite or supplement the existing test so it asserts against the *aligned* limit rather than an arbitrary large one: construct a payload sized just over the real Windows command-line boundary (not 16 MiB over it) and prove the same two properties — clean storage-layer acceptance/rejection behavior and no poisoning of subsequent `prepare()` calls. Keep a much smaller, fast synthetic case (like the existing `maxRecordBytes: 1_024` / `4_096` harness at [owned-runtime-manager.test.ts:630-639](../../tests/observer/owned-runtime-manager.test.ts#L630-L639)) for pure store-capacity-budget behavior — that part is already correctly scaled down and doesn't need to change.
- If a payload near the real boundary is retained purely to prove the store layer tolerates something larger than any single argument's command-line limit (e.g., many arguments each individually under 32,767 units but summing higher before the aggregate check fires), keep that as an explicit, named "aggregate vs. per-string" test case rather than folding it back into an arbitrary large number.

**Acceptance:**

- The production default ceiling for a prepared-launch descriptor is justified by a documented calculation tied to the real Windows command-line limit, not a round number picked to comfortably exceed one test fixture.
- The "largest payload" test constructs a payload sized from that same real boundary, not 512×32,768 characters.
- Existing store-capacity-budget tests (record count, aggregate bytes, per-record bytes) keep passing unchanged — this task does not touch that machinery, only the prepared-descriptor-specific ceiling and its test.

### Task 4: record baseline timings and helper-process counts

**Status:** Complete. Two comparable Workbench baselines and two comparable runtime baselines passed in the same controlled Windows environment:

- Workbench: [`sample 1`](../validation/2026-07-19T08-06-18-022Z-workbench-operational-baseline-292535fd-f4e9-4e46-8d1d-c4cb10d673a5.json) (309,639.261 ms total) and [`sample 2`](../validation/2026-07-19T08-12-15-503Z-workbench-operational-baseline-6a588062-221a-4ac7-a3df-76e29816fd86.json) (314,036.494 ms total).
- Runtime: [`sample 1`](../validation/2026-07-19T08-18-42-066Z-runtime-operational-baseline-55fa9e79-30fc-49df-b4eb-64ef58a2dcff.json) (41,620.513 ms total) and [`sample 2`](../validation/2026-07-19T08-20-03-663Z-runtime-operational-baseline-2234124b-1107-4474-9de1-b2eb69423669.json) (41,926.297 ms total).
- Each same-path pair has identical environment, workload, source-closure, and ordered-operation identity. The records bind Workbench or game executable version 1.7.0.54, record every required timing boundary, start and finish at zero supervised processes, and require actual-exit settlement to zero. Private host identifiers and absolute paths are absent; owner capabilities and PIDs are absent or redacted, while non-identifying machine-class data is retained for comparison.
- `thresholds` is deliberately `null`; these are observations, not a premature performance gate.

The repository-only harnesses own the timing recorder. Production additions are limited to count-only diagnostics and actual-exit bookkeeping needed to prove process vacancy.

**Initial state:** No reusable timing or process-count instrumentation existed in production code. A repo-wide search for `durationMs`, `elapsedMs`, `performance.now()`, and `process.hrtime` under `.ts` files found exactly one hit, inside `tests/workbench/integration/live-lifecycle-acceptance.test.ts` — a local measurement inside one opt-in manual test, not shared infrastructure. `ChildSupervisor` ([`src/workbench/child-supervisor.ts:35`](../../src/workbench/child-supervisor.ts#L35)) already tracked every supervised child and was the natural place to expose a count, since both Workbench and owned-runtime children register there.

This task is genuinely "record a baseline," not "build a benchmarking framework" — the parent doc's own status note for this task is a single line, and the goal is a first reproducible number to notice future regressions against, following the evidence-artifact pattern established by the Enforce compile and mailbox acceptance records under `docs/validation/`.

**Implementation:**

- Add timing capture at exactly four boundaries, matching the parent doc's own phrasing ("launch, managed calls, capture, and shutdown"):
  - **Launch:** time from `start()`/launch-plan submission to a confirmed `running` state.
  - **Managed calls:** time for a representative ordinary NET API call (post-Stage-0-Task-11, these run outside the machine mutex — this baseline is also the natural regression check that they stay fast now that they're unlocked).
  - **Capture:** time from job submission to artifact availability, for at least one runtime and one Workbench capture.
  - **Shutdown:** time from stop request to `terminationComplete` (and separately, to `observerCleanupPending` clearing, since Stage 0/F9 made those two distinct).
- Sample a helper-process count (via `ChildSupervisor` or equivalent process enumeration) at rest and at each boundary above, to catch process-handle leaks as a side effect of the same run.
- Reuse the existing opt-in acceptance harnesses (`scripts/run-workbench-observer-acceptance.ts`, `scripts/run-runtime-observer-acceptance.ts`) as the place to emit this data rather than building new instrumentation paths — they already exercise launch/capture/shutdown end-to-end in a controlled environment. Emit results as a timestamped JSON artifact under `docs/validation/`, following the shared compile/mailbox evidence shape (`schemaVersion`, `kind`, `startedAt`/`finishedAt`, structured results) so evidence artifacts stay uniform and greppable.
- Do not gate CI on specific timing thresholds yet — that requires more than one data point. This task's exit bar is "a number exists and is reproducible," not "a regression budget is enforced." A follow-up stage (or a later Stage 1 task, if a maintainer wants it sooner) can add threshold enforcement once there's a baseline plus at least one comparison run.

**Acceptance:**

- Running the acceptance harness in a controlled environment twice produces two comparable, structured timing/process-count artifacts under `docs/validation/`.
- The artifact records enough about the environment (Workbench version, machine class, Node version) that a future large delta can be triaged as "real regression" vs. "different machine" without guesswork.

### Task 5: formally review the finalized Workbench image evidence

**Status:** Complete. The finalized manifest for run `20260718T015947Z-6ec8429d` remained unmodified at review and retains its original `Unreviewed`/`imagesReviewed=false` state. Formal review is recorded separately in [`2026-07-19-workbench-observer-evidence-review.json`](../validation/2026-07-19-workbench-observer-evidence-review.json), bound to that manifest and every exported member by SHA-256. The record explicitly notes that the source bundle is retained only in a machine-local temporary directory and is not a durable repository archive.

**Review performed:**

- Inspected all five PNGs at their original 1181×632 resolution: `initial-current`, `explicit-pose`, `post-pose-restoration-current`, `explicit-look-at`, and `post-look-at-restoration-current`.
- Confirmed coherent Workbench renders, materially distinct pose/look-at views, and visible return to the initial composition after both explicit views. No blank frame, decode corruption, or foreign-window contamination was visible.
- Recorded the image-capable reviewer identity, Workbench product/file version 1.7.0.54, per-capture outcomes, the expected editor-overlay warning, and explicit scope limitations.
- Recomputed the manifest SHA-256 and matched it to the export receipt. Recomputed all 12 declared member hashes and byte counts, confirmed the exact 13-file set including `manifest.json`, and found no mismatch or unexpected file.

**Acceptance:**

- The formal review outcome is `Passed` and `imagesReviewed=true` in a durable repository evidence record.
- The review record does not rewrite or misrepresent the finalized source manifest's original `Unreviewed` state, and it distinguishes hash verification from physical immutability or durable archival.
- The companion-based Workbench editor path may now be described as live-qualified for the reviewed Workbench 1.7.0.54 procedure and stated limitations.

## Suggested review boundaries

- **Evidence integrity:** Task 0 is complete and independently reviewable through the two fixture fixes and the recorded 10-run Windows artifact.
- **CI infrastructure:** Tasks 1 and 2 together — both are `ci.yml` and packaging-script changes, naturally reviewed as one "what gates a merge now" change.
- **Correctness-adjacent cleanup:** Task 3 alone — it's a source and test change in `owned-runtime-manager.ts`, not a CI change, and touches a file every other Stage 0 finding also touches, so keep its diff minimal and easy to isolate from the others.
- **Observability baseline:** Task 4 alone — lowest risk, no gating behavior, easiest to land whenever a controlled environment is available to run it.
- **Formal visual evidence:** Task 5 alone — a review record bound to an already finalized export, with no production-code change.

## Exit criteria

Restated from the parent doc's Stage 1 exit criteria, made concrete against what was verified in this guide:

- [ ] A PR touching `src/workbench/**` or Windows-only paths in `src/observer/**` cannot merge on Ubuntu-only evidence. The Windows job exists in `ci.yml`; requiring the applicable Ubuntu and Windows check contexts in `main` branch protection remains an external administrator action.
- [x] `npm run test:package` is a required CI step, and it exercises an actual `--omit=dev` install of the packed tarball, not just the file manifest.
- [x] The compile-only and behavioral mailbox artifacts under `docs/validation/` are the template followed by both pairs of controlled timing/process-count evidence, so "reproducible in a controlled environment" is concrete and checkable.
- [x] The prepared-launch-descriptor byte ceiling and its test are both justified by the real Windows command-line boundary, not an arbitrary round number.
- [x] The test suite is clean across repeated runs, not just a single green run — Task 0 met its 10-consecutive-run bar, and the Stage 1 closeout suite passed 262 suites with 980 passed, 4 skipped, and 0 failed.
- [x] The five-capture Workbench export has a separate formal image-review record whose hashes bind it to the finalized manifest and member attestations.

## Non-goals for this stage

Everything in the parent doc's "Consolidate" section (shared `ExactProcessBackend`, `WorkbenchSessionController`, `CaptureService`, etc.) is Stage 2+ and explicitly out of scope here. Stage 1 does not move, rename, or merge any production module. Task 3 is a narrowly scoped constant-and-test change, and Task 4 is limited to count-only diagnostic access plus private-child actual-exit bookkeeping used by repository-only acceptance harnesses. Reusable timing instrumentation, production thresholds, and module decomposition remain out of scope. Resist the temptation to "clean up while you're in there" on `owned-runtime-manager.ts` for Task 3 or Task 0 — that file's real decomposition is Stage 2's job.
