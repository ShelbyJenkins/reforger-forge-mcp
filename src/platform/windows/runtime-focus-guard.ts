import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_GUARD_TIMEOUT_MS = 15_000;
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;

interface RuntimeFocusGuardProtocol {
  ok: boolean;
  status: string;
  protectedWindowCount?: number;
  foregroundIntercepted?: boolean;
  foregroundRestored?: boolean;
  finalForegroundOwned?: boolean;
  message?: string;
}

function parseProtocol(stdout: string): RuntimeFocusGuardProtocol {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("Runtime focus guard returned no protocol response");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Runtime focus guard returned malformed protocol JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime focus guard returned an invalid protocol response");
  }
  const protocol = value as Record<string, unknown>;
  if (typeof protocol.ok !== "boolean" || typeof protocol.status !== "string") {
    throw new Error("Runtime focus guard returned an incomplete protocol response");
  }
  return protocol as unknown as RuntimeFocusGuardProtocol;
}

function helperPath(): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return join(packageRoot, "scripts", "windows", "runtime-focus-guard.ps1");
}

/**
 * Enforce the prepared `-noFocus` contract across Reforger's replacement
 * startup windows. The helper temporarily applies WS_EX_NOACTIVATE and
 * restores each original style before returning.
 */
export function preserveWindowsForegroundDuringRuntimeStartup(
  targetPid: number,
  timeoutMs = DEFAULT_GUARD_TIMEOUT_MS
): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  if (!Number.isSafeInteger(targetPid) || targetPid <= 0) {
    return Promise.reject(new Error("Runtime focus guard requires an exact positive PID"));
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    return Promise.reject(new Error("Runtime focus guard timeout must be 1000..60000 ms"));
  }

  return new Promise((resolvePromise, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", helperPath(),
        "-TargetPid", String(targetPid),
        "-DeadlineUnixMs", String(Date.now() + timeoutMs),
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs + 2_000,
        maxBuffer: MAX_HELPER_OUTPUT_BYTES,
      },
      (error, stdout) => {
        let protocol: RuntimeFocusGuardProtocol;
        try {
          protocol = parseProtocol(stdout);
        } catch (parseError) {
          reject(new Error(
            `Runtime focus guard failed without valid evidence: ${
              parseError instanceof Error ? parseError.message : String(parseError)
            }${error ? ` (${error.message})` : ""}`
          ));
          return;
        }
        if (error || !protocol.ok || protocol.finalForegroundOwned === true) {
          reject(new Error(
            protocol.message ??
            `Runtime focus guard failed (${protocol.status})${error ? `: ${error.message}` : ""}`
          ));
          return;
        }
        resolvePromise();
      }
    );
  });
}
