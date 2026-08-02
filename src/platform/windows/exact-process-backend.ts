import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";
import type {
  ExactOwnedProcessIdentity,
  ExactProcessBackend,
  ExactProcessInspection,
  ExactProcessTerminationResult,
} from "../../foundation/exact-process-backend.js";
import type { ExactProcessIdentity } from "../../foundation/identity.js";
import type {
  MachineMutex,
  MachineMutexRequest,
} from "../../foundation/machine-mutex.js";

const DEFAULT_HELPER_TIMEOUT_MS = 20_000;

export type WindowsExactProcessBackendFailureCode =
  | "UNSUPPORTED_PLATFORM"
  | "IDENTITY_UNVERIFIABLE"
  | "STATE_INVALID"
  | "LIFECYCLE_BUSY"
  | "HELPER_FAILURE"
  | "RECOVERY_REQUIRED";

export class WindowsExactProcessBackendError extends Error {
  constructor(
    message: string,
    public readonly code: WindowsExactProcessBackendFailureCode
  ) {
    super(message);
    this.name = "WindowsExactProcessBackendError";
  }
}

type WindowsExactProcessFailure = Error & {
  readonly code: WindowsExactProcessBackendFailureCode;
};

export interface WindowsExactProcessBackendOptions {
  /** A callback is evaluated immediately before each helper invocation. */
  helperTimeoutMs?: number | (() => number);
  /** Optional absolute deadline shared by every nested helper phase. */
  operationDeadlineAtMs?: () => number | undefined;
  /**
   * Process-level fallback invoked if an acquired OS mutex disappears before
   * an unfenced action finishes, or if the supplied lease-loss fence throws.
   * It must not return.
   */
  leaseLossFailStop?: (error: WindowsExactProcessFailure) => never;
  /** Compatibility hook for domain adapters that retain their public error type. */
  errorFactory?: (
    message: string,
    code: WindowsExactProcessBackendFailureCode
  ) => WindowsExactProcessFailure;
}

export interface WindowsMutexDeadlineBudget {
  /** Maximum time passed to the OS mutex wait itself. */
  readonly mutexWaitTimeoutMs: number;
  /** Maximum time allowed for one helper response/exit phase. */
  readonly helperTimeoutMs: number;
  /** Parent-side bound for wait plus acquisition acknowledgement. */
  readonly acquisitionTimeoutMs: number;
}

/**
 * Divide one remaining absolute operation budget between mutex acquisition,
 * its helper acknowledgement, and a final helper release/kill allowance.
 */
export function allocateWindowsMutexDeadlineBudget(input: {
  readonly remainingMs: number;
  readonly requestedMutexWaitMs: number;
  readonly configuredHelperTimeoutMs: number;
}): WindowsMutexDeadlineBudget {
  const { remainingMs, requestedMutexWaitMs, configuredHelperTimeoutMs } = input;
  if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0 ||
      !Number.isSafeInteger(requestedMutexWaitMs) || requestedMutexWaitMs <= 0 ||
      !Number.isSafeInteger(configuredHelperTimeoutMs) || configuredHelperTimeoutMs <= 0) {
    throw new TypeError("Windows mutex deadline budget inputs must be positive integers.");
  }

  // At most one third is assigned to either helper boundary. The middle share
  // remains available to the OS wait, while a smaller configured helper bound
  // naturally gives the mutex wait more of the common deadline.
  const helperTimeoutMs = Math.min(
    configuredHelperTimeoutMs,
    Math.max(1, Math.floor(remainingMs / 3))
  );
  const mutexWaitTimeoutMs = Math.min(
    requestedMutexWaitMs,
    Math.max(1, remainingMs - (2 * helperTimeoutMs))
  );
  return Object.freeze({
    mutexWaitTimeoutMs,
    helperTimeoutMs,
    acquisitionTimeoutMs: Math.min(remainingMs, mutexWaitTimeoutMs + helperTimeoutMs),
  });
}

export interface WindowsTerminationDeadlineBudget {
  /** Timeout sent to the exact-process termination helper. */
  readonly terminationTimeoutMs: number;
  /** Parent-side allowance reserved for receiving the helper response. */
  readonly responseAllowanceMs: number;
}

/** Reserve a response allowance inside the already-clamped termination budget. */
export function allocateWindowsTerminationDeadlineBudget(input: {
  readonly operationBudgetMs: number;
  readonly requestedTerminationTimeoutMs: number;
  readonly configuredHelperTimeoutMs: number;
}): WindowsTerminationDeadlineBudget {
  const { operationBudgetMs, requestedTerminationTimeoutMs, configuredHelperTimeoutMs } = input;
  if (!Number.isSafeInteger(operationBudgetMs) || operationBudgetMs <= 0 ||
      !Number.isSafeInteger(requestedTerminationTimeoutMs) || requestedTerminationTimeoutMs <= 0 ||
      !Number.isSafeInteger(configuredHelperTimeoutMs) || configuredHelperTimeoutMs <= 0) {
    throw new TypeError("Windows termination deadline budget inputs must be positive integers.");
  }
  const responseAllowanceMs = Math.min(
    configuredHelperTimeoutMs,
    Math.max(1, Math.floor(operationBudgetMs / 2))
  );
  return Object.freeze({
    terminationTimeoutMs: Math.min(
      requestedTerminationTimeoutMs,
      Math.max(1, operationBudgetMs - responseAllowanceMs)
    ),
    responseAllowanceMs,
  });
}

export interface WindowsHelperResponse {
  ok?: boolean;
  status?: string;
  reason?: string;
  message?: string;
  identity?: unknown;
  ownerArgumentMatched?: unknown;
  expectedArgumentsMatched?: unknown;
  windows?: unknown;
  processes?: unknown;
  unverifiable?: unknown;
  listenerPid?: unknown;
}

export type WindowsExactProcessKernel = ExactProcessBackend & MachineMutex;

function isPositiveFileTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return false;
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}

export function parseWindowsExactProcessIdentity(value: unknown): ExactProcessIdentity | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const pid = Number(record.pid);
  if (!Number.isInteger(pid) || pid <= 0 ||
      typeof record.executablePath !== "string" || record.executablePath.trim().length === 0 ||
      !isPositiveFileTime(record.creationTime)) return null;
  return {
    pid,
    executablePath: resolve(record.executablePath),
    creationTime: record.creationTime,
  };
}

function parseJsonText(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Concrete Windows implementation of the shared exact-process and
 * machine-mutex capabilities. Workbench-specific endpoint and state commands
 * live in its compatibility adapter, not in this platform kernel.
 */
export class WindowsExactProcessBackend implements ExactProcessBackend, MachineMutex {
  readonly platform = "win32" as const;
  private readonly helperTimeoutMs: () => number;
  private readonly operationDeadlineAtMs: (() => number | undefined) | undefined;
  private readonly leaseLossFailStop: (error: WindowsExactProcessFailure) => never;
  private readonly errorFactory: NonNullable<WindowsExactProcessBackendOptions["errorFactory"]>;

  constructor(
    private readonly helperPath: string,
    options: WindowsExactProcessBackendOptions = {}
  ) {
    const helperTimeout = options.helperTimeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
    this.helperTimeoutMs = typeof helperTimeout === "function"
      ? helperTimeout
      : () => helperTimeout;
    this.operationDeadlineAtMs = options.operationDeadlineAtMs;
    this.errorFactory = options.errorFactory ??
      ((message, code) => new WindowsExactProcessBackendError(message, code));
    this.leaseLossFailStop = options.leaseLossFailStop ?? (() => process.abort());
    this.currentHelperTimeoutMs();
  }

  protected failure(
    message: string,
    code: WindowsExactProcessBackendFailureCode
  ): WindowsExactProcessFailure {
    return this.errorFactory(message, code);
  }

  private assertSupported(): void {
    if (platform() !== "win32") {
      throw this.failure(
        "Automated Workbench lifecycle control is supported only on Windows.",
        "UNSUPPORTED_PLATFORM"
      );
    }
    if (!existsSync(this.helperPath)) {
      throw this.failure(
        `Bundled Windows lifecycle helper is missing: ${this.helperPath}`,
        "HELPER_FAILURE"
      );
    }
  }

  private powershellArgs(mode: string, deadlineUnixMs: number): string[] {
    return [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.helperPath,
      "-Mode",
      mode,
      "-DeadlineUnixMs",
      String(deadlineUnixMs),
    ];
  }

  private async waitForMutexHelperExit(
    child: ChildProcessWithoutNullStreams,
    closePromise: Promise<number | null>,
    context: string,
    killImmediately: boolean,
    outcomeUncertain = false,
    timeoutMs?: number
  ): Promise<void> {
    if (killImmediately) child.kill();
    const helperTimeoutMs = timeoutMs ?? this.currentHelperTimeoutMs();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      closePromise.then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(this.failure(
            `${context}; the mutex helper did not exit within ${helperTimeoutMs}ms. ` +
              "Durable lifecycle state was preserved for recovery.",
            outcomeUncertain ? "RECOVERY_REQUIRED" : "HELPER_FAILURE"
          ));
        }, helperTimeoutMs);
        timer.unref();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  protected async invoke(
    mode: string,
    request: unknown,
    timeoutMs?: number,
    mutationOutcomeUncertainOnTimeout = false
  ): Promise<WindowsHelperResponse> {
    this.assertSupported();
    timeoutMs ??= this.currentHelperTimeoutMs();
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw this.failure("Windows lifecycle helper timeout must be positive.", "STATE_INVALID");
    }
    timeoutMs = this.clampToOperationDeadline(timeoutMs, `Windows lifecycle helper mode ${mode}`);
    const deadlineUnixMs = Date.now() + timeoutMs;
    return new Promise<WindowsHelperResponse>((resolvePromise, reject) => {
      const child = spawn("powershell.exe", this.powershellArgs(mode, deadlineUnixMs), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        const message = `Windows lifecycle helper mode ${mode} exceeded its ${timeoutMs}ms deadline.`;
        reject(this.failure(
          mutationOutcomeUncertainOnTimeout
            ? `${message} The mutation outcome is uncertain; durable lifecycle state was preserved for recovery.`
            : message,
          mutationOutcomeUncertainOnTimeout ? "RECOVERY_REQUIRED" : "HELPER_FAILURE"
        ));
      }, timeoutMs);
      timer.unref();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdin.on("error", () => undefined);
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(this.failure(
          `Could not start Windows lifecycle helper: ${error.message}`,
          "HELPER_FAILURE"
        ));
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (lines.length === 0) {
          reject(this.failure(
            `Windows lifecycle helper mode ${mode} returned no private JSON response` +
              `${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
            "HELPER_FAILURE"
          ));
          return;
        }
        try {
          const response = parseJsonText(lines[lines.length - 1]) as WindowsHelperResponse;
          if (code !== 0 && response.ok !== false) {
            reject(this.failure(
              `Windows lifecycle helper mode ${mode} exited with code ${code}.`,
              "HELPER_FAILURE"
            ));
            return;
          }
          resolvePromise(response);
        } catch (error) {
          reject(this.failure(
            `Windows lifecycle helper mode ${mode} returned invalid JSON: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            "HELPER_FAILURE"
          ));
        }
      });
      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
  }

  async withMachineMutex<T>(args: MachineMutexRequest<T>): Promise<T> {
    this.assertSupported();
    const configuredHelperTimeoutMs = this.currentHelperTimeoutMs();
    const operationDeadlineAtMs = this.currentOperationDeadlineAtMs();
    let mutexWaitTimeoutMs = args.timeoutMs;
    let helperTimeoutMs = configuredHelperTimeoutMs;
    let acquisitionBudgetMs = mutexWaitTimeoutMs + helperTimeoutMs;
    if (operationDeadlineAtMs !== undefined) {
      const remainingMs = this.remainingOperationMs(
        operationDeadlineAtMs,
        "Lifecycle mutex acquisition"
      );
      const budget = allocateWindowsMutexDeadlineBudget({
        remainingMs,
        requestedMutexWaitMs: args.timeoutMs,
        configuredHelperTimeoutMs,
      });
      helperTimeoutMs = budget.helperTimeoutMs;
      mutexWaitTimeoutMs = budget.mutexWaitTimeoutMs;
      acquisitionBudgetMs = budget.acquisitionTimeoutMs;
    }
    const child = spawn(
      "powershell.exe",
      this.powershellArgs("HoldMutex", Date.now() + acquisitionBudgetMs),
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }
    ) as ChildProcessWithoutNullStreams;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", () => undefined);
    let stderr = "";
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const closePromise = new Promise<number | null>((resolveClose) =>
      child.once("close", (code) => resolveClose(code))
    );
    const acquired = await new Promise<WindowsHelperResponse>((resolveAcquired, reject) => {
      let buffer = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const error = this.failure(
          `Lifecycle mutex holder produced no acquisition response within ${acquisitionBudgetMs}ms.`,
          "HELPER_FAILURE"
        );
        void this.waitForMutexHelperExit(
          child,
          closePromise,
          "Lifecycle mutex acquisition timed out",
          true,
          false,
          helperTimeoutMs
        ).then(() => reject(error), reject);
      }, acquisitionBudgetMs);
      timer.unref();
      const cleanup = (): void => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("error", onError);
        child.off("close", onClose);
      };
      const onError = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(this.failure(
          `Could not start the lifecycle mutex holder: ${error.message}`,
          "HELPER_FAILURE"
        ));
      };
      const onClose = (code: number | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(this.failure(
          `Lifecycle mutex holder exited before its acquisition response (code ${code})` +
            `${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
          "HELPER_FAILURE"
        ));
      };
      const onData = (chunk: string): void => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        settled = true;
        cleanup();
        try {
          resolveAcquired(parseJsonText(buffer.slice(0, newline).trim()) as WindowsHelperResponse);
        } catch (error) {
          const invalidResponse = this.failure(
            `Lifecycle mutex holder returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
            "HELPER_FAILURE"
          );
          void this.waitForMutexHelperExit(
            child,
            closePromise,
            "Lifecycle mutex holder returned invalid JSON",
            true,
            false,
            helperTimeoutMs
          ).then(() => reject(invalidResponse), reject);
        }
      };
      child.once("error", onError);
      child.once("close", onClose);
      child.stdout.on("data", onData);
      child.stdin.write(`${JSON.stringify({ mutexName: args.name, timeoutMs: mutexWaitTimeoutMs })}\n`);
    });
    if (acquired.ok !== true || acquired.status !== "acquired") {
      child.stdin.end();
      await this.waitForMutexHelperExit(
        child,
        closePromise,
        "Lifecycle mutex holder did not exit after refusing acquisition",
        false,
        false,
        helperTimeoutMs
      );
      throw this.failure(
        acquired.status === "timeout"
          ? `Timed out waiting for the machine-wide Workbench lifecycle mutex ${args.name}.`
          : `Lifecycle mutex acquisition failed: ${acquired.message ?? acquired.reason ?? stderr.trim()}`,
        acquired.status === "timeout" ? "LIFECYCLE_BUSY" : "HELPER_FAILURE"
      );
    }

    let released = false;
    const holderFailure = closePromise.then((code) => {
      if (!released) {
        const error = this.failure(
          `Lifecycle mutex holder exited unexpectedly with code ${code}; ` +
            "the protected action lost its machine-wide lifecycle lease.",
          "RECOVERY_REQUIRED"
        );
        if (args.onLeaseLost) {
          // A fenced caller revokes its session/transaction authority before
          // this rejection can leave the mutex boundary. The action may still
          // have asynchronous work settling in the background, but every
          // subsequent mutation is required to re-check that synchronous
          // fence. Preserve the stdio host so the tool can report and diagnose
          // the durable RECOVERY_REQUIRED state.
          try {
            args.onLeaseLost(error);
          } catch {
            // A broken fence cannot prove that late mutation was disabled.
            try {
              this.leaseLossFailStop(error);
            } finally {
              process.abort();
            }
          }
          throw error;
        }
        // Generic/unfenced actions retain the process-level safety boundary:
        // without a synchronous revocation hook they could mutate after the
        // OS released the mutex.
        try {
          this.leaseLossFailStop(error);
        } finally {
          process.abort();
        }
      }
      return new Promise<never>(() => undefined);
    });
    try {
      return await Promise.race([args.action(), holderFailure]);
    } finally {
      released = true;
      child.stdin.end("release\n");
      const releaseRemainingMs = operationDeadlineAtMs === undefined
        ? helperTimeoutMs
        : Math.floor(operationDeadlineAtMs - Date.now());
      // If the protected action consumed the final millisecond, terminate the
      // holder immediately so the OS releases the mutex; do not grant a fresh
      // helper window after the shared deadline.
      const releaseExpired = releaseRemainingMs <= 0;
      const releaseTimeoutMs = releaseExpired
        ? 1
        : Math.min(helperTimeoutMs, releaseRemainingMs);
      await this.waitForMutexHelperExit(
        child,
        closePromise,
        "Lifecycle mutex holder did not release",
        releaseExpired,
        true,
        releaseTimeoutMs
      );
    }
  }

  async inspectCurrentProcess(pid: number): Promise<ExactProcessIdentity & { userSid: string }> {
    const response = await this.invoke("InspectCurrent", { pid });
    const identity = parseWindowsExactProcessIdentity(response.identity);
    const userSid = response.identity && typeof response.identity === "object"
      ? (response.identity as Record<string, unknown>).userSid
      : null;
    if (response.ok !== true || response.status !== "found" || !identity || !isString(userSid)) {
      throw this.failure(
        `Current MCP process identity is unverifiable: ${response.message ?? response.reason ?? "invalid helper response"}`,
        "IDENTITY_UNVERIFIABLE"
      );
    }
    return { ...identity, userSid };
  }

  async inspectProcess(
    pid: number,
    expectedOwnerTokenArgument?: string
  ): Promise<ExactProcessInspection | null> {
    const response = await this.invoke("InspectProcess", {
      pid,
      expectedOwnerTokenArgument: expectedOwnerTokenArgument ?? "",
    });
    if (response.ok === true && response.status === "absent") return null;
    const identity = parseWindowsExactProcessIdentity(response.identity);
    if (response.ok !== true || response.status !== "found" || !identity) {
      throw this.failure(
        `Process ${pid} is unverifiable: ${response.message ?? response.reason ?? "invalid helper response"}`,
        "IDENTITY_UNVERIFIABLE"
      );
    }
    return {
      identity,
      ownerArgumentMatched: typeof response.ownerArgumentMatched === "boolean"
        ? response.ownerArgumentMatched
        : null,
    };
  }

  async verifyAndTerminate(
    expected: ExactOwnedProcessIdentity,
    timeoutMs: number
  ): Promise<ExactProcessTerminationResult> {
    const helperTimeoutMs = this.currentHelperTimeoutMs();
    const outerTimeoutMs = this.clampToOperationDeadline(
      timeoutMs + helperTimeoutMs,
      "Exact process termination"
    );
    const { terminationTimeoutMs } = allocateWindowsTerminationDeadlineBudget({
      operationBudgetMs: outerTimeoutMs,
      requestedTerminationTimeoutMs: timeoutMs,
      configuredHelperTimeoutMs: helperTimeoutMs,
    });
    const response = await this.invoke(
      "VerifyTerminate",
      { expected, timeoutMs: terminationTimeoutMs },
      outerTimeoutMs,
      true
    );
    if (response.ok === true &&
        (response.status === "terminated" || response.status === "already_exited")) {
      return { kind: response.status };
    }
    const allowedReasons = new Set<
      Extract<ExactProcessTerminationResult, { kind: "refused" }>["reason"]
    >([
      "access_denied",
      "pid_reused",
      "executable_mismatch",
      "creation_time_mismatch",
      "command_line_unverifiable",
      "token_mismatch",
      "timeout",
      "helper_failure",
    ]);
    const reason = allowedReasons.has(
      response.reason as Extract<ExactProcessTerminationResult, { kind: "refused" }>["reason"]
    )
      ? response.reason as Extract<ExactProcessTerminationResult, { kind: "refused" }>["reason"]
      : "helper_failure";
    return {
      kind: "refused",
      reason,
      message: response.message ?? "The exact process helper refused termination.",
    };
  }

  private currentHelperTimeoutMs(): number {
    const timeoutMs = this.helperTimeoutMs();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw this.failure("Windows lifecycle helper timeout must be positive.", "STATE_INVALID");
    }
    return timeoutMs;
  }

  private currentOperationDeadlineAtMs(): number | undefined {
    const deadlineAtMs = this.operationDeadlineAtMs?.();
    if (deadlineAtMs === undefined) return undefined;
    if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= 0) {
      throw this.failure("Windows lifecycle absolute deadline is invalid.", "STATE_INVALID");
    }
    return deadlineAtMs;
  }

  private remainingOperationMs(deadlineAtMs: number, context: string): number {
    const remainingMs = Math.floor(deadlineAtMs - Date.now());
    if (remainingMs <= 0) {
      throw this.failure(`${context} exceeded its absolute deadline.`, "HELPER_FAILURE");
    }
    return remainingMs;
  }

  private clampToOperationDeadline(
    requestedMs: number,
    context: string,
    deadlineAtMs = this.currentOperationDeadlineAtMs()
  ): number {
    if (deadlineAtMs === undefined) return requestedMs;
    return Math.min(requestedMs, this.remainingOperationMs(deadlineAtMs, context));
  }
}

export function createWindowsExactProcessBackend(
  helperPath: string,
  options: WindowsExactProcessBackendOptions = {}
): WindowsExactProcessKernel {
  return new WindowsExactProcessBackend(helperPath, options);
}
