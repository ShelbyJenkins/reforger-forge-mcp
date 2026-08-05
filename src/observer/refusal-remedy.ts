import type { CaptureErrorCode } from "./capture-contract.js";

export type ObserverRefusalTool =
  | "observer_setup"
  | "observer_prepare_launch"
  | "observer_instances"
  | "observer_capture"
  | "observer_job"
  | "observer_runtime"
  | "game_launch"
  | "observer_run_begin"
  | "observer_run_status"
  | "observer_run_finalize"
  | "observer_run_discard";

export type ObserverRefusalAction =
  | "ensure"
  | "status"
  | "doctor"
  | "uninstall"
  | "prepare"
  | "list"
  | "capture"
  | "read"
  | "cancel"
  | "release"
  | "start"
  | "stop"
  | "begin"
  | "finalize"
  | "discard";

/** Closed producer/input tags; diagnostic prose is never interpreted as a reason. */
export type ObserverRemedyReason =
  | "display_arguments"
  | "managed_arguments"
  | "command_line_overflow"
  | "owner_token_injection"
  | "nul_argument"
  | "fingerprint_conflict"
  | "runtime_executable_missing";

export interface ObserverRefusalContext {
  readonly tool: ObserverRefusalTool;
  readonly action: ObserverRefusalAction;
  readonly reason?: ObserverRemedyReason;
  readonly sessionId?: string;
}

export type ObserverRefusalRemedy =
  | {
      readonly kind: "tool";
      readonly tool: "observer_instances";
      readonly input: { readonly sessionId: string };
      readonly why: "refresh_session_inventory";
    }
  | {
      readonly kind: "tool";
      readonly tool: "observer_runtime";
      readonly input: { readonly action: "status"; readonly runtimeId: string };
      readonly why: "inspect_consumed_runtime";
    }
  | {
      readonly kind: "external";
      readonly action:
        | "remove_display_arguments"
        | "remove_owner_argument"
        | "configure_runtime_executable"
        | "use_started_runtime_id"
        | "verify_stop_runtime_id";
    };

export interface ObserverRefusalRemedyRequest {
  readonly code: CaptureErrorCode;
  readonly context: ObserverRefusalContext;
  readonly readRemedyContext: () => unknown;
}

export type ObserverRefusalRemedyResolver = (
  request: ObserverRefusalRemedyRequest
) => ObserverRefusalRemedy | null;

const RUNTIME_ID_PATTERN =
  /^rt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 96 &&
    !/[\0-\x1f\x7f]/u.test(value);
}

function dynamicRecord(read: () => unknown): Readonly<Record<string, unknown>> | null {
  const value = read();
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

/** Resolve only operation/reason combinations that prove one safe next action. */
export const resolveObserverRefusalRemedy: ObserverRefusalRemedyResolver = ({
  code,
  context,
  readRemedyContext,
}) => {
  if (code === "ARGUMENT_CONFLICT") {
    if (context.reason === "display_arguments") {
      return { kind: "external", action: "remove_display_arguments" };
    }
    if (context.reason === "owner_token_injection") {
      return { kind: "external", action: "remove_owner_argument" };
    }
    return null;
  }

  if (code === "RUNTIME_NOT_FOUND" &&
      (context.tool === "observer_runtime" || context.tool === "game_launch")) {
    if (context.action === "start") {
      return context.reason === "runtime_executable_missing"
        ? { kind: "external", action: "configure_runtime_executable" }
        : null;
    }
    return context.action === "status"
      ? { kind: "external", action: "use_started_runtime_id" }
      : context.action === "stop"
        ? { kind: "external", action: "verify_stop_runtime_id" }
        : null;
  }

  if ((code === "INSTANCE_NOT_FOUND" || code === "NO_RENDER_ENDPOINT") &&
      validSessionId(context.sessionId)) {
    return {
      kind: "tool",
      tool: "observer_instances",
      input: { sessionId: context.sessionId },
      why: "refresh_session_inventory",
    };
  }

  if (code === "PREPARED_LAUNCH_CONSUMED" &&
      context.tool === "observer_runtime" && context.action === "start") {
    const runtimeId = dynamicRecord(readRemedyContext)?.runtimeId;
    return typeof runtimeId === "string" && RUNTIME_ID_PATTERN.test(runtimeId)
      ? {
          kind: "tool",
          tool: "observer_runtime",
          input: { action: "status", runtimeId },
          why: "inspect_consumed_runtime",
        }
      : null;
  }

  // Expired/stale preparations and all fixed-policy codes deliberately have no
  // presentation-layer mutation. The projector gates fixed codes before this
  // resolver is invoked.
  return null;
};

export function formatObserverRefusalRemedy(remedy: ObserverRefusalRemedy): string {
  if (remedy.kind === "tool") {
    const why = remedy.why === "refresh_session_inventory"
      ? "Use its fresh opaque target for the next renderer-bound operation."
      : "Inspect that exact consumed runtime before deciding whether to stop it.";
    return `\n\nNext action: call ${remedy.tool} with ${JSON.stringify(remedy.input)}. ${why}`;
  }

  switch (remedy.action) {
    case "remove_display_arguments":
      return "\n\nNext action: remove -window, -screenWidth, and -screenHeight from arguments; use forceNonNativeWindowSize only when native fullscreen is unavailable.";
    case "remove_owner_argument":
      return "\n\nNext action: prepare a new descriptor without any runtime owner-token argument; ownership arguments are manager-controlled.";
    case "configure_runtime_executable":
      return "\n\nNext action: correct the configured game path so it contains an allowlisted runtime executable, then prepare a fresh launch if needed.";
    case "use_started_runtime_id":
      return "\n\nNext action: use the exact runtimeId returned by a successful observer_runtime start.";
    case "verify_stop_runtime_id":
      return "\n\nNext action: verify the exact runtimeId from the start result; never stop a process by PID or name.";
  }
}
