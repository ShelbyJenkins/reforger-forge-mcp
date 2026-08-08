import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExactProcessIdentity } from "../../foundation/identity.js";

const DEFAULT_GUARD_TIMEOUT_MS = 60_000;
const MIN_GUARD_TIMEOUT_MS = 1_000;
const MAX_GUARD_TIMEOUT_MS = 120_000;
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;

export interface RuntimeFocusGuardPreparation {
  readonly executablePath: string;
  readonly ownerTokenArgument: string;
  readonly timeoutMs?: number;
  /** Native fault injection for the opt-in Windows acceptance fixture only. */
  readonly testFaultMode?: "hook" | "style";
}

export interface RuntimeFocusGuardEvidence {
  readonly targetPid: number;
  readonly targetCreationTime: string;
  readonly hookCount: number;
  readonly hooksUnhooked: boolean;
  readonly callbackRooted: boolean;
  readonly callbackReleased: boolean;
  readonly protectedWindowCount: number;
  readonly styleVerifiedCount: number;
  readonly foregroundIntercepted: boolean;
  readonly foregroundRestored: boolean;
  readonly finalForegroundOwned: boolean;
}

export interface RuntimeFocusGuardTransaction {
  /** Bind the just-created child immediately; the native helper retains its exact handle. */
  bindTarget(targetPid: number): Promise<void>;
  /** Require positive native evidence matching the independently inspected child identity. */
  complete(expected: ExactProcessIdentity): Promise<RuntimeFocusGuardEvidence>;
  /** Stop a ready guard when spawn or exact inspection fails. */
  abort(): Promise<void>;
}

type FocusGuardProtocol = Record<string, unknown> & {
  readonly ok: boolean;
  readonly status: string;
};

export class RuntimeFocusGuardError extends Error {
  readonly code = "FOCUS_PROTECTION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeFocusGuardError";
  }
}

function helperPath(): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return join(packageRoot, "scripts", "windows", "runtime-focus-guard.ps1");
}

function parseProtocol(line: string): FocusGuardProtocol {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new RuntimeFocusGuardError("Runtime focus guard returned malformed protocol JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeFocusGuardError("Runtime focus guard returned an invalid protocol response");
  }
  const protocol = value as Record<string, unknown>;
  if (typeof protocol.ok !== "boolean" || typeof protocol.status !== "string") {
    throw new RuntimeFocusGuardError("Runtime focus guard returned an incomplete protocol response");
  }
  return protocol as FocusGuardProtocol;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function positiveFileTime(value: unknown): string | null {
  return typeof value === "string" && /^[1-9]\d*$/.test(value) ? value : null;
}

function readEvidence(protocol: FocusGuardProtocol): RuntimeFocusGuardEvidence {
  const targetPid = positiveInteger(protocol.targetPid);
  const targetCreationTime = positiveFileTime(protocol.targetCreationTime);
  const hookCount = positiveInteger(protocol.hookCount);
  const protectedWindowCount = positiveInteger(protocol.protectedWindowCount);
  const styleVerifiedCount = positiveInteger(protocol.styleVerifiedCount);
  if (!protocol.ok || protocol.status !== "protected" || targetPid === null ||
      targetCreationTime === null || hookCount !== 2 ||
      protectedWindowCount === null || styleVerifiedCount === null ||
      styleVerifiedCount !== protectedWindowCount ||
      protocol.hooksUnhooked !== true || protocol.callbackRooted !== true ||
      protocol.callbackReleased !== true || protocol.finalForegroundOwned !== false ||
      typeof protocol.foregroundIntercepted !== "boolean" ||
      typeof protocol.foregroundRestored !== "boolean" ||
      (protocol.foregroundIntercepted && !protocol.foregroundRestored)) {
    const message = typeof protocol.message === "string" ? protocol.message :
      `Runtime focus guard returned insufficient protection evidence (${protocol.status})`;
    throw new RuntimeFocusGuardError(message);
  }
  return {
    targetPid,
    targetCreationTime,
    hookCount,
    hooksUnhooked: true,
    callbackRooted: true,
    callbackReleased: true,
    protectedWindowCount,
    styleVerifiedCount,
    foregroundIntercepted: protocol.foregroundIntercepted,
    foregroundRestored: protocol.foregroundRestored,
    finalForegroundOwned: false,
  };
}

/** Validate the helper's positive native proof against independent process inspection. */
export function validateRuntimeFocusGuardEvidence(
  value: unknown,
  expected: ExactProcessIdentity
): RuntimeFocusGuardEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeFocusGuardError("Runtime focus guard returned an invalid evidence object");
  }
  const protocol = value as FocusGuardProtocol;
  if (typeof protocol.ok !== "boolean" || typeof protocol.status !== "string") {
    throw new RuntimeFocusGuardError("Runtime focus guard returned incomplete evidence");
  }
  const evidence = readEvidence(protocol);
  if (evidence.targetPid !== expected.pid ||
      evidence.targetCreationTime !== expected.creationTime) {
    throw new RuntimeFocusGuardError(
      "Runtime focus guard native handle identity does not match exact process inspection"
    );
  }
  return evidence;
}

function assertPreparation(input: RuntimeFocusGuardPreparation): number {
  if (input.executablePath.trim().length === 0) {
    throw new RuntimeFocusGuardError("Runtime focus guard requires an executable path");
  }
  if (!input.ownerTokenArgument.startsWith("-reforgerForgeOwnerToken=") ||
      input.ownerTokenArgument.length > 256) {
    throw new RuntimeFocusGuardError("Runtime focus guard requires the exact bounded owner argument");
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_GUARD_TIMEOUT_MS ||
      timeoutMs > MAX_GUARD_TIMEOUT_MS) {
    throw new RuntimeFocusGuardError("Runtime focus guard timeout must be 1000..120000 ms");
  }
  return timeoutMs;
}

function writeLine(child: ChildProcessWithoutNullStreams, value: unknown): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    child.stdin.write(`${JSON.stringify(value)}\n`, "utf8", (error) => {
      if (error) reject(new RuntimeFocusGuardError(`Runtime focus guard input failed: ${error.message}`));
      else resolvePromise();
    });
  });
}

/**
 * Establish the native hooks before process creation. The returned transaction
 * must be bound from the synchronous spawn callback, then completed only after
 * the ordinary exact-process backend independently inspects the same child.
 */
export async function prepareWindowsForegroundDuringRuntimeStartup(
  input: RuntimeFocusGuardPreparation
): Promise<RuntimeFocusGuardTransaction> {
  const timeoutMs = assertPreparation(input);
  if (process.platform !== "win32") {
    throw new RuntimeFocusGuardError("Runtime focus protection is available only on Windows");
  }

  const deadlineUnixMs = Date.now() + timeoutMs;
  const child = spawn("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", helperPath(),
    "-DeadlineUnixMs", String(deadlineUnixMs),
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let buffered = "";
  let stderr = "";
  let readySettled = false;
  let finalSettled = false;
  let readyResolve!: (protocol: FocusGuardProtocol) => void;
  let readyReject!: (error: Error) => void;
  let finalResolve!: (protocol: FocusGuardProtocol) => void;
  let finalReject!: (error: Error) => void;
  const ready = new Promise<FocusGuardProtocol>((resolvePromise, reject) => {
    readyResolve = resolvePromise;
    readyReject = reject;
  });
  const final = new Promise<FocusGuardProtocol>((resolvePromise, reject) => {
    finalResolve = resolvePromise;
    finalReject = reject;
  });
  // A failed prepare may never expose `final` to a caller; keep that rejection handled.
  void final.catch(() => undefined);

  const fail = (error: Error): void => {
    if (!readySettled) {
      readySettled = true;
      readyReject(error);
    }
    if (!finalSettled) {
      finalSettled = true;
      finalReject(error);
    }
  };
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_HELPER_OUTPUT_BYTES);
  });
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    if (buffered.length > MAX_HELPER_OUTPUT_BYTES) {
      fail(new RuntimeFocusGuardError("Runtime focus guard exceeded its output bound"));
      child.kill();
      return;
    }
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      let protocol: FocusGuardProtocol;
      try { protocol = parseProtocol(line); }
      catch (error) {
        fail(error instanceof Error ? error : new RuntimeFocusGuardError(String(error)));
        child.kill();
        return;
      }
      if (protocol.status === "ready") {
        if (!readySettled) {
          readySettled = true;
          readyResolve(protocol);
        }
      } else {
        if (!readySettled) {
          readySettled = true;
          readyReject(new RuntimeFocusGuardError(
            typeof protocol.message === "string" ? protocol.message :
              `Runtime focus guard failed before readiness (${protocol.status})`
          ));
        }
        if (!finalSettled) {
          finalSettled = true;
          finalResolve(protocol);
        }
      }
    }
  });
  child.once("error", (error) => fail(new RuntimeFocusGuardError(
    `Runtime focus guard could not start: ${error.message}`
  )));
  child.once("close", (code) => {
    if (!finalSettled) fail(new RuntimeFocusGuardError(
      `Runtime focus guard exited before evidence (${code ?? "unknown"})${stderr ? `: ${stderr.trim()}` : ""}`
    ));
  });

  const timer = setTimeout(() => {
    fail(new RuntimeFocusGuardError("Runtime focus guard exceeded its absolute deadline"));
    child.kill();
  }, timeoutMs + 5_000);
  timer.unref();
  try {
    await writeLine(child, {
      executablePath: resolve(input.executablePath),
      ownerTokenArgument: input.ownerTokenArgument,
      faultMode: input.testFaultMode ?? "none",
    });
  } catch (error) {
    clearTimeout(timer);
    child.kill();
    throw error;
  }

  let readyProtocol: FocusGuardProtocol;
  try {
    readyProtocol = await ready;
    if (!readyProtocol.ok || positiveInteger(readyProtocol.hookCount) === null ||
        Number(readyProtocol.hookCount) < 2 || readyProtocol.callbackRooted !== true) {
      throw new RuntimeFocusGuardError(
        typeof readyProtocol.message === "string" ? readyProtocol.message :
          "Runtime focus guard did not prove pre-spawn hook readiness"
      );
    }
  } catch (error) {
    clearTimeout(timer);
    child.kill();
    throw error;
  }

  let boundPid: number | null = null;
  return {
    async bindTarget(targetPid) {
      if (!Number.isSafeInteger(targetPid) || targetPid <= 0 || boundPid !== null) {
        throw new RuntimeFocusGuardError("Runtime focus guard target must be bound exactly once");
      }
      boundPid = targetPid;
      await writeLine(child, { action: "bind", targetPid });
      child.stdin.end();
    },
    async complete(expected) {
      if (boundPid === null || expected.pid !== boundPid) {
        throw new RuntimeFocusGuardError("Runtime focus guard completion identity does not match its bound PID");
      }
      try {
        return validateRuntimeFocusGuardEvidence(await final, expected);
      } finally {
        clearTimeout(timer);
      }
    },
    async abort() {
      clearTimeout(timer);
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (boundPid === null) await writeLine(child, { action: "abort" });
      } catch {
        // Killing the exact helper below is the abort authority.
      }
      child.stdin.end();
      child.kill();
    },
  };
}
