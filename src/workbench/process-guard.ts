import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { platform, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

export const WORKBENCH_PROCESS_NAME = "ArmaReforgerWorkbenchSteamDiag.exe";
export const WORKBENCH_OWNER_ARG_PREFIX = "-reforgerForgeOwnerToken=";
const OWNER_MARKER_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_STALE_MS = 120_000;
const PROCESS_QUERY_TIMEOUT_MS = 5_000;
const PROCESS_CAPTURE_TIMEOUT_MS = 5_000;
const PROCESS_POLL_MS = 100;
const CREATION_TIME_TOLERANCE_MS = 2_000;

export interface WorkbenchProcessIdentity {
  pid: number;
  executablePath: string;
  commandLine: string;
  creationTimeMs: number;
}

export interface WorkbenchOwnerMarker {
  version: 1;
  token: string;
  pid: number;
  executablePath: string;
  commandLineToken: string;
  creationTimeMs: number;
  launchedAtMs: number;
  gprojPath: string | null;
  host: string;
  port: number;
}

export interface WorkbenchProcessInspector {
  listWorkbenchProcesses(): Promise<WorkbenchProcessIdentity[]>;
  inspectPid(pid: number): Promise<WorkbenchProcessIdentity | null>;
  terminate(pid: number): boolean;
}

export interface WorkbenchProcessGuardOptions {
  stateDir?: string;
  inspector?: WorkbenchProcessInspector;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function parseJsonText(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
}

export function isProcessIdAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return platform() === "win32" ? normalized.toLowerCase() : normalized;
}

function parseIdentity(value: unknown): WorkbenchProcessIdentity | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const pid = Number(record.pid);
  const creationTimeMs = Number(record.creationTimeMs);
  const executablePath = typeof record.executablePath === "string" ? record.executablePath : "";
  const commandLine = typeof record.commandLine === "string" ? record.commandLine : "";
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(creationTimeMs)) return null;
  return { pid, executablePath, commandLine, creationTimeMs };
}

async function queryWindowsProcesses(pid?: number): Promise<WorkbenchProcessIdentity[]> {
  const filter = pid === undefined
    ? `Name='${WORKBENCH_PROCESS_NAME}'`
    : `ProcessId=${pid}`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$items = @(Get-CimInstance Win32_Process -Filter \"${filter}\")`,
    "$result = @($items | ForEach-Object {",
    "  $created = 0",
    "  if ($_.CreationDate) { $created = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }",
    "  [pscustomobject]@{",
    "    pid = [int]$_.ProcessId",
    "    executablePath = [string]$_.ExecutablePath",
    "    commandLine = [string]$_.CommandLine",
    "    creationTimeMs = [long]$created",
    "  }",
    "})",
    "ConvertTo-Json -InputObject $result -Compress",
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { timeout: PROCESS_QUERY_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }
  );
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.map(parseIdentity).filter((entry): entry is WorkbenchProcessIdentity => entry !== null);
}

async function queryWindowsProcessesFallback(pid?: number): Promise<WorkbenchProcessIdentity[]> {
  const selector = pid === undefined
    ? `Get-Process -Name '${WORKBENCH_PROCESS_NAME.replace(/\.exe$/i, "")}' -ErrorAction SilentlyContinue`
    : `Get-Process -Id ${pid} -ErrorAction SilentlyContinue`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$items = @(${selector})`,
    "$result = @($items | ForEach-Object {",
    "  $created = 0",
    "  try { $created = ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } catch {}",
    "  $path = ''",
    "  try { $path = [string]$_.Path } catch {}",
    "  [pscustomobject]@{",
    "    pid = [int]$_.Id",
    "    executablePath = $path",
    "    commandLine = ''",
    "    creationTimeMs = [long]$created",
    "  }",
    "})",
    "ConvertTo-Json -InputObject $result -Compress",
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { timeout: PROCESS_QUERY_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }
  );
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.map(parseIdentity).filter((entry): entry is WorkbenchProcessIdentity => entry !== null);
}

export function resolveWindowsInspectionFallback(
  pid: number | undefined,
  fallback: WorkbenchProcessIdentity[],
  primaryError: unknown
): WorkbenchProcessIdentity[] {
  if (pid === undefined || fallback.length === 0) return fallback;
  const detail = primaryError instanceof Error ? primaryError.message : String(primaryError);
  throw new Error(
    `Workbench PID ${pid} exists, but Windows denied command-line inspection needed to verify its ` +
      `owner token (${detail}). Refusing adoption or termination; no process was killed.`
  );
}

async function queryWindowsProcessesFailClosed(pid?: number): Promise<WorkbenchProcessIdentity[]> {
  try {
    return await queryWindowsProcesses(pid);
  } catch (primaryError) {
    let fallback: WorkbenchProcessIdentity[];
    try {
      fallback = await queryWindowsProcessesFallback(pid);
    } catch (fallbackError) {
      throw new Error(
        `Windows Workbench process inspection failed in both CIM and Get-Process fallbacks. ` +
          `CIM: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}; ` +
          `fallback: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}. ` +
          "Refusing launch because absence of another Workbench cannot be proven."
      );
    }
    logger.warn(
      `CIM Workbench inspection failed; Get-Process fallback found ${fallback.length} process(es).`
    );
    return resolveWindowsInspectionFallback(pid, fallback, primaryError);
  }
}

function queryProcIdentity(pid: number): WorkbenchProcessIdentity | null {
  const procDir = `/proc/${pid}`;
  try {
    const executablePath = readlinkSync(join(procDir, "exe"));
    const commandLine = readFileSync(join(procDir, "cmdline"), "utf8").replace(/\0/g, " ").trim();
    // Linux start ticks are sufficient as a stable process-instance discriminator,
    // even though they are not Unix epoch milliseconds.
    const stat = readFileSync(join(procDir, "stat"), "utf8");
    const closeParen = stat.lastIndexOf(")");
    const fields = stat.slice(closeParen + 2).split(" ");
    const startTicks = Number(fields[19]);
    if (!Number.isFinite(startTicks)) return null;
    return { pid, executablePath, commandLine, creationTimeMs: startTicks };
  } catch {
    return null;
  }
}

export class DefaultWorkbenchProcessInspector implements WorkbenchProcessInspector {
  async listWorkbenchProcesses(): Promise<WorkbenchProcessIdentity[]> {
    if (platform() === "win32") return queryWindowsProcessesFailClosed();
    if (!existsSync("/proc")) return [];
    const matches: WorkbenchProcessIdentity[] = [];
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const identity = queryProcIdentity(Number(entry.name));
      if (!identity) continue;
      if (basename(identity.executablePath).toLowerCase() === WORKBENCH_PROCESS_NAME.toLowerCase()) {
        matches.push(identity);
      }
    }
    return matches;
  }

  async inspectPid(pid: number): Promise<WorkbenchProcessIdentity | null> {
    if (platform() === "win32") {
      const entries = await queryWindowsProcessesFailClosed(pid);
      return entries[0] ?? null;
    }
    return queryProcIdentity(pid);
  }

  terminate(pid: number): boolean {
    try {
      return process.kill(pid, "SIGTERM");
    } catch {
      return false;
    }
  }
}

function isMarker(value: unknown): value is WorkbenchOwnerMarker {
  if (!value || typeof value !== "object") return false;
  const marker = value as Partial<WorkbenchOwnerMarker>;
  return marker.version === OWNER_MARKER_VERSION &&
    typeof marker.token === "string" && marker.token.length >= 16 &&
    Number.isInteger(marker.pid) && Number(marker.pid) > 0 &&
    typeof marker.executablePath === "string" && marker.executablePath.length > 0 &&
    typeof marker.commandLineToken === "string" && marker.commandLineToken.length > 0 &&
    typeof marker.creationTimeMs === "number" && Number.isFinite(marker.creationTimeMs) &&
    typeof marker.launchedAtMs === "number" && Number.isFinite(marker.launchedAtMs) &&
    (typeof marker.gprojPath === "string" || marker.gprojPath === null) &&
    typeof marker.host === "string" &&
    Number.isInteger(marker.port) && Number(marker.port) > 0;
}

export class WorkbenchProcessGuard {
  readonly stateDir: string;
  readonly lockPath: string;
  readonly ownerMarkerPath: string;
  private readonly inspector: WorkbenchProcessInspector;
  private readonly lockTimeoutMs: number;
  private readonly lockStaleMs: number;

  constructor(options: WorkbenchProcessGuardOptions = {}) {
    this.stateDir = options.stateDir ?? tmpdir();
    this.lockPath = join(this.stateDir, "reforger-forge-mcp-workbench.launch.lock");
    this.ownerMarkerPath = join(this.stateDir, "reforger-forge-mcp-workbench.owner.json");
    this.inspector = options.inspector ?? new DefaultWorkbenchProcessInspector();
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  }

  createOwnerToken(): string {
    return randomUUID();
  }

  ownerArgument(token: string): string {
    return `${WORKBENCH_OWNER_ARG_PREFIX}${token}`;
  }

  async withLaunchLock<T>(action: () => Promise<T>): Promise<T> {
    mkdirSync(this.stateDir, { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    const lockToken = `${process.pid}:${randomUUID()}`;
    let fd: number | null = null;

    while (fd === null) {
      try {
        const openedFd = openSync(this.lockPath, "wx");
        try {
          writeFileSync(openedFd, JSON.stringify({
            token: lockToken,
            pid: process.pid,
            createdAtMs: Date.now(),
          }));
          fd = openedFd;
        } catch (writeError) {
          // A created-but-uninitialized lock has no recoverable holder proof.
          // Close our exact descriptor and remove only the path we just made.
          try { closeSync(openedFd); } catch { /* best effort */ }
          try { unlinkSync(this.lockPath); } catch { /* best effort */ }
          throw writeError;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        try {
          const ageMs = Date.now() - statSync(this.lockPath).mtimeMs;
          if (ageMs > this.lockStaleMs) {
            let holderPid = 0;
            try {
              const record = parseJsonText(readFileSync(this.lockPath, "utf8")) as { pid?: unknown };
              holderPid = Number(record.pid);
            } catch {
              // Malformed old lock: age plus absence of a live recorded holder
              // is required before reclamation.
            }
            if (!isProcessIdAlive(holderPid)) {
              unlinkSync(this.lockPath);
              continue;
            }
          }
        } catch {
          // The lock cannot be inspected or reclaimed. Treat it as active and
          // continue through the same bounded deadline/poll path below.
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for the machine-wide Workbench launch lock at ${this.lockPath}. ` +
              "Another launcher is active; no second Workbench was started."
          );
        }
        await sleep(PROCESS_POLL_MS);
      }
    }

    try {
      return await action();
    } finally {
      try {
        // The path still exists while our descriptor is open, so another launcher
        // cannot replace it between close and unlink.
        closeSync(fd);
      } finally {
        try {
          const record = parseJsonText(readFileSync(this.lockPath, "utf8")) as { token?: string };
          if (record.token === lockToken) unlinkSync(this.lockPath);
        } catch {
          // A crashed/stale lock is reclaimed by age on the next bounded attempt.
        }
      }
    }
  }

  async listWorkbenchProcesses(): Promise<WorkbenchProcessIdentity[]> {
    return this.inspector.listWorkbenchProcesses();
  }

  async assertNoWorkbenchProcesses(): Promise<void> {
    const processes = await this.listWorkbenchProcesses();
    if (processes.length === 0) return;
    const pids = processes.map((entry) => entry.pid).join(", ");
    throw new Error(
      `Refusing to launch another Workbench while PID(s) ${pids} are running. ` +
        "The existing process is not owned by this launch operation."
    );
  }

  readOwnerMarker(): WorkbenchOwnerMarker | null {
    try {
      const parsed = parseJsonText(readFileSync(this.ownerMarkerPath, "utf8"));
      if (isMarker(parsed)) return parsed;
      logger.warn(`Ignoring malformed Workbench owner marker at ${this.ownerMarkerPath}`);
    } catch {
      return null;
    }
    return null;
  }

  private markerMatchesIdentity(
    marker: WorkbenchOwnerMarker,
    identity: WorkbenchProcessIdentity
  ): boolean {
    return identity.pid === marker.pid &&
      normalizePath(identity.executablePath) === normalizePath(marker.executablePath) &&
      identity.commandLine.includes(marker.commandLineToken) &&
      Math.abs(identity.creationTimeMs - marker.creationTimeMs) <= CREATION_TIME_TOLERANCE_MS;
  }

  async recoverOwnerMarker(): Promise<WorkbenchOwnerMarker | null> {
    const marker = this.readOwnerMarker();
    if (!marker) return null;
    const identity = await this.inspector.inspectPid(marker.pid);
    if (identity && this.markerMatchesIdentity(marker, identity)) return marker;
    // Missing process, PID reuse, different executable, or missing random token:
    // discard proof but never terminate the process now occupying that PID.
    this.clearOwnerMarker(marker.token);
    return null;
  }

  async captureOwnerMarker(args: {
    pid: number;
    executablePath: string;
    token: string;
    launchedAtMs: number;
    gprojPath: string | null;
    host: string;
    port: number;
  }): Promise<WorkbenchOwnerMarker> {
    const expectedToken = this.ownerArgument(args.token);
    const deadline = Date.now() + PROCESS_CAPTURE_TIMEOUT_MS;
    let identity: WorkbenchProcessIdentity | null = null;
    while (Date.now() < deadline) {
      identity = await this.inspector.inspectPid(args.pid);
      if (identity &&
        normalizePath(identity.executablePath) === normalizePath(args.executablePath) &&
        identity.commandLine.includes(expectedToken)) {
        break;
      }
      identity = null;
      await sleep(PROCESS_POLL_MS);
    }
    if (!identity) {
      throw new Error(
        `Could not verify Workbench process ${args.pid} by executable path and owner token; launch aborted.`
      );
    }

    const marker: WorkbenchOwnerMarker = {
      version: OWNER_MARKER_VERSION,
      token: args.token,
      pid: args.pid,
      executablePath: resolve(args.executablePath),
      commandLineToken: expectedToken,
      creationTimeMs: identity.creationTimeMs,
      launchedAtMs: args.launchedAtMs,
      gprojPath: args.gprojPath,
      host: args.host,
      port: args.port,
    };
    this.writeOwnerMarker(marker);
    return marker;
  }

  writeOwnerMarker(marker: WorkbenchOwnerMarker): void {
    mkdirSync(this.stateDir, { recursive: true });
    const tempPath = `${this.ownerMarkerPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // Windows rename does not replace an existing file. Launches are serialized
    // by the machine-wide lock, and an old marker never authorizes termination
    // without a fresh process-identity check.
    if (existsSync(this.ownerMarkerPath)) unlinkSync(this.ownerMarkerPath);
    renameSync(tempPath, this.ownerMarkerPath);
  }

  clearOwnerMarker(expectedToken: string): void {
    const marker = this.readOwnerMarker();
    if (!marker || marker.token !== expectedToken) return;
    try {
      unlinkSync(this.ownerMarkerPath);
    } catch {
      // Best effort. A stale marker never authorizes a kill without revalidation.
    }
  }

  async terminateVerifiedOwner(marker: WorkbenchOwnerMarker, timeoutMs: number): Promise<void> {
    const identity = await this.inspector.inspectPid(marker.pid);
    if (!identity) {
      this.clearOwnerMarker(marker.token);
      return;
    }
    if (!this.markerMatchesIdentity(marker, identity)) {
      throw new Error(
        `Refusing to terminate PID ${marker.pid}: executable, creation time, or owner token no longer matches.`
      );
    }
    if (!this.inspector.terminate(marker.pid)) {
      throw new Error(`Could not terminate verified MCP-owned Workbench process ${marker.pid}.`);
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.inspector.inspectPid(marker.pid);
      if (!current || !this.markerMatchesIdentity(marker, current)) {
        this.clearOwnerMarker(marker.token);
        return;
      }
      await sleep(PROCESS_POLL_MS);
    }
    throw new Error(
      `Verified MCP-owned Workbench process ${marker.pid} did not exit within ${timeoutMs / 1000}s.`
    );
  }
}
