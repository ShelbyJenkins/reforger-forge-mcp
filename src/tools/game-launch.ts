import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { z as z4 } from "zod/v4";
import { mcpDiscriminatedOutputSchema } from "../foundation/mcp-discriminated-output-schema.js";
import {
  GameLaunchPlanError,
  projectPublicGameLaunchPlanError,
} from "../launch/game-launch-errors.js";
import {
  resolveGameAddonPlan,
  type GameAddonPlanSnapshot,
} from "../launch/game-addon-plan.js";
import { buildGameRuntimeArguments, type GameRuntimeKind } from "../launch/game-runtime-arguments.js";
import {
  resolveGameWorldPlan,
  type GameWorldPlanSnapshot,
} from "../launch/game-world-plan.js";
import {
  planCanonicalGameLaunchIsolated,
  planningDeadlineError,
} from "../launch/game-launch-planning-isolation.js";
import type {
  ObserverApplication,
  ObserverInstanceList,
} from "../observer/application.js";
import { ObserverApplicationError } from "../observer/errors.js";
import {
  prepareObserverLaunch,
  type ObserverLaunchInput,
  type ObserverPreparedLaunch,
} from "../observer/launch.js";
import {
  assertCompositeLaunchArguments,
  assertNativeFullscreenLaunch,
  COMPOSITE_ARGUMENT_MAXIMUM_COUNT,
  COMPOSITE_ARGUMENT_MAXIMUM_TOKEN_LENGTH,
  deriveGameLaunchProfilePath,
  forceNonNativeWindowSizeSchema,
} from "../observer/launch-policy.js";
import {
  computeOwnedGameLaunchEvidenceDigest,
  OWNED_GAME_LAUNCH_PREPARATION_EVIDENCE_SCHEMA_VERSION,
  OwnedRuntimeError,
  OwnedRuntimePreconsumptionError,
  type OwnedGameLaunchPreparationEvidence,
  type OwnedRuntimeExecutableEvidence,
  type OwnedRuntimeManager,
  type OwnedRuntimePublicStatus,
  type PreparedOwnedGameLaunch,
} from "../observer/owned-runtime-manager.js";
import {
  projectPublicObserverToolError,
  PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM,
  type PublicObserverErrorCandidate,
} from "../observer/public-contract.js";
import { resolveObserverRefusalRemedy } from "../observer/refusal-remedy.js";
import {
  canonicalizeGproj,
  ProjectIdentityError,
  type CanonicalProjectIdentity,
} from "../workbench/project-identity.js";
import {
  executeOwnedRuntimeOperation,
  extractOwnedRuntimeError,
  deriveOwnedGameLaunchAttemptKey,
  ownedRuntimeIdSchema,
} from "./owned-runtime-operations.js";

export const GAME_LAUNCH_PREPARE_IDENTITY_VERSION = 1 as const;
export const GAME_LAUNCH_PREPARE_KEY_PREFIX = "mcp-game-launch-prepare-v1-";
export const GAME_LAUNCH_PLANNING_KEY_PREFIX = "mcp-game-launch-planning-v1-";
export const GAME_LAUNCH_IN_FLIGHT_MAXIMUM = 32;
export const GAME_LAUNCH_PLANNING_DEADLINE_MS = 60_000;
export const GAME_LAUNCH_EXECUTABLE_MAXIMUM_BYTES = 1024 * 1024 * 1024;

const boundedNonblank = z.string().trim().min(1).max(32_768);
const sessionTtlSchema = z.number().int().min(1_000).max(24 * 60 * 60 * 1_000);
const waitSchema = z.number().int().min(0).max(5 * 60 * 1_000);
const additionalArgumentsSchema = z.array(
  z.string().min(1).max(COMPOSITE_ARGUMENT_MAXIMUM_TOKEN_LENGTH),
).max(COMPOSITE_ARGUMENT_MAXIMUM_COUNT);

const gameLaunchActionSchema = z.enum(["start", "status", "stop"]);
const gameLaunchRuntimeKindSchema = z.enum(["client", "listenServer"]);

export const gameLaunchRawInputShape = {
  action: gameLaunchActionSchema.optional().describe(
    "Operation to perform. Omit for start; status and stop require runtimeId.",
  ),
  gprojPath: boundedNonblank.optional().describe(
    "Start only: exact absolute .gproj path. When omitted, the active owned Workbench project hint is used if available.",
  ),
  world: boundedNonblank.optional().describe(
    "Start only: project-contained world path, resource reference, or GUID. Omit only when the project has one unambiguous registered world.",
  ),
  runtimeKind: gameLaunchRuntimeKindSchema.optional().describe(
    "Start only (default: listenServer). Legacy client means a standalone graphical -world launch; it never selects Reforger's engine -client replication mode.",
  ),
  arguments: additionalArgumentsSchema.optional().describe(
    "Start only (default: []). Additional bounded runtime arguments; project, world, add-on, profile, display, and ownership arguments remain composite-managed.",
  ),
  waitForInstanceMs: waitSchema.optional().describe(
    "Start only (default: 60000). Maximum render-instance readiness wait in milliseconds; timeout is partial success and never hides the started runtime.",
  ),
  sessionTtlMs: sessionTtlSchema.optional().describe(
    "Start only. Observer session lifetime in milliseconds; omit to use the server's configured game-launch default.",
  ),
  forceUpdate: z.boolean().optional().describe(
    "Start only (default: true). Retain the Observer-managed -forceUpdate launch policy.",
  ),
  noFocus: z.boolean().optional().describe(
    "Start only (default: true). Retain the Observer-managed -noFocus launch policy.",
  ),
  forceNonNativeWindowSize: forceNonNativeWindowSizeSchema.optional().describe(
    "Start only. Exceptional, justified non-native window size; omit for the native borderless-fullscreen default.",
  ),
  afterRuntimeId: ownedRuntimeIdSchema.optional().describe(
    "Start only. Exact stopped predecessor fence offered by a prior stop result for one deliberate same-profile successor.",
  ),
  runtimeId: ownedRuntimeIdSchema.optional().describe(
    "Status/stop only: exact opaque runtimeId returned by a successful owned start.",
  ),
  waitForRestorationMs: waitSchema.optional().describe(
    "Stop only (default: 20000). Maximum camera-restoration wait in milliseconds before stop reports its bounded outcome.",
  ),
} as const;

export const gameLaunchRawInputSchema = z.object(gameLaunchRawInputShape).strict();
export const gameLaunchStartInputSchema = z.object({
  action: z.literal("start"),
  gprojPath: boundedNonblank.optional(),
  world: boundedNonblank.optional(),
  runtimeKind: gameLaunchRuntimeKindSchema.default("listenServer"),
  arguments: additionalArgumentsSchema.default([]),
  waitForInstanceMs: waitSchema.default(60_000),
  sessionTtlMs: sessionTtlSchema,
  forceUpdate: z.boolean().default(true),
  noFocus: z.boolean().default(true),
  forceNonNativeWindowSize: forceNonNativeWindowSizeSchema.optional(),
  afterRuntimeId: ownedRuntimeIdSchema.optional(),
}).strict();
export const gameLaunchStatusInputSchema = z.object({
  action: z.literal("status"),
  runtimeId: ownedRuntimeIdSchema,
}).strict();
export const gameLaunchStopInputSchema = z.object({
  action: z.literal("stop"),
  runtimeId: ownedRuntimeIdSchema,
  waitForRestorationMs: waitSchema.default(20_000),
}).strict();

export type GameLaunchStartInput = z.infer<typeof gameLaunchStartInputSchema>;
export type GameLaunchStatusInput = z.infer<typeof gameLaunchStatusInputSchema>;
export type GameLaunchStopInput = z.infer<typeof gameLaunchStopInputSchema>;
export type GameLaunchInput = GameLaunchStartInput | GameLaunchStatusInput | GameLaunchStopInput;

const gameLaunchSessionIdSchema = z.string().min(1).max(96);
const gameLaunchRemedySessionIdSchema = gameLaunchSessionIdSchema.refine(
  (value) => !/[\0-\x1f\x7f]/u.test(value),
  "sessionId must not contain control characters",
);
const gameLaunchOutputSessionIdSchema = z4.string().min(1).max(96);
const gameLaunchOutputRuntimeIdSchema = z4.string().regex(
  /^rt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const gameLaunchOutputPreparedLaunchIdSchema = z4.string().regex(
  /^pl-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const gameLaunchCompositeAttemptIdSchema = z4.string().regex(
  /^ga-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const gameLaunchSha256Schema = z4.string().regex(/^[a-f0-9]{64}$/);
const gameLaunchAddonGuidSchema = z4.string().regex(/^[A-Fa-f0-9]{16}$/);

const gameLaunchSuccessorSchema = z4.discriminatedUnion("eligible", [
  z4.object({
    eligible: z4.literal(false),
    reason: z4.enum(["exact_stop_required", "recovery_required"]),
  }).strict(),
  z4.object({
    eligible: z4.literal(true),
    afterRuntimeId: gameLaunchOutputRuntimeIdSchema,
  }).strict(),
]);

const gameLaunchChainPublicSchema = z4.object({
  schemaVersion: z4.literal(1),
  delivery: z4.literal("owned"),
  compositeAttemptId: gameLaunchCompositeAttemptIdSchema,
  generation: z4.number().int().positive(),
  state: z4.enum(["reserved", "prepared", "starting", "running", "terminal"]),
  predecessorRuntimeId: gameLaunchOutputRuntimeIdSchema.nullable(),
  runtimeId: gameLaunchOutputRuntimeIdSchema.optional(),
  retry: z4.object({ afterRuntimeId: gameLaunchOutputRuntimeIdSchema.nullable() }).strict(),
  successor: gameLaunchSuccessorSchema,
}).strict();

const ownedRuntimePublicStatusSchema = z4.object({
  runtimeId: gameLaunchOutputRuntimeIdSchema,
  sessionId: gameLaunchOutputSessionIdSchema,
  preparedLaunchId: gameLaunchOutputPreparedLaunchIdSchema,
  state: z4.enum([
    "running",
    "stopping",
    "exited",
    "identity_mismatch",
    "unverifiable",
    "stale",
  ]),
  pid: z4.number().int().positive(),
  runtimeKind: z4.enum(["client", "listenServer", "dedicated", "testRunner"]),
  startedAt: z4.string().datetime(),
  exactOwned: z4.boolean(),
  reason: z4.string().optional(),
  stoppedAt: z4.string().datetime().optional(),
  termination: z4.enum(["terminated", "already_exited"]).optional(),
  identityVacant: z4.boolean().optional(),
  terminationComplete: z4.boolean().optional(),
  observerCleanupPending: z4.boolean().optional(),
  compositeAttemptId: gameLaunchCompositeAttemptIdSchema.optional(),
  chain: gameLaunchChainPublicSchema.optional(),
}).strict();

const statusToolCallSchema = z4.object({
  tool: z4.literal("game_launch"),
  input: z4.object({
    action: z4.literal("status"),
    runtimeId: gameLaunchOutputRuntimeIdSchema,
  }).strict(),
}).strict();
const stopToolCallSchema = z4.object({
  tool: z4.literal("game_launch"),
  input: z4.object({
    action: z4.literal("stop"),
    runtimeId: gameLaunchOutputRuntimeIdSchema,
  }).strict(),
}).strict();
const successorToolCallSchema = z4.object({
  tool: z4.literal("game_launch"),
  input: z4.object({
    action: z4.literal("start"),
    afterRuntimeId: gameLaunchOutputRuntimeIdSchema,
  }).strict(),
  instruction: z4.string().min(1),
}).strict();

const captureNextSchema = z4.discriminatedUnion("ready", [
  z4.object({
    ready: z4.literal(true),
    tool: z4.literal("observer_capture"),
    input: z4.object({ target: z4.string().min(1) }).strict(),
  }).strict(),
  z4.object({
    ready: z4.literal(false),
    firstCall: z4.object({
      tool: z4.literal("observer_instances"),
      input: z4.object({
        sessionId: gameLaunchOutputSessionIdSchema,
        requiredCapabilities: z4.tuple([z4.literal("render.capture")]),
        renderersOnly: z4.literal(true),
        waitMs: z4.literal(60_000),
      }).strict(),
    }).strict(),
    instruction: z4.string().min(1),
  }).strict(),
]);

const startNextSchema = z4.object({
  status: statusToolCallSchema,
  capture: captureNextSchema,
  stop: stopToolCallSchema,
}).strict();
const statusNextSchema = z4.object({ stop: stopToolCallSchema }).strict();
const stopNextSchema = z4.object({
  status: statusToolCallSchema,
  successor: successorToolCallSchema.optional(),
}).strict();

const instanceWaitSchema = z4.object({
  instances: z4.array(z4.record(z4.string(), z4.unknown())),
  compatibleCount: z4.number().int().nonnegative(),
  waitedMs: z4.number().nonnegative(),
  timedOut: z4.boolean(),
  warnings: z4.array(z4.string()).optional(),
}).strict();

export const GAME_LAUNCH_READINESS_WARNING = Object.freeze({
  notRequested: "The owned runtime started; render-instance readiness was not requested.",
  timedOut: "The owned runtime started, but no matching render-capable observer instance became ready before the wait ended.",
  failed: "The owned runtime started, but readiness could not be confirmed.",
} as const);

const readinessWarningSchema = z4.enum([
  GAME_LAUNCH_READINESS_WARNING.notRequested,
  GAME_LAUNCH_READINESS_WARNING.timedOut,
  GAME_LAUNCH_READINESS_WARNING.failed,
]);

const gameLaunchStartSuccessSchema = z4.object({
  action: z4.literal("start").describe("Success branch discriminator: start."),
  compositeAttemptId: gameLaunchCompositeAttemptIdSchema,
  chain: gameLaunchChainPublicSchema,
  runtime: ownedRuntimePublicStatusSchema,
  sessionId: gameLaunchOutputSessionIdSchema,
  preparedLaunchId: gameLaunchOutputPreparedLaunchIdSchema,
  preparation: z4.object({
    expiresAt: z4.string().datetime(),
    bundleDigest: gameLaunchSha256Schema,
    warnings: z4.array(z4.string()),
  }).strict(),
  project: z4.object({
    gprojPath: z4.string().min(1),
    selection: z4.enum(["explicit", "active_workbench_hint"]),
  }).strict(),
  executablePath: z4.string().min(1),
  profilePath: z4.string().min(1),
  world: z4.object({
    path: z4.string().min(1),
    metadataPath: z4.string().min(1),
    guid: gameLaunchAddonGuidSchema,
    relativePath: z4.string().min(1),
    resourceReference: z4.string().min(1),
  }).strict(),
  addons: z4.object({
    targetGuid: gameLaunchAddonGuidSchema,
    dependencyGuids: z4.array(gameLaunchAddonGuidSchema),
    emittedRoots: z4.array(z4.string().min(1)),
    implicitRoots: z4.array(z4.string().min(1)),
    rootProvenance: z4.array(z4.object({
      path: z4.string().min(1),
      provenance: z4.array(z4.enum([
        "configured",
        "target_parent",
        "installation_addons",
        "profile_addons",
        "dependency_container",
      ])),
      emitted: z4.boolean(),
    }).strict()),
  }).strict(),
  evidence: z4.object({
    world: gameLaunchSha256Schema,
    addons: gameLaunchSha256Schema,
    executable: gameLaunchSha256Schema,
  }).strict(),
  arguments: z4.array(z4.string()),
  instanceWait: instanceWaitSchema.nullable(),
  readinessWarning: readinessWarningSchema.optional(),
  readinessError: z4.string().min(1).max(PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM).optional(),
  next: startNextSchema,
}).strict();

const gameLaunchStatusSuccessSchema = z4.object({
  action: z4.literal("status").describe("Success branch discriminator: status."),
  runtime: ownedRuntimePublicStatusSchema,
  next: statusNextSchema,
}).strict();

const gameLaunchStopSuccessSchema = z4.object({
  action: z4.literal("stop").describe("Success branch discriminator: stop."),
  runtime: ownedRuntimePublicStatusSchema,
  next: stopNextSchema,
}).strict();

/** Exact in-process success contract; action is the branch discriminator. */
export const gameLaunchSuccessSchema = z4.discriminatedUnion("action", [
  gameLaunchStartSuccessSchema,
  gameLaunchStatusSuccessSchema,
  gameLaunchStopSuccessSchema,
]);
export type GameLaunchSuccess = z4.infer<typeof gameLaunchSuccessSchema>;

/**
 * The pinned SDK requires an object-shaped registration wrapper. The wrapper
 * publishes the exact action branches and delegates runtime validation to the
 * same discriminated schema used before structured output is returned.
 */
export const gameLaunchOutputSchema = mcpDiscriminatedOutputSchema(
  gameLaunchSuccessSchema,
  "action",
);

export interface GameLaunchPrepareIdentity {
  readonly version: typeof GAME_LAUNCH_PREPARE_IDENTITY_VERSION;
  readonly delivery: "owned";
  readonly projectComparisonKey: string;
  readonly worldResourceReference: string;
  readonly worldEvidenceSchemaVersion: number;
  readonly worldEvidenceDigest: string;
  readonly addonEvidenceSchemaVersion: number;
  readonly addonEvidenceDigest: string;
  readonly runtimeKind: GameRuntimeKind;
  readonly executablePath: string;
  readonly executableEvidenceSchemaVersion: number;
  readonly executableEvidenceDigest: string;
  readonly arguments: readonly string[];
  readonly profilePath: string;
  readonly sessionTtlMs: number;
  readonly forceUpdate: boolean;
  readonly noFocus: boolean;
  readonly forceNonNativeWindowSize: {
    readonly width: number;
    readonly height: number;
    readonly justification: string;
  } | null;
}

export interface CanonicalGameLaunchPreparation {
  readonly project: CanonicalProjectIdentity;
  readonly projectSelection: "explicit" | "active_workbench_hint";
  readonly profilePath: string;
  readonly world: GameWorldPlanSnapshot;
  readonly addons: GameAddonPlanSnapshot;
  readonly executable: OwnedRuntimeExecutableEvidence;
  readonly arguments: readonly string[];
  readonly prepareIdentity: GameLaunchPrepareIdentity;
  readonly prepareKey: string;
  readonly evidence: OwnedGameLaunchPreparationEvidence;
  readonly launchInput: ObserverLaunchInput;
}

export interface RegisterGameLaunchOptions {
  readonly manager: OwnedRuntimeManager;
  readonly workbenchClient?: GameLaunchActiveProjectHintPort;
  readonly configuredAddonRoots?: readonly string[];
  readonly defaultSessionTtlMs: number;
  /** @internal Absolute elapsed budget for isolated evidence planning. */
  readonly planningDeadlineMs?: number;
  /** @internal Planning-only executable hashing ceiling. */
  readonly executableMaximumBytes?: number;
  /** @internal Isolated-planner seam for physical-exit lifecycle tests. */
  readonly isolatedPlanner?: typeof planCanonicalGameLaunchIsolated;
}

export interface GameLaunchActiveProjectHintPort {
  activeProjectGprojPathHint(options: {
    readonly signal: AbortSignal;
    readonly deadlineAtMs: number;
  }): Promise<string | null>;
}

/** Worker-local planning dependencies after the lifecycle hint is projected. */
export interface CanonicalGameLaunchPlanningOptions {
  readonly manager: OwnedRuntimeManager;
  readonly workbenchClient?: {
    activeProjectGprojPath(): Promise<string | null>;
  };
  readonly configuredAddonRoots?: readonly string[];
  readonly defaultSessionTtlMs: number;
}

interface GameLaunchMutationResult {
  readonly prepared: PreparedOwnedGameLaunch;
  readonly runtime: OwnedRuntimePublicStatus;
}

interface GameLaunchReadiness {
  readonly inventory: ObserverInstanceList | null;
  readonly warning?: string;
  readonly readinessError?: string;
}

interface SharedGameLaunchStart {
  readonly controller: AbortController;
  readonly promise: Promise<{
    readonly plan: CanonicalGameLaunchPreparation;
    readonly mutation: GameLaunchMutationResult;
  }>;
  subscribers: number;
  planning: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Fixed-field serialization for the one initial owned game-launch family. */
export function canonicalGameLaunchPrepareIdentity(value: GameLaunchPrepareIdentity): string {
  return JSON.stringify([
    "reforger-forge-game-launch-prepare",
    value.version,
    value.delivery,
    value.projectComparisonKey,
    value.worldResourceReference,
    [value.worldEvidenceSchemaVersion, value.worldEvidenceDigest],
    [value.addonEvidenceSchemaVersion, value.addonEvidenceDigest],
    value.runtimeKind,
    value.executablePath,
    [value.executableEvidenceSchemaVersion, value.executableEvidenceDigest],
    value.arguments,
    value.profilePath,
    value.sessionTtlMs,
    value.forceUpdate,
    value.noFocus,
    value.forceNonNativeWindowSize === null
      ? null
      : [
          value.forceNonNativeWindowSize.width,
          value.forceNonNativeWindowSize.height,
          value.forceNonNativeWindowSize.justification,
        ],
  ]);
}

export function computeGameLaunchPrepareKey(value: GameLaunchPrepareIdentity): string {
  return `${GAME_LAUNCH_PREPARE_KEY_PREFIX}${sha256(canonicalGameLaunchPrepareIdentity(value))}`;
}

/**
 * Exact caller-level planning key. This intentionally uses no filesystem
 * canonicalization: only byte-equal bounded requests coalesce before evidence
 * collection, while the later prepare key still governs evidence identity.
 */
export function computeGameLaunchPlanningKey(input: GameLaunchStartInput): string {
  const canonical = JSON.stringify([
    "reforger-forge-game-launch-planning",
    1,
    input.gprojPath ?? null,
    input.world ?? null,
    input.runtimeKind,
    input.arguments,
    input.sessionTtlMs,
    input.forceUpdate,
    input.noFocus,
    input.forceNonNativeWindowSize === undefined
      ? null
      : [
          input.forceNonNativeWindowSize.width,
          input.forceNonNativeWindowSize.height,
          input.forceNonNativeWindowSize.justification,
        ],
    input.afterRuntimeId ?? null,
  ]);
  return `${GAME_LAUNCH_PLANNING_KEY_PREFIX}${sha256(canonical)}`;
}

function invalidInput(message: string): OwnedRuntimeError {
  return new OwnedRuntimeError("INVALID_REQUEST", message);
}

export function parseGameLaunchInput(
  value: unknown,
  defaultSessionTtlMs: number,
): GameLaunchInput {
  try {
    const raw = gameLaunchRawInputSchema.parse(value);
    const action = raw.action ?? "start";
    if (action === "start") {
      if (!Number.isSafeInteger(defaultSessionTtlMs) ||
          defaultSessionTtlMs < 1_000 || defaultSessionTtlMs > 24 * 60 * 60 * 1_000) {
        throw invalidInput("The configured game-launch session TTL is invalid.");
      }
      return gameLaunchStartInputSchema.parse({
        ...raw,
        action,
        sessionTtlMs: raw.sessionTtlMs ?? defaultSessionTtlMs,
      });
    }
    if (action === "status") return gameLaunchStatusInputSchema.parse({ ...raw, action });
    return gameLaunchStopInputSchema.parse({ ...raw, action });
  } catch (error) {
    if (error instanceof OwnedRuntimeError) throw error;
    if (error instanceof z.ZodError) {
      throw invalidInput("game_launch input does not match the selected action schema.");
    }
    throw error;
  }
}

function projectIdentityError(error: unknown, fromHint: boolean): GameLaunchPlanError {
  if (fromHint) {
    return new GameLaunchPlanError(
      "PROJECT_REQUIRED",
      "The active Workbench project hint is unavailable or stale. Provide an exact absolute gprojPath.",
    );
  }
  if (error instanceof ProjectIdentityError && error.code === "TARGET_CHANGED") {
    return new GameLaunchPlanError(
      "PROJECT_CHANGED",
      "The requested project changed while its canonical identity was being resolved.",
    );
  }
  return new GameLaunchPlanError(
    "PROJECT_INVALID",
    "The requested gprojPath is not an existing canonical project file.",
  );
}

async function resolveGameLaunchProject(
  explicitPath: string | undefined,
  workbenchClient: CanonicalGameLaunchPlanningOptions["workbenchClient"],
): Promise<{ project: CanonicalProjectIdentity; selection: CanonicalGameLaunchPreparation["projectSelection"] }> {
  if (explicitPath !== undefined) {
    if (!isAbsolute(explicitPath)) {
      throw new GameLaunchPlanError(
        "PROJECT_INVALID",
        "game_launch requires gprojPath to be an exact absolute path.",
      );
    }
    try {
      return { project: canonicalizeGproj(explicitPath), selection: "explicit" };
    } catch (error) {
      throw projectIdentityError(error, false);
    }
  }
  if (!workbenchClient) {
    throw new GameLaunchPlanError(
      "PROJECT_REQUIRED",
      "No active Workbench project hint is configured. Provide an exact absolute gprojPath.",
    );
  }
  let hint: string | null;
  try {
    hint = await workbenchClient.activeProjectGprojPath();
  } catch (error) {
    throw projectIdentityError(error, true);
  }
  if (!hint || !isAbsolute(hint)) throw projectIdentityError(undefined, true);
  try {
    return { project: canonicalizeGproj(hint), selection: "active_workbench_hint" };
  } catch (error) {
    throw projectIdentityError(error, true);
  }
}

export async function planCanonicalGameLaunch(
  application: Pick<ObserverApplication, "managedRoot" | "profileRoot">,
  input: GameLaunchStartInput,
  options: CanonicalGameLaunchPlanningOptions,
): Promise<CanonicalGameLaunchPreparation> {
  assertCompositeLaunchArguments(input.arguments);
  const executable = options.manager.resolveRuntimeExecutableEvidence(input.runtimeKind);
  const { project, selection } = await resolveGameLaunchProject(input.gprojPath, options.workbenchClient);
  const profilePath = deriveGameLaunchProfilePath(application.profileRoot, project.comparisonKey);
  const world = resolveGameWorldPlan({ project, ...(input.world === undefined ? {} : { world: input.world }) });
  const addons = resolveGameAddonPlan({
    project,
    configuredAddonRoots: options.configuredAddonRoots ?? [],
    executablePath: executable.executablePath,
    profilePath,
    managedRoot: application.managedRoot,
    profileRoot: application.profileRoot,
  });
  const argumentsArray = buildGameRuntimeArguments({
    runtimeKind: input.runtimeKind,
    worldResourceReference: world.resourceReference,
    emittedAddonRoots: addons.emittedAddonRoots,
    targetAddonGuid: addons.targetGuid,
    extraArguments: input.arguments,
  });
  assertNativeFullscreenLaunch({
    runtimeKind: input.runtimeKind,
    arguments: argumentsArray,
    ...(input.forceNonNativeWindowSize === undefined
      ? {}
      : { forceNonNativeWindowSize: input.forceNonNativeWindowSize }),
  });
  const prepareIdentity: GameLaunchPrepareIdentity = Object.freeze({
    version: GAME_LAUNCH_PREPARE_IDENTITY_VERSION,
    delivery: "owned",
    projectComparisonKey: project.comparisonKey,
    worldResourceReference: world.resourceReference,
    worldEvidenceSchemaVersion: world.schemaVersion,
    worldEvidenceDigest: world.worldEvidenceDigest,
    addonEvidenceSchemaVersion: addons.schemaVersion,
    addonEvidenceDigest: addons.addonEvidenceDigest,
    runtimeKind: input.runtimeKind,
    executablePath: executable.executablePath,
    executableEvidenceSchemaVersion: executable.schemaVersion,
    executableEvidenceDigest: executable.executableEvidenceDigest,
    arguments: Object.freeze([...argumentsArray]),
    profilePath,
    sessionTtlMs: input.sessionTtlMs,
    forceUpdate: input.forceUpdate,
    noFocus: input.noFocus,
    forceNonNativeWindowSize: input.forceNonNativeWindowSize === undefined
      ? null
      : Object.freeze({ ...input.forceNonNativeWindowSize }),
  });
  const prepareKey = computeGameLaunchPrepareKey(prepareIdentity);
  const evidenceFields: Omit<OwnedGameLaunchPreparationEvidence, "gameLaunchEvidenceDigest"> = {
    schemaVersion: OWNED_GAME_LAUNCH_PREPARATION_EVIDENCE_SCHEMA_VERSION,
    prepareKey,
    projectComparisonKey: project.comparisonKey,
    world,
    addons,
    executable,
  };
  const evidence: OwnedGameLaunchPreparationEvidence = Object.freeze({
    ...evidenceFields,
    gameLaunchEvidenceDigest: computeOwnedGameLaunchEvidenceDigest(evidenceFields),
  });
  const launchInput: ObserverLaunchInput = {
    runtimeKind: input.runtimeKind,
    arguments: [...argumentsArray],
    profilePath,
    sessionTtlMs: input.sessionTtlMs,
    transportPreference: ["rest", "mailbox"],
    forceUpdate: input.forceUpdate,
    noFocus: input.noFocus,
    ...(input.forceNonNativeWindowSize === undefined
      ? {}
      : { forceNonNativeWindowSize: { ...input.forceNonNativeWindowSize } }),
    idempotencyKey: prepareKey,
  };
  return Object.freeze({
    project,
    projectSelection: selection,
    profilePath,
    world,
    addons,
    executable,
    arguments: Object.freeze([...argumentsArray]),
    prepareIdentity,
    prepareKey,
    evidence,
    launchInput,
  });
}

function assertPlanningOpen(signal: AbortSignal, deadlineAtMs: number): void {
  if (signal.aborted) {
    throw new OwnedRuntimeError("CANCELLED", "Game launch planning was cancelled");
  }
  if (Date.now() >= deadlineAtMs) throw planningDeadlineError();
}

async function resolveIsolatedPlanningHint(
  input: GameLaunchStartInput,
  options: RegisterGameLaunchOptions,
  signal: AbortSignal,
  deadlineAtMs: number,
): Promise<string | null | undefined> {
  if (input.gprojPath !== undefined) return undefined;
  if (!options.workbenchClient) {
    throw new GameLaunchPlanError(
      "PROJECT_REQUIRED",
      "No active Workbench project hint is configured. Provide an exact absolute gprojPath.",
    );
  }
  assertPlanningOpen(signal, deadlineAtMs);
  try {
    const hint: unknown = await options.workbenchClient.activeProjectGprojPathHint({
      signal,
      deadlineAtMs,
    });
    assertPlanningOpen(signal, deadlineAtMs);
    if (hint !== null && (typeof hint !== "string" || hint.length > 32_768)) {
      throw projectIdentityError(undefined, true);
    }
    return hint;
  } catch (error) {
    // The trusted lifecycle read owns and joins its cancellable inspection.
    // Preserve cancellation/deadline classification before adapting an actual
    // lifecycle-hint failure to the public project-selection contract.
    assertPlanningOpen(signal, deadlineAtMs);
    if (error instanceof OwnedRuntimeError || error instanceof GameLaunchPlanError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ABORTED") {
      throw new OwnedRuntimeError("CANCELLED", "Game launch planning was cancelled");
    }
    if (error instanceof Error && "code" in error && error.code === "DEADLINE_EXCEEDED") {
      throw planningDeadlineError();
    }
    throw projectIdentityError(error, true);
  }
}

function awaitSharedGameLaunchStart(
  operation: SharedGameLaunchStart,
  signal: AbortSignal,
): Promise<{
  readonly plan: CanonicalGameLaunchPreparation;
  readonly mutation: GameLaunchMutationResult;
}> {
  if (signal.aborted) {
    return Promise.reject(new OwnedRuntimeError("CANCELLED", "Game launch planning was cancelled"));
  }
  if (operation.controller.signal.aborted) {
    // An equal retry can arrive while the prior operation's final subscriber
    // is still joining physical cancellation. It must join that retained
    // operation too; otherwise the retry could report completion while the
    // request-owned reader remains alive outside admission.
    return operation.promise.then(
      (result) => result,
      () => Promise.reject(new OwnedRuntimeError(
        "CANCELLED",
        "Game launch planning was cancelled",
      )),
    );
  }
  operation.subscribers += 1;
  return new Promise((resolve, reject) => {
    let left = false;
    const leave = (): void => {
      if (left) return;
      left = true;
      signal.removeEventListener("abort", onAbort);
      operation.subscribers -= 1;
      if (operation.subscribers === 0 && operation.planning) operation.controller.abort();
    };
    const onAbort = (): void => {
      // Once a durable lifecycle mutation may begin, cancellation must not
      // hide a successful start and its exact stop authority from the caller.
      if (!operation.planning) return;
      const mustJoinPhysicalPlanning = operation.subscribers === 1;
      leave();
      if (!mustJoinPhysicalPlanning) {
        reject(new OwnedRuntimeError("CANCELLED", "Game launch planning was cancelled"));
        return;
      }
      // The final subscriber owns cancellation of the shared physical plan.
      // Join that plan before reporting cancellation so a hint reader or
      // evidence worker can never detach after admission is released. If the
      // operation crossed into mutation concurrently, return its authority
      // instead of hiding a successfully spawned runtime.
      void operation.promise.then(
        resolve,
        () => reject(new OwnedRuntimeError(
          "CANCELLED",
          "Game launch planning was cancelled",
        )),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.promise.then(
      (result) => {
        if (left) return;
        leave();
        resolve(result);
      },
      (error: unknown) => {
        if (left) return;
        leave();
        reject(error);
      },
    );
  });
}

function requirePreparedLaunchId(
  prepared: ObserverPreparedLaunch,
): asserts prepared is ObserverPreparedLaunch & { preparedLaunchId: string } {
  if (typeof prepared.preparedLaunchId !== "string") {
    throw new OwnedRuntimeError(
      "STORAGE_UNVERIFIABLE",
      "Owned game-launch preparation did not publish its durable descriptor.",
    );
  }
}

async function executeGameLaunchMutation(
  application: Pick<ObserverApplication, "prepareLaunch" | "revokeSession">,
  manager: OwnedRuntimeManager,
  plan: CanonicalGameLaunchPreparation,
  revalidationDeadlineAtMs: number,
  executableMaximumBytes: number,
  afterRuntimeId?: string,
): Promise<GameLaunchMutationResult> {
  const prepared = await manager.prepareInitialOwnedGameLaunch({
    launchInput: plan.launchInput,
    evidence: plan.evidence,
    ...(afterRuntimeId === undefined ? {} : { afterRuntimeId }),
    prepare: (attemptLaunchInput) => prepareObserverLaunch(application, attemptLaunchInput),
    revokeSession: (sessionId) => application.revokeSession(sessionId),
  });
  requirePreparedLaunchId(prepared);
  try {
    const runtime = await manager.start({
      preparedLaunchId: prepared.preparedLaunchId,
      idempotencyKey: deriveOwnedGameLaunchAttemptKey("start", {
        delivery: "owned",
        compositeAttemptId: prepared.compositeAttemptId,
        canonicalFingerprint: prepared.canonicalFingerprint,
      }),
      revalidationDeadlineAtMs,
      executableMaximumBytes,
    });
    return { prepared, runtime };
  } catch (error) {
    if (!(error instanceof OwnedRuntimePreconsumptionError)) throw error;
    try {
      await application.revokeSession(prepared.sessionId);
    } catch {
      throw new OwnedRuntimeError(
        "RECOVERY_REQUIRED",
        "Prepared game launch was invalidated before consumption, but session revocation could not be confirmed.",
      );
    }
    throw error.planningError;
  }
}

function extractApplicationError(error: unknown): PublicObserverErrorCandidate | undefined {
  if (error instanceof OwnedRuntimeError) return extractOwnedRuntimeError(error);
  if (!(error instanceof ObserverApplicationError)) return undefined;
  return {
    code: error.code,
    readDiagnosticMessage: () => error.message,
    readDetails: () => error.details,
  };
}

function projectObserverFailure(
  error: unknown,
  action: "start" | "status" | "stop" | "list",
  sessionId?: string,
): string {
  const remedySessionId = gameLaunchRemedySessionIdSchema.safeParse(sessionId);
  return projectPublicObserverToolError(error, {
    subject: "Observer runtime error",
    extract: extractApplicationError,
    remedyContext: {
      tool: action === "list" ? "observer_instances" : "game_launch",
      action,
      ...(remedySessionId.success ? { sessionId: remedySessionId.data } : {}),
      ...(error instanceof OwnedRuntimeError && error.remedyReason !== undefined
        ? { reason: error.remedyReason }
        : {}),
    },
    resolveRemedy: resolveObserverRefusalRemedy,
    readRemedyContext: () => error instanceof OwnedRuntimeError || error instanceof ObserverApplicationError
      ? error.details
      : undefined,
  });
}

function gameLaunchToolError(error: unknown, action: "start" | "status" | "stop") {
  const text = error instanceof GameLaunchPlanError
    ? projectPublicGameLaunchPlanError(error)
    : error instanceof OwnedRuntimeError || error instanceof ObserverApplicationError
      ? projectObserverFailure(error, action)
      : projectPublicGameLaunchPlanError(error);
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

async function waitForRenderInstance(
  application: Pick<ObserverApplication, "instances">,
  sessionId: string,
  waitForInstanceMs: number,
  signal?: AbortSignal,
): Promise<GameLaunchReadiness> {
  try {
    const inventory = await application.instances({
      sessionId,
      requiredCapabilities: ["render.capture"],
      renderersOnly: true,
      waitMs: waitForInstanceMs,
      ...(signal === undefined ? {} : { signal }),
    });
    if (inventory.compatibleCount > 0) return { inventory };
    return {
      inventory,
      warning: waitForInstanceMs === 0
        ? GAME_LAUNCH_READINESS_WARNING.notRequested
        : GAME_LAUNCH_READINESS_WARNING.timedOut,
    };
  } catch (error) {
    return {
      inventory: null,
      warning: GAME_LAUNCH_READINESS_WARNING.failed,
      readinessError: projectObserverFailure(error, "list", sessionId),
    };
  }
}

function firstOpaqueTarget(inventory: ObserverInstanceList | null): string | null {
  if (!inventory) return null;
  for (const instance of inventory.instances) {
    if (typeof instance.target === "string" && instance.target.length > 0) return instance.target;
  }
  return null;
}

function startPresentation(
  plan: CanonicalGameLaunchPreparation,
  mutation: GameLaunchMutationResult,
  readiness: GameLaunchReadiness,
) {
  const target = firstOpaqueTarget(readiness.inventory);
  return {
    action: "start",
    compositeAttemptId: mutation.prepared.compositeAttemptId,
    chain: mutation.runtime.chain ?? mutation.prepared.chain,
    runtime: mutation.runtime,
    sessionId: mutation.prepared.sessionId,
    preparedLaunchId: mutation.prepared.preparedLaunchId,
    preparation: {
      expiresAt: mutation.prepared.expiresAt,
      bundleDigest: mutation.prepared.bundleDigest,
      warnings: mutation.prepared.warnings,
    },
    project: {
      gprojPath: plan.project.displayPath,
      selection: plan.projectSelection,
    },
    executablePath: plan.executable.executablePath,
    profilePath: plan.profilePath,
    world: {
      path: plan.world.worldPath,
      metadataPath: plan.world.metaPath,
      guid: plan.world.guid,
      relativePath: plan.world.relativePath,
      resourceReference: plan.world.resourceReference,
    },
    addons: {
      targetGuid: plan.addons.targetGuid,
      dependencyGuids: plan.addons.dependencyGuids,
      emittedRoots: plan.addons.emittedAddonRoots,
      implicitRoots: plan.addons.implicitAddonRoots,
      rootProvenance: plan.addons.roots.map((root) => ({
        path: root.path,
        provenance: root.provenance,
        emitted: root.emitted,
      })),
    },
    evidence: {
      world: plan.world.worldEvidenceDigest,
      addons: plan.addons.addonEvidenceDigest,
      executable: plan.executable.executableEvidenceDigest,
    },
    arguments: mutation.prepared.arguments,
    instanceWait: readiness.inventory,
    ...(readiness.warning === undefined ? {} : { readinessWarning: readiness.warning }),
    ...(readiness.readinessError === undefined
      ? {}
      : { readinessError: readiness.readinessError }),
    next: {
      status: { tool: "game_launch", input: { action: "status", runtimeId: mutation.runtime.runtimeId } },
      capture: target === null
        ? {
            ready: false,
            firstCall: {
              tool: "observer_instances",
              input: {
                sessionId: mutation.prepared.sessionId,
                requiredCapabilities: ["render.capture"],
                renderersOnly: true,
                waitMs: 60_000,
              },
            },
            instruction: "Use the opaque target returned by observer_instances in observer_capture.",
          }
        : { ready: true, tool: "observer_capture", input: { target } },
      stop: { tool: "game_launch", input: { action: "stop", runtimeId: mutation.runtime.runtimeId } },
    },
  };
}

function lifecyclePresentation(
  action: "status" | "stop",
  runtime: OwnedRuntimePublicStatus,
) {
  return {
    action,
    runtime,
    next: action === "status"
      ? { stop: { tool: "game_launch", input: { action: "stop", runtimeId: runtime.runtimeId } } }
      : {
          status: { tool: "game_launch", input: { action: "status", runtimeId: runtime.runtimeId } },
          ...(runtime.chain?.successor.eligible === true
            ? {
                successor: {
                  tool: "game_launch",
                  input: { action: "start", afterRuntimeId: runtime.chain.successor.afterRuntimeId },
                  instruction: "Repeat the desired start fields and retain this exact afterRuntimeId fence.",
                },
              }
            : {}),
        },
  };
}

function gameLaunchToolSuccess(value: unknown) {
  const structuredContent = gameLaunchSuccessSchema.parse(value);
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(structuredContent, null, 2),
    }],
    structuredContent,
  };
}

export function registerGameLaunch(
  server: McpServer,
  application: ObserverApplication,
  options: RegisterGameLaunchOptions,
): void {
  const planningDeadlineMs = options.planningDeadlineMs ?? GAME_LAUNCH_PLANNING_DEADLINE_MS;
  const executableMaximumBytes = options.executableMaximumBytes ??
    GAME_LAUNCH_EXECUTABLE_MAXIMUM_BYTES;
  if (!Number.isSafeInteger(planningDeadlineMs) || planningDeadlineMs < 1 ||
      planningDeadlineMs > 5 * 60_000) {
    throw new TypeError("Game-launch planning deadline must be from 1 through 300000 milliseconds");
  }
  if (!Number.isSafeInteger(executableMaximumBytes) || executableMaximumBytes < 1) {
    throw new TypeError("Game-launch executable byte limit must be a positive safe integer");
  }
  const configuredAddonRoots = Object.freeze([...(options.configuredAddonRoots ?? [])]);
  const mutationInFlight = new Map<string, Promise<GameLaunchMutationResult>>();
  const startInFlight = new Map<string, SharedGameLaunchStart>();

  const createSharedStart = (input: GameLaunchStartInput): SharedGameLaunchStart => {
    const controller = new AbortController();
    const deadlineAtMs = Date.now() + planningDeadlineMs;
    let operation!: SharedGameLaunchStart;
    const promise = (async () => {
      const activeProjectHint = await resolveIsolatedPlanningHint(
        input,
        options,
        controller.signal,
        deadlineAtMs,
      );
      assertPlanningOpen(controller.signal, deadlineAtMs);
      const executableSource = options.manager.resolveRuntimeExecutablePlanningSource(
        input.runtimeKind,
      );
      assertPlanningOpen(controller.signal, deadlineAtMs);
      const plan = await (options.isolatedPlanner ?? planCanonicalGameLaunchIsolated)({
        application: {
          managedRoot: application.managedRoot,
          profileRoot: application.profileRoot,
        },
        input,
        configuredAddonRoots,
        ...(input.gprojPath === undefined ? { activeProjectHint: activeProjectHint ?? null } : {}),
        executableSource,
        executableMaximumBytes,
        deadlineAtMs,
      }, controller.signal);
      // The worker can publish its logical result just before cancellation or
      // expiry and then spend time joining physical exit. Reassert the shared
      // planning fence after that join and before any durable preparation or
      // lifecycle mutation can begin.
      assertPlanningOpen(controller.signal, deadlineAtMs);
      operation.planning = false;

      const mutationKey = `${plan.prepareKey}\0${input.afterRuntimeId ?? "initial"}`;
      let mutation = mutationInFlight.get(mutationKey);
      if (!mutation) {
        if (mutationInFlight.size >= GAME_LAUNCH_IN_FLIGHT_MAXIMUM) {
          throw new OwnedRuntimeError(
            "STORE_CAPACITY_EXCEEDED",
            "Too many game-launch mutations are already in flight.",
          );
        }
        mutation = executeGameLaunchMutation(
          application,
          options.manager,
          plan,
          deadlineAtMs,
          executableMaximumBytes,
          input.afterRuntimeId,
        );
        mutationInFlight.set(mutationKey, mutation);
        void mutation.finally(() => {
          if (mutationInFlight.get(mutationKey) === mutation) {
            mutationInFlight.delete(mutationKey);
          }
        }).catch(() => undefined);
      }
      return { plan, mutation: await mutation };
    })();
    operation = {
      controller,
      promise,
      subscribers: 0,
      planning: true,
    };
    return operation;
  };

  server.registerTool(
    "game_launch",
    {
      title: "Launch or manage an exact-owned game runtime",
      description:
        "Plan and start one exact-owned graphical Arma Reforger runtime, or inspect/stop a returned runtimeId. Start defaults to listenServer and the active owned Workbench project hint when available; an explicit gprojPath must be absolute. Legacy runtimeKind client means standalone -world and never the engine's -client replication mode. A deliberate same-profile successor requires the exact afterRuntimeId offered only after completed stop/restoration/session cleanup. Exact retries recover their durable composite attempt; natural exit and unknown outcomes never authorize relaunch. World, add-on, executable, native-fullscreen, observer preparation, and owned-process evidence are fail-closed. A readiness timeout never hides a successfully started process.",
      inputSchema: gameLaunchRawInputShape,
      outputSchema: gameLaunchOutputSchema,
    },
    async (rawInput, extra) => {
      let action: "start" | "status" | "stop" = "start";
      try {
        const input = parseGameLaunchInput(rawInput, options.defaultSessionTtlMs);
        action = input.action;
        if (input.action === "status") {
          const runtime = await executeOwnedRuntimeOperation(options.manager, input);
          return gameLaunchToolSuccess(lifecyclePresentation("status", runtime));
        }
        if (input.action === "stop") {
          const runtime = await executeOwnedRuntimeOperation(options.manager, input, extra.signal);
          return gameLaunchToolSuccess(lifecyclePresentation("stop", runtime));
        }

        if (extra.signal.aborted) {
          throw new OwnedRuntimeError("CANCELLED", "Game launch planning was cancelled");
        }
        const planningKey = computeGameLaunchPlanningKey(input);
        let operation = startInFlight.get(planningKey);
        if (!operation) {
          if (startInFlight.size >= GAME_LAUNCH_IN_FLIGHT_MAXIMUM) {
            throw new OwnedRuntimeError(
              "STORE_CAPACITY_EXCEEDED",
              "Too many game-launch starts are already admitted.",
            );
          }
          operation = createSharedStart(input);
          startInFlight.set(planningKey, operation);
          void operation.promise.finally(() => {
            if (startInFlight.get(planningKey) === operation) startInFlight.delete(planningKey);
          }).catch(() => undefined);
        }
        const { plan, mutation: started } = await awaitSharedGameLaunchStart(
          operation,
          extra.signal,
        );
        const readiness = await waitForRenderInstance(
          application,
          started.prepared.sessionId,
          input.waitForInstanceMs,
          extra.signal,
        );
        return gameLaunchToolSuccess(startPresentation(plan, started, readiness));
      } catch (error) {
        return gameLaunchToolError(error, action);
      }
    },
  );
}
