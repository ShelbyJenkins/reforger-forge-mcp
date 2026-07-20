# Stage 6 deletion ledger

Revision examined: `90cd342140fa3bafd510295d1a0e1c84d0ab499c`  
Recorded: 2026-07-19 (America/Los_Angeles)  
Environment: Windows 10.0.26200.0, Node `v26.4.0`, TypeScript `5.9.3`.

The worktree was already dirty with the uncommitted Stage 1--5 implementation
when this ledger was opened. Those changes were preserved. A scoped `git diff`
therefore includes prior work in several candidate paths and cannot be used as
an attribution boundary for this Stage 6 pass. Each row lists the exact files
changed or audited here; `git diff --check` is the integrity measurement.

## Baseline

| Command | Result |
| --- | --- |
| `npm.cmd run protocol:check` | Passed; all 14 artifacts current. |
| `npm.cmd run build` | Passed; MCP and private-agent projects emitted. |
| `node scripts/list-tools.mjs` | Passed; 55 tools registered and the retired tools absent. |
| Focused Stage 6 contracts | Passed; 282 tests across Workbench lifecycle (154), foundation/staging (37), and protocol/private-agent (91) suites. |
| `npm.cmd run test:stage3 -- --retry=0` | Passed; 241 tests. |
| `npm.cmd run test:stage4 -- --retry=0` | Passed; 61 tests. |
| `npm.cmd test -- --retry=0` | Blocked by one existing failure in `tests/observer/package-contract.test.ts`: the pre-existing `.gitattributes` edit removed `* text=auto eol=lf`. This Stage 6 pass did not change that file. |
| `npm.cmd run test:package` | Incomplete: its initial production build passed, then the fresh `npm install --omit=dev` step produced no output before the outer 240-second command timeout. No package pass is claimed. |
| Stage 3/4 controlled-product evidence audit | No Stage 3 V4/two-run target-build record or full Stage 4 runtime failure-injection evidence was found. Existing operational baselines are descriptive and do not satisfy removal gates. |

## Candidate ledger

| Candidate | Invariant and replacement owner | Fault proof | Compatibility and consumer audit | Evidence gate | Diff measurement and disposition |
| --- | --- | --- | --- | --- | --- |
| `FakeLifecycleBackend` constructor alias in `tests/workbench/fake-lifecycle-backend.ts` | Exact inspection, PID-reuse fencing, owner-token refusal, termination, and mutex serialization remain owned by `FakeExactProcessBackend`; the Workbench factory adds only endpoint/CAS behavior. | `process-guard`, lifecycle, runner, restart, and termination-race tests inject mismatched creation tokens, occupied endpoints, and termination refusal. | Repository-only test API. All `new FakeLifecycleBackend(...)` consumers were migrated to `createFakeLifecycleBackend(...)`; the `FakeLifecycleBackend` type remains as the documented adapter shape. | Focused Workbench lifecycle contracts. | Scoped files: fake adapter plus six consumers. `git diff --check` clean. **Migrated:** constructor compatibility spelling deleted. |
| Camera, lifecycle, and acceptance source-text contracts | Observable camera restoration, public terminal state, exact-owner cleanup, and installed-package behavior are owned by the compiled runtime/Workbench/build acceptance paths and their behavioral contracts. | Required controlled failure matrices are not retained for every required injected fault. | Repository-only acceptance tests, but removal would weaken the current evidence posture. | Runtime and Workbench controlled compiled runs; Stage 3 two target-only plus public V4 proof. | No deletion. **Intentionally retained:** product-backed evidence gate remains unmet. |
| Staging digest compatibility exports `sha256File` / `computeBundleDigest` | Shared content-addressed algorithms are owned by `src/foundation/digest.ts` and `src/companions/content-addressed-bundle.ts`. | Content-addressed bundle tests reject digest, path, and payload mismatches; staging cleanup re-verifies a changed file by canonical content digest. | No import consumers of either staging re-export. Cleanup now calls the companion owner directly. | Managed-path, digest, JSON/CAS, and staging contracts. | Scoped file: `observer/agent/staging.ts`. `git diff --check` clean. **Deleted:** unused re-exports. |
| V3 receipts, preflight, and Workbench compatibility facade | A V4 target-only receipt and a documented V3 durable-record migration must own the remaining invariant. | The repository-only target harness rejects a second spawn/NET call, but no retained controlled two-run proof exists. | Public imports, CLI receipts, and durable journals remain live. | Stage 3 controlled target-only and final public V4 evidence. | No deletion. **Intentionally retained:** removing V3/preflight compatibility would abandon supported recovery obligations. |
| Handwritten protocol artifact registry-order assertions | `scripts/generate-protocol-artifacts.ts` and `tests/observer/protocol-artifacts.test.ts` own deterministic generation and drift detection; runtime Zod parsing remains in `tests/observer/protocol.test.ts`. | The artifact test alters/deletes generated files and observes drift before regeneration. | Repository-only duplicate equality/order test; published artifact paths remain generator-owned. | `npm.cmd run protocol:check` and protocol suites. | Scoped file: `tests/observer/protocol.test.ts`. `git diff --check` clean. **Deleted:** redundant checked-in artifact/order comparison. |
| Observer host/private composition aliases | `createObserverApplication()` is the private-agent factory; `createObserverApplication()` in `src/observer/application.ts` is the host graph factory. | Agent-application, runtime API, retention, and owned-runtime behavioral tests exercise the private application. | `createObserverAgent` had only repository test consumers and was removed. `ObserverCoordinator` is still used by host tests and controlled acceptance harnesses. | Private-child recovery plus both controlled capture paths before host facade removal. | Scoped files: `observer/agent/index.ts` and three private-agent test consumers. `git diff --check` clean. **Partially migrated:** private alias deleted; host coordinator intentionally retained pending live capture evidence. |
| Refusal-only public schemas/tests | The real registration path and `scripts/list-tools.mjs` own absence of `wb_play`, `wb_save`, and `wb_execute_action`; direct-handler safety refusals remain behaviorally owned by supported tools. | Tool inventory would fail if a retired tool reappeared. | No stale registered tool or removed build-only schema was found. Surviving safety tests protect live paths. | Tool inventory and full suite. | No code deletion. **Already absent / intentional behavioral coverage.** |
| Separate observer TypeScript build | `tsconfig.shared.build.json` compiles shared foundation/companions once; `observer/tsconfig.build.json` emits the private agent leaf. | A clean build verifies the two project references; package smoke must exercise both advertised binaries. | `build:observer` remains the only leaf emitter for `dist/observer/agent/**`. | Clean build and installed-tarball package smoke. | No deletion. **Intentional leaf build:** compilation is not yet unified. |

## Review commands for this boundary

```text
git diff --stat -- tests/workbench/fake-lifecycle-backend.ts tests/workbench/activity-gate.test.ts tests/workbench/process-guard.test.ts tests/workbench/restart-ownership.test.ts tests/workbench/runner.test.ts tests/workbench/spawn-crash-characterization.test.ts tests/workbench/termination-identity-race.test.ts observer/agent/staging.ts observer/agent/index.ts tests/observer/owned-runtime-manager.test.ts tests/observer/retention.test.ts tests/observer/runtime-api.test.ts tests/observer/protocol.test.ts docs/validation/2026-07-19-stage-6-deletion-ledger.md
git diff --numstat -- <same scoped paths>
git diff --check
git diff -- <same scoped paths>
```

The first two commands are retained as review artifacts rather than line-count
targets. Their output includes pre-existing uncommitted work in this checkout.
At closeout, the scoped tracked-file measurement was 1,122 insertions and 719
deletions across 13 files; the new ledger is untracked and therefore omitted by
`git diff`. These counts include the pre-existing Stage 1--5 changes noted
above and are not attributed to Stage 6.
