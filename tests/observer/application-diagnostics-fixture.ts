import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, fork } from "node:child_process";
import { vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createObserverApplication,
  type CreateObserverApplicationOptions,
  type ObserverApplication,
  type ObserverCaptureInput,
} from "../../src/observer/application.js";
import {
  registerObserverTools,
  type ObserverToolDefaults,
} from "../../src/observer/tools.js";
import type { OwnedRuntimeManager } from "../../src/observer/owned-runtime-manager.js";
import type {
  WorkbenchObserverInstance,
  WorkbenchObserverJobStatus,
  WorkbenchObserverRecoverInput,
  WorkbenchObserverSubmitInput,
} from "../../src/workbench/observer-adapter.js";
import { workbenchWorldRevision } from "../../src/observer/world-revision.js";

const CHILD_PROTOCOL = "rfo-observer-child-v1";

export class FakeChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new PassThrough();
  readonly operations: string[] = [];
  readonly requests: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  readonly responders = new Map<string, (payload: Record<string, unknown>) => unknown>();
  killed = false;
  holdOperation: string | null = null;
  instances: Array<Record<string, unknown>> = [];

  constructor() {
    super();
  }

  announceReady(): void {
    queueMicrotask(() => this.emit("message", {
      protocol: CHILD_PROTOCOL,
      type: "ready",
      descriptor: { protocolVersion: "1.0", agentVersion: "0.1.0",
        agentInstanceId: "agent-test", host: "127.0.0.1", port: 49152 },
    }));
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    const request = message as { requestId: string; operation: string; payload?: Record<string, unknown> };
    this.operations.push(request.operation);
    const payload = request.payload ?? {};
    this.requests.push({ operation: request.operation, payload });
    callback?.(null);
    if (request.operation === this.holdOperation) return true;
    queueMicrotask(() => {
      try {
        const responder = this.responders.get(request.operation);
        const result = responder
          ? responder(payload)
          : request.operation === "instances" ? { instances: this.instances }
          : request.operation === "cancelJob" ? {
              sessionId: payload.sessionId,
              jobId: payload.jobId,
              instanceId: "runtime-instance-1",
              state: "cancelled",
              cameraLease: {
                everHeld: false,
                held: false,
                restorationConfirmed: true,
              },
            }
          : { operation: request.operation };
        this.emit("message", { protocol: CHILD_PROTOCOL, type: "response",
          requestId: request.requestId, ok: true, result });
      } catch (error) {
        const candidate = error as { code?: unknown; message?: unknown };
        this.emit("message", {
          protocol: CHILD_PROTOCOL, type: "response", requestId: request.requestId, ok: false,
          error: {
            code: typeof candidate.code === "string" ? candidate.code : "INTERNAL_ERROR",
            message: typeof candidate.message === "string" ? candidate.message : String(error),
          },
        });
      }
      if (request.operation === "shutdown") this.exit(0);
    });
    return true;
  }

  disconnect(): void {
    this.connected = false;
    this.emit("disconnect");
  }

  kill(): boolean {
    this.killed = true;
    this.exit(0);
    return true;
  }

  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.connected = false;
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

function fakeFork(child: FakeChild, count: { value: number }): typeof fork {
  return (() => {
    count.value += 1;
    child.announceReady();
    return child as unknown as ChildProcess;
  }) as typeof fork;
}

export function createChildBackedApplication(
  child: FakeChild,
  options: Omit<CreateObserverApplicationOptions, "forkChild"> = {},
  forkCount: { value: number } = { value: 0 },
): ObserverApplication {
  return createObserverApplication({
    agentPath: "private-child.js",
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    ...options,
    forkChild: fakeFork(child, forkCount),
  });
}

export function createChildHarness(
  options: Omit<CreateObserverApplicationOptions, "forkChild"> = {},
  child = new FakeChild(),
) {
  const forkCount = { value: 0 };
  return { child, forkCount, coordinator: createChildBackedApplication(child, options, forkCount) };
}

export function createWorkbenchHarness(
  adapter = fakeWorkbenchAdapter(),
  child = new FakeChild(),
  options: Omit<CreateObserverApplicationOptions, "forkChild" | "workbenchAdapter"> = {},
  forkCount: { value: number } = { value: 0 },
) {
  return { adapter, child,
    coordinator: createChildBackedApplication(child, { ...options, workbenchAdapter: adapter }, forkCount) };
}

export function respondWithRun(
  child: FakeChild,
  runId: string,
  captures: Array<Record<string, unknown>> | (() => Array<Record<string, unknown>>),
  state = "open",
): void {
  child.responders.set("runStatus", () => ({ runId, state,
    captures: typeof captures === "function" ? captures() : captures, warnings: [] }));
}

export interface RegisteredTool {
  definition: {
    description?: string;
    inputSchema?: Record<string, { safeParse(value: unknown): { success: boolean; data?: unknown } }>;
  };
  handler: (input: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<{
    content: Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    isError?: boolean;
  }>;
}

export function toolRegistry(
  coordinator: ObserverApplication,
  ownedRuntimeManager: OwnedRuntimeManager = {} as OwnedRuntimeManager,
  defaults: Omit<ObserverToolDefaults, "ownedRuntimeManager"> = {}
): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, definition: RegisteredTool["definition"],
      handler: RegisteredTool["handler"]): void => {
      tools.set(name, { definition, handler });
    },
  } as unknown as McpServer;
  registerObserverTools(server, coordinator, { ...defaults, ownedRuntimeManager });
  return tools;
}

export function createToolHarness(
  overrides: Record<string, unknown> = {},
  ownedRuntimeManager?: OwnedRuntimeManager,
) {
  const coordinator = toolApplication(overrides);
  const tools = toolRegistry(coordinator, ownedRuntimeManager);
  const signal = new AbortController().signal;
  const extra = { signal };
  return { coordinator, tools,
    handler: (name: string) => tools.get(name)!.handler,
    call: (name: string, input: Record<string, unknown>) => tools.get(name)!.handler(input, extra),
    signal, extra };
}

export function toolApplication(
  overrides: Record<string, unknown> = {},
): ObserverApplication {
  return { defaultCaptureTimeoutMs: 30_000, maxInlineImageBytes: 1_024,
    ...overrides } as unknown as ObserverApplication;
}

export function captureToolInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { sessionId: "session-1", view: { kind: "current" }, asynchronous: false,
    timeoutMs: 30_000, settleFrames: 0, performancePolicy: "evidence", ...overrides };
}

export function runtimeInstance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { instanceId: "runtime-instance-1", sessionId: "runtime-session-1",
    capabilities: ["render.capture", "camera.runtime"], worldId: null, worldEpoch: 0,
    stale: false, transportHealthy: true, headless: false, ...overrides };
}

export function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const WORKBENCH_INSTANCE_ID = "workbench-generation-1";
const WORKBENCH_WORLD_ID = "world-editor-1";

export function workbenchJob(
  state: string,
  sequence = 1,
  jobId = "wb-job-1",
): WorkbenchObserverJobStatus {
  const terminal = state === "completed" || state === "cancelled" || state === "failed";
  return {
    jobId, instanceId: WORKBENCH_INSTANCE_ID, lifecycleGeneration: "generation-1",
    canonicalTarget: "C:/projects/CurrentProject.gproj",
    worldIdentity: WORKBENCH_WORLD_ID, viewKind: "current", state, sequence,
    message: `Workbench job is ${state}`,
    cameraLeaseHeld: !terminal, restorationConfirmed: terminal, ownerCameraId: 4, actualFov: 70,
    actualCamera: {
      matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 2, 3]],
      position: [1, 2, 3], verticalFov: 70, nearPlane: 0.1, farPlane: 1_000,
    },
    ...(state === "completed" ? {
      artifact: {
        format: "png", mimeType: "image/png", path: "C:/profile/ReforgerForgeObserver/workbench/wb-job-1.png",
        logicalPath: "$profile:ReforgerForgeObserver/workbench/wb-job-1.png",
        bytes: 70, pngBytes: png.length, width: 1, height: 1,
        sourceWidth: 1, sourceHeight: 1,
        viewportWidth: 1, viewportHeight: 1,
        sha256: "a".repeat(64), pngSha256: "b".repeat(64),
        completedAt: "2026-07-15T12:00:00.000Z",
      },
    } : {}),
  };
}

export function workbenchInstance(
  overrides: Partial<WorkbenchObserverInstance> = {},
): WorkbenchObserverInstance {
  return {
    instanceId: WORKBENCH_INSTANCE_ID, lifecycleGeneration: "generation-1",
    canonicalTarget: "C:/projects/CurrentProject.gproj",
    endpoint: { host: "127.0.0.1", port: 17777 },
    process: {
      pid: 42, executablePath: "C:/tools/Workbench.exe",
      creationTime: "2026-07-15T11:59:00.000Z",
      launchedAtMs: Date.parse("2026-07-15T11:59:00.000Z"),
    },
    projectFile: "C:/projects/CurrentProject.gproj", worldIdentity: WORKBENCH_WORLD_ID,
    capabilities: ["render.capture", "camera.editor"],
    activeJobId: null, restorationApiAvailable: true,
    readinessMessage: "full camera APIs available",
    ...overrides,
  };
}

export function workbenchCaptureInput(
  idempotencyKey: string,
  overrides: Partial<ObserverCaptureInput> = {},
): ObserverCaptureInput {
  return {
    idempotencyKey,
    view: { kind: "current" },
    timeoutMs: 1_000,
    expectedWorldRevision: workbenchWorldRevision(WORKBENCH_WORLD_ID),
    ...overrides,
  };
}

export function managedWorkbenchCaptureInput(
  runId: string,
  captureLabel: string,
  overrides: Partial<ObserverCaptureInput> = {},
): ObserverCaptureInput {
  return workbenchCaptureInput(`${runId}:${captureLabel}`, {
    runId,
    captureLabel,
    instanceId: WORKBENCH_INSTANCE_ID,
    asynchronous: true,
    ...overrides,
  });
}

export interface ManagedWorkbenchCaptureRecord extends Record<string, unknown> {
  captureLabel: string;
  state: string;
  backend: "workbench";
  jobId: string;
  instanceId: string;
  worldId: string | null;
  worldEpoch: number;
  artifactAvailable: boolean;
  missingArtifact: boolean;
}

export function managedWorkbenchCaptureRecord(
  captureLabel: string,
  overrides: Partial<ManagedWorkbenchCaptureRecord> = {},
): ManagedWorkbenchCaptureRecord {
  return {
    captureLabel, state: "completed", backend: "workbench", jobId: "wb-job-1",
    instanceId: WORKBENCH_INSTANCE_ID, worldId: WORKBENCH_WORLD_ID, worldEpoch: 0,
    artifactAvailable: true, missingArtifact: false,
    ...overrides,
  };
}

export interface ManagedWorkbenchArtifactMetadata extends Record<string, unknown> {
  instanceId: string;
  worldId: string | null;
  worldEpoch: number;
  width: number;
  height: number;
  contentSha256: string;
  completedAt: string;
  requestedView: ObserverCaptureInput["view"];
}

export function managedWorkbenchArtifactMetadata(
  overrides: Partial<ManagedWorkbenchArtifactMetadata> = {},
): ManagedWorkbenchArtifactMetadata {
  return {
    instanceId: WORKBENCH_INSTANCE_ID, worldId: WORKBENCH_WORLD_ID, worldEpoch: 0,
    width: 1, height: 1,
    contentSha256: "b".repeat(64),
    completedAt: "2026-07-15T12:00:00.000Z",
    requestedView: { kind: "current" },
    ...overrides,
  };
}

export function fakeWorkbenchAdapter(options: { unavailable?: boolean } = {}) {
  let state = "queued";
  let jobId = "wb-job-1";
  return {
    instances: vi.fn(async (): Promise<WorkbenchObserverInstance[]> => {
      if (options.unavailable) throw new Error("observer handler is not installed");
      return [workbenchInstance()];
    }),
    submit: vi.fn(async (input: WorkbenchObserverSubmitInput) => {
      jobId = input.jobId ?? jobId;
      return workbenchJob(state, 1, jobId);
    }),
    recover: vi.fn(async (_input: WorkbenchObserverRecoverInput) => workbenchJob(state, 2, jobId)),
    status: vi.fn(async () => workbenchJob(state, 2, jobId)),
    cancel: vi.fn(async (_jobId: string) => {
      state = "cancelled";
      return workbenchJob(state, 3, jobId);
    }),
    release: vi.fn(async (_jobId: string) => ({ jobId: "wb-job-1",
      restorationConfirmed: true, artifactRemoved: true })),
    readCompletedArtifact: vi.fn((_jobId: string) => ({
      image: png,
      metadata: { width: 1, height: 1, contentSha256: "b".repeat(64),
        completedAt: "2026-07-15T12:00:00.000Z" },
    })),
    restoreAll: vi.fn(async () => undefined),
    complete(): void {
      state = "completed";
    },
  } satisfies NonNullable<CreateObserverApplicationOptions["workbenchAdapter"]> & { complete(): void };
}
