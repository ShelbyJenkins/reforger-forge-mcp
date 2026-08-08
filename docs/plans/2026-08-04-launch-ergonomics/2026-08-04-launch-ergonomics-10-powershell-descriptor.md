# Commit 10 plan: build safe external PowerShell descriptors

> **Commit:** `feat(launch): add safe external PowerShell descriptor`
>
> **Series position:** deferred infrastructure follow-up.
>
> **Dependencies:** [launch policy](2026-08-04-launch-ergonomics-05-runtime-launch-policy.md)
> and [runtime plumbing](2026-08-04-launch-ergonomics-06-runtime-plumbing.md).
> This commit is internal-only; it must not add game_launch script.

## Why this is its own commit

Exact Windows argv rendering, descriptor attestation, and managed publication are
security-sensitive but do not require lifecycle-state changes. They can be tested
in isolation. Keeping the output private until Commits 11-12 prevents a safe
quoting implementation from being mistaken for safe activation.

## Goal

Create a runtime-validated external game descriptor, render it to a
Windows-PowerShell-compatible script with exact argv semantics, and optionally
publish that script under the managed root without overwrite or path escape.

## Files

- new src/platform/windows/command-line.ts
- src/observer/owned-runtime-manager.ts
- new src/launch/external-game-launch-descriptor.ts
- new src/launch/powershell-launch-script.ts
- new tests/platform/windows/command-line.test.ts
- new tests/launch/external-game-launch-descriptor.test.ts
- new tests/launch/powershell-launch-script.test.ts
- a Windows argv-echo fixture or helper mode for end-to-end round trips
- package.json if the new tests need an enduring stage entry

## Shared exact Windows command-line primitives

Move quoteWindowsArgument, assertWindowsCommandLineFits, and the reusable
owner-argument scan out of owned-runtime-manager.ts into the small platform
module. Make the owner scan accept an explicit bounded prefix set: the manager
passes its existing runtime-owner prefix, while the external descriptor passes
every Workbench/runtime owner prefix. Import the helpers back into the manager and
prove its spawn arguments and bounds are unchanged. Keep/re-export existing public
constants from their current modules unless a separate compatibility-tested
foundation module is justified.

The quoting function must remain compatible with the Windows/libuv command-line
rules used by Node's direct spawn. The platform module must not import
OwnedRuntimeError back from the observer layer: use a neutral typed violation (or
an injected error factory), and wrap it in the manager so its existing codes and
messages remain exact. Keep quote/length/owner scanning semantics unchanged for
the manager. Apply any additional NUL/control rejection only at the new external
descriptor boundary. The exact length helper uses the executable plus every
quoted argument. Owner rejection is case-insensitive and the descriptor supplies
all supported Workbench/runtime token prefixes.

Do not expose a shell-command builder. A human-readable command is display-only
and must be labeled as not safe to paste into a shell.

## Descriptor model and runtime validation

Define a discriminated value with at least:

    kind: game_runtime
    ownership: external_unowned
    runtimeKind: client | listenServer
    executablePath: canonical absolute file
    argv: bounded exact argument vector
    workingDirectory: dirname(executablePath)
    expiresAt: finite future instant
    grants: fixed allowlisted statements
    doesNotGrant: fixed ownership warnings

Do not accept an independent commandLine. Derive every display/rendered value from
executablePath and argv in one private factory.

TypeScript types are not a trust boundary. Give the internal factory output a
private brand and have both renderer and writer parse a strict runtime schema.
That brand cannot survive MCP JSON: Commit 12 returns a frozen, unbranded public
projection of the validated safe fields, while only the internal branded object
may reach rendering/publication. At the factory, render, and write boundaries:

- resolve runtimeKind again through the manager's
  resolveRuntimeExecutablePath method;
- require canonical equality with executablePath;
- require a canonical regular allowlisted executable;
- require workingDirectory to equal its dirname;
- require exact kind/ownership/grant text;
- require a bounded future expiry;
- rerun owner-token and command-line checks.

Commit 12 must additionally require expiresAt to equal the prepared observer
session expiry exactly. It is not a caller-selected extension of that contract.

Unless executable bytes are hashed and compared again at execution, document the
remaining creation-to-execution identity gap. Canonical path revalidation does not
prove an executable was not replaced after the script was written.

Any preview-shaped value with kind=workbench_editor, ownership=preview_only, or
runnable=false must fail this runtime schema even if cast by a caller. Test this
with a local object literal so this deferred commit does not depend on optional
Commit 8 shipping first.

## PowerShell renderer

Do not use Start-Process -ArgumentList; its string-to-argv behavior is not the
required exact boundary. Render a script that:

- uses separately escaped PowerShell single-quoted literals;
- constructs System.Diagnostics.ProcessStartInfo;
- sets UseShellExecute=false;
- assigns canonical executablePath to FileName;
- assigns dirname(executablePath) to WorkingDirectory;
- assigns one Arguments string produced by quoteWindowsArgument;
- checks expiresAt locally immediately before Process.Start;
- contains no owner token or status/stop claim.

Represent source as a string whose first code point is U+FEFF and report
encoding=utf-8-bom in the later public projection. Publication encodes that exact
string as UTF-8, yielding EF BB BF for Windows PowerShell 5.1 Unicode paths. Pin
this contract in tests; do not ambiguously add a second BOM at write time. Bound
source bytes and reject NUL. State clearly in the header: run once before expiry,
keep the originating MCP/private child alive, manually close the game, and do not
expect MCP process ownership.

The renderer in this commit is internal testable infrastructure. Commit 12 must
add the shared launch gate immediately around expiry recheck/Process.Start before
the source becomes public. Until then, no public tool may return or publish it.

## Managed publisher

Allow only:

    <application.managedRoot>/launch-scripts/<name>.ps1

where name matches ASCII letters, digits, underscore, or hyphen and is 1..64
characters. The API accepts the branded descriptor plus a logical name, never an
arbitrary caller path or caller-supplied source. It deterministically invokes the
renderer itself; if a lower-level seam accepts bytes, it must compare them
byte-for-byte with a fresh render before publication.

Perform bounded no-link canonical containment checks on every existing ancestor
and the destination. Support prospective validation when managedRoot does not yet
exist, then require fresh real-path revalidation at publication. Use atomic
exclusive creation with restrictive mode where supported:

- absent name: publish exact BOM-prefixed bytes;
- existing regular same-name/same-bytes: idempotent success;
- existing different content, link/reparse point, directory, or special file:
  conflict, never overwrite.

Enforce aggregate launch-scripts count and byte caps as well as per-file bytes so
distinct valid names cannot grow the directory without bound. Do not delete an
unknown or merely old script to make room. Expose an exact path+sha256 removal
operation for Commit 12, which may remove only the file bound to a proven-retired
external marker; define safe uninstall around the same evidence.

Use bounded, same-directory temporary names and exclusive atomic publication.
Clean only exact temporary files created by the current operation. After a crash
or uncertain completion, reconcile the final path/hash: exact committed bytes are
idempotent success, an exact still-owned temporary may be removed, and every other
state is a conflict. Do not create the managed root during descriptor construction
or prospective validation.

## Tests

Cover:

- manager spawn behavior before/after helper extraction;
- argv round-trip through a fixture echo executable for empty strings, spaces,
  quotes, trailing backslashes, Unicode, and shell metacharacters;
- unchanged manager error codes/messages plus descriptor-only NUL/control
  hardening, token bounds, and total-length refusal;
- owner-token rejection at factory, renderer, and writer;
- forged kind, ownership, runtime kind, cwd, expiry, grants, brand, and executable;
- resolver change/replacement between each boundary;
- exact single U+FEFF/UTF-8 BOM representation, literal escaping,
  ProcessStartInfo fields, local expiry check, and absence of
  Start-Process/ArgumentList;
- prospective and final containment, links/reparse points, byte caps, exclusive
  atomic publication, aggregate count/byte caps, crash/temp reconciliation,
  exact-hash removal, same-bytes idempotency, and different-content conflict;
- preview-shaped object-literal rejection without importing optional Commit 8.

## Validation

    npx vitest run tests/platform/windows/command-line.test.ts tests/launch/external-game-launch-descriptor.test.ts tests/launch/powershell-launch-script.test.ts tests/observer/owned-runtime-manager-spawn-publication.test.ts
    npm run test:stage4
    npm run typecheck
    npm run build
    npm run lint:unused

Run the argv round-trip test on Windows; a pure string expectation is not an
adequate substitute for the platform gate.

## Commit acceptance

- Owned manager behavior remains unchanged through shared argv primitives.
- Forged or stale descriptors fail at every output boundary.
- Published files are bounded, contained, atomic, and never overwritten.
- No public script action, observer preparation, external marker, process
  inventory, or claim of ownership is added.
