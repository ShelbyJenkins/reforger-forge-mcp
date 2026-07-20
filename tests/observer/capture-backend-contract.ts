import { describe, expect, it } from "vitest";
import type { BackendJobRef, CaptureBackend, CaptureInstance } from "../../src/observer/capture-contract.js";
import { runtimeWorldRevision, workbenchWorldRevision } from "../../src/observer/world-revision.js";
import { contractRequest } from "./capture-policy-fixture.js";

export interface CaptureBackendContractHarness {
  backend: CaptureBackend;
  instance: CaptureInstance;
  lowLevelCalls: string[];
  complete(): void;
}

export function captureBackendContract(
  label: string,
  createHarness: () => CaptureBackendContractHarness
): void {
  describe(`${label} production capture backend contract`, () => {
    it("lists, submits, recovers by exact ref, reads, cancels, and releases", async () => {
      const harness = createHarness();
      const deadlineAtMs = Date.now() + 5_000;
      const context = { deadlineAtMs };
      const listed = await harness.backend.listInstances({}, context);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ backend: harness.backend.kind, instanceId: harness.instance.instanceId });

      const submitted = await harness.backend.submit({
        jobId: "job-contract-1",
        idempotencyKey: "contract-request",
        request: contractRequest(harness.instance),
        instance: harness.instance,
      }, context);
      expect(submitted.ref).toMatchObject({ jobId: "job-contract-1", instanceId: harness.instance.instanceId });
      harness.complete();
      const completed = await harness.backend.status(submitted.ref, context);
      expect(completed).toMatchObject({ state: "completed", restorationConfirmed: true });
      await expect(harness.backend.read(submitted.ref, context)).resolves.toMatchObject({ image: expect.any(Buffer) });
      const cancelled = await harness.backend.cancel(submitted.ref, context);
      expect(cancelled.ref.jobId).toBe("job-contract-1");
      await expect(harness.backend.release(submitted.ref, context)).resolves.toMatchObject({ restorationConfirmed: true });
      expect(harness.lowLevelCalls).toEqual(expect.arrayContaining(["instances", "submit", "status", "read", "cancel", "release"]));
    });

    it("rejects a stale selected revision before backend submission", async () => {
      const harness = createHarness();
      const stale = harness.backend.kind === "runtime"
        ? runtimeWorldRevision("different", 8)
        : workbenchWorldRevision("project/different#8");
      const request = contractRequest(harness.instance, { expectedWorldRevision: stale });
      await expect(harness.backend.submit({
        jobId: "job-contract-stale",
        idempotencyKey: "contract-stale",
        request,
        instance: harness.instance,
      }, { deadlineAtMs: Date.now() + 5_000 })).rejects.toMatchObject({ code: "WORLD_CHANGED" });
      expect(harness.lowLevelCalls).not.toContain("submit");
    });

    it("preserves exact recovery identity and remaining deadline", async () => {
      const harness = createHarness();
      const ref: BackendJobRef = {
        backend: harness.backend.kind,
        jobId: "job-exact-ref",
        instanceId: harness.instance.instanceId,
        ...(harness.instance.sessionId ? { sessionId: harness.instance.sessionId } : {}),
        worldRevision: harness.instance.worldRevision,
        recoveryBinding: harness.instance.recoveryBinding,
      };
      const deadlineAtMs = Date.now() + 2_000;
      await harness.backend.status(ref, { deadlineAtMs }).catch(() => undefined);
      expect(harness.lowLevelCalls).toContain("status");
      await expect(harness.backend.status(ref, { deadlineAtMs: Date.now() - 1 }))
        .rejects.toMatchObject({ code: expect.stringMatching(/CAPTURE_TIMEOUT|TRANSPORT_UNAVAILABLE/) });
    });
  });
}
