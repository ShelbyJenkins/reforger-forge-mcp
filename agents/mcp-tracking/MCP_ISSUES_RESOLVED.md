# Resolved MCP Issues

This is the reverse-chronological closed history for non-defect MCP contract
records. Move newly resolved or verified entries to the top. The legacy records
below were migrated from the mixed tracker on 2026-07-28; same-day ties retain
their migration order.

## MCP-004 - material validation could not resolve inherited stock dependencies

**Status:** Resolved

**Severity:** Non-breaking validation limitation

**Observed:** 2026-07-28

**Closed:** 2026-08-03

**Resolution:** The path-bound material helper no longer delegates texture
reference checks to the stock `MaterialValidatorUtils.CheckTextures` routine.
That routine requires source metafiles only to derive absolute source-texture
paths for a separate consumer, but this helper never consumes those paths.
Packed base-game textures can therefore be registered and loadable without
exposing the loose source metadata that routine expects.

The helper now validates each effective `.edds` reference directly: malformed
or unresolved GUIDs remain fatal, and the stock slot/suffix compatibility check
still runs. Standalone `action: "texture"` validation continues to require
registered source metadata because it actually inspects import configuration.
The public tool description and focused response tests state the same split.

**Verification:** Workbench 1.7.0.54 compiled the PC WorkbenchGame module with
no script errors for helper build
`080399d444e0815b73cedf1b7542e562361c55e88ccf28f8c28b12de873893d1`
(bundle
`5019e91efdc60776bbed454975d799d7d7d46dcf1ccc9bbc74aad693578a7d14`).
Live validation of Arcade Vehicles' Sedan Body Blue, Body Red, Interior Blue,
and Interior Red wrappers returned `status: "ok"`, `valid: true`, and no fatal
or metafile findings. Each retained the same 14 inherited severity-2 material
advisories, confirming the result still reports real nonfatal checks.

Two isolated registered negative fixtures also remained fail-closed. A missing
texture GUID returned exactly one severity-3 unresolved-GUID finding, while an
NMO texture assigned to `BCRMap` returned exactly one severity-3 incompatible
slot finding; both returned `valid: false`. Each acceptance transaction first
qualified the exact new helper identity above. Final diagnostics confirmed that
Workbench was absent, the endpoint refused connections, and the shared
lifecycle was vacant after acceptance cleanup. TypeScript typecheck and build,
helper manifest consistency, 21 focused helper/tool/Enforce-contract tests, and
the packed production-install/CLI smoke check also pass. After cleanup, both
real multi-process lifecycle ownership tests passed against the vacant endpoint.

## MCP-053 - graphical launches could still opt into tiny windows casually

**Status:** Resolved

**Priority:** P1

**Observed:** 2026-08-03

**Closed:** 2026-08-03

**Decision:** Native borderless fullscreen is the normal graphical Observer
launch. Screenshot dimensions are an output concern handled by
`observer_capture.image`; they are not a reason to shrink the renderer. A
non-native window must be an explicit exception rather than an arbitrary launch
argument.

**Resolution:** `observer_prepare_launch` now refuses raw `-window`,
`-screenWidth`, and `-screenHeight` tokens at both the public MCP boundary and
the private launch normalizer. The only supported direct override is the
deliberately named `forceNonNativeWindowSize` object, which requires bounded
width and height plus a 20-to-512-character justification and is invalid for a
dedicated runtime. `observer_runtime` preserves the prepared choice and exposes
no second display-size control.

The obsolete 1280x720 override was removed from the live Workbench Observer
acceptance launcher, and its shared launch helper now rejects display-size
tokens so the override cannot return accidentally. Runtime acceptance launch
helpers follow the same policy. Public tool descriptions, the Observer guide,
maintainer documentation, coding-agent guidance, release notes, and the older
MCP-036 record now agree on the superseding contract.

**Verification:** Seven focused schema, preparation, HTTP, persistence, runtime
argument, and Workbench acceptance-contract suites pass 57/57 tests. TypeScript
typecheck and both package builds pass. The packed tarball passes a fresh
production-only install, both advertised CLI binaries, Enforce descriptors, and
public-projection/mailbox import checks. After building the package, the
complete offline suite passes with only
`tests/workbench/multiprocess-lifecycle.test.ts` excluded; that unchanged
Windows test independently refuses its initial idle lease claim in this
environment. Every other test file passes, and an isolated rerun reproduces the
same unrelated refusal. No live Workbench or game runtime was launched for this
change; the retained live runtime procedure still asserts monitor coverage,
popup style, and absence of caption/thick-frame chrome before accepting a
graphical run.

## MCP-047 - project MCP launchers had no safe inspection or same-arguments verification path

**Status:** Resolved

**Priority:** P1

**Observed:** 2026-08-01

**Closed:** 2026-08-01

**Decision:** Keep the AI client, its stdio MCP server, and Workbench as three
separate ownership boundaries. Do not add an all-in-one background launcher:
an external script cannot attach a second stdio server to an already-running
client, and the standalone Workbench runner must not compete with an MCP-owned
lifecycle.

**Resolution:** The packaged `scripts/start-mcp-stdio.ps1` now supplies one
shared project-launcher implementation with three modes. `Serve` is the
protocol-clean default intended only for client registration. `Describe`
validates Node 24+, the built server, configured directories, and ordered
startup arguments, then emits JSON without starting the server or Workbench.
`Verify` sends those same normalized arguments through the bounded compiled-MCP
verifier. Agent and setup guidance now explains client refresh, stdio ownership,
`wb_launch`, and the standalone foreground editor boundary explicitly.

The containing workspace's 13 project wrappers now delegate to that helper.
The migration fixed three incorrect repository-root calculations, added the
missing ArcadeVehicles wrapper, removed ineffective broad add-on roots, and
replaced Roadblock Runners' deleted evidence directory with its two current
vehicle evidence roots. A project-level dependency audit also restored the
specific OnePointZeroOne root required by ArcadeVehicles and the systems root
required by VoroDeploy.

**Verification:** The combined launcher and Workbench regression run passes
51/51 tests, including JSON-only description, exact Verify/Serve argument
parity, Node-version refusal, absence of direct Workbench spawning, and a
dynamic contract check for every adjacent `.gproj` launcher, including local
dependency visibility. TypeScript typecheck passes. All 13 real project
wrappers pass `-Mode Verify` with a 58-tool MCP handshake, and the
installed-package smoke test passes with the shared launcher present. These
checks launched bounded verifier processes only; they did not launch Workbench
or a game runtime.

## MCP-046 - generic `wb_launch` repeatedly minimizes the attended editor

**Status:** Resolved

**Priority:** P1

**Observed:** 2026-08-01

**Closed:** 2026-08-01

**Decision:** A fresh generic `wb_launch` and every `wb_restart` now leave the
normal, focusable attended Workbench window policy in place. Reuse does not
alter an existing window's state. The public tool does not expose background
mode; minimize-without-activation remains a retained low-level spawn capability
that no MCP tool selects.

**Resolution:** `buildMcpEditorLaunchPlan()` now selects `showWindow: "normal"`,
matching target-resource and foreground CLI editor plans. Tool descriptions,
setup guidance, coding-agent guidance, and guided prompts state the attended
contract. The retained native background helper tracks every top-level window
handle it has handled and minimizes each distinct handle at most once. It can
still catch a later main window after a splash window, but it cannot repeatedly
undo a user's restoration of the same window during its 120-second discovery
period.

**Verification:** Five focused suites pass 46/46 tests. Launch-plan and
controller transaction coverage prove generic launch and replacement restart
both select `showWindow: "normal"` and schedule no minimize calls. Lifecycle
coverage retains the explicit background, normal-window, and nonfatal-helper
contracts. The bundled Windows helper compiled and passed its native process,
endpoint, mutex, and exact-termination tests, while a source contract verifies
per-window handle deduplication. No live Workbench process was launched during
this offline verification.

## MCP-035 — decide whether exact-owned runtime profile logs are supporting evidence

**Status:** Resolved

**Priority:** P1

**Closed:** 2026-07-31

**Decision:** Admit only the assigned `script.log` of a selected, completed
exact-owned runtime capture. `observer_prepare_launch` now assigns a relative
session-specific `-logsDir` beneath the exclusive engine profile and refuses
caller-supplied replacements. Managed profile directories are not added to the
global supporting-log allowlist.

**Authority:** When runtime capture completion is committed, the private agent
mints a durable run-record grant binding run ID, normalized capture label,
session ID, exact runtime ID and generation, canonical profile, and exact
`script.log` path. The public schema exposes only
`{ kind: "relevantLog", label, sourceCaptureLabel }`; caller-supplied runtime
identity, generation, profile, and path fields cannot mint or replace a grant.
The referenced capture must be completed, selected for export, runtime-backed,
and privately granted by a currently retained exact-owned lifecycle.

**Compatibility and security:** The explicit `path` form remains supported for
regular text files beneath configured `supportingLogRoots`, preserving external
launch and operator-managed log workflows. Both forms reuse the same bounded
regular-file, symlink/junction, source-identity, replacement-during-read, UTF-8,
redaction, copy, hash, manifest, and receipt checks. The semantic manifest entry
records its source capture label without exposing the profile path or grant.

**Verification:** Observer coverage passes 481/481 tests. It includes automatic
redacted export, private grant durability and non-disclosure, external/unowned
and unselected capture rejection, other-profile and private-file denial,
caller-supplied `-logsDir` rejection, junction escape rejection, and a
deterministic source-replacement race. The full repository test suite,
typecheck, unused-code analysis, both production builds, compiled MCP
handshake/tool-registration verification, protocol check, and Observer source
manifest checks also pass.

## MCP-031 — review the implemented `game_duplicate` contract

**Status:** Resolved

**Priority:** P0

**Closed:** 2026-07-31

**Related implementation records:** MCP-012, MCP-013, and MCP-045

**Decision:** Approve `game_duplicate` as an `.et`-only prefab tool. It keeps
`register=false` as an offline-copy mode and never launches Workbench for
`register=true`; registration requires an already-running Workbench targeting
the exact destination project. `.conf` copying remains unsupported because it
does not need the prefab ancestry and entity-ID transformations performed by
this tool, and should be considered separately with its own contract and tests.

**Hardening:** Source prefab leaves can now be loaded from PAK files as well as
extracted or loose game data, matching ancestry resolution. Deferred
`wb_resources(action: "register")` recovery now accepts only an absolute,
existing resource file contained by the exact active project's canonical addon
directory. Copied-but-unregistered files remain recoverable partial successes;
structured status fields remain part of the broader output-schema work.

**Verification:** Focused path, duplication, ancestry, PAK, resource-tool, and
helper-status coverage passes 61/61 tests, including PAK-only leaf duplication,
invalid source traversal, and cross-project deferred-registration rejection.
The full repository test suite, typecheck, unused-code analysis, compiled MCP
build, and fresh-process MCP handshake/tool-registration verification also pass.

## MCP-007 — guarded build did not classify a Workbench access violation

**Status:** Resolved

**Severity:** Breaking validation limitation

**Closed:** 2026-07-31

**Observed behavior:** `wb_build` for `OnePointZeroOneTestContent.gproj`
terminated twice with Windows status `0xC0000005`, no output tree, and no
`validationFailure`. The receipt failed closed but exposed only the numeric
exit, so callers could not distinguish the engine crash from an ordinary
nonzero Workbench exit.

**Resolution:** Runner editor and build receipts now derive a structured
`exitStatus.classification` while preserving the raw reason, exit code, signal,
and timeout fields. Windows error statuses are normalized to unsigned
eight-digit `nativeStatus` values, and known statuses receive an
`exceptionName`; `0xC0000005` is reported as `windows_exception` and
`STATUS_ACCESS_VIOLATION`. Signed and unsigned representations normalize to the
same result.

`validationFailure` remains reserved for post-exit output-attestation failures
after a zero native exit. A Windows exception therefore remains an MCP error
with `output: null` and `validationFailure: null`, but it is no longer
ambiguous. The standalone CLI maps native statuses outside its portable exit
range to exit code `1`. Guidance explicitly rejects automatic crash retries
and the runner does not collect private crash-dump contents.

The underlying Workbench engine or project crash is not treated as an MCP
defect: the guarded lifecycle already proved exact ownership and cleanup, and
no MCP output can certify a build that the native process did not complete.

**Verification:** Focused runner coverage exercises successful, ordinary
nonzero, timeout, unsigned access-violation, and signed access-violation exits.
The MCP tool coverage verifies that unsuccessful receipts remain `isError` and
retain their structured classification, and CLI coverage verifies portable
exit-code mapping and normalized access-violation metadata.

## MCP-002 — a running stdio MCP does not reload a repaired local build

**Status:** Verified — accepted behavior

**Severity:** Non-breaking workflow limitation

**Closed:** 2026-07-31

**Decision:** Do not add in-process hot reload or self-restart behavior. The
client owns the stdio MCP process and session, while the server loads its
modules, registered tools, staged-file policy, and lifecycle state at process
startup. A client refresh or restart is the safe boundary that starts the
rebuilt server and renegotiates the MCP session.

Contributor and client guidance now states that every local `npm run build`
must be followed by an MCP-server refresh or client restart before testing the
rebuilt code. `wb_restart` restarts only the exact MCP-owned Workbench process;
it does not reload the MCP server. `npm run mcp:verify` checks a separate fresh
process and likewise does not replace a server already running in a client.

**Verification:** The server entry point establishes one stdio transport for
the process and disposes its owned resources when that process terminates. The
original stale generated `UserMaps.desc` observation was the separate MCP-001
helper-staging defect; its generated-file handling and cleanup were fixed and
verified independently.

## MCP-043 — fullscreen observer captures can exceed retained-image limits

**Status:** Resolved

**Priority:** P1

**Closed:** 2026-07-31

`observer_capture` now accepts an optional `image` policy with independent
fit-inside `maxWidth` and `maxHeight` bounds and `png`, `jpeg`, or `webp`
output. JPEG and WebP accept a bounded optional quality and otherwise use the
configured default; PNG remains lossless and rejects quality. Omitting the
policy preserves native-resolution PNG behavior. The normalized policy is part
of capture idempotency and recovery identity.

Runtime BMP and Workbench PNG intake share the pinned asynchronous
`@napi-rs/image` 1.14.0 transformation service. Workbench uses
`System.GetRenderingResolution`, `System.MakeScreenshotRawData`, and
`Workbench.SavePixelRawData` to persist the requested fit-inside PNG while the
callback-owned pixels are valid, before host transcoding or durable promotion.
The retained artifact, MCP content, recovery record, evidence manifest, and
finalization receipt bind the actual format, MIME type, extension, dimensions,
quality, bytes, digest, source provenance, and requested policy. Existing PNG
records remain readable and all source, decoded-pixel, retained, inline, and
aggregate limits remain enforced.

**Live verification:** The v4 positive-path Workbench acceptance passed on
Workbench 1.7.0.54 and Node.js 24.18.0. Its 288x288 World Editor source viewport
was reduced to 192x192 before PNG persistence and host retention. Six finalized
captures included PNG, JPEG quality 61, JPEG quality 68, and WebP using the
exact default quality 75 with their correct MIME types and extensions. The
procedure also proved completed-request replay, an in-flight cancellation,
pose and look-at restoration, post-cancellation capture, manifest validation,
managed release, exact-owned shutdown, and zero remaining Workbench or
supervised child processes. The same producer path computes its destination
from the reported source viewport, so larger and fullscreen viewports do not
materialize a native-size Workbench PNG first.

**Failure verification:** Direct tests cover a valid final encoding above the
retained-byte limit, injected decoder failure, a one-shot injected encoder
failure before atomic promotion followed by successful recovery, post-promotion
recovery, and exact explicit/default quality metadata across recovery. Failed
transformations neither promote partial output nor discard the recoverable
source.

**Release verification:** The package, lockfile, and server version are 1.2.0;
the current operator and agent guides describe the resolution/format/quality
contract, and the v1.2.0 notes are required package content. Node 24 clean
install, protocol check, unused-code check, byte-stable protocol generation,
MCP and Observer builds, typecheck, the complete Vitest suite, and both online
cache-warming and offline installed-tarball package checks passed. The earlier
peak-memory benchmark suggestion is not a release gate: reviewed hard limits
bound allocation and retention, while the live operational baseline records
the representative capture timings and environment without imposing a
hardware-specific performance threshold.

Producer-side runtime raw-data capture remains a separate optional
optimization. Runtime output is already bounded before durable artifact
promotion, so that optimization is not required to resolve this issue.

## MCP-003 — evidence runs may span a Workbench lifecycle restart

**Status:** Resolved

**Closed:** 2026-07-29

Completed captures are retained as backend-neutral run artifacts. Their
instance and world identity remain in each capture record, but a later
Workbench lifecycle does not invalidate an already completed artifact.
`ObserverRunStore.finalize` validates only the selected labels, their retained
completed artifacts, review data, and export integrity; `discard` releases the
same retained artifacts without a current-Workbench lifecycle check.

Capture submission remains lifecycle-fenced, so a capture cannot be accepted
from a stale observer. The resulting evidence bundle identifies each selected
capture's instance and world, allowing review of a deliberately mixed-lifecycle
bundle without silently attributing its images to one Workbench session.

**Verification:** `tests/observer/runs.test.ts` creates two completed
Workbench captures with distinct instance and world identities, then finalizes
both in one reviewed bundle. The focused test suite passed (15 tests) without
starting an MCP host, Workbench, or Arma client.

## MCP-039 — provide a safe way to release or transfer an idle lifecycle lease

**Status:** Resolved

**Priority:** P0

**Closed:** 2026-07-28

**Decision:** Preempt a provably idle lease at claim time instead of building a
cooperative release/transfer protocol between MCP hosts.

The root cause was that the lease had no release path at all: `mcpOwner` was
never cleared, so a claim survived for the owning process's entire lifetime.
`validateAndClaimLocked` recovered a dead owner but refused a live one purely
because its PID still resolved, even when the record was quiescent.

`WorkbenchProcessGuard.validateAndClaimLocked` now consults
`provenIdleLease` before refusing a live owner, and claims with the new
`source: "idle_owner"` when every one of these holds:

- the durable record is `phase: vacant` with no `workbench` and no `operation`
- no Workbench process exists (a strict scan, not a best-effort one)
- the NET API endpoint is positively `vacant`
- the recorded owner has the same Windows user SID (unchanged precondition)

Anything unproven — an unverifiable process scan or an unverifiable endpoint
probe — keeps the lease with its current owner and returns
`OWNED_BY_OTHER_MCP` with the specific reason it was not idle.

A cooperative request to the owner was deliberately not built. Every operation
the lease protects (capture, editor session, build, target-bound save, Observer
restoration) requires a live Workbench and is already fenced by
`workbench !== null` plus `phase: running`, so a vacant record is itself the
owner's durable idle attestation. Asking the owning process would add a channel
and a new class of hangs without adding evidence. A heartbeat/expiry contract
was also rejected: it is time-based, and it can revoke a lease from an owner
whose Workbench is live but whose event loop is briefly blocked.

Safety rests on two existing invariants rather than on process termination.
The whole decision runs inside the machine-wide lifecycle mutex, so concurrent
claims cannot interleave, and `transitionLocked` refuses any mutation whose
generation and lease id were superseded. A preempted owner is never signalled;
its next mutation fails `GENERATION_MISMATCH` and it recovers by re-claiming.

Clearing `mcpOwner` inside `transitionToVacant` was evaluated and rejected as
unsafe. Several flows — `ensureRunningCoordinated` in particular — pass through
a vacant record as an intermediate state of one larger owned operation and then
reacquire across a separate lock acquisition, so releasing there would open a
window for a competing MCP mid-launch. Preemption covers those cases anyway,
because it recovers any vacant lease regardless of how it was left behind.

`wb_diagnose` lifecycle evidence gained `leaseOwner` (owning pid, instance id,
lease id, claim time) and `leasePreemptible`, so the owning session can be
identified without terminating an OS process.

**Verification:** Focused regression coverage in
`tests/workbench/process-guard.test.ts` for idle-owner preemption, the
preempted owner's `GENERATION_MISMATCH` fence and re-claim, and refusal for a
running Workbench, an in-progress operation, an occupied endpoint, an
unverifiable endpoint, a live unowned Workbench process, an unverifiable
process scan, and a different Windows user. `tests/workbench/diagnostics.test.ts`
covers the new lease projection. `tests/workbench/multiprocess-lifecycle.test.ts`
proves the handoff across two real live Node MCP processes on Windows: the
contender takes the idle lease with `source: "idle_owner"`, neither process is
terminated, and the previous owner is refused with `OWNED_BY_OTHER_MCP` once
the new owner reserves the lease. The full Vitest suite (1820 tests),
TypeScript typecheck, and knip passed.

## Historical and verified records

## MCP-030 — remove configured `projectPath` targeting

**Status:** Resolved

**Priority:** P0

**Closed:** 2026-07-28

**Decision:** Remove `projectPath`, `defaultMod`, their CLI flags, and
container-scanning target selection. Addon-scoped tools accept the exact
`.gproj` through `gprojPath` or, where supported, derive it from the verified
running Workbench lifecycle. `mod_create` instead receives an explicit
`outputDir`.

Base-game and standard Workshop addon roots remain automatically discovered.
Nonstandard roots are additive through `workbenchAddonDirs` or repeated
`--workbench-addon-dir` flags. Dependency preflight searches those effective
roots plus target-relative candidates; it does not search arbitrary filesystem
locations.

**Verification:** Configuration rejects the retired settings and flags;
target-resolution, project-identity, generators, duplication, prompts, setup,
and Workbench lifecycle tests cover exact and active targeting. The full
Vitest suite, TypeScript typecheck, and production build passed.

## MCP-029 — `observer_capture` uses only the opaque world revision

**Status:** Resolved

**Priority:** P0

**Closed:** 2026-07-28

**Decision:** The public `observer_capture` contract requires
`expectedWorldRevision` from the immediately preceding `observer_instances`
result. It does not support `expectedWorldId`, `expectedWorldEpoch`, legacy-pair
requests, or dual-form requests. Inventory and result metadata retain nullable
world-ID and epoch projections for diagnostics, while the internal runtime
protocol may project the opaque revision back to those fields.

A canonical revision may represent a graphical runtime with no loaded world.
That state permits `current` capture and rejects `pose` or `lookAt` until an
active world is available.

**Verification:** The registered MCP schema requires
`expectedWorldRevision`, omits both removed fields, and rejects additional
properties. Capture normalization, runtime and Workbench backends, durable-run
reservation, current-view null-world behavior, acceptance/failure-matrix
callers, package guidance, and MCP response tests use the canonical revision.
The focused observer contract suite passed 97 tests; the full Vitest suite,
TypeScript typecheck, MCP build, and Observer build also passed.

## MCP-026 — old release notes describe their release-time API surface

**Status:** Verified

**Closed:** 2026-07-28

The relevant legacy release notes are labeled as historical records, and
archived plans are not live API reference. Current MCP schemas and guides are
the present-behavior source; historical material is not used by verification or
package contracts as canonical documentation.

## MCP-018 — explicit resource save workflow

**Status:** Verified

**Closed:** 2026-07-28

The supported guarded save flow is:

```text
wb_launch(gprojPath, resourcePath) -> target-bound edits ->
wb_save_resource(confirm: "save", resourcePath)
```

The target must be the same `.ent` or `.et` resource supplied at launch.

## MCP-017 — evidence roots are needed only for finalization

**Status:** Verified

**Closed:** 2026-07-28

`observer_run finalize` requires a configured allowlisted evidence destination.
Run begin, capture, status, and discard remain available without one; a
caller-supplied path cannot bypass an empty allowlist.
