# Task 6 test-support migration ledger

Research snapshot: 2026-07-20, after the completed support-layer migration.

Task 6 now has one owner for callback-scoped temporary directories, manual
time, polling, and observer fixtures. `tests/observer/helpers.ts` has been
deleted. The remaining direct temporary-directory allocations are listed
individually below; they are foundation-boundary or native/process-sensitive
fixtures, not alternate ordinary test-support owners.

## Migrated ordinary setup

| File and test area | Replacement / reason |
| --- | --- |
| `tests/companions/content-addressed-bundle.test.ts` | `withTemporaryDirectory`; descriptor-race reset runs in the callback finally block |
| `tests/observer/agent-application.test.ts`, `application.test.ts`, `application-operations.test.ts`, `cli.test.ts`, `evidence-bundle-service.test.ts`, `paths.test.ts`, `launch-arguments.test.ts`, `staging.test.ts`, `workbench-regression.test.ts`, `sessions-recovery.test.ts`, `runtime-api.test.ts` | callback-scoped roots with explicit application/server closure where required |
| `tests/observer/artifacts.test.ts` | callback-scoped roots plus `createObserverSessionFixture`, `ManualTime`, and registration owner |
| `tests/observer/jobs.test.ts` | callback-scoped roots plus shared observer fixtures; adopts `waitForValue` with `ManualTime` |
| `tests/observer/mailbox.test.ts` | every mailbox case owns its callback-scoped root; intermediate-file assertions remain inside the scope |
| `tests/observer/retention.test.ts` | every retention case owns its callback-scoped root; lifecycle assertions remain unchanged |
| `tests/observer/runs.test.ts` | every run/evidence case owns its callback-scoped root |
| `tests/observer/registry.test.ts` | callback-scoped roots plus shared observer fixtures and `ManualTime` |
| `tests/observer/private-child-owned-runtime-recovery.test.ts` | callback-scoped root with application close in the callback finally block; native child timing remains local |
| `tests/observer/enforce-contract-validator.test.ts`, `protocol-artifacts.test.ts` | callback-scoped cloned/generated artifact roots |
| `tests/cross-cutting/packed-archive.test.ts` | callback-scoped archive roots; archive builders receive the owning root explicitly |
| `tests/workbench/launch-args.test.ts`, `project-identity.test.ts`, `workbench-launch-plan.test.ts` | callback-scoped ordinary Workbench roots |
| `tests/workbench/helper-addon.test.ts` | callback-scoped helper staging/project roots |
| `tests/workbench/build-acceptance-contract.test.ts` | callback-scoped injected build-acceptance harness and output-proof roots |
| `tests/workbench/observer-adapter.test.ts` | callback-scoped fake observer client/profile roots |
| `tests/observer/phase-h.test.ts`, idle-diagnostics case | callback-scoped parent root while preserving the assertion that managed storage is never created |

## Exhaustive remaining direct `mkdtempSync` inventory

Each row is one remaining direct allocation found by `rg -n 'mkdtempSync?\\(' tests -g '*.ts'`.

| Call site | Disposition | Why it remains direct |
| --- | --- | --- |
| `tests/foundation/json-store-contract.ts:62` | retain | Foundation contract helper exercises direct JSON-store path creation and cleanup |
| `tests/foundation/digest.test.ts:15` | retain | Digest boundary test owns a direct source root |
| `tests/foundation/digest.test.ts:24` | retain | Digest boundary test owns a second direct source root |
| `tests/foundation/json-store.test.ts:41` | retain | JSON-store foundation test mutates the direct storage path |
| `tests/foundation/managed-path.test.ts:26` | retain | Managed-path foundation helper is the direct path boundary under test |
| `tests/workbench/activity-gate.test.ts:343` | retain | Fake Workbench lifecycle harness characterizes lock, identity, restoration, and exact-child behavior |
| `tests/workbench/integration/live-lifecycle-acceptance.test.ts:127` | retain | Supported live Workbench process acceptance root |
| `tests/workbench/integration/live-lifecycle-acceptance.test.ts:128` | retain | Supported live companion-helper process root |
| `tests/workbench/multiprocess-lifecycle.test.ts:81` | retain | Real multi-process Node worker state root |
| `tests/workbench/lifecycle-helper-timeout.test.ts:27` | retain | Native PowerShell lifecycle-helper script root |
| `tests/observer/owned-runtime-exit-reconciliation.test.ts:180` | retain | Owned-runtime process-exit reconciliation fixture |
| `tests/observer/owned-runtime-manager.test.ts:474` | retain | Owned-runtime harness fallback when a lifecycle test intentionally omits an injected root |
| `tests/observer/owned-runtime-manager.test.ts:765` | retain | Owned-runtime agent-lease lifecycle case |
| `tests/observer/owned-runtime-manager.test.ts:918` | retain | Owned-runtime crash-recovery lifecycle case |
| `tests/observer/owned-runtime-manager.test.ts:2324` | retain | Owned-runtime link/authority lifecycle case |
| `tests/workbench/process-guard.test.ts:27` | retain | Process-guard lifecycle state and lock boundary helper |
| `tests/observer/owned-runtime-spawn-crash-characterization.test.ts:235` | retain | Native spawn/crash characterization root |
| `tests/observer/owned-runtime-spawn-crash-characterization.test.ts:236` | retain | Native spawn/crash snapshot-managed-root fixture |
| `tests/observer/integration/owned-runtime-windows.test.ts:40` | retain | Supported Windows owned-runtime process integration |
| `tests/workbench/project-launcher-safety.test.ts:171` | retain | Real global-mutex lifecycle case |
| `tests/workbench/project-launcher-safety.test.ts:280` | retain | Native owner-process termination case |
| `tests/workbench/restart-ownership.test.ts:97` | retain | Restart/ownership lifecycle harness with exact process guard behavior |
| `tests/workbench/runner.test.ts:78` | retain | Child-supervisor and runner lifecycle harness |
| `tests/workbench/spawn-crash-characterization.test.ts:126` | retain | Native Workbench spawn-crash characterization harness |
| `tests/workbench/termination-identity-race.test.ts:16` | retain | Exact process identity race fixture |
| `tests/workbench/workbench-policy-fixture.ts:210` | retain | Stage 3 authoritative policy/lifecycle fixture; not a generic support owner |

## Polling and time adoption

`tests/support/wait.ts` delegates exactly once to `pollUntil`. The migrated
jobs suite uses `waitForValue` with `ManualTime`; support tests cover success,
expiry, probe failure, and cancellation. `vi.waitFor`, child-process delays,
socket waits, and native lifecycle timing remain in their owning suites.
