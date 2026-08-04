import { describe, expect, it, vi } from "vitest";
import {
  formatLifecycleDiagnostic,
  normalizeLifecycleDiagnostic,
  runCliShutdown,
} from "../src/mcp-lifecycle.js";
import { OwnedRuntimeError } from "../src/observer/owned-runtime-manager.js";

describe("MCP lifecycle diagnostics", () => {
  it("extracts only stable owned-runtime fields from a thrown shutdown error", () => {
    const error = new OwnedRuntimeError("SHUTDOWN_SEAL_FAILED", "top-level secret=drop-me", {
      applicationCloseSafe: false,
      busyRuntimeIds: ["rt-busy"],
      errorRuntimes: [{ runtimeId: "rt-error", reason: "inspection failed" }],
      accessToken: "must-not-appear",
      localPath: "C:\\private\\operator\\state",
    });
    Object.assign(error, { arbitrary: "not-approved" });

    expect(normalizeLifecycleDiagnostic(error)).toEqual({
      code: "SHUTDOWN_SEAL_FAILED",
      applicationCloseSafe: false,
      busyRuntimeIds: ["rt-busy"],
      errorRuntimes: [{ runtimeId: "rt-error", reason: "inspection failed" }],
    });
    const rendered = formatLifecycleDiagnostic(error);
    expect(rendered).not.toMatch(/drop-me|must-not-appear|operator|arbitrary|localPath|stack/);
  });

  it("redacts hostile detail strings and bounds arrays, identifiers, and output", () => {
    const rendered = formatLifecycleDiagnostic(new OwnedRuntimeError(
      "SHUTDOWN_SEAL_FAILED",
      "unsafe",
      {
        applicationCloseSafe: false,
        busyRuntimeIds: Array.from({ length: 100 }, (_, index) =>
          `${index}-Authorization: Bearer hostile.token.${index}-${"x".repeat(500)}`),
        errorRuntimes: Array.from({ length: 100 }, (_, index) => ({
          runtimeId: `rt-${index}-${"y".repeat(500)}`,
          reason: `C:\\Users\\private\\token=${index}-${"z".repeat(2_000)}`,
        })),
      },
    ));

    expect(rendered.length).toBeLessThanOrEqual(4_096);
    expect(rendered).not.toMatch(/hostile\.token|C:\\Users|token=0/);
    const parsed = JSON.parse(rendered.slice(rendered.indexOf("{") ));
    expect(parsed.busyRuntimeIds.length).toBeLessThanOrEqual(16);
    expect(parsed.errorRuntimes.length).toBeLessThanOrEqual(8);
  });
});

describe("CLI MCP shutdown", () => {
  it("closes protocol admissions before disposal and clears the watchdog on success", async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const exit = vi.fn();
      const stdout = vi.spyOn(process.stdout, "write");
      const shutdown = runCliShutdown({
        reason: "fixture",
        deadlineMs: 1_000,
        retryDelayMs: 10,
        closeProtocol: async () => { order.push("protocol"); },
        disposeTools: async () => {
          order.push("dispose");
          return { applicationCloseSafe: true, busyRuntimeIds: [], errorRuntimes: [] };
        },
        emergencyTerminate: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        exit,
      });

      await expect(shutdown).resolves.toBe("closed");
      expect(order).toEqual(["protocol", "dispose"]);
      expect(exit).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(stdout).not.toHaveBeenCalled();
      stdout.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries structured unsafe results on one deadline and exits once at expiry", async () => {
    vi.useFakeTimers();
    try {
      const exits: number[] = [];
      const errors: string[] = [];
      const emergencyTerminate = vi.fn();
      const disposeTools = vi.fn(async () => ({
        applicationCloseSafe: false,
        busyRuntimeIds: ["rt-persistently-busy"],
        errorRuntimes: [],
      }));
      const shutdown = runCliShutdown({
        reason: "persistent unsafe fixture",
        deadlineMs: 100,
        retryDelayMs: 10,
        closeProtocol: async () => undefined,
        disposeTools,
        emergencyTerminate,
        info: vi.fn(),
        warn: vi.fn(),
        error: (message) => errors.push(message),
        exit: (code) => { exits.push(code); },
      });

      await vi.advanceTimersByTimeAsync(100);
      await expect(shutdown).resolves.toBe("emergency");
      expect(disposeTools.mock.calls.length).toBeGreaterThan(1);
      expect(emergencyTerminate).toHaveBeenCalledOnce();
      expect(exits).toEqual([1]);
      expect(errors.join("\n")).toContain("rt-persistently-busy");
      expect(errors.join("\n")).toContain("emergency=true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes an unrecoverable failure immediately through emergency termination", async () => {
    const exit = vi.fn();
    const emergencyTerminate = vi.fn();
    const shutdown = runCliShutdown({
      reason: "unrecoverable fixture",
      deadlineMs: 10_000,
      closeProtocol: async () => undefined,
      disposeTools: async () => { throw Object.assign(new Error("terminal close failed"), { code: "INTERNAL_ERROR" }); },
      emergencyTerminate,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      exit,
    });

    await expect(shutdown).resolves.toBe("emergency");
    expect(emergencyTerminate).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });
});
