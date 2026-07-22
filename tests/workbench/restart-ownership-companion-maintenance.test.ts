import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKBENCH_HELPER_PING_RESPONSE } from "./fake-companion.js";
import {
  cleanupRestartOwnershipFixtures, createAsyncGate, createHarness, createRunningHarness,
  createSiblingGuard, republishLifecycleState,
} from "./restart-ownership-fixture.js";

afterEach(cleanupRestartOwnershipFixtures);

describe("companion maintenance and unlocked NET calls", () => {
  it("runs companion staging and retention outside the machine mutex", async () => {
    const harness = createHarness();
    const helperRoot = join(harness.root, "managed-helper");
    harness.companionProvider.status = () => ({
      installed: true,
      managedRoot: helperRoot, roleRoot: helperRoot,
      currentBundleDigest: "a".repeat(64),
      stagedDigests: ["a".repeat(64)],
      managedBytes: 0, staleCaptureCount: 0, warnings: [],
    });
    harness.companionProvider.applyRetention = () => ({
      removedDigestRoots: [], removedCaptureFiles: [], removedTemporaryRoots: [],
      reclaimedBytes: 0, remainingBytes: 0,
    });
    const originalMutex = harness.backend.withMachineMutex.bind(harness.backend);
    let mutexDepth = 0;
    harness.backend.withMachineMutex = async (args) => originalMutex({
      ...args,
      action: async () => {
        mutexDepth += 1;
        try {
          return await args.action();
        } finally {
          mutexDepth -= 1;
        }
      },
    });
    const ensureStaged = harness.companionProvider.ensureStaged.bind(harness.companionProvider);
    const applyRetention = harness.companionProvider.applyRetention!.bind(harness.companionProvider);
    harness.companionProvider.ensureStaged = vi.fn((target) => {
      expect(mutexDepth).toBe(0);
      return ensureStaged(target);
    });
    harness.companionProvider.applyRetention = vi.fn((options) => {
      expect(mutexDepth).toBe(0);
      return applyRetention(options);
    });

    await expect(harness.client.ensureManagedCompanion(harness.projectPath))
      .resolves.toMatchObject({ action: "staged" });
    await expect(harness.client.applyManagedCompanionRetention())
      .resolves.toMatchObject({ removedDigestRoots: [] });
    expect(harness.companionProvider.ensureStaged).toHaveBeenCalledTimes(1);
    expect(harness.companionProvider.applyRetention).toHaveBeenCalledTimes(2);
    expect(mutexDepth).toBe(0);
  });

  it("publishes a durable reservation before uninstalling from a missing lifecycle", async () => {
    const harness = createHarness();
    const contenderGuard = createSiblingGuard(harness);
    let contenderAttempt: ReturnType<typeof contenderGuard.withLifecycleLock> | null = null;
    let reservedBeforeUninstall: unknown;
    harness.backend.afterReplace = ({ next }) => {
      if (next.phase === "starting" && next.workbench === null && next.operation?.kind === "recovery") {
        reservedBeforeUninstall = next;
      }
    };
    harness.companionProvider.uninstall = vi.fn(() => {
      expect(reservedBeforeUninstall).toMatchObject({
        phase: "starting",
        workbench: null,
        operation: { kind: "recovery" },
      });
      contenderAttempt = contenderGuard.withLifecycleLock((session) =>
        session.validateAndClaim({
          endpoint: { host: harness.config.workbenchHost, port: harness.config.workbenchPort },
          target: null,
        })
      );
      return { removed: true, roleRoot: join(harness.root, "managed-helper") };
    });

    await expect(harness.client.uninstallManagedCompanion()).resolves.toMatchObject({
      removed: true,
    });
    await expect(contenderAttempt).resolves.toMatchObject({
      kind: "refused",
      code: "OWNED_BY_OTHER_MCP",
    });
    const read = await harness.guard.readLifecycleState();
    expect(read).toMatchObject({
      kind: "valid",
      state: { phase: "vacant", workbench: null, companion: null, operation: null },
    });
  });

  it("releases the machine mutex while an ordinary managed NET request is blocked", async () => {
    const { harness } = await createRunningHarness();
    const callGate = createAsyncGate();
    harness.netApiCall.mockImplementation(async (api) => {
      if (api === "EMCP_WB_Ping") return WORKBENCH_HELPER_PING_RESPONSE;
      await callGate.block();
      return { status: "ok", count: 1 };
    });

    const request = harness.client.call("EMCP_WB_ListEntities", {}, { skipAutoLaunch: true });
    await callGate.entered;
    const contenderRead = await harness.guard.withLifecycleLock((session) => session.readState());
    expect(contenderRead).toMatchObject({ kind: "valid", state: { phase: "running" } });
    const previousPid = harness.children[0].pid;
    const restarting = harness.client.restartOwnedWorkbench();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(harness.backend.terminationCalls).toHaveLength(0);

    callGate.release();
    await expect(request).resolves.toMatchObject({ status: "ok", count: 1 });
    await expect(restarting).resolves.toMatchObject({ previousPid });
    expect(harness.children).toHaveLength(2);
  });

  it("refuses stale local state publication when generation changes during an unlocked NET call", async () => {
    const { harness } = await createRunningHarness();
    const callGate = createAsyncGate();
    harness.netApiCall.mockImplementation(async (api) => {
      if (api === "EMCP_WB_Ping") return WORKBENCH_HELPER_PING_RESPONSE;
      await callGate.block();
      return { status: "ok", mode: "edit" };
    });

    const request = harness.client.call("EMCP_WB_GetState", {}, { skipAutoLaunch: true });
    await callGate.entered;
    await republishLifecycleState(harness);
    const mutexGate = createAsyncGate();
    const holder = harness.guard.withLifecycleLock(() => mutexGate.block());
    await mutexGate.entered;
    callGate.release();
    const requestError = request.catch((error: unknown) => error);

    // The NET response is provisional until its lock-free exact-generation
    // check completes. A stale response invalidates the local cache immediately.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.client.state).toMatchObject({ connected: false, mode: "unknown" });
    mutexGate.release();
    await holder;

    await expect(requestError).resolves.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(harness.client.state).toMatchObject({ connected: false, mode: "unknown" });
  });
});
