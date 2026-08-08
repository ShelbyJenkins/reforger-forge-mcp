# Launch ergonomics adversarial review

> **Project overview:** [Launch ergonomics](README.md).
>
> **Scope:** the delivered work in this directory — the foundation, commits 1-8,
> 13-15, and MCP-056. Commits 9-12 are deferred and were reviewed only for the
> forward obligations they leave behind.
>
> **Date:** 2026-08-05. **Basis:** the numbered-series diff
> `977961d..4f64515` contains 183 files / 17,298 insertions overall and 145 files /
> 16,468 insertions under `src`, `scripts`, `observer`, and `tests`. The Option A
> foundation at `ce0f915` was inspected separately because it is an ancestor of
> `977961d` and therefore cannot appear in that diff.
>
> **Posture:** this document is deliberately adversarial. It assumes the
> implementation notes and status table in `README.md` are advocacy and tries to
> falsify them. Findings are ordered by consequence, not by commit. The extended
> pass applies a desktop-release bar: responsive, repeatable, exact-process,
> cancellation-aware, diagnosable behavior on supported Windows systems.

## Phased implementation matrix

This matrix expands the [recommended order of work](#recommended-order-of-work).
Execute phases and rows from top to bottom except where a task is explicitly
blocked or deferred. This is a live implementation ledger; statuses below were
last updated on 2026-08-06 and should move with implementation and validation.

| Status | Order | Phase | Task | Relevant section |
|---|---:|---|---|---|
| Implemented — pre-bind focus proof and headless A→B, destroyed/reused HWND, and stale-generation PID scenarios pass; the attended immediate/delayed USER32 gate remains opt-in | 1 | 1 — Launch safety | Close the `MCP-058` Windows focus transaction: prove protection before activation, retain exact process identity, preserve the user's latest foreground choice, and add immediate/delayed real-GUI fixtures. | [H2](#h2), [M7](#m7), [M8](#m8) |
| Implemented — the native boundary proves final path/full identity/stable same-handle bytes and path re-open; 19 core plus 34 planner tests, isolated starts, and a fresh packed-install helper smoke pass; `MCP-059` is resolved | 2 | 1 — Launch safety | Establish the `MCP-059` same-handle Windows file-identity boundary and fail closed on zero or unavailable identity and reparse traversal. | [H3](#h3) |
| Implemented — typed late-failure and deterministic race suites pass | 3 | 1 — Launch safety | Map late planner scan/stat failures to typed refusals and add deterministic race, metadata, manifest, cap, and replacement tests. | [H1](#h1) |
| Implemented — exact canonical case is preserved; focused containment/provider tests pass | 4 | 1 — Launch safety | Preserve case-sensitive Windows containment and provider identity, or return a typed unsupported-filesystem refusal. | [M2](#m2) |
| Implemented — one admitted/coalesced start owns the raw Workbench hint plus all initial, baseline, pre-spawn, and post-spawn evidence workers under one absolute deadline/cap; cancellation, equal retry, kill/terminate refusal, lease loss, and the final spawn fence retain admission until exact physical close/exit; 97/97 focused and launch tests, typecheck, clean build, package contract, and fresh packed-install smoke pass; `MCP-067` is resolved | 5 | 1 — Launch safety | Move planning behind bounded admission and early coalescing, off the event loop, with elapsed deadlines, an executable-byte cap, cancellation, and latency tests. | [M6](#m6) |
| Implemented as scoped — durable successor and pre-runtime reserved/revocation/abort proofs pass 14 focused recovery tests and typecheck; prior-manager adoption, family retirement, and live crash-window gates remain fail-closed under `MCP-068` | 6 | 1 — Launch safety | Implement fenced durable successor generations for same-root start → stop → start; until then, expose the one-generation limitation and recovery path machine-readably. | [H4](#h4) |
| Implemented — exact exit plus stdio close remains pending through delayed exit and true/false/throwing kill paths; 12/12 shutdown tests pass | 7 | 2 — Host lifecycle | Keep private-child shutdown pending until exact exit/close evidence is observed under the remaining absolute deadline, including delayed and failed kills. | [M10](#m10) |
| Implemented — absolute Node registration/drift/receipt behavior passes spaces, Unicode, empty/conflicting `PATH`, and the 112-test setup group | 8 | 2 — Host lifecycle | Persist the verified absolute Node executable in managed registrations and include it in drift checks and receipts. | [M9](#m9) |
| Implemented — a zero-seeded stdio clock and every provider share one monotonic sample; the 132-test readiness group passes | 9 | 2 — Host lifecycle | Thread one injected monotonic clock through the readiness inspector and every provider; prove it with a fake clock starting at zero. | [M1](#m1) |
| Implemented — the exact default serial command passed in 426 seconds: 264 files and 2,393 tests passed, with one opt-in attended-focus file and its three tests skipped; the explicit unowned-Workbench precondition contract remains enforced | 10 | 3 — Reproducible acceptance | Make the default test command reproduce the claimed suite, including serial lifecycle handling and an explicit unowned-Workbench precondition. | [P1](#p1) |
| Implemented — `MCP-057` resolved with exact child-close containment; 107 focused and 373 Stage 3 tests, build, package, and live-writer smoke pass; exact default-root gate deferred while an unowned attended Workbench is active | 11 | 3 — Reproducible acceptance | Resolve the live-root LMDB crash, then run and precisely label the exact default-root MCP-056 gate. | [P3](#p3) |
| Implemented — composite consumed-launch remedy tests pass | 12 | 4 — Contract coherence | Extend the `PREPARED_LAUNCH_CONSUMED` remedy to `game_launch`. | [M3](#m3) |
| Implemented — fixed readiness warnings and bounded projected errors are separate; the integrated 56-test launch suite passes | 13 | 4 — Contract coherence | Separate the fixed readiness warning from the bounded projected readiness error. | [M4](#m4) |
| Implemented — privileged cleanup is counted, proof-invalidating, and readiness-visible | 14 | 4 — Contract coherence | Make privileged cleanup observable and enforced, or rename it as a marker and constrain its call sites architecturally. | [M5](#m5) |
| Implemented — readiness projection receives the validated session ID and agrees with structured `next`; the integrated 56-test launch suite passes | 15 | 4 — Contract coherence | Pass the validated session ID into readiness-failure projection and assert agreement with structured `next`. | [L11](#l11) |
| Implemented — `tools/list` publishes the exact three-branch action-discriminated `oneOf` through a public Zod 4 object adapter; SDK runtime validation, matching structured/text payloads, 16/16 schema round-trip tests, and 56/56 launch tests pass | 16 | 5 — MCP API compatibility | Add a discriminated `game_launch` success schema, matching `structuredContent` and text, property descriptions, and structure-based tests. | [P4](#p4) |
| Implemented as scoped — interim claim narrowed to tested 2025-era stdio; black-box initialization passes and `MCP-064` is resolved; a v2 dual-era migration is a separate upgrade | 17 | 5 — MCP API compatibility | Declare and test supported MCP protocol eras by narrowing the compatibility claim or migrating and testing both openings. | [P5](#p5) |
| Implemented — saturation/deduplication regression passes | 18 | 6 — Low-risk cleanup | Preserve diagnosed blocker categories when the bounded blocker set saturates. | [L1](#l1) |
| Implemented — `REQUEST_ACTIVE` makes dormant unsettled work visible | 19 | 6 — Low-risk cleanup | Make dormant monitoring caused by a never-settled request diagnostically visible. | [L2](#l2) |
| Implemented — eager-scheduler dispatch-order regression passes | 20 | 6 — Low-risk cleanup | Schedule dispatch-turn release after forwarding `onmessage` and cover an eager injected scheduler. | [L3](#l3) |
| Implemented — raw invariant integer validation rejects decimal PowerShell input | 21 | 6 — Low-risk cleanup | Reject decimal `-McpIdleShutdownMs` values before PowerShell coercion. | [L4](#l4) |
| Implemented — server composition now narrows the required runtime manager once | 22 | 6 — Low-risk cleanup | Resolve the contradictory `ownedRuntimeManager` nullability assumptions. | [L5](#l5) |
| Implemented — host, Workbench, and runtime-manager nil-UUID fences pass | 23 | 6 — Low-risk cleanup | Reject nil UUIDs at injected host and manager identity fences. | [L6](#l6) |
| Implemented — ambiguous-target remedy now reports multiple matches | 24 | 6 — Low-risk cleanup | Give `AMBIGUOUS_TARGET` a context-correct remedy reason. | [L7](#l7) |
| Implemented — public `history`/`recover`, standalone-client `runtimeKind`, and foreign-evidence idle semantics pass a 15-test docs/schema contract; `MCP-065` is resolved | 25 | 6 — Low-risk cleanup | Document `history`/`recover`, clarify or rename standalone `runtimeKind`, and correct foreign-evidence idle semantics. | [L8](#l8), [L9](#l9), [L10](#l10) |
| Implemented — dead `EXTERNAL_ACTIVATION` member excluded until its deferred producer ships | 26 | 6 — Low-risk cleanup | Add the `EXTERNAL_ACTIVATION` producer with Commit 12, or exclude the dead member from current blocker bounds until then. | [P2](#p2) |
| In progress — automated acceptance is green (264 files/2,393 tests, typecheck, build, offline package, unused-code, protocol, manifest, and diff checks); one opt-in USER32 file/three tests and the exact active-default-root gate remain explicitly deferred while their attended/live-host preconditions are unsafe | 27 | 7 — Final acceptance | Run the complete desktop black-box acceptance suite after its implementation and safety prerequisites close. | [Desktop-grade acceptance bar](#desktop-grade-acceptance-bar) |

### Live completion queue

This lists only unfinished or deferred work. Completed evidence remains in the
phased implementation matrix and issue trackers above. It is refreshed whenever
a gate changes state; the latest refresh is **2026-08-06 13:58 PDT**.

| Status | Queue | Parent row | Current work and evidence | Completion condition / next transition |
|---|---:|---:|---|---|
| Deferred — attended | 1 | 1, 27 | Immediate/delayed real-GUI USER32 focus acceptance requires an attended desktop and deliberate focus changes. Headless A→B, destroyed/reused HWND, and stale-PID-generation cases already pass. | Run only in an attended session, then record the artifact/result; do not synthesize focus changes in an unattended host. |
| Deferred — live-host precondition | 2 | 11, 27 | The exact active-default-root MCP-056/LMDB gate is unsafe while an unowned attended Workbench/live host is using that root; isolated-root and live-writer containment already pass. | Re-run only after the root is proven unowned and vacant, without killing or adopting the existing host. |
| Deferred — non-blocking follow-up | 3 | 5, 6 | `MCP-068` retains advanced prior-manager successor adoption/family retirement work; `MCP-069` retains hostile executable-image pinning across publication. Both stay fail closed and are not being silently folded into current row closure. | Separate implementation plans and live crash/hostile-filesystem gates. |

## Review basis and primary sources

The source trace covered the project overview, all plans 01-15, MCP-056, the
historical `MCP Lifecycle Option A Implementation Plan` recovered from
`ce0f915^`, the earlier `2026-07-28-mcp-api-contract-follow-up.md`, and the
current `README.md`, `SETUP.md`, `docs/observer.md`, `observer/README.md`, and
`agents/AGENTS.md`. Code claims were traced through the implementation and
tests, including paths outside the series diff when a new call site depended on
older lifecycle or setup code.

The external contract was checked against primary sources rather than plan
paraphrases:

| Area | Primary source | What it establishes here |
|---|---|---|
| Reforger resource identity | Bohemia's [Workbench Metadata](https://community.bistudio.com/wiki/Arma_Reforger%3AWorkbench_Metadata) | `.meta` carries the engine GUID; its recorded path is informational, and a Workbench move/rename retains the GUID. |
| Add-on closure | Bohemia's [Resource Manager options](https://community.bistudio.com/wiki/Arma_Reforger%3AResource_Manager%3A_Options) | Every dependency must be present in an `addonsDir` search root or startup can fall back/fail. |
| Runtime argv | Bohemia's [Startup Parameters](https://community.bistudio.com/wiki/Arma_Reforger%3AStartup_Parameters) and [Server Config](https://community.bistudio.com/wiki/Arma_Reforger%3AServer_Config) | `-server <world>` starts a local server; `-client` is a replication-client switch; `-addons`/`-addonsDir` have distinct list contracts; `scenarioId` belongs to server configuration rather than this graphical argv. |
| Windows file/process identity | Microsoft [FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info), [Win32_Process](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process), [case sensitivity](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity), and [reparse-point-aware I/O guidance](https://learn.microsoft.com/en-us/dotnet/api/microsoft.visualstudio.utilities.internal.reparsepointaware?view=visualstudiosdk-2022) | Stable identity is volume plus file ID; PID alone is reusable; Windows directories can be case-sensitive; path verification followed by another path operation is not a same-handle TOCTOU proof. |
| Desktop responsiveness and child lifecycle | Microsoft [Preventing Hangs](https://learn.microsoft.com/en-us/windows/win32/win7appqual/preventing-hangs-in-windows-applications), Node [File system](https://nodejs.org/api/fs.html), and Node [Child process](https://nodejs.org/api/child_process.html) | Long/blocking I/O belongs off the event thread with cancellation; Node's synchronous filesystem APIs block further JavaScript; sending a child signal is not proof of exit. |
| MCP tool and protocol contract | MCP [Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) and the official TypeScript SDK [2026-07-28 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md) | `outputSchema`/`structuredContent` are the typed result path; a directly connected legacy `McpServer`/`StdioServerTransport` serves only the 2025-era protocol. |

## What was verified independently

Every implementation claim below was checked against the code rather than
accepted from the plans; product-contract and validation-record claims were
also checked against their originating guides and primary external sources:

- `npm run typecheck` passes.
- `npm test` was executed on this branch. Result: **2 failed files / 2 failed
  tests of 2,280**, 249 files passing, 1 skipped. See [P1](#p1) — the two
  failures are test-infrastructure defects, not regressions from this series,
  but they show that the default command and currently allowed machine state
  cannot reproduce the recorded serial result as written.
- The two failing files were re-run serially to separate flakes from
  reproducible failures.
- The `UNOWNED_WORKBENCH` refusal behind the `multiprocess-lifecycle` failure was
  reproduced directly by driving `tests/workbench/fixtures/lifecycle-owner-worker.ts`
  outside vitest.
- Produced-versus-asserted error codes were diffed for both launch planners.
- After the extended source/Windows pass, typecheck was rerun and 8 safe focused
  files passed **137/137 tests**: both launch planners, `game_launch`, private
  agent close, owned-runtime spawn/focus routing, the runtime live-acceptance
  *contract* test, managed client registration, and MCP stdio composition. No
  Workbench or game process was launched.

## Summary judgement

The redaction boundary, seal transaction, argv builder, pre-consumption
revocation rule, host-argument partition, and existing-only Observer storage
inspection still hold up. Several are correct in the non-obvious way the plans
demanded. The [what holds up](#what-holds-up-under-attack) section records that
evidence because a defect-only review would misstate the risk.

The original conclusion was nevertheless too lenient for a desktop release.
The extended Windows pass found that the startup-focus helper can claim success
without proving it covered startup ([H2](#h2)); the planners' file-identity
fallback is permissive exactly when identity is unavailable ([H3](#h3)); and the
primary launch action intentionally cannot perform an ordinary stop/relaunch
cycle without a fresh root or the deferred successor design ([H4](#h4)). In
addition, [H1](#h1) is an explicit failed acceptance gate, not merely optional
test hardening, and static inspection found actual raw-error holes behind it.
The same path audit found that officially supported case-sensitive Windows
directories defeat lowercase containment and provider identity ([M2](#m2)).

The delivered work can still be described as a bounded one-generation
engineering baseline under ordinary case-insensitive NTFS assumptions, but not
as a finished desktop launcher. Desktop release should block
on [H1](#h1)-[H4](#h4), [M2](#m2), **and** the event-loop, focus-ownership,
registration, and child-exit gaps in [M6](#m6)-[M10](#m10). No review evidence supports a
generic shell-injection path, arbitrary game/Workbench termination, or a break
in the observer redaction boundary.

---

## High

### H1

**No test deterministically exercises the fail-closed scan races or asserts
several metadata-refusal branches in either launch planner.**

`src/launch/game-world-plan.ts` (1,037 lines) and `src/launch/game-addon-plan.ts`
(1,156 lines) are the most safety-relevant new modules in the series: they are
the only things standing between a caller-supplied path and a spawned game
process. Both plans made bounded, fail-closed scanning an explicit acceptance
criterion. Commit 3 required coverage of "every discovery cap and concurrent
replacement"; Commit 4 required "oversize manifests, entry/candidate limits, and
concurrent change".

Diffing the error codes each module *produces* against the codes its suite
*asserts*:

| Module | Produced but never asserted exactly in its planner suite |
|---|---|
| `game-world-plan.ts` | `WORLD_SCAN_UNSTABLE`, `WORLD_INVALID`, `WORLD_METADATA_MISSING`, `WORLD_METADATA_UNREADABLE`, `PROJECT_CHANGED` |
| `game-addon-plan.ts` | `ADDON_SCAN_UNSTABLE`, `ADDON_MANIFEST_MALFORMED`, `ADDON_MANIFEST_UNREADABLE` |

`*_SCAN_UNSTABLE` is the concurrent-modification refusal in both files — the
branch that fires when a directory's identity or listing digest changes between
the pre-scan and post-scan `lstat`. It is reached only under a race. That is
precisely why it needs a deterministic test: ordinary use, CI, or live
acceptance cannot be relied on to exercise and identify it without a controlled
race, and an inverted comparison or a
digest computed over the wrong value would leave every existing test green while
silently converting the fail-closed guarantee into a no-op.

The same argument applies to `WORLD_METADATA_MISSING` / `_UNREADABLE`, which is
the difference between "this world has no sidecar and must be registered" and
"this world's sidecar could not be read, so do not launch it".

`tests/launch/game-addon-plan.test.ts` is 7 tests and 15 assertions for 1,156
lines. `tests/launch/game-world-plan.test.ts` is denser (47 assertions) and does
cover ordinary file-symlink containment, but still omits the five codes above
and the Windows identity cases in [H3](#h3).

Static inspection also found race exits that cannot currently produce the typed
code the plans promise. `game-addon-plan.ts:555-573` performs second-phase
`lstatSync` calls after a stable directory read without catching them, and
`game-world-plan.ts:544-553` does the same for the final project/world/metadata
stats. Deletion, access loss, or replacement in those windows escapes as raw
`ENOENT`/`EACCES`; `gameLaunchToolError` treats it as unknown and returns the fixed
generic `INTERNAL_ERROR`, not `ADDON_SCAN_UNSTABLE` or `WORLD_CHANGED`. H1 is
therefore both an unfulfilled acceptance test and a demonstrated hole in the
typed fail-closed surface. This is tracked as part of `MCP-059`.

*Recommendation:* add fault-injection coverage for the scan-stability and
manifest-read branches. Both modules already take injectable limits, so the caps
are testable; the instability paths need a seam or a real concurrent mutation
between the paired `lstat` calls. Wrap every post-read/post-scan stat and map its
failure to the existing typed unstable/changed code before testing it.

### H2

**The Windows startup-focus guard can report success without proving that it
protected startup.**

The public contract says native-fullscreen launches run "without stealing
startup focus" (`docs/observer.md:127-130`). The implementation is not strong
enough to support that statement:

- Protection begins only after `spawn()` returns
  (`src/observer/owned-runtime-manager.ts:3553-3567`) and then requires a new
  PowerShell process to parse the script, compile/JIT the C# helper, capture the
  foreground, and install hooks. A fast first window can activate in that gap.
  If it is already foreground when `Protect` begins, the helper deliberately
  discards that HWND (`runtime-focus-guard.ps1:183-188`), so the prior foreground
  identity is unrecoverable and later final state cannot prove focus was never
  stolen.
- `preserveWindowsForegroundDuringRuntimeStartup` uses a fixed 15-second default
  (`src/platform/windows/runtime-focus-guard.ts:5,47-50`), while
  `game_launch` can wait another 60 seconds for its first render instance only
  after the runtime start has returned (`src/tools/game-launch.ts:651-656`). A
  cold runtime whose first top-level window appears at second 20 is unguarded.
- The PowerShell helper records a window in `originalStyles` before checking the
  outcome of `SetWindowLongPtr` or `SetWindowPos`
  (`scripts/windows/runtime-focus-guard.ps1:190-205`). It never rejects a zero
  `SetWinEventHook` result (`:229-246`). Those APIs can all fail while the helper
  continues.
- The C# helper passes one local managed `WinEventProc` delegate to both native
  hooks (`:215-246`) but never roots it with `GCHandle` or an equivalent lifetime
  guard. A collection during the 15-second loop can therefore invalidate hook
  delivery or raise at the interop boundary.
- The final protocol sets `ok` solely from
  `!FinalForegroundOwned` (`:305-327`). `protectedWindowCount: 0`, no installed
  hook, and no observed startup window are all accepted as positive proof.

The manager waits for this weak result before publishing the start
(`src/observer/owned-runtime-manager.ts:3561-3576`), so the failure is not merely
cosmetic helper telemetry: a launch can return success while the advertised
desktop behavior was never covered. Existing tests inject a successful helper
and assert call routing; the only real-helper contract check looks for a DLL
import. There is no GC-pressure, delayed-GUI, native-failure, or zero-window test.

Microsoft documents that [`SetWinEventHook`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook)
returns a null handle when hook installation fails and specifically requires a
`GCHandle` for managed callbacks so the collector cannot move them. Microsoft
also documents that [`SetForegroundWindow`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)
actually activates the window and directs keyboard input to it. Silent false
success at this boundary is therefore user-visible behavior, not harmless best
effort. The reopened focus defect is tracked as `MCP-058`.

*Recommendation:* define positive focus-protection evidence. Require nonzero
hooks; root the callback for the complete lifetime of both hooks and release it
only after both are unhooked; use `SetLastError`-aware interop and verify style
write/readback plus `SetWindowPos`; establish guard readiness before the target
can activate (for example through a pre-spawn observer or suspended native
launcher); and keep protection alive until a target startup window has been
observed and is stable, or until the same bounded readiness/startup deadline
ends. Windows integration fixtures should cover both an immediate first window
and one delayed beyond 15 seconds, apply GC pressure, and expose forced
hook/style failures. The launch must either remain
protected or return a typed failure—never `ok` with no observation.

### H3

**The planner's Windows file-identity fallback is fail-open when stable identity
is unavailable.**

Both planners implement the same predicate:

```ts
if (left.dev === 0n && left.ino === 0n) return true;
if (right.dev === 0n && right.ino === 0n) return true;
```

That is `game-world-plan.ts:144-147` and `game-addon-plan.ts:212-215`. If either
side has no usable device/inode identity, *any* other file passes the same-file
stage. Later comparisons add size and timestamps, but those are mutable
attributes, not file identity. Microsoft defines Windows identity as a volume
serial number plus 128-bit file ID and says that pair distinguishes two open
handles ([`FILE_ID_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info)).
Unavailable identity is uncertainty and must refuse under this project's stated
contract; it cannot be treated as equality.

The open operation does not close the gap on the supported platform. Both files
use `constants.O_NOFOLLOW ?? 0` (`game-world-plan.ts:247`,
`game-addon-plan.ts:643`). Node's [filesystem flag table](https://nodejs.org/api/fs.html#file-system-flags)
states that Windows exposes only a limited flag set that excludes `O_NOFOLLOW`;
the value is absent on this Windows host, so the effective no-follow mask is
zero. A pre-open replacement is followed normally, and the later `lstat` /
`realpath` checks are path operations that can be raced back. Microsoft's
[reparse-point-aware guidance](https://learn.microsoft.com/en-us/dotnet/api/microsoft.visualstudio.utilities.internal.reparsepointaware?view=visualstudiosdk-2022)
is explicit that verification and subsequent work must use the same verified
handle to avoid this pattern.

Ordinary NTFS files on the review machine returned nonzero IDs, so this does not
invalidate the common-path evidence. It does invalidate the universal no-follow
and fail-closed guarantee promised by the plans. The tests create ordinary file symlinks;
they have no zero-ID adapter, junction, mount-point, hard-link substitution, or
Windows handle-identity case. This is tracked as `MCP-059`.

*Recommendation:* reject zero/unavailable identity immediately, or constrain and
document supported filesystems. For the strong Windows guarantee the plans claim,
open with a native handle that does not silently traverse a reparse point,
validate nonzero `FILE_ID_INFO` and the final handle path, read through that same
handle, and revalidate the same handle identity. Add deterministic zero-ID and
barrier-controlled replacement tests plus real Windows symlink, junction,
mount-point, and hard-link fixtures.

### H4

**`game_launch` cannot perform the ordinary desktop cycle start -> stop -> start
for the same launch family.**

This is deliberate and safe, but it is a product-level release blocker hidden
behind the word "baseline." Plan 7's "Baseline retry limitation" says there is
no durable successor index, terminal evidence must refuse, and one initial
generation is supported per retained profile evidence family
(`2026-08-04-launch-ergonomics-07-owned-game-launch.md:173-216`). The public
guide tells the user to create a fresh isolated managed/profile root and MCP
lifecycle for a deliberate second generation (`docs/observer.md:106-111`).

The code and test agree. `assertGameLaunchRetryRecoverable` returns
`PREPARED_LAUNCH_CONSUMED` once the retained runtime is terminal or stopping
(`src/observer/owned-runtime-manager.ts:1872-1911`), and
`tests/observer/game-launch.test.ts:572-589` proves that a successful start,
successful exact-owned stop, and identical start produce one spawn followed by
an error. The default terminal receipt retention is 24 hours, while the private
prepare-idempotency contract is why the guide does not promise that waiting is
a safe relaunch mechanism.

This is not an implementation deviation from Commit 7. It is a mismatch between
the intentionally narrow delivery and the primary surface's desktop meaning.
Normal desktop launchers are repeatable; asking a user or agent to create a new
storage root and server lifecycle after every clean stop is not a shippable
ordinary workflow. M3 would improve the error's remedy but cannot create a
successor. The limitation is tracked as `MCP-061`.

*Recommendation:* land the fenced durable successor transition from retained
Commit 9 before presenting `game_launch` as the normal launcher. Until then,
name it as a one-generation technical baseline in the tool description and
setup UX, return an explicit `successorUnavailable` state after stop, and make
the fresh-root workaround machine-readable rather than buried in prose.

---

## Medium

### M1

**The injected monotonic clock does not reach the readiness inspector or any
readiness provider.**

Commit 15 required the five-second readiness budget to run on the injected
monotonic clock, and the hermetic stdio test to advance time without waiting in
real time. The wiring does not do this.

`McpIdleShutdownController` uses its injected `nowTick` to compute
`deadlineTick: this.nowTick() + MCP_IDLE_READINESS_BUDGET_MS`
(`src/mcp-idle-shutdown.ts:282`). That deadline then crosses into two layers that
have no access to the injected clock:

- `McpIdleReadinessInspector` is constructed in `src/server.ts:303` **without**
  `nowTick`, so it falls back to real `performance.now()` and computes
  `effectiveDeadline = Math.min(options.deadlineTick, this.nowTick() + this.maximumProbeMs)`
  (`src/mcp-idle-readiness.ts:134`).
- All six providers hardcode the real clock. Every one reads
  `performance.now() > options.deadlineTick`:
  `src/workbench/activity-gate.ts:534`, `src/workbench/session-controller.ts:749,759,828`,
  `src/foundation/child-supervisor.ts:265`, `src/observer/agent-client.ts:474`,
  `src/observer/capture-service.ts:812`,
  `src/observer/owned-runtime-manager.ts:2434,2446,2713`.

This is not a production bug — in `src/index.ts` every seam is `performance.now()`,
so the clocks coincide. The problem is that the test seam only appears to work.
`tests/setup/mcp-idle-shutdown-stdio.test.ts:29` seeds its fake timer with
`now = performance.now()`, and because that fake only ever runs *ahead* of real
time, the cross-clock comparisons happen to resolve correctly. The hermetic test
is therefore anchored to wall-clock reality, which is the property it was written
to remove.

The failure mode is quiet and misleading. A future test that seeds its fake clock
at `0` — the obvious thing to write — makes `effectiveDeadline <= this.nowTick()`
true on entry, so `inspectIdleShutdownReadiness` returns `INCOMPLETE_PROOF`
immediately, forever. That reads as "the host is correctly refusing to exit",
not as "the probe is broken". A clock seeded *behind* real time yields an
effectively negative budget with the same result.

*Recommendation:* thread one `nowTick` from `runMcpStdioServer` into the
`McpIdleReadinessInspector` constructor and into every provider's inspection
options, and assert in a test that a fake clock seeded at `0` still produces a
committable proof.

### M2

**Case-sensitive Windows project trees collapse distinct paths across the
containment and provider-identity boundary.**

The shared `pathComparisonKey` resolves and lowercases every path, and
`isPathContained` computes containment between those lowercase strings
(`src/foundation/managed-path.ts:73-82`). Project identity independently stores
the same lowercase representation (`src/workbench/project-identity.ts:30-50`).
That assumption is used as authority, not merely display normalization:

- world admission accepts a canonical candidate when the lowercase containment
  test passes (`src/launch/game-world-plan.ts:349-351`), and stored-snapshot
  validation repeats it (`:958-973`);
- add-on roots with equal lowercase keys merge (`src/launch/game-addon-plan.ts:354-359`),
  and distinct manifest paths collapse in `manifestsByPath` (`:914-929`).

Microsoft documents that [Windows supports case sensitivity per directory](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity),
where `Foo` and `foo` are distinct siblings. With a selected root
`C:\Mods\Foo`, a world under distinct sibling `C:\Mods\foo` becomes a lowercase
descendant and can be misclassified as project-contained. Distinct add-on
providers can likewise merge, defeating Commit 4's requirement that the target
GUID resolve to exactly one canonical project. This violates Commit 3's exact
containment contract (`2026-08-04-launch-ergonomics-03-world-resolution.md:69-71`)
and Commit 4's provider-uniqueness contract
(`2026-08-04-launch-ergonomics-04-dependency-root-safety.md:18-20,69-75`). It is
tracked as `MCP-066`.

*Recommendation:* either detect and return a typed unsupported-filesystem
refusal for every relevant case-sensitive ancestor, or implement
directory-aware identity and containment that respects the actual filesystem
semantics. Removing `.toLowerCase()` alone is not a proof. Add a real Windows
fixture with distinct `Foo`/`foo` siblings and prove outside-project world
refusal, distinct root/provider accounting, and stable snapshot revalidation.

### M3

**The `PREPARED_LAUNCH_CONSUMED` remedy is gated to `observer_runtime` and was
not extended to `game_launch`.**

`src/observer/refusal-remedy.ts:148-149` requires
`context.tool === "observer_runtime" && context.action === "start"`.

Commit 7 added `"game_launch"` to `ObserverRefusalTool`
(`src/observer/refusal-remedy.ts:10`) and did extend the `RUNTIME_NOT_FOUND`
branch to accept it (`src/observer/refusal-remedy.ts:125`), but left this branch
alone. A consumed-preparation conflict raised through the composite therefore
returns no remedy, while the identical refusal through the primitive returns the
validated `observer_runtime { action: "status", runtimeId }` guidance.

This is safe — Commit 2's rule that consumed recovery must never advise a second
prepare/start is upheld either way — but it is an inconsistency, and the
composite is the surface where a caller is *most* likely to hit a retry conflict,
because Commit 7 deliberately ships without a successor chain.

### M4

**The composite prefixes prose onto projected observer error text and embeds the
result in a success payload.**

`src/tools/game-launch.ts:499`:

```ts
warning: `The owned runtime started, but readiness could not be confirmed. ${projectObserverFailure(error, "list")}`
```

Commit 2's stated acceptance is "No observer tool appends text after public
projection", and its rationale was explicit: composing around the projector
bypasses the total-length cap and the fixed-message gate, which is why the
projector owns both.

The redaction guarantee is not broken here — `projectObserverFailure` still
returns a fully projected, redacted, ≤512-character string, and the prefix is a
fixed literal. What is broken is the invariant. The emitted field is now a
>512-character string assembled from projector output by a caller, which is the
composition pattern the boundary was isolated to make impossible, and it
normalises the practice for the next feature that wraps the projector with
something less inert than a constant.

*Recommendation:* carry the projected text as its own field
(`readinessError`) beside a separate fixed `readinessWarning`, so no caller
concatenates onto projector output.

### M5

**`runPrivilegedCleanup` is a no-op and enforces nothing.**

`src/mcp-host-admission.ts:92-94`:

```ts
async runPrivilegedCleanup<T>(action: () => Promise<T> | T): Promise<T> {
  return action();
}
```

Commit 14 specified that "shutdown cleanup uses an internal close capability
instead of ordinary admission". The three cleanup call sites use it correctly
(`src/observer/agent-client.ts:229`, `src/observer/capture-service.ts:839`,
`src/observer/owned-runtime-manager.ts:5900`), and it is genuinely necessary,
because `acquire()` throws once the gate is sealed and disposal must still run.

But as written the method conveys no capability. It performs no check, holds no
token, and is indistinguishable from calling `action()` directly. Nothing
prevents an ordinary work path from using it to run after a seal, and no test can
distinguish correct use from abuse. The name asserts a fence that does not exist.

*Recommendation:* either make it observable — record that a privileged cleanup is
in flight so a post-seal escape is at least diagnosable — or rename it to reflect
that it is a documentation marker, and add the architecture test that constrains
its call sites.

### M6

**Expensive synchronous launch planning runs before deduplication or admission
control and can freeze the whole MCP host.**

`game_launch` completes `planCanonicalGameLaunch` before consulting either the
same-key `inFlight` map or its 32-mutation limit
(`src/tools/game-launch.ts:636-645`). Planning performs all of this on the one
JavaScript event thread:

- `game-world-plan.ts` uses synchronous `lstat`, `realpath`, directory, open, and
  read operations while permitting 10,000 visited entries, 256 candidates, and
  multi-megabyte reads;
- `game-addon-plan.ts` does the same for as many as 20,000 entries, 2,048
  candidates, and 64 MiB of aggregate manifest evidence; and
- `inspectExecutableFile` reads and hashes the configured executable to EOF with
  `openSync`/`readSync` and no size ceiling
  (`src/observer/owned-runtime-manager.ts:736-764`).

The count and byte caps are valuable denial-of-volume bounds, but they are not
elapsed-time bounds. Node states plainly that synchronous filesystem APIs block
the event loop and further JavaScript execution. A slow OneDrive placeholder,
UNC path, filter driver/antivirus delay, or merely a large executable therefore
blocks every request, cancellation notification, timer, readiness callback, and
orderly-shutdown handler. An `AbortSignal` cannot interrupt code while the event
loop is inside a synchronous call. Equal retries repeat all evidence gathering
before reaching the map that should coalesce them, and unique bursts do their
work before the 32-operation cap can reject them.

This is the difference between "bounded scan size" and desktop responsiveness.
Microsoft's hang guidance recommends moving blocking file I/O off the event/UI
thread and making operations longer than one second cancellable or backgrounded.
The gap is tracked as `MCP-060`.

*Recommendation:* acquire a bounded planning admission before any hash/scan,
coalesce equal requests at an earlier canonical request key where safe, move
filesystem work to asynchronous or isolated worker/helper execution, and define
one absolute planning deadline plus an executable byte budget. A timeout must
not merely `Promise.race` an uncancellable scan into the background; retain and
coalesce late physical work or isolate it so the host can terminate it safely.
Add latency tests that submit more than 32 equal and unequal starts while pings,
cancellation, and shutdown timers remain responsive.

### M7

**The focus guard's mutation authority is PID-only, so PID reuse can target an
unrelated desktop process.**

TypeScript passes only `TargetPid` to the helper
(`src/platform/windows/runtime-focus-guard.ts:47-69`). `IsOwnedWindow` compares
only `GetWindowThreadProcessId(...) === targetPid`
(`scripts/windows/runtime-focus-guard.ps1:150-156`), and the polling loop opens
and disposes a fresh `Process.GetProcessById` object on every iteration
(`:250-267`). The helper does not retain the originally spawned process handle or
verify its creation time.

If Reforger exits and Windows reuses that number during the 15-second helper
lifetime, the next lookup sees a live process and continues. Enumeration and
hooks can then apply `WS_EX_NOACTIVATE` to the new process's windows, and final
restoration can write styles under the same recycled PID. This contradicts the
rest of the owned-runtime design, which never treats PID alone as exact authority.
The race is narrow, but the affected object is an unrelated desktop application,
so fail-closed identity matters. It is tracked under `MCP-058`.

*Recommendation:* open and retain the exact spawned process handle before any
window mutation, carry the expected creation identity into the helper, and stop
the guard as soon as that exact process exits. Before each mutation/restoration,
validate the window PID against the still-retained process object. Add an
injectable identity fixture in which the target exits and a different process
appears under the same numeric PID; it must receive zero window calls.

### M8

**Focus restoration can itself steal focus from the user's newer choice.**

The helper captures `restoreWindow = GetForegroundWindow()` once at startup
(`scripts/windows/runtime-focus-guard.ps1:183-188`) and every later target
activation calls `RestoreForeground(restoreWindow)` (`:208-213`). Its event hooks
are filtered to the target PID, so they cannot observe the user moving from
application A to application B before the game creates or activates a window.

Concrete sequence: launch from IDE A, switch intentionally to browser B, then a
Reforger replacement window activates. The guard calls `BringWindowToTop`,
`SetActiveWindow`, and `SetForegroundWindow` on A. It has prevented the game from
stealing focus by stealing it back from the user on behalf of a stale window.
`RestoreForeground` checks only `IsWindow`, so raw HWND destruction/reuse is a
second ambiguity. Microsoft defines `SetForegroundWindow` as activating that
window and directing keyboard input to it; this is not a neutral restoration.

*Recommendation:* observe global foreground changes during the bounded guard and
track the most recent verified non-target window with its process creation
identity. Never restore a handle solely because it was valid at helper startup.
Test `A -> B -> target`, a destroyed restore window, and a reused HWND. This is
also tracked under `MCP-058`.

### M9

**Managed desktop registrations do not launch the Node executable that setup
verified.**

`server-verification.ts:217-218,773-775` probes with an absolute
`process.execPath` (or injected node command). The registration gate validates
that report and then calls `registerDetectedClients` with only `serverPath`
(`src/setup/register-clients-cli.ts:190-202`). Every generated stdio entry drops
the verified interpreter and persists ambient `"node"`:

- `expectedStdioEntry` and `expectedVsCodeEntry`
  (`src/setup/client-registration.ts:1108-1126`);
- the Codex CLI registration (`:1731-1740`);
- the Claude JSON registration (`:2004-2011`); and
- the Continue transport (`:2128-2134`).

GUI applications commonly inherit a different or stale environment from the
terminal that ran setup. A registration can therefore pass verification and
later fail because `node` is absent, or start a different/obsolete Node that does
not meet the package's `>=24` engine contract. `SETUP.md:223-224` says the
ordinary distribution uses "the installed Node executable," which hides this
resolution gap. It is tracked as `MCP-062`.

*Recommendation:* carry the verified absolute Node path in the validated
setup report and registration context, persist it as `command`, and include it
in drift comparison and receipts. Test paths with spaces and Unicode, a GUI-like
empty PATH, and a PATH whose first `node` is the wrong version.

### M10

**Private Observer-child close reports completion after sending a kill, without
observing exit.**

When graceful shutdown misses its two-second window,
`ObserverAgentClient.closeInternal` removes its temporary exit waiter,
disconnects, calls `child.kill()`, and resolves in the same timer callback
(`src/observer/agent-client.ts:246-257`). Its `finally` then clears the child and
marks the client closed (`:258-268`). The permanent bookkeeping listener remains,
but application disposal no longer awaits its evidence. The kill return value is
ignored and no second bounded wait observes `exit` or `close`.

Node's child-process contract distinguishes signal delivery from termination:
the `killed` property means a signal was successfully sent, not that the child
has exited, and the `close` event follows process termination and stdio closure.
The current test double makes `kill()` synchronously emit `exit`, so it cannot
reproduce an asynchronous real process where signal delivery, process exit, and
stdio closure are distinct observations, nor a false/throwing kill. The ordinary
disposer can consequently publish a clean host shutdown before its supposedly
disposable private child's termination is observed. This is tracked as `MCP-063`.

*Recommendation:* after escalation, check the kill result and await exact child
`exit`/`close` under the remaining absolute CLI shutdown deadline. Missing
termination proof must keep cleanup unsafe and surface a bounded failure; only
the already-defined emergency host deadline may abandon the child and exit
nonzero. Add a child fixture whose kill returns true but whose exit is delayed,
and one whose kill returns false.

---

## Low

### L1

**A saturated blocker set collapses to `INCOMPLETE_PROOF`, discarding every
diagnosed category.** `src/mcp-idle-readiness.ts:92-99` returns `null` when a
15th value arrives after 14 unique codes have been collected; the aggregate then
falls back to `["INCOMPLETE_PROOF"]` (`src/mcp-idle-readiness.ts:203`). Requires
all 14 codes active at once plus one duplicate, so it is an edge case and it
fails closed — but it destroys exactly the operator diagnostics Commit 15
promised, in the one scenario where they matter most. Note the bound is sized off
a code list that includes `EXTERNAL_ACTIVATION`, which has no producer yet (see
[P2](#p2)).

### L2

**A dormant controller reports `monitoring` with an elapsed `eligibleAt`.**
`src/mcp-idle-shutdown.ts:263` returns from `evaluate()` when
`activeRequestCount !== 0` without rescheduling a timer and without changing
state. Re-arming depends entirely on a later `emit`. In the ordinary case that is
fine — every counter change emits. But a token that never settles (a retained
`serverRequestCount` entry, for instance) leaves the controller permanently
dormant while `diagnostic()` still reports `state: "monitoring"` and an
`eligibleAt` in the past. Commit 15 required blocked states to be reported by
category; this one is invisible.

### L3

**The dispatch-turn token is scheduled before `onmessage` is forwarded.**
`src/mcp-activity-transport.ts:224` calls `this.scheduleTurn(...)` inside
`receive()`, which returns before `ActivityTrackingTransport.start()` forwards to
`this.onmessage` (`src/mcp-activity-transport.ts:429-430`). Commit 15 was
specific: "Schedule release only after forwarding `onmessage`, using an injected
turn scheduler such as `setImmediate`, not `queueMicrotask`."

With `setImmediate` the observable behaviour is identical, because the check
phase runs after the current turn and after the microtask queue drains. The
concern is that the guarantee now rests on the scheduler's phase rather than on
program order. The code defends against a *throwing* scheduler
(`src/mcp-activity-transport.ts:225-228` sets the sticky blocker) but not against
a *too-eager* one; an injected scheduler that runs synchronously would release
the token before the SDK can enter the application counter, and the architecture
test cannot catch that because the ordering is not expressed in the code.

### L4

**`-McpIdleShutdownMs` silently rounds decimals.** `scripts/start-mcp-stdio.ps1:30`
declares `[ValidateRange(60000, 86400000)] [long]$McpIdleShutdownMs`. PowerShell
coerces `60000.5` to a `long` before validation, so a decimal is accepted and
rounded rather than rejected. Commit 15 required decimals to be rejected. The
TypeScript parser (`src/config.ts:755-759`) does reject them, so the launcher
merely rounds silently rather than admitting an invalid value — cosmetic, but it
diverges from the documented contract and from the range errors the same
parameter does surface.

### L5

**Contradictory nullability for `ownedRuntimeManager`.** `src/server.ts:260`
asserts non-null with `observerApplication.ownedRuntimeManager!`, while
`src/server.ts:311` treats the same value as possibly absent when assembling the
readiness providers. One of the two is wrong. In practice the composite tolerates
`undefined`, so the assertion is load-bearing only by accident; it should be a
real narrowing or the provider list should stop guarding.

### L6

**Injected instance IDs accept the nil UUID.** `src/mcp-host-identity.ts:21` uses
`z.string().uuid()`, which admits `00000000-0000-0000-0000-000000000000`.
Production always supplies `crypto.randomUUID()` (`src/index.ts:107`), so this is
not reachable today, but Commit 13 added explicit injection seams for
`WorkbenchProcessGuardOptions.mcpInstanceId` and
`OwnedRuntimeManagerOptions.managerInstanceId`, and a nil UUID is a poor
lifecycle-ownership discriminator to accept at a fence that distinguishes hosts.

### L7

**`AMBIGUOUS_TARGET` inherits a remedy reason written for a different code.**
`src/workbench/refusal-remedy.ts:80` maps `AMBIGUOUS_TARGET` to
`exactProjectRequired`, whose `why` is "Cold Workbench project discovery is
intentionally unavailable." For `TARGET_REQUIRED` that is exactly right. For an
*ambiguous* target the action (supply an exact absolute `.gproj`) is still
correct, but the stated cause is not — discovery worked and returned more than
one candidate. Commit 1 was explicit that context, not convenience, selects
overloaded remedies. The table is otherwise compile-time exhaustive across all 27
codes via `satisfies Record<WorkbenchErrorCode, ...>`, which typecheck confirms.

### L8

**The public quick reference does not expose the recovery actions delivered by
MCP-056.** `src/tools/observer-runtime.ts:68-100` registers and accurately
describes `history` and `recover`, but `docs/observer.md:382-388` still says
`observer_runtime` only starts, inspects, or stops a runtime. `SETUP.md` likewise
has no operator path from retained-history blockers to those bounded actions.
The tools remain model-discoverable, so this is not an API failure, but the
feature created specifically to make stuck desktop hosts recoverable is absent
from the human recovery guide. Tracked under `MCP-065`.

### L9

**`runtimeKind: "client"` collides with a different concept in Reforger's own
`-client` switch.** The builder intentionally emits `-world` for this enum and
never emits `-client`; that argv is correct. Bohemia's Startup Parameters guide,
however, defines `-client` as replication-client mode, while `-world` is a
standalone graphical world load. `docs/observer.md:97-99` explains the mapping,
but `gameLaunchRawInputShape.runtimeKind` has no property description and the
top-level tool description does not disambiguate it. For an MCP caller,
`runtimeKind: "client"` reasonably implies the engine mode it expressly does not
select. Prefer `standalone` as the public value, retaining `client` as a
deprecated alias if compatibility requires it. Tracked under `MCP-065`.

### L10

**The root README reverses valid foreign-evidence idle semantics.** `README.md:67-70`
says "foreign ... lifecycle evidence keeps that host open." The host-scoped
contract does the opposite for *well-formed, attributable* foreign evidence:
Commit 14 skips valid unequal origins, and MCP-056 filters another installation
or Windows user from obligations the current host can never satisfy. Malformed,
legacy-unattributable, incomplete, or racing evidence still blocks. The current
sentence erases that critical distinction and makes correct nonblocking behavior
look like a safety regression. Tracked under `MCP-065`.

### L11

**The embedded readiness-error projection omits a remedy that the composite
separately returns.**

`resolveObserverRefusalRemedy` emits the `observer_instances` remedy for
`INSTANCE_NOT_FOUND` and `NO_RENDER_ENDPOINT` only when the context carries a
valid `sessionId` (`src/observer/refusal-remedy.ts:138-146`). Commit 2 wrote that
gate correctly—never invent a placeholder. But `projectObserverFailure` builds
its context without the session ID (`src/tools/game-launch.ts:449-455`), even
inside `waitForRenderInstance`, which has the real value (`:475-502`). Its
projected error text therefore suppresses the session-specific remedy.

This is not the caller-recovery dead end the original review described:
`startPresentation` independently emits
`next.capture.firstCall = observer_instances` with the prepared session ID when
no render target was found (`:560-575`). The result instead contains two
inconsistent guidance projections, and a consumer that reads only the embedded
error loses information present in `next`.

*Recommendation:* pass the validated session ID into `projectObserverFailure`
for readiness failures and assert that the embedded remedy and structured `next`
instruction agree. Keep the latter as the authoritative machine path.

---

## Process and validation

### P1

**The recorded acceptance is not reproducible from the repository's own default
command.**

`npm test` on `4f64515`: **2 failed files, 2 failed tests, 2,277 passed, 1
skipped**. The status table in `README.md` records "the complete serial suite
passes 251 files and 2,278 tests" for commits 8 and MCP-056. Both failures are
pre-existing test-infrastructure defects rather than regressions from this
series. Together they show that the default command and the project's currently
allowed machine state do not reproduce the recorded serial result as a single
repository artifact.

**`tests/workbench/runner-build-lifecycle.test.ts`** — fails under `npm test`
with `Workbench target build deadline expired before spawn`; passes when re-run
with `--no-file-parallelism`. `npm test` is `vitest run`, which parallelises
files by default. The plans' acceptance records consistently say *serial* suite,
so the recorded result and the default command are two different runs. Either
`npm test` should pin serial execution for these lifecycle files, or the
acceptance records should name the flag they were produced with.

**`tests/workbench/multiprocess-lifecycle.test.ts`** — fails deterministically,
serially, on any machine with a running Workbench. The first assertion is
`expect(claimed.result?.kind).toBe("claimed")` at line 118 and it receives
`refused`. Driving the fixture worker directly outside vitest shows why:

```json
{"kind":"refused","code":"UNOWNED_WORKBENCH",
 "message":"Workbench PID(s) 37540, 15720 are running without a claimable exact MCP lifecycle owner."}
```

The production guard is behaving correctly — an unowned Workbench is not
claimable, which is the whole point of the check. The test simply has an
undocumented machine-state precondition, and surfaces it as
`expected 'refused' to be 'claimed'`, which reads like a lifecycle-ownership
regression and costs a reviewer real time to disprove. Given that this project's
own execution constraint assumes Workbench may be open, the test should either
skip when an unowned Workbench is present or assert the refusal explicitly.

### P2

**`EXTERNAL_ACTIVATION` is a shipped blocker code with no producer.**
`src/mcp-idle-readiness.ts:10` declares it, and Commit 14's plan assigns its
producer to Commit 12, which is deferred. This is intentional forward design, not
a defect, but two consequences are worth recording: the enum has a permanently
dead member until Commit 12 lands, and it inflates the `MAX_BLOCKERS` bound that
[L1](#l1) depends on.

### P3

**MCP-056's prescribed live gate was replaced by a snapshot test, so the
original status "live validated" overstated what ran.**

The plan requires the production MCP composition to inspect and recover against
the *established default Observer root*, then prove safe idle exit
(`2026-08-05-mcp-056-bounded-runtime-history-recovery.md:93-102`). The result
section says the active environment was copied byte-for-byte under the lifecycle
mutex, the controlled host ran against that copy, and "the original default
Observer environment was never opened" (`:136-160`).

That substitution was prudent: older MCP hosts still had the default environment
mapped and the review constraint forbids disturbing them. It proved useful
classification, foreign-authority refusal, no termination, and clean isolated
idle exit. It did **not** exercise the open-handle/multi-host behavior named by
the gate. This distinction is now material rather than academic: open
`MCP-057` records a native access violation when a fresh host performs an
existing-only Workbench LMDB inspection while another host has the live
environment mapped.

The overview's MCP-056 note already said "Snapshot acceptance," and this review
corrects its status cell to "snapshot/live-composition validated; default-root
gate blocked by MCP-057." Keep that distinction until the exact live-root read
can fail closed without risking another host.

### P4

**The new primary launch surface repeats the repository's known untyped MCP
result debt.**

`game_launch` registers only `description` and `inputSchema`
(`src/tools/game-launch.ts:605-611`). Its properties have no `.describe(...)`
metadata, it has no title, output schema, or `structuredContent`, and each
successful action embeds its only machine payload inside a Markdown JSON fence
(`:595-667`). The focused tests recover the value with a regular expression and
`JSON.parse` (`tests/observer/game-launch.test.ts:164-168`). By contrast,
`wb_check` already publishes both an `outputSchema` and conforming
`structuredContent` (`src/tools/wb-check.ts:138-188`).

This was not a Commit 7 acceptance item and it is already tracked broadly as
deferred `MCP-027`, so it is not a new safety regression. It is still the wrong
endpoint at which to compound the debt. The earlier API-contract plan explicitly
says to add structured output incrementally beginning with Observer and
Workbench lifecycle receipts, where stable IDs/state matter most. The MCP tool
spec likewise defines `outputSchema` for client validation and recommends a text
copy alongside structured output for compatibility.

Before this composite becomes the ordinary desktop path, define one
discriminated success schema for start/status/stop, return the identical object
as `structuredContent` and serialized text, add property descriptions for
conditional fields/defaults, and make tests consume structure rather than
screen-scraping Markdown. Keep error projection bounded separately; do not leak
private diagnostics through a richer schema.

### P5

**The package's "universal MCP server" claim has no declared modern-protocol
compatibility contract.**

`package-lock.json` resolves `@modelcontextprotocol/sdk` 1.29.0, and production
constructs `StdioServerTransport` then calls `server.connect(transport)`
directly (`src/mcp-stdio-server.ts:114-140`). The official TypeScript SDK's
[2026-07-28 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)
states that a hand-constructed server directly connected this way serves only
the 2025-era protocol; modern or dual-era stdio uses the v2 `serveStdio` entry.
A dual-era client can fall back. A modern-only client cannot.

The repository tests explicit traffic as `2025-11-25` and does not state a
supported protocol era, while `package.json:5` says the server "works with any
AI agent." This is a compatibility decision, not proof of a current client
failure, and is tracked as `MCP-064`.

*Recommendation:* either narrow the compatibility statement to the tested
2025-era/dual-era clients, or migrate to the v2 dual-era server and black-box
test both openings. A migration must re-audit `ActivityTrackingTransport`,
cancellation accounting, discovery traffic, and idle sealing rather than
assuming the modern request lifecycle is byte-for-byte legacy behavior.

---

## What holds up under attack

These were specifically probed for defects and found correct. Recording them
matters as much as the findings, because several are correct in the difficult way
the plans demanded rather than the convenient way.

**The observer redaction boundary is ordered correctly.** In
`projectPublicObserverToolError` (`src/observer/public-contract.ts:116-190`) the
fixed-message registry short-circuits at line 133, strictly before
`readDiagnosticMessage()`, `readDetails()`, and the remedy resolver are ever
invoked. The remedy is resolved and length-reserved before the diagnostic is
redacted, and every exit path — including both fallbacks and the catch — re-checks
against the 512-character cap. This is the exact evaluation order Commit 2
specified, including the non-obvious requirement that fixed codes never touch a
lazy reader.

**The game projector is spoof-proof, which makes the composite's default branch
safe.** `projectPublicGameLaunchPlanError` (`src/launch/game-launch-errors.ts:204-207`)
rejects anything that is not a real `GameLaunchPlanError` with a registry-known
code before reading a single field. That is what makes the final `else` of
`gameLaunchToolError` (`src/tools/game-launch.ts:468`) correct rather than a hole:
unknown and prototype-free spoofed objects collapse to a fixed internal error, as
Commit 7 required.

**The seal transaction is genuinely atomic and the proof is unforgeable.**
`McpIdleSealProof` is a frozen object used as a `WeakMap` key
(`src/mcp-host-admission.ts:112-120`), so it cannot be constructed by a caller. It
is consumed on first use even when validation fails, and
`trySealIdleAdmissions` (`src/mcp-host-admission.ts:126-142`) validates the gate
revision *and* every provider revision before flipping `sealed`, with no `await`
anywhere between the checks and the seal. `tryCommitIdleShutdown`
(`src/mcp-idle-shutdown.ts:188-204`) performs its epoch, count, elapsed-deadline,
and seal-eligibility checks first, then calls the host seal and the transport
seal in the same synchronous turn. Both seal operations are non-throwing, and a
failed check leaves both gates open.

**Pre-consumption revocation is correctly fenced.** `executeGameLaunchMutation`
(`src/tools/game-launch.ts:415-433`) revokes the session only when the manager
returns the private `OwnedRuntimePreconsumptionError` proof, and rethrows every
other error untouched. The manager mints that proof only after writing the
invalidation record and proving no consumption or runtime reference exists
(`src/observer/owned-runtime-manager.ts:3297-3331`). Commit 7's rule that a
post-consumption error must never be inferred as unstarted is upheld.

**The argv builder matches the researched contract.**
`src/launch/game-runtime-arguments.ts` emits `-server` for `listenServer` and
`-world` for `client`, emits neither `-scenarioId` nor a standalone `-client`, and
rejects commas, NULs, and CR/LF in emitted roots before joining them for
`-addonsDir`. `mergeConfiguredAddonDirectories` appears only in
`src/observer/tools.ts`, confirming Commit 5's single-owner rule for root
ordering: the composite never double-merges.

**The evidence and re-attestation chain is coherent on ordinary case-insensitive
Windows trees once a trustworthy nonzero file identity exists.** `stableFileRead`
(`src/launch/game-world-plan.ts:226-287`)
performs an initial `lstat`, file/type and size checks, open plus `fstat`, a
bounded same-descriptor read, post-read `fstat`/`lstat`, hashing, and later
containment revalidation. The add-on manifest reader uses the same general
sequence, and both digests feed the prepare identity and point-of-use
re-attestation. That is meaningful defense for ordinary case-insensitive NTFS
files with stable nonzero IDs. It is not a universal Windows proof: [H1](#h1)
covers its untyped race exits and missing tests, [H3](#h3) covers the zero-ID and
unavailable-`O_NOFOLLOW` construction gap, and [M2](#m2) covers case-sensitive
path identity.

**Host-argument partitioning keeps the label out of configuration.**
`partitionMcpHostArguments` runs before `partitionConfigurationArguments`
(`src/index.ts:54-55`), rejects duplicates and a missing value, and
`scripts/verify-mcp-server.mjs` passes only the remainder as `startupArguments`
while forwarding the label as a typed `hostClientLabel`. `verifyMcpServer` then
reconstructs `[...nodeArguments, serverPath, ...hostArguments, ...startupArguments]`
(`src/setup/server-verification.ts:245-248`), so the spawned child — not only the
short-lived verifier — carries the product marker, which is what Commit 13
explicitly called out as insufficient if done the easy way.

**Existing-only LMDB reads do not materialise storage.**
`LmdbEnvironment.inspectExisting` (`src/foundation/lmdb-store.ts:319-345`) reuses
an already-open handle, otherwise resolves the environment directory and returns
`missing` without creating it, and only then opens a temporary `readOnly` handle
that is closed in `finally`. This is a non-creation property only; open
`MCP-057` means it must not be read as proof that a temporary live-environment
open is crash-safe under another process's mapping.

---

## Recommended order of work

1. `MCP-058`: close [H2](#h2), [M7](#m7), and [M8](#m8) as one Windows focus
   transaction. Positive hook/style evidence, exact process identity, current
   foreground ownership, rooted callback lifetime, and immediate/delayed real-GUI
   fixtures must land together.
2. `MCP-059` and `MCP-066`: close [H3](#h3), then [H1](#h1) and [M2](#m2).
   Establish a real same-handle Windows identity boundary, map every late
   filesystem failure to a typed refusal, and exercise zero IDs, case-sensitive
   siblings, and replacement barriers before relying on the evidence digests.
3. `MCP-060`: close [M6](#m6). Planning admission, coalescing, elapsed deadline,
   executable byte bound, and event-loop latency tests are one responsiveness
   change; adding only a timer around synchronous work is insufficient.
4. `MCP-061`: close [H4](#h4) by implementing the retained fenced-successor
   design, or explicitly ship the current surface as a one-generation technical
   preview rather than the ordinary launcher.
5. `MCP-063` and `MCP-062`: make private-child exit observable ([M10](#m10)) and
   pin managed registrations to the verified Node executable ([M9](#m9)). These
   are the minimum install/teardown expectations for a desktop background host.
6. [M1](#m1): thread one monotonic clock through the inspector and every provider;
   prove it with a fake clock seeded at `0`.
7. [P1](#p1) and [P3](#p3): make the repository's default command reproduce the
   claimed suite, and label snapshot versus live-root validation precisely.
   Resolve `MCP-057` before attempting the blocked live-root gate.
8. [M3](#m3)-[M5](#m5) and [L11](#l11): align remedy/projection contracts,
   restore the projector composition invariant, and make privileged cleanup
   either an enforced capability or an honest marker.
9. Deferred `MCP-027` and open `MCP-064`: publish typed `game_launch` results and
   declare/test the supported MCP protocol era before making a broad universal-
   client claim ([P4](#p4), [P5](#p5)).
10. Low findings after the blocking contracts. [L1](#l1) and [L2](#l2) belong
    with diagnostics; [L8](#l8)-[L10](#l10) are one public-guidance correction
    tracked as `MCP-065`.

## Desktop-grade acceptance bar

The review should not be closed merely because the prose or unit-test counts
change. A release-grade closure needs all of the following black-box evidence:

- immediate and delayed Windows GUIs whose first and replacement windows cannot
  steal focus; GC pressure preserves the rooted callback; forced hook/style
  failures refuse; an `A -> B -> target` sequence leaves B in front; PID and HWND
  reuse cause zero unrelated mutations;
- real Windows file symlinks, directory junctions, mount points, hard links,
  case-sensitive `Foo`/`foo` siblings, zero/unavailable file IDs, and
  deterministic before-open/after-read replacements all refuse or preserve exact
  same-handle identity without collapsing containment or provider keys;
- the configured executable directory is an explicit trusted/non-user-writable
  boundary, or a replace-for-spawn-and-restore fixture proves that the mapped
  process image—not merely the current pathname—matches the attested bytes;
- more than 32 equal and unequal launch requests cannot starve ping,
  cancellation, diagnostics, or the orderly-shutdown deadline, and equal work is
  physically coalesced rather than only coalesced after planning;
- one unchanged managed/profile root completes start -> render-ready -> capture
  restoration -> stop -> start again with two exact generations and no ambiguous
  recovery state;
- a real private child whose kill returns false or whose exit/stdio close is
  delayed prevents clean-close publication, while the CLI emergency deadline
  remains bounded and nonzero;
- a packed install registered from a terminal still starts from supported GUI
  clients with an empty or conflicting PATH because the verified absolute Node
  executable is retained;
- `game_launch` start/status/stop return schema-valid `structuredContent` plus a
  compatible text projection, and the tested client/protocol-era matrix matches
  the package's compatibility statement; and
- `npm test`, the documented serial suite, snapshot acceptance, and any guarded
  live-root acceptance are named separately and reproduce their recorded
  results without requiring Workbench to be closed unless the gate says so.
