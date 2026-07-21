import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  caseForId,
  type FaultMatrix,
  type FaultMatrixAction,
  type FaultMatrixBackend,
  type FaultMatrixCase,
  type FaultMatrixPhase,
} from "../observer/protocol/fault-matrix.js";
import {
  deadlineAfter,
  deriveDeadline,
  pollUntil,
  type Clock,
  type Deadline,
  type Sleeper,
} from "../src/foundation/time.js";

export const FAULT_CONTROL_SCHEMA_VERSION = 1 as const;
export const FAULT_CONTROL_MAX_DOCUMENT_BYTES = 32 * 1024;
export const FAULT_CONTROL_POLL_INTERVAL_MS = 25;
export const FAULT_CONTROL_MAX_BARRIER_MS = 15_000;
export const FAULT_CONTROL_ACKNOWLEDGEMENT_RETRY_MS = 1_000;

export const FAULT_CONTROL_REFUSAL_CODES = [
  "MALFORMED",
  "CAPABILITY_MISMATCH",
  "RUN_MISMATCH",
  "FIXTURE_MISMATCH",
  "LIFECYCLE_MISMATCH",
  "MATRIX_MISMATCH",
  "PHASE_MISMATCH",
  "REPLAY_REFUSED",
  "CASE_TERMINAL",
  "DEADLINE_EXPIRED",
] as const;
export type FaultControlRefusalCode = typeof FAULT_CONTROL_REFUSAL_CODES[number];

export interface FaultControlBinding {
  readonly fixtureId: string;
  readonly lifecycleId: string;
  readonly lifecycleGeneration: string;
}

export interface FaultControlBootstrap {
  readonly schemaVersion: typeof FAULT_CONTROL_SCHEMA_VERSION;
  readonly runId: string;
  readonly backend: FaultMatrixBackend;
  readonly capability: string;
  readonly fixtureContentIdentity: string;
  readonly generatedProjectIdentity: string;
  readonly generatedAddonIdentity: string;
  readonly binding: FaultControlBinding;
}

export interface FaultControlActionCommand {
  readonly schemaVersion: typeof FAULT_CONTROL_SCHEMA_VERSION;
  readonly kind: "arm" | "release" | "cancel";
  readonly runId: string;
  readonly requestId: string;
  readonly caseId: string;
  readonly phase: FaultMatrixPhase;
  readonly action: FaultMatrixAction;
  readonly binding: FaultControlBinding;
}

export interface FaultControlTerminalCommand {
  readonly schemaVersion: typeof FAULT_CONTROL_SCHEMA_VERSION;
  readonly kind: "terminal";
  readonly runId: string;
  readonly requestId: string;
  readonly caseId: string;
  readonly phase: FaultMatrixPhase;
  readonly binding: FaultControlBinding;
}

export type FaultControlCommand = FaultControlActionCommand | FaultControlTerminalCommand;

export interface FaultControlAcknowledgement {
  readonly schemaVersion: typeof FAULT_CONTROL_SCHEMA_VERSION;
  readonly kind: "arrived" | "executed" | "refused" | "terminalled";
  readonly requestId: string;
  readonly caseId: string;
  readonly phase: FaultMatrixPhase;
  readonly disposition: "arrived" | "executed" | "refused" | "terminalled";
  readonly reason: FaultControlRefusalCode | null;
}

export interface FaultControlValidation {
  readonly accepted: boolean;
  readonly command?: FaultControlCommand;
  readonly reason?: FaultControlRefusalCode;
  readonly replay?: FaultControlAcknowledgement;
}

export interface FaultControlMailbox {
  writeInbox(filename: string, body: string): Promise<void>;
  takeOutbox(): Promise<FaultControlAcknowledgement | undefined>;
}

export interface OwnedFaultControlRoot {
  readonly root: string;
  readonly bootstrapPath: string;
  readonly inboxPath: string;
  readonly outboxPath: string;
}

export class FaultControlError extends Error {
  constructor(readonly code: FaultControlRefusalCode) {
    super(code);
    this.name = "FaultControlError";
  }
}

type FaultControlProtocolState =
  | "awaiting_arm"
  | "arm_pending"
  | "armed"
  | "action_pending"
  | "action_executed"
  | "terminal_pending"
  | "terminal";

interface PendingFaultControlCommand {
  readonly fingerprint: string;
  readonly command: FaultControlCommand;
  readonly priorState: FaultControlProtocolState;
}

interface RecordedFaultControlAcknowledgement {
  readonly fingerprint: string;
  readonly commandKind: FaultControlCommand["kind"];
  readonly acknowledgement: FaultControlAcknowledgement;
}

const REFUSAL_SET = new Set<string>(FAULT_CONTROL_REFUSAL_CODES);
const PHASE_SET = new Set<string>([
  "before_lease", "lease_acquired", "capture_in_progress", "restoration_in_progress", "terminal_release",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_FILENAME = /^(\d{12})-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!plainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160 &&
    !/[\0\r\n]/.test(value);
}

function sameBinding(left: FaultControlBinding, right: FaultControlBinding): boolean {
  return left.fixtureId === right.fixtureId && left.lifecycleId === right.lifecycleId &&
    left.lifecycleGeneration === right.lifecycleGeneration;
}

function validBinding(value: unknown): value is FaultControlBinding {
  return exactKeys(value, ["fixtureId", "lifecycleId", "lifecycleGeneration"]) &&
    boundedId(value.fixtureId) && boundedId(value.lifecycleId) && boundedId(value.lifecycleGeneration);
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * Create the disposable private mailbox below an already-owned run root. The
 * caller is responsible for deletion through its ordinary host cleanup path.
 */
export function createOwnedFaultControlRoot(options: {
  readonly runRoot: string;
  readonly controlRoot: string;
  readonly bootstrap: FaultControlBootstrap;
}): OwnedFaultControlRoot {
  const runRoot = resolve(options.runRoot);
  const controlRoot = resolve(options.controlRoot);
  const relation = relative(runRoot, controlRoot);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new FaultControlError("MALFORMED");
  }
  const runEntry = lstatSync(runRoot);
  if (!runEntry.isDirectory() || runEntry.isSymbolicLink() || existsSync(controlRoot)) {
    throw new FaultControlError("MALFORMED");
  }
  const parent = dirname(controlRoot);
  const parentEntry = lstatSync(parent);
  if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) throw new FaultControlError("MALFORMED");
  if (!exactKeys(options.bootstrap, [
    "schemaVersion", "runId", "backend", "capability", "fixtureContentIdentity", "generatedProjectIdentity",
    "generatedAddonIdentity", "binding",
  ]) || options.bootstrap.schemaVersion !== FAULT_CONTROL_SCHEMA_VERSION || !boundedId(options.bootstrap.runId) ||
      (options.bootstrap.backend !== "runtime" && options.bootstrap.backend !== "workbench") ||
      !UUID.test(options.bootstrap.capability) ||
      !boundedId(options.bootstrap.fixtureContentIdentity) ||
      !boundedId(options.bootstrap.generatedProjectIdentity) ||
      !boundedId(options.bootstrap.generatedAddonIdentity) ||
      !validBinding(options.bootstrap.binding)) {
    throw new FaultControlError("MALFORMED");
  }
  mkdirSync(controlRoot, { mode: 0o700 });
  const inboxPath = `${controlRoot}/inbox`;
  const outboxPath = `${controlRoot}/outbox`;
  mkdirSync(inboxPath, { mode: 0o700 });
  mkdirSync(outboxPath, { mode: 0o700 });
  const bootstrapPath = `${controlRoot}/bootstrap.json`;
  writeFileSync(bootstrapPath, `${JSON.stringify(options.bootstrap)}\n`, {
    encoding: "utf8", flag: "wx", mode: 0o600,
  });
  return Object.freeze({ root: controlRoot, bootstrapPath, inboxPath, outboxPath });
}

export function removeOwnedFaultControlRoot(root: OwnedFaultControlRoot): void {
  const entry = lstatSync(root.root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new FaultControlError("MALFORMED");
  rmSync(root.root, { recursive: true, force: true });
}

function commandFingerprint(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** Parse the strict new-file mailbox name without touching a document body. */
export function parseFaultControlFilename(filename: string): { sequence: number; capability: string } | undefined {
  if (typeof filename !== "string" || filename.length > 128) return undefined;
  const match = CONTROL_FILENAME.exec(filename);
  if (!match) return undefined;
  const sequence = Number(match[1]);
  if (!Number.isSafeInteger(sequence)) return undefined;
  return { sequence, capability: match[2].toLowerCase() };
}

export function faultControlFilename(sequence: number, capability: string): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 999_999_999_999 || !UUID.test(capability)) {
    throw new Error("Invalid fault-control filename components");
  }
  return `${String(sequence).padStart(12, "0")}-${capability.toLowerCase()}.json`;
}

/** Resolve --only through the catalog; runner-local schedules are never accepted. */
export function resolveFaultMatrixCases(matrix: FaultMatrix, only?: string): readonly FaultMatrixCase[] {
  if (only === undefined) return Object.freeze([]);
  return Object.freeze([caseForId(matrix, only)]);
}

function parseCommand(body: string): FaultControlCommand | undefined {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > FAULT_CONTROL_MAX_DOCUMENT_BYTES) return undefined;
  let value: unknown;
  try { value = JSON.parse(body); } catch { return undefined; }
  if (!plainRecord(value) || value.schemaVersion !== FAULT_CONTROL_SCHEMA_VERSION || !boundedId(value.runId) ||
      !validRequestId(value.requestId) || !boundedId(value.caseId) || typeof value.phase !== "string" ||
      !PHASE_SET.has(value.phase) || !validBinding(value.binding)) return undefined;
  if (value.kind === "terminal") {
    if (!exactKeys(value, ["schemaVersion", "kind", "runId", "requestId", "caseId", "phase", "binding"])) return undefined;
    return value as unknown as FaultControlTerminalCommand;
  }
  if ((value.kind !== "arm" && value.kind !== "release" && value.kind !== "cancel") ||
      !exactKeys(value, ["schemaVersion", "kind", "runId", "requestId", "caseId", "phase", "action", "binding"]) ||
      typeof value.action !== "string") return undefined;
  return value as unknown as FaultControlActionCommand;
}

export function validateFaultControlAcknowledgement(value: unknown): value is FaultControlAcknowledgement {
  if (!exactKeys(value, ["schemaVersion", "kind", "requestId", "caseId", "phase", "disposition", "reason"]) ||
      value.schemaVersion !== FAULT_CONTROL_SCHEMA_VERSION || !validRequestId(value.requestId) ||
      !boundedId(value.caseId) || typeof value.phase !== "string" || !PHASE_SET.has(value.phase) ||
      (value.kind !== "arrived" && value.kind !== "executed" && value.kind !== "refused" && value.kind !== "terminalled") ||
      value.disposition !== value.kind ||
      (value.kind === "refused" ? (typeof value.reason !== "string" || !REFUSAL_SET.has(value.reason)) : value.reason !== null)) {
    return false;
  }
  return true;
}

/**
 * Shared fixture-side security predicate. It has no filesystem or Enforce dependency:
 * a generated bridge supplies the filename/body and performs the native action only
 * after this class has accepted the envelope.
 */
export class FaultControlAuthorizer {
  private terminal = false;
  private previousSequence = -1;
  private protocolState: FaultControlProtocolState = "awaiting_arm";
  private readonly pending = new Map<string, PendingFaultControlCommand>();
  private readonly acknowledgements = new Map<string, RecordedFaultControlAcknowledgement>();

  constructor(private readonly options: {
    readonly matrix: FaultMatrix;
    readonly bootstrap: FaultControlBootstrap;
    readonly readLifecycleBinding: () => FaultControlBinding | undefined;
  }) {
    this.validateBootstrap(options.bootstrap);
  }

  validateBootstrap(value: unknown): asserts value is FaultControlBootstrap {
    if (!exactKeys(value, [
      "schemaVersion", "runId", "backend", "capability", "fixtureContentIdentity", "generatedProjectIdentity",
      "generatedAddonIdentity", "binding",
    ]) || value.schemaVersion !== FAULT_CONTROL_SCHEMA_VERSION || !boundedId(value.runId) ||
        (value.backend !== "runtime" && value.backend !== "workbench") || typeof value.capability !== "string" || !UUID.test(value.capability) ||
        !boundedId(value.fixtureContentIdentity) || !boundedId(value.generatedProjectIdentity) ||
        !boundedId(value.generatedAddonIdentity) || !validBinding(value.binding)) {
      throw new FaultControlError("MALFORMED");
    }
  }

  invalidate(): void {
    this.terminal = true;
    this.protocolState = "terminal";
    this.pending.clear();
  }

  private admit(command: FaultControlCommand, fingerprint: string): FaultControlValidation {
    const priorState = this.protocolState;
    if (command.kind === "arm") {
      if (priorState !== "awaiting_arm") return { accepted: false, reason: "REPLAY_REFUSED" };
      this.protocolState = "arm_pending";
    } else if (command.kind === "release" || command.kind === "cancel") {
      // An action may cross the barrier only after the fixture has recorded
      // its own observable arrival acknowledgement for the arm request.
      if (priorState !== "armed") return { accepted: false, reason: "REPLAY_REFUSED" };
      this.protocolState = "action_pending";
    } else {
      // The host can seal a case after a successful arrival, a successful
      // action, or an action-side refusal. It cannot manufacture terminal
      // authority before the fixture has accepted a barrier.
      if (priorState !== "arm_pending" && priorState !== "armed" && priorState !== "action_pending" && priorState !== "action_executed") {
        return { accepted: false, reason: "REPLAY_REFUSED" };
      }
      this.protocolState = "terminal_pending";
    }
    this.pending.set(command.requestId, { fingerprint, command, priorState });
    return { accepted: true, command };
  }

  authorize(filename: string, body: string): FaultControlValidation {
    // Capability validation is deliberately the first body-independent operation.
    const named = parseFaultControlFilename(filename);
    if (!named || named.capability !== this.options.bootstrap.capability.toLowerCase()) {
      return { accepted: false, reason: "CAPABILITY_MISMATCH" };
    }
    // A sequence names one mailbox document, not one logical request. Check
    // it before the replay ledger so an attacker cannot reuse a consumed file
    // number to obtain a cached acknowledgement.
    if (named.sequence <= this.previousSequence) return { accepted: false, reason: "REPLAY_REFUSED" };
    this.previousSequence = named.sequence;
    const command = parseCommand(body);
    if (!command) return { accepted: false, reason: "MALFORMED" };
    if (command.runId !== this.options.bootstrap.runId) return { accepted: false, reason: "RUN_MISMATCH" };
    if (command.binding.fixtureId !== this.options.bootstrap.binding.fixtureId) {
      return { accepted: false, reason: "FIXTURE_MISMATCH" };
    }
    const currentBinding = this.options.readLifecycleBinding();
    if (!currentBinding || !sameBinding(command.binding, this.options.bootstrap.binding) || !sameBinding(command.binding, currentBinding)) {
      return { accepted: false, reason: "LIFECYCLE_MISMATCH" };
    }
    const fingerprint = commandFingerprint(body);
    const known = this.acknowledgements.get(command.requestId);
    if (known) {
      if (known.fingerprint !== fingerprint) return { accepted: false, reason: "REPLAY_REFUSED" };
      // A terminal acknowledgement alone remains replayable after terminal
      // invalidation so a host that lost it can finish cleanup. Earlier arm
      // and action acknowledgements never reopen a sealed case.
      if (this.terminal && known.commandKind !== "terminal") return { accepted: false, reason: "CASE_TERMINAL" };
      return { accepted: true, command, replay: known.acknowledgement };
    }
    if (this.terminal) return { accepted: false, reason: "CASE_TERMINAL" };
    if (this.pending.has(command.requestId)) return { accepted: false, reason: "REPLAY_REFUSED" };
    let matrixCase: FaultMatrixCase;
    try { matrixCase = caseForId(this.options.matrix, command.caseId); } catch { return { accepted: false, reason: "MATRIX_MISMATCH" }; }
    if (matrixCase.backend !== this.options.bootstrap.backend) return { accepted: false, reason: "MATRIX_MISMATCH" };
    if (matrixCase.injection.phase !== command.phase) return { accepted: false, reason: "PHASE_MISMATCH" };
    if (command.kind !== "terminal" && matrixCase.injection.action !== command.action) {
      return { accepted: false, reason: "MATRIX_MISMATCH" };
    }
    return this.admit(command, fingerprint);
  }

  /** Persist the deterministic acknowledgement before a mailbox bridge writes it. */
  remember(command: FaultControlCommand, rawBody: string, acknowledgement: FaultControlAcknowledgement): FaultControlAcknowledgement {
    if (!validateFaultControlAcknowledgement(acknowledgement) || acknowledgement.requestId !== command.requestId ||
        acknowledgement.caseId !== command.caseId || acknowledgement.phase !== command.phase) {
      throw new FaultControlError("MALFORMED");
    }
    const fingerprint = commandFingerprint(rawBody);
    const pending = this.pending.get(command.requestId);
    if (!pending || pending.fingerprint !== fingerprint) throw new FaultControlError("REPLAY_REFUSED");
    const expected = command.kind === "arm" ? "arrived" : command.kind === "terminal" ? "terminalled" : "executed";
    if (acknowledgement.kind !== "refused" && acknowledgement.kind !== expected) throw new FaultControlError("MALFORMED");
    this.pending.delete(command.requestId);
    if (acknowledgement.kind === "refused") {
      this.protocolState = pending.priorState;
    } else if (command.kind === "arm") {
      this.protocolState = "armed";
    } else if (command.kind === "terminal") {
      this.terminal = true;
      this.protocolState = "terminal";
    } else {
      this.protocolState = "action_executed";
    }
    this.acknowledgements.set(command.requestId, { fingerprint, commandKind: command.kind, acknowledgement });
    return acknowledgement;
  }
}

export class InMemoryFaultControlMailbox implements FaultControlMailbox {
  readonly inbox: Array<{ readonly filename: string; readonly body: string }> = [];
  private readonly outbox: FaultControlAcknowledgement[] = [];

  async writeInbox(filename: string, body: string): Promise<void> {
    this.inbox.push(Object.freeze({ filename, body }));
  }

  async takeOutbox(): Promise<FaultControlAcknowledgement | undefined> {
    return this.outbox.shift();
  }

  acknowledge(value: FaultControlAcknowledgement): void {
    if (!validateFaultControlAcknowledgement(value)) throw new FaultControlError("MALFORMED");
    this.outbox.push(Object.freeze({ ...value }));
  }
}

/** New-file-per-message mailbox used by the gated live runners. */
export class FilesystemFaultControlMailbox implements FaultControlMailbox {
  private previousOutboxSequence = -1;
  private readonly capability: string;

  constructor(
    private readonly inboxPath: string,
    private readonly outboxPath: string,
    capability: string,
  ) {
    if (!UUID.test(capability)) throw new FaultControlError("MALFORMED");
    this.capability = capability.toLowerCase();
  }

  async writeInbox(filename: string, body: string): Promise<void> {
    const parsedName = parseFaultControlFilename(filename);
    if (!parsedName || Buffer.byteLength(body, "utf8") > FAULT_CONTROL_MAX_DOCUMENT_BYTES) {
      throw new FaultControlError("MALFORMED");
    }
    if (parsedName.capability !== this.capability) throw new FaultControlError("CAPABILITY_MISMATCH");
    writeFileSync(join(this.inboxPath, filename), body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }

  async takeOutbox(): Promise<FaultControlAcknowledgement | undefined> {
    const names = readdirSync(this.outboxPath).filter((name) => name.endsWith(".json")).sort();
    for (const name of names) {
      const parsedName = parseFaultControlFilename(name);
      if (!parsedName) {
        throw new FaultControlError("MALFORMED");
      }
      // Reject another run's capability before opening or parsing its body.
      if (parsedName.capability !== this.capability) {
        throw new FaultControlError("CAPABILITY_MISMATCH");
      }
      if (parsedName.sequence <= this.previousOutboxSequence) {
        throw new FaultControlError("REPLAY_REFUSED");
      }
      const filePath = join(this.outboxPath, name);
      const entry = lstatSync(filePath);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new FaultControlError("MALFORMED");
      // Stat the regular file first so an oversized document is refused
      // without loading its contents into memory.
      if (entry.size > FAULT_CONTROL_MAX_DOCUMENT_BYTES) {
        throw new FaultControlError("MALFORMED");
      }
      const body = readFileSync(filePath, "utf8");
      if (Buffer.byteLength(body, "utf8") > FAULT_CONTROL_MAX_DOCUMENT_BYTES) {
        throw new FaultControlError("MALFORMED");
      }
      unlinkSync(filePath);
      let value: unknown;
      try { value = JSON.parse(body); } catch { throw new FaultControlError("MALFORMED"); }
      if (!validateFaultControlAcknowledgement(value)) throw new FaultControlError("MALFORMED");
      this.previousOutboxSequence = parsedName.sequence;
      return value;
    }
    return undefined;
  }
}

export interface FaultMatrixRunScaffolding {
  readonly controlRoot: OwnedFaultControlRoot;
  readonly authorizer: FaultControlAuthorizer;
  readonly scheduler: FaultMatrixScheduler;
}

export interface FaultMatrixSchedulerOptions {
  readonly matrix: FaultMatrix;
  readonly mailbox: FaultControlMailbox;
  readonly runId: string;
  readonly capability: string;
  readonly binding: FaultControlBinding;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly deadline?: Deadline;
  readonly caseDeadlineMs?: number;
  readonly barrierAllowanceMs?: number;
  readonly onCleanup?: () => Promise<void> | void;
}

export interface ScheduledFaultCase {
  readonly case: FaultMatrixCase;
  readonly requestId: string;
  readonly arrived: FaultControlAcknowledgement;
}

/** Host-side barrier owner. It never invents a schedule and uses only absolute deadlines. */
export class FaultMatrixScheduler {
  private readonly deadline: Deadline;
  private readonly barrierAllowanceMs: number;
  private readonly controller = new AbortController();
  private sequence = 0;
  private terminal = false;
  private finishing = false;
  private armStarted = false;
  private actionStarted = false;
  private scheduled: ScheduledFaultCase | undefined;
  private activeCase: FaultMatrixCase | undefined;

  constructor(private readonly options: FaultMatrixSchedulerOptions) {
    if (!UUID.test(options.capability) || !boundedId(options.runId) || !validBinding(options.binding)) {
      throw new FaultControlError("MALFORMED");
    }
    const budget = options.caseDeadlineMs ?? FAULT_CONTROL_MAX_BARRIER_MS;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 900_000) throw new FaultControlError("MALFORMED");
    this.deadline = options.deadline ?? deadlineAfter(options.clock, budget);
    this.barrierAllowanceMs = options.barrierAllowanceMs ?? FAULT_CONTROL_MAX_BARRIER_MS;
    if (!Number.isSafeInteger(this.barrierAllowanceMs) || this.barrierAllowanceMs < 1 ||
        this.barrierAllowanceMs > FAULT_CONTROL_MAX_BARRIER_MS) throw new FaultControlError("MALFORMED");
  }

  get signal(): AbortSignal { return this.controller.signal; }

  private assertOpen(): void {
    if (this.terminal || this.finishing) throw new FaultControlError("CASE_TERMINAL");
  }

  private async write(command: FaultControlCommand, allowFinishing = false): Promise<void> {
    if (!allowFinishing) this.assertOpen();
    const body = JSON.stringify(command);
    await this.options.mailbox.writeInbox(faultControlFilename(this.sequence++, this.options.capability), body);
  }

  private command(caseValue: FaultMatrixCase, kind: FaultControlActionCommand["kind"], requestId = randomUUID()): FaultControlActionCommand {
    return Object.freeze({
      schemaVersion: FAULT_CONTROL_SCHEMA_VERSION,
      kind,
      runId: this.options.runId,
      requestId,
      caseId: caseValue.id,
      phase: caseValue.injection.phase,
      action: caseValue.injection.action,
      binding: this.options.binding,
    });
  }

  private async awaitAcknowledgement(
    requestId: string,
    caseValue: FaultMatrixCase,
    expected: FaultControlAcknowledgement["kind"],
    deadline: Deadline,
    ignoreCaseAbort = false,
  ): Promise<FaultControlAcknowledgement> {
    const result = await pollUntil({
      clock: this.options.clock,
      sleeper: this.options.sleeper,
      deadline,
      intervalMs: FAULT_CONTROL_POLL_INTERVAL_MS,
      // A terminal acknowledgement is the bounded closeout handshake after a
      // prior barrier failure has already aborted ordinary case work.
      signal: ignoreCaseAbort ? undefined : this.signal,
      probe: async () => {
        const acknowledgement = await this.options.mailbox.takeOutbox();
        if (!acknowledgement) return undefined;
        if (!validateFaultControlAcknowledgement(acknowledgement)) throw new FaultControlError("MALFORMED");
        if (acknowledgement.requestId !== requestId || acknowledgement.caseId !== caseValue.id ||
            acknowledgement.phase !== caseValue.injection.phase) return undefined;
        if (acknowledgement.kind === "refused") throw new FaultControlError(acknowledgement.reason!);
        if (acknowledgement.kind !== expected) throw new FaultControlError("MALFORMED");
        return acknowledgement;
      },
    });
    if (result.kind === "expired") {
      throw new FaultControlError("DEADLINE_EXPIRED");
    }
    return result.value;
  }

  /**
   * A lost acknowledgement is retried once with exactly the same JSON command
   * and request ID. The filename gets a new sequence because the mailbox is
   * new-file-per-message; the fixture's replay ledger returns its recorded
   * acknowledgement without repeating the action.
   */
  private async awaitWithOneAcknowledgementRetry(
    command: FaultControlCommand,
    caseValue: FaultMatrixCase,
    expected: FaultControlAcknowledgement["kind"],
    allowFinishing = false,
  ): Promise<FaultControlAcknowledgement> {
    const fullDeadline = deriveDeadline(this.options.clock, this.deadline, this.barrierAllowanceMs);
    const firstDeadline = deriveDeadline(
      this.options.clock,
      fullDeadline,
      Math.min(FAULT_CONTROL_ACKNOWLEDGEMENT_RETRY_MS, this.barrierAllowanceMs),
    );
    try {
      return await this.awaitAcknowledgement(command.requestId, caseValue, expected, firstDeadline, allowFinishing);
    } catch (error) {
      if (!(error instanceof FaultControlError) || error.code !== "DEADLINE_EXPIRED" ||
          firstDeadline.atMs >= fullDeadline.atMs) throw error;
      await this.write(command, allowFinishing);
      return this.awaitAcknowledgement(command.requestId, caseValue, expected, fullDeadline, allowFinishing);
    }
  }

  /** Arm a declared case and block only until the fixture proves phase arrival. */
  async arm(caseId: string): Promise<ScheduledFaultCase> {
    this.assertOpen();
    if (this.scheduled || this.armStarted) throw new FaultControlError("REPLAY_REFUSED");
    const caseValue = caseForId(this.options.matrix, caseId);
    this.armStarted = true;
    this.activeCase = caseValue;
    const requestId = randomUUID();
    const command = this.command(caseValue, "arm", requestId);
    await this.write(command);
    try {
      const arrived = await this.awaitWithOneAcknowledgementRetry(command, caseValue, "arrived");
      this.scheduled = Object.freeze({ case: caseValue, requestId, arrived });
      return this.scheduled;
    } catch (error) {
      this.controller.abort(error);
      throw error;
    }
  }

  /** Release or cancel exactly the armed fault boundary; a second action is refused. */
  async releaseBarrier(kind: "release" | "cancel" = "release"): Promise<FaultControlAcknowledgement> {
    this.assertOpen();
    if (!this.scheduled) throw new FaultControlError("MATRIX_MISMATCH");
    if (this.actionStarted) throw new FaultControlError("REPLAY_REFUSED");
    this.actionStarted = true;
    const command = this.command(this.scheduled.case, kind);
    await this.write(command);
    try {
      return await this.awaitWithOneAcknowledgementRetry(command, this.scheduled.case, "executed");
    } catch (error) {
      this.controller.abort(error);
      throw error;
    }
  }

  /** Convenience form used by live runners after they have selected a declared ID. */
  async schedule(caseId: string, kind: "release" | "cancel" = "release"): Promise<FaultControlAcknowledgement> {
    await this.arm(caseId);
    return this.releaseBarrier(kind);
  }

  /** Terminally revoke this in-memory capability before invoking owned cleanup. */
  async finishCase(): Promise<void> {
    if (this.terminal || this.finishing) return;
    const selected = this.scheduled?.case ?? this.activeCase;
    this.finishing = true;
    // Invalidate and abort all ordinary barrier consumers before starting the
    // terminal closeout handshake. The terminal acknowledgement wait opts out
    // of this case signal and therefore cannot compete with a still-live
    // arrival/action poller for the mailbox.
    this.controller.abort(new FaultControlError("CASE_TERMINAL"));
    let failure: unknown;
    try {
      if (selected) {
        const command: FaultControlTerminalCommand = Object.freeze({
          schemaVersion: FAULT_CONTROL_SCHEMA_VERSION,
          kind: "terminal",
          runId: this.options.runId,
          requestId: randomUUID(),
          caseId: selected.id,
          phase: selected.injection.phase,
          binding: this.options.binding,
        });
        await this.write(command, true);
        await this.awaitWithOneAcknowledgementRetry(command, selected, "terminalled", true);
      }
    } catch (error) {
      failure = error;
    } finally {
      this.terminal = true;
      this.finishing = false;
      try {
        await this.options.onCleanup?.();
      } catch (cleanupError) {
        failure ??= cleanupError;
      }
    }
    if (failure) throw failure;
  }
}

/** Construct the complete Phase 1 runner seam without enabling a live case. */
export function createFaultMatrixRunScaffolding(options: {
  readonly runRoot: string;
  readonly controlRoot: string;
  readonly matrix: FaultMatrix;
  readonly bootstrap: FaultControlBootstrap;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly readLifecycleBinding?: () => FaultControlBinding | undefined;
  readonly onCleanup?: () => Promise<void> | void;
}): FaultMatrixRunScaffolding {
  const ownedRoot = createOwnedFaultControlRoot({
    runRoot: options.runRoot,
    controlRoot: options.controlRoot,
    bootstrap: options.bootstrap,
  });
  try {
    const mailbox = new FilesystemFaultControlMailbox(
      ownedRoot.inboxPath,
      ownedRoot.outboxPath,
      options.bootstrap.capability,
    );
    const readLifecycleBinding = options.readLifecycleBinding ?? (() => options.bootstrap.binding);
    const authorizer = new FaultControlAuthorizer({
      matrix: options.matrix,
      bootstrap: options.bootstrap,
      readLifecycleBinding,
    });
    const scheduler = new FaultMatrixScheduler({
      matrix: options.matrix,
      mailbox,
      runId: options.bootstrap.runId,
      capability: options.bootstrap.capability,
      binding: options.bootstrap.binding,
      clock: options.clock,
      sleeper: options.sleeper,
      onCleanup: options.onCleanup,
    });
    return Object.freeze({ controlRoot: ownedRoot, authorizer, scheduler });
  } catch (error) {
    try { removeOwnedFaultControlRoot(ownedRoot); } catch { /* preserve the construction failure */ }
    throw error;
  }
}
