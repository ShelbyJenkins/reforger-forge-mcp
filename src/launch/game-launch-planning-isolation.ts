import { Worker, type WorkerOptions } from "node:worker_threads";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameWorldDiagnosticCandidate, GameLaunchPlanRemedy } from "./game-launch-errors.js";
import { GameLaunchPlanError, type GameLaunchPlanErrorCode } from "./game-launch-errors.js";
import {
  OwnedRuntimeError,
  type OwnedRuntimeExecutablePlanningSource,
} from "../observer/owned-runtime-manager.js";
import type {
  CanonicalGameLaunchPreparation,
  GameLaunchStartInput,
} from "../tools/game-launch.js";

export interface IsolatedGameLaunchPlanningRequest {
  readonly application: {
    readonly managedRoot: string;
    readonly profileRoot: string;
  };
  readonly input: GameLaunchStartInput;
  readonly configuredAddonRoots: readonly string[];
  readonly activeProjectHint?: string | null;
  readonly executableSource: OwnedRuntimeExecutablePlanningSource;
  readonly executableMaximumBytes: number;
  readonly deadlineAtMs: number;
}

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

export type SerializedPlanningError =
  | SerializedGameLaunchPlanError
  | SerializedOwnedRuntimeError
  | SerializedUnknownError;

export type IsolatedGameLaunchPlanningResponse =
  | { readonly ok: true; readonly plan: CanonicalGameLaunchPreparation }
  | { readonly ok: false; readonly error: SerializedPlanningError };

export type GameLaunchPlanningWorkerFactory = (
  url: URL,
  options: WorkerOptions,
) => Worker;

export function planningDeadlineError(): GameLaunchPlanError {
  return new GameLaunchPlanError(
    "PLANNING_TIMEOUT",
    "Game launch planning exceeded its absolute elapsed-time deadline.",
  );
}

function planningWorkerUrl(): { url: URL; typescript: boolean } {
  const typescript = extname(fileURLToPath(import.meta.url)).toLowerCase() === ".ts";
  return {
    url: new URL(`./game-launch-planning-worker.${typescript ? "ts" : "js"}`, import.meta.url),
    typescript,
  };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rehydratePlanningError(value: unknown): Error {
  if (!plainRecord(value) || typeof value.kind !== "string" ||
      typeof value.code !== "string" || typeof value.message !== "string") {
    return new Error("Game launch planning worker returned an invalid planning error");
  }
  if (value.kind === "gameLaunchPlan") {
    try {
      return new GameLaunchPlanError(value.code as GameLaunchPlanErrorCode, value.message, {
        ...(value.details === undefined ? {} : { details: value.details }),
        ...(Array.isArray(value.candidates)
          ? { candidates: value.candidates as GameWorldDiagnosticCandidate[] }
          : {}),
        ...(value.remedy === undefined ? {} : { remedy: value.remedy as GameLaunchPlanRemedy }),
      });
    } catch {
      return new Error("Game launch planning worker returned an invalid planning error");
    }
  }
  if (value.kind === "ownedRuntime") {
    return new OwnedRuntimeError(
      value.code,
      value.message,
      plainRecord(value.details) ? value.details : undefined,
      value.remedyReason as never,
    );
  }
  return new Error(value.message || "Game launch planning worker failed");
}

/** Run all blocking launch evidence discovery in a killable worker. */
function planCanonicalGameLaunchWithWorkerFactory(
  request: IsolatedGameLaunchPlanningRequest,
  signal: AbortSignal,
  workerFactory: GameLaunchPlanningWorkerFactory = (url, options) =>
    new Worker(url, options),
): Promise<CanonicalGameLaunchPreparation> {
  if (signal.aborted) {
    return Promise.reject(new OwnedRuntimeError("CANCELLED", "Game launch planning was cancelled"));
  }
  const remainingMs = request.deadlineAtMs - Date.now();
  if (!Number.isSafeInteger(request.deadlineAtMs) || remainingMs <= 0) {
    return Promise.reject(planningDeadlineError());
  }
  const entry = planningWorkerUrl();
  const worker = workerFactory(entry.url, {
    workerData: request,
    ...(entry.typescript ? { execArgv: ["--import", "tsx"] } : {}),
  });
  // Keep physical-exit proof separate from the outcome listener. This join is
  // installed before any termination request and survives listener cleanup.
  const workerExited = new Promise<void>((resolve) => {
    worker.once("exit", () => resolve());
  });
  // A retained request, not planning evidence, owns host liveness. Transport
  // shutdown may therefore exit without waiting for an uncooperative worker;
  // live requests still retain and terminate it through the promise below.
  worker.unref();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => {
      void finish({
        error: new OwnedRuntimeError("CANCELLED", "Game launch planning was cancelled"),
      });
    };
    const onMessage = (value: unknown): void => {
      if (!plainRecord(value) || typeof value.ok !== "boolean") {
        void finish({ error: new Error("Game launch planning worker returned an invalid response") });
        return;
      }
      const response = value as IsolatedGameLaunchPlanningResponse;
      void finish(response.ok && response.plan !== undefined
        ? { plan: response.plan }
        : !response.ok
          ? { error: rehydratePlanningError(response.error) }
          : { error: new Error("Game launch planning worker returned an invalid response") });
    };
    const onError = (): void => {
      void finish({ error: new Error("Game launch planning worker failed") });
    };
    const onExit = (): void => {
      if (!settled) void finish({ error: new Error("Game launch planning worker exited before completion") });
    };

    const finish = async (outcome: {
      readonly plan?: CanonicalGameLaunchPreparation;
      readonly error?: Error;
    }): Promise<void> => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      let terminationFailed = false;
      try {
        await worker.terminate();
      } catch {
        terminationFailed = true;
      }
      // terminate() rejection does not prove the thread stopped. Do not settle
      // the planning request while filesystem work may still be running.
      await workerExited;
      if (terminationFailed && outcome.error === undefined) {
        reject(new Error("Game launch planning worker could not be terminated cleanly"));
        return;
      }
      if (outcome.error !== undefined) reject(outcome.error);
      else if (outcome.plan !== undefined) resolve(outcome.plan);
      else reject(new Error("Game launch planning worker produced no result"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    // Close the cancellation race across synchronous Worker construction and
    // listener registration, then recompute the timer from the one absolute
    // deadline after workerData structured cloning has completed.
    if (signal.aborted) {
      onAbort();
      return;
    }
    const postConstructionRemainingMs = request.deadlineAtMs - Date.now();
    if (postConstructionRemainingMs <= 0) {
      void finish({ error: planningDeadlineError() });
      return;
    }
    timer = setTimeout(() => {
      void finish({ error: planningDeadlineError() });
    }, postConstructionRemainingMs);
    timer.unref?.();
  });
}

/** Build a planner around an explicit worker factory for lifecycle tests. */
export function createCanonicalGameLaunchIsolatedPlanner(
  workerFactory: GameLaunchPlanningWorkerFactory,
): (
  request: IsolatedGameLaunchPlanningRequest,
  signal: AbortSignal,
) => Promise<CanonicalGameLaunchPreparation> {
  return (request, signal) =>
    planCanonicalGameLaunchWithWorkerFactory(request, signal, workerFactory);
}

/** Run all blocking launch evidence discovery in a killable worker. */
export function planCanonicalGameLaunchIsolated(
  request: IsolatedGameLaunchPlanningRequest,
  signal: AbortSignal,
): Promise<CanonicalGameLaunchPreparation> {
  return planCanonicalGameLaunchWithWorkerFactory(request, signal);
}
