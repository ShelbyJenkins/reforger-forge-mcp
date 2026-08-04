import { describe, expect, it, vi } from "vitest";
import { EvidenceRunService } from "../../src/observer/evidence-run-service.js";
import { normalizeCaptureRequest } from "../../src/observer/capture-request.js";
import { workbenchWorldRevision } from "../../src/observer/world-revision.js";
import { contractInstance, contractJob, contractPng, contractRef } from "./capture-policy-fixture.js";

describe("EvidenceRunService", () => {
  it("passes complete request identity through reserve, admission revision, submission, and promotion", async () => {
    const instance = contractInstance("workbench");
    const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
    const agent = { async request(operation: string, payload: Record<string, unknown> = {}) {
      calls.push({ operation, payload });
      if (operation === "runReserveCapture") return { capture: { state: "reserved", jobId: payload.jobId } };
      return {};
    } };
    const service = new EvidenceRunService(agent);
    const request = normalizeCaptureRequest({
      idempotencyKey: "run-capture",
      instanceId: instance.instanceId,
      expectedWorldRevision: instance.worldRevision,
      view: { kind: "current" },
      timeoutMs: 1_000,
      asynchronous: true,
      runId: "20260719T120000Z-a1b2c3d4",
      captureLabel: "overview",
    });
    await service.reserve({ runId: request.runId!, captureLabel: request.captureLabel!, idempotencyKey: "run-capture", request, jobId: "job-workbench" });
    const ref = contractRef(instance, "job-workbench");
    await service.bind({ runId: request.runId!, captureLabel: request.captureLabel!, ref });
    const revisedWorldRevision = workbenchWorldRevision("project/world#8");
    const revisedRequest = normalizeCaptureRequest({
      idempotencyKey: "run-capture",
      instanceId: instance.instanceId,
      expectedWorldRevision: revisedWorldRevision,
      view: { kind: "current" },
      timeoutMs: 1_000,
      asynchronous: true,
      runId: request.runId,
      captureLabel: request.captureLabel,
    });
    const revisedRef = { ...ref, worldRevision: revisedWorldRevision };
    await service.reviseAdmission({
      runId: request.runId!, captureLabel: request.captureLabel!, ref: revisedRef,
      request: revisedRequest, selectionDelegated: true, retryCount: 1,
    });
    await service.submitted({ runId: request.runId!, captureLabel: request.captureLabel!, ref: revisedRef });
    await service.complete({
      runId: request.runId!, captureLabel: request.captureLabel!, ref: revisedRef,
      artifact: { image: contractPng, metadata: { contentSha256: "a".repeat(64) } },
      job: { ...contractJob(instance, "completed", ref.jobId), ref: revisedRef },
    });
    expect(calls[0]).toMatchObject({ operation: "runReserveCapture", payload: { jobId: "job-workbench", requestFingerprint: request.fingerprint, expectedWorldRevision: instance.worldRevision } });
    expect(calls[1]).toMatchObject({ operation: "runBindCapture", payload: { backend: "workbench", worldRevision: instance.worldRevision } });
    expect(calls[2]).toMatchObject({
      operation: "runReviseCaptureAdmission",
      payload: { jobId: "job-workbench", worldRevision: revisedWorldRevision, requestFingerprint: revisedRequest.fingerprint, selectionDelegated: true, retryCount: 1 },
    });
    expect(calls[3]).toMatchObject({ operation: "runSubmitCapture", payload: { runId: request.runId, captureLabel: request.captureLabel } });
    expect(calls[4]).toMatchObject({ operation: "importWorkbenchArtifact", payload: { jobId: "job-workbench", image: contractPng } });
  });

  it("converges durable snapshots before returning status and around finalization", async () => {
    const runId = "20260719T120100Z-b1c2d3e4";
    let state = "open";
    const agent = { async request(operation: string) {
      if (operation === "runFinalize") { state = "finalized"; return { run: { runId, state }, receipt: { managedArtifactsReleased: true } }; }
      return { runId, state, captures: [{ captureLabel: "proof", state: state === "open" ? "completed" : "released", backend: "workbench", jobId: "job-1", instanceId: "wb-1", artifactAvailable: state === "open" }] };
    } };
    const snapshots: Record<string, unknown>[] = [];
    const service = new EvidenceRunService(agent, async (run) => { snapshots.push(structuredClone(run)); });
    await service.status(runId);
    const result = await service.finalize({ runId, releaseManagedArtifacts: true });
    expect(result).toMatchObject({ run: { state: "finalized" } });
    expect(snapshots.some((run) => run.state === "open")).toBe(true);
    expect(snapshots.at(-1)).toMatchObject({ state: "finalized", captures: [{ state: "released", artifactAvailable: false }] });
  });

  it("projects discard release proof into convergence without rereading a deleted run", async () => {
    const runId = "20260719T120200Z-c1d2e3f4";
    const request = vi.fn(async (operation: string) => operation === "runDiscard"
      ? { runId, discarded: true, releasedCaptureLabels: ["proof"] }
      : { runId, state: "open", captures: [{ captureLabel: "proof", state: "completed", backend: "runtime", jobId: "job-1", instanceId: "rt-1", artifactAvailable: true }] });
    const snapshots: Record<string, unknown>[] = [];
    const service = new EvidenceRunService({ request }, async (run) => { snapshots.push(structuredClone(run)); });
    await service.discard(runId);
    expect(request.mock.calls.filter(([operation]) => operation === "runDiscard")).toHaveLength(1);
    expect(snapshots.at(-1)).toMatchObject({ state: "discarded", captures: [{ state: "released", artifactAvailable: false }] });
  });
});
