import {
  JOB_STATES,
  PROTOCOL_VERSION,
  SESSION_CONTRACT_NAME,
  SESSION_DIRECTORY_NAME,
  TERMINAL_JOB_STATES,
  WORKBENCH_OBSERVER_ADAPTER_PROTOCOL,
} from "./constants.js";
import {
  CAPABILITY_REGISTRY,
  ERROR_REGISTRY,
  type ObserverCapabilityDefinition,
  type ObserverErrorDefinition,
} from "./registry.js";

/** A generated Enforce module is intentionally specific to one script module. */
export type EnforceTarget = "game" | "workbench";

export interface EnforceStringValue {
  readonly field: string;
  readonly value: string;
}

export interface EnforceNumberValue {
  readonly field: string;
  readonly value: number;
  readonly kind: "int" | "float";
}

/**
 * Values in this ledger stay local to their respective Enforce consumer. They
 * are descriptor evidence, not an instruction to emit a falsely shared value.
 */
export interface BackendTuningEntry {
  readonly owner: "runtime" | "workbench";
  readonly source: string;
  readonly value: number;
  readonly reason: string;
  readonly acceptance: string;
}

export interface EnforceTargetContract {
  readonly className: string;
  readonly outputPath: string;
  readonly strings: readonly EnforceStringValue[];
  readonly numbers: readonly EnforceNumberValue[];
}

export interface ObserverEnforceContract {
  readonly descriptorVersion: 1;
  readonly identities: {
    readonly runtimeObserver: string;
    readonly workbenchAdapter: string;
    /** Descriptor-only evidence. The helper lifecycle package remains its owner. */
    readonly workbenchHelperBundle: string;
  };
  readonly terminalStates: readonly string[];
  readonly targets: Readonly<Record<EnforceTarget, EnforceTargetContract>>;
  readonly backendTuning: readonly BackendTuningEntry[];
}

/**
 * A small input seam lets generator tests use a synthetic registry without
 * mutating the production registry. Scalar values default to the canonical
 * observer protocol when omitted.
 */
export interface EnforceContractSource {
  readonly errorRegistry: Readonly<Record<string, ObserverErrorDefinition>>;
  readonly capabilityRegistry: Readonly<Record<string, ObserverCapabilityDefinition>>;
  readonly runtimeObserverProtocol?: string;
  readonly workbenchAdapterProtocol?: string;
  readonly workbenchHelperBundleProtocol?: string;
  readonly sessionDirectoryName?: string;
  readonly sessionContractName?: string;
  readonly jobStates?: readonly string[];
  readonly terminalJobStates?: readonly string[];
}

export const GAME_ENFORCE_PROTOCOL_OUTPUT =
  "observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverProtocol.c" as const;
export const WORKBENCH_ENFORCE_PROTOCOL_OUTPUT =
  "observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ObserverProtocol.c" as const;

/**
 * The helper bundle owns this identity in helper-addon.ts/RFWB_HelperBuild.c.
 * Keep only a descriptor assertion here: importing helper-addon.ts would make
 * the observer protocol package depend on Workbench lifecycle code.
 */
export const WORKBENCH_HELPER_BUNDLE_PROTOCOL_DESCRIPTOR = "2.0" as const;

/** The host adapter imports these named values instead of owning duplicates. */
export const WORKBENCH_ADAPTER_PROTOCOL = WORKBENCH_OBSERVER_ADAPTER_PROTOCOL;
export const OBSERVER_TERMINAL_STATES = TERMINAL_JOB_STATES;
export const WORKBENCH_ADAPTER_TERMINAL_STATES = OBSERVER_TERMINAL_STATES;

type ErrorCodeForBackend<Backend extends string> = {
  [Code in keyof typeof ERROR_REGISTRY]: Backend extends (typeof ERROR_REGISTRY)[Code]["backends"][number]
    ? Code
    : never;
}[keyof typeof ERROR_REGISTRY];

type CapabilityForBackend<Backend extends string> = {
  [Capability in keyof typeof CAPABILITY_REGISTRY]: Backend extends (typeof CAPABILITY_REGISTRY)[Capability]["backends"][number]
    ? Capability
    : never;
}[keyof typeof CAPABILITY_REGISTRY];

export type WorkbenchObserverProtocolErrorCode = ErrorCodeForBackend<"workbench">;
export type WorkbenchObserverProtocolCapability = CapabilityForBackend<"workbench">;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid observer Enforce contract: ${message}`);
}

function fieldSuffix(value: string): string {
  assert(!value.includes("\0"), "Enforce values must not contain NUL");
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  assert(/^[A-Z][A-Z0-9_]*$/.test(normalized), `cannot derive a stable field name from ${JSON.stringify(value)}`);
  return normalized;
}

function field(prefix: string, value: string): string {
  assert(/^[A-Z][A-Z0-9_]*$/.test(prefix), `invalid Enforce field prefix ${JSON.stringify(prefix)}`);
  return `${prefix}_${fieldSuffix(value)}`;
}

function selectBackendEntries<T extends { readonly backends: readonly string[] }>(
  registry: Readonly<Record<string, T>>,
  backend: "runtime" | "workbench"
): readonly (readonly [string, T])[] {
  return Object.entries(registry).filter(([, definition]) => definition.backends.includes(backend));
}

/**
 * Workbench exposes only the response states its handlers can emit. Numeric
 * positions deliberately select canonical JOB_STATES rather than copying state
 * spellings into a second source of truth: accepted, settling, capturing,
 * awaiting-artifact, and restoring, followed by the canonical terminal set.
 */
const WORKBENCH_NON_TERMINAL_JOB_STATE_INDEXES = [2, 7, 8, 9, 10] as const;

function workbenchResponseStates(
  jobStates: readonly string[],
  terminalJobStates: readonly string[]
): readonly string[] {
  for (const index of WORKBENCH_NON_TERMINAL_JOB_STATE_INDEXES) {
    assert(index < jobStates.length, "canonical job-state set is missing a Workbench response state");
  }
  const selectedIndexes = new Set<number>(WORKBENCH_NON_TERMINAL_JOB_STATE_INDEXES);
  const terminal = new Set(terminalJobStates);
  return jobStates.filter((state, index) => selectedIndexes.has(index) || terminal.has(state));
}

function targetValueMap(
  contract: ObserverEnforceContract,
  target: EnforceTarget,
  prefix: string
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    contract.targets[target].strings
      .filter((entry) => entry.field.startsWith(prefix))
      .map((entry) => [entry.field.slice(prefix.length), entry.value])
  ));
}

/**
 * Build the derived target ledger. This is the only place that translates
 * canonical registry values into Enforce member names.
 */
export function createObserverEnforceContract(source: EnforceContractSource): ObserverEnforceContract {
  const runtimeObserver = source.runtimeObserverProtocol ?? PROTOCOL_VERSION;
  const workbenchAdapter = source.workbenchAdapterProtocol ?? WORKBENCH_OBSERVER_ADAPTER_PROTOCOL;
  const workbenchHelperBundle = source.workbenchHelperBundleProtocol ?? WORKBENCH_HELPER_BUNDLE_PROTOCOL_DESCRIPTOR;
  const sessionDirectoryName = source.sessionDirectoryName ?? SESSION_DIRECTORY_NAME;
  const sessionContractName = source.sessionContractName ?? SESSION_CONTRACT_NAME;
  const jobStates = source.jobStates ?? JOB_STATES;
  const terminalStates = source.terminalJobStates ?? TERMINAL_JOB_STATES;

  assert(jobStates.length > 0, "job-state vocabulary must not be empty");
  assert(terminalStates.length > 0, "terminal-state vocabulary must not be empty");
  assert(new Set(jobStates).size === jobStates.length, "job-state vocabulary must be unique");
  assert(new Set(terminalStates).size === terminalStates.length, "terminal-state vocabulary must be unique");
  assert(terminalStates.every((state) => jobStates.includes(state)), "terminal states must belong to job states");

  const gameStrings: EnforceStringValue[] = [
    { field: "RUNTIME_PROTOCOL_VERSION", value: runtimeObserver },
    ...jobStates.map((state) => ({ field: field("STATE", state), value: state })),
    ...selectBackendEntries(source.errorRegistry, "runtime")
      .map(([code]) => ({ field: field("ERROR", code), value: code })),
    ...selectBackendEntries(source.capabilityRegistry, "runtime")
      .map(([capability]) => ({ field: field("CAP", capability), value: capability })),
    { field: "DIRECTORY_SESSION_ROOT", value: sessionDirectoryName },
    { field: "FILE_SESSION_CONTRACT", value: sessionContractName },
  ];

  const workbenchStrings: EnforceStringValue[] = [
    { field: "ADAPTER_PROTOCOL", value: workbenchAdapter },
    ...workbenchResponseStates(jobStates, terminalStates)
      .map((state) => ({ field: field("STATE", state), value: state })),
    ...selectBackendEntries(source.errorRegistry, "workbench")
      .map(([code]) => ({ field: field("ERROR", code), value: code })),
    ...selectBackendEntries(source.capabilityRegistry, "workbench")
      .map(([capability]) => ({ field: field("CAP", capability), value: capability })),
    // Workbench composes its local "$profile:" prefix and "workbench" leaf;
    // only the reviewed shared observer directory segment crosses this boundary.
    { field: "DIRECTORY_SESSION_ROOT", value: sessionDirectoryName },
  ];

  const contract: ObserverEnforceContract = {
    descriptorVersion: 1,
    identities: { runtimeObserver, workbenchAdapter, workbenchHelperBundle },
    terminalStates: [...terminalStates],
    targets: {
      game: {
        className: "RFO_ObserverProtocol",
        outputPath: GAME_ENFORCE_PROTOCOL_OUTPUT,
        strings: gameStrings,
        numbers: [],
      },
      workbench: {
        className: "EMCP_WB_ObserverProtocol",
        outputPath: WORKBENCH_ENFORCE_PROTOCOL_OUTPUT,
        strings: workbenchStrings,
        numbers: [],
      },
    },
    backendTuning: [
      {
        owner: "runtime",
        source: "observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverCameraProjection.c",
        value: 0.001,
        reason: "Runtime camera-projection matrix comparison.",
        acceptance: "Runtime capture/restoration acceptance.",
      },
      {
        owner: "workbench",
        source: "observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ObserverCommon.c",
        value: 0.0001,
        reason: "Exact Workbench editor-camera restoration matrix comparison.",
        acceptance: "Workbench editor-camera restoration acceptance.",
      },
      {
        owner: "workbench",
        source: "observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ObserverCommon.c",
        value: 0.001,
        reason: "Workbench submitted matrix orthonormality/input validation.",
        acceptance: "Workbench invalid-input acceptance.",
      },
    ],
  };
  validateObserverEnforceContract(contract);
  return freezeContract(contract);
}

function freezeContract(contract: ObserverEnforceContract): ObserverEnforceContract {
  for (const target of Object.values(contract.targets)) {
    Object.freeze(target.strings);
    Object.freeze(target.numbers);
    Object.freeze(target);
  }
  Object.freeze(contract.terminalStates);
  Object.freeze(contract.backendTuning);
  Object.freeze(contract.identities);
  Object.freeze(contract.targets);
  return Object.freeze(contract);
}

/** Validate a custom test fixture or the production contract before rendering. */
export function validateObserverEnforceContract(contract: ObserverEnforceContract): void {
  assert(contract.descriptorVersion === 1, "unsupported descriptor version");
  const identityValues = Object.values(contract.identities);
  assert(new Set(identityValues).size === identityValues.length, "protocol identities must remain distinct");
  assert(contract.terminalStates.length > 0, "terminal-state subset must not be empty");
  assert(new Set(contract.terminalStates).size === contract.terminalStates.length, "terminal states must be unique");

  const outputPaths = new Set<string>();
  for (const targetName of ["game", "workbench"] as const) {
    const target = contract.targets[targetName];
    assert(target !== undefined, `missing ${targetName} target`);
    assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(target.className), `unsupported class name ${JSON.stringify(target.className)}`);
    assert(/^[A-Za-z0-9._/-]+$/.test(target.outputPath), `invalid output path ${JSON.stringify(target.outputPath)}`);
    assert(!outputPaths.has(target.outputPath), `duplicate target output path ${target.outputPath}`);
    outputPaths.add(target.outputPath);
    assert(target.strings.length + target.numbers.length > 0, `${targetName} target vocabulary must not be empty`);

    const fields = new Set<string>();
    for (const entry of [...target.strings, ...target.numbers]) {
      assert(/^[A-Z][A-Z0-9_]*$/.test(entry.field), `invalid field name ${JSON.stringify(entry.field)}`);
      assert(!fields.has(entry.field), `duplicate field ${entry.field} for ${targetName}`);
      fields.add(entry.field);
    }
    for (const entry of target.strings) {
      assert(typeof entry.value === "string" && !entry.value.includes("\0"), `invalid string value for ${entry.field}`);
    }
    for (const entry of target.numbers) {
      assert(Number.isFinite(entry.value), `numeric field ${entry.field} must be finite`);
      if (entry.kind === "int") assert(Number.isSafeInteger(entry.value), `integer field ${entry.field} must be a safe integer`);
      assert(
        contract.backendTuning.some((tuning) =>
          tuning.owner === (targetName === "game" ? "runtime" : "workbench") && tuning.value === entry.value
        ),
        `numeric field ${entry.field} has no explicit ledger decision`
      );
    }
    const targetStateValues = new Set(
      target.strings.filter((entry) => entry.field.startsWith("STATE_")).map((entry) => entry.value)
    );
    for (const state of contract.terminalStates) {
      assert(targetStateValues.has(state), `${targetName} target omits terminal state ${state}`);
    }
  }

  for (const targetName of ["game", "workbench"] as const) {
    const target = contract.targets[targetName];
    const expectedClassName = targetName === "game" ? "RFO_ObserverProtocol" : "EMCP_WB_ObserverProtocol";
    const expectedOutputPath = targetName === "game"
      ? GAME_ENFORCE_PROTOCOL_OUTPUT
      : WORKBENCH_ENFORCE_PROTOCOL_OUTPUT;
    assert(target.className === expectedClassName, `unsupported ${targetName} class name ${JSON.stringify(target.className)}`);
    assert(target.outputPath === expectedOutputPath, `invalid ${targetName} output path ${JSON.stringify(target.outputPath)}`);
  }

  for (const [index, entry] of contract.backendTuning.entries()) {
    assert(entry.owner === "runtime" || entry.owner === "workbench", `backend tuning ${index} has an invalid owner`);
    assert(Number.isFinite(entry.value), `backend tuning ${index} must be finite`);
    assert(entry.source.length > 0, `backend tuning ${index} has no source`);
    assert(entry.reason.length > 0, `backend tuning ${index} has no reason`);
    assert(entry.acceptance.length > 0, `backend tuning ${index} has no acceptance proof`);
  }

  const expectedTuning = [
    ["runtime", 0.001],
    ["workbench", 0.0001],
    ["workbench", 0.001],
  ] as const;
  for (const [owner, value] of expectedTuning) {
    assert(
      contract.backendTuning.some((entry) => entry.owner === owner && entry.value === value && entry.source.length > 0 && entry.reason.length > 0 && entry.acceptance.length > 0),
      `missing ${owner} tuning ledger entry for ${value}`
    );
  }
}

export const CANONICAL_ENFORCE_CONTRACT_SOURCE: EnforceContractSource = {
  errorRegistry: ERROR_REGISTRY,
  capabilityRegistry: CAPABILITY_REGISTRY,
};

export const OBSERVER_ENFORCE_CONTRACT = createObserverEnforceContract(CANONICAL_ENFORCE_CONTRACT_SOURCE);

/**
 * Target-filtered host vocabulary. Keys are generated Enforce suffixes, so a
 * host consumer can use (for example) ERROR_RESTORATION_UNCONFIRMED without
 * retaining a second error-code literal.
 */
export const WORKBENCH_ADAPTER_ERROR_CODES: Readonly<Record<string, WorkbenchObserverProtocolErrorCode>> =
  targetValueMap(OBSERVER_ENFORCE_CONTRACT, "workbench", "ERROR_") as Readonly<
    Record<string, WorkbenchObserverProtocolErrorCode>
  >;

export const WORKBENCH_ADAPTER_CAPABILITIES: Readonly<Record<string, WorkbenchObserverProtocolCapability>> =
  targetValueMap(OBSERVER_ENFORCE_CONTRACT, "workbench", "CAP_") as Readonly<
    Record<string, WorkbenchObserverProtocolCapability>
  >;

export const WORKBENCH_ADAPTER_STATE_VALUES: Readonly<Record<string, string>> =
  targetValueMap(OBSERVER_ENFORCE_CONTRACT, "workbench", "STATE_");
