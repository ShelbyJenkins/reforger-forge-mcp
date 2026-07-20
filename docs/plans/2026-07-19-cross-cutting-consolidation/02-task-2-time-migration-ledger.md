# Task 2 time migration ledger

`src/foundation/time.ts` owns the ordinary wall-clock primitives: validated
timer duration, absolute deadline creation/derivation, remaining budget,
cancellable delay, and immediate-probe polling. Domain code still maps expiry,
cancellation, and failed probes to its own public result or error.

| Owner | Decision | Reason |
| --- | --- | --- |
| `observer/agent/artifacts.ts` stable-file check | Migrate | Local filesystem stability polling has no durable retry authority. Expiry still maps to `ARTIFACT_INCOMPLETE`. |
| `scripts/run-workbench-build-acceptance.ts` log attribution | Migrate | Repository-only, ordinary owner-token log discovery; evidence and attribution checks remain local. |
| `scripts/run-workbench-observer-acceptance.ts` capability/job discovery | Migrate | Repository-only ordinary polling; capture evidence validation and diagnostics remain local. |
| `src/workbench/process-guard.ts` spawned-process inspection | Migrate | Repeated exact inspection is ordinary delay; identity validation and failure classification remain local. |
| `src/workbench/runner.ts` log attribution | Migrate | Ordinary log discovery; the runner retains `LOG_ATTRIBUTION_FAILED` and parent build deadline policy. |
| `src/workbench/readiness.ts` retry arithmetic | Specialized adapter | Its delay must race child exit/error and abort. The existing timing seam remains the delay owner while shared validation and remaining-deadline arithmetic are used. |
| `src/observer/owned-runtime-manager.ts` exact-child inspection / child-exit settle | Specialized adapter | These ordinary local waits use the injected shared sleeper. Persisted expiry, fences, recovery files, stop authority, and public `OwnedRuntimeError` mapping remain local. |
| `observer/agent/mailbox-coordinator.ts` | Retain | `pollOnce` is externally scheduled mailbox processing, not a delayed retry loop. It owns cursor and durable mailbox ordering. |
| `src/observer/capture-service.ts` | Retain | Capture polling is bound to persisted job state, cancellation, restoration, and periodic sweeping. |
| `src/foundation/reservation-gate.ts` | Retain | Durable idempotent-reservation retry ordering is intentionally distinct from generic polling. |
| `src/workbench/lifecycle-execution.ts` | Retain | Exit/control and absence races protect durable lifecycle publication and recovery state. |
| `src/observer/agent-client.ts`, `src/workbench/net-api-client.ts`, `src/observer/workbench-capture-backend.ts` | Retain | These timers bound socket/IPC request lifetimes, not ordinary polling. |
| `src/workbench/activity-gate.ts`, `src/foundation/child-supervisor.ts`, observer/capture sweep intervals | Retain | These are reservation, supervision, or maintenance scheduling owners. |
| operational-baseline helpers | Retain | Measurements intentionally use their existing monotonic/performance semantics. |

The post-migration timer inventory is intentionally limited to the retained
specialized owners above plus tests and live-only acceptance code. New ordinary
polls should use the foundation or add a reviewed row here explaining why their
ordering cannot do so.

Validation completed: focused foundation/artifact/readiness/process-guard/
runner/owned-runtime suites, `npm run build`, cross-cutting baseline, Stage 3,
Stage 4, full `npm test`, and the packed `--omit=dev` smoke test. Controlled
live Workbench and observer acceptance remain skipped because no configured
live environment is available.
