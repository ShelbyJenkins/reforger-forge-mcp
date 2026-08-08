# Outstanding MCP Issues

This FIFO queue contains open contract decisions, acknowledged limitations, and
deferred improvements that are not currently a broken supported behavior.
Append new findings at the bottom; move resolved or verified records to
[MCP_ISSUES_RESOLVED.md](MCP_ISSUES_RESOLVED.md).

## MCP-068 - successor chains retain fail-closed recovery hardening gaps

**Status:** Open

**Priority:** P2 - crash recovery and long-lived profile reuse

**Observed:** 2026-08-06

**Observed behavior:** MCP-061 now provides the ordinary exact-owned
start → stop → successor workflow with a durable profile chain. Same-manager
pre-runtime recovery can resume an exact `reserved` attempt and can replace an
unrecorded preparation only after a durable `revocation_pending` state and an
explicit proof-bearing `aborted` transition. The more advanced recovery
branches from the retained Commit 9 plan remain deliberately fail closed:
prior-manager reserved or revocation-pending attempts are not adopted after an
Observer/MCP restart, legacy Commit-7 evidence is not adopted into a chain, and
a terminal chain tip is retained indefinitely within the configured store caps
instead of retiring the complete family atomically. The exhaustive injected
restart/crash-window matrix and live Windows successor gate are also
outstanding.

**Decision needed:** Implement proof-bearing prior-manager adoption or recovery,
unambiguous legacy evidence adoption, and bounded atomic whole-family retirement
without ever converting missing or unknown evidence into launch permission.
Complete the restart/crash-window and live successor gates.

**Affected areas:**
[`src/observer/owned-runtime-manager.ts`](../../src/observer/owned-runtime-manager.ts),
[`src/tools/game-launch.ts`](../../src/tools/game-launch.ts), retained-chain
storage accounting/reconciliation, and successor recovery acceptance tests.

**Evidence:** Current focused coverage proves initial/successor retries, one
fenced successor after exact stop, same-manager resume of the original
preparation key, proof-bearing revocation/abort/replacement, and predecessor
proof retention for an aborted successor. False, thrown, crashed, lease-lost,
or prior-manager cleanup remains recovery-pinned; legacy-without-ledger and
lost-outcome states still return `RECOVERY_REQUIRED`. Sweep protects evidence
needed by the active chain but has no atomic family-retirement transition.

## MCP-069 - executable re-attestation does not pin the file through ownership publication

**Status:** Open

**Priority:** P2 - hostile replacement resistance at the owned-runtime spawn boundary

**Observed:** 2026-08-06

**Observed behavior:** MCP-067 moves bounded executable hashing to an isolated
worker and performs a second attestation only after the spawned process's exact
identity is durable. The worker closes its file handle before the manager
retains the Observer lifecycle and publishes the ownership receipt. A narrow
check → retain → publish interval therefore remains in which the executable's
path can be replaced. Exact PID/path/creation identity, owner-token evidence,
and cleanup recovery remain durable, but the implementation does not provide a
same-handle proof spanning process creation through publication.

**Decision needed:** Either retain a non-replaceable Windows file handle across
the spawn/publication transaction or attest the loaded process image's stable
volume/file identity from the exact process handle. Define the required
sharing/delete semantics, recovery behavior, and package boundary before
advertising a strict hostile-filesystem no-TOCTOU guarantee.

**Affected areas:**
[`src/observer/owned-runtime-manager.ts`](../../src/observer/owned-runtime-manager.ts),
[`src/launch/game-launch-revalidation-isolation.ts`](../../src/launch/game-launch-revalidation-isolation.ts),
the Windows exact-process backend, and owned-runtime spawn-publication tests.

**Evidence:** The post-spawn hook runs after the `identity_verified` journal
state and detects replacements that occur before its read. Its worker-owned
handle is terminated and closed before lifecycle retention and runtime-receipt
publication, so current tests prove pre/post replacement detection and exact
cleanup authority, not a handle continuously pinning the executable file.

## MCP-070 - foreground-triggered Workbench reload can observe partial script edits and crash

**Status:** Open

**Priority:** P1 - attended editor data safety and script-edit reliability

**Observed:** 2026-08-06

**Observed behavior:** An MCP-owned World Editor session rescans externally
modified scripts when Workbench regains focus. A multi-part edit to one Game
script was observed between writes: the reload saw a new function call before
the later function definition had reached disk. Game-script compilation failed,
Workbench attempted to reload the open world with the Game module unavailable,
and then terminated with an access violation. The crash left the MCP transport
closed and its durable Workbench lifecycle reporting `running` after the exact
Workbench process and NET API endpoint were gone.

**Decision needed:** Define a supported coordination boundary for script edits
while an MCP-owned editor is live. At minimum, prevent MCP-authored incremental
writes from exposing intermediate file states to Workbench, and recover a
provably exited editor lifecycle after this failure. Determine whether focus-
triggered reload can be suppressed, debounced until files are stable, or must
instead require an explicit stop/restart workflow for script mutations.

**Affected areas:** Workbench script-edit/write tools, editor lifecycle recovery,
external-change detection, and attended World Editor reload behavior.

**Evidence:** The attributed editor log records `Reloading game scripts` at
20:33:59, an undefined function from the intermediate file at 20:34:04, world
loading with unknown Game classes immediately afterward, and a native access
violation at 20:34:07. The completed file on disk contained the missing code.
