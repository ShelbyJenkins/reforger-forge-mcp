import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { boundedOption } from "#foundation/bounded-option";
import { LmdbRecordStore, LmdbRecordStoreError } from "#foundation/lmdb-record-store";
import { ObserverError, observerOptionError } from "./errors.js";
import {
  assertManagedPath,
  ensureCanonicalDirectory,
} from "./paths.js";

const STORAGE_VERSION = 1;
// Single LMDB namespace for the agent's private authority records. The store
// opens its own environment under `root`, distinct from the MCP process's
// owned-runtimes environment (the process boundary is preserved by IPC, never
// by sharing a database).
const AUTHORITY_FAMILY = "authority";
// A serialized authority record is at minimum `{}\n`; anything shorter is a
// truncated/corrupt value. Preserves the prior BoundedJsonStore lower bound.
const AUTHORITY_RECORD_MIN_BYTES = 2;
const DEFAULT_MAX_RECORDS = 1_024;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 32 * 1024 * 1024;
const DEFAULT_RELEASE_RETENTION_MS = 5 * 60_000;

const runtimeIdSchema = z.string().regex(
  /^rt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
);
const generationSchema = z.string().regex(/^[a-f0-9]{64}$/);
const releaseBindingSchema = z.object({
  runtimeId: runtimeIdSchema,
  sessionId: z.string().min(1).max(96),
  generation: generationSchema,
});
const authoritySchema = releaseBindingSchema.extend({
  preparedLaunchId: z.string().regex(
    /^pl-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  ),
  profilePath: z.string().min(1).max(32_768),
  runtimeKind: z.enum(["client", "listenServer", "dedicated", "testRunner"]),
  pid: z.number().int().positive(),
  executablePath: z.string().min(1).max(32_768),
  creationTimeFileTime: z.string().max(32).regex(/^\d+$/),
  ownerTokenArgument: z.string().min(1).max(192).startsWith("-reforgerForgeOwnerToken="),
  launchedAtMs: z.number().int().positive(),
});

export type OwnedRuntimeRecoveryAuthority = z.infer<typeof authoritySchema>;
type ReleaseBinding = z.infer<typeof releaseBindingSchema>;

const authorityRecordSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  authority: z.union([authoritySchema, releaseBindingSchema]),
  state: z.enum(["retained", "release_acknowledged"]),
  session: z.unknown().nullable(),
  jobs: z.array(z.unknown()).max(16_384),
  instances: z.array(z.unknown()).max(4_096),
  stopReservationId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  releasedAt: z.string().datetime().nullable(),
}).superRefine((record, context) => {
  if (record.state === "retained" && record.session === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["session"],
      message: "retained authority requires a session snapshot",
    });
  }
  if (record.state === "retained" && !("preparedLaunchId" in record.authority)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authority"],
      message: "retained authority requires exact runtime receipt fields",
    });
  }
});

export type OwnedRuntimeAuthorityRecord = z.infer<typeof authorityRecordSchema>;

export interface OwnedRuntimeAuthoritySnapshot {
  session: unknown;
  jobs: unknown[];
  instances: unknown[];
}

export interface OwnedRuntimeAuthorityStats {
  records: number;
  bytes: number;
  retained: number;
  releaseAcknowledged: number;
  maxRecords: number;
  maxBytes: number;
  maxRecordBytes: number;
}

function lifecycleGeneration(authority: OwnedRuntimeRecoveryAuthority): string {
  return createHash("sha256").update(JSON.stringify({
    runtimeId: authority.runtimeId,
    sessionId: authority.sessionId,
    preparedLaunchId: authority.preparedLaunchId,
    pid: authority.pid,
    executablePath: authority.executablePath,
    creationTimeFileTime: authority.creationTimeFileTime,
    ownerTokenArgument: authority.ownerTokenArgument,
    launchedAtMs: authority.launchedAtMs,
  })).digest("hex");
}

function sameAuthority(
  left: OwnedRuntimeRecoveryAuthority,
  right: OwnedRuntimeRecoveryAuthority
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Owner-private, bounded durable hand-off between private observer children.
 * A record is accepted only when its generation recomputes from the immutable
 * exact-runtime fields supplied by the MCP's durable runtime receipt.
 */
export class OwnedRuntimeAuthorityStore {
  readonly root: string;
  readonly maxRecords: number;
  readonly maxBytes: number;
  readonly maxRecordBytes: number;
  readonly releaseRetentionMs: number;
  private readonly recordStore: LmdbRecordStore;
  private closed = false;

  constructor(
    stateRoot: string,
    private readonly clock: () => number = Date.now,
    options: {
      maxRecords?: number;
      maxBytes?: number;
      maxRecordBytes?: number;
      releaseRetentionMs?: number;
    } = {}
  ) {
    this.root = ensureCanonicalDirectory(join(stateRoot, "owned-runtime-authorities-v1"));
    assertManagedPath(stateRoot, this.root);
    this.maxRecords = boundedOption(options.maxRecords, DEFAULT_MAX_RECORDS, 1, 100_000, "Owned runtime authority record limit", observerOptionError);
    this.maxBytes = boundedOption(options.maxBytes, DEFAULT_MAX_BYTES, 4_096, 1024 * 1024 * 1024, "Owned runtime authority byte limit", observerOptionError);
    this.maxRecordBytes = boundedOption(
      options.maxRecordBytes,
      Math.min(DEFAULT_MAX_RECORD_BYTES, this.maxBytes),
      1_024,
      this.maxBytes,
      "Owned runtime authority record byte limit",
      observerOptionError
    );
    this.releaseRetentionMs = boundedOption(
      options.releaseRetentionMs,
      DEFAULT_RELEASE_RETENTION_MS,
      0,
      24 * 60 * 60_000,
      "Owned runtime authority release retention",
      observerOptionError
    );
    this.recordStore = new LmdbRecordStore({
      storageRoot: this.root,
      maxRecordBytes: this.maxRecordBytes,
      // Bound listIds/usage scans to the aggregate record cap so a corrupt or
      // oversized authority namespace fails closed rather than materializing.
      maxScanRecords: this.maxRecords,
    });
  }

  /** Release the agent-private LMDB environment; called on agent shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    await this.recordStore.close();
  }

  validateAuthority(input: unknown): OwnedRuntimeRecoveryAuthority {
    const authority = authoritySchema.parse(input);
    if (lifecycleGeneration(authority) !== authority.generation) {
      throw new ObserverError(
        "SESSION_MISMATCH",
        "Owned runtime recovery generation does not match its exact durable receipt",
        409
      );
    }
    return authority;
  }

  read(runtimeId: string): OwnedRuntimeAuthorityRecord | null {
    runtimeIdSchema.parse(runtimeId);
    // After shutdown the environment is released; report nothing durable rather
    // than reopening it (which would re-hold the memory map past teardown).
    if (this.closed) return null;
    try {
      const record = this.readRecord(runtimeId);
      if (!record) return null;
      if (record.authority.runtimeId !== runtimeId ||
          ("preparedLaunchId" in record.authority &&
            lifecycleGeneration(record.authority) !== record.authority.generation) ||
          (!("preparedLaunchId" in record.authority) && record.state !== "release_acknowledged")) {
        throw new Error("filename or generation mismatch");
      }
      return record;
    } catch (error) {
      throw new ObserverError(
        "SESSION_UNVERIFIABLE",
        `Owned runtime recovery authority is invalid: ${error instanceof Error ? error.message : String(error)}`,
        409
      );
    }
  }

  retain(
    authorityInput: unknown,
    snapshot: OwnedRuntimeAuthoritySnapshot
  ): { record: OwnedRuntimeAuthorityRecord; alreadyRetained: boolean; reconstructed: boolean } {
    const authority = this.validateAuthority(authorityInput);
    const existing = this.read(authority.runtimeId);
    if (existing) {
      if (!("preparedLaunchId" in existing.authority)) {
        if (existing.authority.sessionId !== authority.sessionId ||
            existing.authority.generation !== authority.generation) {
          throw new ObserverError(
            "SESSION_MISMATCH",
            "Owned runtime recovery authority conflicts with a released generation",
            409
          );
        }
      } else {
        this.assertExact(existing, authority);
      }
      if (existing.state === "release_acknowledged") {
        throw new ObserverError(
          "SESSION_MISMATCH",
          "Owned runtime lifecycle generation was already released",
          409
        );
      }
      return { record: existing, alreadyRetained: true, reconstructed: true };
    }
    const now = new Date(this.clock()).toISOString();
    const record = authorityRecordSchema.parse({
      version: STORAGE_VERSION,
      authority,
      state: "retained",
      session: snapshot.session,
      jobs: snapshot.jobs,
      instances: snapshot.instances,
      stopReservationId: null,
      createdAt: now,
      updatedAt: now,
      releasedAt: null,
    });
    this.write(record, true);
    return { record, alreadyRetained: false, reconstructed: false };
  }

  updateSnapshot(
    runtimeId: string,
    sessionId: string,
    snapshot: OwnedRuntimeAuthoritySnapshot
  ): void {
    const existing = this.read(runtimeId);
    if (!existing || existing.state !== "retained" || existing.authority.sessionId !== sessionId) return;
    this.write(authorityRecordSchema.parse({
      ...existing,
      session: snapshot.session,
      jobs: snapshot.jobs,
      instances: snapshot.instances,
      updatedAt: new Date(this.clock()).toISOString(),
    }), false);
  }

  acknowledgeRelease(
    sessionId: string,
    runtimeId: string,
    generation: string
  ): { released: boolean; alreadyReleased: boolean; generation: string } {
    generationSchema.parse(generation);
    const existing = this.read(runtimeId);
    if (existing) {
      if (existing.authority.sessionId !== sessionId || existing.authority.generation !== generation) {
        throw new ObserverError(
          "SESSION_MISMATCH",
          "Owned runtime lifecycle release conflicts with another exact generation",
          409
        );
      }
      if (existing.state === "release_acknowledged") {
        return { released: false, alreadyReleased: true, generation };
      }
      const now = new Date(this.clock()).toISOString();
      this.write(authorityRecordSchema.parse({
        ...existing,
        state: "release_acknowledged",
        session: null,
        jobs: [],
        instances: [],
        stopReservationId: null,
        updatedAt: now,
        releasedAt: now,
      }), false);
      return { released: true, alreadyReleased: false, generation };
    }

    // The retain request may have been lost before delivery. A generation-only
    // tombstone is still exact within the private MCP trust boundary and makes
    // a later delayed retain/release conflict or replay deterministically.
    const now = new Date(this.clock()).toISOString();
    const binding: ReleaseBinding = releaseBindingSchema.parse({
      runtimeId,
      sessionId,
      generation,
    });
    this.write(authorityRecordSchema.parse({
      version: STORAGE_VERSION,
      authority: binding,
      state: "release_acknowledged",
      session: null,
      jobs: [],
      instances: [],
      stopReservationId: null,
      createdAt: now,
      updatedAt: now,
      releasedAt: now,
    }), true);
    return { released: false, alreadyReleased: true, generation };
  }

  claimStopReservation(
    sessionId: string,
    runtimeId: string,
    generation: string,
    reservationId: string
  ): { reserved: boolean; reservationId?: string; created: boolean } {
    z.string().uuid().parse(reservationId);
    const existing = this.requireRetained(sessionId, runtimeId, generation);
    if (existing.stopReservationId) {
      return existing.stopReservationId === reservationId
        ? { reserved: true, reservationId, created: false }
        : { reserved: false, reservationId: existing.stopReservationId, created: false };
    }
    this.write(authorityRecordSchema.parse({
      ...existing,
      stopReservationId: reservationId,
      updatedAt: new Date(this.clock()).toISOString(),
    }), false);
    return { reserved: true, reservationId, created: true };
  }

  releaseStopReservation(
    sessionId: string,
    runtimeId: string,
    generation: string,
    reservationId: string
  ): boolean {
    const existing = this.requireRetained(sessionId, runtimeId, generation);
    if (existing.stopReservationId !== reservationId) return false;
    this.write(authorityRecordSchema.parse({
      ...existing,
      stopReservationId: null,
      updatedAt: new Date(this.clock()).toISOString(),
    }), false);
    return true;
  }

  hasStopReservation(sessionId: string): boolean {
    return this.records().some((record) =>
      record.state === "retained" && record.authority.sessionId === sessionId &&
      record.stopReservationId !== null
    );
  }

  stopReservation(
    sessionId: string,
    runtimeId: string,
    generation: string
  ): string | null {
    return this.requireRetained(sessionId, runtimeId, generation).stopReservationId;
  }

  findRetainedBySession(sessionId: string): OwnedRuntimeAuthorityRecord | null {
    return this.records().find((record) =>
      record.state === "retained" && record.authority.sessionId === sessionId
    ) ?? null;
  }

  sweep(now = this.clock()): string[] {
    const removed: string[] = [];
    for (const record of this.records()) {
      if (record.state !== "release_acknowledged" || !record.releasedAt ||
          now - Date.parse(record.releasedAt) < this.releaseRetentionMs) continue;
      this.recordStore.remove(AUTHORITY_FAMILY, record.authority.runtimeId);
      removed.push(record.authority.runtimeId);
    }
    return removed.sort();
  }

  stats(): OwnedRuntimeAuthorityStats {
    const base = {
      maxRecords: this.maxRecords,
      maxBytes: this.maxBytes,
      maxRecordBytes: this.maxRecordBytes,
    };
    if (this.closed) {
      return { records: 0, bytes: 0, retained: 0, releaseAcknowledged: 0, ...base };
    }
    const records = this.records();
    const usage = this.recordStore.usage([AUTHORITY_FAMILY]);
    return {
      records: records.length,
      bytes: usage.bytes,
      retained: records.filter((record) => record.state === "retained").length,
      releaseAcknowledged: records.filter((record) => record.state === "release_acknowledged").length,
      ...base,
    };
  }

  private requireRetained(
    sessionId: string,
    runtimeId: string,
    generation: string
  ): OwnedRuntimeAuthorityRecord {
    const existing = this.read(runtimeId);
    if (!existing || existing.authority.sessionId !== sessionId ||
        existing.authority.generation !== generation || existing.state !== "retained" ||
        !("preparedLaunchId" in existing.authority)) {
      throw new ObserverError(
        "SESSION_MISMATCH",
        "Owned runtime lifecycle reservation lacks exact retained authority",
        409
      );
    }
    return existing as OwnedRuntimeAuthorityRecord & { authority: OwnedRuntimeRecoveryAuthority };
  }

  private assertExact(
    record: OwnedRuntimeAuthorityRecord,
    authority: OwnedRuntimeRecoveryAuthority
  ): void {
    if (!("preparedLaunchId" in record.authority) || !sameAuthority(record.authority, authority)) {
      throw new ObserverError(
        "SESSION_MISMATCH",
        "Owned runtime recovery authority conflicts with another exact generation",
        409
      );
    }
  }

  private readRecord(runtimeId: string): OwnedRuntimeAuthorityRecord | null {
    const raw = this.recordStore.getRaw(AUTHORITY_FAMILY, runtimeId);
    if (raw === null) return null;
    if (raw.byteLength < AUTHORITY_RECORD_MIN_BYTES || raw.byteLength > this.maxRecordBytes) {
      throw new Error(`authority record byte length ${raw.byteLength} is outside its bounds`);
    }
    const decoded = JSON.parse(Buffer.from(raw).toString("utf8").replace(/^\uFEFF/, ""));
    return authorityRecordSchema.parse(decoded);
  }

  private write(record: OwnedRuntimeAuthorityRecord, exclusive: boolean): void {
    const runtimeId = record.authority.runtimeId;
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    if (bytes.byteLength > this.maxRecordBytes) {
      throw new ObserverError("TRANSPORT_UNAVAILABLE", "Owned runtime recovery authority exceeds its record budget", 503);
    }
    // Aggregate record/byte admission, byte-for-byte parity with the prior
    // BoundedJsonStore bounds (stored bytes equal the old serialized file size).
    const existing = this.recordStore.getRaw(AUTHORITY_FAMILY, runtimeId);
    const usage = this.recordStore.usage([AUTHORITY_FAMILY]);
    const nextRecords = usage.records + (existing === null ? 1 : 0);
    const nextBytes = usage.bytes - (existing?.byteLength ?? 0) + bytes.byteLength;
    if (nextRecords > this.maxRecords || nextBytes > this.maxBytes) {
      throw new ObserverError("TRANSPORT_UNAVAILABLE", "Owned runtime recovery authority store is full", 503);
    }
    try {
      this.recordStore.putRaw(AUTHORITY_FAMILY, runtimeId, bytes, { exclusive });
    } catch (error) {
      if (error instanceof LmdbRecordStoreError && error.code === "RECORD_EXISTS") {
        throw new ObserverError("SESSION_MISMATCH", "Owned runtime recovery authority already exists", 409);
      }
      if (error instanceof LmdbRecordStoreError && error.code === "RECORD_TOO_LARGE") {
        throw new ObserverError("TRANSPORT_UNAVAILABLE", "Owned runtime recovery authority exceeds its record budget", 503);
      }
      throw error;
    }
  }

  private records(): OwnedRuntimeAuthorityRecord[] {
    if (this.closed) return [];
    const records: OwnedRuntimeAuthorityRecord[] = [];
    for (const runtimeId of this.recordStore.listIds(AUTHORITY_FAMILY)) {
      if (!runtimeIdSchema.safeParse(runtimeId).success) continue;
      try {
        const record = this.read(runtimeId);
        if (record) records.push(record);
      } catch {
        // Isolate one corrupt lifecycle. Its record still consumes the
        // aggregate capacity budget, but it cannot block unrelated exact
        // recovery, release, diagnostics, or tombstone sweeping.
      }
    }
    return records;
  }

}
