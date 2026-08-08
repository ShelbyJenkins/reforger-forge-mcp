# Resolved MCP Bugs

This is the reverse-chronological closed history for fixed MCP defects. Move
newly resolved bugs to the top. The legacy records below were migrated from the
mixed tracker on 2026-07-28; same-day ties retain their migration order.

## Resolved defects

## MCP-059 - launch-planner filesystem evidence is not fully fail closed on Windows

**Status:** Resolved

**Severity:** P1 - concurrent replacement can escape the advertised exact-evidence boundary

**Observed:** 2026-08-05

**Closed:** 2026-08-06

**Resolution:** Supported Windows evidence reads now cross one bundled native
boundary that owns the `CreateFileW` handle. It opens the requested object with
`FILE_FLAG_OPEN_REPARSE_POINT`, obtains a nonzero `FILE_ID_INFO` volume and
128-bit file ID plus the Node-compatible handle identity, obtains and matches
the final handle path, reads and hashes the bounded content through that same
handle, compares before/after handle snapshots, and reopens the requested path
to prove that it still names the handle that supplied the evidence. Zero or
unavailable identity, leaf reparse points, ancestor reparse traversal, path or
handle replacement, oversize input, an unavailable helper, and incomplete
protocol evidence all fail closed. World, add-on-manifest, and resource-meta
readers route through this boundary before the non-Windows `O_NOFOLLOW` path;
their persisted evidence now retains the complete native volume/file ID and
their failures remain typed planner refusals. The helper is addressed by an
absolute PowerShell path and a package-root-relative script path in source
workers, compiled workers, and fresh production installs.

**Verification:** The Windows identity, native-boundary, architecture,
source-worker, and package-contract run passes 19/19. The world, add-on, and
resource-meta planner run passes 34/34, including deterministic zero identity
and replacement plus real hard-link, file-symlink, and ancestor-junction cases.
An isolated `game_launch` start plus exact retry passes in 5.672 seconds; the
single-start event-loop fixture passes in 4.293 seconds. `npm run test:package`
performs a clean build, verifies a 1,116-file tarball, installs it with production
dependencies, imports the compiled same-handle module, and successfully executes
its bundled helper. Typecheck and `git diff --check` pass. Filesystems that
cannot return the required nonzero identities or final handle path remain
explicitly unsupported for this proof and are refused rather than weakened.

## MCP-066 - case-sensitive Windows paths collapse launch containment and provider identity

**Status:** Resolved

**Severity:** P2 - supported filesystem semantics can cross an exact project/provider boundary

**Observed:** 2026-08-05

**Closed:** 2026-08-06

**Resolution:** Canonical-path keys now preserve native-realpath spelling instead
of unconditionally lowercasing Windows paths. Project containment, world
selection, add-on-root deduplication, and manifest-provider identity therefore
keep distinct case-sensitive siblings distinct. Where stable filesystem identity
is unavailable, the associated launch evidence fails closed rather than using
case-folding as a substitute.

**Verification:** Focused file-identity and planner tests pass 29/29, including
exact canonical-case assertions, and the broader dependent containment/provider
set passes 117/117. Typecheck also passes. The separate Windows same-handle
reparse-race boundary is resolved under MCP-059.

## MCP-063 - observer-agent close marks cleanup complete before forced exit is observed

**Status:** Resolved

**Severity:** P2 - private-child termination and stdio cleanup are not observed before clean close

**Observed:** 2026-08-05

**Closed:** 2026-08-06

**Resolution:** Forced private-child shutdown now remains pending until both the
exact child `exit` and stdio `close` events are observed within the remaining
absolute shutdown deadline. A false or throwing kill and missing exit/close
evidence remain explicit retryable cleanup failures; they are never published
as a clean closed state.

**Verification:** The agent-client shutdown suite passes 12/12 and distinguishes
signal delivery from delayed close, false kill, missing termination evidence,
and the successful exact exit-plus-close path.

## MCP-062 - managed client registrations discard the Node executable that setup verified

**Status:** Resolved

**Severity:** P2 - installed desktop registrations can fail or run a different Node version

**Observed:** 2026-08-05

**Closed:** 2026-08-06

**Resolution:** The server-verification report now carries the exact absolute
Node executable path it exercised. Every managed registration persists that
path, and registration inspection, drift checks, doctor output, and setup
receipts compare and report the same verified executable rather than resolving
ambient `node` from a GUI client's PATH.

**Verification:** The focused setup, registration, verification, doctor, and
receipt suites pass 100/100, including empty/conflicting PATH fixtures and exact
absolute-command drift assertions.

## MCP-057 - existing-only Workbench LMDB inspection can crash a fresh host

**Status:** Resolved

**Severity:** P1 - native host termination during a supported read-only idle probe

**Observed:** 2026-08-05

**Closed:** 2026-08-06

**Observed behavior:** While another MCP/Workbench lifecycle had the shared
Workbench v3 LMDB environment mapped, a fresh production process calling the
existing-only lifecycle reader could terminate with Windows exception
`0xC0000005` before JavaScript received a result.

**Cause:** `lmdb` 3.5.6 performs read-only DBI opening in native code and its
installed `open.js` implementation itself records a race around updating DBI
state outside the lock. A native access violation cannot be caught or converted
to a refusal inside the process that mapped the environment.

**Resolution:** A fresh MCP host no longer maps the Workbench environment in
its own address space for idle readiness. One bounded, minimal-environment Node
subprocess opens the already-existing environment read-only, retains that one
handle while reading both lifecycle and spawn-journal records, and returns a
bounded projection that is strictly revalidated by the parent. Abnormal exit,
timeout, invalid protocol output, and reader errors become malformed evidence
and therefore `INCOMPLETE_PROOF`; hard failures are retained to prevent a crash
respawn loop. Timeout and cancellation request termination and wait for exact
child transport-close evidence under a separate one-second cleanup bound; a
missing close becomes a distinct fail-closed cleanup failure. A process that
already owns an open writer continues to reuse that exact handle. Missing
storage remains uncreated and the reader exposes no durable-state mutation API.

The underlying native-library defect remains isolated rather than claimed
fixed. The exact default-root MCP-056 acceptance was not run during closure:
both default stores existed while an attended Workbench and multiple MCP/Node
hosts were active. The status remains precisely snapshot/live-composition
validated with default-root acceptance deferred until that shared-state gate is
safe to execute.

**Verification:** The crash-isolation suite covers missing-root noncreation, a
fresh reader against a disposable environment whose writer remains mapped in
another process, unchanged `data.mdb` size/mtime, abnormal child exit, absolute
timeout, cancellation, exact child-close/PID cleanup before settlement, stable
hard-failure projection, and crash-storm suppression. Combined readiness maps a
failed projection to `INCOMPLETE_PROOF`. The focused isolation, store,
readiness, architecture, and package-contract run passes 107/107; Stage 3 passes
373/373; and the cross-process/readiness run passes 26/26 with one explicit
machine-precondition skip because an unowned Workbench is running. Typecheck,
the full compiled build, and `git diff --check` pass. A compiled-worker
live-writer smoke returned without changing `data.mdb`, and the packed-package
check verified 1,103 files plus a fresh production-only install and both bins.

## MCP-054 — `wb_log_query` misses error-level editor diagnostics

**Status:** Resolved

**Severity:** P2 — hides relevant diagnostics and forces raw-log fallback

**Observed:** 2026-08-04

**Closed:** 2026-08-04

**Observed behavior:** In a live exact-owned Workbench editor session,
`wb_log_query` found all three attributed log files but returned zero matches
for `levels: ["E"]`, while the same directory's raw `error.log` contained
ordinary `SCRIPT (E)` and compact `PATHFINDING(E)` records.

**Cause:** The shared Enfusion line parser expected the channel at column zero
and required whitespace before the level marker. Editor records carry an
`HH:mm:ss.SSS` prefix, may align the channel with additional leading spaces,
and may omit the gap before `(E)`.

**Resolution:** Severity and channel parsing now accepts the timestamped,
alignment-padded, and compact Workbench spellings while preserving the full
original line for redacted presentation. The registered tool and level-filter
descriptions now state that editor severity is normalized.

**Verification:** Parser and MCP-tool regressions pass 17/17 tests, including
timestamped `SCRIPT    (E):`, `PATHFINDING(E):`, and `RESOURCES (E):` records
distributed across `console.log`, `error.log`, and `script.log`. The full
repository suite, TypeScript typecheck, compiled MCP build and verification
with all 62 tools registered, and unused-code analysis passed. A read-only
inspection of the attributed editor logs confirmed the covered record shapes;
no new Workbench process was launched.

## MCP-051 — `wb_launch` masks project compile failures as an undefined Ping API

**Status:** Resolved

**Severity:** P2 — delays diagnosis and misclassifies a project compile failure

**Closed:** 2026-08-02

**Resolution:** Every fresh Workbench launch now carries a new owner token.
When readiness ends in a launch failure, bounded diagnostics inspect only the
managed profile's recent, unambiguously owner-attributed log directory. A
`Can't compile "<module>" script module!` marker is reclassified as
`PROJECT_COMPILE_FAILED`, and `wb_launch` reports the module, first relevant
compiler diagnostic, and exact `script.log` path. The controller scans both
before and after rollback to allow for log flushing, preserves identity and
recovery failures as authoritative, and exposes the last compiler failure in
`wb_diagnose` until the next actual fresh-launch attempt.

**Verification:** Parser and launch integration coverage exercises the observed
absolute readiness timeout whose last Ping error is `Undefined API func`,
owner-token attribution, bounded and ambiguous logs, diagnostic extraction,
post-rollback log discovery, identity-error precedence, and diagnosis cleanup.
The combined regression run passed 126/126 tests; the full repository suite,
typecheck, build, compiled MCP verification, unused-code check, manifest and
protocol checks, and packed-package smoke install also passed. A live broken
RainbowVeil launch followed by a fixed relaunch was not repeated.

## MCP-050 — registered `.ptc` resources cannot be opened in Particle Editor

**Status:** Resolved

**Severity:** P2 — attended resource navigation failure with a manual workaround

**Closed:** 2026-08-02

**Resolution:** Registered `MetaFile` resources are now validated before any
World Editor requirement, and `.ptc` navigation delegates to the global
`Workbench.OpenResource` router so Workbench can select Particle Editor even in
`no_world_editor` mode. `wb_resources(getInfo)` recognizes `.ptc` metadata and
returns its registered resource name, GUID, resource/config class, source path,
editor type, and config count; other resource types retain their native path.

**Verification:** Resource-tool and helper-contract coverage passes registered
`.ptc` identity through both open surfaces, verifies Particle Editor routing
without a World Editor document, checks structured metadata, and preserves the
existing behavior for other resource types. The combined 126-test regression
run, full repository suite, typecheck, build, manifest verification, and package
smoke install passed. A live registered RainbowVeil particle was not opened in
an attended Particle Editor during this close-out.

## MCP-049 — `wb_launch` closes the MCP transport before starting Workbench

**Status:** Resolved

**Severity:** P1 — blocks all Workbench lifecycle and diagnostic tools

**Closed:** 2026-08-02

**Resolution:** The Windows machine-mutex holder-loss path no longer ignores
its lease-loss callback and unconditionally aborts the long-running MCP host.
Loss now synchronously fences lifecycle work and returns structured
`RECOVERY_REQUIRED` when durable mutation can be stopped. Lifecycle sessions,
LMDB writes, compare-and-swap operations, and spawn-journal updates recheck that
fence at their commit boundaries. Exact native termination remains deliberately
non-cancellable and fail-stop if the holder cannot be fenced safely.

**Verification:** A Windows stdio integration test starts the actual source MCP,
forces a managed Workbench child to exit during `wb_launch`, receives a
structured launch refusal, and successfully calls `wb_diagnose` through the
same client and transport. Native holder-loss, post-await fencing, LMDB
transaction, and exact-termination tests also pass. The combined regression run
passed 126/126 tests, and the full suite, typecheck, build, compiled MCP
verification, unused-code check, and package smoke install passed. The original
RainbowVeil transport-loss incident was not replayed live.

## MCP-048 — failed Workbench pose capture retains an unreleasable camera lease

**Status:** Resolved

**Severity:** P1 — disruptive editor-state and lifecycle cleanup failure

**Closed:** 2026-08-02

**Resolution:** A pose installation that is synchronously rejected now rolls
back the entire original camera transaction, including the persistent editor
controller, before Submit yields. Indeterminate verification retains a bounded
rollback obligation for later cancel retries; later exact world, project,
subscene, camera, or projection displacement relinquishes the stale lease
without writing over newer editor state. Nonfinite camera evidence fails closed.
Terminal Workbench jobs release only with an explicit no-held-lease result, and
discard keeps held or unreachable cleanup actionable and retryable. Durable job
records cannot be swept before a release receipt, and nested runtime lease state
is projected into the shared restoration contract without treating missing
proof as success.

**Verification:** The observer safety suite passed 85/85 tests, Stage 4 passed
113/113, and fault-matrix/helper coverage passed 78/78. It covers normalized and
partial installation rollback, temporarily unmeasurable projection, user/world
displacement, nonfinite evidence, viewport changes, terminal held-lease discard,
transport loss, later cancel/release recovery, runtime lease projection, and
handler retention until receipt. Protocol-only Enforce validation, protocol and
manifest checks (Workbench helper digest
`fd64ed0a4f279a4a473bb728ebc020baa15806ab7358a6440f294f5d397f8bda`), the
full repository suite, typecheck, build, and package smoke install passed. No
attended Workbench camera acceptance or native ScriptEditor compile was run.

## MCP-045 — `game_duplicate` source lookup could escape configured data roots

**Status:** Resolved

**Severity:** P1

**Closed:** 2026-07-31

**Resolution:** Game-resource references now pass through a shared normalizer
that permits one valid resource GUID prefix but rejects absolute,
drive-relative, traversing, empty-segment, malformed-GUID, and NUL-containing
paths. Loose-file lookup resolves every direct and `Data`-prefixed candidate
through link-safe canonical containment and requires a regular file, so callers
such as prefab ancestry fail closed at the configured data-root boundary.
`game_duplicate` validates the source before any read or destination write.

**Verification:** Focused coverage passes 61/61 tests. It exercises accepted
direct and `Data`-prefixed resources, traversal and absolute forms, malformed
GUID prefixes, and a concrete `game_duplicate` sibling-file escape attempt that
is rejected without creating a destination. The same run covers the associated
PAK-leaf and deferred-registration hardening approved under MCP-031. The full
repository test suite, typecheck, unused-code analysis, compiled MCP build, and
fresh-process MCP verification also pass.

## MCP-042 - `wb_component` reports an added prefab component that `wb_save_resource` drops

**Status:** Resolved

**Severity:** P0

**Closed:** 2026-07-31

**Resolution:** Prefab Edit Mode component operations now target the
serializable prefab-template ancestor and verify their component-count delta.
The public component and entity-modification tools can address an unnamed
prefab root by `entityIndex`. Before native save, an inherited `.et` containing
an explicit empty nested component override is refused and its target session
is tainted, preventing the known lossy-success path.

**Verification:** The disposable live explicit-save acceptance added a custom
script component to an unnamed prefab root, configured its attributed value to
`42`, saved it, and verified the component and value after a fresh Workbench
reopen. A separate inherited prefab with an explicit empty array override was
refused before native save; dispatch count and source bytes remained unchanged,
and the tainted session rejected a second save. Focused and repository-wide
offline tests also passed.

## MCP-040 - loose-resource registration deadlocks behind World Editor edit mode

**Status:** Resolved

**Severity:** P0

**Closed:** 2026-07-31

**Resolution:** The Workbench state helper now reports `no_world_editor` when
there is no document and `GetGame().InPlayMode()` is false. `wb_resources` uses
a ResourceManager-specific mode guard that permits this generic state while
continuing to reject actual Play mode.

**Verification:** The disposable live lifecycle acceptance launched generic
Workbench, observed `no_world_editor`, registered a loose `.et` and `.ent`
without metadata, and verified distinct generated GUIDs plus responsive bridge
ping. Fresh target-bound Workbench sessions then opened and saved both
registered resources successfully, with final exact process vacancy.

## MCP-036 - managed server launch is not borderless and steals foreground focus

**Status:** Resolved

**Severity:** Disruptive runtime-launch behavior

**Closed:** 2026-07-31

**Resolution:** Managed graphical acceptance launches no longer inject
`-window` or fixed screen dimensions. Launch preparation retains
`-noFocus -forceUpdate`, and exact-owned graphical launches containing
`-noFocus` additionally use a short-lived Windows startup guard across
Reforger's replacement windows. The guard restores original styles after
initialization. Explicit `noFocus: false` bypasses the guard, caller-supplied
`-window` remains supported, and dedicated runtimes and test runners are not
guarded.

**Superseded window-size policy (2026-08-03):** MCP-053 subsequently removed
the raw `-window` escape hatch. Non-native window sizing now requires the
structured `forceNonNativeWindowSize` exception with a written justification.

**Verification:** An isolated live probe showed that current Reforger still
took focus even with `-noFocus` first, proving argument order was not the cause.
The complete graphical observer acceptance then passed with a visible
borderless fullscreen popup covering the monitor, no foreground ownership
during readiness, successful captures/restoration, and exact shutdown. The
observed foreground PID remained the prior application rather than Reforger.

## MCP-006 — resource registration can stall and disconnect Workbench

**Status:** Resolved

**Severity:** Non-breaking authoring failure

**Closed:** 2026-07-31

**Resolution:** Resource registration and rebuild calls now use a 120-second
operation-specific deadline instead of the generic 10-second deadline. The
`game_duplicate` and `wb_entity_duplicate` registration paths use the same
deadline and cannot auto-launch a replacement Workbench mid-request.

**Verification:** The disposable live lifecycle acceptance registered a loose
prefab, world, and minimal valid material through generic Workbench, verified
distinct generated metadata and bridge responsiveness after each registration,
and reopened/saved the prefab and world in fresh target-bound sessions. The run
finished with exact process vacancy; focused and repository-wide offline tests
also passed.

## MCP-044 - MCP verification rejected the supported `mod.gprojPath` input

**Status:** Resolved

**Severity:** P1

**Closed:** 2026-07-30

**Resolution:** The compiled-server verifier now distinguishes the removed mod
build surface from the supported exact-project `gprojPath` used by mod
validation. It still rejects `action: "build"` and the genuinely removed build
arguments.

**Verification:** `tests/setup/server-verification.test.ts` advertises
`gprojPath` in the valid runtime surface and verifies that registration passes.
The defect was discovered by the read-only `npm run mcp:verify` baseline; no
Workbench or game process was launched.

## MCP-041 — `wb_layers` advertised mutations that the staged helper did not implement

**Status:** Resolved

**Severity:** P1

**Closed:** 2026-07-29

**Resolution:** `wb_layers` now advertises exactly the helper's supported
actions: `list`, `getActive`, `getEntityLayer`, `isVisible`, `getInfo`, and
`toggleLock`. Unsupported create/delete/rename/active-layer/visibility
mutations are no longer registered. Every advertised helper response is checked
for `status: "ok"`, so a helper rejection becomes `isError: true` rather than
a false `Layer Updated` receipt.

**Verification:** `tests/workbench/wb-layers-tool.test.ts` covers schema/helper
parity and a rejected helper action; the focused offline suite and TypeScript
typecheck passed. No Workbench process was launched.

## MCP-038 — `scenario_create_conflict` respects `patrolCount: 0`

**Status:** Resolved

**Severity:** P1

**Closed:** 2026-07-29

**Resolution:** Defender generation uses nullish defaulting
(`base.patrolCount ?? 2`), preserving an explicit zero while applying the
default only when the value is omitted.

**Verification:** The existing zero-value regression in
`tests/templates/scenario.test.ts` passed in the focused offline suite. No
Workbench process was launched.

## MCP-037 — `prefab(action: "create")` corrupted inherited game-mode structure

**Status:** Resolved

**Severity:** P0

**Closed:** 2026-07-29

**Resolution:** Parent-aware prefab creation now uses the resolved leaf
ancestor's root entity class instead of the generic recipe root. It also uses
only direct `components` members when materializing ancestry, so nested
containers cannot be promoted into peer components.

**Verification:** `tests/templates/prefab.test.ts` covers the typed inherited
root, and `tests/utils/prefab-ancestry.test.ts` covers nested-container
exclusion; both passed in the focused offline suite and TypeScript typecheck.
No Workbench process was launched.

## MCP-034 — `observer_run finalize` hid its required capture-label list

**Status:** Resolved

**Severity:** Non-breaking public-contract mismatch

**Closed:** 2026-07-29

**Resolution:** The registered `observer_run` description now states that
finalize requires `runId`, `includeCaptureLabels`, and `review`; the
`includeCaptureLabels` schema property explicitly identifies its finalize-only
requirement. This matches the existing handler validation.

**Verification:** `tests/observer/observer-mcp-tools-schema-responses.test.ts`
inspects the public schema and description through the MCP transport; it passed
in the focused offline suite and TypeScript typecheck.

## MCP-033 — owned `dedicated` runtime launched the game client executable

**Status:** Resolved

**Severity:** Breaking runtime-lifecycle mismatch

**Closed:** 2026-07-29

**Resolution:** Owned-runtime executable discovery is now parameterized by the
prepared runtime kind. `dedicated` selects an allowlisted
`ArmaReforgerServer*.exe`; client, listen-server, and test-runner kinds retain
the graphical executable allowlist. Start, status, and receipt re-attestation
all resolve against the runtime kind on the durable descriptor or receipt.

**Verification:** `tests/observer/owned-runtime-executable-resolution.test.ts`
selects `ArmaReforgerServerDiag.exe` when both executable families exist, and
`tests/observer/owned-runtime-manager-spawn-publication.test.ts` proves start
passes the prepared dedicated kind into the resolver. Both passed offline,
along with TypeScript typecheck.

## MCP-032 — Workbench launch and build disagreed on target-relative dependencies

**Status:** Resolved

**Severity:** Breaking validation failure

**Closed:** 2026-07-29

**Resolution:** MCP-owned editor plans now include the target project's sibling
add-on container, just as guarded target builds do, before dependency preflight
and process spawn.

**Verification:**
`tests/workbench/restart-ownership-addon-dependencies.test.ts` proves an
MCP-owned editor launch resolves a sibling dependency and emits that root in
`-addonsDir`. The focused offline suite and TypeScript typecheck passed; no
Workbench process was launched.

## MCP-010 — guarded build reported a non-vacant endpoint after its process exited

**Status:** Resolved

**Severity:** Breaking validation failure

**Closed:** 2026-07-29

**Resolution:** The native endpoint-vacancy helper treats a retained TCP owner
table row as vacant only after opening the reported PID with a native process
handle proves it has exited or no longer exists. A live or unverifiable PID
remains fail-closed.

**Verification:** `tests/workbench/project-launcher-safety.test.ts` exercises
the actual PowerShell helper against a local loopback listener and then its
vacant endpoint. It passed in the focused offline suite; no Workbench process
was launched.

## MCP-009 — TestContent MCP launch omitted the Core dependency root

**Status:** Resolved

**Closed:** 2026-07-28

**Observed behavior:** A target-bound TestContent launch was refused because
Workbench could not resolve the declared Core dependency GUID
`E62D3489FAA8E058`.

**Cause:** `TestContent/start_mcp.ps1` registered TestContent as a Workbench
addon root but omitted its sibling Core project.

**Resolution:** The launcher supplies both the Core and TestContent addon
roots. The local stdio MCP host must be restarted through that launcher before
retrying because an active host retains its startup configuration.

## MCP-008 — target-bound launch resolved resources from the wrong root

**Status:** Resolved

**Closed:** 2026-07-28

**Observed behavior:** `wb_launch` received the exact TestContent `.gproj` and
project-relative world path
`Worlds/Testing/OPZO_BodyIdentityValidation/OPZO_BodyIdentityValidation.ent`,
but resolved it beneath the repository root and rejected it as missing.

**Cause:** Nonabsolute target paths were resolved from the MCP process working
directory instead of the selected project's `modDirectory`.

**Resolution:** Target canonicalization now resolves relative resources from
the explicit project root. The TestContent launcher also uses the existing
OnePointZeroOne screenshot-evidence directory.

**Verification:** Focused resource-target regression tests and the TypeScript
build pass, including the TestContent-relative `.ent` case. The live launch
reached the MCP but was safely refused because an independent MCP-owned
Workbench lifecycle lease was active; no editor state or resource was changed.

## MCP-005 — Observer opaque and legacy world expectations conflicted

**Status:** Resolved

**Severity:** P0

**Closed:** 2026-07-28

**Observed behavior:** `observer_instances` returned a matching `worldId`,
legacy epoch, and opaque `worldRevision`, but a capture containing all three
could be rejected with `WORLD_CHANGED` because the legacy and opaque values did
not identify the same revision.

**Resolution:** The public contract accepts either canonical
`expectedWorldRevision` or the complete legacy
`expectedWorldId`/`expectedWorldEpoch` pair. Both forms may be supplied only
when they identify the same revision. Absent binding and one-sided legacy
values are rejected, and current guidance prefers the canonical revision.

**Verification:** Observer schema and capture-request regression coverage
exercise canonical-only, complete-legacy, matching dual, mismatched dual, and
partial legacy requests.

**Superseded contract:** MCP-029 later approved `expectedWorldRevision` as the
only public capture binding and removed the temporary legacy and dual forms.

## MCP-001 — Workbench helper staging rejected a normal generated file

**Status:** Resolved

**Severity:** Breaking

**Observed:** 2026-07-28

**Closed:** 2026-07-28

**Observed behavior:** `wb_launch` failed with `LAUNCH_FAILED` and reported an
incomplete helper payload after Workbench had previously opened the staged
helper.

**Cause:** Workbench writes `UserMaps.desc` beside the helper. The staging
policy allowed `resourceDatabase.rdb` but not that second normal generated
file, so the next launch failed closed.

**Resolution:** Added `UserMaps.desc` to the exact staged-only generated-file
allowlist in `src/workbench/helper-addon.ts` and extended
`tests/workbench/helper-addon.test.ts` to cover both generated files.

**Verification:** The focused helper-addon suite passed 10 tests and the
TypeScript build passed. The exact stale generated cache file was removed so
the observed Workbench session could launch.

## MCP-025 — live acceptance recreated the removed validation-docs folder

**Status:** Resolved

**Closed:** 2026-07-28

The opt-in runtime and Workbench Observer acceptance harnesses previously
defaulted their baseline artifacts to `docs/validation`, recreating a removed
repository directory. They now default beneath their externally confined
acceptance artifact root; callers can still choose an explicit publication
directory with `--validation-root`.

## MCP-024 — live guides linked from the README were omitted from packages

**Status:** Resolved

**Closed:** 2026-07-28

The npm package now includes the linked Observer guide, runner guide, and
contribution guide, and package verification requires them. This keeps package
README links usable after installation.

## MCP-023 — verification parsed a removed README tool table

**Status:** Resolved

**Closed:** 2026-07-28

Runtime verification and setup receipts previously treated the root README's
hand-maintained tool table as an API oracle. The verifier now inspects the
registered MCP tools directly, rejects duplicate/refusal-only tools, and
requires a nonempty runtime description. This makes the runtime registration,
not prose, the source of truth for the verification check.

## MCP-022 — case-sensitive package entry for `SETUP.md`

**Status:** Resolved

**Closed:** 2026-07-28

The documentation file is now `SETUP.md`; package metadata and package-contract
coverage now use that same case, including on case-sensitive publish targets.

## MCP-021 — removed validation path remains in configuration example

**Status:** Resolved

**Closed:** 2026-07-28

`reforger-forge.config.example.json` previously pointed evidence output at the
removed `docs/validation` path. It now uses an explicit managed evidence-root
example.

## MCP-020 — model GUID availability in `asset_search`

**Status:** Resolved

**Closed:** 2026-07-28

`asset_search(type: "model")` now returns indexed GUID-prefixed `.xob`
references when the resource database contains them. Prefab and prompt guidance
directs model discovery there rather than to `api_search`.

## MCP-019 — residual `ObserverCoordinatorError` terminology

**Status:** Resolved

**Closed:** 2026-07-28

The deleted `ObserverCoordinator` facade is not used in production; the
composition root is `ObserverApplication`. The host boundary now uses
`ObserverApplicationError`. `ObserverCoordinatorError` remains only as a
deprecated constructor alias for import and `instanceof` compatibility; current
host code, tests, and guidance use the application terminology.

## MCP-016 — `wb_resources` advertised unsupported `browse`

**Status:** Resolved

**Severity:** P1

**Closed:** 2026-07-28

The MCP schema advertised `browse`, but the Workbench helper deliberately
returned “not yet implemented.” The public action enum now omits `browse`
until a tested helper implementation exists.

## MCP-015 — model lookup guidance used the wrong discovery tool

**Status:** Resolved

**Severity:** P1

**Closed:** 2026-07-28

Live prefab guidance directed callers to `api_search` for `.xob` models.
Models are game assets, so discovery now uses `asset_search(type: "model")`;
the asset index returns the GUID-prefixed model references used in that
guidance.

## MCP-014 — `wiki_read` claimed unlimited page text

**Status:** Resolved

**Severity:** P1

**Closed:** 2026-07-28

`wiki_read` returns at most 100,000 page-content characters and appends a
truncation notice. Its tool description and prompt guidance now advertise that
cap consistently.

## MCP-013 — `game_duplicate` overstated its supported resource scope

**Status:** Resolved

**Severity:** P1

**Closed:** 2026-07-28

The tool advertised `.conf` and PAK support despite a prefab-centric loose-data
implementation. It now supports `.et` prefabs only, validates both extensions,
describes the source-data requirement accurately, and directs later
registration through `wb_resources(action: "register")`.

## MCP-012 — `game_duplicate(register=true)` could auto-launch Workbench

**Status:** Resolved

**Severity:** P0

**Closed:** 2026-07-28

Registration now calls Workbench with `skipAutoLaunch: true`. It requires an
already-running compatible Workbench; failures state that a copy may exist but
is not registered, and non-`ok` helper receipts are MCP errors.

## MCP-011 — configured `projectPath` was unsafe as a default write root

**Status:** Resolved

**Severity:** P0

**Closed:** 2026-07-28

`projectPath` remains an addons container. Addon-scoped mutations now require
an explicit addon root, a direct-child `modName`, or a valid configured
`defaultMod`; they never write to the container or select its first child.

**Superseded contract:** MCP-030 later removed `projectPath`, `defaultMod`, and
container-based targeting entirely in favor of exact `gprojPath` or the
verified running Workbench lifecycle target.
