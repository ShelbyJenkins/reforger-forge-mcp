import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import {
  GameLaunchPlanError,
  type GameLaunchPlanErrorCode,
  type GameLaunchPlanRemedy,
  type GameWorldDiagnosticCandidate,
} from "./game-launch-errors.js";
import type { GameAddonPlanSnapshot } from "./game-addon-plan.js";
import type { GameWorldPlanSnapshot } from "./game-world-plan.js";
import type {
  OwnedRuntimeExecutableEvidence,
  OwnedRuntimeExecutablePlanningSource,
} from "../observer/owned-runtime-manager.js";

interface IsolatedGameLaunchRevalidationBase {
  readonly executableMaximumBytes: number;
  readonly deadlineAtMs: number;
}

export type IsolatedGameLaunchRevalidationRequest =
  | (IsolatedGameLaunchRevalidationBase & {
      readonly phase: "baseline_executable";
      readonly executableSource: OwnedRuntimeExecutablePlanningSource;
      readonly runtimeKind: OwnedRuntimeExecutableEvidence["runtimeKind"];
    })
  | (IsolatedGameLaunchRevalidationBase & {
      readonly phase: "pre_spawn";
      readonly world: GameWorldPlanSnapshot;
      readonly addons: GameAddonPlanSnapshot;
      readonly executableSource: OwnedRuntimeExecutablePlanningSource;
      readonly expectedExecutable: OwnedRuntimeExecutableEvidence;
    })
  | (IsolatedGameLaunchRevalidationBase & {
      readonly phase: "post_spawn_executable";
      readonly expectedExecutable: OwnedRuntimeExecutableEvidence;
    });

interface SerializedGameLaunchPlanError {
  readonly kind: "gameLaunchPlan";
  readonly code: GameLaunchPlanErrorCode;
  readonly message: string;
  readonly details?: unknown;
  readonly candidates?: readonly GameWorldDiagnosticCandidate[];
  readonly remedy?: GameLaunchPlanRemedy;
}

interface SerializedOwnedRuntimeError {
  readonly kind: "ownedRuntime";
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly remedyReason?: string;
}

interface SerializedUnknownError {
  readonly kind: "unknown";
  readonly message: string;
}

export type SerializedGameLaunchRevalidationError =
  | SerializedGameLaunchPlanError
  | SerializedOwnedRuntimeError
  | SerializedUnknownError;

export type IsolatedGameLaunchRevalidationResponse =
  | { readonly ok: true; readonly executable: OwnedRuntimeExecutableEvidence }
  | { readonly ok: false; readonly error: SerializedGameLaunchRevalidationError };

/** Non-planning worker failures are adapted by the lifecycle phase that receives them. */
export class GameLaunchRevalidationIsolationError extends Error {
  constructor(
    readonly kind: "ownedRuntime" | "unknown",
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GameLaunchRevalidationIsolationError";
  }
}

export type GameLaunchRevalidationWorkerFactory = (
  url: URL,
  options: WorkerOptions,
) => Worker;

export function gameLaunchRevalidationDeadlineError(): GameLaunchPlanError {
  return new GameLaunchPlanError(
    "PLANNING_TIMEOUT",
    "Game-launch point-of-use revalidation exceeded its absolute elapsed-time deadline.",
  );
}

function workerEntry(): { url: URL; typescript: boolean } {
  const typescript = extname(fileURLToPath(import.meta.url)).toLowerCase() === ".ts";
  return {
    url: new URL(`./game-launch-revalidation-worker.${typescript ? "ts" : "js"}`, import.meta.url),
    typescript,
  };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rehydrateError(value: unknown): Error {
  if (!plainRecord(value) || typeof value.kind !== "string" ||
      typeof value.message !== "string") {
    return new GameLaunchRevalidationIsolationError(
      "unknown",
      "INVALID_WORKER_RESPONSE",
      "Game-launch revalidation worker returned an invalid error.",
    );
  }
  if (value.kind === "gameLaunchPlan" && typeof value.code === "string") {
    try {
      return new GameLaunchPlanError(value.code as GameLaunchPlanErrorCode, value.message, {
        ...(value.details === undefined ? {} : { details: value.details }),
        ...(Array.isArray(value.candidates)
          ? { candidates: value.candidates as GameWorldDiagnosticCandidate[] }
          : {}),
        ...(value.remedy === undefined ? {} : { remedy: value.remedy as GameLaunchPlanRemedy }),
      });
    } catch {
      return new GameLaunchRevalidationIsolationError(
        "unknown",
        "INVALID_WORKER_RESPONSE",
        "Game-launch revalidation worker returned an invalid planning error.",
      );
    }
  }
  if (value.kind === "ownedRuntime" && typeof value.code === "string") {
    return new GameLaunchRevalidationIsolationError(
      "ownedRuntime",
      value.code,
      value.message,
      plainRecord(value.details) ? value.details : undefined,
    );
  }
  return new GameLaunchRevalidationIsolationError(
    "unknown",
    "WORKER_FAILED",
    value.message || "Game-launch revalidation worker failed.",
  );
}

/**
 * Run blocking point-of-use reads outside the MCP event loop. The worker is
 * always terminated when the single absolute deadline expires or a response
 * is accepted, so late filesystem work cannot detach from the start attempt.
 */
function revalidateGameLaunchPointOfUseWithWorkerFactory(
  request: IsolatedGameLaunchRevalidationRequest,
  signal?: AbortSignal,
  workerFactory: GameLaunchRevalidationWorkerFactory = (url, options) =>
    new Worker(url, options),
): Promise<OwnedRuntimeExecutableEvidence> {
  if (signal?.aborted) {
    return Promise.reject(new GameLaunchRevalidationIsolationError(
      "unknown",
      "ABORTED",
      "Game-launch point-of-use revalidation was aborted before worker startup.",
    ));
  }
  const remainingMs = request.deadlineAtMs - Date.now();
  if (!Number.isSafeInteger(request.deadlineAtMs) || remainingMs <= 0) {
    return Promise.reject(gameLaunchRevalidationDeadlineError());
  }
  if (!Number.isSafeInteger(request.executableMaximumBytes) ||
      request.executableMaximumBytes < 1) {
    return Promise.reject(new TypeError(
      "Game-launch revalidation executable byte limit must be a positive safe integer.",
    ));
  }
  const entry = workerEntry();
  const worker = workerFactory(entry.url, {
    workerData: request,
    ...(entry.typescript ? { execArgv: ["--import", "tsx"] } : {}),
  });
  // Observe physical exit independently from the outcome listener. `finish`
  // removes its classification listener, but this join remains installed
  // before termination can begin and is the proof that no worker work remains.
  const workerExited = new Promise<void>((resolve) => {
    worker.once("exit", () => resolve());
  });
  worker.unref();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => {
      void finish({
        error: new GameLaunchRevalidationIsolationError(
          "unknown",
          "ABORTED",
          "Game-launch point-of-use revalidation was aborted after lifecycle authority ended.",
        ),
      });
    };
    const onMessage = (value: unknown): void => {
      if (!plainRecord(value) || typeof value.ok !== "boolean") {
        void finish({
          error: new GameLaunchRevalidationIsolationError(
            "unknown",
            "INVALID_WORKER_RESPONSE",
            "Game-launch revalidation worker returned an invalid response.",
          ),
        });
        return;
      }
      const response = value as IsolatedGameLaunchRevalidationResponse;
      void finish(response.ok && response.executable !== undefined
        ? { executable: response.executable }
        : !response.ok
          ? { error: rehydrateError(response.error) }
          : {
              error: new GameLaunchRevalidationIsolationError(
                "unknown",
                "INVALID_WORKER_RESPONSE",
                "Game-launch revalidation worker returned no executable evidence.",
              ),
            });
    };
    const onError = (): void => {
      void finish({
        error: new GameLaunchRevalidationIsolationError(
          "unknown",
          "WORKER_FAILED",
          "Game-launch revalidation worker failed.",
        ),
      });
    };
    const onExit = (): void => {
      if (!settled) {
        void finish({
          error: new GameLaunchRevalidationIsolationError(
            "unknown",
            "WORKER_EXITED",
            "Game-launch revalidation worker exited before completion.",
          ),
        });
      }
    };

    const finish = async (outcome: {
      readonly executable?: OwnedRuntimeExecutableEvidence;
      readonly error?: Error;
    }): Promise<void> => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      let terminationFailed = false;
      try {
        await worker.terminate();
      } catch {
        terminationFailed = true;
      }
      // A rejected terminate() is not evidence that the thread stopped. Stay
      // pending until the independently observed exit rather than publishing
      // a timeout/error while blocking filesystem work could still continue.
      await workerExited;
      if (terminationFailed) {
        reject(new GameLaunchRevalidationIsolationError(
          "unknown",
          "WORKER_TERMINATION_FAILED",
          "Game-launch revalidation worker could not be terminated cleanly.",
        ));
        return;
      }
      if (outcome.error !== undefined) reject(outcome.error);
      else if (outcome.executable !== undefined) resolve(outcome.executable);
      else reject(new GameLaunchRevalidationIsolationError(
        "unknown",
        "INVALID_WORKER_RESPONSE",
        "Game-launch revalidation worker produced no result.",
      ));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    // Close the small race between the pre-spawn abort check and listener
    // registration. `finish` owns and joins worker termination in either path.
    if (signal?.aborted) {
      onAbort();
      return;
    }
    // Worker construction includes structured-cloning workerData. Recompute
    // against the same absolute deadline after that synchronous work so it
    // cannot extend the kill budget by reusing the pre-construction duration.
    const postConstructionRemainingMs = request.deadlineAtMs - Date.now();
    if (postConstructionRemainingMs <= 0) {
      void finish({ error: gameLaunchRevalidationDeadlineError() });
      return;
    }
    timer = setTimeout(() => {
      void finish({ error: gameLaunchRevalidationDeadlineError() });
    }, postConstructionRemainingMs);
    timer.unref?.();
  });
}

/** Build a revalidator around an explicit worker factory for lifecycle tests. */
export function createGameLaunchPointOfUseIsolatedRevalidator(
  workerFactory: GameLaunchRevalidationWorkerFactory,
): (
  request: IsolatedGameLaunchRevalidationRequest,
  signal?: AbortSignal,
) => Promise<OwnedRuntimeExecutableEvidence> {
  return (request, signal) =>
    revalidateGameLaunchPointOfUseWithWorkerFactory(request, signal, workerFactory);
}

export function revalidateGameLaunchPointOfUseIsolated(
  request: IsolatedGameLaunchRevalidationRequest,
  signal?: AbortSignal,
): Promise<OwnedRuntimeExecutableEvidence> {
  return revalidateGameLaunchPointOfUseWithWorkerFactory(request, signal);
}
