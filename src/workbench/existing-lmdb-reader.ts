import { spawn, type ChildProcess } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKBENCH_EXISTING_READER_CLEANUP_TIMEOUT_MS,
  WORKBENCH_EXISTING_READER_MAX_ERROR_BYTES,
  WORKBENCH_EXISTING_READER_MAX_OUTPUT_BYTES,
  WORKBENCH_EXISTING_READER_TIMEOUT_MS,
  type ExistingLifecycleWireRead,
  type ExistingSpawnJournalWireRead,
  type WorkbenchExistingLmdbWireSnapshot,
} from "./existing-lmdb-reader-protocol.js";

export type WorkbenchExistingLmdbIsolationErrorCode =
  | "CANCELLED"
  | "CLEANUP_FAILED"
  | "OUTPUT_LIMIT"
  | "SPAWN_FAILED"
  | "TIMEOUT"
  | "WORKER_FAILED"
  | "WORKER_PROTOCOL_INVALID";

export class WorkbenchExistingLmdbIsolationError extends Error {
  constructor(
    public readonly code: WorkbenchExistingLmdbIsolationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkbenchExistingLmdbIsolationError";
  }
}

export interface WorkbenchExistingLmdbIsolationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Never settle cancellation/deadline until the exact reader emits close. */
  readonly requireCloseBeforeSettlement?: boolean;
  /** Test-only worker override used to characterize abnormal exit and timeout containment. */
  readonly workerUrl?: URL;
  /** Test-only process observation used to prove cleanup before promise settlement. */
  readonly observeSpawnedPid?: (pid: number | undefined) => void;
  /** Test-only process constructor used to inject termination refusal. */
  readonly spawnProcess?: typeof spawn;
}

function readerWorkerUrl(): URL {
  const typescript = extname(fileURLToPath(import.meta.url)).toLowerCase() === ".ts";
  return new URL(`./existing-lmdb-reader-worker.${typescript ? "ts" : "js"}`, import.meta.url);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function parseLifecycle(value: unknown): ExistingLifecycleWireRead | null {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "missing") return { kind: "missing" };
  if (value.kind === "valid" && "state" in value) return { kind: "valid", state: value.state };
  if (value.kind === "malformed" &&
      isBoundedText(value.path, 32_768) &&
      isBoundedText(value.rawSha256, 128) &&
      isBoundedText(value.message, 4_096)) {
    return {
      kind: "malformed",
      path: value.path,
      rawSha256: value.rawSha256,
      message: value.message,
    };
  }
  return null;
}

function parseJournal(value: unknown): ExistingSpawnJournalWireRead | null {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "missing") return { kind: "missing" };
  if (value.kind === "valid" && isBoundedText(value.generation, 4_096) && "record" in value) {
    return { kind: "valid", generation: value.generation, record: value.record };
  }
  if (value.kind === "malformed" &&
      isBoundedText(value.path, 32_768) &&
      isBoundedText(value.rawSha256, 128) &&
      isBoundedText(value.message, 4_096)) {
    return {
      kind: "malformed",
      path: value.path,
      rawSha256: value.rawSha256,
      message: value.message,
    };
  }
  return null;
}

function parseWorkerOutput(output: string): WorkbenchExistingLmdbWireSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new WorkbenchExistingLmdbIsolationError(
      "WORKER_PROTOCOL_INVALID",
      "Existing-only Workbench LMDB reader returned invalid JSON.",
      { cause: error },
    );
  }
  if (!isPlainRecord(value) || typeof value.ok !== "boolean") {
    throw new WorkbenchExistingLmdbIsolationError(
      "WORKER_PROTOCOL_INVALID",
      "Existing-only Workbench LMDB reader returned an invalid response envelope.",
    );
  }
  if (value.ok === false) {
    const error = isBoundedText(value.error, 4_096)
      ? value.error
      : "Existing-only Workbench LMDB reader failed without a valid diagnostic.";
    throw new WorkbenchExistingLmdbIsolationError("WORKER_FAILED", error);
  }
  if (!isPlainRecord(value.snapshot)) {
    throw new WorkbenchExistingLmdbIsolationError(
      "WORKER_PROTOCOL_INVALID",
      "Existing-only Workbench LMDB reader omitted its snapshot.",
    );
  }
  const lifecycle = parseLifecycle(value.snapshot.lifecycle);
  const journal = parseJournal(value.snapshot.journal);
  if (!lifecycle || !journal) {
    throw new WorkbenchExistingLmdbIsolationError(
      "WORKER_PROTOCOL_INVALID",
      "Existing-only Workbench LMDB reader returned malformed record projections.",
    );
  }
  return { lifecycle, journal };
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? WORKBENCH_EXISTING_READER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > WORKBENCH_EXISTING_READER_TIMEOUT_MS) {
    throw new WorkbenchExistingLmdbIsolationError(
      "TIMEOUT",
      `Existing-only Workbench LMDB inspection timeout must be between 1 and ${WORKBENCH_EXISTING_READER_TIMEOUT_MS} ms.`,
    );
  }
  return timeout;
}

function isolatedReaderEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/**
 * Inspect the Workbench LMDB in a killable process boundary. Native LMDB
 * faults cannot be caught by JavaScript, so the owning MCP process must never
 * map a fresh live environment merely to answer an idle-readiness probe.
 */
export function inspectWorkbenchLmdbExistingIsolated(
  stateDir: string,
  options: WorkbenchExistingLmdbIsolationOptions = {},
): Promise<WorkbenchExistingLmdbWireSnapshot> {
  if (options.signal?.aborted) {
    return Promise.reject(new WorkbenchExistingLmdbIsolationError(
      "CANCELLED",
      "Existing-only Workbench LMDB inspection was cancelled.",
    ));
  }
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const workerUrl = options.workerUrl ?? readerWorkerUrl();
  const typescript = extname(fileURLToPath(workerUrl)).toLowerCase() === ".ts";
  let child: ChildProcess;
  try {
    child = (options.spawnProcess ?? spawn)(process.execPath, [
      ...(typescript ? ["--import", "tsx"] : []),
      fileURLToPath(workerUrl),
      stateDir,
    ], {
      cwd: process.cwd(),
      env: isolatedReaderEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    try {
      options.observeSpawnedPid?.(child.pid);
    } catch {
      // Test-only observation must never influence the production child.
    }
  } catch (error) {
    return Promise.reject(new WorkbenchExistingLmdbIsolationError(
      "SPAWN_FAILED",
      "Existing-only Workbench LMDB reader could not be spawned.",
      { cause: error },
    ));
  }

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let outputExceeded = false;
    let terminationError: WorkbenchExistingLmdbIsolationError | null = null;
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      clearTimeout(operationTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const settle = (
      error: WorkbenchExistingLmdbIsolationError | null,
      snapshot?: WorkbenchExistingLmdbWireSnapshot,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      if (error) reject(error);
      else if (snapshot) resolvePromise(snapshot);
      else reject(new WorkbenchExistingLmdbIsolationError(
        "WORKER_PROTOCOL_INVALID",
        "Existing-only Workbench LMDB reader completed without a snapshot.",
      ));
    };
    const terminateAndAwaitClose = (error: WorkbenchExistingLmdbIsolationError): void => {
      if (settled || terminationError) return;
      terminationError = error;
      clearTimeout(operationTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill();
        } catch {
          // The cleanup deadline below converts missing close evidence into a
          // distinct fail-closed result. Never claim termination from kill().
        }
      }
      cleanupTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill();
          } catch {
            // A second best-effort termination attempt cannot substitute for
            // the missing transport-close evidence reported below.
          }
        }
        if (options.requireCloseBeforeSettlement) {
          // A failed kill is not physical-stop evidence. Keep the close
          // listener, streams, and caller promise alive until the exact child
          // actually closes; request-owned launch admission remains retained.
          cleanupTimer = null;
          return;
        }
        settle(new WorkbenchExistingLmdbIsolationError(
          "CLEANUP_FAILED",
          `Existing-only Workbench LMDB reader did not close within ${WORKBENCH_EXISTING_READER_CLEANUP_TIMEOUT_MS} ms after termination was requested.`,
          { cause: error },
        ));
      }, WORKBENCH_EXISTING_READER_CLEANUP_TIMEOUT_MS);
      cleanupTimer.unref?.();
    };
    const onAbort = (): void => {
      terminateAndAwaitClose(new WorkbenchExistingLmdbIsolationError(
        "CANCELLED",
        "Existing-only Workbench LMDB inspection was cancelled.",
      ));
    };
    const onStdout = (chunk: Buffer | string): void => {
      if (outputExceeded) return;
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout, "utf8") > WORKBENCH_EXISTING_READER_MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        terminateAndAwaitClose(new WorkbenchExistingLmdbIsolationError(
          "OUTPUT_LIMIT",
          "Existing-only Workbench LMDB reader exceeded its output bound.",
        ));
      }
    };
    const onStderr = (chunk: Buffer | string): void => {
      if (Buffer.byteLength(stderr, "utf8") >= WORKBENCH_EXISTING_READER_MAX_ERROR_BYTES) return;
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr, "utf8") > WORKBENCH_EXISTING_READER_MAX_ERROR_BYTES) {
        stderr = Buffer.from(stderr, "utf8")
          .subarray(0, WORKBENCH_EXISTING_READER_MAX_ERROR_BYTES)
          .toString("utf8");
      }
    };
    const onError = (error: Error): void => {
      const failure = new WorkbenchExistingLmdbIsolationError(
        "SPAWN_FAILED",
        "Existing-only Workbench LMDB reader process failed.",
        { cause: error },
      );
      if (child.pid === undefined) settle(failure);
      else terminateAndAwaitClose(failure);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      if (terminationError) {
        settle(terminationError);
        return;
      }
      if (code !== 0 || signal !== null) {
        const detail = stderr.trim();
        settle(new WorkbenchExistingLmdbIsolationError(
          "WORKER_FAILED",
          `Existing-only Workbench LMDB reader exited abnormally (${signal ?? `code ${String(code)}`})${detail ? `: ${detail}` : "."}`,
        ));
        return;
      }
      let snapshot: WorkbenchExistingLmdbWireSnapshot;
      try {
        snapshot = parseWorkerOutput(stdout.trim());
      } catch (error) {
        settle(error instanceof WorkbenchExistingLmdbIsolationError
          ? error
          : new WorkbenchExistingLmdbIsolationError(
            "WORKER_PROTOCOL_INVALID",
            "Existing-only Workbench LMDB reader response could not be validated.",
            { cause: error },
          ));
        return;
      }
      settle(null, snapshot);
    };

    const operationTimer = setTimeout(() => {
      terminateAndAwaitClose(new WorkbenchExistingLmdbIsolationError(
        "TIMEOUT",
        `Existing-only Workbench LMDB inspection exceeded ${timeoutMs} ms.`,
      ));
    }, timeoutMs);
    operationTimer.unref?.();

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    // Close the small race between the pre-spawn abort check and listener
    // registration. An already-aborted signal does not replay its event.
    if (options.signal?.aborted) onAbort();
  });
}
