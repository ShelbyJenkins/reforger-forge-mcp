import { parentPort, workerData } from "node:worker_threads";
import { GameLaunchPlanError } from "./game-launch-errors.js";
import type {
  IsolatedGameLaunchPlanningRequest,
  IsolatedGameLaunchPlanningResponse,
  SerializedPlanningError,
} from "./game-launch-planning-isolation.js";
import {
  OwnedRuntimeError,
  resolveRuntimeExecutableEvidenceFromSource,
  type OwnedRuntimeManager,
} from "../observer/owned-runtime-manager.js";
import type { ObserverApplication } from "../observer/application.js";
import {
  planCanonicalGameLaunch,
  type CanonicalGameLaunchPlanningOptions,
} from "../tools/game-launch.js";

function serializeError(error: unknown): SerializedPlanningError {
  if (error instanceof GameLaunchPlanError) {
    return {
      kind: "gameLaunchPlan",
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.candidates.length === 0 ? {} : { candidates: error.candidates }),
      ...(error.remedy === undefined ? {} : { remedy: error.remedy }),
    };
  }
  if (error instanceof OwnedRuntimeError) {
    return {
      kind: "ownedRuntime",
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.remedyReason === undefined ? {} : { remedyReason: error.remedyReason }),
    };
  }
  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : "Game launch planning failed",
  };
}

async function run(request: IsolatedGameLaunchPlanningRequest): Promise<void> {
  if (!parentPort) throw new Error("Game launch planning worker has no parent port");
  try {
    if (Date.now() >= request.deadlineAtMs) {
      throw new GameLaunchPlanError(
        "PLANNING_TIMEOUT",
        "Game launch planning exceeded its absolute elapsed-time deadline.",
      );
    }
    const manager = {
      resolveRuntimeExecutableEvidence: () => resolveRuntimeExecutableEvidenceFromSource(
        request.executableSource,
        request.input.runtimeKind,
        request.executableMaximumBytes,
      ),
    } as unknown as OwnedRuntimeManager;
    const application = request.application as ObserverApplication;
    const options: CanonicalGameLaunchPlanningOptions = {
      manager,
      configuredAddonRoots: request.configuredAddonRoots,
      defaultSessionTtlMs: request.input.sessionTtlMs,
      ...(request.input.gprojPath === undefined
        ? {
            workbenchClient: {
              activeProjectGprojPath: async () => request.activeProjectHint ?? null,
            },
          }
        : {}),
    };
    const plan = await planCanonicalGameLaunch(application, request.input, options);
    if (Date.now() >= request.deadlineAtMs) {
      throw new GameLaunchPlanError(
        "PLANNING_TIMEOUT",
        "Game launch planning exceeded its absolute elapsed-time deadline.",
      );
    }
    const response: IsolatedGameLaunchPlanningResponse = { ok: true, plan };
    parentPort.postMessage(response);
  } catch (error) {
    const response: IsolatedGameLaunchPlanningResponse = { ok: false, error: serializeError(error) };
    parentPort.postMessage(response);
  } finally {
    parentPort.close();
  }
}

void run(workerData as IsolatedGameLaunchPlanningRequest);
