import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChildProcess, fork } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createObserverApplication } from "../../src/observer/application.js";
import { ObserverApplicationError } from "../../src/observer/errors.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";
import { uninstallManagedObserver } from "../../observer/agent/private-child.js";
import { ObserverError } from "../../observer/agent/errors.js";
import {
  captureRequestFingerprint,
  type SubmitJobInput,
} from "../../observer/agent/jobs.js";
import { runtimeWorldRevision } from "../../src/observer/world-revision.js";
import {
  FakeChild,
  codedError,
  createChildBackedApplication,
  createChildHarness,
  createWorkbenchHarness,
  fakeWorkbenchAdapter,
  png,
  runtimeInstance,
  workbenchCaptureInput,
} from "./application-diagnostics-fixture.js";

describe("observer application", () => {
  it("preserves sessions and staging while a cancelled job still requires restoration", () => {
    const cancel = vi.fn();
    const revoke = vi.fn();
    const cleanup = vi.fn();
    const activeJob = { sessionId: "session-1", jobId: "job-1", state: "restoring",
      cameraLease: { held: true, restorationConfirmed: false } };
    const agent = {
      jobs: { diagnostics: vi.fn(() => [activeJob]), cancel },
      control: { revokeSession: revoke, cleanupStaged: cleanup },
    };

    expect(() => uninstallManagedObserver(agent as never)).toThrowError(
      expect.objectContaining<Partial<ObserverError>>({ code: "CAMERA_BUSY" })
    );
    expect(cancel).toHaveBeenCalledWith("session-1", "job-1");
    expect(revoke).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("always passes the confined platform-default roots to its private child", async () => {
    const child = new FakeChild();
    const managedRoot = resolve(process.cwd(), "..", ".observer-default-test");
    let forkArguments: readonly string[] = [];
    const forkChild = ((_modulePath: string, argumentsArray?: readonly string[]) => {
      forkArguments = argumentsArray ?? [];
      child.announceReady();
      return child as unknown as ChildProcess;
    }) as typeof fork;
    const coordinator = createObserverApplication({ defaultManagedRoot: managedRoot,
      agentPath: "private-child.js", forkChild, startupTimeoutMs: 1_000, requestTimeoutMs: 1_000 });

    await coordinator.ensureSetup();

    expect(forkArguments).toEqual(expect.arrayContaining([
      "--root", managedRoot,
      "--profile-root", join(managedRoot, "profiles"),
    ]));
    await coordinator.close();
  });

  it("deduplicates concurrent lazy startup and requests graceful child shutdown", async () => {
    const { child, forkCount: count, coordinator } = createChildHarness();

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

  it("reattaches a completed runtime capture when a replacement child no longer retains its job", async () => {
    const child = new FakeChild();
    const runId = "20260726T022925Z-d7867722";
    const capture = {
      captureLabel: "opzo-runtime-proof",
      state: "completed",
      backend: "runtime",
      sessionId: "runtime-session-1",
      jobId: "runtime-job-1",
      instanceId: "runtime-instance-1",
      worldId: "opzo-world",
      worldEpoch: 4,
      artifactAvailable: true,
      missingArtifact: false,
    };
    child.responders.set("runStatus", () => ({
      runId,
      state: "open",
      captures: [capture],
    }));
    child.responders.set("jobStatus", () => {
      throw codedError("JOB_NOT_FOUND", "terminal runtime job is no longer retained");
    });
    const coordinator = createChildBackedApplication(child);

    await expect(coordinator.runStatus(runId)).resolves.toMatchObject({
      runId,
      captures: [expect.objectContaining({ state: "completed", artifactAvailable: true })],
    });
    await expect(coordinator.jobStatus(capture.jobId)).resolves.toMatchObject({
      state: "completed",
      managedArtifactAvailable: true,
      recoveredFromManagedArtifact: true,
    });
    await coordinator.close();
  });

  it("maps run-convergence failures through the public observer error boundary", async () => {
    const child = new FakeChild();
    const runId = "20260726T022925Z-d7867722";
    child.responders.set("runStatus", () => ({
      runId,
      state: "open",
      captures: [{
        captureLabel: "opzo-runtime-proof",
        state: "completed",
        backend: "runtime",
        sessionId: "runtime-session-1",
        jobId: "runtime-job-1",
        instanceId: "runtime-instance-1",
        worldId: "opzo-world",
        worldEpoch: 4,
        artifactAvailable: true,
        missingArtifact: false,
      }],
    }));
    child.responders.set("jobStatus", () => {
      throw codedError("ARTIFACT_INVALID", "retained capture no longer verifies");
    });
    const coordinator = createChildBackedApplication(child);

    await expect(coordinator.runStatus(runId)).rejects.toEqual(
      expect.objectContaining<Partial<ObserverApplicationError>>({
        name: "ObserverApplicationError",
        code: "ARTIFACT_INVALID",
      }),
    );
    await coordinator.close();
  });

  it("preserves a reservation-free exact-vacancy stop preflight from the private child", async () => {
    const child = new FakeChild();
    child.responders.set("runtimeStopPreflight", () => ({
      sessionKnown: true,
      ready: true,
      reserved: false,
      reservationRequired: false,
      activeJobIds: [],
      cameraLeaseJobIds: [],
      restorationPendingJobIds: [],
      reason: "exact_runtime_vacancy_has_no_retained_lifecycle",
    }));
    const coordinator = createChildBackedApplication(child);
    try {
      await expect(coordinator.reserveRuntimeStop(
        "session-direct-exit",
        "00000000-0000-4000-8000-000000000001",
        true,
        {
          runtimeId: "rt-00000000-0000-4000-8000-000000000002",
          generation: "a".repeat(64),
        }
      )).resolves.toMatchObject({
        sessionKnown: true,
        ready: true,
        reserved: false,
        reservationRequired: false,
      });
    } finally {
      await coordinator.close();
    }
  });

  it("keeps a timed-out private child counted until its actual exit", async () => {
    const { child, coordinator } = createChildHarness();
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
    const { child, forkCount: count, coordinator } = createChildHarness({ requestTimeoutMs: 10_000 });
    await coordinator.ensureSetup();
    child.holdOperation = "status";
    const status = coordinator.status();
    await vi.waitFor(() => expect(child.operations).toContain("status"));
    child.exit(17);
    await expect(status).rejects.toEqual(expect.objectContaining<Partial<ObserverApplicationError>>({
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

  it("keeps idle status and doctor strictly read-only without forking or creating managed roots", async () => withTemporaryDirectory(async (parent) => {
    const managedRoot = join(parent, "managed-root-must-not-be-created");
    const { forkCount: count, coordinator } = createChildHarness({ managedRoot });

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
        imageOutput: {
          defaultFormat: "png",
          defaultLossyQuality: 75,
          minimumLossyQuality: 1,
          maximumLossyQuality: 100,
          inlineResponseMaxBytes: 8 * 1024 * 1024,
        },
      });
      expect(doctor).toMatchObject({
        readOnly: true,
        mutationPerformed: false,
        diagnostic: "doctor",
        agentState: "idle",
        running: false,
        profileRoot: join(managedRoot, "profiles"),
      });
      expect(count.value).toBe(0);
      expect(existsSync(managedRoot)).toBe(false);
      await coordinator.close();
      expect(count.value).toBe(0);
      expect(existsSync(managedRoot)).toBe(false);
    } finally {
      await coordinator.close();
    }
  }, { prefix: "rfo-idle-diagnostics-" }));

  it("returns a host-validated Workbench PNG without starting the private runtime child", async () => {
    const count = { value: 0 };
    const { adapter, coordinator } = createWorkbenchHarness(
      fakeWorkbenchAdapter(), new FakeChild(), { pollIntervalMs: 10 }, count,
    );
    adapter.complete();

    const result = await coordinator.capture(workbenchCaptureInput("workbench-current-1"));

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
    const { adapter, coordinator } = createWorkbenchHarness();
    await coordinator.ensureSetup();
    const submitted = await coordinator.capture(workbenchCaptureInput("workbench-async-1", {
      asynchronous: true,
    }));
    expect(submitted).toMatchObject({ asynchronous: true, job: { backend: "workbench" } });
    const jobId = submitted.job.jobId as string;
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);

    expect(await coordinator.jobStatus(jobId)).toMatchObject({ state: "queued" });
    expect(await coordinator.cancelJob(jobId)).toMatchObject({ state: "cancelled" });
    const released = {
      backend: "workbench",
      jobId,
      restorationConfirmed: true,
      artifactRemoved: true,
    };
    expect(await coordinator.releaseJob(jobId)).toMatchObject(released);
    expect(await coordinator.releaseJob(jobId)).toMatchObject(released);
    expect(adapter.recover).toHaveBeenCalledWith({ jobId, expectedInstanceId: "workbench-generation-1" });
    expect(adapter.cancel).toHaveBeenCalledWith(jobId);
    expect(adapter.release).toHaveBeenCalledOnce();
    await coordinator.close();
  });

  it("deduplicates Workbench captures by a hashed public idempotency key and rejects conflicting reuse", async () => {
    const { adapter, coordinator } = createWorkbenchHarness();
    await coordinator.ensureSetup();
    const request = workbenchCaptureInput("raw-user-key-must-not-become-a-job-path", {
      asynchronous: true,
    });

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
    await coordinator.cancelJob(jobId);
    await coordinator.releaseJob(jobId);
    await expect(coordinator.capture(request)).rejects.toMatchObject({ code: "JOB_RELEASED" });
    expect(adapter.submit).toHaveBeenCalledOnce();
    await coordinator.close();
  });

  it("replays runtime capture without extending its original wall-clock deadline", async () => {
    const child = new FakeChild();
    child.instances = [runtimeInstance()];
    let retainedFingerprint: string | null = null;
    const submittedPayloads: Record<string, unknown>[] = [];
    child.responders.set("submitJob", (payload) => {
      submittedPayloads.push(payload);
      const fingerprint = captureRequestFingerprint(payload as unknown as SubmitJobInput);
      if (retainedFingerprint !== null && retainedFingerprint !== fingerprint) {
        throw codedError("IDEMPOTENCY_CONFLICT", "runtime idempotency conflict");
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
    const coordinator = createChildBackedApplication(child);
    await coordinator.ensureSetup();
    const request = { sessionId: "runtime-session-1", idempotencyKey: "runtime-relative-deadline",
      view: { kind: "current" } as const, asynchronous: true, timeoutMs: 1_000,
      expectedWorldRevision: runtimeWorldRevision(null, 0) };

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

  it("returns a released-job receipt when a delivered runless capture is retried", async () => {
    const { adapter, coordinator } = createWorkbenchHarness();
    adapter.complete();
    const request = workbenchCaptureInput("sync-retry-key");

    const first = await coordinator.capture(request);
    expect(first).toMatchObject({ asynchronous: false, job: { jobId: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
    await expect(coordinator.capture(request)).rejects.toMatchObject({ code: "JOB_RELEASED" });
    expect(adapter.submit).toHaveBeenCalledOnce();
    expect(adapter.readCompletedArtifact).toHaveBeenCalledOnce();
    await coordinator.close();
  });

  it("merges Workbench with session-scoped runtime inventory and degrades handler absence to a warning", async () => {
    const runtime = runtimeInstance({ instanceId: "runtime-1", backend: "runtime", sessionId: "session-1" });
    const healthyChild = new FakeChild();
    healthyChild.instances = [runtime];
    const { coordinator: healthy } = createWorkbenchHarness(fakeWorkbenchAdapter(), healthyChild);

    const merged = await healthy.instances({ sessionId: "session-1", renderersOnly: true });
    expect(merged.instances.map((instance) => instance.backend)).toEqual(["runtime", "workbench"]);
    expect(merged.instances[1]).toMatchObject({ selectedTransport: "workbench-netapi" });
    expect(merged.compatibleCount).toBe(2);
    await healthy.close();

    const unavailableChild = new FakeChild();
    unavailableChild.instances = [runtime];
    const { coordinator: unavailable } = createWorkbenchHarness(
      fakeWorkbenchAdapter({ unavailable: true }), unavailableChild);
    const runtimeOnly = await unavailable.instances({ sessionId: "session-1" });
    expect(runtimeOnly.instances).toEqual([expect.objectContaining(runtime)]);
    expect(runtimeOnly.warnings?.[0]).toContain("observer handler is not installed");
    await unavailable.close();
  });
});
