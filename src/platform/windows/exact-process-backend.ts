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
  helperTimeoutMs?: number;
  /**
   * Process-level fail-stop invoked if an acquired OS mutex disappears before
   * the protected action finishes. It must not return.
   */
  leaseLossFailStop?: (error: WindowsExactProcessFailure) => never;
  /** Compatibility hook for domain adapters that retain their public error type. */
  errorFactory?: (
    message: string,
    code: WindowsExactProcessBackendFailureCode
  ) => WindowsExactProcessFailure;
}

export interface WindowsHelperResponse {
  ok?: boolean;
  status?: string;
  reason?: string;
  message?: string;
  identity?: unknown;
  ownerArgumentMatched?: unknown;
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
  protected readonly helperTimeoutMs: number;
  private readonly leaseLossFailStop: (error: WindowsExactProcessFailure) => never;
  private readonly errorFactory: NonNullable<WindowsExactProcessBackendOptions["errorFactory"]>;

  constructor(
    private readonly helperPath: string,
    options: WindowsExactProcessBackendOptions = {}
  ) {
    this.helperTimeoutMs = options.helperTimeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
    this.errorFactory = options.errorFactory ??
      ((message, code) => new WindowsExactProcessBackendError(message, code));
    this.leaseLossFailStop = options.leaseLossFailStop ?? (() => process.abort());
    if (!Number.isInteger(this.helperTimeoutMs) || this.helperTimeoutMs <= 0) {
      throw this.failure("Windows lifecycle helper timeout must be positive.", "STATE_INVALID");
    }
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
    outcomeUncertain = false
  ): Promise<void> {
    if (killImmediately) child.kill();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      closePromise.then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(this.failure(
            `${context}; the mutex helper did not exit within ${this.helperTimeoutMs}ms. ` +
              "Durable lifecycle state was preserved for recovery.",
            outcomeUncertain ? "RECOVERY_REQUIRED" : "HELPER_FAILURE"
          ));
        }, this.helperTimeoutMs);
        timer.unref();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  protected async invoke(
    mode: string,
    request: unknown,
    timeoutMs = this.helperTimeoutMs,
    mutationOutcomeUncertainOnTimeout = false
  ): Promise<WindowsHelperResponse> {
    this.assertSupported();
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw this.failure("Windows lifecycle helper timeout must be positive.", "STATE_INVALID");
    }
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
    const acquisitionBudgetMs = args.timeoutMs + this.helperTimeoutMs;
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
          true
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
            true
          ).then(() => reject(invalidResponse), reject);
        }
      };
      child.once("error", onError);
      child.once("close", onClose);
      child.stdout.on("data", onData);
      child.stdin.write(`${JSON.stringify({ mutexName: args.name, timeoutMs: args.timeoutMs })}\n`);
    });
    if (acquired.ok !== true || acquired.status !== "acquired") {
      child.stdin.end();
      await this.waitForMutexHelperExit(
        child,
        closePromise,
        "Lifecycle mutex holder did not exit after refusing acquisition",
        false
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
            "the MCP must fail-stop before any unprotected lifecycle work can continue.",
          "RECOVERY_REQUIRED"
        );
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
      await this.waitForMutexHelperExit(
        child,
        closePromise,
        "Lifecycle mutex holder did not release",
        false,
        true
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
    const response = await this.invoke(
      "VerifyTerminate",
      { expected, timeoutMs },
      timeoutMs + this.helperTimeoutMs,
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
}

export function createWindowsExactProcessBackend(
  helperPath: string,
  options: WindowsExactProcessBackendOptions = {}
): WindowsExactProcessKernel {
  return new WindowsExactProcessBackend(helperPath, options);
}
