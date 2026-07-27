import { describe, expect, it } from "vitest";
import { JobStore, type JobRecord, type JobStoreOptions } from "../../observer/agent/jobs.js";
import { InstanceRegistry } from "../../observer/agent/registry.js";
import { COMMAND_DELIVERY_LEASE_MS, type ArtifactManifest, type CameraLeaseStatus } from "../../observer/protocol/index.js";
import { deadlineAfter } from "../../src/foundation/time.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";
import { createObserverSessionFixture, graphicalRegistration } from "../support/observer-fixtures.js";
import { ManualTime } from "../support/manual-time.js";
import { waitForValue } from "../support/wait.js";

function setup(
  root: string,
  jobOptions: JobStoreOptions = {},
  registrationOverrides: NonNullable<Parameters<typeof graphicalRegistration>[1]> = {}
) {
  const clock = new ManualTime();
  const fixture = createObserverSessionFixture({ root, clock });
  const registry = new InstanceRegistry(fixture.store, { clock });
  const registration = graphicalRegistration(fixture.created, registrationOverrides);
  registry.register(registration, fixture.created.contract.sessionToken);
  const jobs = new JobStore(fixture.store, registry, clock, jobOptions);
  return { ...fixture, registry, registration, jobs, clock };
}

function scopedIt(
  name: string,
  run: (root: string) => Promise<void> | void,
): void {
  it(name, () => withTemporaryDirectory(run, { prefix: "rfo-jobs-" }));
}

const noCamera = (): CameraLeaseStatus => ({ held: false, restorationConfirmed: false });
const heldCamera = (): CameraLeaseStatus => ({ held: true, leaseId: "lease-1", observerCameraId: 42 });
const restoredCamera = (): CameraLeaseStatus => ({ held: false, restorationConfirmed: true });

function status(
  setupValue: ReturnType<typeof setup>,
  jobId: string,
  sequence: number,
  state: string,
  extra: Record<string, unknown> = {}
) {
  return {
    protocolVersion: "1.0",
    sessionId: setupValue.registration.sessionId,
    instanceId: setupValue.registration.instanceId,
    instanceNonce: setupValue.registration.instanceNonce,
    jobId,
    sequence,
    state,
    worldId: setupValue.registration.worldId,
    worldEpoch: setupValue.registration.worldEpoch,
    timestamp: new Date(setupValue.clock.now()).toISOString(),
    cameraLease: noCamera(),
    ...extra,
  };
}

function submitCurrent(value: ReturnType<typeof setup>, idempotencyKey = "capture-current") {
  return value.jobs.submit({
    sessionId: value.registration.sessionId,
    idempotencyKey,
    deadlineAt: new Date(value.clock.now() + 30_000).toISOString(),
    view: { kind: "current" },
  });
}

function submitCamera(value: ReturnType<typeof setup>, idempotencyKey = "capture-camera") {
  return value.jobs.submit({
    sessionId: value.registration.sessionId,
    idempotencyKey,
    deadlineAt: new Date(value.clock.now() + 30_000).toISOString(),
    view: { kind: "lookAt", position: [0, 1, 0], target: [1, 1, 0], fov: 60 },
  });
}

function dispatch(value: ReturnType<typeof setup>, job: JobRecord) {
  const command = value.jobs.nextCommand(
    value.registration.sessionId,
    value.registration.instanceId,
    value.registration.instanceNonce
  );
  expect(command).toMatchObject({ commandKind: "capture", jobId: job.request.jobId, deliveryAttempt: 1 });
  return command!;
}

function accept(value: ReturnType<typeof setup>, job: JobRecord, sequence = 1) {
  const command = dispatch(value, job);
  value.jobs.update(status(value, job.request.jobId, sequence, "accepted", {
    deliveryToken: command.deliveryToken,
  }), value.created.contract.sessionToken);
  return command;
}

function manifest(value: ReturnType<typeof setup>, job: JobRecord, artifactId = "artifact-1"): ArtifactManifest {
  const timestamp = new Date(value.clock.now()).toISOString();
  return {
    protocolVersion: "1.0",
    sessionId: value.registration.sessionId,
    instanceId: value.registration.instanceId,
    instanceNonce: value.registration.instanceNonce,
    jobId: job.request.jobId,
    artifactId,
    relativeScreenshotFilename: `${job.request.jobId}.png`,
    screenshotIssuedAt: timestamp,
    completedAt: timestamp,
    worldId: value.registration.worldId,
    worldEpoch: value.registration.worldEpoch,
    actualCamera: job.request.view.kind === "current" ? {} : { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    ...(job.request.view.kind !== "current" ? { actualFov: job.request.view.fov } : {}),
    requestedSettleFrames: job.request.settleFrames,
    actualSettleFrames: job.request.settleFrames,
    contaminated: false,
    warnings: [],
  };
}

describe("observer jobs", () => {
  scopedIt("classifies an absent or session-mismatched job as JOB_NOT_FOUND", (root) => {
    const value = setup(root);
    expect(() => value.jobs.require(value.registration.sessionId, "missing-job"))
      .toThrowError(expect.objectContaining({ code: "JOB_NOT_FOUND", httpStatus: 404 }));

    const job = submitCurrent(value);
    expect(() => value.jobs.require("different-session", job.request.jobId))
      .toThrowError(expect.objectContaining({ code: "JOB_NOT_FOUND", httpStatus: 404 }));
  });

  scopedIt("returns the original job for one session idempotency key", async (root) => {
    const value = setup(root);
    const input = {
      sessionId: value.registration.sessionId,
      idempotencyKey: "capture-1",
      deadlineAt: new Date(value.clock.now() + 10_000).toISOString(),
      view: { kind: "current" as const },
    };
    expect(value.jobs.submit(input)).toBe(value.jobs.submit(input));
    expect(value.jobs.diagnostics()).toHaveLength(1);

    let ready = false;
    const pending = waitForValue({
      clock: value.clock,
      sleeper: value.clock,
      deadline: deadlineAfter(value.clock, 100),
      intervalMs: 10,
      probe: () => ready ? "ready" : undefined,
    });
    await Promise.resolve();
    expect(value.clock.pendingSleepCount).toBe(1);
    ready = true;
    await value.clock.runNextSleep();
    await expect(pending).resolves.toEqual({ kind: "value", value: "ready" });
  });

  scopedIt("replays equivalent canonical capture requests", (root) => {
    const value = setup(root);
    const first = value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "canonical-replay",
      deadlineAt: "2026-07-16T20:01:00.000Z",
      view: { kind: "pose", position: [-0, 1, 2], orientation: [0, 0, 0, 1], fov: 60 },
    });
    const replay = value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "canonical-replay",
      deadlineAt: "2026-07-16T13:01:00-07:00",
      view: { kind: "pose", position: [0, 1, 2], orientation: [-0, 0, 0, 1], fov: 60 },
      settleFrames: 0,
      performancePolicy: "evidence",
    });
    expect(replay).toBe(first);
    expect(value.jobs.stats()).toMatchObject({ jobs: 1, idempotencyReceipts: 1 });
  });

  scopedIt("replays a policy-derived deadline and conflicts when its timeout policy changes", (root) => {
    const value = setup(root);
    const first = value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "relative-deadline-replay",
      deadlineAt: new Date(value.clock.now() + 10_000).toISOString(),
      deadlinePolicyMs: 10_000,
      view: { kind: "current" },
    });
    const replay = value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "relative-deadline-replay",
      deadlineAt: new Date(value.clock.now() + 10_025).toISOString(),
      deadlinePolicyMs: 10_000,
      view: { kind: "current" },
    });

    expect(replay).toBe(first);
    expect(() => value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "relative-deadline-replay",
      deadlineAt: new Date(value.clock.now() + 20_000).toISOString(),
      deadlinePolicyMs: 20_000,
      view: { kind: "current" },
    })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
  });

  it.each([
    ["instance", { instanceId: "instance-2" }],
    ["deadline", { deadlineAt: "2026-07-16T20:01:00.001Z" }],
    ["view", { view: { kind: "lookAt" as const, position: [0, 1, 0] as [number, number, number], target: [1, 1, 0] as [number, number, number], fov: 60 } }],
    ["settle policy", { settleFrames: 1 }],
    ["performance policy", { performancePolicy: "instrumented" as const }],
    ["nullable world expectation", { expectedWorldId: null }],
    ["world epoch", { expectedWorldEpoch: 1 }],
  ])("rejects idempotency-key reuse after changing %s", (_label, changed) => withTemporaryDirectory((root) => {
    const value = setup(root);
    const base = {
      sessionId: value.registration.sessionId,
      idempotencyKey: "semantic-conflict",
      deadlineAt: "2026-07-16T20:01:00.000Z",
      view: { kind: "current" as const },
    };
    value.jobs.submit(base);
    expect(() => value.jobs.submit({ ...base, ...changed }))
      .toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(value.jobs.stats()).toMatchObject({ jobs: 1, idempotencyReceipts: 1 });
  }, { prefix: "rfo-jobs-" }));

  scopedIt("allows a key to name a new request after its bounded receipt expires", (root) => {
    const value = setup(root, { idempotencyReceiptRetentionMs: 100 });
    const first = value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "expired-receipt",
      deadlineAt: new Date(value.clock.now() + 1_000).toISOString(),
      view: { kind: "current" },
    });
    value.clock.advance(1_101);
    const second = value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "expired-receipt",
      deadlineAt: new Date(value.clock.now() + 1_000).toISOString(),
      view: { kind: "current" },
      settleFrames: 1,
    });
    expect(second.request.jobId).not.toBe(first.request.jobId);
    expect(value.jobs.stats()).toMatchObject({ jobs: 2, idempotencyReceipts: 1 });
  });

  scopedIt("fails closed before exceeding the retained-record budget", (root) => {
    const value = setup(root, { maxRecords: 1 });
    submitCurrent(value, "bounded-record-1");

    expect(() => submitCurrent(value, "bounded-record-2"))
      .toThrowError(expect.objectContaining({ code: "TRANSPORT_UNAVAILABLE" }));
    expect(value.jobs.stats()).toMatchObject({
      jobs: 1,
      idempotencyReceipts: 1,
      pendingQueueEntries: 1,
      maxRecords: 1,
    });
  });

  scopedIt("fails closed without partial insertion when the byte budget is exhausted", (root) => {
    const value = setup(root, { maxEstimatedBytes: 1_024 });

    expect(() => submitCamera(value, "bounded-byte-budget"))
      .toThrowError(expect.objectContaining({ code: "TRANSPORT_UNAVAILABLE" }));
    expect(value.jobs.stats()).toMatchObject({
      jobs: 0,
      idempotencyReceipts: 0,
      pendingQueueEntries: 0,
      maxEstimatedBytes: 1_024,
    });
  });

  scopedIt("rejects an oversized mutable job record without partially completing it", (root) => {
    const value = setup(root, {
      maxEstimatedBytes: 64 * 1024,
      maxRecordEstimatedBytes: 2 * 1024,
    });
    const job = submitCurrent(value, "bounded-record-mutation");
    accept(value, job);
    value.jobs.update(status(value, job.request.jobId, 2, "capturing"), value.created.contract.sessionToken);
    value.jobs.update(status(value, job.request.jobId, 3, "awaitingArtifact"), value.created.contract.sessionToken);
    const oversized = {
      ...manifest(value, job),
      forwardCompatibleDiagnostic: "x".repeat(4 * 1024),
    } as ArtifactManifest;

    expect(() => value.jobs.completeArtifact(
      value.registration.sessionId,
      job.request.jobId,
      oversized,
      "C:\\managed\\artifact.png"
    )).toThrowError(expect.objectContaining({ code: "TRANSPORT_UNAVAILABLE" }));
    expect(job).toMatchObject({ state: "awaitingArtifact", artifact: null, artifactPath: null });
    expect(value.jobs.stats().approximateBytes).toBeLessThanOrEqual(64 * 1024);
  });

  scopedIt("rejects a stale expected world before queueing camera work", (root) => {
    const value = setup(root);
    const base = {
      sessionId: value.registration.sessionId,
      deadlineAt: new Date(value.clock.now() + 10_000).toISOString(),
      view: { kind: "current" as const },
    };
    expect(() => value.jobs.submit({
      ...base,
      idempotencyKey: "wrong-world-id",
      expectedWorldId: "world-2",
      expectedWorldEpoch: value.registration.worldEpoch,
    })).toThrowError(expect.objectContaining({ code: "WORLD_CHANGED" }));
    expect(() => value.jobs.submit({
      ...base,
      idempotencyKey: "wrong-world-epoch",
      expectedWorldId: value.registration.worldId,
      expectedWorldEpoch: value.registration.worldEpoch + 1,
    })).toThrowError(expect.objectContaining({ code: "WORLD_CHANGED" }));
    expect(value.jobs.diagnostics()).toHaveLength(0);
  });

  scopedIt("captures the current view when inventory explicitly reports no world", (root) => {
    const value = setup(root, {}, { worldId: null, worldEpoch: 7 });
    const job = value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "null-world-current",
      deadlineAt: new Date(value.clock.now() + 10_000).toISOString(),
      view: { kind: "current" },
      expectedWorldId: null,
      expectedWorldEpoch: 7,
    });
    expect(job).toMatchObject({ worldId: null, worldEpoch: 7, state: "queued" });
  });

  scopedIt("emits a canonical decimal-string wire view for Enforce float decoding", (root) => {
    const value = setup(root);
    const job = value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "pose-wire-view",
      deadlineAt: new Date(value.clock.now() + 30_000).toISOString(),
      view: {
        kind: "pose",
        position: [2435.79, 33.4687, 5509.35],
        orientation: [0, 0, 0, 1],
        fov: 65,
      },
    });
    expect(dispatch(value, job).wireView).toEqual({
      position: ["2435.79", "33.4687", "5509.35"],
      orientation: ["0", "0", "0", "1"],
      target: [],
      fov: "65",
    });
  });

  scopedIt("redelivers an unacknowledged capture with a stable acknowledgement token and renewed lease", (root) => {
    const value = setup(root);
    const job = submitCurrent(value);
    const first = dispatch(value, job);
    const lostResponseRetry = value.jobs.nextCommand(value.registration.sessionId, value.registration.instanceId, value.registration.instanceNonce)!;
    expect(lostResponseRetry).toEqual(first);
    expect(job.state).toBe("dispatched");

    value.clock.advance(COMMAND_DELIVERY_LEASE_MS + 1);
    const nextLease = value.jobs.nextCommand(value.registration.sessionId, value.registration.instanceId, value.registration.instanceNonce)!;
    expect(nextLease).toMatchObject({ jobId: job.request.jobId, deliveryAttempt: 2 });
    expect(nextLease.deliveryToken).toBe(first.deliveryToken);
    value.jobs.update(status(value, job.request.jobId, 1, "accepted", {
      deliveryToken: first.deliveryToken,
    }), value.created.contract.sessionToken);
    expect(job.state).toBe("accepted");
  });

  scopedIt("keeps exactly one capture in flight per renderer", (root) => {
    const value = setup(root);
    const first = submitCurrent(value, "first");
    const second = submitCurrent(value, "second");
    const command = accept(value, first);
    expect(command.jobId).toBe(first.request.jobId);
    expect(value.jobs.nextCommand(value.registration.sessionId, value.registration.instanceId, value.registration.instanceNonce)).toBeNull();

    value.jobs.update(status(value, first.request.jobId, 2, "failed", {
      errorCode: "CAPTURE_REJECTED",
    }), value.created.contract.sessionToken);
    expect(value.jobs.nextCommand(value.registration.sessionId, value.registration.instanceId, value.registration.instanceNonce)).toMatchObject({
      jobId: second.request.jobId,
      commandKind: "capture",
    });
  });

  scopedIt("delivers cancellation explicitly after dispatch and acknowledges its token", (root) => {
    const value = setup(root);
    const job = submitCurrent(value);
    accept(value, job);
    value.jobs.cancel(value.registration.sessionId, job.request.jobId);
    expect(job.state).toBe("accepted");

    const cancellation = value.jobs.nextCommand(value.registration.sessionId, value.registration.instanceId, value.registration.instanceNonce)!;
    expect(cancellation).toMatchObject({
      commandKind: "cancel",
      jobId: job.request.jobId,
      deliveryAttempt: 1,
      cancellationRequestedAt: expect.any(String),
    });
    expect(value.jobs.nextCommand(value.registration.sessionId, value.registration.instanceId, value.registration.instanceNonce)).toEqual(cancellation);
    value.jobs.update(status(value, job.request.jobId, 2, "cancelled", {
      deliveryToken: cancellation.deliveryToken,
    }), value.created.contract.sessionToken);
    expect(job.state).toBe("cancelled");
    expect(value.jobs.diagnostics()).toMatchObject([{ cancellationDeliveryAcknowledged: true }]);
  });

  scopedIt("uses the explicit transition graph and rejects illegal jumps", (root) => {
    const value = setup(root);
    const job = submitCurrent(value);
    const command = dispatch(value, job);
    expect(() => value.jobs.update(status(value, job.request.jobId, 1, "capturing", {
      deliveryToken: command.deliveryToken,
    }), value.created.contract.sessionToken)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    value.jobs.update(status(value, job.request.jobId, 1, "accepted", {
      deliveryToken: command.deliveryToken,
    }), value.created.contract.sessionToken);
    expect(() => value.jobs.update(status(value, job.request.jobId, 2, "awaitingArtifact"), value.created.contract.sessionToken))
      .toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    value.jobs.update(status(value, job.request.jobId, 2, "capturing"), value.created.contract.sessionToken);
    value.jobs.update(status(value, job.request.jobId, 3, "failed", { errorCode: "CAPTURE_REJECTED" }), value.created.contract.sessionToken);
    expect(() => value.jobs.update(status(value, job.request.jobId, 4, "failed", { errorCode: "CAPTURE_REJECTED" }), value.created.contract.sessionToken))
      .toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  scopedIt("allows acquisition failure without a lease but requires confirmed restoration after one was held", (root) => {
    const value = setup(root);
    const acquisitionFailure = submitCamera(value, "acquisition-failure");
    accept(value, acquisitionFailure);
    value.jobs.update(status(value, acquisitionFailure.request.jobId, 2, "acquiringCamera"), value.created.contract.sessionToken);
    value.jobs.update(status(value, acquisitionFailure.request.jobId, 3, "failed", {
      errorCode: "CAMERA_BUSY",
    }), value.created.contract.sessionToken);
    expect(acquisitionFailure.state).toBe("failed");
    expect(acquisitionFailure.cameraWasAcquired).toBe(false);

    const held = submitCamera(value, "held-camera");
    accept(value, held);
    value.jobs.update(status(value, held.request.jobId, 2, "acquiringCamera", {
      cameraLease: heldCamera(),
    }), value.created.contract.sessionToken);
    expect(() => value.jobs.update(status(value, held.request.jobId, 3, "failed", {
      errorCode: "CAMERA_BUSY",
      cameraLease: heldCamera(),
    }), value.created.contract.sessionToken)).toThrowError(expect.objectContaining({ code: "CAMERA_BUSY" }));
    value.jobs.update(status(value, held.request.jobId, 3, "restoring", {
      cameraLease: restoredCamera(),
    }), value.created.contract.sessionToken);
    value.jobs.update(status(value, held.request.jobId, 4, "failed", {
      errorCode: "CAMERA_BUSY",
      cameraLease: restoredCamera(),
    }), value.created.contract.sessionToken);
    expect(held).toMatchObject({
      state: "failed",
      cameraWasAcquired: true,
      cameraLease: { held: false, restorationConfirmed: true, leaseId: "lease-1", observerCameraId: 42 },
    });
  });

  scopedIt("accepts a pre-acquisition camera-capability refusal without pinning restoration", (root) => {
    const value = setup(root);
    const rejected = submitCamera(value, "detached-camera-rejected");
    const command = dispatch(value, rejected);
    value.jobs.update(status(value, rejected.request.jobId, 1, "failed", {
      deliveryToken: command.deliveryToken,
      errorCode: "CAPABILITY_UNAVAILABLE",
      message: "Explicit pose/lookAt requires a CameraManager-owned current camera; current capture remains available reason=detached_player_camera_unsupported",
    }), value.created.contract.sessionToken);

    expect(rejected).toMatchObject({
      state: "failed",
      terminalErrorCode: "CAPABILITY_UNAVAILABLE",
      cameraWasAcquired: false,
      cameraLease: { everHeld: false, held: false, restorationConfirmed: false },
    });
    expect(value.jobs.stats()).toMatchObject({ restorationObligations: 0 });

    const successor = submitCurrent(value, "current-after-detached-rejection");
    expect(value.jobs.nextCommand(
      value.registration.sessionId,
      value.registration.instanceId,
      value.registration.instanceNonce
    )).toMatchObject({ jobId: successor.request.jobId, commandKind: "capture" });
  });

  scopedIt("pins an unresolved restoration obligation past normal terminal retention", (root) => {
    const value = setup(root, { terminalJobRetentionMs: 1, idempotencyReceiptRetentionMs: 1 });
    const job = submitCamera(value, "restoration-unconfirmed");
    accept(value, job);
    value.jobs.update(status(value, job.request.jobId, 2, "acquiringCamera", {
      cameraLease: heldCamera(),
    }), value.created.contract.sessionToken);
    value.jobs.update(status(value, job.request.jobId, 3, "restoring", {
      cameraLease: { held: false, restorationConfirmed: false },
    }), value.created.contract.sessionToken);
    value.jobs.update(status(value, job.request.jobId, 4, "failed", {
      errorCode: "RESTORATION_UNCONFIRMED",
      cameraLease: { held: false, restorationConfirmed: false },
    }), value.created.contract.sessionToken);
    expect(job).toMatchObject({
      state: "failed",
      terminalErrorCode: "RESTORATION_UNCONFIRMED",
      cameraLease: { everHeld: true, held: false, restorationConfirmed: false },
    });
    value.clock.advance(30_002);
    value.jobs.sweep(value.clock.now());
    expect(value.jobs.require(value.registration.sessionId, job.request.jobId)).toBe(job);
    expect(value.jobs.stats()).toMatchObject({ jobs: 1, restorationObligations: 1 });
    expect(value.jobs.sessionPins()).toContain(value.registration.sessionId);
  });

  scopedIt("does not dispatch a queued successor past terminal unconfirmed restoration", (root) => {
    const value = setup(root);
    const first = submitCamera(value, "unconfirmed-first");
    accept(value, first);
    value.jobs.update(status(value, first.request.jobId, 2, "acquiringCamera", {
      cameraLease: heldCamera(),
    }), value.created.contract.sessionToken);
    const successor = submitCamera(value, "unconfirmed-successor");
    value.jobs.update(status(value, first.request.jobId, 3, "restoring", {
      cameraLease: { held: false, restorationConfirmed: false },
    }), value.created.contract.sessionToken);
    value.jobs.update(status(value, first.request.jobId, 4, "failed", {
      errorCode: "RESTORATION_UNCONFIRMED",
      cameraLease: { held: false, restorationConfirmed: false },
    }), value.created.contract.sessionToken);

    expect(first).toMatchObject({
      state: "failed",
      terminalErrorCode: "RESTORATION_UNCONFIRMED",
      cameraLease: { everHeld: true, restorationConfirmed: false },
    });
    expect(successor.state).toBe("queued");
    expect(value.jobs.nextCommand(
      value.registration.sessionId,
      value.registration.instanceId,
      value.registration.instanceNonce
    )).toBeNull();
  });

  scopedIt("terminalizes an accepted current-view job when its deadline expires", (root) => {
    const value = setup(root, { terminalJobRetentionMs: 1, idempotencyReceiptRetentionMs: 1 });
    const job = submitCurrent(value, "expired-current-view");
    accept(value, job);
    value.clock.advance(30_001);

    expect(value.jobs.sweepDeadlines(value.clock.now())).toEqual([job.request.jobId]);
    expect(job).toMatchObject({ state: "failed", terminalErrorCode: "CAPTURE_TIMEOUT" });
    value.clock.advance(2);
    expect(value.jobs.sweep(value.clock.now()).removedJobs).toContain(job.request.jobId);
  });

  scopedIt("disposes unresolved work only after the host proves exact runtime vacancy", (root) => {
    const value = setup(root);
    const job = submitCamera(value, "exact-runtime-vacancy");
    accept(value, job);
    value.jobs.update(status(value, job.request.jobId, 2, "acquiringCamera", {
      cameraLease: heldCamera(),
    }), value.created.contract.sessionToken);
    value.jobs.update(status(value, job.request.jobId, 3, "restoring", {
      cameraLease: { held: false, restorationConfirmed: false },
    }), value.created.contract.sessionToken);

    expect(value.jobs.vacateSession(value.registration.sessionId)).toEqual([job.request.jobId]);
    expect(job).toMatchObject({
      state: "failed",
      terminalErrorCode: "INSTANCE_STALE",
      cameraLease: {
        everHeld: true,
        held: false,
        restorationConfirmed: false,
        vacancyDisposition: "exact_runtime_vacant",
      },
    });
    expect(value.jobs.stats().restorationObligations).toBe(0);
    expect(value.jobs.sessionPins()).not.toContain(value.registration.sessionId);
    expect(value.jobs.vacateSession(value.registration.sessionId)).toEqual([]);
  });

  scopedIt("enforces per-session rate, FOV, settle-frame, and capture-distance limits before routing", async (root) => {
    const rate = setup(root);
    rate.created.record.limits.maxCaptureRatePerMinute = 1;
    const first = submitCurrent(rate, "rate-1");
    expect(() => submitCurrent(rate, "rate-2")).toThrowError(expect.objectContaining({ code: "CAPTURE_REJECTED" }));
    first.createdAt -= 60_001;
    expect(() => submitCurrent(rate, "rate-3")).not.toThrow();

    const limits = await withTemporaryDirectory((limitsRoot) => setup(limitsRoot), { prefix: "rfo-jobs-" });
    limits.created.record.limits.minFov = 40;
    limits.created.record.limits.maxFov = 80;
    limits.created.record.limits.maxSettleFrames = 2;
    limits.created.record.limits.maxCaptureDistance = 10;
    const base = {
      sessionId: limits.registration.sessionId,
      deadlineAt: new Date(limits.clock.now() + 30_000).toISOString(),
    };
    expect(() => limits.jobs.submit({ ...base, idempotencyKey: "low-fov", view: {
      kind: "pose", position: [0, 0, 0], orientation: [0, 0, 0, 1], fov: 39,
    } })).toThrowError(expect.objectContaining({ code: "CAPTURE_REJECTED" }));
    expect(() => limits.jobs.submit({ ...base, idempotencyKey: "high-fov", view: {
      kind: "lookAt", position: [0, 0, 0], target: [1, 0, 0], fov: 81,
    } })).toThrowError(expect.objectContaining({ code: "CAPTURE_REJECTED" }));
    expect(() => limits.jobs.submit({ ...base, idempotencyKey: "settle", view: { kind: "current" }, settleFrames: 3 }))
      .toThrowError(expect.objectContaining({ code: "CAPTURE_REJECTED" }));
    expect(() => limits.jobs.submit({ ...base, idempotencyKey: "distance", view: {
      kind: "pose", position: [11, 0, 0], orientation: [0, 0, 0, 1], fov: 60,
    } })).toThrowError(expect.objectContaining({ code: "CAPTURE_REJECTED" }));
  });

  scopedIt("preflights artifact state and completes matching retries idempotently", (root) => {
    const value = setup(root);
    const job = submitCurrent(value);
    accept(value, job);
    const artifact = manifest(value, job);
    expect(() => value.jobs.preflightArtifact(value.registration.sessionId, job.request.jobId, artifact))
      .toThrowError(expect.objectContaining({ code: "ARTIFACT_INCOMPLETE" }));
    value.jobs.update(status(value, job.request.jobId, 2, "capturing"), value.created.contract.sessionToken);
    value.jobs.update(status(value, job.request.jobId, 3, "awaitingArtifact"), value.created.contract.sessionToken);
    expect(value.jobs.preflightArtifact(value.registration.sessionId, job.request.jobId, artifact).alreadyCompleted).toBe(false);
    expect(value.jobs.completeArtifact(value.registration.sessionId, job.request.jobId, artifact, "C:\\retained\\image.png")).toBe(job);
    expect(job.state).toBe("completed");
    expect(value.jobs.preflightArtifact(value.registration.sessionId, job.request.jobId, artifact).alreadyCompleted).toBe(true);
    expect(value.jobs.completeArtifact(value.registration.sessionId, job.request.jobId, artifact, "C:\\retained\\image.png")).toBe(job);
    expect(() => value.jobs.completeArtifact(value.registration.sessionId, job.request.jobId, {
      ...artifact,
      artifactId: "artifact-other",
    }, "C:\\retained\\image.png")).toThrowError(expect.objectContaining({ code: "ARTIFACT_INVALID" }));
  });

  scopedIt("accepts a camera artifact only after awaitingArtifact and restoration confirmation", (root) => {
    const value = setup(root);
    const job = submitCamera(value);
    accept(value, job);
    value.jobs.update(status(value, job.request.jobId, 2, "acquiringCamera", { cameraLease: heldCamera() }), value.created.contract.sessionToken);
    value.jobs.update(status(value, job.request.jobId, 3, "positioning", { cameraLease: heldCamera() }), value.created.contract.sessionToken);
    value.jobs.update(status(value, job.request.jobId, 4, "settling", { cameraLease: heldCamera() }), value.created.contract.sessionToken);
    value.jobs.update(status(value, job.request.jobId, 5, "capturing", { cameraLease: heldCamera() }), value.created.contract.sessionToken);
    value.jobs.update(status(value, job.request.jobId, 6, "awaitingArtifact", { cameraLease: heldCamera() }), value.created.contract.sessionToken);
    const artifact = manifest(value, job);
    expect(() => value.jobs.preflightArtifact(value.registration.sessionId, job.request.jobId, artifact))
      .toThrowError(expect.objectContaining({ code: "CAMERA_BUSY" }));
    value.jobs.update(status(value, job.request.jobId, 7, "restoring", { cameraLease: restoredCamera() }), value.created.contract.sessionToken);
    expect(value.jobs.preflightArtifact(value.registration.sessionId, job.request.jobId, artifact).alreadyCompleted).toBe(false);
    expect(value.jobs.completeArtifact(value.registration.sessionId, job.request.jobId, artifact, "C:\\retained\\camera.png").state).toBe("completed");
  });

  scopedIt("rejects performance policy until a coordinator exists", (root) => {
    const value = setup(root);
    expect(() => value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "performance",
      deadlineAt: new Date(value.clock.now() + 10_000).toISOString(),
      view: { kind: "current" },
      performancePolicy: "performance",
    })).toThrowError(expect.objectContaining({ code: "PERFORMANCE_POLICY_BLOCKED" }));
  });

  scopedIt("invalidates late old-world status", (root) => {
    const value = setup(root);
    const job = submitCurrent(value);
    const command = dispatch(value, job);
    expect(() => value.jobs.update(status(value, job.request.jobId, 1, "accepted", {
      deliveryToken: command.deliveryToken,
      worldEpoch: 2,
    }), value.created.contract.sessionToken)).toThrowError(expect.objectContaining({ code: "WORLD_CHANGED" }));
    expect(job.state).toBe("failed");
  });
});
