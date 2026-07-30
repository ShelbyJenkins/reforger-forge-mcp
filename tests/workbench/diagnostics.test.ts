import { describe, expect, it, vi } from "vitest";
import {
  diagnoseLifecycle,
  diagnoseWorkbench,
  formatLifecycleDiagnostic,
} from "../../src/workbench/diagnostics.js";
import type {
  LifecycleStateRead,
  WorkbenchProcessGuard,
} from "../../src/workbench/process-guard.js";
import { WORKBENCH_HELPER_PING_RESPONSE } from "./fake-companion.js";

type LifecycleReader = Pick<WorkbenchProcessGuard, "mcpInstanceId" | "readLifecycleState">;

function lifecycleReader(read: LifecycleStateRead | Error): LifecycleReader {
  return {
    mcpInstanceId: "mcp-current",
    readLifecycleState: vi.fn(async () => {
      if (read instanceof Error) throw read;
      return read;
    }),
  } as unknown as LifecycleReader;
}

describe("Workbench diagnostics", () => {
  it("formats exact lifecycle ownership without claiming or reconciling state", () => {
    const report = formatLifecycleDiagnostic({
      kind: "valid",
      state: {
        version: 3,
        generation: "generation-1",
        phase: "running",
        endpoint: { host: "127.0.0.1", port: 5775 },
        target: { path: "C:\\mods\\Example\\Example.gproj", comparisonKey: "example" },
        mcpOwner: {
          pid: 100,
          executablePath: "C:\\node.exe",
          creationTime: "123",
          instanceId: "mcp-current",
          leaseId: "lease-1",
          userSid: "sid",
          claimedAtMs: 1,
        },
        workbench: null,
        companion: {
          addonId: "helper",
          addonGuid: "0123456789ABCDEF",
          addonDirectory: "C:\\helper",
          addonSearchRoot: "C:\\root",
          bundleDigest: "digest",
          buildIdentity: "build-1",
          profilePath: "C:\\profile",
        },
        operation: { kind: "restart", operationId: "operation-1" },
      },
    }, "mcp-current");

    expect(report).toMatchObject({
      state: "valid",
      version: 3,
      generation: "generation-1",
      phase: "running",
      endpoint: "127.0.0.1:5775",
      target: "C:\\mods\\Example\\Example.gproj",
      lease: "current_mcp",
      leaseOwner: {
        pid: 100,
        instanceId: "mcp-current",
        leaseId: "lease-1",
        claimedAtMs: 1,
      },
      leasePreemptible: false,
      operation: "restart:operation-1",
      companionBuildIdentity: "build-1",
    });
  });

  it("marks an idle lease preemptible and names its owning MCP session", () => {
    const report = formatLifecycleDiagnostic({
      kind: "valid",
      state: {
        version: 3,
        generation: "generation-2",
        phase: "vacant",
        endpoint: { host: "127.0.0.1", port: 5775 },
        target: { path: "C:\\mods\\Example\\Example.gproj", comparisonKey: "key" },
        mcpOwner: {
          pid: 12752,
          executablePath: "C:\\node.exe",
          creationTime: "123",
          instanceId: "mcp-other",
          leaseId: "lease-2",
          userSid: "sid",
          claimedAtMs: 5,
        },
        workbench: null,
        companion: null,
        operation: null,
      },
    }, "mcp-current");

    expect(report).toMatchObject({
      lease: "other_mcp",
      leaseOwner: { pid: 12752, instanceId: "mcp-other" },
      leasePreemptible: true,
    });
  });

  it("reports lifecycle read failures as malformed best-effort evidence", async () => {
    await expect(diagnoseLifecycle(lifecycleReader(new Error("read failed")))).resolves.toEqual({
      state: "malformed",
      version: null,
      generation: null,
      phase: null,
      endpoint: null,
      target: null,
      lease: "unknown",
      leaseOwner: null,
      leasePreemptible: false,
      operation: null,
      companionBuildIdentity: null,
      detail: "read failed",
    });
  });

  it("uses only the narrow NET call and lifecycle reader to produce the public report", async () => {
    const lifecycle = lifecycleReader({ kind: "missing" });
    const netCalls: unknown[][] = [];
    const callNetApi = async <T = Record<string, unknown>>(
      apiFunc: string,
      params: Record<string, unknown>,
      options: { timeout: number; skipAutoLaunch: true }
    ): Promise<T> => {
      netCalls.push([apiFunc, params, options]);
      return WORKBENCH_HELPER_PING_RESPONSE as unknown as T;
    };

    const report = await diagnoseWorkbench({
      host: "127.0.0.1",
      port: 5775,
      lifecycle,
      callNetApi,
      classifyNetError: () => null,
    });

    expect(netCalls).toEqual([[
      "EMCP_WB_Ping",
      {},
      { timeout: 3000, skipAutoLaunch: true },
    ]]);
    expect(lifecycle.readLifecycleState).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      host: "127.0.0.1",
      port: 5775,
      workbenchExe: null,
      netApi: "up_with_companion",
      lifecycle: { state: "missing", lease: "vacant" },
    });
  });

  it("preserves historical NET error classification", async () => {
    const timeout = { code: "TIMEOUT", message: "diagnostic timeout" };
    const report = await diagnoseWorkbench({
      host: "127.0.0.1",
      port: 5775,
      lifecycle: lifecycleReader({ kind: "missing" }),
      callNetApi: vi.fn(async () => { throw timeout; }),
      classifyNetError: (error) => error === timeout ? timeout : null,
    });

    expect(report.netApi).toBe("timeout");
    expect(report.netApiError).toBe("diagnostic timeout");
  });
});
