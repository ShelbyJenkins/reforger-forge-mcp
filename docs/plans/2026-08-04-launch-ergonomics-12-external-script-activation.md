# Commit 12 plan: activate external script delivery

> **Commit:** `feat(observer): add externally managed game launch scripts`
>
> **Series position:** final deferred follow-up.
>
> **Dependencies:** [owned composite](2026-08-04-launch-ergonomics-07-owned-game-launch.md),
> [successor index](2026-08-04-launch-ergonomics-09-successor-recovery.md),
> [PowerShell descriptors](2026-08-04-launch-ergonomics-10-powershell-descriptor.md),
> and [runtime inventory/gate](2026-08-04-launch-ergonomics-11-runtime-process-inventory.md).

## Why this is its own commit

Returning runnable source changes the threat model. The MCP prepares observer state
but receives no exact process receipt, cannot prevent sequential double execution,
and cannot safely clear the profile from its own records alone. Script delivery
must remain absent until durable cross-mode exclusion, process inventory, observer
vacancy, expiry/revocation, and a shared spawn gate all exist.

## Goal

Add game_launch action=script. Return an exact, expiring,
externally-owned PowerShell descriptor/source and optionally publish one managed
file. Coordinate issuance and later clearance with the same profile attempt index
used by owned launches, without claiming status, stop, termination, or ownership.

## Files

- src/tools/game-launch.ts
- src/observer/owned-runtime-manager.ts
- src/observer/application.ts
- src/observer/launch.ts
- src/observer/setup.ts
- new `src/observer/runtime-instance-inventory.ts` as the runtime-only
  completeness API
- observer/agent/control-api.ts
- observer/agent/application-operations.ts
- observer/agent/private-child.ts
- src/tools/owned-runtime-operations.ts only if shared marker callbacks belong
  beside the executor
- src/launch/external-game-launch-descriptor.ts
- src/launch/powershell-launch-script.ts
- src/foundation/runtime-profile-inventory.ts
- src/platform/windows/exact-process-backend.ts
- scripts/windows/workbench-lifecycle.ps1
- tests/observer/game-launch.test.ts
- new tests/observer/game-launch-external-script.test.ts
- tests/observer/application-shutdown.test.ts
- tests/observer/mcp-shutdown-characterization.test.ts
- new tests/observer/setup-external-marker.test.ts
- new tests/observer/runtime-instance-inventory.test.ts
- tests/launch/external-game-launch-descriptor.test.ts
- tests/launch/powershell-launch-script.test.ts
- tests/platform/windows/runtime-profile-inventory.test.ts
- tests/observer/package-contract.test.ts
- tests/observer/observer-mcp-tools-schema-responses.test.ts
- scripts/run-runtime-observer-acceptance.ts
- tests/observer/runtime-live-acceptance-contract.test.ts
- docs/observer.md
- observer/README.md
- agents/AGENTS.md
- package.json if focused tests need enduring stage coverage

## Public schema and result

Add script to action and add scriptName as a raw optional field matching:

    ^[A-Za-z0-9_-]{1,64}$

The strict ScriptInput accepts the same project/world/runtime/argument/prepare
fields as StartInput plus scriptName. It rejects runtimeId,
waitForRestorationMs, waitForInstanceMs, and afterRuntimeId. Support only client
and listenServer.

Return one outer activation result with:

- an unbranded frozen public projection of the internally branded
  ExternalGameLaunchDescriptor;
- exact PowerShell source beginning with U+FEFF plus encoding=utf-8-bom;
- sessionId, profile, world, dependency plan, and expiry;
- prepare and publication warnings;
- scriptPath only when publication occurred;
- explicit external_unowned limitations and manual-cleanup instructions.

If scriptName is omitted, return source only and perform no filesystem write. A
descriptor-only exact retry may later bind one script name. Same name and same
bytes is idempotent; a different second name or different content conflicts.
Exclude scriptName/publication destination from the activation fingerprint and
track publication separately so it cannot create another runnable preparation.

The public descriptor expiry must equal the prepared observer session expiry
exactly. It is never caller-selected or extended.

## External preparation flow

Use the same canonical project/world/dependency/argv derivation and point-of-use
re-attestation as owned start. Keep missing or ambiguous dependencies as hard
refusals for both delivery modes; do not add an unowned warning escape hatch in
this series.

Migrate Commit 9's versioned delivery=owned records to an explicitly versioned
schema that also understands these states:

    external_reserved -> external_prepared -> external_issued -> external_retired
              \                 \
               +-----------------+-> external_abandoned

Only migrate a fully valid known owned schema under the lifecycle mutex; unknown
versions, missing delivery, or unknown states remain pinned. Reserve aggregate
record/count/byte headroom for the worst-case final marker and publication binding
before any private-child IPC.

Under the fixed launch coordination gate:

1. resolve/canonicalize the executable and prospectively validate an optional
   destination without creating managedRoot;
2. inspect both the profile ledger and all manager prepared/consumption/pending/
   runtime evidence, proving no owned or external activation blocks it;
3. reserve external_reserved with delivery=external_script, a new
   compositeAttemptId, the canonical fingerprint, the manager's trusted
   `originManagerInstanceId`, current private-child agentInstanceId/generation,
   and the preallocated storage budget;
4. release the gate only after the reservation is durable.

Derive the prepare key from delivery, compositeAttemptId, and canonical fingerprint
as specified by Commit 9. Exact retries reuse that durable attempt; a proven
abandoned replacement gets a new attempt ID/key even when launch fields are
identical. Prepare without OwnedRuntimeManager.recordPreparedLaunch. This narrowly
prevents observer_runtime/game_launch owned start from consuming that prepared ID;
it does not prevent a user from executing returned source twice.

After prepare:

- atomically bind external_prepared with sessionId, exact session expiry/profile,
  prepared identity, child generation, issued executable path, installation root,
  and executable file identity;
- re-attest executable, project/world/meta/providers/dependencies and final
  publication containment;
- construct and runtime-validate the external descriptor;
- render source with the Commit 11 gate;
- bind the exact public descriptor/source hash and optional script path/hash, then
  transition to external_issued before returning; publish only when scriptName is
  present.

If publication fails after a usable descriptor/source exists, return that
descriptor and a publication warning rather than hiding a live profile lease
behind an opaque error. If any post-prepare failure leaves no usable descriptor,
call ObserverApplication.revokeSession(sessionId), prove revocation, and
fenced-transition to external_abandoned before returning the error. A failure to
prove revocation remains pinned.

Do not collapse external_reserved directly to issued. If the host loses the
prepare response, or crashes after the child commits prepare but before the marker
binds sessionId, the outcome cannot be replayed exactly after a private-child
restart. Keep that attempt pinned until its maximum possible session/contract
window has elapsed, the profile lease is absent, and the full process/observer
vacancy proof succeeds; only then abandon/retire it. Never silently create a
replacement session.

Bind every retry to the recorded agentInstanceId/generation. After private-child
replacement, do not rerender, republish, or reprepare the old issued attempt. Keep
it pinned until expiry and vacancy. An already emitted script can still start the
game after unexpected child death, but observer registration will then fail; this
is an explicit crash limitation.

An issued-response retry may reproduce the stored public projection/source only
when the same child generation is live and the descriptor passes Commit 10's
fresh resolver/runtime validation. If the resolver changed, do not rewrite the
issued executable or source; refuse the retry while retaining historical evidence
for clearance.

## Emitted script semantics

Immediately before Process.Start, the script must:

1. create/open the exact
   Global\ReforgerForge.GameLaunchCoordination.v1 mutex with Commit 11's pinned
   current-user/SYSTEM ACL and acquire it with a wait bounded by expiresAt;
2. refuse on timeout or AbandonedMutexException and recheck expiresAt while
   holding it;
3. construct ProcessStartInfo with UseShellExecute=false, exact FileName,
   WorkingDirectory, and prequoted Arguments;
4. call Process.Start before releasing the gate in try/finally.

This closes the race where the MCP observes vacancy while a paused valid script is
about to spawn. The gate carries no owner token, process receipt, stop authority,
or lifecycle claim.

The script and tool response must say:

- execute once and before expiresAt;
- the originating MCP/private child must remain alive;
- the stable profile remains leased until expiry even after manual game close;
- observer registration, inventory, and graphical capture may work;
- there is no owned runtime ID, exact status/stop, shutdown sealing, exit
  reconciliation, or MCP termination authority;
- the user must close the game;
- the same source can still be run twice sequentially before expiry;
- executable identity is not attested across creation-to-execution replacement
  unless a future hash-pin design is implemented.

Never emit any Workbench/runtime owner token. Do not accept a user-supplied command
line or arbitrary path.

The MCP always acquires this launch gate before
OWNED_RUNTIME_LIFECYCLE_MUTEX. Assert the gate lease/fence after every awaited
inventory/private-child call and immediately before a state transition. The
generated PowerShell and the Windows helper need a real cross-process contention
test; matching constant strings alone is insufficient.

## Cross-mode exclusion and marker clearance

Every unresolved external state lives in the same canonical-profile index as owned
attempts. While retained, it blocks different external requests and every owned
initial/successor request for that profile. Owned ledger state plus every existing
manager prepared/consumption/pending/runtime record likewise blocks script
issuance.

Bind `originManagerInstanceId` from the manager object, never the tool request or
an existing mutable marker. When Commit 13 is present it is the same UUID as the
process-wide MCP host identity. Cross-mode launch exclusion remains profile-wide,
but Commit 14 uses this field to distinguish the current host's shutdown
obligations from a valid marker owned by another MCP UUID. This classification
does not assert whether that foreign host is still live. Missing, corrupt, or
unknown origin evidence is indeterminate; it is never rewritten to the current
host merely to permit cleanup.

Fence the still-public primitives, not only game_launch:

- OwnedRuntimeManager.recordPreparedLaunch checks the profile marker under its
  existing lifecycle mutex before publishing a descriptor;
- OwnedRuntimeManager.start repeats the check before consumption in case an older
  descriptor raced marker issuance;
- when recordPreparedLaunch rejects for an external marker, it first binds a
  durable primitive_cleanup_required obligation containing the proven-unrecorded
  session/profile/child generation/expiry. Extend prepareObserverLaunch's recorder
  protocol so this specific cleanup path attempts revoke, validates the response,
  and durably resolves the obligation. Do not retain today's catch-and-ignore
  behavior for this marker conflict;
- failed/unknown revoke keeps the cleanup obligation and marker pinned without
  exposing a public-startable descriptor;
- script reservation scans all older prepared/pending/runtime evidence, not just
  the new ledger.

This prevents a caller from waiting for external session TTL and then using
observer_prepare_launch plus observer_runtime start while an unowned process still
uses the profile.

External delivery is allowed only for a fresh profile family or after Commit 9 has
atomically retired the complete prior owned family. It cannot follow a retained
terminal owned chain. External has no runtimeId, so neither owned nor external
input can name it as afterRuntimeId. Once an external family reaches
external_retired, retire the whole family atomically; a later owned or external
request begins a new initial family rather than a successor.

Clear or abandon the external marker only while holding the shared launch gate and
after all of these are true:

- the activation contract expired or its known unstarted session was explicitly
  revoked;
- Commit 11's complete bounded inventory reports vacant for the deduplicated union
  of the marker's historical issued executable/install identity and the current
  graphical executable paths when resolution succeeds, against the exact
  canonical profile. During retirement only, `RUNTIME_NOT_FOUND` contributes zero
  current candidates after the marker's stored installation-root evidence has
  been revalidated; the historical candidates still require vacancy proof;
- a new runtime-only typed observer inventory reports complete=true and no matching
  session/renderer; do not use application.instances(), whose CaptureService
  aggregation mixes Workbench and converts backend failures into warnings;
- a typed complete profile-lease/contract query proves no in-memory session,
  on-disk contract, or primitive_cleanup_required obligation remains for the exact
  canonical profile;
- no prepared consumption, pending start, owned receipt, or later index state
  exists;
- an optional bound managed script is absent or still has its exact issued hash
  and can be removed through Commit 10's exact cleanup operation;
- the evidence, exact script cleanup result, and index transition are durably
  committed together.

Access denied, helper failure, partial/truncated inventory, corrupt/unattested
historical marker evidence, unknown observer completeness, a changed managed
script, malformed or changed installation-root evidence, resolver uncertainty
other than the retirement-only `RUNTIME_NOT_FOUND` case, or any race is
indeterminate and blocks clearance. A resolver change or ordinary removal of the
historical executable by itself does not permanently brick the profile: pass the
issuance-attested historical path as a non-existing inventory candidate alongside
any current candidates, and clear when that complete union proves vacancy. A user
statement and natural timeout alone are not proof.

The shared gate prevents clearance racing a script about to start, but it cannot
prevent running one emitted file twice sequentially. Document that residual risk
instead of claiming exactly-once activation.

Implement the runtime-only observer inventory against the private runtime backend
or agent client with an exact schema/deadline/signal and explicit completeness.
Workbench backend warnings are irrelevant; runtime transport failure, malformed
response, truncation, or child-generation change is indeterminate.

Add the profile-lease query as a private-child operation over the exact canonical
profile. It must reconcile the session store and on-disk profile contract, return
only bounded non-secret state, and carry completeness plus agent generation.
Transport failure, a newer generation, or revoke outcome uncertainty blocks
retirement even when no runtime instance is registered.

## Status, stop, and cleanup

Do not fabricate a runtimeId for external launch. game_launch status/stop and
observer_runtime status/stop continue to accept only exact owned runtime receipts
and therefore refuse external ownership.

For the live acceptance harness, retain the exact Process object/handle and Windows
creation identity when executing the script. Close only that exact process, or use
attended UI close. Never use kill-by-name or PID-only cleanup. Then wait for or
explicitly revoke the session as permitted, prove inventory and observer vacancy,
and verify the profile marker clears.

## Graceful shutdown, uninstall, and retention

An unresolved external marker whose trusted `originManagerInstanceId` matches
the current host means the emitted script still relies on this host's private
child or may still start. Make application-layer
`ObserverApplication.close`/`closeRuntimeLifecycle` refuse before terminating or
revoking that child. A valid foreign-host marker is ignored by this host's
disposer and is never mutated; a missing, malformed, or otherwise unattributable
origin remains indeterminate and blocks host close.

Uninstall has wider authority because runtime-observer and Workbench companion
files are shared across MCP hosts. `observer_setup` uninstall and its setup
coordinator must refuse while *any* unresolved current-host, valid foreign-host,
or unattributable external marker remains, before either shared component or
observer state is removed. Do not silently convert the refusal into successful
partial uninstall. Cross-mode launch exclusion and uninstall safety remain
global regardless of marker ownership or inferred host liveness.

Preserve the following typed idle-readiness classification for Commit 14. If
Commit 14 is already present, extend its provider here; if it lands later, it
consumes this projection. Every current-host
`external_reserved`, `external_prepared`, `external_issued`, or unresolved
`external_abandoned` record, every `primitive_cleanup_required` obligation, and
every associated live/indeterminate profile lease or contract is blocking.
`external_retired` is nonblocking. Expiry alone does not change that
classification. The automatic-idle probe is read-only: it must not revoke a
session, acquire the launch gate to advance or abandon a marker, remove a script,
terminate an unowned game, or treat incomplete inventory as vacancy. Only this
commit's existing launch-gate then lifecycle-mutex proof and atomic retirement
transition remove the blocker. A valid foreign-host marker is not this host's
shutdown obligation and is never mutated by its timer.

Application-layer refusal is not a promise that the private child survives every
way the process can end. Stdin EOF/client-process termination, SIGINT/SIGTERM,
the existing CLI shutdown deadline, and a crash remain forced host-termination
boundaries: the current close-first CLI path may eventually terminate the private
child, and a script run afterward may start the game without observer
registration. Commit 15's idle controller consumes Commit 14's current-host
blocker and never enters that path automatically. Document the forced-termination
limitation alongside crash behavior rather than describing graceful refusal as
process ownership.

Include every external state/publication binding in storage counts, byte caps,
headroom, corruption handling, sweep, restart reconciliation, diagnostics, and
shutdown. Exact expired script removal occurs during proven external retirement.
Uninstall may remove only an exact bound path/hash after the marker is retired;
an absent file is already clean, while changed/linked/uncertain content is
preserved and reported. Never broad-delete launch-scripts to satisfy retention.

## Tests

Cover:

- strict script branch fields/defaults and rejection of afterRuntimeId/status/stop
  fields;
- attempt-scoped delivery-specific prepare/manager key digests, no recorder call,
  exact session expiry, child-generation binding, and fixed resolved fingerprint;
- descriptor-only response, later one-name bind, same-bytes retry, and second-name
  conflict;
- owned-schema migration, explicit external state transitions, reservation/storage
  headroom before prepare, and cross-mode exclusion in every ledger/manager state;
- fresh/retired-family transition rules and rejection of successors to/from
  external delivery;
- observer_prepare_launch recorder and observer_runtime start both refusing an
  unresolved external profile, including race cases and revocation of a newly
  rejected primitive preparation;
- primitive prepare racing after external expiry with revoke success, revoke
  failure, and lost revoke response; cleanup obligation/profile-contract vacancy
  must block retirement until proven resolved;
- pre/post-prepare filesystem and executable re-attestation;
- successful prepare plus publication failure returning usable source/warning;
- unusable post-prepare failure proving revoke before abandonment;
- lost prepare response, crash before marker bind, and private-child generation
  replacement remaining pinned without reprepare/rerender;
- source gate/lock ordering: acquire exact ACL'd global mutex, expiry recheck,
  Process.Start, finally release; real script/helper contention, abandoned mutex,
  and expiry while waiting;
- unbranded public descriptor, single leading U+FEFF/encoding field, no owner token,
  and explicit unowned/crash warnings;
- sequential double execution acknowledged, not falsely prevented;
- clearance only after expiry/revocation plus historical+current process inventory,
  runtime-only complete observer vacancy, complete profile-session/contract lease
  vacancy, and exact managed-script cleanup;
- occupied, access-denied, malformed, truncated, helper-timeout, corrupt historical
  evidence, changed script, and incomplete/changed-child observer evidence
  remaining pinned, while an ordinary removed historical file remains clearable;
- owned status/stop refusing an external activation;
- crash windows across reserve, prepare, marker bind, render, publication, expiry,
  clearance, and atomic retirement;
- external records/publications in capacity, sweep, corruption, diagnostics, and
  restart accounting;
- trusted origin-manager binding and forward idle-readiness fixtures at every
  external state, including expiry, foreign-host markers, incomplete evidence,
  and eligibility only after the exact `external_retired` transition. Extend/run
  Commit 14's provider when it is already present; otherwise Commit 14 consumes
  these fixtures later;
- application close refusing current-host/unattributable markers while ignoring
  a valid foreign origin, and global observer_setup uninstall refusing every
  unresolved current/foreign/unattributable marker without killing a child or
  partially uninstalling;
- forced EOF/signal/CLI-deadline characterization without promising child
  survival after host death. If Commit 15 is already present, contrast it with
  marker-aware automatic-idle refusal; otherwise Commit 15 owns that later actor
  test;
- exact public schema/package/docs contracts.

## Validation

    npx vitest run tests/observer/game-launch-external-script.test.ts tests/observer/game-launch.test.ts tests/observer/runtime-instance-inventory.test.ts tests/observer/application-shutdown.test.ts tests/observer/mcp-shutdown-characterization.test.ts tests/observer/setup-external-marker.test.ts tests/launch/external-game-launch-descriptor.test.ts tests/launch/powershell-launch-script.test.ts tests/platform/windows/runtime-profile-inventory.test.ts tests/observer/observer-mcp-tools-schema-responses.test.ts tests/observer/package-contract.test.ts tests/observer/runtime-live-acceptance-contract.test.ts
    npm run test:cross-cutting:baseline
    npm run test
    npm run typecheck
    npm run build
    npm run mcp:verify

## Live gate

Extend the opt-in Windows runtime acceptance:

1. request descriptor-only script output;
2. execute it once before expiry while retaining the exact process handle and
   creation identity;
3. prove the observer registers and capture succeeds;
4. prove both owned status/stop surfaces refuse ownership;
5. prove observer_prepare_launch/observer_runtime cannot create an owned launch on
   the marked profile and application-layer graceful close/uninstall refuse
   without killing the private child;
6. close only the retained exact process;
7. prove the profile remains blocked until expiry/revocation and both complete
   vacancy checks succeed;
8. verify marker/profile/exact-script cleanup and that application-layer graceful
   shutdown is then allowed;
9. separately verify the emitted script refuses after expiry.

Never leave an unowned game running.

## Commit acceptance

- Runnable source appears only after all four prerequisite commits.
- External and owned activation cannot overlap one canonical profile through the
  MCP's state machine.
- Expiry plus conservative process and observer vacancy is required for clearance.
- Public primitives and shutdown honor host ownership, while shared uninstall
  honors every unresolved external marker.
- The preserved state makes unresolved external work a current-host blocker for
  Commit 14. When Commit 15 is present, automatic idle shutdown honors it and the
  timer never performs external retirement or acts on another host's marker.
- Application close refuses a current-host or unattributable marker and ignores a
  valid foreign marker; shared uninstall refuses every unresolved marker
  regardless of origin. Forced transport close, signals, the CLI deadline, and
  crashes retain their documented termination behavior.
- The tool never claims exact ownership or status/stop authority.
- Residual sequential double execution and executable replacement risk are
  disclosed and tested as limitations.
