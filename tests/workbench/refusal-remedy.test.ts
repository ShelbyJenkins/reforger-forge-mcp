import { describe, expect, it } from "vitest";
import {
  WORKBENCH_REMEDY_RESOLVERS,
  formatWorkbenchRefusal,
} from "../../src/workbench/refusal-remedy.js";
import {
  WorkbenchError,
  type WorkbenchErrorCode,
} from "../../src/workbench/session-controller.js";

const WORKBENCH_ERROR_CODES = [
  "CONNECTION_REFUSED",
  "TIMEOUT",
  "PROTOCOL_ERROR",
  "API_ERROR",
  "LAUNCH_FAILED",
  "PROJECT_COMPILE_FAILED",
  "TARGET_REQUIRED",
  "AMBIGUOUS_TARGET",
  "INVALID_CONFIG",
  "INVALID_TARGET",
  "TARGET_CHANGED",
  "TARGET_CONFLICT",
  "OWNED_BY_OTHER_MCP",
  "UNOWNED_WORKBENCH",
  "ENDPOINT_CONFLICT",
  "USER_CONFLICT",
  "IDENTITY_UNVERIFIABLE",
  "STATE_INVALID",
  "RECOVERY_REQUIRED",
  "UNSUPPORTED_PLATFORM",
  "LIFECYCLE_BUSY",
  "ACTIVE_CAPTURE",
  "CAPTURE_INVALIDATED",
  "UNATTENDED_SAVE_UNSUPPORTED",
  "TARGET_SESSION_REQUIRED",
  "TARGET_SESSION_TAINTED",
  "SAVE_OUTCOME_UNCERTAIN",
] as const satisfies readonly WorkbenchErrorCode[];

describe("Workbench refusal remedies", () => {
  it("has one deliberate fallback decision for every Workbench error code", () => {
    expect(Object.keys(WORKBENCH_REMEDY_RESOLVERS).sort())
      .toEqual([...WORKBENCH_ERROR_CODES].sort());
    expect(WORKBENCH_ERROR_CODES).toHaveLength(27);
  });

  it.each([
    "PROJECT_COMPILE_FAILED",
    "INVALID_CONFIG",
    "TARGET_CONFLICT",
    "UNOWNED_WORKBENCH",
    "RECOVERY_REQUIRED",
    "LIFECYCLE_BUSY",
    "ACTIVE_CAPTURE",
    "CAPTURE_INVALIDATED",
    "TARGET_SESSION_REQUIRED",
    "TARGET_SESSION_TAINTED",
    "SAVE_OUTCOME_UNCERTAIN",
  ] as const)("keeps the overloaded %s fallback producer-only", (code) => {
    expect(WORKBENCH_REMEDY_RESOLVERS[code]).toBeNull();
  });

  it("preserves raw diagnostics and serializes suggested tool input as JSON", () => {
    const message = "raw diagnostic\nC:\\mods\\quoted \\\"project\\\"\\Worlds\\One.ent";
    const input = {
      gprojPath: "C:\\mods\\quoted \\\"project\\\"\\line\nnext\\Example.gproj",
    };
    const rendered = formatWorkbenchRefusal(
      new WorkbenchError(message, "TARGET_REQUIRED", {
        kind: "remedy",
        remedy: {
          kind: "tool",
          tool: "wb_launch",
          input,
          why: "The producer proved the exact target.",
        },
      }),
      { operation: "wb_restart" }
    );

    expect(rendered).toContain(message);
    expect(rendered).toContain(JSON.stringify(input));
    expect(rendered).toContain("`TARGET_REQUIRED` — ");
    expect(rendered.match(/Next action:/g)).toHaveLength(1);
  });

  it("lets every explicit producer decision override the fallback registry", () => {
    const suppressed = formatWorkbenchRefusal(
      new WorkbenchError("missing target", "TARGET_REQUIRED", {
        kind: "no_safe_remedy",
      }),
      { operation: "wb_launch" }
    );
    const owned = formatWorkbenchRefusal(
      new WorkbenchError("already explains recovery", "TARGET_REQUIRED", {
        kind: "message_owns_recovery",
      }),
      { operation: "wb_launch" }
    );
    const retry = formatWorkbenchRefusal(
      new WorkbenchError("operation is active", "LIFECYCLE_BUSY", {
        kind: "remedy",
        remedy: {
          kind: "retry",
          when: "after the active operation reaches a terminal state",
          why: "The current operation remains authoritative.",
        },
      }),
      { operation: "wb_restart" }
    );

    expect(suppressed).not.toContain("Next action:");
    expect(owned).not.toContain("Next action:");
    expect(retry).toContain(
      "Next action: retry wb_restart after the active operation reaches a terminal state."
    );
    expect(retry.match(/Next action:/g)).toHaveLength(1);
  });

  it("uses the original operation for a context-resolved retry instruction", () => {
    const rendered = formatWorkbenchRefusal(
      new WorkbenchError("target is missing", "TARGET_REQUIRED"),
      { operation: "wb_save_resource" }
    );

    expect(rendered).toContain("retry wb_save_resource");
    expect(rendered).not.toContain("retry wb_launch");
  });

  it("explains an ambiguous target as multiple matches rather than unavailable discovery", () => {
    const rendered = formatWorkbenchRefusal(
      new WorkbenchError("multiple projects matched", "AMBIGUOUS_TARGET"),
      { operation: "wb_launch" }
    );

    expect(rendered).toContain("More than one project target matched");
    expect(rendered).not.toContain("discovery is intentionally unavailable");
  });

  it("retains generic error presentation", () => {
    expect(formatWorkbenchRefusal(new Error("generic failure"), {
      operation: "wb_launch",
    })).toBe("generic failure");
    expect(formatWorkbenchRefusal("plain failure", {
      operation: "wb_launch",
    })).toBe("plain failure");
  });
});
