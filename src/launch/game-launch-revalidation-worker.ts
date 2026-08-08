import { parentPort, workerData } from "node:worker_threads";
import { revalidateGameAddonPlan } from "./game-addon-plan.js";
import { GameLaunchPlanError } from "./game-launch-errors.js";
import {
  type IsolatedGameLaunchRevalidationRequest,
  type IsolatedGameLaunchRevalidationResponse,
  type SerializedGameLaunchRevalidationError,
} from "./game-launch-revalidation-isolation.js";
import { revalidateGameWorldPlan } from "./game-world-plan.js";
import {
  OwnedRuntimeError,
  resolveRuntimeExecutableEvidenceFromSource,
} from "../observer/owned-runtime-manager.js";

function serializeError(error: unknown): SerializedGameLaunchRevalidationError {
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
    message: error instanceof Error ? error.message : "Game-launch revalidation failed.",
  };
}

function assertDeadline(request: IsolatedGameLaunchRevalidationRequest): void {
  if (Date.now() >= request.deadlineAtMs) {
    throw new GameLaunchPlanError(
      "PLANNING_TIMEOUT",
      "Game-launch point-of-use revalidation exceeded its absolute elapsed-time deadline.",
    );
  }
}

async function run(request: IsolatedGameLaunchRevalidationRequest): Promise<void> {
  if (!parentPort) throw new Error("Game-launch revalidation worker has no parent port.");
  try {
    assertDeadline(request);
    if (request.phase === "pre_spawn") {
      revalidateGameWorldPlan(request.world);
      assertDeadline(request);
      revalidateGameAddonPlan(request.addons);
      assertDeadline(request);
    }
    const executable = resolveRuntimeExecutableEvidenceFromSource(
      request.phase === "post_spawn_executable"
        ? { kind: "executablePath", executablePath: request.expectedExecutable.executablePath }
        : request.executableSource,
      request.phase === "baseline_executable"
        ? request.runtimeKind
        : request.expectedExecutable.runtimeKind,
      request.executableMaximumBytes,
    );
    assertDeadline(request);
    if (request.phase === "baseline_executable") {
      const response: IsolatedGameLaunchRevalidationResponse = { ok: true, executable };
      parentPort.postMessage(response);
      return;
    }
    // Both values are native-realpath canonical spellings. Preserve exact case:
    // Windows directories may be case-sensitive, so case folding would merge
    // distinct executable identities and regress the canonical-path contract.
    if (executable.executablePath !== request.expectedExecutable.executablePath ||
        executable.executableEvidenceDigest !==
          request.expectedExecutable.executableEvidenceDigest) {
      throw new GameLaunchPlanError(
        "EXECUTABLE_CHANGED",
        request.phase === "pre_spawn"
          ? "Configured runtime executable changed after game-launch planning."
          : "Configured runtime executable was replaced during start.",
      );
    }
    const response: IsolatedGameLaunchRevalidationResponse = { ok: true, executable };
    parentPort.postMessage(response);
  } catch (error) {
    const response: IsolatedGameLaunchRevalidationResponse = {
      ok: false,
      error: serializeError(error),
    };
    parentPort.postMessage(response);
  } finally {
    parentPort.close();
  }
}

void run(workerData as IsolatedGameLaunchRevalidationRequest);
