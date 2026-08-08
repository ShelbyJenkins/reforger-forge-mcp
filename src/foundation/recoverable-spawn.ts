import type { ExactProcessBackend } from "./exact-process-backend.js";
import type { ExactProcessIdentity } from "./identity.js";

export type RecoverableSpawnPhase =
  | "pre_spawn"
  | "spawned_unverified"
  | "identity_verified"
  | "published";

/**
 * Durable, domain-neutral evidence for one process-creation attempt.
 *
 * A spawned_unverified record is intentionally not termination authority: a
 * PID alone can be reused. Only identity_verified/published records carry the
 * exact identity required for automated recovery.
 */
export interface RecoverableSpawnRecord<
  Identity extends ExactProcessIdentity = ExactProcessIdentity,
  Metadata = unknown
> {
  readonly transactionId: string;
  readonly phase: RecoverableSpawnPhase;
  readonly pid: number | null;
  readonly identity: Identity | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly metadata: Metadata;
}

export interface RecoverableSpawnJournal<
  Identity extends ExactProcessIdentity,
  Metadata
> {
  /** Compare-and-swap or otherwise durably commit the next phase. */
  persist(
    previous: RecoverableSpawnRecord<Identity, Metadata> | null,
    next: RecoverableSpawnRecord<Identity, Metadata>
  ): Promise<RecoverableSpawnRecord<Identity, Metadata>>;
  /**
   * Retire the exact pre_spawn record after a separate pre-spawn policy hook
   * fails. This is safe only before the process-creation callback is invoked.
   */
  discardPreSpawn?(
    record: RecoverableSpawnRecord<Identity, Metadata>
  ): Promise<void>;
}

export interface RecoverableSpawnFence {
  /** Refuse the next irreversible phase after reservation ownership is lost. */
  assertActive(): void | Promise<void>;
}

export interface RecoverableSpawnOptions<
  Child,
  Identity extends ExactProcessIdentity,
  Metadata,
  Published
> {
  readonly transactionId: string;
  readonly metadata: Metadata;
  readonly backend: ExactProcessBackend;
  readonly journal: RecoverableSpawnJournal<Identity, Metadata>;
  readonly fence?: RecoverableSpawnFence;
  readonly now?: () => number;
  /**
   * Synchronous policy revalidation after durable pre_spawn publication and
   * immediately before process creation.
   */
  readonly beforeSpawn?: () => void;
  readonly spawn: () => Child;
  readonly childPid: (child: Child) => number | null | undefined;
  readonly awaitSpawn?: (child: Child) => Promise<void>;
  readonly inspect: (
    child: Child,
    backend: ExactProcessBackend
  ) => Promise<Identity>;
  /**
   * Domain-specific verification that must run only after exact identity is
   * durably journaled, but still before lifecycle retention or publication.
   * A failure therefore leaves recovery authority for the spawned child.
   */
  readonly afterIdentityPersisted?: (
    identity: Identity,
    child: Child,
    record: RecoverableSpawnRecord<Identity, Metadata>
  ) => Promise<void>;
  /** Domain-specific retain/readiness work that must precede publication. */
  readonly beforePublish?: (
    identity: Identity,
    child: Child,
    record: RecoverableSpawnRecord<Identity, Metadata>
  ) => Promise<void>;
  /** Publish the domain's authoritative ownership record. */
  readonly publish: (
    identity: Identity,
    child: Child,
    record: RecoverableSpawnRecord<Identity, Metadata>
  ) => Promise<Published>;
}

export interface RecoverableSpawnResult<
  Child,
  Identity extends ExactProcessIdentity,
  Metadata,
  Published
> {
  readonly child: Child;
  readonly identity: Identity;
  readonly publication: Published;
  readonly record: RecoverableSpawnRecord<Identity, Metadata>;
}

export class RecoverableSpawnPreSpawnCleanupError extends Error {
  constructor(
    readonly preSpawnError: unknown,
    readonly cleanupError: unknown
  ) {
    const preSpawnMessage = preSpawnError instanceof Error
      ? preSpawnError.message
      : String(preSpawnError);
    const cleanupMessage = cleanupError instanceof Error
      ? cleanupError.message
      : String(cleanupError);
    super(
      `Pre-spawn validation failed (${preSpawnMessage}), and durable pre_spawn ` +
        `journal retirement could not be proven (${cleanupMessage}).`,
      { cause: cleanupError instanceof Error ? cleanupError : undefined }
    );
    this.name = "RecoverableSpawnPreSpawnCleanupError";
  }
}

function positivePid(value: number | null | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new TypeError("Spawn returned no positive, safe child PID.");
  }
  return value!;
}

function assertRecordTransition<Identity extends ExactProcessIdentity, Metadata>(
  previous: RecoverableSpawnRecord<Identity, Metadata> | null,
  next: RecoverableSpawnRecord<Identity, Metadata>
): void {
  const order: Record<RecoverableSpawnPhase, number> = {
    pre_spawn: 0,
    spawned_unverified: 1,
    identity_verified: 2,
    published: 3,
  };
  if (previous && previous.transactionId !== next.transactionId) {
    throw new TypeError("Spawn journal changed transaction identity.");
  }
  if (previous && order[next.phase] !== order[previous.phase] + 1) {
    throw new TypeError(
      `Invalid recoverable spawn transition ${previous.phase} -> ${next.phase}.`
    );
  }
  if (next.phase === "pre_spawn" && (next.pid !== null || next.identity !== null)) {
    throw new TypeError("pre_spawn cannot contain process identity.");
  }
  if (next.phase === "spawned_unverified" && (next.pid === null || next.identity !== null)) {
    throw new TypeError("spawned_unverified requires only a PID.");
  }
  if ((next.phase === "identity_verified" || next.phase === "published") &&
      (!next.identity || next.pid !== next.identity.pid)) {
    throw new TypeError(`${next.phase} requires one matching exact process identity.`);
  }
}

async function assertFenceActive(fence: RecoverableSpawnFence): Promise<void> {
  const pending = fence.assertActive();
  if (pending) await pending;
}

/**
 * Execute the shared recoverable spawn state machine.
 *
 * The journal is deliberately injected. Plain Node stores use rename-based
 * CAS; Workbench lifecycle state uses its machine-mutex/helper-mediated CAS.
 */
export async function runRecoverableSpawn<
  Child,
  Identity extends ExactProcessIdentity,
  Metadata,
  Published
>(
  options: RecoverableSpawnOptions<Child, Identity, Metadata, Published>
): Promise<RecoverableSpawnResult<Child, Identity, Metadata, Published>> {
  const now = options.now ?? Date.now;
  const fence = options.fence ?? { assertActive: () => undefined };
  const createdAtMs = now();
  let record: RecoverableSpawnRecord<Identity, Metadata> = {
    transactionId: options.transactionId,
    phase: "pre_spawn",
    pid: null,
    identity: null,
    createdAtMs,
    updatedAtMs: createdAtMs,
    metadata: options.metadata,
  };
  assertRecordTransition(null, record);
  record = await options.journal.persist(null, record);

  await assertFenceActive(fence);
  if (options.beforeSpawn) {
    try {
      options.beforeSpawn();
    } catch (error) {
      try {
        if (!options.journal.discardPreSpawn) {
          throw new Error("the recoverable spawn journal does not support exact pre_spawn retirement");
        }
        await options.journal.discardPreSpawn(record);
      } catch (cleanupError) {
        throw new RecoverableSpawnPreSpawnCleanupError(error, cleanupError);
      }
      throw error;
    }
  }
  const child = options.spawn();
  // Attach spawn/error observation before the journal's asynchronous CAS can
  // yield. Some ChildProcess implementations emit `spawn` in the next
  // microtask; subscribing after persistence would miss that terminal edge.
  const spawnReady = options.awaitSpawn?.(child);
  // Mark a rejected observation as handled even if PID validation or the
  // spawned_unverified journal CAS fails before this transaction can await it.
  // Awaiting the original promise below still propagates the same rejection.
  void spawnReady?.catch(() => undefined);
  const pid = positivePid(options.childPid(child));
  let next: RecoverableSpawnRecord<Identity, Metadata> = {
    ...record,
    phase: "spawned_unverified",
    pid,
    updatedAtMs: now(),
  };
  assertRecordTransition(record, next);
  record = await options.journal.persist(record, next);

  if (spawnReady) await spawnReady;
  await assertFenceActive(fence);
  const identity = await options.inspect(child, options.backend);
  if (identity.pid !== pid) {
    throw new TypeError(
      `Exact inspection returned PID ${identity.pid} for spawned PID ${pid}.`
    );
  }
  await assertFenceActive(fence);
  next = {
    ...record,
    phase: "identity_verified",
    identity,
    updatedAtMs: now(),
  };
  assertRecordTransition(record, next);
  record = await options.journal.persist(record, next);

  await assertFenceActive(fence);
  await options.afterIdentityPersisted?.(identity, child, record);
  await assertFenceActive(fence);
  await options.beforePublish?.(identity, child, record);
  await assertFenceActive(fence);
  const publication = await options.publish(identity, child, record);
  next = {
    ...record,
    phase: "published",
    updatedAtMs: now(),
  };
  assertRecordTransition(record, next);
  record = await options.journal.persist(record, next);
  return { child, identity, publication, record };
}

/** True only when a durable record is sufficient for exact automated cleanup. */
export function hasRecoverableExactIdentity<Identity extends ExactProcessIdentity>(
  record: RecoverableSpawnRecord<Identity, unknown>
): record is RecoverableSpawnRecord<Identity, unknown> & { identity: Identity; pid: number } {
  return (record.phase === "identity_verified" || record.phase === "published") &&
    record.identity !== null && record.pid === record.identity.pid;
}
