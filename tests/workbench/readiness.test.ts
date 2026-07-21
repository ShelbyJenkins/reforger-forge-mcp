import { describe, expect, it, vi, type Mock } from "vitest";
import { type WorkbenchNetApiPort } from "../../src/workbench/net-api-client.js";
import { type VerifyEndpointOwnerResult } from "../../src/workbench/process-guard.js";
import {
  waitForCompanionReady,
  WorkbenchReadinessError,
  type WorkbenchReadinessChild,
} from "../../src/workbench/readiness.js";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
  WORKBENCH_HELPER_ADDON_VERSION,
  WORKBENCH_HELPER_BUILD_IDENTITY,
  WORKBENCH_HELPER_PROTOCOL_VERSION,
  type WorkbenchCompanionLaunch,
} from "../../src/workbench/helper-addon.js";

const companion: WorkbenchCompanionLaunch = {
  addonId: WORKBENCH_HELPER_ADDON_ID,
  addonGuid: WORKBENCH_HELPER_ADDON_GUID,
  addonVersion: WORKBENCH_HELPER_ADDON_VERSION,
  protocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
  buildIdentity: WORKBENCH_HELPER_BUILD_IDENTITY,
  bundleDigest: "a".repeat(64),
  addonDirectory: "C:\\managed\\addon",
  addonSearchRoot: "C:\\managed\\addons",
  workbenchProfilePath: "C:\\managed\\profile",
  reused: true,
};

const ping = {
  status: "ok",
  helperAddonId: WORKBENCH_HELPER_ADDON_ID,
  helperAddonGuid: WORKBENCH_HELPER_ADDON_GUID,
  helperAddonVersion: WORKBENCH_HELPER_ADDON_VERSION,
  helperProtocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
  workbenchProtocol: WORKBENCH_HELPER_PROTOCOL_VERSION,
  helperBuildIdentity: WORKBENCH_HELPER_BUILD_IDENTITY,
};

// A vi.fn cannot express the port's generic `call<T>()`; keep the mock for
// `.mock` introspection while presenting the exact port surface to production.
type MockNetApiCall = WorkbenchNetApiPort["call"] & Mock;

function baseOptions() {
  return {
    endpoint: { host: "127.0.0.1", port: 5775 },
    process: {
      pid: 42,
      executablePath: "C:\\Workbench.exe",
      creationTime: "created",
      ownerTokenArgument: "-reforgerForgeOwnerToken=secret",
      launchedAtMs: 1,
    },
    companion,
    netApi: { call: vi.fn(async () => ping) as unknown as MockNetApiCall },
    verifyEndpointOwner: vi.fn(async (): Promise<VerifyEndpointOwnerResult> => ({ kind: "owned", listenerPid: 42 })),
    attestCompanion: vi.fn(() => companion),
    deadlineMs: Date.now() + 1_000,
    pollIntervalMs: 1,
  };
}

describe("Workbench companion readiness", () => {
  it("orders endpoint ownership before Ping and attests once outside the loop", async () => {
    const trace: string[] = [];
    const options = baseOptions();
    options.attestCompanion = vi.fn(() => { trace.push("attest"); return companion; });
    options.verifyEndpointOwner = vi.fn(async (): Promise<VerifyEndpointOwnerResult> => {
      trace.push("endpoint");
      return { kind: "owned", listenerPid: 42 };
    });
    options.netApi.call = vi.fn(async () => { trace.push("ping"); return ping; }) as unknown as MockNetApiCall;
    await expect(waitForCompanionReady(options)).resolves.toMatchObject({
      addonId: WORKBENCH_HELPER_ADDON_ID,
      workbenchProtocol: WORKBENCH_HELPER_PROTOCOL_VERSION,
    });
    expect(trace).toEqual(["attest", "endpoint", "ping"]);
    expect(options.attestCompanion).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched Workbench protocol", async () => {
    const options = baseOptions();
    options.netApi.call = vi.fn(async () => ({ ...ping, workbenchProtocol: "stale" })) as unknown as MockNetApiCall;
    await expect(waitForCompanionReady(options)).rejects.toMatchObject({
      code: "IDENTITY_UNVERIFIABLE",
    });
  });

  it("bounds Ping by the remaining absolute deadline", async () => {
    const options = baseOptions();
    options.deadlineMs = Date.now() + 25;
    await waitForCompanionReady(options);
    expect(options.netApi.call).toHaveBeenCalledWith("EMCP_WB_Ping", {}, expect.objectContaining({
      timeoutMs: expect.any(Number),
      responseCapBytes: 1024 * 1024,
    }));
    const call = options.netApi.call.mock.calls[0][2] as { timeoutMs: number };
    expect(call.timeoutMs).toBeGreaterThan(0);
    expect(call.timeoutMs).toBeLessThanOrEqual(25);
  });

  it("fails before endpoint or Ping work when the child already exited", async () => {
    const options = baseOptions();
    const terminal = Promise.resolve({
      kind: "exit" as const,
      exit: { code: 1, signal: null },
    });
    const child: WorkbenchReadinessChild = {
      terminalState: { kind: "exit", exit: { code: 1, signal: null } },
      terminal,
    };
    await expect(waitForCompanionReady({ ...options, child })).rejects.toMatchObject({
      code: "CHILD_EXITED",
    });
    expect(options.verifyEndpointOwner).not.toHaveBeenCalled();
  });

  it("fails immediately when the supervised child errors during polling", async () => {
    const options = baseOptions();
    options.pollIntervalMs = 100;
    options.verifyEndpointOwner = vi.fn(async (): Promise<VerifyEndpointOwnerResult> => ({
      kind: "refused",
      reason: "listener_not_found",
      message: "not listening yet",
    }));
    let terminalState: WorkbenchReadinessChild["terminalState"] = null;
    let publishTerminal!: () => void;
    const terminal = new Promise<NonNullable<WorkbenchReadinessChild["terminalState"]>>(
      (resolvePromise) => {
        publishTerminal = () => {
          terminalState = { kind: "error", error: new Error("spawn channel failed") };
          resolvePromise(terminalState);
        };
      }
    );
    const child: WorkbenchReadinessChild = {
      get terminalState() { return terminalState; },
      terminal,
    };
    setTimeout(publishTerminal, 0);

    await expect(waitForCompanionReady({ ...options, child })).rejects.toMatchObject({
      code: "CHILD_ERROR",
    });
    expect(options.netApi.call).not.toHaveBeenCalled();
  });

  it("fails immediately for cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForCompanionReady({ ...baseOptions(), signal: controller.signal }))
      .rejects.toEqual(expect.objectContaining({ code: "ABORTED" } satisfies Partial<WorkbenchReadinessError>));
  });
});
