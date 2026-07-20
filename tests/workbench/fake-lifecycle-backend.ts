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
  LifecycleEndpoint,
  VerifyEndpointOwnerResult,
  VerifyEndpointVacantResult,
  WorkbenchIdentity,
  WorkbenchLifecycleBackend,
  WorkbenchLifecycleStateV3,
  WorkbenchProcessScan,
} from "../../src/workbench/process-guard.js";
import {
  createFakeExactProcessBackend,
  type FakeExactProcessBackend,
} from "../foundation/fake-exact-process-backend.js";

interface FakeLifecycleControls {
  readonly workbenchPids: Set<number>;
  readonly endpointOwnershipCalls: Array<{
    endpoint: LifecycleEndpoint;
    expected: WorkbenchIdentity;
  }>;
  readonly endpointVacancyCalls: LifecycleEndpoint[];
  unverifiable: WorkbenchProcessScan["unverifiable"];
  endpointOwnershipResult: VerifyEndpointOwnerResult | null;
  endpointVacancyResult: VerifyEndpointVacantResult | null;
  replaceFailure: ((args: {
    path: string;
    expectedGeneration: string | null;
    next: WorkbenchLifecycleStateV3;
  }) => Error | null) | null;
  addWorkbench(identity: ExactProcessIdentity, ownerArgument?: string): void;
}

/** Workbench-specific capabilities adapted onto the one shared exact-process fake. */
export type FakeLifecycleBackend = FakeExactProcessBackend &
  WorkbenchLifecycleBackend &
  FakeLifecycleControls;

export function createFakeLifecycleBackend(
  current: ExactProcessIdentity & { userSid: string } = {
    pid: 1001,
    executablePath: "C:\\Program Files\\nodejs\\node.exe",
    creationTime: "133900000000000001",
    userSid: "S-1-5-21-test-user",
  }
): FakeLifecycleBackend {
  const backend = createFakeExactProcessBackend(current) as FakeLifecycleBackend;
  backend.processes.set(current.pid, current);
  backend.workbenchPids = new Set<number>();
  backend.endpointOwnershipCalls = [];
  backend.endpointVacancyCalls = [];
  backend.unverifiable = [];
  backend.endpointOwnershipResult = null;
  backend.endpointVacancyResult = null;
  backend.replaceFailure = null;

  backend.scanWorkbenchProcesses = async () => ({
    processes: [...backend.workbenchPids]
      .map((pid) => backend.processes.get(pid))
      .filter((entry): entry is ExactProcessIdentity => entry !== undefined),
    unverifiable: [...backend.unverifiable],
  });

  backend.verifyEndpointOwner = async (endpoint, expected) => {
    backend.endpointOwnershipCalls.push({ endpoint, expected });
    if (backend.endpointOwnershipResult) return backend.endpointOwnershipResult;
    const actual = backend.processes.get(expected.pid);
    if (!actual || actual.creationTime !== expected.creationTime ||
        actual.executablePath.toLowerCase() !== expected.executablePath.toLowerCase() ||
        backend.ownerArguments.get(expected.pid) !== expected.ownerTokenArgument) {
      return {
        kind: "refused",
        reason: "workbench_process_mismatch",
        message: "The expected fake Workbench identity is not live and exact.",
      };
    }
    if (backend.workbenchPids.size !== 1 || !backend.workbenchPids.has(expected.pid)) {
      return {
        kind: "refused",
        reason: "workbench_process_mismatch",
        message: "The expected fake Workbench is not the sole Workbench process.",
      };
    }
    return { kind: "owned", listenerPid: expected.pid };
  };

  backend.verifyEndpointVacant = async (endpoint) => {
    backend.endpointVacancyCalls.push(endpoint);
    if (backend.endpointVacancyResult) return backend.endpointVacancyResult;
    if (backend.workbenchPids.size === 0) return { kind: "vacant" };
    const listenerPid = [...backend.workbenchPids][0];
    return {
      kind: "occupied",
      listenerPid,
      message: `Fake endpoint is still owned by PID ${listenerPid}.`,
    };
  };

  const verifyExactAndTerminate = backend.verifyAndTerminate.bind(backend);
  backend.verifyAndTerminate = async (expected, timeoutMs) => {
    const result = await verifyExactAndTerminate(expected, timeoutMs);
    if (result.kind === "terminated") backend.workbenchPids.delete(expected.pid);
    return result;
  };

  backend.replaceState = async (args) => {
    const failure = backend.replaceFailure?.(args);
    if (failure) throw failure;
    if (args.expectedGeneration === null) {
      if (existsSync(args.path)) throw new Error("generation mismatch: expected missing");
    } else {
      if (!existsSync(args.path)) throw new Error("generation mismatch: missing state");
      const currentState = JSON.parse(readFileSync(args.path, "utf8")) as { generation?: string };
      if (currentState.generation !== args.expectedGeneration) throw new Error("generation mismatch");
    }
    const temp = `${args.path}.fake.tmp`;
    writeFileSync(temp, `${JSON.stringify(args.next, null, 2)}\n`, "utf8");
    if (existsSync(args.path)) unlinkSync(args.path);
    renameSync(temp, args.path);
  };

  backend.archiveState = async (args) => {
    const bytes = readFileSync(args.path);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== args.expectedSha256) throw new Error("hash mismatch");
    renameSync(args.path, args.archivePath);
  };

  backend.addWorkbench = (identity, ownerArgument) => {
    backend.processes.set(identity.pid, identity);
    backend.workbenchPids.add(identity.pid);
    if (ownerArgument) backend.ownerArguments.set(identity.pid, ownerArgument);
  };

  return backend;
}
