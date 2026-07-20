# LMDB lifecycle Node-authority migration implementation guide

**Status:** In progress
**Parent context:** [LMDB persistence migration implementation guide](90-independent-lmdb-persistence-migration.md)
**Research snapshot:** 2026-07-20, against the active working tree
**Scope decision (reviewed and accepted):** implement LMDB-3 as **Node-owned
database authority**. Owned-runtime-manager's ten file-backed record families
are explicitly out of scope for this guide; they remain a separate follow-on.

## Why Node-owned authority is lower risk than it first reads

`WorkbenchProcessGuard.backend.withMachineMutex` already spawns a **separate**
`powershell.exe -Mode HoldMutex` process that holds the OS-level named mutex
for the duration of the Node-side `action` callback
(`src/platform/windows/exact-process-backend.ts:270`). The current
`ReplaceState`/`ArchiveState` helper modes are a *second*, independent
`powershell.exe` invocation that trusts the caller already holds that mutex —
they do not themselves acquire it. This means Node-owned authority does not
require redesigning mutex acquisition at all: the `action` callback already
runs under real cross-process exclusion. The only change is that the durable
read-modify-write of lifecycle/spawn-journal state moves from "ask a second
helper process to CAS a JSON file" to "CAS an LMDB record directly from
Node," while remaining inside that same `action` callback.

## Target contracts

Reuse `src/foundation/durable-kv.ts` and `src/foundation/lmdb-store.ts`
unchanged (already implemented and tested per [90](90-independent-lmdb-persistence-migration.md)).
Add one new adapter so `process-guard.ts` call sites need minimal changes:

```ts
// src/foundation/lmdb-cas-store.ts
export interface LmdbCasInspection<T> =
  | { kind: "missing" }
  | { kind: "versioned"; value: T; generation: string }
  | { kind: "corrupt"; path: string; rawSha256: string; message: string };

export interface LmdbCasStoreOptions<T> {
  readonly storageRoot: string;
  readonly databaseDirectory?: string;
  readonly key: string;              // one fixed durable key per store instance
  readonly schema: string;
  readonly codec: DurableRecordCodec<T>;
  readonly generationOf: (value: T) => string;
  readonly corruptArchiveDir: string; // where corrupt bytes are archived as files
  readonly beforeCompareAndSwap?: (args: {
    expectedGeneration: string | null;
    next: T;
  }) => Error | void;                // test-only injection seam, see below
}

export class LmdbCasStore<T> {
  inspect(): Promise<LmdbCasInspection<T>>;
  compareAndSwap(expected: string | null, next: T):
    Promise<{ kind: "replaced"; current: { value: T; generation: string } }
      | { kind: "conflict"; actualGeneration: string | null }>;
  archiveCorrupt(record: { kind: "corrupt" } & LmdbCasInspection<T>, archivePath: string): Promise<void>;
}
```

This mirrors the existing `JsonCasPort<T>` surface
(`src/foundation/json-store.ts:82`) closely enough that
`WorkbenchProcessGuard`'s call sites (`readLifecycleState`,
`readSpawnJournal`, `createClaimedState`, `replaceExisting`,
`createSpawnJournal().persist`, the malformed-state archival branch in
`validateAndClaimLocked`) change only at construction time, not at call
sites. `LmdbCasStore` is intentionally process-guard-specific glue, not a
new foundation primitive — the narrow `DurableKvStore` port stays the single
foundation abstraction per [90](90-independent-lmdb-persistence-migration.md).

### `LmdbDurableKvStore.inspect(key)` addition

`LmdbCasStore` needs to distinguish "missing" / "valid" / "corrupt" without
throwing on corrupt records (unlike `LmdbDurableKvStore.read`, which throws
`LmdbStoreError` on decode failure). Add a non-throwing inspection method to
`src/foundation/lmdb-store.ts`:

```ts
export type LmdbInspection<T> =
  | { kind: "missing" }
  | { kind: "valid"; value: T; version: number }
  | { kind: "corrupt"; version: number; rawSha256: string; message: string };

// on LmdbDurableKvStore<T>
inspect(key: string): Promise<LmdbInspection<T>>;
```

`inspect` reads the raw entry, computes `sha256` over the raw stored bytes
before attempting to decode, and catches `LmdbStoreError` from
`decodeStoredValue` to produce the `corrupt` variant instead of throwing.
`read()` keeps throwing (existing behavior/tests are unaffected); `inspect`
is additive.

### Corrupt-record archival stays file-based

Per [90](90-independent-lmdb-persistence-migration.md)'s non-goals ("Do not
claim human-readable inspection, raw-byte archival... after moving a record
into an opaque database"), `LmdbCasStore.archiveCorrupt` writes the raw
corrupt envelope bytes to a JSON file under a `corrupt/` directory beneath
`stateDir`, then removes the LMDB entry (using its known raw storage
version) so a subsequent read reports `missing`. This matches the current
file-based behavior of `JsonCasStore.archiveCorrupt`, which renames the
corrupt file away from the canonical path.

### Storage layout

One LMDB environment per `WorkbenchProcessGuard` instance, rooted at the
existing `stateDir` (`%LOCALAPPDATA%/ReforgerForge/Workbench/v3` by default),
in a `durable-kv-v1` subdirectory (the `LmdbDurableKvStore` default). Keys:

```text
v1\0workbench\0lifecycle
v1\0workbench\0spawn-journal
```

`WorkbenchProcessGuard.statePath` / `.spawnJournalPath` (currently public
`string` file paths) are **removed** — they have no LMDB equivalent and are
referenced only inside `process-guard.ts` and one test
(`tests/workbench/process-guard.test.ts:265`, which directly
`writeFileSync`s malformed bytes at `guard.statePath` to simulate
corruption; see Test plan below for its replacement). `stateDir` remains
public and is now also the LMDB environment root and corrupt-archive root.

## Test-injection seam (`beforeCompareAndSwap`)

Five existing tests use `FakeLifecycleBackend.replaceFailure` — a hook
previously invoked from inside `HelperMediatedJsonCasBackend`'s write path —
for two distinct purposes:

1. Injecting a write-time `Error` to test CAS-failure recovery
   (`tests/workbench/restart-ownership.test.ts:590`).
2. Firing a side effect (mutating an unrelated file) at the exact moment a
   specific lifecycle transition is about to commit, to test revalidation
   races (`tests/workbench/runner.test.ts:899,928`).

Since Node no longer routes writes through the backend at all, this hook
moves to `WorkbenchProcessGuardOptions.beforeLifecycleReplace` (invoked
immediately before `LmdbCasStore.compareAndSwap` attempts its write, i.e. the
same logical point in the control flow as before). `FakeLifecycleBackend`
keeps its `replaceFailure` **property** (pure test state, no interface
method), and the two harness constructors
(`tests/workbench/runner.test.ts:117`,
`tests/workbench/restart-ownership.test.ts:127`) wire
`beforeLifecycleReplace: (args) => backend.replaceFailure?.(args) ?? undefined`.
The five individual `harness.backend.replaceFailure = ...` assignments in
test bodies do not change.

`createFakeLifecycleBackend`'s `replaceState`/`archiveState` method
implementations are deleted along with the interface members (below).

## Helper protocol changes

Remove from `WorkbenchLifecycleBackend` (`src/workbench/process-guard.ts`)
and `WindowsLifecycleBackend`:

- `replaceState(args): Promise<void>`
- `archiveState(args): Promise<void>`

Remove from `scripts/windows/workbench-lifecycle.ps1`:

- `'ReplaceState'` and `'ArchiveState'` from the `-Mode` `ValidateSet`
- `Invoke-ReplaceState`, `Invoke-ArchiveState`, and their dispatch cases

Remove from `tests/workbench/lifecycle-helper-timeout.test.ts`:

- The schema-contract test asserting `$currentVersion -ne 3` appears in the
  helper source (the version check now lives only in
  `parseLifecycleState`/the LMDB envelope codec)
- The "returns durable recovery when lifecycle state replacement does not
  return" test (`backend.replaceState(...)`; the method no longer exists)

All other cases in that file (mutex acquisition/timeout/fail-stop,
`inspectProcess`, `verifyEndpointVacant`, `verifyAndTerminate`) are untouched
— the mutex and process-inspection helper surface is unchanged.

`tests/workbench/multiprocess-lifecycle.test.ts` and
`tests/workbench/fixtures/lifecycle-owner-worker.ts` need **no changes**:
they exercise `WorkbenchProcessGuard` end-to-end through the real
`WindowsLifecycleBackend` and real `stateDir`, so they automatically cover
real cross-process LMDB CAS once the swap lands. This is the primary
real-Windows evidence for the migration (`describe.runIf(platform() === "win32")`).

## Implementation tasks

1. Add `LmdbDurableKvStore.inspect(key)` to `src/foundation/lmdb-store.ts`.
2. Add `src/foundation/lmdb-cas-store.ts` (`LmdbCasStore<T>`), including
   corrupt-archival to a file and the `beforeCompareAndSwap` test seam.
3. In `src/workbench/process-guard.ts`:
   - Remove `statePath`/`spawnJournalPath` fields, `casBackend()`,
     `HelperMediatedJsonCasBackend`/`JsonCasStore` imports and usage.
   - Add `beforeLifecycleReplace` to `WorkbenchProcessGuardOptions`.
   - Replace `lifecycleStore()`/`spawnStore()` to construct `LmdbCasStore`
     instances over `stateDir`, with the fixed keys above.
   - Remove `replaceState`/`archiveState` from `WorkbenchLifecycleBackend`
     and `WindowsLifecycleBackend`.
4. Update `scripts/windows/workbench-lifecycle.ps1` per Helper protocol
   changes above.
5. Update `tests/workbench/fake-lifecycle-backend.ts` (drop
   `replaceState`/`archiveState` methods, keep `replaceFailure` property).
6. Update `tests/workbench/runner.test.ts` and
   `tests/workbench/restart-ownership.test.ts` harness construction to wire
   `beforeLifecycleReplace`.
7. Update `tests/workbench/lifecycle-helper-timeout.test.ts` per above.
8. Rewrite `tests/workbench/process-guard.test.ts`'s malformed-state test to
   inject corruption by opening the LMDB environment directly at the known
   key (same technique as `tests/foundation/lmdb-store.test.ts`'s
   `replaceRawValue`) instead of `writeFileSync(guard.statePath, ...)`.
9. Add focused `LmdbCasStore` tests (new
   `tests/foundation/lmdb-cas-store.test.ts`): missing/valid/corrupt
   inspection, CAS success/conflict, corrupt archival-then-recovery,
   `beforeCompareAndSwap` injection.
10. Run the validation commands below; fix regressions until green.

## Non-goals (unchanged from the parent guide)

- `src/observer/owned-runtime-manager.ts`'s ten record families are not
  touched by this guide.
- No change to public lifecycle error codes, claim/refusal semantics, or
  durable recovery behavior — this is a storage-layer swap under an
  unchanged domain contract.
- No change to mutex acquisition, process inspection, or endpoint
  verification helper modes.

## Validation

```powershell
npm run build
npm test -- tests/foundation/lmdb-store.test.ts tests/foundation/lmdb-cas-store.test.ts tests/foundation/durable-kv.test.ts
npm test -- tests/workbench/process-guard.test.ts tests/workbench/lifecycle-helper-timeout.test.ts
npm test -- tests/workbench/runner.test.ts tests/workbench/restart-ownership.test.ts tests/workbench/activity-gate.test.ts tests/workbench/termination-identity-race.test.ts tests/workbench/spawn-crash-characterization.test.ts tests/workbench/stage3-acceptance.test.ts tests/workbench/project-launcher-safety.test.ts
npm test -- tests/workbench/multiprocess-lifecycle.test.ts
npm test
npm run test:package
```

## Completion criteria

- `LmdbCasStore` has focused tests for every inspection/CAS/archival path.
- `process-guard.ts` no longer imports `JsonCasStore` or
  `HelperMediatedJsonCasBackend`.
- The PS1 helper no longer implements `ReplaceState`/`ArchiveState`.
- All listed test files pass, including the real-Windows
  `multiprocess-lifecycle.test.ts` suite.
- `npm run build` and `npm test` (full suite) are green.
