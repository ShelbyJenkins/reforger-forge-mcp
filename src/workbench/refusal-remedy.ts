import {
  WorkbenchError,
  type WorkbenchErrorCode,
} from "./session-controller.js";

export type WorkbenchRemedy =
  | {
      readonly kind: "tool";
      readonly tool: string;
      readonly input: object;
      readonly why: string;
    }
  | {
      readonly kind: "retry";
      readonly when: string;
      readonly why: string;
    }
  | {
      readonly kind: "external";
      readonly action: string;
      readonly why: string;
    };

export type WorkbenchProducerRemedyDecision =
  | { readonly kind: "remedy"; readonly remedy: WorkbenchRemedy }
  | { readonly kind: "message_owns_recovery" }
  | { readonly kind: "no_safe_remedy" };

export interface WorkbenchRefusalContext {
  readonly operation: string;
  readonly gprojPath?: string;
  readonly resourcePath?: string;
  readonly originalInput?: Readonly<Record<string, unknown>>;
}

export type WorkbenchRemedyResolver = (
  context: WorkbenchRefusalContext
) => WorkbenchRemedy | null;

const diagnose = (why: string): WorkbenchRemedy => ({
  kind: "tool",
  tool: "wb_diagnose",
  input: {},
  why,
});

const exactProjectRequired = (
  context: WorkbenchRefusalContext
): WorkbenchRemedy => ({
  kind: "external",
  action:
    `Provide an exact absolute .gproj path as gprojPath, then retry ${context.operation}.`,
  why: "Cold Workbench project discovery is intentionally unavailable.",
});

/**
 * Exhaustive fallback policy for errors that do not carry a producer decision.
 *
 * A null entry is deliberate: the code is overloaded or the raw producer
 * diagnostic already contains the only evidence needed to choose a safe action.
 */
export const WORKBENCH_REMEDY_RESOLVERS = {
  CONNECTION_REFUSED: () => diagnose(
    "It distinguishes an absent editor from an endpoint, helper, or ownership failure."
  ),
  TIMEOUT: () => diagnose(
    "It preserves the timed-out operation while inspecting the exact lifecycle and endpoint."
  ),
  PROTOCOL_ERROR: () => diagnose(
    "It checks the exact managed helper and NET API compatibility."
  ),
  API_ERROR: () => diagnose(
    "It reports the exact editor, helper, and target state without retrying the failed mutation."
  ),
  LAUNCH_FAILED: () => diagnose(
    "It inspects the exact launch transaction and attributed Workbench evidence."
  ),
  PROJECT_COMPILE_FAILED: null,
  TARGET_REQUIRED: exactProjectRequired,
  AMBIGUOUS_TARGET: exactProjectRequired,
  INVALID_CONFIG: null,
  INVALID_TARGET: () => ({
    kind: "external",
    action: "Correct the exact project or resource path before retrying.",
    why: "The rejected target was not safe to canonicalize or use.",
  }),
  TARGET_CHANGED: () => diagnose(
    "It re-inspects the recorded target identity before any later retry."
  ),
  TARGET_CONFLICT: null,
  OWNED_BY_OTHER_MCP: () => ({
    kind: "external",
    action: "Continue through the MCP instance that owns the recorded Workbench lifecycle.",
    why: "This MCP cannot claim or stop another live owner's exact process.",
  }),
  UNOWNED_WORKBENCH: null,
  ENDPOINT_CONFLICT: () => diagnose(
    "It identifies the recorded and configured NET API endpoints without taking ownership."
  ),
  USER_CONFLICT: () => ({
    kind: "external",
    action: "Use the Windows user that owns the recorded lifecycle, or close that lifecycle there.",
    why: "Cross-user Workbench ownership cannot be transferred safely."
  }),
  IDENTITY_UNVERIFIABLE: () => diagnose(
    "It reports which exact process, endpoint, target, or helper proof is missing."
  ),
  STATE_INVALID: () => diagnose(
    "It inspects the durable lifecycle record without guessing a repair."
  ),
  RECOVERY_REQUIRED: null,
  UNSUPPORTED_PLATFORM: () => ({
    kind: "external",
    action: "Run the Workbench lifecycle tools on a supported Windows host.",
    why: "Their process-identity and lifecycle guarantees depend on Windows APIs."
  }),
  LIFECYCLE_BUSY: null,
  ACTIVE_CAPTURE: null,
  CAPTURE_INVALIDATED: null,
  UNATTENDED_SAVE_UNSUPPORTED: () => ({
    kind: "external",
    action: "Use the attended editor to review and save the resource.",
    why: "The requested save cannot be proven safe through the bounded automated path."
  }),
  TARGET_SESSION_REQUIRED: null,
  TARGET_SESSION_TAINTED: null,
  SAVE_OUTCOME_UNCERTAIN: null,
} satisfies Record<WorkbenchErrorCode, WorkbenchRemedyResolver | null>;

function resolveRemedy(
  error: WorkbenchError,
  context: WorkbenchRefusalContext
): WorkbenchRemedy | null {
  const decision = error.remedyDecision;
  if (decision) {
    return decision.kind === "remedy" ? decision.remedy : null;
  }
  const resolver = WORKBENCH_REMEDY_RESOLVERS[error.code];
  return resolver ? resolver(context) : null;
}

function formatRemedy(
  remedy: WorkbenchRemedy,
  context: WorkbenchRefusalContext
): string {
  switch (remedy.kind) {
    case "tool":
      return `Next action: call ${remedy.tool} with ${JSON.stringify(remedy.input)}. ${remedy.why}`;
    case "retry":
      return `Next action: retry ${context.operation} ${remedy.when}. ${remedy.why}`;
    case "external":
      return `Next action: ${remedy.action} ${remedy.why}`;
  }
}

function appendRemedy(
  message: string,
  error: WorkbenchError,
  context: WorkbenchRefusalContext
): string {
  try {
    const remedy = resolveRemedy(error, context);
    return remedy ? `${message}\n\n${formatRemedy(remedy, context)}` : message;
  } catch {
    // Presentation must never replace or hide the producer's raw diagnostic.
    return message;
  }
}

/** Format a coded Workbench refusal for tool boundaries that own the envelope. */
export function formatWorkbenchRefusal(
  error: unknown,
  context: WorkbenchRefusalContext
): string {
  if (!(error instanceof WorkbenchError)) {
    return error instanceof Error ? error.message : String(error);
  }
  return appendRemedy(`\`${error.code}\` — ${error.message}`, error, context);
}

/**
 * Preserve a boundary's existing prose wrapper while still applying the same
 * typed remedy policy. wb_state intentionally uses this form.
 */
export function formatWorkbenchRefusalMessage(
  error: unknown,
  context: WorkbenchRefusalContext
): string {
  if (!(error instanceof WorkbenchError)) {
    return error instanceof Error ? error.message : String(error);
  }
  return appendRemedy(error.message, error, context);
}
