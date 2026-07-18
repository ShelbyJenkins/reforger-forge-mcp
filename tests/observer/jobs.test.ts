import { afterEach, describe, expect, it } from "vitest";
import { JobStore, type JobRecord } from "../../observer/agent/jobs.js";
import { InstanceRegistry } from "../../observer/agent/registry.js";
import { COMMAND_DELIVERY_LEASE_MS, type ArtifactManifest, type CameraLeaseStatus } from "../../observer/protocol/index.js";
import { cleanup, createSessionFixture, FakeClock, graphicalRegistration, temporaryDirectory } from "./helpers.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(cleanup));

function setup() {
  const root = temporaryDirectory();
  roots.push(root);
  const clock = new FakeClock();
  const fixture = createSessionFixture(root, clock);
  const registry = new InstanceRegistry(fixture.store, { clock });
  const registration = graphicalRegistration(fixture.created);
  registry.register(registration, fixture.created.contract.sessionToken);
  const jobs = new JobStore(fixture.store, registry, clock);
  return { ...fixture, registry, registration, jobs, clock };
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
  it("returns the original job for one session idempotency key", () => {
    const value = setup();
    const input = {
      sessionId: value.registration.sessionId,
      idempotencyKey: "capture-1",
      deadlineAt: new Date(value.clock.now() + 10_000).toISOString(),
      view: { kind: "current" as const },
    };
    expect(value.jobs.submit(input)).toBe(value.jobs.submit(input));
    expect(value.jobs.diagnostics()).toHaveLength(1);
  });

  it("rejects a stale expected world before queueing camera work", () => {
    const value = setup();
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

  it("emits a canonical decimal-string wire view for Enforce float decoding", () => {
    const value = setup();
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

  it("redelivers an unacknowledged capture with a stable acknowledgement token and renewed lease", () => {
    const value = setup();
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

  it("keeps exactly one capture in flight per renderer", () => {
    const value = setup();
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

  it("delivers cancellation explicitly after dispatch and acknowledges its token", () => {
    const value = setup();
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

  it("uses the explicit transition graph and rejects illegal jumps", () => {
    const value = setup();
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

  it("allows acquisition failure without a lease but requires confirmed restoration after one was held", () => {
    const value = setup();
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

  it("records ownership loss as a distinct bounded restoration failure", () => {
    const value = setup();
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
  });

  it("enforces per-session rate, FOV, settle-frame, and capture-distance limits before routing", () => {
    const rate = setup();
    rate.created.record.limits.maxCaptureRatePerMinute = 1;
    const first = submitCurrent(rate, "rate-1");
    expect(() => submitCurrent(rate, "rate-2")).toThrowError(expect.objectContaining({ code: "CAPTURE_REJECTED" }));
    first.createdAt -= 60_001;
    expect(() => submitCurrent(rate, "rate-3")).not.toThrow();

    const limits = setup();
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

  it("preflights artifact state and completes matching retries idempotently", () => {
    const value = setup();
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

  it("accepts a camera artifact only after awaitingArtifact and restoration confirmation", () => {
    const value = setup();
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

  it("rejects performance policy until a coordinator exists", () => {
    const value = setup();
    expect(() => value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "performance",
      deadlineAt: new Date(value.clock.now() + 10_000).toISOString(),
      view: { kind: "current" },
      performancePolicy: "performance",
    })).toThrowError(expect.objectContaining({ code: "PERFORMANCE_POLICY_BLOCKED" }));
  });

  it("invalidates late old-world status", () => {
    const value = setup();
    const job = submitCurrent(value);
    const command = dispatch(value, job);
    expect(() => value.jobs.update(status(value, job.request.jobId, 1, "accepted", {
      deliveryToken: command.deliveryToken,
      worldEpoch: 2,
    }), value.created.contract.sessionToken)).toThrowError(expect.objectContaining({ code: "WORLD_CHANGED" }));
    expect(job.state).toBe("failed");
  });
});
