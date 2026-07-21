import { OBSERVER_TERMINAL_STATES } from "./enforce-contract.js";
import { ERROR_REGISTRY } from "./registry.js";

/** The immutable wire vocabulary shared by the two local fixture harnesses. */
export const FAULT_MATRIX_SCHEMA_VERSION = 1 as const;
export const FAULT_MATRIX_PHASES = Object.freeze([
  "before_lease",
  "lease_acquired",
  "capture_in_progress",
  "restoration_in_progress",
  "terminal_release",
] as const);

export type FaultMatrixBackend = "runtime" | "workbench";
export type FaultMatrixPhase = typeof FAULT_MATRIX_PHASES[number];
export type FaultMatrixView = "current" | "pose" | "lookAt" | null;
export type RuntimeFaultAction =
  | "cancel_capture"
  | "replace_runtime_world"
  | "disconnect_private_agent"
  | "stop_owned_runtime";
export type WorkbenchFaultAction =
  | "cancel_capture"
  | "disable_fixture_handler"
  | "submit_competing_capture"
  | "replace_fixture_world"
  | "write_invalid_artifact"
  | "stop_owned_workbench";
export type FaultMatrixAction = RuntimeFaultAction | WorkbenchFaultAction;
/** Kept in the protocol project so the matrix does not create a reverse build dependency. */
export type ObserverErrorCode = keyof typeof ERROR_REGISTRY;

export type MatrixEvidenceField =
  | "public_terminal"
  | "deadline"
  | "world_revision"
  | "camera"
  | "artifact"
  | "cleanup"
  | "retained_diagnostics";
export type MatrixRequiredCheck =
  | "lifecycle_vacant"
  | "endpoint_vacant"
  | "child_vacant"
  | "exact_owner_vacant";

/** Canonical public terminal shape shared by declarations and evidence. */
export interface FaultMatrixTerminal {
  readonly state: typeof OBSERVER_TERMINAL_STATES[number];
  readonly errorCode: ObserverErrorCode | null;
}

export interface ObservablePhaseSupport {
  readonly kind: "observable";
  /** A public status predicate, never a source-location instruction. */
  readonly publicStatusPredicate: string;
  /** The matching fixture acknowledgement at the action boundary. */
  readonly fixtureAcknowledgement: string;
}

export interface NotApplicablePhaseSupport {
  readonly kind: "not_applicable";
  readonly rationale: string;
}

export type PhaseSupport = ObservablePhaseSupport | NotApplicablePhaseSupport;
export type PhaseSupportMap = Readonly<Record<FaultMatrixPhase, PhaseSupport>>;

interface FaultMatrixCaseBase<Backend extends FaultMatrixBackend, Action extends FaultMatrixAction> {
  readonly schemaVersion: typeof FAULT_MATRIX_SCHEMA_VERSION;
  readonly id: string;
  readonly backend: Backend;
  readonly view: FaultMatrixView;
  readonly injection: { readonly phase: FaultMatrixPhase; readonly action: Action };
  readonly phaseSupport: PhaseSupportMap;
  readonly expectedTerminal: FaultMatrixTerminal;
  readonly cameraDisposition: "restored" | "exact_process_exit" | "not_acquired";
  readonly requiredChecks: readonly MatrixRequiredCheck[];
  readonly requiredEvidence: readonly MatrixEvidenceField[];
}

export interface RuntimeFaultMatrixCase extends FaultMatrixCaseBase<"runtime", RuntimeFaultAction> {}
export interface WorkbenchFaultMatrixCase extends FaultMatrixCaseBase<"workbench", WorkbenchFaultAction> {}
export type FaultMatrixCase = RuntimeFaultMatrixCase | WorkbenchFaultMatrixCase;

export interface FaultMatrix {
  readonly schemaVersion: typeof FAULT_MATRIX_SCHEMA_VERSION;
  readonly cases: readonly FaultMatrixCase[];
  readonly caseIds: readonly string[];
  /** A read-only facade; it intentionally exposes no Map mutator at runtime. */
  readonly byId: ReadonlyMap<string, FaultMatrixCase>;
}

const CASE_ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){3,5}$/;
const PHASE_SET = new Set<string>(FAULT_MATRIX_PHASES);
const TERMINAL_STATE_SET = new Set<string>(OBSERVER_TERMINAL_STATES);
const CHECK_SET = new Set<MatrixRequiredCheck>([
  "lifecycle_vacant", "endpoint_vacant", "child_vacant", "exact_owner_vacant",
]);
const EVIDENCE_SET = new Set<MatrixEvidenceField>([
  "public_terminal", "deadline", "world_revision", "camera", "artifact", "cleanup", "retained_diagnostics",
]);

/** Every declared action is constrained before any fixture process can start. */
export const FAULT_ACTION_PHASES: Readonly<Record<FaultMatrixBackend, Readonly<Record<string, readonly FaultMatrixPhase[]>>>> = Object.freeze({
  runtime: Object.freeze({
    // Cancellation is the common probe used to prove both the pre-acquisition
    // and terminal-before-release barriers. The other actions deliberately
    // retain narrower declared sets so invalid phase/action schedules remain
    // fail-closed rather than becoming a runner convention.
    cancel_capture: FAULT_MATRIX_PHASES,
    replace_runtime_world: Object.freeze(["lease_acquired", "capture_in_progress"] as const),
    disconnect_private_agent: Object.freeze(["lease_acquired", "capture_in_progress", "restoration_in_progress"] as const),
    stop_owned_runtime: Object.freeze(["lease_acquired", "capture_in_progress", "restoration_in_progress"] as const),
  }),
  workbench: Object.freeze({
    cancel_capture: FAULT_MATRIX_PHASES,
    disable_fixture_handler: Object.freeze(["lease_acquired", "capture_in_progress"] as const),
    submit_competing_capture: Object.freeze(["lease_acquired", "capture_in_progress"] as const),
    replace_fixture_world: Object.freeze(["lease_acquired", "capture_in_progress"] as const),
    write_invalid_artifact: Object.freeze(["capture_in_progress"] as const),
    stop_owned_workbench: Object.freeze(["lease_acquired", "capture_in_progress", "restoration_in_progress"] as const),
  }),
});

function fail(message: string): never {
  throw new Error(`Invalid fault matrix: ${message}`);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reject arbitrary state/error strings before they reach portable evidence. */
export function isCanonicalFaultMatrixTerminal(value: unknown): value is FaultMatrixTerminal {
  if (!plainRecord(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "state") || !Object.hasOwn(value, "errorCode") ||
      typeof value.state !== "string" || !TERMINAL_STATE_SET.has(value.state)) {
    return false;
  }
  const errorCode = value.errorCode;
  if (errorCode !== null && (typeof errorCode !== "string" || !Object.hasOwn(ERROR_REGISTRY, errorCode))) return false;
  return (value.state !== "completed" && value.state !== "cancelled") || errorCode === null;
}

function nonEmptyProof(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\0\r\n]/.test(value)) {
    fail(`${label} must be a bounded non-empty string`);
  }
  // A synchronization proof belongs to a public predicate plus fixture acknowledgement,
  // not a source line or an implementation instruction.
  if (/(?:\bawait\b|\bline\s*\d|\.ts\b|\.c\b|[\\/]|`)/i.test(value)) {
    fail(`${label} must be observable rather than source-oriented`);
  }
}

function validatePhaseSupport(value: unknown, phase: FaultMatrixPhase, injectionPhase: FaultMatrixPhase): void {
  if (!plainRecord(value)) fail(`phaseSupport.${phase} is not an object`);
  if (value.kind === "not_applicable") {
    if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "rationale")) {
      fail(`phaseSupport.${phase} must have an exact not-applicable shape`);
    }
    nonEmptyProof(value.rationale, `phaseSupport.${phase}.rationale`);
    if (phase === injectionPhase) fail("injection phase cannot be not applicable");
    return;
  }
  if (value.kind !== "observable" || Object.keys(value).length !== 3 ||
      !Object.hasOwn(value, "publicStatusPredicate") || !Object.hasOwn(value, "fixtureAcknowledgement")) {
    fail(`phaseSupport.${phase} must have an exact observable shape`);
  }
  nonEmptyProof(value.publicStatusPredicate, `phaseSupport.${phase}.publicStatusPredicate`);
  nonEmptyProof(value.fixtureAcknowledgement, `phaseSupport.${phase}.fixtureAcknowledgement`);
}

function uniqueKnownValues<T extends string>(
  values: unknown,
  known: ReadonlySet<T>,
  label: string
): asserts values is readonly T[] {
  if (!Array.isArray(values) || values.length < 1 || values.some((value) => typeof value !== "string" || !known.has(value as T)) ||
      new Set(values).size !== values.length) {
    fail(`${label} must contain unique known values`);
  }
}

function viewId(view: FaultMatrixView): string {
  return view === null ? "na" : view === "lookAt" ? "lookat" : view;
}

function validateCase(caseValue: unknown, seenObjects: Set<object>, ids: Set<string>): asserts caseValue is FaultMatrixCase {
  if (!plainRecord(caseValue)) fail("case is not an object");
  if (seenObjects.has(caseValue as object)) fail("duplicate case object");
  seenObjects.add(caseValue as object);
  const expectedKeys = [
    "schemaVersion", "id", "backend", "view", "injection", "phaseSupport", "expectedTerminal",
    "cameraDisposition", "requiredChecks", "requiredEvidence",
  ];
  const keys = Object.keys(caseValue).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== [...expectedKeys].sort()[index])) {
    fail("case has unexpected or missing fields");
  }
  if (caseValue.schemaVersion !== FAULT_MATRIX_SCHEMA_VERSION) fail("unsupported schema version");
  if (typeof caseValue.id !== "string" || !CASE_ID.test(caseValue.id)) fail("case has a malformed ID");
  if (ids.has(caseValue.id)) fail(`duplicate case ID ${caseValue.id}`);
  ids.add(caseValue.id);
  if (caseValue.backend !== "runtime" && caseValue.backend !== "workbench") fail("case has an unknown backend");
  if (caseValue.view !== null && caseValue.view !== "current" && caseValue.view !== "pose" && caseValue.view !== "lookAt") {
    fail("case has an unknown view");
  }
  if (!plainRecord(caseValue.injection) || Object.keys(caseValue.injection).length !== 2 ||
      !Object.hasOwn(caseValue.injection, "phase") || !Object.hasOwn(caseValue.injection, "action") ||
      typeof caseValue.injection.phase !== "string" || !PHASE_SET.has(caseValue.injection.phase) ||
      typeof caseValue.injection.action !== "string") {
    fail("case has an invalid injection");
  }
  const declaredActions = FAULT_ACTION_PHASES[caseValue.backend] as Readonly<Record<string, readonly FaultMatrixPhase[]>>;
  const actionPhases = declaredActions[caseValue.injection.action];
  if (!actionPhases) fail("case action is incompatible with its backend");
  if (!actionPhases.includes(caseValue.injection.phase as FaultMatrixPhase)) {
    fail("case action is incompatible with its injection phase");
  }
  const idParts = caseValue.id.split(".");
  if (idParts.length !== 4 || idParts[0] !== caseValue.backend || idParts[1] !== caseValue.injection.action ||
      idParts[2] !== caseValue.injection.phase || idParts[3] !== viewId(caseValue.view)) {
    fail("case ID does not agree with its schedule");
  }
  const phaseSupport = caseValue.phaseSupport;
  if (!plainRecord(phaseSupport) ||
      Object.keys(phaseSupport).length !== FAULT_MATRIX_PHASES.length ||
      !FAULT_MATRIX_PHASES.every((phase) => Object.hasOwn(phaseSupport, phase))) {
    fail("case phaseSupport must name every canonical phase");
  }
  for (const phase of FAULT_MATRIX_PHASES) {
    validatePhaseSupport(phaseSupport[phase], phase, caseValue.injection.phase as FaultMatrixPhase);
  }
  if (!isCanonicalFaultMatrixTerminal(caseValue.expectedTerminal)) fail("case has an invalid expected terminal result");
  if (caseValue.cameraDisposition !== "restored" && caseValue.cameraDisposition !== "exact_process_exit" &&
      caseValue.cameraDisposition !== "not_acquired") {
    fail("case has an invalid camera disposition");
  }
  if (caseValue.cameraDisposition === "not_acquired" &&
      FAULT_MATRIX_PHASES.indexOf(caseValue.injection.phase as FaultMatrixPhase) >= FAULT_MATRIX_PHASES.indexOf("lease_acquired")) {
    fail("not-acquired camera disposition is invalid after lease acquisition");
  }
  uniqueKnownValues(caseValue.requiredChecks, CHECK_SET, "case requiredChecks");
  uniqueKnownValues(caseValue.requiredEvidence, EVIDENCE_SET, "case requiredEvidence");
  if (caseValue.cameraDisposition === "exact_process_exit" && !caseValue.requiredChecks.includes("exact_owner_vacant")) {
    fail("exact-process-exit camera disposition requires exact-owner vacancy evidence");
  }
}

/** Validate untrusted or test-created case declarations before launching a fixture. */
export function validateFaultMatrix(cases: readonly FaultMatrixCase[]): void {
  if (!Array.isArray(cases)) fail("catalog is not an array");
  const objects = new Set<object>();
  const ids = new Set<string>();
  for (const item of cases) validateCase(item, objects, ids);
}

function cloneAndFreeze<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value as object)) return seen.get(value as object) as T;
  const clone: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  seen.set(value as object, clone);
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    (clone as Record<string, unknown>)[key] = cloneAndFreeze(member, seen);
  }
  return Object.freeze(clone) as T;
}

/**
 * `Object.freeze(new Map())` still permits `set()` and `delete()`. Keep the
 * mutable index private and expose only the ReadonlyMap operations required by
 * catalog consumers.
 */
function immutableCaseIndex(cases: readonly FaultMatrixCase[]): ReadonlyMap<string, FaultMatrixCase> {
  const index = new Map(cases.map((item) => [item.id, item] as const));
  const readonlyIndex: ReadonlyMap<string, FaultMatrixCase> = {
    get size(): number { return index.size; },
    get: index.get.bind(index),
    has: index.has.bind(index),
    entries: index.entries.bind(index),
    keys: index.keys.bind(index),
    values: index.values.bind(index),
    forEach(callbackfn, thisArg): void {
      index.forEach((value, key) => callbackfn.call(thisArg, value, key, readonlyIndex));
    },
    [Symbol.iterator]: index[Symbol.iterator].bind(index),
  };
  return Object.freeze(readonlyIndex);
}

/** Clone, validate, index, and deep-freeze a catalog so runners cannot mutate schedules. */
export function defineFaultMatrix(cases: readonly FaultMatrixCase[]): FaultMatrix {
  validateFaultMatrix(cases);
  // Canonical catalog order is stable regardless of the order in which a
  // backend appends declarations. Evidence and source identity consume this
  // order directly, so preserving caller order would be observable drift.
  const ordered = [...cases].sort((left, right) => left.id.localeCompare(right.id));
  const cloned = cloneAndFreeze(ordered) as readonly FaultMatrixCase[];
  const byId = immutableCaseIndex(cloned);
  return Object.freeze({
    schemaVersion: FAULT_MATRIX_SCHEMA_VERSION,
    cases: cloned,
    caseIds: Object.freeze(cloned.map((item) => item.id)),
    byId,
  });
}

export function caseForId(matrix: FaultMatrix, caseId: string): FaultMatrixCase {
  if (!matrix || matrix.schemaVersion !== FAULT_MATRIX_SCHEMA_VERSION || typeof caseId !== "string") {
    throw new Error("Unknown fault-matrix case");
  }
  const item = matrix.byId.get(caseId);
  if (!item) throw new Error(`Unknown fault-matrix case: ${caseId}`);
  return item;
}

const RUNTIME_CANCEL_LEASE_ACQUIRED_POSE: RuntimeFaultMatrixCase = {
  schemaVersion: FAULT_MATRIX_SCHEMA_VERSION,
  id: "runtime.cancel_capture.lease_acquired.pose",
  backend: "runtime",
  view: "pose",
  injection: { phase: "lease_acquired", action: "cancel_capture" },
  phaseSupport: {
    before_lease: {
      kind: "not_applicable",
      rationale: "This is the Phase 2 pilot case; it injects only at lease_acquired. The remaining canonical cancellation phases are deferred until the pilot's live run and measured timing land.",
    },
    lease_acquired: {
      kind: "observable",
      publicStatusPredicate: "the public job state equals acquiringCamera and its cameraLease held field equals true for the same job and world epoch",
      fixtureAcknowledgement: "RFO_RuntimeMatrixControl observed cameraWasAcquired true and an outstanding camera lease for the armed job before the job advanced past acquiringCamera",
    },
    capture_in_progress: {
      kind: "not_applicable",
      rationale: "This is the Phase 2 pilot case; it injects only at lease_acquired. The remaining canonical cancellation phases are deferred until the pilot's live run and measured timing land.",
    },
    restoration_in_progress: {
      kind: "not_applicable",
      rationale: "This is the Phase 2 pilot case; it injects only at lease_acquired. The remaining canonical cancellation phases are deferred until the pilot's live run and measured timing land.",
    },
    terminal_release: {
      kind: "not_applicable",
      rationale: "This is the Phase 2 pilot case; it injects only at lease_acquired. The remaining canonical cancellation phases are deferred until the pilot's live run and measured timing land.",
    },
  },
  // A cancelled terminal state carries no errorCode: the runtime wire protocol
  // (RFO_ObserverService.BuildStatusJson) only publishes errorCode for a
  // failed state, and isCanonicalFaultMatrixTerminal enforces the same rule.
  expectedTerminal: { state: "cancelled", errorCode: null },
  cameraDisposition: "restored",
  requiredChecks: ["lifecycle_vacant", "endpoint_vacant", "child_vacant", "exact_owner_vacant"],
  requiredEvidence: ["public_terminal", "deadline", "world_revision", "camera", "artifact", "cleanup"],
};

const WORKBENCH_CANCEL_LEASE_ACQUIRED_POSE: WorkbenchFaultMatrixCase = {
  schemaVersion: FAULT_MATRIX_SCHEMA_VERSION,
  id: "workbench.cancel_capture.lease_acquired.pose",
  backend: "workbench",
  view: "pose",
  injection: { phase: "lease_acquired", action: "cancel_capture" },
  phaseSupport: {
    before_lease: {
      kind: "not_applicable",
      rationale: "This is the Phase 3 vertical-slice case; it injects only at lease_acquired. Workbench Submit is a single synchronous NET API call with no repeated poll point before the lease is retained, so a before_lease barrier has no observable hold point yet. The remaining canonical phases are deferred until this slice has a retained live result.",
    },
    lease_acquired: {
      kind: "observable",
      publicStatusPredicate: "the handler job state equals accepted or settling and cameraLeaseHeld equals true for the same job and handler lease",
      fixtureAcknowledgement: "RFO_WorkbenchObserverMatrixPlugin observed OnLeaseAcquiredBarrier held before Advance progressed settle polling for the armed job",
    },
    capture_in_progress: {
      kind: "not_applicable",
      rationale: "This is the Phase 3 vertical-slice case; it injects only at lease_acquired. The remaining canonical phases are deferred until this slice has a retained live result and measured timing to budget against.",
    },
    restoration_in_progress: {
      kind: "not_applicable",
      rationale: "This is the Phase 3 vertical-slice case; it injects only at lease_acquired. The remaining canonical phases are deferred until this slice has a retained live result and measured timing to budget against.",
    },
    terminal_release: {
      kind: "not_applicable",
      rationale: "This is the Phase 3 vertical-slice case; it injects only at lease_acquired. The remaining canonical phases are deferred until this slice has a retained live result and measured timing to budget against.",
    },
  },
  // A cancelled terminal state carries no errorCode: EMCP_WB_ObserverJobResponse
  // only publishes terminalErrorCode for a failed state, and
  // isCanonicalFaultMatrixTerminal enforces the same rule.
  expectedTerminal: { state: "cancelled", errorCode: null },
  cameraDisposition: "restored",
  requiredChecks: ["lifecycle_vacant", "endpoint_vacant", "child_vacant", "exact_owner_vacant"],
  requiredEvidence: ["public_terminal", "deadline", "world_revision", "camera", "artifact", "cleanup"],
};

/**
 * Phase 2 pilot: exactly one end-to-end runtime case, per the phase-2 plan's
 * explicit pilot-first sequencing. Additional cancellation phases and the
 * other fault families (world loss, transport loss, owned shutdown) are
 * deliberately deferred until this pilot has a retained live result and
 * measured per-case timing to budget against. Success-path cases are not
 * declared here: the shared fault-matrix schema (Phase 1) has no "no fault"
 * injection action, and the existing positive-path script already proves the
 * success path; extending that shared contract is out of scope for one pilot.
 *
 * Phase 3 vertical slice: one end-to-end Workbench case
 * (WB-CANCEL-LEASE-ACQUIRED-POSE), matching the same pilot-first sequencing
 * before the full Workbench case table (cancellation at every phase,
 * transport loss, lease contention, world loss, artifact failure, owned
 * shutdown, terminal-release idempotency) is added.
 */
export const OBSERVER_FAULT_MATRIX = defineFaultMatrix([
  RUNTIME_CANCEL_LEASE_ACQUIRED_POSE,
  WORKBENCH_CANCEL_LEASE_ACQUIRED_POSE,
]);
