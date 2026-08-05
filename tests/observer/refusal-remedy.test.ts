import { describe, expect, it, vi } from "vitest";
import {
  formatObserverRefusalRemedy,
  resolveObserverRefusalRemedy,
  type ObserverRefusalContext,
} from "../../src/observer/refusal-remedy.js";
import type { CaptureErrorCode } from "../../src/observer/capture-contract.js";

function resolve(
  code: CaptureErrorCode,
  context: ObserverRefusalContext,
  dynamic: unknown = undefined
) {
  return resolveObserverRefusalRemedy({
    code,
    context,
    readRemedyContext: () => dynamic,
  });
}

describe("observer refusal remedy policy", () => {
  it("distinguishes broad argument conflicts using closed reason tags", () => {
    expect(resolve("ARGUMENT_CONFLICT", {
      tool: "observer_prepare_launch",
      action: "prepare",
      reason: "display_arguments",
    })).toEqual({ kind: "external", action: "remove_display_arguments" });
    expect(resolve("ARGUMENT_CONFLICT", {
      tool: "observer_runtime",
      action: "start",
      reason: "owner_token_injection",
    })).toEqual({
      kind: "external",
      action: "remove_owner_argument",
    });
    expect(resolve("ARGUMENT_CONFLICT", {
      tool: "observer_runtime",
      action: "start",
      reason: "command_line_overflow",
    })).toBeNull();
    expect(resolve("ARGUMENT_CONFLICT", {
      tool: "observer_runtime",
      action: "start",
      reason: "remove window flags from this diagnostic",
    } as unknown as ObserverRefusalContext)).toBeNull();
  });

  it("keeps runtime-not-found remedies action and producer-reason specific", () => {
    expect(resolve("RUNTIME_NOT_FOUND", {
      tool: "observer_runtime",
      action: "start",
    })).toBeNull();
    expect(resolve("RUNTIME_NOT_FOUND", {
      tool: "observer_runtime",
      action: "start",
      reason: "runtime_executable_missing",
    })).toEqual({
      kind: "external",
      action: "configure_runtime_executable",
    });
    expect(resolve("RUNTIME_NOT_FOUND", {
      tool: "observer_runtime",
      action: "status",
    })).toEqual({ kind: "external", action: "use_started_runtime_id" });
    expect(resolve("RUNTIME_NOT_FOUND", {
      tool: "observer_runtime",
      action: "stop",
    })).toEqual({ kind: "external", action: "verify_stop_runtime_id" });
  });

  it("suggests fresh instance inventory only with a validated owned session", () => {
    const selected = resolve("NO_RENDER_ENDPOINT", {
      tool: "observer_capture",
      action: "capture",
      sessionId: "session-owned-1",
    });

    expect(selected).toEqual({
      kind: "tool",
      tool: "observer_instances",
      input: { sessionId: "session-owned-1" },
      why: "refresh_session_inventory",
    });
    expect(formatObserverRefusalRemedy(selected!)).toContain(
      JSON.stringify({ sessionId: "session-owned-1" })
    );
    expect(resolve("INSTANCE_NOT_FOUND", {
      tool: "observer_capture",
      action: "capture",
    })).toBeNull();
    expect(resolve("INSTANCE_NOT_FOUND", {
      tool: "observer_capture",
      action: "capture",
      sessionId: "bad\nsession",
    })).toBeNull();
  });

  it("uses only an exact consumed runtime ID and never proposes another start", () => {
    const runtimeId = "rt-00000000-0000-4000-8000-000000000042";
    const selected = resolve("PREPARED_LAUNCH_CONSUMED", {
      tool: "observer_runtime",
      action: "start",
    }, { runtimeId });
    const rendered = formatObserverRefusalRemedy(selected!);

    expect(selected).toEqual({
      kind: "tool",
      tool: "observer_runtime",
      input: { action: "status", runtimeId },
      why: "inspect_consumed_runtime",
    });
    expect(rendered).toContain(JSON.stringify({ action: "status", runtimeId }));
    expect(rendered).not.toContain('"action":"start"');
    for (const invalid of [
      undefined,
      "rt-not-a-uuid",
      "rt-00000000-0000-1000-8000-000000000042",
      "rt-00000000-0000-4000-7000-000000000042",
    ]) {
      expect(resolve("PREPARED_LAUNCH_CONSUMED", {
        tool: "observer_runtime",
        action: "start",
      }, { runtimeId: invalid })).toBeNull();
    }
  });

  it("does not read dynamic context for remedies that do not need it", () => {
    const read = vi.fn(() => {
      throw new Error("must not read");
    });

    expect(resolveObserverRefusalRemedy({
      code: "NO_RENDER_ENDPOINT",
      context: {
        tool: "observer_capture",
        action: "capture",
        sessionId: "session-owned-1",
      },
      readRemedyContext: read,
    })).not.toBeNull();
    expect(resolveObserverRefusalRemedy({
      code: "PREPARED_LAUNCH_EXPIRED",
      context: { tool: "observer_runtime", action: "start" },
      readRemedyContext: read,
    })).toBeNull();
    expect(resolveObserverRefusalRemedy({
      code: "PREPARED_LAUNCH_STALE",
      context: { tool: "observer_runtime", action: "start" },
      readRemedyContext: read,
    })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
