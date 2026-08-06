# Commit 11 plan: add bounded runtime profile inventory

> **Commit:** `feat(observer): add bounded runtime profile inventory`
>
> **Series position:** deferred external-activation prerequisite.
>
> **Dependency:** [runtime plumbing](2026-08-04-launch-ergonomics-06-runtime-plumbing.md).
> It may be developed independently of the descriptor commit, but both are needed
> by Commit 12.

## Why this is its own commit

The current ExactProcessBackend can inspect only a supplied PID. Clearing an
external activation marker requires a conservative machine-wide vacancy proof for
current plus issuance-attested historical runtime executable candidates and one
exact profile. Bounded Windows enumeration and access-denied behavior deserve a
separate review and rollback surface from script issuance.

## Goal

Add a private Windows backend operation that lists bounded, identity-rich runtime
processes for exact canonical executable paths and determines whether an exact
profile may still be active. Uncertainty must block vacancy.

## Files

- new src/foundation/runtime-profile-inventory.ts interface
- new src/foundation/game-launch-coordination.ts
- src/platform/windows/exact-process-backend.ts
- scripts/windows/workbench-lifecycle.ps1
- new tests/foundation/fake-runtime-profile-inventory.ts
- new tests/platform/windows/runtime-profile-inventory.test.ts
- tests/workbench/lifecycle-helper-timeout.test.ts
- tests/workbench/multiprocess-lifecycle.test.ts
- package.json if the focused tests need an enduring stage entry

## Narrow interface

Prefer a separate RuntimeProfileInventory capability over widening every fake
ExactProcessBackend implementation when lifecycle inspection does not need
enumeration. A type guard/composed Windows kernel may expose both.

The request contains a bounded discriminated candidate list:

- current_existing entries freshly resolved as canonical regular executable
  files;
- historical_attested entries containing the canonical path/basename and issuance
  file identity persisted by a validated marker; the historical file may have
  been removed or renamed by an update and need not still exist on disk;
- one exact canonical profile path (not only a comparison key, because argv
  contains -profile <path>);
- absolute deadline and maximum result count/bytes.

The result contains only bounded evidence needed for admission:

- PID;
- canonical executable image path;
- Windows creation-time identity;
- command-line/profile evidence or an explicit unverifiable reason;
- access/parse status.

It does not return arbitrary environment, window titles, tokens, or full
unbounded command lines. It has no terminate method.

## Helper protocol

Add a ListRuntimeProfiles mode to the packaged
scripts/windows/workbench-lifecycle.ps1 helper used by
WindowsExactProcessBackend. Validate request JSON before enumeration and validate
the response again in TypeScript.

Required bounds include:

- maximum allowlisted executable count and path length;
- helper execution deadline;
- processes visited and results returned;
- per-field and total response bytes;
- one response object only;
- exact schema version and no unknown status values.

Validate the spelling and provenance of every historical entry but do not
re-canonicalize it through the now-missing file. Corrupt/unattested historical
evidence is indeterminate; ordinary on-disk absence is not. Use the allowlisted
executable basenames only to build a complete bounded
candidate set; a basename can exclude a different-name process but can never prove
a same-name candidate safe. For every same-name candidate, canonicalize the image
path and compare case-insensitively with Windows path semantics. Extract profile
evidence using the exact argument grammar emitted by the observer private
child/shared launch policy, not substring matching. Preserve PID plus creation
time so reuse is detectable.

Any same-name candidate whose image, creation identity, command line, or profile
cannot be read is uncertainty, not absence. Access denied, helper timeout, partial
enumeration, truncation, malformed output, or a process changing during inspection
must return blocked/indeterminate.

A verified different basename may be ignored. A same-name process may be ignored
only after its canonical image proves it is outside the allowlist, and an
allowlisted-image process may be declared nonmatching only after its exact profile
argument is readable. Never infer vacancy from process name alone.

## Vacancy decision

Build a pure decision function with three outcomes:

- vacant: complete inventory proves no allowlisted runtime uses the profile;
- occupied: at least one exact matching process/profile exists;
- indeterminate: a potentially matching process or the inventory itself could not
  be verified.

Only vacant is affirmative evidence for Commit 12. occupied and indeterminate
carry bounded safe diagnostics and must block external-marker clearance/new
activation.

Observer instance vacancy is not part of this backend; Commit 12 adds a
runtime-only, completeness-bearing observer inventory and combines it with this
process decision while holding the launch coordination gate. The public
application.instances aggregation is not suitable because it mixes optional
Workbench instances and converts backend failures to warnings.

## Launch coordination gate primitive

Pin the name to:

    Global\ReforgerForge.GameLaunchCoordination.v1

Define a narrow GameLaunchCoordinationGate and a separate
HoldGameLaunchGate helper/backend mode. Do not route it through generic
MachineMutex.withMachineMutex/HoldMutex: the current generic helper deliberately
grants World SID and is shared by Workbench/owned lifecycle code. Preserve that
existing ACL/behavior exactly. The new gate-specific mode pins scope/ACL for both
new callers: the current user SID and SYSTEM may synchronize/modify the mutex, and
creation or verification failure is fail-closed. It is coordination only: it
carries no owner token, receipt, stop authority, or lifecycle claim.

The emitted PowerShell cannot call the TypeScript abstraction. Specify the
equivalent System.Threading.Mutex creation/open, MutexSecurity, WaitOne, and
try/finally ReleaseMutex sequence for Commit 12. Its wait is bounded by expiresAt.
An emitted script treats AbandonedMutexException as a refusal; the MCP may treat
it as acquired-but-dirty only if it reruns the complete process/observer vacancy
proof before any transition.

Whenever both locks are needed, the global order is launch coordination gate then
OWNED_RUNTIME_LIFECYCLE_MUTEX. Never acquire them in reverse. After any awaited
inventory/private-child work, assert the machine-mutex lease/fence again before
committing state.

Test ACL/scope, deadline, lease-loss, abandoned ownership, and cross-process mutual
exclusion here. Commit 12 will make the generated script and the MCP
clearance/reservation path use this same gate. Do not expose a script yet.

## Tests

Cover:

- exact graphical client and listen-server executable allowlists;
- removed historical executable candidates after a game update, plus corrupt
  historical evidence remaining indeterminate;
- canonical/case-insensitive path matching and rejection of basename-only matches;
- exact profile parsing with spaces, quotes, Unicode, and near-prefix values;
- PID reuse/creation identity;
- different-name exclusion plus same-name exact image/profile proof;
- matching occupied result;
- access denied, missing command line, malformed path, helper timeout/failure,
  truncation, oversize response, process churn, and unknown statuses becoming
  indeterminate;
- request and result bounds;
- fake backend parity;
- exact global gate name/ACL, expiry-bounded timeout, lease loss, abandoned mutex,
  lock ordering, and real PowerShell-versus-helper mutual exclusion;
- regression that generic HoldMutex retains its existing World-SID behavior;
- no termination call or public MCP tool.

## Validation

    npx vitest run tests/platform/windows/runtime-profile-inventory.test.ts tests/workbench/lifecycle-helper-timeout.test.ts tests/workbench/multiprocess-lifecycle.test.ts
    npm run test:stage4
    npm run test:cross-cutting:baseline
    npm run typecheck
    npm run build

Run the helper integration cases on Windows with a retained test-process handle.
Clean up only that exact handle/creation identity.

## Commit acceptance

- Vacancy is proven from canonical image, profile argument, and complete bounded
  enumeration.
- Access uncertainty always blocks.
- The capability cannot enumerate arbitrary process data or terminate anything.
- One tested machine gate is ready for both script and MCP callers.
- No external marker is cleared and no public script action is added.
