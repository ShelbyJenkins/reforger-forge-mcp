# Outstanding MCP Bugs

This FIFO queue contains unintended, reproducible failures of the supported
MCP contract. Append new findings at the bottom; move resolved entries to
[MCP_BUGS_RESOLVED.md](MCP_BUGS_RESOLVED.md).

## MCP-057 - existing-only Workbench LMDB inspection can crash a fresh host

**Status:** Open

**Severity:** P1 - native host termination during a supported read-only idle probe

**Observed:** 2026-08-05

**Observed behavior:** While another MCP/Workbench lifecycle had the shared
Workbench v3 LMDB environment mapped, a fresh production process calling
`WorkbenchProcessGuard.readLifecycleStateExistingOnly()` terminated with Windows
exception `0xC0000005` before the read returned. The full host idle-readiness
probe failed the same way. A production MCP host otherwise completed MCP-056
history/recovery with no blockers, committed idle shutdown at 60.02 seconds, and
then exited with that native status because the immediately preceding aggregate
readiness probe had opened the shared Workbench environment. The lifecycle and
spawn-journal reads are now serialized, eliminating same-process concurrent
opens, but a single temporary read-only open against the already-mapped live
environment remains sufficient to reproduce the exception.

**Expected contract:** Existing-only Workbench inspection must remain bounded,
noncreating, logically read-only, and fail closed on malformed, legacy,
unreadable, or racing evidence. It must return `INCOMPLETE_PROOF` or a stable
Workbench blocker instead of terminating the MCP process, and it must not
require stopping, restarting, or otherwise disturbing the active Workbench or
its owning MCP host.

**Affected areas:**
[`src/foundation/lmdb-store.ts`](../../src/foundation/lmdb-store.ts),
[`src/workbench/process-guard.ts`](../../src/workbench/process-guard.ts),
[`src/workbench/session-controller.ts`](../../src/workbench/session-controller.ts),
and aggregate MCP idle readiness on Windows.

**Evidence:** The direct existing-only process printed its pre-read marker and
then exited natively before producing a lifecycle result. A byte-exact-snapshot
MCP-056 acceptance with isolated Workbench state classified the retained
Observer snapshot, started and closed its disposable private Observer child,
committed the 60-second idle shutdown, and exited with code 0. No Workbench
process was launched, stopped, restarted, or claimed during this diagnosis.

## MCP-058 - the Windows runtime focus guard can report protection it did not prove

**Status:** Open

**Severity:** P1 - disruptive desktop focus behavior and possible mutation of an unrelated window

**Observed:** 2026-08-05

**Observed behavior:** The exact-owned graphical launch path advertises that its
default native-fullscreen launch does not steal startup focus, but the helper can
return `ok: true` after a fixed 15-second interval without observing any target
window. Protection also begins only after the target is spawned and a new
PowerShell process has parsed/JIT-compiled the helper; a fast window can activate
before any hook exists, and the helper discards the restore HWND if the target is
already foreground when protection starts. It does not reject failed
`SetWinEventHook`, `SetWindowLongPtr`, or
`SetWindowPos` calls, and success means only that the target PID does not own the
foreground at the final sample. A slow first window can therefore appear after
the helper exits and take focus. Its managed hook callback is not rooted for the
native hooks' lifetime, so garbage collection can also invalidate hook delivery
or raise at the interop boundary. The helper identifies windows only by PID,
so PID reuse during its lifetime can redirect style mutation/restoration to an
unrelated process. On each intercepted target activation, it attempts to restore
the foreground HWND captured at helper startup even if the user deliberately
switched to another application in the meantime.

**Expected contract:** Focus protection must be ready before the target can
activate, then either return bounded positive evidence that the relevant
startup-window interval was covered or fail closed.
Every native hook/style operation must be checked, window ownership must remain
bound to the exact process creation identity, and restoration must never force a
stale application over the user's newer foreground choice. The managed callback
must remain rooted until both native hooks have been removed.

**Affected areas:**
[`src/platform/windows/runtime-focus-guard.ts`](../../src/platform/windows/runtime-focus-guard.ts),
[`scripts/windows/runtime-focus-guard.ps1`](../../scripts/windows/runtime-focus-guard.ps1),
[`src/observer/owned-runtime-manager.ts`](../../src/observer/owned-runtime-manager.ts),
and the `game_launch` / `observer_runtime` `noFocus` contract.

**Evidence:** Static tracing found that hook-installation and style/position
mutation return values do not gate `ok`; `protectedWindowCount: 0` is accepted;
the local `WinEventProc` delegate is passed to two hooks without `GCHandle` or an
equivalent lifetime root; readiness can be awaited for another 60 seconds only
after the 15-second guard has returned; and existing tests cover routing/import
presence, not GC pressure, an immediate or delayed GUI, native-call failures, PID
reuse, or an `A -> B -> target` foreground sequence. This extends the failure
surface behind resolved MCP-036.

## MCP-059 - launch-planner filesystem evidence is not fully fail closed on Windows

**Status:** Open

**Severity:** P1 - concurrent replacement can escape the advertised exact-evidence boundary

**Observed:** 2026-08-05

**Observed behavior:** Both new launch planners use `O_NOFOLLOW ?? 0`; Node does
not expose `O_NOFOLLOW` on Windows, so the open follows the platform default.
Their shared `sameFile` logic also returns `true` whenever either `(dev, ino)`
pair is `(0, 0)`, converting unavailable stable identity into permission rather
than uncertainty. Normal nonzero NTFS IDs mitigate the common case, but when
stable identity is unavailable the before/open/after proof collapses to mutable
size and timestamp fields plus later path checks. Separately, uncaught
post-scan/post-read `lstatSync` calls turn precise concurrent disappearance or
access failure into generic `INTERNAL_ERROR` instead of the existing typed
`*_SCAN_UNSTABLE` / `*_CHANGED` refusals.

**Expected contract:** Missing or zero stable identity must refuse rather than
match. Windows reads that support a fail-closed claim must validate a nonzero
handle identity and final canonical path, reject reparse traversal, and perform
the evidence read through the same verified handle. Every concurrent
post-read/post-scan failure must remain inside the bounded typed launch-error
contract.

**Affected areas:**
[`src/launch/game-world-plan.ts`](../../src/launch/game-world-plan.ts),
[`src/launch/game-addon-plan.ts`](../../src/launch/game-addon-plan.ts),
[`src/launch/game-launch-errors.ts`](../../src/launch/game-launch-errors.ts),
and both launch-planner test suites.

**Evidence:** On the supported Windows host, `fs.constants.O_NOFOLLOW` is
absent. `sameFile` has an explicit zero-ID success branch in both planners.
The add-on scanner's second-phase stats and the explicit-world planner's final
project/world/meta stats are outside typed catch/mapping boundaries. Existing
coverage exercises ordinary file symlinks but has no zero-ID adapter, junction,
mount-point, hard-link replacement, or deterministic post-read race fixture.

## MCP-062 - managed client registrations discard the Node executable that setup verified

**Status:** Open

**Severity:** P2 - installed desktop registrations can fail or run a different Node version

**Observed:** 2026-08-05

**Observed behavior:** Server verification executes the compiled MCP with the
current absolute `process.execPath`, but registration passes only `serverPath`
into the client builders. Codex, Claude Code, VS Code-family, and Continue
registrations persist `command: "node"`. A GUI client with a stale or narrower
PATH can therefore fail to start the verified server, or resolve a different
unsupported Node binary.

**Expected contract:** Managed registration must persist and later compare the
same absolute Node executable that passed setup verification, or explicitly
declare ambient PATH resolution as an unsupported/manual configuration.

**Affected areas:**
[`src/setup/server-verification.ts`](../../src/setup/server-verification.ts),
[`src/setup/register-clients-cli.ts`](../../src/setup/register-clients-cli.ts),
[`src/setup/client-registration.ts`](../../src/setup/client-registration.ts),
and managed-client registration tests and guidance.

**Evidence:** All generated stdio entries and CLI registration arguments use the
literal `node`; the validated verification report records the Node version but
does not represent or carry the verified executable path into
`registerDetectedClients`.

## MCP-063 - observer-agent close marks cleanup complete before forced exit is observed

**Status:** Open

**Severity:** P2 - private-child termination and stdio cleanup are not observed before clean close

**Observed:** 2026-08-05

**Observed behavior:** After the private Observer child misses its graceful
two-second exit window, `ObserverAgentClient.closeInternal()` removes its
temporary exit waiter, calls `disconnect()` and `child.kill()`, resolves
immediately, clears the tracked child, and marks the client closed. The permanent
bookkeeping listener remains, but disposal no longer awaits it. The method
ignores a false kill return and does not await `exit` or `close`; successful
signal delivery is not the same observation as termination and stdio closure.

**Expected contract:** Ordinary cleanup must wait for exact child exit/close
under the remaining absolute shutdown deadline. A false/throwing kill or missing
termination observation must remain an explicit cleanup failure and must not be
published as a clean closed state.

**Affected areas:**
[`src/observer/agent-client.ts`](../../src/observer/agent-client.ts),
Observer application disposal, idle shutdown, and agent-client tests.

**Evidence:** The forced branch resolves in the same timer callback that calls
`child.kill()`. The test double makes `kill()` emit `exit` synchronously, so the
suite cannot distinguish signal delivery from later real-process termination.

## MCP-066 - case-sensitive Windows paths collapse launch containment and provider identity

**Status:** Open

**Severity:** P2 - supported filesystem semantics can cross an exact project/provider boundary

**Observed:** 2026-08-05

**Observed behavior:** Shared path identity lowercases every resolved Windows
path, and containment computes `relative()` between those lowercase strings.
Windows supports per-directory case sensitivity, where sibling `Foo` and `foo`
paths are distinct. A world beneath one sibling can therefore be misclassified
as contained by the other selected project, while distinct add-on roots or
manifest providers can collapse into one map entry.

**Expected contract:** Canonical project containment and provider uniqueness
must follow the actual filesystem's case semantics. If the implementation cannot
prove that relation on a case-sensitive tree, planning must return a bounded
typed refusal rather than silently applying a case-insensitive identity.

**Affected areas:**
[`src/foundation/managed-path.ts`](../../src/foundation/managed-path.ts),
[`src/workbench/project-identity.ts`](../../src/workbench/project-identity.ts),
[`src/launch/game-world-plan.ts`](../../src/launch/game-world-plan.ts),
[`src/launch/game-addon-plan.ts`](../../src/launch/game-addon-plan.ts),
and Windows launch-planner integration tests.

**Evidence:** `pathComparisonKey` and the project identity comparison key call
`toLowerCase()` unconditionally. World admission and snapshot validation use the
result for containment, while add-on root and manifest maps use it for
deduplication. The originating Commit 3 and Commit 4 plans require exact
project-contained worlds and a unique canonical target provider, and do not
exclude Windows directories with the supported case-sensitive attribute.
