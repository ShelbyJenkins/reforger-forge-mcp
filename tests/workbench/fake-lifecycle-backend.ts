import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type {
  ExactProcessIdentity,
  ProcessInspection,
  LifecycleEndpoint,
  VerifyEndpointOwnerResult,
  VerifyTerminateResult,
  WorkbenchIdentity,
  WorkbenchLifecycleBackend,
  WorkbenchLifecycleStateV2,
  WorkbenchProcessScan,
} from "../../src/workbench/process-guard.js";

export class FakeLifecycleBackend implements WorkbenchLifecycleBackend {
  readonly platform = "test" as const;
  readonly processes = new Map<number, ExactProcessIdentity>();
  readonly ownerArguments = new Map<number, string>();
  readonly workbenchPids = new Set<number>();
  readonly terminationCalls: WorkbenchIdentity[] = [];
  readonly endpointOwnershipCalls: Array<{
    endpoint: LifecycleEndpoint;
    expected: WorkbenchIdentity;
  }> = [];
  unverifiable: WorkbenchProcessScan["unverifiable"] = [];
  terminationResult: VerifyTerminateResult | null = null;
  endpointOwnershipResult: VerifyEndpointOwnerResult | null = null;
  replaceFailure: ((args: {
    path: string;
    expectedGeneration: string | null;
    next: WorkbenchLifecycleStateV2;
  }) => Error | null) | null = null;
  maxConcurrent = 0;
  private concurrent = 0;
  private mutexTail: Promise<void> = Promise.resolve();

  constructor(
    readonly current: ExactProcessIdentity & { userSid: string } = {
      pid: 1001,
      executablePath: "C:\\Program Files\\nodejs\\node.exe",
      creationTime: "133900000000000001",
      userSid: "S-1-5-21-test-user",
    }
  ) {
    this.processes.set(current.pid, current);
  }

  async withMachineMutex<T>(args: {
    name: string;
    timeoutMs: number;
    action: () => Promise<T>;
  }): Promise<T> {
    void args.name;
    void args.timeoutMs;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.mutexTail;
    this.mutexTail = previous.then(() => turn);
    await previous;
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      return await args.action();
    } finally {
      this.concurrent -= 1;
      release();
    }
  }

  async inspectCurrentProcess(): Promise<ExactProcessIdentity & { userSid: string }> {
    return this.current;
  }

  async inspectProcess(
    pid: number,
    expectedOwnerTokenArgument?: string
  ): Promise<ProcessInspection | null> {
    const identity = this.processes.get(pid);
    if (!identity) return null;
    return {
      identity,
      ownerArgumentMatched: expectedOwnerTokenArgument
        ? this.ownerArguments.get(pid) === expectedOwnerTokenArgument
        : null,
    };
  }

  async scanWorkbenchProcesses(): Promise<WorkbenchProcessScan> {
    return {
      processes: [...this.workbenchPids]
        .map((pid) => this.processes.get(pid))
        .filter((entry): entry is ExactProcessIdentity => entry !== undefined),
      unverifiable: [...this.unverifiable],
    };
  }

  async verifyEndpointOwner(
    endpoint: LifecycleEndpoint,
    expected: WorkbenchIdentity
  ): Promise<VerifyEndpointOwnerResult> {
    this.endpointOwnershipCalls.push({ endpoint, expected });
    if (this.endpointOwnershipResult) return this.endpointOwnershipResult;
    const actual = this.processes.get(expected.pid);
    if (!actual || actual.creationTime !== expected.creationTime ||
        actual.executablePath.toLowerCase() !== expected.executablePath.toLowerCase() ||
        this.ownerArguments.get(expected.pid) !== expected.ownerTokenArgument) {
      return {
        kind: "refused",
        reason: "workbench_process_mismatch",
        message: "The expected fake Workbench identity is not live and exact.",
      };
    }
    if (this.workbenchPids.size !== 1 || !this.workbenchPids.has(expected.pid)) {
      return {
        kind: "refused",
        reason: "workbench_process_mismatch",
        message: "The expected fake Workbench is not the sole Workbench process.",
      };
    }
    return { kind: "owned", listenerPid: expected.pid };
  }

  async verifyAndTerminate(expected: WorkbenchIdentity): Promise<VerifyTerminateResult> {
    this.terminationCalls.push(expected);
    if (this.terminationResult) return this.terminationResult;
    const actual = this.processes.get(expected.pid);
    if (!actual) return { kind: "already_exited" };
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
    if (this.ownerArguments.get(expected.pid) !== expected.ownerTokenArgument) {
      return { kind: "refused", reason: "token_mismatch", message: "Owner argument is absent." };
    }
    this.processes.delete(expected.pid);
    this.workbenchPids.delete(expected.pid);
    return { kind: "terminated" };
  }

  async replaceState(args: {
    path: string;
    expectedGeneration: string | null;
    next: WorkbenchLifecycleStateV2;
  }): Promise<void> {
    const failure = this.replaceFailure?.(args);
    if (failure) throw failure;
    if (args.expectedGeneration === null) {
      if (existsSync(args.path)) throw new Error("generation mismatch: expected missing");
    } else {
      if (!existsSync(args.path)) throw new Error("generation mismatch: missing state");
      const current = JSON.parse(readFileSync(args.path, "utf8")) as { generation?: string };
      if (current.generation !== args.expectedGeneration) throw new Error("generation mismatch");
    }
    const temp = `${args.path}.fake.tmp`;
    writeFileSync(temp, `${JSON.stringify(args.next, null, 2)}\n`, "utf8");
    if (existsSync(args.path)) unlinkSync(args.path);
    renameSync(temp, args.path);
  }

  async archiveState(args: {
    path: string;
    archivePath: string;
    expectedSha256: string;
  }): Promise<void> {
    const bytes = readFileSync(args.path);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== args.expectedSha256) throw new Error("hash mismatch");
    renameSync(args.path, args.archivePath);
  }

  addWorkbench(identity: ExactProcessIdentity, ownerArgument?: string): void {
    this.processes.set(identity.pid, identity);
    this.workbenchPids.add(identity.pid);
    if (ownerArgument) this.ownerArguments.set(identity.pid, ownerArgument);
  }
}
