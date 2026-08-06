# Commit 7 plan: add the owned-only game launch composite

> **Commit:** `feat(observer): add owned game launch composite`
>
> **Series position:** 7 of 7 required baseline commits.
>
> **Dependencies:** [world resolution](2026-08-04-launch-ergonomics-03-world-resolution.md),
> [dependency/root safety](2026-08-04-launch-ergonomics-04-dependency-root-safety.md),
> [launch policy](2026-08-04-launch-ergonomics-05-runtime-launch-policy.md), and
> [runtime plumbing](2026-08-04-launch-ergonomics-06-runtime-plumbing.md), plus
> [observer public remedies](2026-08-04-launch-ergonomics-02-observer-refusals.md)
> for its promised public-error behavior.

## Why this is its own commit

This is the first public composite that derives the full project/world plan and
then delegates spawn to the already-existing owned runtime primitive. It should be
reviewed and live-tested independently of durable successor chains and external
scripts. The baseline deliberately supports one initial owned activation family;
repeated relaunch and external delivery remain deferred.

## Goal

Register game_launch with actions start, status, and stop. For start, safely select
one canonical project world, prove its add-on graph, prepare the observer, spawn
through OwnedRuntimeManager, optionally wait for a render-capable instance, and
return all authority needed to inspect or stop the exact process.

## Files

- new src/tools/game-launch.ts
- src/tools/owned-runtime-operations.ts
- src/observer/tools.ts
- src/observer/owned-runtime-manager.ts
- src/setup/server-verification.ts
- tests/observer/application.test.ts
- tests/observer/observer-mcp-tools-registration-runtime.test.ts
- tests/observer/observer-mcp-tools-schema-responses.test.ts
- tests/observer/package-contract.test.ts
- tests/setup/server-verification.test.ts
- new tests/observer/game-launch.test.ts
- scripts/run-runtime-observer-acceptance.ts
- tests/observer/runtime-live-acceptance-contract.test.ts
- docs/observer.md
- observer/README.md
- agents/AGENTS.md
- package.json if focused tests must be added to the enduring stage

## Public schema and registration

Register next to observer_runtime inside registerObserverTools, behind the same
ownedRuntimeManager gate. Keep observer_prepare_launch and observer_runtime public.
The existing ObserverApplication plus ObserverToolDefaults already carry the
application, Workbench client, configured add-on roots, and owned manager, so no
production edit is expected in src/server.ts or src/observer/application.ts after
Commit 5. Keep the single registerObserverTools call and do not compose
OwnedRuntimeManager directly in server.ts.

The raw MCP input is one property object whose branch fields are all optional and
have no defaults:

    action?: start | status | stop
    gprojPath?: bounded nonblank string
    world?: bounded nonblank string
    runtimeKind?: client | listenServer
    arguments?: bounded array of bounded strings
    waitForInstanceMs?: integer 0..300000
    sessionTtlMs?: existing prepare range
    forceUpdate?: boolean
    noFocus?: boolean
    forceNonNativeWindowSize?: existing native-policy type
    runtimeId?: exact runtime ID
    waitForRestorationMs?: integer 0..300000

Resolve a missing action to start, then parse again with strict internal
StartInput, StatusInput, or StopInput schemas. Apply defaults only after selecting
the branch: listenServer, empty extra arguments, 60-second instance wait, the
primitive's prepare defaults, and a 20-second restoration wait. Reject every
irrelevant branch field. Zod does not prove path form, and the current
canonicalizeGproj helper resolves relative input. Reject an explicit value with
node:path isAbsolute before canonicalization; canonicalization then proves the
existing exact project. Relative caller input is not accepted by this composite.

Do not expose script, scriptName, afterRuntimeId, profilePath, public
idempotencyKey, scenario, dedicated, or testRunner in this commit.

## Start pipeline

Run the following in order:

1. Add and use
   `OwnedRuntimeManager.resolveRuntimeExecutableEvidence(kind)`. It applies the
   same configured resolver, canonicalFile check, and `inspectExecutableFile`
   read used by start, returning a frozen private value containing schema version,
   runtime kind, canonical executable path, `{ sha256, size, device, inode }`, and
   a fixed-field `executableEvidenceDigest`. The composite uses that canonical
   path's installation add-ons directory as an implicit dependency root. Keep
   Commit 6's path-only method for its existing callers; callers must not assemble
   executable evidence themselves.
2. Resolve the project from explicit gprojPath or
   WorkbenchClient.activeProjectGprojPath(). The latter is only a canonicalized
   path recorded by the running lifecycle, not fresh endpoint/process/lease proof;
   label it as a selection hint and re-canonicalize it. If neither exists, require
   an exact absolute path. Catch Workbench/ProjectIdentity failures from the hint
   lookup and adapt them to a fixed typed GameLaunchPlanError that asks for an
   explicit absolute gprojPath; do not leak them as INTERNAL_ERROR or read unsafe
   Workbench details.
3. Derive the stable per-project profile before dependency planning so the
   profile/addons directory is included as an implicit root.
4. Resolve the world, dependencies, target-provider uniqueness, emitted add-on
   roots, runtime-kind argv, reserved extras, and native-fullscreen policy using
   Commits 3-5. Use fixed transportPreference [rest, mailbox].
5. Build one versioned canonical prepare identity with fixed field order:
   version, delivery=owned, project comparison key, world resource reference,
   world evidence schema and `worldEvidenceDigest`, add-on evidence schema and
   `addonEvidenceDigest`, runtime kind, canonical executable path, executable
   evidence schema and `executableEvidenceDigest`, fully derived arguments,
   profile path, TTL, forceUpdate, noFocus, and native-window exception. Exclude
   waitForInstanceMs because it is read-only. Hash it into a
   mcp-game-launch-prepare-v1 key and freeze an exact digest fixture.
6. Enter a bounded manager-owned initial-preparation gate that holds
   OWNED_RUNTIME_LIFECYCLE_MUTEX across the canonical-profile evidence query,
   first re-attestation, prepareObserverLaunch call without its recorder, and
   descriptor record. Reserve descriptor/invalidation headroom before IPC, assert
   the mutex lease/fence after the awaited private-child response, and record via
   a non-reentrant locked helper rather than recursively acquiring the mutex. This
   is the machine-wide serialization that prevents two MCP/private-child processes
   from both observing an empty profile and preparing/recording concurrently.
   Persist the original bounded world/add-on snapshots and executable evidence in
   versioned private manager evidence beside the prepared descriptor, verify their
   digests on every read, and include their bytes in record/aggregate caps and
   pre-IPC headroom. An equal retry may compare newly computed digests to locate
   the record, but it cannot replace the stored snapshots/evidence.
7. Start through Commit 6's throwing raw executor with a manager-owned
   pre-consumption callback. While holding the same fenced
   lifecycle transaction used by start, immediately before the consumption write,
   the manager invokes revalidateGameWorldPlan/revalidateGameAddonPlan with the
   original manager-stored snapshots and recomputes executable evidence against
   the original canonical path/digest. Retry-supplied snapshots are not
   revalidation authority. If this callback refuses, the
   manager atomically publishes a bounded prepared-invalidation receipt and makes
   the exact descriptor unstartable while proving no consumption/pending/runtime
   receipt exists, then returns a private typed pre-consumption proof. Only that
   proof authorizes the wrapper to revoke the session. A record failure must
   likewise prove no startable descriptor before revocation; otherwise leave the
   session/evidence pinned.
8. Once manager.start has crossed consumption, any thrown error may represent a
   lost post-consumption or post-spawn outcome. The wrapper must never infer
   unstarted state, discard, or revoke from that error. Preserve the manager's
   durable recovery evidence and return bounded status/retry guidance. The
   manager's existing final exact CreateProcess-length and owner-token check
   remains authoritative.
9. If waitForInstanceMs is nonzero, query the matching session with
   requiredCapabilities [render.capture], renderersOnly=true,
   waitMs=waitForInstanceMs, and signal=extra.signal. Both supported kinds are
   graphical. A timeout/query error after spawn is partial success: return
   runtimeId, sessionId, the readiness failure, and exact status/stop guidance.
   Capture guidance must use the returned opaque instance target rather than
   reconstructing a target from session/instance IDs. Do not turn wait
   cancellation or failure into an opaque error that hides a live process.

Every filesystem identity used to derive the prepare key must be the resolved,
canonical identity, not raw request spelling. The world, add-on, and executable
evidence digests are part of that identity even when the visible world reference,
roots, argv, and executable path did not change.

The fenced callback is the closest available point-of-use check; the lifecycle
mutex serializes MCP launch mutations but cannot stop an unrelated process from
replacing project files after the callback returns. Preserve the manager's
spawn-time executable file-identity checks and document this ordinary external
filesystem TOCTOU rather than claiming the mutex locks project files.

## Baseline retry limitation

This commit has no durable successor index. Within the same live MCP/private-child
lifecycle, matching world/add-on/executable evidence digests, and no prior
invalidation/revocation, an exact retry of the initial request must recover the
same preparedLaunchId/runtimeId and cause one spawn. A changed request or evidence
digest, a request after terminal evidence, or an ambiguous post-restart prepared
outcome must fail closed instead of creating another process.

Inside the manager-owned preparation gate, run a bounded query over its existing
prepared, invalidation, consumption, pending, runtime, stop, and restoration
records for the canonical profile. Recover an exact retained prepare fingerprint
or refuse any different, terminal, stale, corrupt, or ambiguous evidence. Do not
create a successor/profile attempt-index record in this commit.

The minimal prepared-invalidation receipt is not a successor/profile index. Add it
to the existing manager's record-directory, per-record/aggregate capacity,
headroom, sweep, corruption, and restart checks; start must consult it before
consumption. Reserve its worst-case bytes before the callback so an invalidation
cannot fail for lack of storage after preparation.

Within this MCP, keep a bounded in-flight mutation map keyed by the canonical
prepare key so concurrent equal requests join one prepare/start promise; each
caller performs its own read-only instance wait afterward. Do not claim the
private-child API itself converges concurrent misses: it publishes its idempotency
entry only after session creation. Across MCP processes, the manager's shared
lifecycle mutex—not the profile contract alone—serializes the empty-profile
prepare/record transaction. A losing equal caller inspects the winner's durable
evidence after acquiring the mutex; direct it to the owning MCP/attempt and do not
promise cross-MCP convergence. Different keys cannot both prepare. After
recording, the manager's existing consumption/idempotency receipts make start
recovery authoritative.

The private child retains prepare-idempotency receipts even after session
revocation. Therefore a prepare invalidated by the point-of-use callback is a
terminal/pinned baseline attempt: record that tombstone and do not promise an
immediate same-key retry, which would recover the revoked descriptor. Commit 9's
durable attempt ID and fenced replacement transition are what create a fresh key
safely. Do not add an ad hoc cache-delete operation in this baseline.

Document this explicitly: the baseline intentionally supports one initial
generation per retained profile evidence family. To launch a deliberate successor,
the user needs Commit 9. Across MCP restart, use the durable runtime receipt for
status/stop; do not promise stale prepared-descriptor replay.

## MCP idle-shutdown classification

This commit is a lifecycle-state producer for Commit 14's typed, read-only
idle-readiness projection. It must preserve enough exact state for that later
projection to classify, without mutating or inferring from raw record counts:

- an in-flight composite mutation, initial-preparation reservation, unexpired or
  outcome-uncertain prepared session, consumption/pending-start transition, live
  or recoverable runtime, active readiness wait, stop/restoration/release
  transition, or an invalidation whose revoke/profile-vacancy outcome is
  uncertain is blocking;
- a valid record owned by another exact MCP host is never acted on or reported
  as this host's obligation; unknown/corrupt ownership remains indeterminate;
- retained terminal evidence is nonblocking only after exact process vacancy or
  stop, observer restoration/sealing, lifecycle release, session revocation or
  expiry, and profile-lease vacancy are all proven; and
- an expired, provably unconsumed preparation with no pending start, live process,
  observer cleanup, session, or profile-lease obligation is likewise nonblocking
  retained evidence; the idle reader does not sweep or retire it; and
- the timer must never invoke prepare revocation, stop a game, manufacture a
  restoration proof, advance retention, or turn an unknown start outcome into a
  terminal one.

If Commit 14 is already present, extend its provider in this commit. If Commit 14
lands later in the recommended order, it consumes these typed states then. An
expired descriptor or inactive protocol connection alone is never proof that the
owned launch lifecycle is safe to abandon; the full unconsumed/vacancy proof above
is required.

## Public results and errors

Return one JSON value containing:

- runtime and process identity safe for public use;
- sessionId and exact canonical project/profile/world;
- world resource reference;
- emitted and implicit add-on roots with provenance;
- target/dependency GUIDs;
- final prepared argv, but no owner token;
- matching instances or a readiness warning;
- exact next calls for status, capture, and stop.

Use a trusted dispatcher:

- GameLaunchPlanError goes through the <=512 game projector from Commit 3;
- OwnedRuntimeError/observer errors go through the observer projector from
  Commits 2 and 6;
- unknown and spoofed objects become fixed INTERNAL_ERROR.

Do not read unsafe diagnostic/details fields before the projector's fixed-message
gate. Preserve all observer_runtime ownership and restoration semantics.

## Registration and documentation contracts

Repository review found 62 distinct static registerTool names. This commit makes
that 63. At runtime the set is 61 when gamePath/ownedRuntimeManager is absent and
63 when it is present. Update tests with the configuration stated explicitly.

Preserve the package contract's meaning of ten observer_* primitives and assert
game_launch separately as a composite. Add it to setup verification's required
list; that verifier is list-based, not a fixed-count check. Update user and agent
documentation without suggesting that the composite replaces the primitives.

## Tests

Cover:

- action-first strict parsing, defaults, irrelevant fields, blank/bounded strings,
  and exact runtime IDs;
- explicit absolute-path enforcement, active-project-hint selection, and safe
  adaptation of stale/invalid Workbench hints;
- client/world and listenServer/server argv;
- exact prepare-key fixture including all three evidence digests and wait
  exclusion;
- recorder use only for owned start and fixed transport order;
- both point-of-use re-attestations and safe revoke/discard on change;
- `.gproj`, world/meta, or dependency-manifest changes that preserve the visible
  world/roots/argv, and same-path executable replacement, changing identity and
  refusing recovery without spawn; recovered starts use the stored original
  evidence rather than retry-built snapshots;
- invalidated/revoked prepare receipts remaining pinned and never reused;
- invalidation-record capacity, corruption, restart, and retention behavior;
- same-request lost-response recovery with one spawn;
- same-MCP concurrent joining, cross-process equal-request safe retry, and
  different-key profile conflict, including two simultaneous empty-profile
  private children;
- lease loss/crash at each awaited phase of the manager-owned preparation gate and
  no recursive mutex acquisition;
- changed, terminal, and stale/ambiguous requests refusing rather than relaunching;
- status/stop parity, signal forwarding, public error dispatch, and owner-token
  redaction;
- post-spawn readiness timeout/cancellation as partial success and opaque target
  reuse in capture guidance;
- unknown manager.start outcomes never triggering wrapper revoke/discard;
- forward idle-readiness fixtures for prepare, start, readiness wait, live
  runtime, stop/restoration, expired provably unconsumed preparation, and every
  uncertain outcome. If Commits 14/15 are already present, also run the timer/
  eligibility integration; otherwise Commit 15 owns that later actor test;
- exact registration order/schema/tool sets and docs/setup contracts.

Keep the manager mutex, restart sealing, restoration, termination-vacancy, recovery
authority, and cross-cutting baseline suites green.

## Validation

    npx vitest run tests/observer/game-launch.test.ts tests/observer/observer-mcp-tools-registration-runtime.test.ts tests/observer/observer-mcp-tools-schema-responses.test.ts tests/observer/package-contract.test.ts tests/setup/server-verification.test.ts tests/observer/runtime-live-acceptance-contract.test.ts
    npm run test:cross-cutting:baseline
    npm run test
    npm run typecheck
    npm run build
    npm run mcp:verify

## Live gate

Before exposing start, add and register a project-contained fixture .ent plus .meta
inside the acceptance add-on. The current fixture is script-only and launches the
stock MPTest world, so it cannot prove this policy unchanged.

Run the public game_launch handler through the live harness:

1. listenServer start;
2. matching render-capable instance;
3. frame capture;
4. stop with restoration and session sealing;
5. the complete client start/capture/stop cycle before exposing client.

Because this baseline deliberately has no same-profile successor, run the client
cycle with a second fixture project or a fresh isolated managed/profile root and
MCP lifecycle. Do not make this acceptance gate depend on the deferred Commit 9.

Use the existing opt-in environment and confirmation gate:

    RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE=1
    npm run dev:observer:acceptance:runtime -- --config <file> --confirm-live-run

The accepted vectors are -server <world> and -world <world>. There is no
-scenarioId gate.

## Commit acceptance

- game_launch start/status/stop is registered only with the owned manager.
- One initial exact request is idempotent and never double-spawns.
- Every launch identity is canonical, bounded, re-attested, and fail-closed.
- A live process is never hidden by a readiness timeout.
- Every nonterminal or uncertain owned-launch state is visible to the MCP
  idle-readiness contract without letting that read-only inspection mutate it.
- No successor chain, external descriptor/script, process inventory, or Workbench
  preview ships here.
