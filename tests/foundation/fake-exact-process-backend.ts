import type {
  ExactOwnedProcessIdentity,
  ExactProcessBackend,
  ExactProcessInspection,
  ExactProcessTerminationResult,
} from "../../src/foundation/exact-process-backend.js";
import type { ExactProcessIdentity } from "../../src/foundation/identity.js";
import type { MachineMutex, MachineMutexRequest } from "../../src/foundation/machine-mutex.js";

export interface FakeExactProcessRecord {
  identity: ExactProcessIdentity;
  ownerArgument: string;
}

type FakeExactProcessEntry = ExactProcessIdentity | FakeExactProcessRecord;

/** Shared behavioral fake for exact inspection, termination, and mutex serialization. */
export class FakeExactProcessBackend<
  Entry extends FakeExactProcessEntry = ExactProcessIdentity,
> implements ExactProcessBackend, MachineMutex {
  readonly platform = "test" as const;
  readonly processes = new Map<number, Entry>();
  readonly ownerArguments = new Map<number, string>();
  readonly terminationCalls: ExactOwnedProcessIdentity[] = [];
  inspectFailure: Error | null = null;
  terminationResult: ExactProcessTerminationResult | null = null;
  beforeTerminate: (() => void) | null = null;
  mutexFailures = 0;
  maxConcurrent = 0;
  private concurrent = 0;
  private exactProcessMutexTail: Promise<void> = Promise.resolve();

  constructor(
    readonly current: ExactProcessIdentity & { userSid: string } = {
      pid: 1001,
      executablePath: "C:\\Program Files\\nodejs\\node.exe",
      creationTime: "133900000000000001",
      userSid: "S-1-5-21-test-user",
    }
  ) {}

  async withMachineMutex<T>(request: MachineMutexRequest<T>): Promise<T> {
    if (this.mutexFailures > 0) {
      this.mutexFailures -= 1;
      throw new Error("fixture mutex failure");
    }
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.exactProcessMutexTail;
    this.exactProcessMutexTail = previous.then(() => turn);
    await previous;
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      return await request.action();
    } finally {
      this.concurrent -= 1;
      release();
    }
  }

  async inspectCurrentProcess(_pid: number): Promise<ExactProcessIdentity & { userSid: string }> {
    return this.current;
  }

  async inspectProcess(
    pid: number,
    expectedOwnerTokenArgument?: string
  ): Promise<ExactProcessInspection | null> {
    if (this.inspectFailure) throw this.inspectFailure;
    const entry = this.processes.get(pid);
    if (!entry) return null;
    return {
      identity: this.identityOf(entry),
      ownerArgumentMatched: expectedOwnerTokenArgument === undefined
        ? null
        : this.ownerArgumentOf(pid, entry) === expectedOwnerTokenArgument,
    };
  }

  async verifyAndTerminate(
    expected: ExactOwnedProcessIdentity
  ): Promise<ExactProcessTerminationResult> {
    this.beforeTerminate?.();
    this.terminationCalls.push({ ...expected });
    if (this.terminationResult) return this.terminationResult;
    const entry = this.processes.get(expected.pid);
    if (!entry) return { kind: "already_exited" };
    const actual = this.identityOf(entry);
    if (actual.creationTime !== expected.creationTime) {
      return { kind: "refused", reason: "creation_time_mismatch", message: "PID was reused." };
    }
    if (actual.executablePath.toLowerCase() !== expected.executablePath.toLowerCase()) {
      return {
        kind: "refused",
        reason: "executable_mismatch",
        message: "Executable path no longer matches.",
      };
    }
    if (this.ownerArgumentOf(expected.pid, entry) !== expected.ownerTokenArgument) {
      return { kind: "refused", reason: "token_mismatch", message: "Owner argument is absent." };
    }
    this.processes.delete(expected.pid);
    this.ownerArguments.delete(expected.pid);
    return { kind: "terminated" };
  }

  protected identityOf(entry: Entry): ExactProcessIdentity {
    return "identity" in entry ? entry.identity : entry;
  }

  protected ownerArgumentOf(pid: number, entry: Entry): string | undefined {
    return "ownerArgument" in entry ? entry.ownerArgument : this.ownerArguments.get(pid);
  }
}

/** Domain tests decorate this one concrete fake through small adapter factories. */
export function createFakeExactProcessBackend<
  Entry extends FakeExactProcessEntry = ExactProcessIdentity,
>(
  current?: ExactProcessIdentity & { userSid: string }
): FakeExactProcessBackend<Entry> {
  return current === undefined
    ? new FakeExactProcessBackend<Entry>()
    : new FakeExactProcessBackend<Entry>(current);
}
