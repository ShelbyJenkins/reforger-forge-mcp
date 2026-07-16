import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess, fork } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ObserverCoordinator,
  ObserverCoordinatorError,
  redactChildLine,
} from "../../src/observer/coordinator.js";
import { registerObserverTools } from "../../src/observer/tools.js";
import { prepareObserverLaunch } from "../../src/observer/launch.js";
import { uninstallManagedObserver } from "../../observer/agent/private-child.js";
import { ObserverError } from "../../observer/agent/errors.js";

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

class FakeChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new PassThrough();
  readonly operations: string[] = [];
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
    const request = message as { requestId: string; operation: string };
    this.operations.push(request.operation);
    callback?.(null);
    if (request.operation === this.holdOperation) return true;
    queueMicrotask(() => {
      this.emit("message", {
        protocol: CHILD_PROTOCOL,
        type: "response",
        requestId: request.requestId,
        ok: true,
        result: request.operation === "instances" ? { instances: this.instances } : { operation: request.operation },
      });
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
  definition: { description?: string };
  handler: (input: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<{
    content: Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    isError?: boolean;
  }>;
}

function toolRegistry(coordinator: ObserverCoordinator): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, definition: RegisteredTool["definition"], handler: RegisteredTool["handler"]): void => {
      tools.set(name, { definition, handler });
    },
  } as unknown as McpServer;
  registerObserverTools(server, coordinator);
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
    submit: vi.fn(async () => {
      return workbenchJob(state) as never;
    }),
    status: vi.fn(async () => workbenchJob(state, 2) as never),
    cancel: vi.fn(async () => {
      state = "cancelled";
      return workbenchJob(state, 3) as never;
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

    await Promise.all([coordinator.ensureSetup(), coordinator.ensureSetup()]);
    await Promise.all([coordinator.status(), coordinator.doctor()]);

    expect(count.value).toBe(1);
    expect(child.operations.sort()).toEqual(["doctor", "stage", "stage", "status"]);
    await coordinator.close();
    expect(child.operations).toContain("shutdown");
    expect(child.killed).toBe(false);
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
        jobId: "wb-job-1",
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
    const coordinator = new ObserverCoordinator({ workbenchAdapter: adapter as never });
    const submitted = await coordinator.capture({
      idempotencyKey: "workbench-async-1",
      view: { kind: "current" },
      asynchronous: true,
      timeoutMs: 1_000,
    });
    expect(submitted).toMatchObject({ asynchronous: true, job: { backend: "workbench", jobId: "wb-job-1" } });

    expect(await coordinator.jobStatus(undefined, "wb-job-1")).toMatchObject({ state: "queued" });
    expect(await coordinator.cancelJob(undefined, "wb-job-1")).toMatchObject({ state: "cancelled" });
    const released = {
      backend: "workbench",
      jobId: "wb-job-1",
      restorationConfirmed: true,
      artifactRemoved: true,
    };
    expect(await coordinator.releaseJob(undefined, "wb-job-1")).toEqual(released);
    expect(await coordinator.releaseJob(undefined, "wb-job-1")).toEqual(released);
    expect(adapter.status).toHaveBeenCalledWith("wb-job-1");
    expect(adapter.cancel).toHaveBeenCalledWith("wb-job-1");
    expect(adapter.release).toHaveBeenCalledOnce();
    await coordinator.close();
  });

  it("deduplicates Workbench captures by a hashed public idempotency key and rejects conflicting reuse", async () => {
    const adapter = fakeWorkbenchAdapter();
    const coordinator = new ObserverCoordinator({ workbenchAdapter: adapter as never });
    const request = {
      idempotencyKey: "raw-user-key-must-not-become-a-job-path",
      view: { kind: "current" } as const,
      asynchronous: true,
      timeoutMs: 1_000,
    };

    const [first, retry] = await Promise.all([
      coordinator.capture(request),
      coordinator.capture(request),
    ]);

    expect(first).toMatchObject({ asynchronous: true, job: { jobId: "wb-job-1" } });
    expect(retry).toMatchObject({ asynchronous: true, job: { jobId: "wb-job-1" } });
    expect(adapter.submit).toHaveBeenCalledOnce();
    expect(adapter.submit).not.toHaveBeenCalledWith(expect.objectContaining({
      jobId: "raw-user-key-must-not-become-a-job-path",
    }));
    await expect(coordinator.capture({
      ...request,
      view: { kind: "lookAt", position: [0, 0, 0], target: [1, 0, 0], fov: 60 },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await coordinator.cancelJob(undefined, "wb-job-1");
    await coordinator.releaseJob(undefined, "wb-job-1");
    await expect(coordinator.capture(request)).rejects.toMatchObject({ code: "JOB_RELEASED" });
    expect(adapter.submit).toHaveBeenCalledOnce();
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

    expect(first).toMatchObject({ asynchronous: false, job: { jobId: "wb-job-1" } });
    expect(retry).toMatchObject({ asynchronous: false, job: { jobId: "wb-job-1" } });
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
    expect(runtimeOnly.instances).toEqual([runtime]);
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

    const result = await prepareObserverLaunch(coordinator, {
      runtimeKind: "client",
      arguments: [],
      profilePath: "C:/profiles/run-1",
      sessionTtlMs: 60_000,
      transportPreference: ["rest"],
      forceUpdate: false,
    });

    expect(result).toMatchObject({
      sessionId: "session-1",
      expiresAt: "2026-07-15T12:30:00.000Z",
      bundleDigest: "a".repeat(64),
      profilePath: "C:/profiles/run-1",
      warnings: [],
    });
    expect(result).not.toHaveProperty("launchNonce");
    expect(result).not.toHaveProperty("contractPath");
  });

  it("registers the five exact public tools", () => {
    const coordinator = { defaultCaptureTimeoutMs: 30_000, maxInlineImageBytes: 1_024 } as ObserverCoordinator;
    const tools = toolRegistry(coordinator);
    expect([...tools.keys()].sort()).toEqual([
      "observer_capture",
      "observer_instances",
      "observer_job",
      "observer_prepare_launch",
      "observer_setup",
    ]);
    for (const tool of tools.values()) expect(tool.definition.description?.length).toBeGreaterThan(40);
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
