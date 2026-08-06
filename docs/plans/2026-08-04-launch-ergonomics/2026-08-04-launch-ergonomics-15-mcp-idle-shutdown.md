# Commit 15 plan: reclaim safely idle MCP host processes

> **Commit:** `feat(mcp): add bounded idle auto-shutdown`
>
> **Series position:** acting half of the MCP idle-lifecycle follow-up.
>
> **Dependency:** [host-scoped idle readiness fencing](2026-08-04-launch-ergonomics-14-mcp-idle-readiness.md),
> which in turn depends on operator-visible MCP host identity. Commits 7, 9, and
> 12 extend that foundation's blocker projection when their feature-specific
> lifecycle states are present.
>
> **Source backlog:** MCP-055. Commits 14 and 15 jointly own the removed queue
> entry; the issue is not moved to the resolved log until this acting commit and
> the complete acceptance gates pass.

## Why the acting feature is one commit

Commit 14 lands the behavior-neutral readiness providers, existing-only readers,
and default-open host gate separately. This commit owns the entire acting safety
transaction: configuration, protocol-wide activity accounting, cancellation and
send completion, the controller, diagnostics, and the only production call that
seals the host gate and exits. A timer without any one of those pieces can abandon
work or leave a phantom process; land and revert the actor together.

Do not fold this into Commit 13. Host identity makes a process diagnosable but
does not decide when it is safe to exit. Do not fold it into owned game launch,
successor recovery, or external script delivery either: those features contribute
typed blocker states through Commit 14, while this commit owns the
process/protocol policy for every MCP configuration.

## Goal

Let each CLI stdio server shut down only itself after a configurable period with
no client protocol activity. The default is exactly 30 minutes. Before committing
shutdown, consume Commit 14's proof that there is no in-flight host-local child
operation, capture/restoration obligation, or owned Workbench/runtime/external
lifecycle that would be abandoned, and independently prove the protocol idle.
Any incomplete or uncertain proof leaves stdio open and retries later.

A connected but silent stdio client is intentionally eligible; treating the open
pipe itself as activity would preserve the accumulation defect. An active request
or detached lifecycle obligation is not eligible, regardless of elapsed time.

## Current-code constraints

- `src/index.ts` currently requests shutdown only for stdin `end`/`close`,
  SIGINT, SIGTERM, and startup failure. There is no idle timer or parent watcher.
- `runCliShutdown` closes the MCP protocol before it calls the tool disposer. It
  then retries unsafe disposal until a 30-second hard deadline and invokes the
  emergency private-child path. An idle timer must not enter that sequence until
  a separate non-mutating safety proof has succeeded.
- Commit 14 adds the read-only, host-scoped readiness proof and default-open
  process admission gate. This commit must consume those public repository
  contracts; it must not duplicate their durable scans or use a mutating disposer
  as a probe.
- the installed MCP SDK does not expose a public request-completion event.
  `McpServer.server` has private request maps that this repository must not read.
  Its public `Transport` boundary sees every decoded JSON-RPC message and every
  response send, including initialize, ping, discovery, tools, resources,
  prompts, and unknown methods.
- SDK 1.26 suppresses both the result and error after a request is cancelled, so
  response matching alone would retain a phantom request forever. Cancellation
  needs paired protocol-response and repository-handler accounting through public
  registration and transport APIs.

## Files

- new `src/mcp-activity-transport.ts`
- new `src/mcp-idle-shutdown.ts`
- new `src/mcp-stdio-server.ts`
- `src/index.ts`
- `src/config.ts`
- `src/server.ts`
- `src/workbench/diagnostics.ts`
- `src/tools/wb-diagnose.ts`
- `src/setup/server-verification.ts`
- `src/setup/setup-receipt.ts`
- `src/setup/doctor.ts`
- `scripts/setup.ps1`
- `scripts/start-mcp-stdio.ps1`; `scripts/verify-mcp-server.mjs` needs contract
  coverage but no production edit unless the audit finds a second argument path
- `scripts/validate-observer-enforce.mjs`
- `scripts/run-observer-enforce-mailbox-acceptance.mjs`
- `scripts/check-package.mjs`
- `reforger-forge.config.example.json`
- `README.md`
- `SETUP.md`
- `docs/runner-cli.md`
- `docs/observer.md` and `agents/AGENTS.md` where automatic-host-lifecycle
  guidance is stated
- new `tests/mcp-activity-transport.test.ts`
- new `tests/mcp-idle-shutdown.test.ts`
- new `tests/setup/mcp-idle-shutdown-stdio.test.ts`
- `tests/setup/mcp-stdio-lifetime.test.ts`
- `tests/config.test.ts`
- `tests/config-installation-contract.test.ts` (validation-only unless the
  config-free managed registration assertion changes)
- `tests/mcp-lifecycle.test.ts`
- `tests/workbench/server-composition.test.ts`
- `tests/workbench/diagnostics.test.ts`
- `tests/workbench/wb-diagnose-tool.test.ts`
- `tests/observer/mcp-shutdown-characterization.test.ts`
- Commit 7/9/12 idle-readiness fixture suites (integration-only when present)
- `tests/setup/server-verification.test.ts`
- `tests/setup/setup-receipt.test.ts`
- `tests/setup/setup-completion-cli.test.ts`
- `tests/setup/doctor.test.ts`
- `tests/setup/build-verification-deduplication.test.ts`
- `tests/setup/setup-script-contract.test.ts`
- `tests/setup/start-mcp-stdio.test.ts`
- `tests/workbench/runner-cli.test.ts`
- `tests/observer/package-contract.test.ts`
- every direct `Config` fixture found by the type checker
- `package.json` to add the focused lifecycle tests to the enduring stage-4 gate

Add `dist/mcp-activity-transport.js`, `dist/mcp-idle-shutdown.js`, and
`dist/mcp-stdio-server.js` to `scripts/check-package.mjs`'s explicit
`requiredFiles` inventory. `package.json.files` already includes all of `dist`.

## Configuration contract

Add one required field to the effective top-level `Config`:

```ts
readonly mcpIdleShutdownMs: number;
```

The JSON key is `mcpIdleShutdownMs`; the CLI flag is
`--mcp-idle-shutdown-ms <milliseconds>`. Apply the existing precedence of
internal default, explicit JSON file, then CLI override. The default is
`1_800_000` milliseconds, exactly 30 minutes. Accept only safe integers from
`60_000` through `86_400_000` inclusive.

Do not add `null`, zero, a negative value, an environment override, or a
`--no-mcp-idle-shutdown` escape hatch. Those would silently restore indefinite
accumulation. Reject duplicates, missing values, decimals, and out-of-range
values with `ConfigurationError`. Document the setting as MCP-server-only. The
shared configuration parser is also used by the standalone Workbench runner, so
that runner may parse the value but must not start an MCP idle timer or imply that
the value bounds a Workbench operation. Document this explicitly in
`docs/runner-cli.md` and test that the flag remains in the configuration partition
passed to `loadConfig`, never in runner intent.

Add the key to the strict file schema, CLI partition/value sets, help text,
example JSON, and settings reference. Explicitly copy it in
`resolveFileConfigPaths`; that function reconstructs every top-level scalar and
would otherwise silently discard a valid JSON value before merge. Bump
`EXPLICIT_CONFIGURATION_CONTRACT_VERSION` from 2 to 3 and update both native
observer harness guards plus the package-contract assertion. Audit all typed
`Config` fixtures rather than making the effective field optional to avoid test
updates.

Expose the effective value in `EffectiveSettingsVerification` and
`SetupSettingsReceipt`; early/unresolved setup receipts use `null`, while a
successful validated report carries the required bounded integer. Bump
`SERVER_VERIFICATION_REPORT_SCHEMA_VERSION` and `SETUP_RECEIPT_SCHEMA_VERSION`
from 1 to 2. Update the verification report's strict parser; setup receipt
constructors, serializer, and renderers; all fixtures; and both the early-failure
schema literal and `Test-CanonicalSetupReceipt` in `scripts/setup.ps1`.
`EffectiveSettingsVerification` remains structurally optional for a failed
settings stage, but its v2 parser requires a bounded `mcpIdleShutdownMs` whenever
`status === "passed"`. `SetupSettingsReceipt.mcpIdleShutdownMs` is a required
`number | null`; PowerShell requires the property and accepts `null` only for an
unresolved settings result, otherwise it validates the same integer bounds. This
is separate from Commit 13's PowerShell **Describe** schema version 2; do not bump
or reinterpret that unrelated descriptor merely because the receipt/report
schemas also become version 2.

Commit 13 partitions host-control arguments from configuration arguments. Add an
optional `[long] -McpIdleShutdownMs` parameter to `start-mcp-stdio.ps1`, validate
the same bounds, and append the CLI pair only when
`PSBoundParameters.ContainsKey("McpIdleShutdownMs")`. Do not give the PowerShell
parameter a 30-minute default: omission must not manufacture an explicit
override. Through this launcher's current enumerated surface, omission selects
the internal default; it does not claim a general `-Config` passthrough. Commit
13's Describe
`configurationArguments`, Verify, and Serve modes must carry the exact same pair.
The flag remains an ordinary configuration argument and must not be consumed as a
host-label option. `verify-mcp-server.mjs` already accepts configuration argv;
prove its existing path preserves the pair. Managed client registrations remain
config-free and inherit the 30-minute default, so no registration rewrite is
required for this setting.

Validate the same bounds again at the CLI idle-controller construction boundary
so an invalid programmatically assembled `Config` cannot create a zero-delay,
overflowing, or effectively unbounded timer.

## Protocol activity and request accounting

Implement an `ActivityTrackingTransport` decorator against the SDK's public
`Transport` interface and wrap `StdioServerTransport` before `server.connect`.
Forward `start`, `send`, `close`, `onmessage`, `onerror`, `onclose`, `sessionId`,
and protocol-version behavior without reading SDK private fields or changing
JSON-RPC bytes.

Pair it with a repository-owned `TrackedMcpServer extends McpServer`, constructed
at the production composition root and passed normally to `registerTools`. It
overrides the public `registerTool`, `registerResource`, and `registerPrompt`
overloads while preserving their exact return types, so the existing registrars
typed as nominal SDK `McpServer` need no unsafe cast or broad signature rewrite.
Wrap every application callback, ResourceTemplate list/completion callback, and
allowed returned-handle callback replacement in an application-operation token
whose `finally` runs even after cancellation. SDK input/output validation,
initialize, ping, empty discovery, and method-not-found paths create no repository
lifecycle operation and remain covered by the protocol-response ledger.

Add an architecture test that rejects production code bypassing the tracked
subclass inside the CLI composition or repository registrars via legacy
registration aliases, raw `server.server.setRequestHandler`/
`setNotificationHandler`, an unwrapped registered-handle callback update,
an untracked prompt-schema completer, `registerToolTask`, a task store, or
experimental task registration. Queued task completion does not necessarily pass
through transport `send` and is unsupported until it has explicit accounting. Do
not inspect, replace, or monkeypatch the SDK's private handler maps.

Preserve the public embedded `registerTools(new McpServer(...), config)` path. It
has no CLI controller or automatic exit and reports the externally managed
diagnostic variant; the bypass rule does not require third-party embedders to use
the CLI-only tracked subclass.

The current repository schemas contain no asynchronous Zod refinement or
transform. Freeze that invariant with architecture coverage: async schema work is
unsupported until it receives its own operation accounting. The SDK's bounded
synchronous validation may traverse several Promise microtasks but must settle or
enter the tracked application callback before the end-turn dispatch token is
released.

Define activity as follows:

1. initialize the last-activity clocks when the decorated transport starts;
2. every successfully decoded inbound JSON-RPC request, notification, or response
   refreshes activity and increments a monotonic activity epoch;
3. every outbound message holds a send-settlement token around the underlying
   `send()` promise so cancellation cannot create a gap while a response is still
   under backpressure; unrelated server notifications do not refresh activity
   merely because this token starts or settles;
4. an inbound client request enters a typed protocol-response multiset before
   dispatch and holds an end-of-event-loop-turn token until the SDK's chained
   Promise microtasks can enter the application-operation counter. Schedule
   release only after forwarding `onmessage`, using an injected turn scheduler
   such as `setImmediate`, not `queueMicrotask`;
5. a matching outbound result/error whose decorated `send()` settles retires one
   protocol-response entry and refreshes activity, so a request lasting longer
   than the timeout receives a full fresh idle period after completion;
6. a valid inbound `notifications/cancelled` refreshes activity and retires one
   matching protocol-response entry because SDK 1.26 suppresses that response.
   The separately wrapped handler remains active until its actual `finally`, even
   if it ignores `AbortSignal`; that settlement refreshes activity and grants a
   fresh interval. An unmatched cancellation changes no count;
7. keep a separate direction-scoped multiset for server-originated JSON-RPC
   requests: enter before calling the underlying `send`, remove on send failure,
   and otherwise retain it until the matching inbound client result/error. A
   matching outbound `notifications/cancelled` retires one entry only after its
   send settles; a failed cancellation send leaves a bounded indeterminate
   blocker unless later response/close evidence clears it; and
8. unrelated server-originated logging, progress, list-changed, heartbeat, or
   housekeeping messages do not refresh the idle clock.

Preserve the distinction between numeric and string request IDs, including `0`
and the empty string, keep the two JSON-RPC directions separate even when they
reuse the same ID, and count duplicate concurrent IDs rather than overwriting
entries. Each response or cancellation decrements at most one matching entry. A
malformed line rejected by the underlying stdio decoder is not activity. A valid
unknown method is activity and stays active through its method-not-found send.
On a failed client-response send, release that protocol entry in `finally` so a
nonfatal send failure cannot pin a phantom response; do not record successful
completion activity. Any dispatch that cannot be classified as a bounded SDK
handler or repository-wrapped operation sets a sticky
`request_completion_indeterminate` blocker until transport close. Transport
close already enters the immediate shutdown path.

Expose only aggregate protocol/application/server-request/send/dispatch counts,
timestamps, epoch-derived state, and bounded categories to the coordinator.
Never expose request IDs, method names, arguments, response bodies, or transport
buffers. The wrapper must preserve stdout as protocol-only output. Use an
injected monotonic clock for elapsed-time admission and keep wall-clock ISO values
only for diagnostics; a system clock correction must not cause early shutdown or
extend the configured duration indefinitely.

## Commit 14 readiness dependency

Consume Commit 14's `inspectIdleShutdownReadiness` and default-open
`McpHostAdmissionGate`; do not duplicate its durable readers, ownership
classification, provider scans, or lifecycle transitions here. Pass the shared
five-second monotonic deadline, `AbortSignal`, and probe generation. A logical
timeout is incomplete. Commit 14 owns and coalesces any physically unsettled scan
and returns incomplete until it settles; no promise crosses this API, and a later
logical check cannot create an overlapping physical scan.

Capture only the protocol activity epoch before awaiting the proof. Commit 14's
proof carries post-inspection provider revisions. This commit adds the synchronous
aggregate `tryCommitIdleShutdown(proof, activityEpoch)`: first validate the epoch,
end-of-turn dispatch token, protocol/application/server-request/send counts, and
elapsed deadline; then call Commit 14's nonthrowing
`trySealIdleAdmissions(proof)` and synchronously seal inbound transport dispatch.
All checks precede either seal, and both post-check seal operations are
nonthrowing. A failed check leaves both gates open; after the host gate seals, the
only continuation is the transport seal and existing coalesced shutdown path.

The proof and seal grant no new lifecycle authority. This commit never signals an
owned Workbench/game process, mutates a lifecycle record, acts on foreign evidence,
or uses the current mutating disposer as a readiness probe.

## Production composition and test seam

Move the current `runServer` body out of the top-level CLI module into an exported
`runMcpStdioServer` in `src/mcp-stdio-server.ts`. `src/index.ts` retains command
parsing and calls it with production process streams, events, timers, logger, and
exit behavior. It also accepts and forwards the one frozen `McpHostIdentity`
created by Commit 13's entry point; it must not generate a second identity while
moving the composition body. The server function accepts narrow injected
transport/stream, monotonic and wall clocks, timer, signal-listener, and exit
seams; production defaults preserve the current behavior. It must not expose tool
internals or a way for production callers to bypass configuration validation.

This is the real wiring seam for the hermetic stdio test. Use a valid production
timeout (at least 60 seconds), advance the injected monotonic clock and timer
without waiting in real time, and exercise the actual McpServer, decorated
transport, tool disposer, and shutdown callback. Do not add a test-only
environment variable, weaken the production bounds, import the side-effecting
CLI entry point, or validate only a surrogate coordinator.

## Idle-check and shutdown transaction

Build a CLI-only `McpIdleShutdownController`; embedders receive the readiness seam
but are not subjected to `process.exit`. Use injected clock/timer/readiness
dependencies for hermetic tests. Keep exactly one unreferenced timer, clear it
synchronously before its callback evaluates state, and reschedule only through
the controller. Permanently cancel the controller on idle commitment, EOF,
stdin-close, signal, or startup-failure shutdown. Coalesce readiness checks so
timer rescheduling and protocol callbacks cannot run two probes concurrently.

The controller executes this state machine:

1. schedule the exact monotonic `lastActivityTick + mcpIdleShutdownMs` deadline;
2. at the deadline, do nothing while any protocol response, application
   operation, server-originated request, send-settlement token, or dispatch-turn
   token is active;
   completion refreshes activity and schedules a full new period;
3. capture only the protocol activity epoch, mark diagnostics as `checking`, and
   run the pure readiness inspection with its shared five-second monotonic bound;
   each provider captures its returned revision after its inspection settles;
4. if the proof is incomplete or has blockers, leave transport and tool
   admissions open, retain the original inactivity time, and recheck after
   `min(mcpIdleShutdownMs, 30_000)` milliseconds, except that a physically
   unsettled timed-out probe must settle before another probe can begin;
5. if any activity occurred during the asynchronous proof, discard it and
   schedule from the new activity time;
6. otherwise call the synchronous aggregate `tryCommitIdleShutdown`; it compares
   the epoch, elapsed deadline, zero activity/token counts, and every provider
   revision, then atomically seals host-local admission and decorated inbound
   dispatch; and
7. only after that linearization point call the existing coalesced
   `shutdown("idle timeout")`, which closes the protocol and uses
   `runCliShutdown` for ordinary disposal and its existing hard deadline.

A request dispatched before the seal increments the epoch and wins the race; the
idle attempt is cancelled. A message arriving after the seal is not dispatched
and observes the imminent connection close. If readiness is blocked or uncertain,
there is no seal, no dropped request, no protocol close, and no emergency child
termination. Do not close stdio first and attempt to reopen it after a failed
probe.

The existing disposer remains the final observer/owned-runtime close authority,
but it does not inspect or stop an owned running Workbench. For Workbench, the
complete readiness proof plus synchronous aggregate admission seal is the final
idle-shutdown authority; a running or uncertain owned Workbench therefore cannot
produce a committable proof. The proof does not grant permission to signal
Workbench, game processes, or another MCP. The CLI emergency path remains limited
to its disposable private child and local handles; automatic shutdown must never
add a kill-by-name, PID-only, host-label, or cross-host cleanup path.

## Diagnostics and operator behavior

Keep Commit 13's `mcpHost` block identity-only. Add a sibling bounded
`mcpLifecycle` block to `wb_diagnose`:

```ts
interface ExternallyManagedMcpLifecycleDiagnostic {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly idleShutdownMs: number;
  readonly state: "externally_managed";
  readonly activeRequestCount: null;
  readonly lastActivityAt: null;
  readonly eligibleAt: null;
  readonly readinessComplete: null;
  readonly blockerCodes: readonly [];
}

interface CliManagedMcpLifecycleDiagnostic {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly idleShutdownMs: number;
  readonly state: "monitoring" | "checking" | "blocked" | "shutdown_committed";
  readonly activeRequestCount: number;
  readonly lastActivityAt: string;
  readonly eligibleAt: string;
  readonly readinessComplete: boolean | null;
  readonly blockerCodes: readonly McpIdleBlockerCode[];
}

type McpLifecycleDiagnostic =
  | ExternallyManagedMcpLifecycleDiagnostic
  | CliManagedMcpLifecycleDiagnostic;
```

Cap and sort blocker codes, validate both timestamps as canonical ISO values, and
bind `instanceId` to the same trusted host object used by Workbench and the owned
runtime manager. For CLI-managed mode, define `activeRequestCount` as a saturated
aggregate of protocol, application, server-request, send, and dispatch slots
rather than a claim about unique IDs. The diagnosing request itself may contribute
more than one slot; its response completion resets the idle period. Externally
managed mode must not synthesize activity or eligibility timestamps. Do not expose
request methods/IDs, process command lines, paths, tokens, or raw probe errors.

Keep Commit 13's single fixed-field stderr startup record identity-only. Report
the effective timeout through `mcpLifecycle` and setup/server verification; the
verifier does not wait for an idle interval. Update and test
`formatServerVerificationReport()` so the human `npm run mcp:verify` output shows
the effective timeout as well as the JSON report. An embedded server with no CLI
idle controller reports `externally_managed`, never a misleading `monitoring`
state. Keep the existing bounded shutdown reason, and log blocked categories only
on a state transition or in debug mode so a 30-second recheck cannot spam stderr.

Do not persist last-activity timestamps or add a durable MCP-host registry. An
on-disk activity ledger cannot transactionally prove another process idle and
would invite cross-client reaping. The timer is authoritative only inside its own
process; existing exact Workbench/runtime stores remain the durable recovery
authorities.

## EOF, parent death, crashes, and stale state

Preserve immediate stdin EOF/close, SIGINT, SIGTERM, and startup-failure behavior;
they do not wait for 30 minutes or pass through the idle eligibility gate. Normal
parent death closes stdio and therefore uses the existing shutdown path. If an
inherited pipe handle prevents EOF after the parent is gone, the same inactivity
timer reclaims this process when its own lifecycle is safe. Do not poll, signal,
or terminate a parent PID.

A host crash cannot run JavaScript cleanup. The private observer child already
closes on IPC disconnect, and later hosts use the existing exact durable
Workbench/runtime reconciliation. Because this commit creates no host activity
record, it creates no stale activity record or cross-host sweeper. Corrupt or
indeterminate existing lifecycle state blocks automatic cleanup and is reported
by bounded category; it is never converted to permission by age.

If a live owned Workbench/runtime or unresolved external contract persists, the
host may correctly remain alive beyond the timeout. That is a diagnosed safety
blocker, not a failure of the inactivity clock.

## Tests

Cover configuration:

- 30-minute default, JSON/CLI precedence, partitioning, help, example, and
  server-only documentation, including JSON propagation through
  `resolveFileConfigPaths` and the standalone runner's parse-but-do-not-act rule;
- exact 60-second and 24-hour endpoints;
- duplicate, missing, decimal, zero, negative, 59,999, 86,400,001, `null`, and
  unknown-key rejection;
- explicit configuration contract version 3 in both harnesses; and
- verification schema-2 parsing plus setup PowerShell schema-2 validation,
  failure receipts, JSON and human renderers, strict old-schema rejection, and
  passed-versus-unresolved timeout invariants; and
- PowerShell omission versus explicit `-McpIdleShutdownMs`, range errors, and
  byte-for-byte Serve/Verify/Describe configuration-argument parity;
- direct `McpIdleShutdownController` construction rejecting invalid
  programmatically assembled timeout values; and
- managed installation templates remaining config-free and inheriting the
  internal 30-minute default.

Cover the public transport decorator with numeric/string/duplicate request IDs,
initialize, ping, tool/resource/prompt discovery, notifications, client
responses, unknown methods, malformed input, decorated `send()` backpressure,
response-send failure, close, and byte-for-byte forwarding. Prove that a long
request cannot time out in flight and receives a full interval after successful
response-send settlement, while unrelated server notifications do not keep the
host alive. Use chained SDK-like Promise microtasks and reentrant fake transport
delivery to prove the injected end-turn token cannot release before handler
admission.

Exercise client cancellation before handler admission, during the supported
bounded synchronous-schema validation path, and inside a long tool/resource/
prompt handler that ignores `AbortSignal`. Cover
numeric/string IDs, `0`, the empty string, duplicates, unmatched cancellation,
application `finally` settlement after the idle interval, and the sticky
indeterminate fallback. Exercise server-request timeout/abort and prove its
outbound cancellation settles the direction-scoped entry without a phantom
blocker. An outstanding server-originated request that crosses the idle deadline
must block shutdown until its matching client result/error or proven local
cancellation completes, then receive a full new interval. The architecture test
must reject untracked raw request/notification, async schema, and task
registration. Also cover initial server-request send failure, failed outbound
cancellation send retaining the indeterminate blocker, and a later matching
client response clearing that blocker.

With fake time, exercise activity at the deadline, activity during an asynchronous
probe, revision change after a complete probe, active-request completion, blocked
and incomplete rechecks without closing transport, exactly one shutdown
commitment, timer unref/cancellation, startup failure, and coalescing with the
existing EOF/signal shutdown request. Include forward/backward wall-clock jumps
to prove only monotonic elapsed time controls admission. Prove a timed-out
uncancellable provider cannot overlap a later probe, its late result is discarded,
and the five-second budget itself uses the monotonic clock. Cover the externally
managed diagnostic union without synthetic activity/eligibility values.

Integrate Commit 14 with complete, blocked, revision-raced, and incomplete
results, including the bounded category for an internally coalesced physical
scan. A failed aggregate commit leaves both gates open; a
successful one calls the nonthrowing host seal and transport seal exactly once in
one turn, consumes the proof, and still permits privileged disposer cleanup.
Prove the exact frozen host identity from `src/index.ts` reaches the readiness
provider and diagnostics through `runMcpStdioServer` without regeneration.

When Commits 7, 9, or 12 are present, consume their forward fixtures through
Commit 14 and exercise actual timeout/controller behavior for every documented
blocking and nonblocking feature state. This is the actor integration deferred by
those earlier commits; do not duplicate their provider implementation here.

Add a hermetic stdio composition test through `runMcpStdioServer` using injected
timing rather than weakening the production 60-second minimum. Start two
separately identified hosts, keep one active or lifecycle-blocked, let the other
become safely idle, and prove only the idle host closes. Assert no signal,
release, record mutation, or private-child termination occurs in the other host.
Also start an otherwise ready private child with no work and prove idle shutdown
closes it cleanly through the normal disposer.

Assert stdout contains only JSON-RPC throughout. Keep existing MCP shutdown,
Workbench ownership/recovery, observer application shutdown, and package tests
green.

## Validation

```powershell
npx vitest run tests/mcp-activity-transport.test.ts tests/mcp-idle-shutdown.test.ts tests/mcp-lifecycle.test.ts tests/setup/mcp-idle-shutdown-stdio.test.ts tests/setup/mcp-stdio-lifetime.test.ts tests/config.test.ts tests/config-installation-contract.test.ts tests/workbench/server-composition.test.ts tests/workbench/runner-cli.test.ts tests/workbench/diagnostics.test.ts tests/workbench/wb-diagnose-tool.test.ts tests/observer/mcp-shutdown-characterization.test.ts tests/setup/server-verification.test.ts tests/setup/setup-receipt.test.ts tests/setup/setup-completion-cli.test.ts tests/setup/doctor.test.ts tests/setup/build-verification-deduplication.test.ts tests/setup/setup-script-contract.test.ts tests/setup/start-mcp-stdio.test.ts tests/observer/package-contract.test.ts
npm run test:stage3
npm run test:stage4
npm run test:cross-cutting:baseline
npm run test
npm run test:package
npm run typecheck
npm run build
npm run mcp:verify
```

## Commit acceptance

- The effective timeout defaults to exactly 1,800,000 ms and is configurable only
  within the documented finite bounds.
- All decoded client protocol traffic, cancelled-handler settlement, and both
  directions of request completion participate in idle timing without using
  SDK-private handler state or leaving phantom counters.
- A long-running request, host-local child operation, capture/restoration duty, or
  owned/uncertain Workbench/runtime/external lifecycle prevents automatic exit.
- A blocked, incomplete, or physically unsettled readiness probe leaves stdio
  open and performs no lifecycle mutation or overlapping scan; the existing
  close-first shutdown path is invoked only after the aggregate epoch/revision/
  admission fence succeeds.
- A silent, safe host closes itself and its disposable private child after the
  configured interval without touching another MCP host or any unowned/foreign
  process or record.
- EOF, parent-close, signals, crashes, and durable subsystem recovery retain their
  existing authority and behavior.
- Bounded diagnostics identify the exact host, timeout, state, and blocker
  categories without exposing request or ownership secrets.
- No persistent host activity ledger, cross-process idle reaper, PID-only kill,
  disable value, or new public tool is introduced.
