# Outstanding MCP Issues

This FIFO queue contains open contract decisions, acknowledged limitations, and
deferred improvements that are not currently a broken supported behavior.
Append new findings at the bottom; move resolved or verified records to
[MCP_ISSUES_RESOLVED.md](MCP_ISSUES_RESOLVED.md).

## MCP-060 - launch planning can monopolize the MCP event loop before admission

**Status:** Open

**Priority:** P1 - whole-host responsiveness and cancellation

**Observed:** 2026-08-05

**Observed behavior:** `game_launch` performs executable hashing plus world and
add-on discovery with synchronous filesystem APIs before it checks the same-key
in-flight map or the 32-mutation limit. The scan caps bound counts and manifest
bytes, but no elapsed deadline or cancellation reaches planning, executable
hashing has no byte ceiling, and one slow filesystem call blocks protocol
dispatch, cancellation, timers, and orderly shutdown. Equal retry storms repeat
the full evidence scan before they can coalesce.

**Decision needed:** Move planning behind bounded admission and off the MCP event
loop, define an absolute planning deadline and executable byte budget, propagate
cancellation where it is physically meaningful, and decide how late or
uncancellable filesystem work is isolated/coalesced without weakening the
same-evidence launch key.

**Affected areas:**
[`src/tools/game-launch.ts`](../../src/tools/game-launch.ts),
[`src/launch/game-world-plan.ts`](../../src/launch/game-world-plan.ts),
[`src/launch/game-addon-plan.ts`](../../src/launch/game-addon-plan.ts),
[`src/observer/owned-runtime-manager.ts`](../../src/observer/owned-runtime-manager.ts),
and launch stress/latency tests.

**Evidence:** Both planners import `*Sync` traversal/read APIs; executable
attestation reads to EOF synchronously; the in-flight lookup occurs only after
`planCanonicalGameLaunch` returns. Node documents that synchronous filesystem
APIs block the event loop and further JavaScript execution.

## MCP-061 - the primary game-launch workflow has no deliberate successor generation

**Status:** Open

**Priority:** P1 - ordinary desktop relaunch workflow

**Observed:** 2026-08-05

**Observed behavior:** The delivered `game_launch` baseline intentionally allows
one initial generation per retained profile evidence family. After a normal
start and exact-owned stop, repeating the same start returns
`PREPARED_LAUNCH_CONSUMED`; changed requests also fail closed. The public
workaround is a fresh isolated managed/profile root and MCP lifecycle. This is
safe and plan-conformant, but it is not the relaunch behavior users expect from
the advertised normal desktop launch surface.

**Decision needed:** Either deliver the fenced durable successor transition in
the retained Commit 9 plan before treating `game_launch` as the normal launcher,
or explicitly position the current action as a one-generation technical
baseline and make the recovery/workaround visible in tool output and setup UI.

**Affected areas:**
[`src/tools/game-launch.ts`](../../src/tools/game-launch.ts),
[`src/observer/owned-runtime-manager.ts`](../../src/observer/owned-runtime-manager.ts),
the deferred successor plan, and public Observer/setup guidance.

**Evidence:** The manager explicitly refuses terminal retained attempts, the
focused test asserts start/stop/same-start refusal, and the originating plan and
public guide both prescribe a fresh root/MCP for a second baseline generation.

## MCP-064 - supported MCP protocol eras are not declared or tested

**Status:** Open

**Priority:** P2 - current-client compatibility decision

**Observed:** 2026-08-05

**Observed behavior:** The package describes itself as a universal MCP server,
but it remains on the v1 SDK and directly connects an `McpServer` to
`StdioServerTransport`. Under the official 2026-07-28 SDK migration guidance,
that composition serves only the 2025-era protocol. Dual-era clients can fall
back, while a modern-only client cannot connect. The repository neither states
that boundary nor tests a legacy/modern compatibility matrix.

**Decision needed:** Declare the supported protocol revision/era and constrain
the compatibility claim, or migrate to the v2 dual-era stdio serving entry and
black-box test initialization, discovery, requests, cancellation, activity
accounting, and shutdown in both eras.

**Affected areas:** `package.json`, `src/mcp-stdio-server.ts`, the activity
transport wrapper, package verification, and setup/compatibility documentation.

**Evidence:** `package-lock.json` resolves `@modelcontextprotocol/sdk` 1.29.0;
production constructs `StdioServerTransport` and calls `server.connect()`
directly; the only explicit transport protocol fixtures use `2025-11-25`.

## MCP-065 - public launch and recovery guidance has stale or misleading contract language

**Status:** Open

**Priority:** P3 - operator discoverability and terminology

**Observed:** 2026-08-05

**Observed behavior:** The Observer quick reference still describes
`observer_runtime` as start/inspect/stop even though public `history` and
`recover` actions now own retained-history diagnosis and recovery. The
`runtimeKind: "client"` name maps to standalone `-world` loading, while Bohemia
uses `-client` for replication-client mode; prose states the mapping but the
registered property has no description that disambiguates the term. The root
README also says valid foreign lifecycle evidence keeps the local host open,
reversing the implemented host-scoped rule: well-formed foreign authority stays
visible but nonblocking, while malformed/unattributable evidence blocks.

**Decision needed:** Update the current operator quick reference and setup
recovery path for `history`/`recover`; rename or alias `runtimeKind: "client"` to
`standalone` (or describe it at the schema boundary); and correct the root idle
paragraph to distinguish valid foreign evidence from uncertain evidence.

**Affected areas:** `docs/observer.md`, `README.md`, `SETUP.md`, the
`game_launch` input schema/description, and documentation contract tests.

**Evidence:** The registered runtime enum includes five actions, while the quick
reference lists three; the argv builder deliberately emits `-world` for
`runtimeKind: "client"`; MCP-056 and idle-readiness filtering explicitly remove
well-formed unequal authority from this host's obligations.
