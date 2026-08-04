import { redactText } from "./foundation/redact.js";

export const MCP_SHUTDOWN_DEADLINE_MS = 30_000;
const MAX_BUSY_RUNTIMES = 16;
const MAX_ERROR_RUNTIMES = 8;
const MAX_IDENTIFIER_LENGTH = 96;
const MAX_REASON_LENGTH = 240;
const MAX_DIAGNOSTIC_LENGTH = 4_096;

export interface LifecycleRuntimeErrorSummary {
  runtimeId: string;
  reason: string;
}

export interface LifecycleDiagnostic {
  code: string;
  applicationCloseSafe?: boolean;
  busyRuntimeIds: string[];
  errorRuntimes: LifecycleRuntimeErrorSummary[];
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface CliShutdownOptions {
  closeProtocol(): Promise<void>;
  disposeTools(deadlineAtMs: number): Promise<Record<string, unknown>>;
  emergencyTerminate(): void;
  emergencyCleanup?(): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  reason: string;
  deadlineMs?: number;
  retryDelayMs?: number;
  clock?: () => number;
  setTimer?: (callback: () => void, milliseconds: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  exit(code: number): void;
}

function dataProperty(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeText(value: unknown, maximumLength: number, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return redactText(value, { profile: "diagnostic", maxLength: maximumLength });
}

function arrayData(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  try {
    return value.slice();
  } catch {
    return [];
  }
}

/**
 * Extract only the stable owned-runtime shutdown fields. In particular, this
 * never spreads or serializes an arbitrary Error/details object.
 */
export function normalizeLifecycleDiagnostic(value: unknown): LifecycleDiagnostic {
  const outerCode = dataProperty(value, "code");
  const details = dataProperty(value, "details");
  const source = details && typeof details === "object" && !Array.isArray(details)
    ? details
    : value;
  const applicationCloseSafe = dataProperty(source, "applicationCloseSafe");
  const busyRuntimeIds = arrayData(dataProperty(source, "busyRuntimeIds"))
    .slice(0, MAX_BUSY_RUNTIMES)
    .map((entry) => safeText(entry, MAX_IDENTIFIER_LENGTH, "unknown"));
  const errorRuntimes = arrayData(dataProperty(source, "errorRuntimes"))
    .slice(0, MAX_ERROR_RUNTIMES)
    .map((entry): LifecycleRuntimeErrorSummary => ({
      runtimeId: safeText(dataProperty(entry, "runtimeId"), MAX_IDENTIFIER_LENGTH, "unknown"),
      reason: safeText(dataProperty(entry, "reason"), MAX_REASON_LENGTH, "Runtime lifecycle could not be verified"),
    }));
  const inferredUnsafe = applicationCloseSafe === false || busyRuntimeIds.length > 0 || errorRuntimes.length > 0;
  const code = safeText(
    outerCode,
    64,
    inferredUnsafe ? "SHUTDOWN_SEAL_FAILED" : "SHUTDOWN_FAILED",
  );
  return {
    code,
    ...(typeof applicationCloseSafe === "boolean" ? { applicationCloseSafe } : {}),
    busyRuntimeIds,
    errorRuntimes,
  };
}

export function formatLifecycleDiagnostic(value: unknown): string {
  const diagnostic = normalizeLifecycleDiagnostic(value);
  let rendered = `MCP lifecycle shutdown: ${JSON.stringify(diagnostic)}`;
  if (rendered.length <= MAX_DIAGNOSTIC_LENGTH) return rendered;
  // The field bounds above normally fit. Keep the fallback valid JSON if a
  // future field expansion exceeds the final transport-safe message ceiling.
  while (diagnostic.errorRuntimes.length > 0 && rendered.length > MAX_DIAGNOSTIC_LENGTH) {
    diagnostic.errorRuntimes.pop();
    rendered = `MCP lifecycle shutdown: ${JSON.stringify(diagnostic)}`;
  }
  while (diagnostic.busyRuntimeIds.length > 0 && rendered.length > MAX_DIAGNOSTIC_LENGTH) {
    diagnostic.busyRuntimeIds.pop();
    rendered = `MCP lifecycle shutdown: ${JSON.stringify(diagnostic)}`;
  }
  return rendered.slice(0, MAX_DIAGNOSTIC_LENGTH);
}

export function lifecycleCloseSafe(value: unknown): boolean {
  return dataProperty(value, "applicationCloseSafe") === true;
}

export function retryableLifecycleFailure(value: unknown): boolean {
  const diagnostic = normalizeLifecycleDiagnostic(value);
  return diagnostic.code === "SHUTDOWN_SEAL_FAILED" ||
    diagnostic.applicationCloseSafe === false ||
    diagnostic.busyRuntimeIds.length > 0 ||
    diagnostic.errorRuntimes.length > 0;
}

/** CLI-only shutdown policy. Embedded disposal never reaches process.exit(). */
export async function runCliShutdown(options: CliShutdownOptions): Promise<"closed" | "emergency"> {
  const now = options.clock ?? Date.now;
  const armTimer = options.setTimer ?? setTimeout;
  const disarmTimer = options.clearTimer ?? clearTimeout;
  const deadlineMs = options.deadlineMs ?? MCP_SHUTDOWN_DEADLINE_MS;
  const retryDelayMs = options.retryDelayMs ?? 100;
  const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => {
    const handle = armTimer(resolve, milliseconds);
    (handle as unknown as { unref?: () => void }).unref?.();
  });
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new TypeError("MCP shutdown deadline is invalid");
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1 || retryDelayMs > deadlineMs) {
    throw new TypeError("MCP shutdown retry delay is invalid");
  }
  const deadlineAtMs = now() + deadlineMs;
  let lastFailure: unknown;
  let emergencyStarted = false;
  let resolveEmergency!: (value: "emergency") => void;
  const emergency = new Promise<"emergency">((resolve) => { resolveEmergency = resolve; });

  const triggerEmergency = (failure: unknown): void => {
    if (emergencyStarted) return;
    emergencyStarted = true;
    const diagnostic = failure ?? lastFailure ?? {
      code: "SHUTDOWN_DEADLINE_EXPIRED",
      applicationCloseSafe: false,
      busyRuntimeIds: [],
      errorRuntimes: [],
    };
    options.error(`${formatLifecycleDiagnostic(diagnostic)}; emergency=true`);
    try { options.emergencyTerminate(); }
    catch (error) { options.error(`MCP emergency private-child termination failed: ${safeText(error instanceof Error ? error.message : error, 512, "unknown failure")}`); }
    try { options.emergencyCleanup?.(); }
    catch (error) { options.error(`MCP emergency lifecycle cleanup failed: ${safeText(error instanceof Error ? error.message : error, 512, "unknown failure")}`); }
    options.exit(1);
    resolveEmergency("emergency");
  };

  // Intentionally referenced: it is the handle that keeps the CLI alive while
  // an otherwise handle-free cleanup promise is still settling.
  const watchdog = armTimer(() => triggerEmergency(lastFailure), deadlineMs);
  const orderly = (async (): Promise<"closed" | "emergency"> => {
    try {
      await options.closeProtocol();
    } catch (error) {
      lastFailure = error;
      triggerEmergency(error);
      return emergency;
    }
    if (emergencyStarted) return "emergency";
    for (;;) {
      if (now() >= deadlineAtMs) {
        triggerEmergency(lastFailure);
        return emergency;
      }
      try {
        const result = await options.disposeTools(deadlineAtMs);
        if (emergencyStarted) return "emergency";
        if (lifecycleCloseSafe(result)) {
          disarmTimer(watchdog);
          options.info(`ReforgerForge MCP server stopped (${options.reason})`);
          return "closed";
        }
        lastFailure = result;
        options.warn(formatLifecycleDiagnostic(result));
      } catch (error) {
        if (emergencyStarted) return "emergency";
        lastFailure = error;
        options.warn(formatLifecycleDiagnostic(error));
        if (!retryableLifecycleFailure(error)) {
          triggerEmergency(error);
          return emergency;
        }
      }
      const remaining = deadlineAtMs - now();
      if (remaining <= 0) continue;
      await Promise.race([
        delay(Math.min(retryDelayMs, remaining)),
        emergency,
      ]);
      if (emergencyStarted) return "emergency";
    }
  })().catch((error) => {
    triggerEmergency(error);
    return emergency;
  });
  return Promise.race([orderly, emergency]);
}
