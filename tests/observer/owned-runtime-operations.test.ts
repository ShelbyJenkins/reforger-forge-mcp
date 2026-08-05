import { describe, expect, it, vi } from "vitest";
import {
  OwnedRuntimeError,
  type OwnedRuntimeManager,
} from "../../src/observer/owned-runtime-manager.js";
import {
  deriveObserverRuntimeIdempotencyKey,
  executeOwnedRuntimeOperation,
  extractOwnedRuntimeError,
  ownedRuntimeSuccessHeading,
} from "../../src/tools/owned-runtime-operations.js";

const PREPARED_ID = "pl-00000000-0000-4000-8000-000000000001";
const RUNTIME_ID = "rt-00000000-0000-4000-8000-000000000002";

function result() {
  return {
    runtimeId: RUNTIME_ID,
    sessionId: "session-one",
    preparedLaunchId: PREPARED_ID,
    state: "running" as const,
    pid: 42,
    runtimeKind: "listenServer" as const,
    startedAt: "2026-08-04T00:00:00.000Z",
    exactOwned: true,
  };
}

describe("shared owned-runtime operations", () => {
  it("dispatches start, status, and stop with stable keys and the abort signal", async () => {
    const manager = {
      start: vi.fn(async () => result()),
      status: vi.fn(async () => result()),
      stop: vi.fn(async () => result()),
    } as unknown as OwnedRuntimeManager;
    const signal = new AbortController().signal;
    const start = { action: "start" as const, preparedLaunchId: PREPARED_ID };
    const status = { action: "status" as const, runtimeId: RUNTIME_ID };
    const stop = { action: "stop" as const, runtimeId: RUNTIME_ID, waitForRestorationMs: 20_000 };

    await expect(executeOwnedRuntimeOperation(manager, start, signal)).resolves.toEqual(result());
    await expect(executeOwnedRuntimeOperation(manager, status, signal)).resolves.toEqual(result());
    await expect(executeOwnedRuntimeOperation(manager, stop, signal)).resolves.toEqual(result());

    expect(manager.start).toHaveBeenCalledWith({
      preparedLaunchId: PREPARED_ID,
      idempotencyKey: deriveObserverRuntimeIdempotencyKey(start),
    });
    expect(manager.status).toHaveBeenCalledWith(RUNTIME_ID);
    expect(manager.stop).toHaveBeenCalledWith({
      runtimeId: RUNTIME_ID,
      waitForRestorationMs: 20_000,
      idempotencyKey: deriveObserverRuntimeIdempotencyKey(stop),
      signal,
    });
  });

  it("lets typed failures escape and exposes only a lazy trusted extractor", async () => {
    const failure = new OwnedRuntimeError("RUNTIME_NOT_FOUND", "bounded diagnostic", { safe: true });
    const manager = {
      status: vi.fn(async () => { throw failure; }),
    } as unknown as OwnedRuntimeManager;

    await expect(executeOwnedRuntimeOperation(manager, { action: "status", runtimeId: RUNTIME_ID }))
      .rejects.toBe(failure);
    const extracted = extractOwnedRuntimeError(failure)!;
    expect(extracted.code).toBe("RUNTIME_NOT_FOUND");
    expect(extracted.readDiagnosticMessage()).toBe("bounded diagnostic");
    expect(extracted.readDetails()).toEqual({ safe: true });
    expect(extractOwnedRuntimeError({ code: "RUNTIME_NOT_FOUND", message: "spoof" })).toBeUndefined();
  });

  it("owns the existing operation-specific success headings", () => {
    expect(ownedRuntimeSuccessHeading("start")).toBe("Exact-owned observer runtime started.");
    expect(ownedRuntimeSuccessHeading("status")).toBe("Exact-owned observer runtime status.");
    expect(ownedRuntimeSuccessHeading("stop")).toBe("Exact-owned observer runtime stopped.");
  });
});
