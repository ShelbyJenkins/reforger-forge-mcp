# LMDB persistence migration implementation guide

**Status:** Deferred follow-on work  
**Parent context:** [Cross-cutting consolidation implementation guide](README.md)  
**Research snapshot:** 2026-07-19, against the active working tree  
**Entry condition:** The parent consolidation follow-on is separately scheduled or its implementation is complete; this migration must receive its own review and risk acceptance.

## Purpose

This is an independent follow-on to the cross-cutting consolidation work. It
is intentionally deferred because it changes the storage medium underneath
durable Workbench and observer state. It must not be mixed into the redaction,
time, protocol-generation, manifest, or test-support tasks unless a separate
review explicitly accepts the migration risk.

## Motivation and decision

The current `src/foundation/json-store.ts` is both a JSON file format and a
storage/concurrency layer. It currently supplies:

1. bounded, link-safe reads and atomic file publication;
2. schema validation and corruption inspection;
3. process-local compare-and-swap (CAS);
4. a helper-mediated CAS boundary for mutations that must remain inside the
   native Windows lifecycle helper; and
5. bounded retention accounting for stores that contain multiple records.

LMDB is a reasonable replacement for the first four *storage* concerns when
the state is allowed to live in an opaque local database. The `lmdb` package
provides TypeScript declarations, transactions, multi-process operation, and
conditional versioned writes. It is not a JSON-file package: values need an
explicit encoding, and the database is not intended to be edited by hand.

The migration decision is therefore:

- use LMDB for authoritative lifecycle, spawn-journal, and other internal KV
  state whose consumers can use a database API;
- retain ordinary JSON receipts, manifests, evidence, and corruption archives
  when an external helper, packaging contract, operator, or test explicitly
  requires a filesystem path and human-readable bytes; and
- do not claim that moving a record into LMDB preserves a file-based protocol.
  Any native helper that currently receives or opens a JSON path needs an
  explicit bridge or protocol change.

The package version, native/prebuilt binary availability, and Windows support
must be verified against the project’s supported Node versions before this
section is scheduled. Pin the selected version in `package.json` and
`package-lock.json`; do not use a floating range for the first migration.

## Starting-point inventory

Before changing code, record the current file-backed consumers and classify
each record. The classification is part of the migration contract.

| Current record or use | Current owner | Initial LMDB decision | Reason |
| --- | --- | --- | --- |
| Workbench lifecycle state | `src/workbench/process-guard.ts` | Migrate only after helper boundary is resolved | Authoritative CAS state, but current helper paths may assume files |
| Workbench spawn journal | `src/workbench/process-guard.ts` | Migrate only with lifecycle state | Must share generation/recovery semantics with lifecycle ownership |
| Owned-runtime receipts and pending-start records | `src/observer/owned-runtime-manager.ts` | Candidate for migration | Internal durable state with schema validation and bounded retention |
| Content-addressed bundle manifest | `src/companions/content-addressed-bundle.ts` | Keep as JSON initially | Manifest is part of an on-disk immutable bundle contract |
| Corrupt-record archives | `JsonCasStore.archiveCorrupt` callers | Keep as files | Archives are operator/evidence artifacts and must retain raw bytes |
| General JSON receipts/evidence | Workbench and observer receipt owners | Keep unless a consumer explicitly needs KV | Human-readable/exportable output is not a database record |

Suggested inventory commands:

~~~powershell
rg -n "BoundedJsonStore|JsonCasStore|atomicWriteFile|archiveCorrupt|\.json" src tests -g "*.ts"
rg -n "lifecycle|spawn|receipt|manifest|pending-start|storageRoot" src/workbench src/observer src/companions -g "*.ts"
rg -n "helper.*path|path.*helper|lifecycle.*json|spawn.*json" src scripts observer tests -g "*.*"
~~~

For every candidate, document whether it is read by another process, whether
its bytes are exported, its maximum expected size, its retention policy, and
whether it must remain recoverable after an uncertain helper outcome.

## Target contracts

Introduce a narrow domain-neutral port rather than allowing LMDB types to
spread through Workbench and observer code:

~~~ts
export interface DurableKvRecord<T> {
  readonly value: T;
  readonly version: number;
}

export interface DurableKvStore<T> {
  read(key: string): Promise<DurableKvRecord<T> | null>;
  put(
    key: string,
    value: T,
    expectedVersion: number | null
  ): Promise<
    | { kind: "replaced"; current: DurableKvRecord<T> }
    | { kind: "conflict"; actualVersion: number | null }
  >;
  remove(key: string, expectedVersion: number): Promise<boolean>;
  close(): Promise<void>;
}
~~~

The public port should expose domain values and a numeric storage version, not
LMDB transaction objects, buffers, or database handles. Existing UUID
`generation` fields remain domain-level lifecycle identity. They must not be
silently replaced by the LMDB version number; compare both when the domain
contract requires both.

Add an explicit codec boundary:

~~~ts
export interface DurableRecordCodec<T> {
  encode(value: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}
~~~

The codec must perform the existing Zod/schema parse after decoding. If JSON
diagnostics or interoperability are useful, encode JSON UTF-8 bytes inside
LMDB, but treat that as an implementation choice rather than proof that the
database is a JSON store.

## Storage layout

Use one database environment under the already managed private storage root.
Do not derive keys by concatenating untrusted paths. Define a versioned key
namespace and encode components unambiguously, for example:

~~~text
v1\0workbench\0lifecycle
v1\0workbench\0spawn-journal
v1\0observer\0runtime\0<runtime-id>
v1\0observer\0pending-start\0<runtime-id>
~~~

The exact key encoding must be centralized and tested for collision,
case-folding, separator, and invalid-identifier behavior. A database key is
not a substitute for the existing managed-path checks on records that remain
files.

Store an envelope, not an unversioned domain object:

~~~ts
interface LmdbEnvelope {
  schema: string;
  generation: string;
  writtenAtMs: number;
  value: Uint8Array;
}
~~~

The envelope gives migrations and diagnostics a stable place for schema and
generation metadata. Validate `schema`, `generation`, timestamps, and decoded
domain values before returning a record. Reject unknown envelope versions
closed rather than guessing how to decode them.

## Implementation tasks

### LMDB-0: freeze the file-backed behavior

1. Run the existing foundation, Workbench, observer, build, package, and
   multi-process lifecycle tests.
2. Record representative lifecycle and spawn-journal JSON bytes, generation
   changes, malformed-state behavior, archive behavior, and uncertain-helper
   outcomes.
3. Add a test-only store factory so domain contract tests can run against the
   existing JSON implementation and the future LMDB implementation.
4. Do not delete or weaken `json-store.ts` during this characterization step.

### LMDB-1: add the dependency and environment owner

1. Add the pinned `lmdb` dependency and verify installation on the supported
   Windows Node versions, clean checkout, npm pack/install, and CI runner.
2. Add `src/foundation/lmdb-store.ts` with one environment owner. Configure
   the environment beneath the managed root and refuse a root that is a
   symlink, non-directory, or outside the configured storage boundary.
3. Make environment opening lazy and idempotent. Expose an explicit async
   `close()` and ensure test teardown closes every environment before removing
   temporary roots.
4. Do not open one LMDB environment per record. Use one environment per
   managed store and namespaced keys.
5. Set database options deliberately and document durability expectations. A
   successful in-memory visibility result is not automatically the same as a
   durable-on-disk result.

### LMDB-2: implement codecs, schema checks, and CAS

1. Implement codecs that reject malformed bytes, unsupported envelope schema,
   invalid UUID generations, invalid timestamps, and domain-schema failures.
2. Implement `read` and `put` inside LMDB read/write transactions.
3. Use LMDB’s conditional version facility, or an equivalent transactionally
   checked version field, so the expected version is checked at commit time.
   A separate `get` followed by an unconditional `put` is not CAS.
4. Map a failed conditional write to `{ kind: "conflict" }`; do not turn it
   into a generic I/O error.
5. Preserve the current distinction between missing, malformed, schema-invalid,
   and conflicting state at the domain boundary.
6. Add an optional `durable` operation only if callers need a stronger flush
   boundary than ordinary commit. Do not silently promise power-loss
   durability without testing the selected LMDB options on Windows.

### LMDB-3: preserve helper-mediated lifecycle authority

This is the migration gate. The current lifecycle design deliberately keeps
some CAS operations inside a native Windows helper. Decide one of the following
before migrating lifecycle records:

1. **Node-owned database authority:** the helper stops reading/mutating the
   lifecycle record directly and Node performs all lifecycle CAS while holding
   the existing machine-wide mutex. The helper remains responsible for exact
   process/endpoint operations only.
2. **Helper-owned database authority:** the helper opens the same LMDB
   environment and implements the conditional mutation protocol. This requires
   compatible LMDB access, environment lifecycle rules, and a new private
   request/response contract.
3. **File bridge retained:** lifecycle state remains a JSON publication at the
   helper boundary while internal observer records move to LMDB. This is the
   lowest-risk incremental option, but it does not remove `JsonCasStore` for
   Workbench lifecycle state.

Do not let Node and the helper independently maintain copies of lifecycle
state. Dual authority creates a split-brain recovery path that the current
generation checks are intended to prevent.

### LMDB-4: migrate one record family at a time

Recommended order:

1. A low-risk internal observer receipt with no external file consumer.
2. Pending-start/runtime records after their bounded-retention policy has an
   LMDB equivalent.
3. Spawn journal and lifecycle state only after LMDB-3 is accepted and tested.
4. Leave bundle manifests and exported receipts as files unless there is a
   separate product reason to change their format.

For each family:

1. Add a versioned database namespace and codec.
2. Add read-only inspection and metrics before changing writes.
3. Import existing files only after validating the same schema and generation
   rules used by normal reads.
4. Use a one-time migration marker in the same LMDB transaction as the first
   authoritative import.
5. Cut over reads and writes together. Do not independently dual-write the
   file and database without a reconciliation protocol.
6. Preserve the old file until the migration is confirmed and the rollback
   window has expired. Deletion must be an explicit cleanup task.

### LMDB-5: quotas, retention, and recovery

LMDB provides database persistence, not this project’s existing retention
policy. Recreate the policy explicitly:

1. Count logical records by namespace.
2. Track encoded byte size before admitting a new value.
3. Reject a write that exceeds per-record or aggregate budgets.
4. Keep domain sweep/pinning decisions outside the foundation store.
5. Define what happens when the database is full, damaged, locked, or opened
   by an incompatible schema version.
6. Keep raw JSON/file archives for externally visible corruption and migration
   rollback. An LMDB decode failure must not be “repaired” by overwriting the
   only copy.

### LMDB-6: remove only after parity evidence

After all selected record families use the new port:

1. Delete only the unused JSON-store paths and backend adapters.
2. Retain file primitives required by manifests, receipts, evidence, and the
   helper bridge.
3. Update package checks and documentation to include the LMDB database files
   only if they are intentionally shipped or created by the application.
4. Do not package a user’s runtime database into the npm artifact.

## Failure and rollback policy

The migration must remain safe under process kill, helper timeout, machine
mutex loss, concurrent MCP instances, invalid bytes, and interrupted first
startup. Required rules:

- A failed import leaves the source JSON untouched and leaves no migration
  marker that claims success.
- A CAS conflict reloads the current record and preserves the existing public
  generation-mismatch behavior.
- An uncertain helper result preserves the authoritative record and returns the
  existing recovery-required result; it must not retry an unknown mutation
  merely because the database write was not observed by the caller.
- A database-open or decode failure fails closed for lifecycle mutation.
- Rollback is implemented as a versioned read/write adapter choice, not by
  copying possibly stale JSON back over newer LMDB state.

## Test plan

Reuse the existing foundation contract suite from
`tests/foundation/json-store-contract.ts` as the behavioral minimum, adding a
parallel LMDB factory. Add focused tests for:

1. missing, valid, malformed, schema-invalid, and unsupported-version records;
2. conditional write success and two-writer conflict;
3. concurrent processes opening the same environment on Windows;
4. process termination during a write transaction;
5. environment close/reopen persistence;
6. key namespace and collision resistance;
7. per-record and aggregate quota enforcement;
8. migration idempotence and interrupted-import recovery;
9. helper timeout and machine-mutex-loss behavior; and
10. database cleanup after parallel tests.

Run the existing lifecycle multiprocess and helper-timeout suites without
changing their assertions. Add a real LMDB integration tier; do not replace
all unit tests with an in-memory fake, because the relevant guarantees concern
the filesystem, native locking, process boundaries, and recovery.

## Validation

~~~powershell
npm install
npm run build
npm test -- tests/foundation/json-store.test.ts tests/workbench/process-guard.test.ts
npm test -- tests/workbench/multiprocess-lifecycle.test.ts tests/workbench/lifecycle-helper-timeout.test.ts
npm run test:package
~~~

Also run the LMDB integration tier on every supported Windows Node version and
on a clean checkout. Record whether each test proves committed visibility,
reopen persistence, or durable flush; those are separate claims.

## Completion criteria

This LMDB follow-on is complete only when:

- the selected `lmdb` version installs and packages successfully on supported
  Windows environments;
- every migrated record family has a schema/versioned codec and a documented
  key namespace;
- CAS conflicts, missing state, malformed state, and recovery-required
  outcomes preserve their existing domain semantics;
- the helper authority decision is implemented and covered by real
  multi-process tests;
- bounded retention and cleanup behavior has parity evidence;
- migration is idempotent, interruption-safe, and rollback-documented;
- external JSON contracts remain files or have an explicitly reviewed
  replacement protocol; and
- the full relevant test, build, package, and controlled lifecycle evidence is
  green.

## LMDB non-goals

- Do not migrate every `.json` file merely to eliminate filesystem code.
- Do not use LMDB as a cache while continuing to treat JSON and LMDB as equal
  authorities.
- Do not expose LMDB handles, transactions, or binary values through domain
  APIs.
- Do not remove generation checks because LMDB has its own record versions.
- Do not claim human-readable inspection, raw-byte archival, or helper
  interoperability after moving a record into an opaque database.
