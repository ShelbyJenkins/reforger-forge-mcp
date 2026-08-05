import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
  OwnedRuntimeError,
  OwnedRuntimePreconsumptionError,
  type OwnedGameLaunchPreparationEvidence,
  type OwnedRuntimeExecutableEvidence,
  type OwnedRuntimeManager,
  type OwnedRuntimePublicStatus,
} from "../observer/owned-runtime-manager.js";
import {
  projectPublicObserverToolError,
  type PublicObserverErrorCandidate,
} from "../observer/public-contract.js";
import { resolveObserverRefusalRemedy } from "../observer/refusal-remedy.js";
import type { WorkbenchClient } from "../workbench/client.js";
import {
  canonicalizeGproj,
  ProjectIdentityError,
  type CanonicalProjectIdentity,
} from "../workbench/project-identity.js";
import {
  executeOwnedRuntimeOperation,
  extractOwnedRuntimeError,
  ownedRuntimeIdSchema,
} from "./owned-runtime-operations.js";

export const GAME_LAUNCH_PREPARE_IDENTITY_VERSION = 1 as const;
export const GAME_LAUNCH_PREPARE_KEY_PREFIX = "mcp-game-launch-prepare-v1-";
export const GAME_LAUNCH_IN_FLIGHT_MAXIMUM = 32;

const boundedNonblank = z.string().trim().min(1).max(32_768);
const sessionTtlSchema = z.number().int().min(1_000).max(24 * 60 * 60 * 1_000);
const waitSchema = z.number().int().min(0).max(5 * 60 * 1_000);
const additionalArgumentsSchema = z.array(
  z.string().min(1).max(COMPOSITE_ARGUMENT_MAXIMUM_TOKEN_LENGTH),
).max(COMPOSITE_ARGUMENT_MAXIMUM_COUNT);

export const gameLaunchRawInputShape = {
  action: z.enum(["start", "status", "stop"]).optional(),
  gprojPath: boundedNonblank.optional(),
  world: boundedNonblank.optional(),
  runtimeKind: z.enum(["client", "listenServer"]).optional(),
  arguments: additionalArgumentsSchema.optional(),
  waitForInstanceMs: waitSchema.optional(),
  sessionTtlMs: sessionTtlSchema.optional(),
  forceUpdate: z.boolean().optional(),
  noFocus: z.boolean().optional(),
  forceNonNativeWindowSize: forceNonNativeWindowSizeSchema.optional(),
  runtimeId: ownedRuntimeIdSchema.optional(),
  waitForRestorationMs: waitSchema.optional(),
} as const;

export const gameLaunchRawInputSchema = z.object(gameLaunchRawInputShape).strict();
export const gameLaunchStartInputSchema = z.object({
  action: z.literal("start"),
  gprojPath: boundedNonblank.optional(),
  world: boundedNonblank.optional(),
  runtimeKind: z.enum(["client", "listenServer"]).default("listenServer"),
  arguments: additionalArgumentsSchema.default([]),
  waitForInstanceMs: waitSchema.default(60_000),
  sessionTtlMs: sessionTtlSchema,
  forceUpdate: z.boolean().default(true),
  noFocus: z.boolean().default(true),
  forceNonNativeWindowSize: forceNonNativeWindowSizeSchema.optional(),
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
  readonly workbenchClient?: Pick<WorkbenchClient, "activeProjectGprojPath">;
  readonly configuredAddonRoots?: readonly string[];
  readonly defaultSessionTtlMs: number;
}

interface GameLaunchMutationResult {
  readonly prepared: ObserverPreparedLaunch & { readonly preparedLaunchId: string };
  readonly runtime: OwnedRuntimePublicStatus;
}

interface GameLaunchReadiness {
  readonly inventory: ObserverInstanceList | null;
  readonly warning?: string;
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
  workbenchClient: RegisterGameLaunchOptions["workbenchClient"],
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
  options: RegisterGameLaunchOptions,
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
    schemaVersion: 1,
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
): Promise<GameLaunchMutationResult> {
  const prepared = await manager.prepareInitialOwnedGameLaunch({
    launchInput: plan.launchInput,
    evidence: plan.evidence,
    prepare: () => prepareObserverLaunch(application, plan.launchInput),
    revokeSession: (sessionId) => application.revokeSession(sessionId),
  });
  requirePreparedLaunchId(prepared);
  try {
    const runtime = await executeOwnedRuntimeOperation(manager, {
      action: "start",
      preparedLaunchId: prepared.preparedLaunchId,
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

function projectObserverFailure(error: unknown, action: "start" | "status" | "stop" | "list"): string {
  return projectPublicObserverToolError(error, {
    subject: "Observer runtime error",
    extract: extractApplicationError,
    remedyContext: {
      tool: action === "list" ? "observer_instances" : "game_launch",
      action,
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
        ? "The owned runtime started; render-instance readiness was not requested."
        : "The owned runtime started, but no matching render-capable observer instance became ready before the wait ended.",
    };
  } catch (error) {
    return {
      inventory: null,
      warning: `The owned runtime started, but readiness could not be confirmed. ${projectObserverFailure(error, "list")}`,
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
      : { status: { tool: "game_launch", input: { action: "status", runtimeId: runtime.runtimeId } } },
  };
}

function jsonText(heading: string, value: unknown): string {
  return `${heading}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export function registerGameLaunch(
  server: McpServer,
  application: ObserverApplication,
  options: RegisterGameLaunchOptions,
): void {
  const inFlight = new Map<string, Promise<GameLaunchMutationResult>>();
  server.registerTool(
    "game_launch",
    {
      description:
        "Plan and start one exact-owned graphical Arma Reforger runtime, or inspect/stop a returned runtimeId. Start defaults to listenServer and the active owned Workbench project hint when available; an explicit gprojPath must be absolute. World, add-on, executable, native-fullscreen, observer preparation, and owned-process evidence are fail-closed. A readiness timeout never hides a successfully started process.",
      inputSchema: gameLaunchRawInputShape,
    },
    async (rawInput, extra) => {
      let action: "start" | "status" | "stop" = "start";
      try {
        const input = parseGameLaunchInput(rawInput, options.defaultSessionTtlMs);
        action = input.action;
        if (input.action === "status") {
          const runtime = await executeOwnedRuntimeOperation(options.manager, input);
          return {
            content: [{
              type: "text" as const,
              text: jsonText("Exact-owned game runtime status.", lifecyclePresentation("status", runtime)),
            }],
          };
        }
        if (input.action === "stop") {
          const runtime = await executeOwnedRuntimeOperation(options.manager, input, extra.signal);
          return {
            content: [{
              type: "text" as const,
              text: jsonText("Exact-owned game runtime stopped.", lifecyclePresentation("stop", runtime)),
            }],
          };
        }

        const plan = await planCanonicalGameLaunch(application, input, options);
        let mutation = inFlight.get(plan.prepareKey);
        if (!mutation) {
          if (inFlight.size >= GAME_LAUNCH_IN_FLIGHT_MAXIMUM) {
            throw new OwnedRuntimeError(
              "STORE_CAPACITY_EXCEEDED",
              "Too many game-launch mutations are already in flight.",
            );
          }
          mutation = executeGameLaunchMutation(application, options.manager, plan);
          inFlight.set(plan.prepareKey, mutation);
          void mutation.finally(() => {
            if (inFlight.get(plan.prepareKey) === mutation) inFlight.delete(plan.prepareKey);
          }).catch(() => undefined);
        }
        const started = await mutation;
        const readiness = await waitForRenderInstance(
          application,
          started.prepared.sessionId,
          input.waitForInstanceMs,
          extra.signal,
        );
        return {
          content: [{
            type: "text" as const,
            text: jsonText(
              readiness.warning === undefined
                ? "Exact-owned game runtime started and became render-ready."
                : "Exact-owned game runtime started; inspect readiness guidance.",
              startPresentation(plan, started, readiness),
            ),
          }],
        };
      } catch (error) {
        return gameLaunchToolError(error, action);
      }
    },
  );
}
