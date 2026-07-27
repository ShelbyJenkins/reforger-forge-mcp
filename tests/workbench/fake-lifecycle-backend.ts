import type {
  ExactProcessIdentity,
  LifecycleEndpoint,
  VerifyEndpointOwnerResult,
  VerifyEndpointVacantResult,
  WorkbenchIdentity,
  WorkbenchLifecycleBackend,
  WorkbenchLifecycleStateV3,
  WorkbenchProcessScan,
  WorkbenchSpawnRecord,
} from "../../src/workbench/process-guard.js";

interface FakeSpawnJournalState {
  version: 3;
  generation: string;
  record: WorkbenchSpawnRecord;
}
import {
  createFakeExactProcessBackend,
  type FakeExactProcessBackend,
} from "../foundation/fake-exact-process-backend.js";

interface FakeLifecycleControls {
  workbenchPids: Set<number>;
  endpointOwnershipCalls: Array<{
    endpoint: LifecycleEndpoint;
    expected: WorkbenchIdentity;
  }>;
  endpointVacancyCalls: LifecycleEndpoint[];
  unverifiable: WorkbenchProcessScan["unverifiable"];
  endpointOwnershipResult: VerifyEndpointOwnerResult | null;
  endpointVacancyResult: VerifyEndpointVacantResult | null;
  minimizeWindowCalls: Array<{ pid: number; timeoutMs: number }>;
  minimizeWindowResult: { minimized: boolean } | null;
  replaceFailure: ((args: {
    expectedGeneration: string | null;
    next: WorkbenchLifecycleStateV3;
  }) => Error | null) | null;
  /** Fires after a lifecycle write commits, before its caller observes success. May throw. */
  afterReplace: ((args: { generation: string; next: WorkbenchLifecycleStateV3 }) => void) | null;
  spawnJournalReplaceFailure: ((args: {
    expectedGeneration: string | null;
    next: FakeSpawnJournalState;
  }) => Error | null) | null;
  afterSpawnJournalReplace: ((args: { generation: string; next: FakeSpawnJournalState }) => void) | null;
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
  backend.minimizeWindowCalls = [];
  backend.minimizeWindowResult = null;
  backend.replaceFailure = null;
  backend.afterReplace = null;
  backend.spawnJournalReplaceFailure = null;
  backend.afterSpawnJournalReplace = null;

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

  backend.minimizeWindow = async (pid, timeoutMs) => {
    backend.minimizeWindowCalls.push({ pid, timeoutMs });
    return backend.minimizeWindowResult ?? { minimized: true };
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

  backend.addWorkbench = (identity, ownerArgument) => {
    backend.processes.set(identity.pid, identity);
    backend.workbenchPids.add(identity.pid);
    if (ownerArgument) backend.ownerArguments.set(identity.pid, ownerArgument);
  };

  return backend;
}
