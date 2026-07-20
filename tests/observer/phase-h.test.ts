import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess, fork } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ObserverCoordinator,
  ObserverCoordinatorError,
  redactChildLine,
} from "../../src/observer/coordinator.js";
import { registerObserverTools } from "../../src/observer/tools.js";
import { prepareObserverLaunch } from "../../src/observer/launch.js";
import {
  OwnedRuntimeError,
  type OwnedRuntimeManager,
} from "../../src/observer/owned-runtime-manager.js";
import {
  claimRuntimeStopReservation,
  releaseRuntimeStopReservation,
  runtimeStopObligations,
  uninstallManagedObserver,
} from "../../observer/agent/private-child.js";
import { ObserverError } from "../../observer/agent/errors.js";
import {
  captureRequestFingerprint,
  type SubmitJobInput,
} from "../../observer/agent/jobs.js";

const CHILD_PROTOCOL = "rfo-observer-child-v1";

describe("observer child diagnostic redaction", () => {
  it("removes complete contract bodies and nonce credentials before forwarding stderr", () => {
    const contractLine = redactChildLine('failure {"contract":{"sessionId":"must-not-appear","safeLooking":"also-hidden"},"detail":"tail-hidden"}');
    expect(contractLine).toContain('"contract":[REDACTED]');
    expect(contractLine).not.toContain("must-not-appear");
    expect(contractLine).not.toContain("also-hidden");
    expect(contractLine).not.toContain("tail-hidden");

    const credentialLine = redactChildLine('launchNonce="launch-secret" instanceNonce:instance-secret Authorization: Bearer abc.def');
    expect(credentialLine).not.toContain("launch-secret");
    expect(credentialLine).not.toContain("instance-secret");
    expect(credentialLine).not.toContain("abc.def");
    expect(credentialLine).toContain("[REDACTED]");
  });
});

describe("observer runtime-stop lease generations", () => {
  it("keeps caller proposals exclusive and rejects delayed stale releases", () => {
    const reservations = new Map<string, string>();
    const sessionId = "session-lease";
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";

    expect(claimRuntimeStopReservation(reservations, sessionId, first)).toEqual({
      reserved: true,
      reservationId: first,
      created: true,
    });
    expect(claimRuntimeStopReservation(reservations, sessionId, first)).toEqual({
      reserved: true,
      reservationId: first,
      created: false,
    });
    expect(claimRuntimeStopReservation(reservations, sessionId, second)).toEqual({
      reserved: false,
      created: false,
    });
    expect(releaseRuntimeStopReservation(reservations, sessionId, second)).toBe(false);
    expect(releaseRuntimeStopReservation(reservations, sessionId, first)).toBe(true);
    expect(claimRuntimeStopReservation(reservations, sessionId, second)).toMatchObject({
      reserved: true,
      reservationId: second,
    });
    expect(releaseRuntimeStopReservation(reservations, sessionId, first)).toBe(false);
    expect(reservations.get(sessionId)).toBe(second);
  });

  it("ignores stale terminal heartbeat IDs while retaining authoritative restoration work", () => {
    const obligations = runtimeStopObligations([
      {
        jobId: "job-terminal",
        state: "completed",
        cameraLease: { everHeld: true, held: false, restorationConfirmed: true },
      },
      {
        jobId: "job-restoring",
        state: "restoring",
        cameraLease: { everHeld: true, held: false, restorationConfirmed: false },
      },
    ], [
      { activeJobId: "job-terminal", cameraLeaseJobId: "job-terminal" },
      { activeJobId: "job-restoring", cameraLeaseJobId: "job-restoring" },
    ], new Set(["job-restoring"]));

    expect(obligations).toEqual({
      activeJobIds: ["job-restoring"],
      cameraLeaseJobIds: ["job-restoring"],
      restorationPendingJobIds: ["job-restoring"],
    });
  });
});

class FakeChild extends EventEmitter {
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
    queueMicrotask(() => this.emit("message", {
      protocol: CHILD_PROTOCOL,
      type: "ready",
      descriptor: {
        protocolVersion: "1.0",
        agentVersion: "0.1.0",
        agentInstanceId: "agent-test",
        host: "127.0.0.1",
        port: 49152,
      },
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
          : request.operation === "instances" ? { instances: this.instances } : { operation: request.operation };
        this.emit("message", {
          protocol: CHILD_PROTOCOL,
          type: "response",
          requestId: request.requestId,
          ok: true,
          result,
        });
      } catch (error) {
        const candidate = error as { code?: unknown; message?: unknown };
        this.emit("message", {
          protocol: CHILD_PROTOCOL,
          type: "response",
          requestId: request.requestId,
          ok: false,
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
    return child as unknown as ChildProcess;
  }) as typeof fork;
}

interface RegisteredTool {
  definition: {
    description?: string;
    inputSchema?: Record<string, { safeParse(value: unknown): { success: boolean; data?: unknown } }>;
  };
  handler: (input: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<{
    content: Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    isError?: boolean;
  }>;
}

function toolRegistry(
  coordinator: ObserverCoordinator,
  ownedRuntimeManager: OwnedRuntimeManager = {} as OwnedRuntimeManager
): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, definition: RegisteredTool["definition"], handler: RegisteredTool["handler"]): void => {
      tools.set(name, { definition, handler });
    },
  } as unknown as McpServer;
  registerObserverTools(server, coordinator, {
    ownedRuntimeManager,
  });
  return tools;
}

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

function workbenchJob(state: string, sequence = 1): Record<string, unknown> {
  const terminal = state === "completed" || state === "cancelled" || state === "failed";
  return {
    jobId: "wb-job-1",
    instanceId: "workbench-generation-1",
    lifecycleGeneration: "generation-1",
    canonicalTarget: "C:/projects/CurrentProject.gproj",
    worldIdentity: "world-editor-1",
    viewKind: "current",
    state,
    sequence,
    message: `Workbench job is ${state}`,
    cameraLeaseHeld: !terminal,
    restorationConfirmed: terminal,
    ownerCameraId: 4,
    actualFov: 70,
    actualCamera: {
      matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 2, 3]],
      position: [1, 2, 3],
      verticalFov: 70,
      nearPlane: 0.1,
      farPlane: 1_000,
    },
    ...(state === "completed" ? {
      artifact: {
        format: "png",
        path: "C:/profile/ReforgerForgeObserver/workbench/wb-job-1.png",
        logicalPath: "$profile:ReforgerForgeObserver/workbench/wb-job-1.png",
        bytes: 70,
        pngBytes: png.length,
        width: 1,
        height: 1,
        sha256: "a".repeat(64),
        pngSha256: "b".repeat(64),
        completedAt: "2026-07-15T12:00:00.000Z",
      },
    } : {}),
  };
}

function fakeWorkbenchAdapter(options: { unavailable?: boolean } = {}) {
  let state = "queued";
  let jobId = "wb-job-1";
  return {
    instances: vi.fn(async () => {
      if (options.unavailable) throw new Error("observer handler is not installed");
      return [{
        instanceId: "workbench-generation-1",
        lifecycleGeneration: "generation-1",
        canonicalTarget: "C:/projects/CurrentProject.gproj",
        endpoint: { host: "127.0.0.1", port: 17777 },
        process: { pid: 42 },
        projectFile: "C:/projects/CurrentProject.gproj",
        worldIdentity: "world-editor-1",
        capabilities: ["render.capture", "camera.editor"],
        activeJobId: null,
        restorationApiAvailable: true,
        readinessMessage: "full camera APIs available",
      }];
    }),
    submit: vi.fn(async (input: { jobId?: string }) => {
      jobId = input.jobId ?? jobId;
      return { ...workbenchJob(state), jobId } as never;
    }),
    recover: vi.fn(async () => ({ ...workbenchJob(state, 2), jobId }) as never),
    status: vi.fn(async () => ({ ...workbenchJob(state, 2), jobId }) as never),
    cancel: vi.fn(async () => {
      state = "cancelled";
      return { ...workbenchJob(state, 3), jobId } as never;
    }),
    release: vi.fn(async () => ({
      jobId: "wb-job-1",
      restorationConfirmed: true,
      artifactRemoved: true,
    })),
    readCompletedArtifact: vi.fn(() => ({
      image: png,
      metadata: {
        width: 1,
        height: 1,
        contentSha256: "b".repeat(64),
        completedAt: "2026-07-15T12:00:00.000Z",
      },
    })),
    restoreAll: vi.fn(async () => undefined),
    complete(): void {
      state = "completed";
    },
  };
}

describe("Phase H observer coordinator", () => {
  it("preserves sessions and staging while a cancelled job still requires restoration", () => {
    const cancel = vi.fn();
    const revoke = vi.fn();
    const cleanup = vi.fn();
    const activeJob = {
      sessionId: "session-1",
      jobId: "job-1",
      state: "restoring",
      cameraLease: { held: true, restorationConfirmed: false },
    };
    const agent = {
      jobs: { diagnostics: vi.fn(() => [activeJob]), cancel },
      control: {
        revokeSession: revoke,
        cleanupStaged: cleanup,
      },
    };

    expect(() => uninstallManagedObserver(agent as never)).toThrowError(
      expect.objectContaining<Partial<ObserverError>>({ code: "CAMERA_BUSY" })
    );
    expect(cancel).toHaveBeenCalledWith("session-1", "job-1");
    expect(revoke).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("refuses managed or profile roots that overlap the configured project", () => {
    expect(() => new ObserverCoordinator({
      projectPath: process.cwd(),
      managedRoot: join(process.cwd(), "observer-managed"),
    })).toThrowError(expect.objectContaining<Partial<ObserverCoordinatorError>>({ code: "INVALID_REQUEST" }));
    expect(() => new ObserverCoordinator({
      projectPath: process.cwd(),
      profileRoot: join(process.cwd(), "observer-profiles"),
    })).toThrowError(expect.objectContaining<Partial<ObserverCoordinatorError>>({ code: "INVALID_REQUEST" }));
    expect(() => new ObserverCoordinator({
      projectPath: process.cwd(),
      defaultManagedRoot: join(process.cwd(), "observer-default-managed"),
    })).toThrowError(expect.objectContaining<Partial<ObserverCoordinatorError>>({ code: "INVALID_REQUEST" }));
  });

  it("always passes the confined platform-default roots to its private child", async () => {
    const child = new FakeChild();
    const managedRoot = resolve(process.cwd(), "..", ".observer-default-test");
    let forkArguments: readonly string[] = [];
    const forkChild = ((_modulePath: string, argumentsArray?: readonly string[]) => {
      forkArguments = argumentsArray ?? [];
      return child as unknown as ChildProcess;
    }) as typeof fork;
    const coordinator = new ObserverCoordinator({
      projectPath: process.cwd(),
      defaultManagedRoot: managedRoot,
      agentPath: "private-child.js",
      forkChild,
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    });

    await coordinator.ensureSetup();

    expect(forkArguments).toEqual(expect.arrayContaining([
      "--root", managedRoot,
      "--profile-root", join(managedRoot, "profiles"),
    ]));
    await coordinator.close();
  });

  it("deduplicates concurrent lazy startup and requests graceful child shutdown", async () => {
    const child = new FakeChild();
    const count = { value: 0 };
    const coordinator = new ObserverCoordinator({
      agentPath: "private-child.js",
      forkChild: fakeFork(child, count),
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    });

    expect(coordinator.diagnosticPrivateChildCount()).toBe(0);
    await Promise.all([coordinator.ensureSetup(), coordinator.ensureSetup()]);
    await Promise.all([coordinator.status(), coordinator.doctor()]);

    expect(count.value).toBe(1);
    expect(coordinator.diagnosticPrivateChildCount()).toBe(1);
    expect(child.operations.sort()).toEqual(["doctor", "stage", "stage", "status"]);
    await coordinator.close();
    expect(child.operations).toContain("shutdown");
    expect(child.killed).toBe(false);
    expect(coordinator.diagnosticPrivateChildCount()).toBe(0);
  });

  it("keeps a timed-out private child counted until its actual exit", async () => {
    const child = new FakeChild();
    const coordinator = new ObserverCoordinator({
      agentPath: "private-child.js",
      forkChild: fakeFork(child, { value: 0 }),
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    });
    await coordinator.ensureSetup();
    child.holdOperation = "shutdown";
    child.kill = () => {
      child.killed = true;
      return true;
    };

    vi.useFakeTimers();
    try {
      const closePromise = coordinator.close();
      await vi.advanceTimersByTimeAsync(4_000);
      await closePromise;

      expect(child.killed).toBe(true);
      expect(coordinator.diagnosticPrivateChildCount()).toBe(1);
      child.exit(0);
      expect(coordinator.diagnosticPrivateChildCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects active operations when its exact child exits", async () => {
    const child = new FakeChild();
    const count = { value: 0 };
    const coordinator = new ObserverCoordinator({
      agentPath: "private-child.js",
      forkChild: fakeFork(child, count),
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 10_000,
    });
    await coordinator.ensureSetup();
    child.holdOperation = "status";
    const status = coordinator.status();
    await vi.waitFor(() => expect(child.operations).toContain("status"));
    child.exit(17);
    await expect(status).rejects.toEqual(expect.objectContaining<Partial<ObserverCoordinatorError>>({
      code: "TRANSPORT_UNAVAILABLE",
    }));
    await expect(coordinator.status()).resolves.toMatchObject({
      readOnly: true,
      agentState: "idle",
      running: false,
    });
    expect(count.value).toBe(1);
    await coordinator.close();
  });

  it("keeps idle status and doctor strictly read-only without forking or creating managed roots", async () => {
    const parent = mkdtempSync(join(tmpdir(), "rfo-idle-diagnostics-"));
    const managedRoot = join(parent, "managed-root-must-not-be-created");
    const count = { value: 0 };
    const coordinator = new ObserverCoordinator({
      managedRoot,
      forkChild: fakeFork(new FakeChild(), count),
    });

    try {
      expect(existsSync(managedRoot)).toBe(false);
      const [status, doctor] = await Promise.all([coordinator.status(), coordinator.doctor()]);

      expect(status).toMatchObject({
        readOnly: true,
        mutationPerformed: false,
        diagnostic: "status",
        agentState: "idle",
        running: false,
        managedStorage: {
          root: { path: managedRoot, exists: false, kind: "missing" },
          profileRoot: { exists: false, kind: "missing" },
        },
        sourceManifest: { verificationState: "declared", verified: false },
        stateLoaded: false,
        sessions: [],
        instances: [],
        jobs: [],
      });
      expect(doctor).toMatchObject({
        readOnly: true,
        mutationPerformed: false,
        diagnostic: "doctor",
        agentState: "idle",
        running: false,
      });
      expect(count.value).toBe(0);
      expect(existsSync(managedRoot)).toBe(false);
      await coordinator.close();
      expect(count.value).toBe(0);
      expect(existsSync(managedRoot)).toBe(false);
    } finally {
      await coordinator.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("returns a host-validated Workbench PNG without starting the private runtime child", async () => {
    const adapter = fakeWorkbenchAdapter();
    adapter.complete();
    const count = { value: 0 };
    const coordinator = new ObserverCoordinator({
      forkChild: fakeFork(new FakeChild(), count),
      pollIntervalMs: 10,
      workbenchAdapter: adapter as never,
    });

    const result = await coordinator.capture({
      idempotencyKey: "workbench-current-1",
      view: { kind: "current" },
      timeoutMs: 1_000,
    });

    expect(result.asynchronous).toBe(false);
    if (!result.asynchronous) {
      expect(result.image).toEqual(png);
      expect(result.job).toMatchObject({
        backend: "workbench",
        jobId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        state: "completed",
        worldId: "world-editor-1",
      });
      expect(result.job.artifact).not.toHaveProperty("path");
    }
    expect(count.value).toBe(0);
    await coordinator.close();
    expect(adapter.restoreAll).toHaveBeenCalledOnce();
  });

  it("routes asynchronous Workbench status, cancellation, and release without sessionId", async () => {
    const adapter = fakeWorkbenchAdapter();
    const coordinator = new ObserverCoordinator({
      agentPath: "private-child.js",
      forkChild: fakeFork(new FakeChild(), { value: 0 }),
      workbenchAdapter: adapter as never,
    });
    await coordinator.ensureSetup();
    const submitted = await coordinator.capture({
      idempotencyKey: "workbench-async-1",
      view: { kind: "current" },
      asynchronous: true,
      timeoutMs: 1_000,
    });
    expect(submitted).toMatchObject({ asynchronous: true, job: { backend: "workbench" } });
    const jobId = submitted.job.jobId as string;
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);

    expect(await coordinator.jobStatus(undefined, jobId)).toMatchObject({ state: "queued" });
    expect(await coordinator.cancelJob(undefined, jobId)).toMatchObject({ state: "cancelled" });
    const released = {
      backend: "workbench",
      jobId,
      restorationConfirmed: true,
      artifactRemoved: true,
    };
    expect(await coordinator.releaseJob(undefined, jobId)).toMatchObject(released);
    expect(await coordinator.releaseJob(undefined, jobId)).toMatchObject(released);
    expect(adapter.recover).toHaveBeenCalledWith({ jobId, expectedInstanceId: "workbench-generation-1" });
    expect(adapter.cancel).toHaveBeenCalledWith(jobId);
    expect(adapter.release).toHaveBeenCalledOnce();
    await coordinator.close();
  });

  it("deduplicates Workbench captures by a hashed public idempotency key and rejects conflicting reuse", async () => {
    const adapter = fakeWorkbenchAdapter();
    const coordinator = new ObserverCoordinator({
      agentPath: "private-child.js",
      forkChild: fakeFork(new FakeChild(), { value: 0 }),
      workbenchAdapter: adapter as never,
    });
    await coordinator.ensureSetup();
    const request = {
      idempotencyKey: "raw-user-key-must-not-become-a-job-path",
      view: { kind: "current" } as const,
      expectedWorldId: "world-editor-1",
      expectedWorldEpoch: 0,
      asynchronous: true,
      timeoutMs: 1_000,
    };

    const [first, retry] = await Promise.all([
      coordinator.capture(request),
      coordinator.capture(request),
    ]);

    expect(first).toMatchObject({ asynchronous: true, job: { jobId: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
    expect(retry).toEqual(first);
    expect(adapter.submit).toHaveBeenCalledOnce();
    expect(adapter.submit).not.toHaveBeenCalledWith(expect.objectContaining({
      jobId: "raw-user-key-must-not-become-a-job-path",
    }));
    await expect(coordinator.capture({
      ...request,
      timeoutMs: 2_000,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(coordinator.capture({
      ...request,
      view: { kind: "lookAt", position: [0, 0, 0], target: [1, 0, 0], fov: 60 },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const jobId = first.job.jobId as string;
    await coordinator.cancelJob(undefined, jobId);
    await coordinator.releaseJob(undefined, jobId);
    await expect(coordinator.capture(request)).rejects.toMatchObject({ code: "JOB_RELEASED" });
    expect(adapter.submit).toHaveBeenCalledOnce();
    await coordinator.close();
  });

  it("replays runtime capture without extending its original wall-clock deadline", async () => {
    const child = new FakeChild();
    child.instances = [{
      instanceId: "runtime-instance-1",
      sessionId: "runtime-session-1",
      capabilities: ["render.capture", "camera.runtime"],
      worldId: null,
      worldEpoch: 0,
      stale: false,
      transportHealthy: true,
      headless: false,
    }];
    let retainedFingerprint: string | null = null;
    const submittedPayloads: Record<string, unknown>[] = [];
    child.responders.set("submitJob", (payload) => {
      submittedPayloads.push(payload);
      const fingerprint = captureRequestFingerprint(payload as unknown as SubmitJobInput);
      if (retainedFingerprint !== null && retainedFingerprint !== fingerprint) {
        throw Object.assign(new Error("runtime idempotency conflict"), {
          code: "IDEMPOTENCY_CONFLICT",
        });
      }
      retainedFingerprint = fingerprint;
      return {
        jobId: "runtime-job-1",
        sessionId: payload.sessionId,
        instanceId: "runtime-instance-1",
        state: "queued",
        worldId: null,
        worldEpoch: 0,
      };
    });
    const coordinator = new ObserverCoordinator({
      agentPath: "private-child.js",
      forkChild: fakeFork(child, { value: 0 }),
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    });
    await coordinator.ensureSetup();
    const request = {
      sessionId: "runtime-session-1",
      idempotencyKey: "runtime-relative-deadline",
      view: { kind: "current" } as const,
      asynchronous: true,
      timeoutMs: 1_000,
    };

    const first = await coordinator.capture(request);
    expect(first).toMatchObject({ asynchronous: true, job: { jobId: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(coordinator.capture(request)).resolves.toEqual(first);
    expect(submittedPayloads).toHaveLength(1);
    expect(submittedPayloads[0].deadlinePolicyMs).toBe(1_000);
    await expect(coordinator.capture({ ...request, timeoutMs: 2_000 }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await coordinator.close();
  });

  it("returns the same retained completed Workbench PNG for a synchronous response retry", async () => {
    const adapter = fakeWorkbenchAdapter();
    adapter.complete();
    const coordinator = new ObserverCoordinator({ workbenchAdapter: adapter as never });
    const request = {
      idempotencyKey: "sync-retry-key",
      view: { kind: "current" } as const,
      timeoutMs: 1_000,
    };

    const first = await coordinator.capture(request);
    const retry = await coordinator.capture(request);

    expect(first).toMatchObject({ asynchronous: false, job: { jobId: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
    expect(retry).toMatchObject({ asynchronous: false, job: { jobId: first.job.jobId } });
    expect(adapter.submit).toHaveBeenCalledOnce();
    expect(adapter.readCompletedArtifact).toHaveBeenCalledTimes(2);
    await coordinator.close();
  });

  it("merges Workbench with session-scoped runtime inventory and degrades handler absence to a warning", async () => {
    const runtime = {
      instanceId: "runtime-1",
      backend: "runtime",
      sessionId: "session-1",
      capabilities: ["render.capture", "camera.runtime"],
      stale: false,
      transportHealthy: true,
      headless: false,
    };
    const healthyChild = new FakeChild();
    healthyChild.instances = [runtime];
    const healthy = new ObserverCoordinator({
      agentPath: "private-child.js",
      forkChild: fakeFork(healthyChild, { value: 0 }),
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      workbenchAdapter: fakeWorkbenchAdapter() as never,
    });

    const merged = await healthy.instances({ sessionId: "session-1", renderersOnly: true });
    expect(merged.instances.map((instance) => instance.backend)).toEqual(["runtime", "workbench"]);
    expect(merged.instances[1]).toMatchObject({ selectedTransport: "workbench-netapi" });
    expect(merged.compatibleCount).toBe(2);
    await healthy.close();

    const unavailableChild = new FakeChild();
    unavailableChild.instances = [runtime];
    const unavailable = new ObserverCoordinator({
      agentPath: "private-child.js",
      forkChild: fakeFork(unavailableChild, { value: 0 }),
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      workbenchAdapter: fakeWorkbenchAdapter({ unavailable: true }) as never,
    });
    const runtimeOnly = await unavailable.instances({ sessionId: "session-1" });
    expect(runtimeOnly.instances).toEqual([expect.objectContaining(runtime)]);
    expect(runtimeOnly.warnings?.[0]).toContain("observer handler is not installed");
    await unavailable.close();
  });
});

describe("Phase H observer MCP tools", () => {
  it("returns only the public launch descriptor and does not expose launch credentials", async () => {
    const coordinator = {
      prepareLaunch: vi.fn(async () => ({
        arguments: ["-profile", "C:/profiles/run-1"],
        session: {
          sessionId: "session-1",
          launchNonce: "secret-launch-nonce",
          expiresAt: "2026-07-15T12:30:00.000Z",
          bundleDigest: "a".repeat(64),
          profilePath: "C:/profiles/run-1",
          contractPath: "C:/profiles/run-1/profile/ReforgerForgeObserver/session.json",
        },
        stagedAddon: { reused: true },
      })),
      revokeSession: vi.fn(),
    } as unknown as ObserverCoordinator;

    const recorder = {
      recordPreparedLaunch: vi.fn(async () => "pl-00000000-0000-4000-8000-000000000001"),
    };
    const result = await prepareObserverLaunch(coordinator, {
      runtimeKind: "client",
      arguments: [],
      profilePath: "C:/profiles/run-1",
      sessionTtlMs: 60_000,
      transportPreference: ["rest"],
      forceUpdate: false,
    }, recorder);

    expect(result).toMatchObject({
      arguments: ["-profile", "C:/profiles/run-1"],
      preparedLaunchId: "pl-00000000-0000-4000-8000-000000000001",
      sessionId: "session-1",
      expiresAt: "2026-07-15T12:30:00.000Z",
      bundleDigest: "a".repeat(64),
      profilePath: "C:/profiles/run-1",
      warnings: [],
    });
    expect(result).not.toHaveProperty("launchNonce");
    expect(result).not.toHaveProperty("contractPath");
    expect(recorder.recordPreparedLaunch).toHaveBeenCalledOnce();

    const externalOnly = await prepareObserverLaunch(coordinator, {
      runtimeKind: "client",
      arguments: [],
      profilePath: "C:/profiles/run-1",
      sessionTtlMs: 60_000,
      transportPreference: ["rest"],
      forceUpdate: false,
    });
    expect(externalOnly.arguments).toEqual(["-profile", "C:/profiles/run-1"]);
    expect(externalOnly).not.toHaveProperty("preparedLaunchId");
  });

  it("registers the seven exact public tools", () => {
    const coordinator = { defaultCaptureTimeoutMs: 30_000, maxInlineImageBytes: 1_024 } as ObserverCoordinator;
    const tools = toolRegistry(coordinator);
    expect([...tools.keys()].sort()).toEqual([
      "observer_capture",
      "observer_instances",
      "observer_job",
      "observer_prepare_launch",
      "observer_run",
      "observer_runtime",
      "observer_setup",
    ]);
    for (const tool of tools.values()) expect(tool.definition.description?.length).toBeGreaterThan(40);
  });

  it("routes explicit observer_runtime actions without exposing owner-token receipt fields", async () => {
    const manager = {
      start: vi.fn(async () => ({ runtimeId: "rt-one", state: "running", exactOwned: true })),
      status: vi.fn(async () => ({ runtimeId: "rt-one", state: "running", exactOwned: true })),
      stop: vi.fn(async () => ({ runtimeId: "rt-one", state: "exited", identityVacant: true })),
    } as unknown as OwnedRuntimeManager;
    const coordinator = { defaultCaptureTimeoutMs: 30_000, maxInlineImageBytes: 1_024 } as ObserverCoordinator;
    const handler = toolRegistry(coordinator, manager).get("observer_runtime")!.handler;
    const signal = new AbortController().signal;
    const started = await handler({
      action: "start",
      preparedLaunchId: "pl-00000000-0000-4000-8000-000000000001",
      idempotencyKey: "start-one",
    }, { signal });
    expect(started.isError).not.toBe(true);
    expect(manager.start).toHaveBeenCalledWith({
      preparedLaunchId: "pl-00000000-0000-4000-8000-000000000001",
      idempotencyKey: "start-one",
    });
    await handler({ action: "status", runtimeId: "rt-00000000-0000-4000-8000-000000000001" }, { signal });
    expect(manager.status).toHaveBeenCalledOnce();
    await handler({
      action: "stop",
      runtimeId: "rt-00000000-0000-4000-8000-000000000001",
      waitForRestorationMs: 20_000,
      idempotencyKey: "stop-one",
    }, { signal });
    expect(manager.stop).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "stop-one",
      waitForRestorationMs: 20_000,
      signal,
    }));
    const invalid = await handler({ action: "start" }, { signal });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain("INVALID_REQUEST");
  });

  it("does not re-expose fixed-policy diagnostics through structured tool details", async () => {
    const secret = "must-not-cross-the-public-boundary";
    const manager = {
      start: vi.fn(async () => {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          `private storage diagnostic: ${secret}`,
          { originalDiagnostic: secret }
        );
      }),
    } as unknown as OwnedRuntimeManager;
    const coordinator = {
      defaultCaptureTimeoutMs: 30_000,
      maxInlineImageBytes: 1_024,
      instances: vi.fn(async () => {
        throw new ObserverCoordinatorError(
          "UNAUTHORIZED",
          `private authorization diagnostic: ${secret}`,
          { originalDiagnostic: secret }
        );
      }),
    } as unknown as ObserverCoordinator;
    const tools = toolRegistry(coordinator, manager);
    const signal = new AbortController().signal;

    const runtimeResult = await tools.get("observer_runtime")!.handler({
      action: "start",
      preparedLaunchId: "pl-00000000-0000-4000-8000-000000000001",
      idempotencyKey: "redacted-start",
    }, { signal });
    const instancesResult = await tools.get("observer_instances")!.handler({}, { signal });

    expect(runtimeResult.content[0].text).toContain("Observer lifecycle storage could not be verified.");
    expect(instancesResult.content[0].text).toContain("Observer request was not authorized.");
    expect(runtimeResult.content[0].text).not.toContain(secret);
    expect(instancesResult.content[0].text).not.toContain(secret);
    expect(runtimeResult.content[0].text).not.toContain("originalDiagnostic");
    expect(instancesResult.content[0].text).not.toContain("originalDiagnostic");
  });

  it("rejects stale Workbench expected-world binding before adapter submission", async () => {
    const adapter = fakeWorkbenchAdapter();
    const coordinator = new ObserverCoordinator({
      agentPath: "private-child.js",
      forkChild: fakeFork(new FakeChild(), { value: 0 }),
      workbenchAdapter: adapter as never,
    });
    await expect(coordinator.capture({
      idempotencyKey: "stale-workbench-world",
      instanceId: "workbench-generation-1",
      expectedWorldId: "world-editor-previous",
      expectedWorldEpoch: 0,
      view: { kind: "current" },
      asynchronous: true,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "WORLD_CHANGED" });
    expect(adapter.submit).not.toHaveBeenCalled();
    await coordinator.close();
  });

  it("durably binds a managed run job before Workbench can retain camera state", async () => {
    const runId = "20260717T195900Z-a0b1c2d3";
    const child = new FakeChild();
    const events: string[] = [];
    const bindings: Array<Record<string, unknown>> = [];
    child.responders.set("runReserveCapture", () => ({
      runId,
      capture: {
        captureLabel: "prebound",
        state: "reserved",
        backend: null,
        jobId: null,
        artifactAvailable: false,
      },
    }));
    child.responders.set("runBindCapture", (payload) => {
      events.push("run-bind");
      bindings.push(payload);
      return { runId, capture: { state: "submitted", ...payload } };
    });
    const adapter = fakeWorkbenchAdapter();
    adapter.submit.mockImplementation(async (input: { jobId?: string }) => {
      events.push("adapter-submit");
      return { ...workbenchJob("queued"), jobId: input.jobId } as never;
    });
    const coordinator = new ObserverCoordinator({
      forkChild: fakeFork(child, { value: 0 }),
      workbenchAdapter: adapter as never,
    });

    const result = await coordinator.capture({
      runId,
      captureLabel: "prebound",
      idempotencyKey: "prebound-key",
      instanceId: "workbench-generation-1",
      expectedWorldId: "world-editor-1",
      expectedWorldEpoch: 0,
      view: { kind: "current" },
      asynchronous: true,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ asynchronous: true, job: { backend: "workbench" } });
    const submittedJobId = (adapter.submit.mock.calls[0][0] as { jobId: string }).jobId;
    expect(submittedJobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bindings[0]).toMatchObject({
      runId,
      captureLabel: "prebound",
      backend: "workbench",
      jobId: submittedJobId,
      instanceId: "workbench-generation-1",
      worldId: "world-editor-1",
      worldEpoch: 0,
    });
    expect(events.slice(0, 2)).toEqual(["run-bind", "adapter-submit"]);
    await coordinator.close();
  });

  it("submits an already-bound durable job when restart recovery proves it never reached Workbench", async () => {
    const runId = "20260717T195930Z-d0c1b2a3";
    const child = new FakeChild();
    child.responders.set("runReserveCapture", () => ({
      runId,
      capture: {
        captureLabel: "restart-before-submit",
        state: "submitted",
        backend: "workbench",
        jobId: "durable-job",
        instanceId: "workbench-generation-1",
        worldId: "world-editor-1",
        worldEpoch: 0,
        expectedWorldId: "world-editor-1",
        expectedWorldEpoch: 0,
        artifactAvailable: false,
      },
    }));
    const adapter = fakeWorkbenchAdapter();
    adapter.recover.mockRejectedValue(Object.assign(new Error("no retained handler job"), { code: "JOB_NOT_FOUND" }));
    const durableStatus = { ...workbenchJob("queued"), jobId: "durable-job" } as never;
    adapter.submit.mockResolvedValue(durableStatus);
    adapter.status.mockResolvedValue(durableStatus);
    const coordinator = new ObserverCoordinator({
      forkChild: fakeFork(child, { value: 0 }),
      workbenchAdapter: adapter as never,
    });

    await expect(coordinator.capture({
      runId,
      captureLabel: "restart-before-submit",
      idempotencyKey: "restart-before-submit-key",
      instanceId: "workbench-generation-1",
      expectedWorldId: "world-editor-1",
      expectedWorldEpoch: 0,
      view: { kind: "current" },
      asynchronous: true,
      timeoutMs: 1_000,
    })).resolves.toMatchObject({
      asynchronous: true,
      job: { jobId: "durable-job", state: "queued" },
    });
    expect(adapter.recover).toHaveBeenCalledWith({
      jobId: "durable-job",
      expectedInstanceId: "workbench-generation-1",
    });
    expect(adapter.submit).toHaveBeenCalledWith({
      jobId: "durable-job",
      view: { kind: "current" },
      settlePolls: 0,
    });
    await coordinator.close();
  });

  it("recovers a durable run's Workbench association after coordinator restart and promotes its completed image", async () => {
    const runId = "20260717T200000Z-a1b2c3d4";
    const capture = {
      captureLabel: "editor-overview",
      state: "submitted",
      backend: "workbench",
      jobId: "wb-job-1",
      instanceId: "workbench-generation-1",
      worldId: "world-editor-1",
      worldEpoch: 0,
      expectedWorldId: "world-editor-1",
      expectedWorldEpoch: 0,
      artifactAvailable: false,
      missingArtifact: false,
    };
    const child = new FakeChild();
    child.responders.set("runStatus", () => ({
      runId,
      state: "open",
      captures: [{ ...capture }],
      warnings: [],
    }));
    child.responders.set("importWorkbenchArtifact", (payload) => {
      expect(payload).toMatchObject({
        jobId: "wb-job-1",
        runId,
        captureLabel: "editor-overview",
      });
      expect(Buffer.isBuffer(payload.image)).toBe(true);
      capture.state = "completed";
      capture.artifactAvailable = true;
      return { imported: true };
    });
    const managedMetadata = {
      instanceId: "workbench-generation-1",
      worldId: "world-editor-1",
      worldEpoch: 0,
      viewKind: "current",
      ownerCameraId: 4,
      actualCamera: workbenchJob("completed").actualCamera,
      actualFov: 70,
      width: 1,
      height: 1,
      contentSha256: "b".repeat(64),
      completedAt: "2026-07-15T12:00:00.000Z",
      requestedView: { kind: "current" },
    };
    child.responders.set("inspectWorkbenchArtifact", () => ({
      available: capture.artifactAvailable,
      metadata: managedMetadata,
    }));
    child.responders.set("readWorkbenchArtifact", () => ({
      imageBase64: png.toString("base64"),
      metadata: managedMetadata,
    }));
    child.responders.set("releaseWorkbenchArtifact", () => ({ released: true }));
    const adapter = fakeWorkbenchAdapter();
    adapter.complete();
    const coordinator = new ObserverCoordinator({
      forkChild: fakeFork(child, { value: 0 }),
      workbenchAdapter: adapter as never,
    });

    await expect(coordinator.runStatus(runId)).resolves.toMatchObject({
      runId,
      captures: [{
        captureLabel: "editor-overview",
        state: "completed",
        artifactAvailable: true,
      }],
    });
    expect(adapter.recover).toHaveBeenCalledWith({
      jobId: "wb-job-1",
      expectedInstanceId: "workbench-generation-1",
    });
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(adapter.release).toHaveBeenCalledOnce();
    expect(child.operations).toEqual(expect.arrayContaining(["runStatus", "importWorkbenchArtifact"]));

    await expect(coordinator.jobStatus(undefined, "wb-job-1")).resolves.toMatchObject({
      state: "completed",
      ownerCameraId: 4,
      restorationConfirmed: true,
      actualFov: 70,
    });
    await expect(coordinator.readJob(undefined, "wb-job-1")).resolves.toMatchObject({
      image: png,
      job: { state: "completed", ownerCameraId: 4 },
    });
    expect(adapter.recover).toHaveBeenCalledOnce();
    expect(adapter.status).not.toHaveBeenCalled();

    await expect(coordinator.releaseJob(undefined, "wb-job-1")).resolves.toMatchObject({
      backend: "workbench",
      jobId: "wb-job-1",
      restorationConfirmed: true,
      managedArtifactReleased: true,
    });
    expect(adapter.recover).toHaveBeenCalledOnce();
    expect(adapter.release).toHaveBeenCalledOnce();
    await coordinator.close();
  });

  it("retires each imported Workbench handler transaction so one managed run can capture sequential views", async () => {
    const runId = "20260717T200030Z-b2c3d4e5";
    const child = new FakeChild();
    const captures = new Map<string, Record<string, unknown>>();
    child.responders.set("runReserveCapture", (payload) => {
      const label = String(payload.captureLabel);
      let capture = captures.get(label);
      if (!capture) {
        capture = {
          captureLabel: label,
          state: "reserved",
          backend: null,
          jobId: null,
          artifactAvailable: false,
        };
        captures.set(label, capture);
      }
      return { runId, capture: { ...capture } };
    });
    child.responders.set("runBindCapture", (payload) => {
      const capture = captures.get(String(payload.captureLabel));
      if (!capture) throw new Error("capture was not reserved");
      Object.assign(capture, payload, { state: "submitted", artifactAvailable: false });
      return { runId, capture: { ...capture } };
    });
    child.responders.set("importWorkbenchArtifact", (payload) => {
      const capture = captures.get(String(payload.captureLabel));
      if (!capture) throw new Error("capture was not bound");
      Object.assign(capture, { state: "completed", artifactAvailable: true });
      return { imported: true };
    });
    child.responders.set("inspectWorkbenchArtifact", (payload) => {
      const capture = [...captures.values()].find((entry) => entry.jobId === payload.jobId);
      return {
        available: capture?.artifactAvailable === true,
        metadata: {
          instanceId: "workbench-generation-1",
          worldId: "world-editor-1",
          worldEpoch: 0,
          width: 1,
          height: 1,
          contentSha256: "b".repeat(64),
          completedAt: "2026-07-15T12:00:00.000Z",
          requestedView: { kind: "current" },
        },
      };
    });

    const adapter = fakeWorkbenchAdapter();
    let activeJobId: string | null = null;
    const statusFor = (jobId: string, state: string) => ({
      ...workbenchJob(state, state === "completed" ? 2 : 1),
      jobId,
    }) as never;
    adapter.instances.mockImplementation(async () => [{
      instanceId: "workbench-generation-1",
      lifecycleGeneration: "generation-1",
      canonicalTarget: "C:/projects/CurrentProject.gproj",
      endpoint: { host: "127.0.0.1", port: 17777 },
      process: { pid: 42 },
      projectFile: "C:/projects/CurrentProject.gproj",
      worldIdentity: "world-editor-1",
      capabilities: ["render.capture", "camera.editor"],
      activeJobId: null,
      restorationApiAvailable: true,
      readinessMessage: "full camera APIs available",
    }]);
    adapter.submit.mockImplementation(async (input: { jobId?: string }) => {
      if (activeJobId) throw Object.assign(new Error("handler slot is occupied"), { code: "CAMERA_BUSY" });
      if (!input.jobId) throw new Error("managed capture omitted its durable job ID");
      activeJobId = input.jobId;
      return statusFor(input.jobId, "queued");
    });
    adapter.recover.mockImplementation(async ({ jobId }: { jobId: string }) => {
      if (!activeJobId) throw Object.assign(new Error("handler job is absent"), { code: "JOB_NOT_FOUND" });
      if (jobId !== activeJobId) throw Object.assign(new Error("handler job differs"), { code: "JOB_NOT_FOUND" });
      return statusFor(activeJobId, "completed");
    });
    adapter.release.mockImplementation(async () => {
      if (!activeJobId) throw Object.assign(new Error("handler job is absent"), { code: "JOB_NOT_FOUND" });
      const jobId = activeJobId;
      activeJobId = null;
      return { jobId, restorationConfirmed: true, artifactRemoved: true };
    });
    const coordinator = new ObserverCoordinator({
      forkChild: fakeFork(child, { value: 0 }),
      workbenchAdapter: adapter as never,
    });

    const capture = async (label: string): Promise<string> => {
      const submitted = await coordinator.capture({
        runId,
        captureLabel: label,
        idempotencyKey: `${runId}:${label}`,
        instanceId: "workbench-generation-1",
        expectedWorldId: "world-editor-1",
        expectedWorldEpoch: 0,
        view: { kind: "current" },
        asynchronous: true,
        timeoutMs: 1_000,
      });
      if (!submitted.asynchronous || typeof submitted.job.jobId !== "string") {
        throw new Error("managed Workbench capture returned no job ID");
      }
      await expect(coordinator.jobStatus(undefined, submitted.job.jobId)).resolves.toMatchObject({
        state: "completed",
        restorationConfirmed: true,
      });
      expect(activeJobId).toBeNull();
      return submitted.job.jobId;
    };

    const firstJobId = await capture("initial-current");
    const retriedFirstJobId = await capture("initial-current");
    expect(retriedFirstJobId).toBe(firstJobId);
    expect(adapter.submit).toHaveBeenCalledOnce();
    expect(adapter.release).toHaveBeenCalledOnce();
    const secondJobId = await capture("explicit-pose");
    expect(secondJobId).not.toBe(firstJobId);
    expect(adapter.submit).toHaveBeenCalledTimes(2);
    expect(adapter.release).toHaveBeenCalledTimes(2);
    expect(child.operations.filter((operation) => operation === "importWorkbenchArtifact")).toHaveLength(2);
    await coordinator.close();
  });

  it("answers Workbench job status from an exact durable run binding after coordinator restart", async () => {
    const runId = "20260717T200045Z-a1b2c3d4";
    const child = new FakeChild();
    child.responders.set("runStatus", () => ({
      runId,
      state: "open",
      captures: [{
        captureLabel: "restart-status",
        state: "completed",
        backend: "workbench",
        jobId: "wb-job-1",
        instanceId: "workbench-generation-1",
        worldId: "world-editor-1",
        worldEpoch: 0,
        artifactAvailable: true,
        missingArtifact: false,
      }],
      warnings: [],
    }));
    const adapter = fakeWorkbenchAdapter();
    adapter.recover.mockRejectedValue(Object.assign(new Error("handler retired"), { code: "JOB_NOT_FOUND" }));
    const coordinator = new ObserverCoordinator({
      forkChild: fakeFork(child, { value: 0 }),
      workbenchAdapter: adapter as never,
    });

    await coordinator.runStatus(runId);
    await expect(coordinator.jobStatus(undefined, "wb-job-1")).resolves.toMatchObject({
      backend: "workbench",
      jobId: "wb-job-1",
      state: "completed",
      restorationConfirmed: true,
      recoveredFromManagedArtifact: true,
    });
    expect(adapter.recover).toHaveBeenCalledOnce();
    await coordinator.close();
  });

  it("reuses the handler-only receipt while managed artifact release is retried", async () => {
    const runId = "20260717T200100Z-b1c2d3e4";
    const child = new FakeChild();
    child.responders.set("runStatus", () => ({
      runId,
      state: "finalized",
      captures: [{
        captureLabel: "release-order",
        state: "completed",
        backend: "workbench",
        jobId: "wb-job-1",
        instanceId: "workbench-generation-1",
        worldId: "world-editor-1",
        worldEpoch: 0,
        artifactAvailable: true,
        missingArtifact: false,
      }],
      warnings: [],
    }));
    let releaseAttempts = 0;
    const events: string[] = [];
    child.responders.set("releaseWorkbenchArtifact", () => {
      releaseAttempts += 1;
      events.push(`managed-${releaseAttempts}`);
      if (releaseAttempts === 1) {
        throw Object.assign(new Error("managed release temporarily unavailable"), { code: "TRANSPORT_UNAVAILABLE" });
      }
      return { released: true };
    });
    const adapter = fakeWorkbenchAdapter();
    adapter.complete();
    adapter.recover.mockImplementation(async () => {
      events.push("adapter-recover");
      return workbenchJob("completed", 2) as never;
    });
    adapter.release.mockImplementation(async () => {
      events.push("adapter-release");
      return { jobId: "wb-job-1", restorationConfirmed: true, artifactRemoved: true };
    });
    const coordinator = new ObserverCoordinator({
      forkChild: fakeFork(child, { value: 0 }),
      workbenchAdapter: adapter as never,
    });
    await coordinator.runStatus(runId);
    expect(events).toEqual(["adapter-recover", "adapter-release"]);

    await expect(coordinator.releaseJob(undefined, "wb-job-1")).rejects.toMatchObject({
      code: "TRANSPORT_UNAVAILABLE",
    });
    expect(adapter.recover).toHaveBeenCalledOnce();
    expect(adapter.release).toHaveBeenCalledOnce();

    await expect(coordinator.releaseJob(undefined, "wb-job-1")).resolves.toMatchObject({
      backend: "workbench",
      jobId: "wb-job-1",
      managedArtifactReleased: true,
    });
    expect(events).toEqual(["adapter-recover", "adapter-release", "managed-1", "managed-2"]);
    expect(await coordinator.releaseJob(undefined, "wb-job-1")).toMatchObject({ managedArtifactReleased: true });
    expect(releaseAttempts).toBe(2);
    expect(adapter.release).toHaveBeenCalledOnce();
    await coordinator.close();
  });

  it.each(["finalize", "discard"] as const)(
    "%s consumes the run-level managed release proof without deleting or releasing twice",
    async (action) => {
      const runId = action === "finalize"
        ? "20260717T200130Z-c1d2e3f4"
        : "20260717T200140Z-d1e2f3a4";
      const capture = {
        captureLabel: "release-once",
        state: "completed",
        backend: "workbench",
        jobId: "wb-job-1",
        instanceId: "workbench-generation-1",
        worldId: "world-editor-1",
        worldEpoch: 0,
        artifactAvailable: true,
        missingArtifact: false,
      };
      const child = new FakeChild();
      child.responders.set("runStatus", () => ({
        runId,
        state: "open",
        captures: [{ ...capture }],
        warnings: [],
      }));
      let managedAvailable = true;
      child.responders.set("runFinalize", () => {
        managedAvailable = false;
        return {
          run: { runId, state: "finalized" },
          receipt: { runId, managedArtifactsReleased: true },
        };
      });
      child.responders.set("runDiscard", () => {
        managedAvailable = false;
        return { runId, discarded: true, releasedCaptureLabels: [capture.captureLabel] };
      });
      child.responders.set("inspectWorkbenchArtifact", () => ({
        available: managedAvailable,
        metadata: {},
      }));
      child.responders.set("releaseWorkbenchArtifact", () => {
        throw new Error("run cleanup already released this managed artifact");
      });

      const adapter = fakeWorkbenchAdapter();
      adapter.complete();
      const coordinator = new ObserverCoordinator({
        forkChild: fakeFork(child, { value: 0 }),
        workbenchAdapter: adapter as never,
      });

      const result = action === "finalize"
        ? await coordinator.finalizeRun({ runId, releaseManagedArtifacts: true })
        : await coordinator.discardRun(runId);

      expect(result).not.toHaveProperty("workbenchReleaseWarnings");
      expect(managedAvailable).toBe(false);
      expect(child.operations.filter((operation) => operation === "releaseWorkbenchArtifact")).toHaveLength(0);
      expect(adapter.recover).toHaveBeenCalledOnce();
      expect(adapter.release).toHaveBeenCalledOnce();

      await expect(coordinator.releaseJob(undefined, "wb-job-1")).resolves.toMatchObject({
        backend: "workbench",
        jobId: "wb-job-1",
        restorationConfirmed: true,
        artifactRemoved: true,
        managedArtifactReleased: true,
      });
      expect(adapter.recover).toHaveBeenCalledOnce();
      expect(adapter.release).toHaveBeenCalledOnce();
      expect(child.operations.filter((operation) => operation === "releaseWorkbenchArtifact")).toHaveLength(0);
      await coordinator.close();
    }
  );

  it("publishes a portable fixed-length capture schema without positional items or nested refs", async () => {
    const coordinator = {
      defaultCaptureTimeoutMs: 30_000,
      maxInlineImageBytes: 1_024,
      capture: vi.fn(),
    } as unknown as ObserverCoordinator;
    const server = new McpServer({ name: "observer-schema-test", version: "1.0.0" });
    registerObserverTools(server, coordinator);
    const client = new Client({ name: "observer-schema-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const capture = listed.tools.find((tool) => tool.name === "observer_capture");
      expect(capture).toBeDefined();

      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const entry of value) visit(entry);
          return;
        }
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if ("items" in record) expect(Array.isArray(record.items)).toBe(false);
        expect(record).not.toHaveProperty("$ref");
        for (const entry of Object.values(record)) visit(entry);
      };
      visit(capture!.inputSchema);

      const view = toolRegistry(coordinator).get("observer_capture")!.definition.inputSchema!.view;
      const captureSchema = toolRegistry(coordinator).get("observer_capture")!.definition.inputSchema!;
      expect(captureSchema.performancePolicy.safeParse("performance").success).toBe(false);
      expect(captureSchema.performancePolicy.safeParse("instrumented").success).toBe(true);
      expect(captureSchema.runId.safeParse("20260717T184233Z-a1b2c3d4").success).toBe(true);
      expect(view.safeParse({
        kind: "pose",
        position: [1, 2, 3],
        orientation: [0, 0, 0, 1],
        fov: 60,
      })).toMatchObject({ success: true, data: { position: [1, 2, 3], orientation: [0, 0, 0, 1] } });
      expect(view.safeParse({
        kind: "pose",
        position: [1, 2],
        orientation: [0, 0, 0, 1],
        fov: 60,
      }).success).toBe(false);
      expect(view.safeParse({
        kind: "pose",
        position: [1, 2, 3],
        orientation: [0, 0, 0, 2],
        fov: 60,
      }).success).toBe(false);
      expect(view.safeParse({
        kind: "lookAt",
        position: [1, 2, 3],
        target: [1, 2, 3],
        fov: 60,
      }).success).toBe(false);
      expect(view.safeParse({
        kind: "lookAt",
        position: [1, 2, 3],
        target: [4, 5, 6],
        fov: 60,
      }).success).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("accepts an inventory-null world for current-view capture through the public tool", async () => {
    const coordinator = {
      defaultCaptureTimeoutMs: 30_000,
      maxInlineImageBytes: 1_024,
      instances: vi.fn(async () => ({
        instances: [{
          instanceId: "runtime-null-world",
          sessionId: "session-1",
          worldId: null,
          worldEpoch: 7,
          capabilities: ["render.capture"],
        }],
        compatibleCount: 1,
        waitedMs: 0,
        timedOut: false,
      })),
      capture: vi.fn(async () => ({
        asynchronous: true,
        job: { jobId: "job-null-world", worldId: null, worldEpoch: 7, state: "queued" },
      })),
    } as unknown as ObserverCoordinator;
    const tools = toolRegistry(coordinator);
    const signal = new AbortController().signal;
    const inventory = await tools.get("observer_instances")!.handler({
      sessionId: "session-1",
      requiredCapabilities: ["render.capture"],
      renderersOnly: true,
      waitMs: 0,
    }, { signal });
    expect(inventory.isError).not.toBe(true);
    expect(inventory.content[0].text).toContain('"worldId": null');

    const expectedWorldId = tools.get("observer_capture")!.definition.inputSchema!.expectedWorldId;
    expect(expectedWorldId.safeParse(null).success).toBe(true);
    expect(expectedWorldId.safeParse(undefined).success).toBe(true);
    const capture = await tools.get("observer_capture")!.handler({
      runId: "20260717T184233Z-a1b2c3d4",
      captureLabel: "null-world-current",
      sessionId: "session-1",
      instanceId: "runtime-null-world",
      idempotencyKey: "null-world-current",
      view: { kind: "current" },
      asynchronous: true,
      timeoutMs: 30_000,
      settleFrames: 0,
      expectedWorldId: null,
      expectedWorldEpoch: 7,
      performancePolicy: "evidence",
    }, { signal });
    expect(capture.isError).not.toBe(true);
    expect(coordinator.capture).toHaveBeenCalledWith(expect.objectContaining({
      expectedWorldId: null,
      expectedWorldEpoch: 7,
      view: { kind: "current" },
    }));
  });

  it("formats one validated PNG image and one concise text metadata item", async () => {
    const coordinator = {
      defaultCaptureTimeoutMs: 30_000,
      maxInlineImageBytes: 1_024,
      capture: vi.fn(async () => ({
        asynchronous: false,
        image: png,
        job: {
          jobId: "job-1",
          instanceId: "instance-1",
          worldId: "world-1",
          worldEpoch: 4,
          artifact: { contaminated: false, warnings: [] },
        },
        metadata: {
          width: 1920,
          height: 1080,
          contentSha256: "a".repeat(64),
          completedAt: "2026-07-15T12:00:00.000Z",
          actualCamera: { position: [1, 2, 3] },
          contaminated: false,
          warnings: [],
        },
      })),
    } as unknown as ObserverCoordinator;
    const handler = toolRegistry(coordinator).get("observer_capture")!.handler;
    const result = await handler({
      sessionId: "session-1",
      view: { kind: "current" },
      asynchronous: false,
      timeoutMs: 30_000,
      settleFrames: 0,
      performancePolicy: "evidence",
    }, { signal: new AbortController().signal });

    expect(result.isError).not.toBe(true);
    expect(result.content).toHaveLength(2);
    expect(result.content.filter((item) => item.type === "image")).toHaveLength(1);
    expect(result.content.filter((item) => item.type === "text")).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    expect(result.content[1].text).toContain('"worldEpoch": 4');
    expect(result.content[1].text).toContain('"width": 1920');
  });

  it("refuses an image larger than the MCP inline limit", async () => {
    const coordinator = {
      defaultCaptureTimeoutMs: 30_000,
      maxInlineImageBytes: 8,
      capture: vi.fn(async () => ({
        asynchronous: false,
        image: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
        job: { jobId: "job-2" },
        metadata: {},
      })),
    } as unknown as ObserverCoordinator;
    const handler = toolRegistry(coordinator).get("observer_capture")!.handler;
    const result = await handler({
      sessionId: "session-1",
      view: { kind: "current" },
      asynchronous: false,
      timeoutMs: 30_000,
      settleFrames: 0,
      performancePolicy: "evidence",
    }, { signal: new AbortController().signal });

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("ARTIFACT_TOO_LARGE");
    expect(result.content[0].text).toContain('"jobId": "job-2"');
    expect(result.content.some((item) => item.type === "image")).toBe(false);
  });
});
