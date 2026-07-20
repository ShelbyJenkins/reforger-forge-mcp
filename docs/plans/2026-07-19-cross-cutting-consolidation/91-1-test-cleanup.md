# Test suite cleanup guide

Survey of `tests/` covering five things: the lopsided test-to-source
distribution, the invisible type-safety debt, the few oversized files that hold
most of the bulk, odd file naming, and thin files. Findings and a recommended
order of operations below.

## Scope, in numbers

Re-derive these before acting — they drift. As of this survey:

- **127** `*.test.ts` files, **~32.7k** lines of test code against **~40.9k**
  lines under `src/`. So in aggregate there is *less* test code than source
  (0.8:1) — the common feeling of "more test than code" is real but local, not
  global (see §1).
- **64** `tsc` errors across `tests/` + `scripts/` (up from ~40 at first
  survey — the number climbs on its own precisely because nothing type-checks
  the suite; see §2).
- Bulk is not evenly spread. **Five files carry 7.9k lines** — a quarter of the
  whole suite — and the largest single file is **2,606 lines**. All five live
  in the two over-tested modules (§1). Fixing "massive tests" means these five
  files far more than it means anything else.

Three problems get conflated under "clean up the tests." Keep them separate —
they have *different*, sometimes opposite, fixes:

1. **Distribution** (§1) — the suite is lopsided, not uniformly bloated. Two
   modules hold ~75% of all test code; several others are barely tested. "Cut
   tests" is the right move in one place and actively wrong in another.
2. **Type-safety debt** (§2–3) — invisible because CI never type-checks tests.
   Low behavior risk to fix, high risk to keep ignoring.
3. **Structural bulk** (§4) — a handful of mega-files that are hard to
   navigate, review, and edit. The lever here is *density* (same coverage, less
   code), not deleting coverage.

## 1. The distribution problem — why it *feels* like more test than code

Aggregate is 0.8:1, but the average hides everything. Per module:

| module | source | test | test:src |
|---|---:|---:|---:|
| **observer** | 7,484 | 11,788 | **1.58** |
| **workbench** | 11,788 | 12,649 | **1.07** |
| animation | 1,446 | 1,106 | 0.76 |
| templates | 1,904 | 1,318 | 0.69 |
| foundation | 3,502 | 1,893 | 0.54 |
| index | 1,051 | 416 | 0.40 |
| **tools** | 8,724 | 604 | **0.07** |
| **scraper** | 1,204 | 99 | **0.08** |

Two facts drive the "overwhelming" feeling:

- **`observer` + `workbench` are the only modules where test outweighs source,
  and together they hold ~75% of all test code while being ~47% of the source.**
  All five mega-files from §4 live in these two directories. When you're in that
  code, it genuinely *is* mostly tests — the feeling is accurate there.
- **`tools` — the second-largest module at 8.7k source lines — has 604 lines of
  test (0.07:1), and `scraper` has 99.** These aren't lean, they're
  under-covered. The suite's real shape is a barbell: heavy on two modules,
  nearly bare on the rest.

**What this means for "do better," and it's the crux:**

- The over-tested pair is the process-ownership / mutex-lease / crash-recovery
  code — genuinely hard concurrency that *does* warrant heavy characterization
  testing. So the goal there is **not** to delete coverage; it's to express the
  same coverage in far less code (the §4 consolidation: table-driven boundary
  cases, extracted fixtures, sub-grouped `describe`s). If a 2,606-line file
  becomes 1,400 lines testing the same behaviors, that's the win — not fewer
  assertions.
- A blunt "we have too many tests, trim them" mandate would do real damage to
  `tools`/`scraper`, which need *more* coverage, not less. Any cleanup ticket
  should scope itself to `observer/` + `workbench/` explicitly and say so, so
  nobody applies the wrong medicine to the thin modules.
- Before adding a single test to `tools`/`scraper`, though — that's a separate
  initiative, out of scope for a *cleanup*. Flag the gap; don't fold it into
  this work.

## 2. Why the type errors exist at all

`tsconfig.build.json` excludes `tests/**/*`, and `npm test` runs `vitest run`,
which transpiles with esbuild and never type-checks. CI (`.github/workflows/ci.yml`)
runs `protocol:check`, `lint:unused`, `build`, and `npm test` — **but never
`tsc` over `tests/`**. That's why errors accumulate silently; the count grew
from ~40 to 64 between surveys with no red build.

**Fix first, before touching any individual test:**

1. Add a script: `"typecheck": "tsc --noEmit -p tsconfig.json"` (the root
   `tsconfig.json` already `include`s `tests/**/*`, so no config change needed).
2. Add a step to `.github/workflows/ci.yml` right after `- run: npm run build`:
   `- run: npm run typecheck`.

Do this now. Without the gate, every fix below can silently regress, and this
guide will be stale again in a month.

> Note: the gate will fail red the moment you add it, because of the 64
> existing errors. Either land the gate and the section-1 fixes in the same PR,
> or add the gate as `continue-on-error: true` first, drive the count to zero,
> then flip it to blocking. Don't merge a green-looking gate that is actually
> non-blocking and forget the second half.

## 3. Current type errors

The specific file:line references below are a **point-in-time snapshot** and
will have drifted. Re-run `npx tsc --noEmit -p tsconfig.json` and treat the
output as the source of truth. The durable value here is the *taxonomy* — every
error falls into one of four clusters, ordered easiest → riskiest.

### A. Dead imports/locals (`TS6133`) — mechanical, no behavior risk

Just delete the unused identifier. At snapshot time these were in
`tests/animation/parser-agr.test.ts`, `tests/observer/artifacts.test.ts`,
`tests/observer/capture-service.test.ts`, `tests/observer/owned-runtime-manager.test.ts`,
`tests/observer/staging.test.ts`, `tests/pak/reader.test.ts`,
`tests/tools/mod-validate.test.ts`, `tests/workbench/client.test.ts`, and
`tests/workbench/status.test.ts`. `lint:unused` already runs in CI — worth
checking why it doesn't catch these (it likely only scans `src/`), and
extending its glob would prevent the whole cluster from recurring.

### B. Readonly fixture fields mutated at setup (`TS2540`) — one root cause, two files

Both places declare a field `readonly` in a fixture *type*, then assign it once
inside the factory that builds the fixture:

- `tests/observer/owned-runtime-manager.test.ts` (`terminateCalls`, `firstEntryBlocked`)
- `tests/workbench/fake-lifecycle-backend.ts` (`workbenchPids`, `endpointOwnershipCalls`, `endpointVacancyCalls`)

These aren't truly immutable — written once at construction, read thereafter.
Drop `readonly` from those five properties. Don't touch the *other* errors on
the same lines (the `verifyAndTerminate`/mock-arity mismatches) — those are
cluster C.

### C. Tests drifted from the current source shape — read the source before touching the assertion

These are the ones worth real attention: each means a test asserts against a
contract that no longer matches `src/`. **In every case, re-check the current
type/behavior in the referenced source before deciding whether to fix the test
or whether the test caught a real regression.** vitest doesn't type-check, so
these are exactly the drifts that let a test pass at runtime while silently not
exercising the real contract.

- **`owned-runtime-manager.test.ts` + `fake-lifecycle-backend.ts`** — fixtures
  override `verifyAndTerminate` with a 2-arg function, but the real port now
  has 1-arg and 2-arg overloads the override doesn't union. Call sites also
  pass `{ action }` to `MachineMutexRequest<T>`, which now also requires `name`
  and `timeoutMs`. Check `src/observer/owned-runtime-manager.ts` — likely just
  missing fields.
- **`tests/workbench/readiness.test.ts`** — every mock of `netApi.call<T>`
  returns a concrete literal instead of satisfying the generic `<T>`, and one
  return type drifted (`workbenchProtocol: "stale"` vs. the real union). Highest
  value to fix carefully: compare the test's handshake payload field-by-field
  against `CompanionReadinessOptions` in `src/workbench/readiness.ts`.
- **`tests/workbench/runner.test.ts`** — reads `.output` off a
  `WorkbenchRunnerReceipt`, but `output` lives on `WorkbenchEditorRunnerReceipt`,
  one member of a union. Add a discriminant narrow before reading it.
- **`tests/observer/protocol.test.ts`** — passes a full run-state union where
  only `"cancelled" | "completed" | "failed"` is accepted. Needs a narrower value.
- **`tests/observer/artifacts.test.ts`** — calls `.advance()` on `Clock`, which
  no longer has it (check `tests/support/manual-time.ts` — likely renamed on
  `ManualTime`).
- **`tests/observer/phase-h.test.ts`** — passes a `({ jobId }) => …` callback
  where a zero-arg `NormalizedProcedure<() => Promise<never>>` is expected.
- **`tests/workbench/observer-live-acceptance-support.test.ts`** — `privatePath`
  isn't a field of `OperationalBaselineWorkload` anymore; renamed or removed.
- **`tests/foundation/lmdb-store.test.ts`** — passes a type argument to a store
  API that dropped its generic (`Expected 0 type arguments, but got 1`).

Same `tsc` pass also surfaces errors in `scripts/run-runtime-observer-acceptance.ts`
and `scripts/run-workbench-observer-acceptance.ts` — not tests, but the gate
will flag them, so budget for them.

## 4. The oversized files — the actual bulk

Five files hold a quarter of the suite:

| file | lines | logical tests | shape |
|---|---:|---:|---|
| `tests/observer/owned-runtime-manager.test.ts` | 2,606 | 57 | one flat `describe`, 57 `it`s |
| `tests/workbench/runner.test.ts` | 1,803 | 41 | 2 `describe`s |
| `tests/observer/phase-h.test.ts` | 1,656 | 32 | 4 `describe`s |
| `tests/workbench/restart-ownership.test.ts` | 1,406 | 43 | one flat `describe` |
| `tests/observer/mailbox.test.ts` | 849 | ~5 | ~170 lines *per test* |

These exhibit two opposite smells, and they need opposite fixes. Don't apply
one rule to all five.

### Smell 1 — flat mega-`describe` (owned-runtime-manager, restart-ownership)

57 `it`s under a single top-level `describe`, with no sub-grouping, is a
navigation problem: you cannot see the file's structure without reading all
2,606 lines, and a reviewer can't tell which region a diff touches. The test
names are long behavioral sentences ("does not hold the machine mutex while
observer stop completion is pending", "retains an unpublished exact lifecycle
until a same-key retry proves child vacancy") — which is *good*, but 57 of them
in a flat list is a table of contents with no chapters.

**But first, check the source.** `src/observer/owned-runtime-manager.ts` is
**4,151 lines** — the single largest source file in the repo. A 2,606-line test
for a 4,151-line module is not obviously wrong; the test is bloated because the
*unit* is bloated. Splitting the test into five tidy files while the source
stays a 4k-line monolith just moves the mess and hides that the real problem is
the module. Note this coupling in whatever ticket you open; ideally the test
split follows a source split, not precedes it.

If splitting the test ahead of the source (a reasonable interim step), split by
behavior cluster, not by line count. The 57 `it`s already group naturally:
descriptor persistence/budgets, recovery-before-spawn, spawn + receipt
publication, mutex/lease fencing, termination + vacancy, restoration-wait
gating, PID-reuse/restart-seal. Move shared setup into a sibling
`owned-runtime-manager-fixture.ts` (the pattern already exists — see
`workbench-policy-fixture.ts`, `fake-lifecycle-backend.ts`) so the split files
share one fixture instead of copy-pasting setup. Keep the behavioral `it`
strings verbatim; only add the `describe` layer.

### Smell 2 — giant test bodies (mailbox)

`mailbox.test.ts` is the inverse: only ~5 logical tests in 849 lines, i.e.
~170 lines each. The bodies inline large literal fixtures (full command/status
objects built by hand) and, in at least one case, bundle two concerns — the
test named "supplements … Enforce writer serialization **and** idempotent
quarantine architecture checks" is two tests wearing one `it`. Fixes:

1. Extract the repeated inline literals (the `command`/`base` objects) into
   small builder helpers with per-test overrides — this alone will roughly
   halve the file.
2. Split any `it` whose name contains "and" / "supplements X with Y" into one
   assertion-focused test each, so a failure names the one thing that broke.

### Is there redundancy across the bulk? Check before assuming yes.

Names like "persists the maximum normalized descriptor produced from **512**
launch tokens" and "round-trips the **maximum-escape** launch-boundary
aggregate at **every** descriptor bound" read like exhaustive edge enumeration
— many near-identical tests varying one magic number. Where that's what they
are, a single table-driven `it.each([...])` replaces a dozen copy-pasted
bodies and *reads* as "here are the boundaries we cover." But confirm they're
genuinely varying-input-same-assertion before collapsing them; some of these
"boundary" tests actually assert different post-conditions and only *look*
parametric. Collapsing those loses coverage. This is a per-cluster judgment
call, not a mechanical pass.

## 5. File/directory naming

The `stage3-*`, `stage4-*`, `phase-h`, and `task0-*` names (and the
`cross-cutting/` directory) are literal task numbers from
`docs/plans/2026-07-19-cross-cutting-consolidation/*.md` and from an earlier
staged Workbench/Observer rewrite (`docs/AGENTS.md` still says "Stage 3"). The
`describe()` strings repeat the names, so they leak into `vitest` output too.

Fine as *plan* vocabulary — plans are dated and go stale. Not fine as permanent
test vocabulary: in six months nobody will know what "Stage 3" or "Phase H"
mean without excavating a historical plan doc.

**Rule going forward:** name a test file (and its top `describe()`) after the
module/behavior it exercises — ideally mirroring the `src/…` path — not after
the task/stage/phase that produced it. Kind-of-test suffixes (`-contract`,
`-characterization`, `-acceptance`) are fine and already used consistently
(e.g. `spawn-crash-characterization.test.ts`) because they describe the *kind*,
not the *when*.

Specific renames, from what each file's `describe()` blocks actually cover:

| current | suggested |
|---|---|
| `tests/workbench/stage3-acceptance.test.ts` | naturally splits along its 4 `describe`s (hermetic target-build, session-controller adapter trace, arbitration, child-supervision); at minimum → `hermetic-build-acceptance.test.ts`, drop "Stage 3" from each `describe()` |
| `tests/workbench/stage3-architecture.test.ts` | `module-boundaries-architecture.test.ts` (a syntax-tree check of import boundaries) |
| `tests/observer/stage4-architecture.test.ts` | `application-composition-architecture.test.ts` (asserts `server.ts` is the sole composition root) |
| `tests/observer/phase-h.test.ts` | split by its 4 `describe`s (see also §4 — it's 1,656 lines), or → `application-diagnostics-acceptance.test.ts` |
| `tests/cross-cutting/task0-characterization.test.ts` | `coordinator-baseline-characterization.test.ts` |

`tests/cross-cutting/addon-inventory.test.ts` and `packed-archive.test.ts` are
already named/described fine; the *directory* concept (integration tests
spanning modules) is legitimate — keep it. Only `task0-characterization.test.ts`
needs renaming, not the directory.

**Coupling to fix in the same commit:** `package.json` hardcodes full file
lists for `test:stage3`, `test:stage4`, and `test:cross-cutting:baseline`.
Rename without updating these and the scripts silently stop matching — they'll
pass by running fewer files. (Better still, once names mirror `src/` paths,
consider replacing the hardcoded lists with directory globs so the next rename
doesn't need a `package.json` edit at all.) Leave `docs/plans/2026-07-19-*`
references alone — dated historical record.

## 6. Thin files — the other tail of the same spectrum

"Right-sized" is a spectrum; section 4 is the fat tail, this is the thin one.
Most small files are *not* a problem — a single focused `it()` per file is fine
when the file is a shared contract, a type-level assertion, or one narrow
regression. Examples that earn their file:

- `tests/observer/capture-contract-types.test.ts` (9 lines) — one
  `expectTypeOf` tying `CaptureErrorCode` to the protocol registry. Padding it
  would dilute it.
- `tests/observer/storage-kernel-contract.test.ts` (15 lines) — runs a shared
  contract helper against two adapters; the assertions live in the helper by
  design.
- `agent-application.test.ts`, `application-operations.test.ts`, `cli.test.ts`
  — each asserts one specific invariant with real `expect()` bodies.

None reviewed looked like leftover stubs. **Do not do a mass "merge everything
under N lines" pass** — it mostly makes cohesive single-purpose files harder to
find. Merge/trim a thin file only when:

1. It duplicates an assertion a sibling already makes for the *same* `src/`
   module (real overlap, not just same directory).
2. Its `describe()`/filename references a task/stage/phase (same smell as §5 —
   usually means it was carved out during a refactor and never folded back).
3. Two+ thin files test the *same* module and would read better as one file
   with multiple `it()`s (someone opening `src/foo.ts` shouldn't guess which of
   three files has its tests).

Otherwise, leave it alone.

## 7. Suggested order of operations

Sequenced so each step is independently landable and low-risk before the risky
structural work:

1. **Land the `typecheck` gate + cluster-A/B fixes together** (§2, §3A/B). The
   gate must go green in the same PR — see the §2 note on non-blocking vs.
   blocking. Extend `lint:unused` to cover `tests/` while here so cluster A
   can't recur.
2. **Cluster C, one file at a time** (§3C), starting with the shared fixtures
   others depend on: `readiness.test.ts`, then `owned-runtime-manager.test.ts`
   / `fake-lifecycle-backend.ts`. Read the current `src/` type first — some are
   real behavioral drift, not stale typing.
3. **Renames + `package.json` script lists in one dedicated commit** (§5).
   Consider switching the scripts to globs so this is the last rename that ever
   needs a `package.json` edit.
4. **Then the bulk** (§4) — deliberately last, because it's the highest-effort,
   highest-review-cost work and benefits from the type gate already being green.
   Do `mailbox.test.ts` first (self-contained, clear win: extract builders,
   split the "and" test). For `owned-runtime-manager` / `restart-ownership`,
   open a ticket that names the source-file coupling and decide split-first vs.
   source-first before writing any code — don't reflexively shard a big test
   whose bigness is a symptom of a big module.
5. **Skip a mass thin-file cleanup** (§6); merge only where its three criteria
   actually apply.
