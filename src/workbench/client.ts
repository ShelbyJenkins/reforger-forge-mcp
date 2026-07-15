/**
 * TCP client for the Workbench NET API.
 *
 * Each rawCall() opens a fresh TCP connection, sends one request, reads the
 * response, and closes the socket (protocol requirement).
 *
 * call() wraps rawCall() with auto-launch: if Workbench isn't running,
 * it installs handler scripts, launches the exe, waits for the NET API,
 * and retries the original call.
 */

import { Socket } from "node:net";
import { existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { encodeRequest, decodeResponse } from "./protocol.js";
import { logger } from "../utils/logger.js";
import type { Config } from "../config.js";
import { generateGproj } from "../templates/gproj.js";
import {
  WorkbenchProcessGuard,
  type WorkbenchOwnerMarker,
} from "./process-guard.js";

const DEFAULT_CLIENT_ID = "EnfusionMCP";
const DEFAULT_TIMEOUT_MS = 10_000;
/** Maximum response size (10 MB) to prevent memory exhaustion from malformed/unexpected data. */
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
const WORKBENCH_EXE = "ArmaReforgerWorkbenchSteamDiag.exe";
const WORKBENCH_SUBDIR = "Workbench";
const HANDLER_FOLDER = "EnfusionMCP";
const LAUNCH_POLL_INTERVAL_MS = 3_000;
const LAUNCH_TIMEOUT_MS = 90_000;
/** Maximum time to wait for an MCP-owned Workbench process to exit. */
const OWNED_PROCESS_EXIT_TIMEOUT_MS = 15_000;
/** Maximum time to wait for the NET API port to be released before relaunch. */
const PORT_RELEASE_TIMEOUT_MS = 15_000;
const PORT_RELEASE_POLL_MS = 200;

export type WorkbenchMode = "edit" | "play" | "unknown";

export interface DiagnosticReport {
  host: string;
  port: number;
  workbenchExe: { path: string; exists: boolean } | null;
  projectPath: { path: string; exists: boolean } | null;
  defaultMod: string | null;
  bundledScripts: { path: string; exists: boolean };
  standaloneAddon: { path: string; exists: boolean; fileCount: number };
  installedMods: Array<{ modDir: string; handlerDir: string; fileCount: number }>;
  /** Result of the NET API probe. */
  netApi: "up_with_handlers" | "up_no_handlers" | "refused" | "timeout" | "error";
  netApiError?: string;
}

export interface WorkbenchState {
  connected: boolean;
  mode: WorkbenchMode;
  lastUpdated: number;
}

export interface WorkbenchCallOptions {
  /** Timeout in milliseconds (default 10 000). */
  timeout?: number;
  /** Skip auto-launch on connection failure (used internally by ping). */
  skipAutoLaunch?: boolean;
}

export interface WorkbenchRestartResult {
  previousPid: number;
  pid: number;
  gprojPath: string | null;
}

interface OwnedWorkbenchLaunch {
  process: ChildProcess | null;
  pid: number;
  gprojPath: string | null;
  marker: WorkbenchOwnerMarker | null;
  spawnError?: Error;
}

export class WorkbenchError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "CONNECTION_REFUSED"
      | "TIMEOUT"
      | "PROTOCOL_ERROR"
      | "API_ERROR"
      | "LAUNCH_FAILED" = "API_ERROR"
  ) {
    super(message);
    this.name = "WorkbenchError";
  }
}

/**
 * Build Workbench command-line arguments from explicit launch configuration.
 *
 * Workbench expects all addon roots in one comma-separated -addonsDir value;
 * repeated flags are not merged reliably. Node's spawn receives each entry in
 * this returned array as one argument, so paths containing spaces remain intact.
 */
export function buildWorkbenchLaunchArgs(
  gprojPath?: string | null,
  configuredAddonDirs?: readonly string[],
  scriptAuthorizeAll = false,
  noThrow = false,
  ownerArgument?: string
): string[] {
  const args: string[] = [];
  const addonDirs: string[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];

  if (configuredAddonDirs !== undefined && !Array.isArray(configuredAddonDirs)) {
    throw new WorkbenchError(
      "Workbench addon directories must be configured as an array of paths.",
      "LAUNCH_FAILED"
    );
  }

  for (const configuredDir of configuredAddonDirs ?? []) {
    if (typeof configuredDir !== "string" || configuredDir.trim().length === 0) {
      throw new WorkbenchError(
        "Workbench addon directories must be non-empty paths.",
        "LAUNCH_FAILED"
      );
    }
    const configuredPath = configuredDir.trim();
    if (configuredPath.includes(",")) {
      throw new WorkbenchError(
        `Workbench addon directory cannot contain a comma: ${configuredPath}`,
        "LAUNCH_FAILED"
      );
    }

    const addonDir = resolve(configuredPath);
    const dedupeKey = process.platform === "win32" ? addonDir.toLowerCase() : addonDir;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    try {
      if (!statSync(addonDir).isDirectory()) {
        invalid.push(addonDir);
        continue;
      }
    } catch {
      invalid.push(addonDir);
      continue;
    }
    addonDirs.push(addonDir);
  }

  if (invalid.length > 0) {
    const message = invalid.length === 1
      ? "Configured Workbench addon path is not a directory:\n"
      : "Configured Workbench addon paths are not directories:\n";
    throw new WorkbenchError(
      message +
        invalid.map((path) => `  - ${path}`).join("\n"),
      "LAUNCH_FAILED"
    );
  }

  if (addonDirs.length > 0) {
    args.push("-addonsDir", addonDirs.join(","));
  }
  if (gprojPath) {
    args.push("-gproj", gprojPath);
  }
  if (scriptAuthorizeAll) {
    args.push("-scriptAuthorizeAll");
  }
  if (noThrow) {
    args.push("-noThrow");
  }
  if (ownerArgument) {
    args.push(ownerArgument);
  }

  return args;
}

export class WorkbenchClient {
  private launchPromise: Promise<void> | null = null;
  private restartPromise: Promise<WorkbenchRestartResult> | null = null;
  private ownedWorkbench: OwnedWorkbenchLaunch | null = null;
  private _state: WorkbenchState = { connected: false, mode: "unknown", lastUpdated: 0 };

  /** Current cached connection state. Updated after every successful call. */
  get state(): Readonly<WorkbenchState> {
    return this._state;
  }

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly config?: Config,
    private readonly clientId: string = DEFAULT_CLIENT_ID,
    private readonly processGuard: WorkbenchProcessGuard = new WorkbenchProcessGuard()
  ) {}

  /**
   * Call a Workbench NET API function.
   * Auto-launches Workbench if not running.
   */
  async call<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options: WorkbenchCallOptions = {}
  ): Promise<T> {
    try {
      const result = await this.rawCall<T>(apiFunc, params, options);
      this._state.connected = true;
      this._state.lastUpdated = Date.now();
      this.extractMode(result);
      return result;
    } catch (err) {
      if (err instanceof WorkbenchError) {
        if (err.code === "CONNECTION_REFUSED" || err.code === "TIMEOUT" || err.code === "PROTOCOL_ERROR") {
          this._state = { connected: false, mode: "unknown", lastUpdated: Date.now() };
        }
        if (!options.skipAutoLaunch && this.config) {
          if (err.code === "CONNECTION_REFUSED") {
            // Workbench not running — install handlers, launch, retry
            logger.info(`Workbench not running, auto-launching...`);
            await this.ensureRunning();
            const result = await this.rawCall<T>(apiFunc, params, options);
            this._state.connected = true;
            this._state.lastUpdated = Date.now();
            this.extractMode(result);
            return result;
          }
          if (err.code === "API_ERROR" && err.message.includes("Undefined API func")) {
            // Installing handlers into a live user session can hot-reload all
            // scripts while a world is loaded. Only an MCP-owned process may be
            // recovered, and recovery is a clean restart rather than a live reload.
            if (!(await this.recoverOwnedWorkbench())) {
              throw new WorkbenchError(
                "Handler recovery refused: the running Workbench was not launched by this MCP instance. " +
                  "Close it yourself, then use wb_launch to start an owner-scoped automation session.",
                "LAUNCH_FAILED"
              );
            }
            logger.info("Handler scripts not loaded in MCP-owned Workbench; restarting cleanly...");
            await this.restartOwnedWorkbench();
            const result = await this.rawCall<T>(apiFunc, params, options);
            this._state.connected = true;
            this._state.lastUpdated = Date.now();
            this.extractMode(result);
            return result;
          }
        }
      }
      throw err;
    }
  }

  /**
   * Explicitly refresh cached state by calling EMCP_WB_GetState.
   */
  async refreshState(): Promise<WorkbenchState> {
    try {
      await this.call<Record<string, unknown>>("EMCP_WB_GetState");
      return { ...this._state };
    } catch {
      this._state = { connected: false, mode: "unknown", lastUpdated: Date.now() };
      return { ...this._state };
    }
  }

  /**
   * Ensure Workbench is running. Installs handler scripts, launches exe,
   * and waits for NET API. Safe to call concurrently — deduplicates launches.
   * @param gprojPath Optional .gproj file path to open directly (skips launcher).
   */
  async ensureRunning(gprojPath?: string): Promise<void> {
    if (!this.config) {
      throw new WorkbenchError("No config provided — cannot auto-launch Workbench.", "LAUNCH_FAILED");
    }

    // Deduplicate concurrent calls — all callers await the same promise
    if (this.launchPromise) {
      return this.launchPromise;
    }

    const promise = this.launchWorkbench(gprojPath).finally(() => {
      // Only clear if this is still the active promise (guards against re-entrant calls)
      if (this.launchPromise === promise) {
        this.launchPromise = null;
      }
    });

    this.launchPromise = promise;
    return promise;
  }

  /**
   * Restart the exact Workbench process launched by this client instance.
   *
   * This deliberately fails closed when the connected Workbench was started by
   * the user or another MCP process. It never searches for or terminates a
   * process by executable name. The original resolved .gproj is retained so a
   * clean startup recompiles the same project with the automated launch flags.
   */
  async restartOwnedWorkbench(): Promise<WorkbenchRestartResult> {
    if (this.restartPromise) return this.restartPromise;

    const promise = this.performOwnedRestart().finally(() => {
      if (this.restartPromise === promise) {
        this.restartPromise = null;
      }
    });
    this.restartPromise = promise;
    return promise;
  }

  /**
   * Recover a process launched by an earlier instance of this MCP server.
   * Adoption requires the persisted random command-line token, executable path,
   * PID, and OS process creation time to match. It never adopts a merely
   * responsive user-launched Workbench.
   */
  async hasOwnedWorkbench(): Promise<boolean> {
    return (await this.recoverOwnedWorkbench()) !== null;
  }

  /**
   * Quick health check. Returns true if Workbench responds, false otherwise.
   * Does NOT auto-launch.
   *
   * Uses our custom EMCP_WB_Ping handler (not the built-in GetLoadedProjects)
   * so the launch poller only succeeds once the mod's handler scripts have
   * finished compiling — avoiding a race where the NET API socket is up but
   * custom handlers aren't loaded yet.
   */
  async ping(): Promise<boolean> {
    try {
      await this.rawCall("EMCP_WB_Ping", {}, { timeout: 3000, skipAutoLaunch: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove injected handler scripts from a mod's directory.
   * Call this after Workbench work is done, before publishing the mod.
   * Deletes Scripts/WorkbenchGame/EnfusionMCP/ from the mod.
   * Safe to call even if scripts were never injected.
   */
  cleanupHandlerScripts(modDir: string): boolean {
    const handlerDir = resolve(modDir, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    logger.info(`Checking for handler scripts at: ${handlerDir}`);
    if (!existsSync(handlerDir)) {
      logger.info(`Handler scripts not found at ${handlerDir}`);
      return false;
    }
    try {
      rmSync(handlerDir, { recursive: true, force: true });
      logger.info(`Removed handler scripts from ${handlerDir}`);
      // Clean up empty parent dirs
      const wbGameDir = join(modDir, "Scripts", "WorkbenchGame");
      if (existsSync(wbGameDir) && readdirSync(wbGameDir).length === 0) {
        rmSync(wbGameDir);
      }
      return true;
    } catch (e) {
      logger.warn(`Failed to clean up handler scripts: ${e}`);
      return false;
    }
  }

  /**
   * Collect a diagnostic snapshot: config, file system, and NET API state.
   * Does NOT auto-launch Workbench or throw — always returns a report.
   */
  async diagnose(): Promise<DiagnosticReport> {
    // --- Config info ---
    const host = this.host;
    const port = this.port;
    const defaultMod = this.config?.defaultMod ?? null;

    // Workbench exe
    let workbenchExe: DiagnosticReport["workbenchExe"] = null;
    if (this.config) {
      const exePath = this.findWorkbenchExe();
      const candidate =
        exePath ??
        join(this.config.workbenchPath, WORKBENCH_SUBDIR, WORKBENCH_EXE);
      workbenchExe = { path: candidate, exists: existsSync(candidate) };
    }

    // Project path
    let projectPathInfo: DiagnosticReport["projectPath"] = null;
    if (this.config?.projectPath) {
      projectPathInfo = {
        path: this.config.projectPath,
        exists: existsSync(this.config.projectPath),
      };
    }

    // Bundled handler scripts (inside this package)
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const bundledDir = join(packageRoot, "mod", "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    const bundledScripts = { path: bundledDir, exists: existsSync(bundledDir) };

    // Standalone addon
    const standaloneBase = this.config?.projectPath
      ? join(this.config.projectPath, HANDLER_FOLDER)
      : join("<unknown>", HANDLER_FOLDER);
    const standaloneScriptsDir = join(standaloneBase, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    const standaloneFileCount = existsSync(standaloneScriptsDir)
      ? readdirSync(standaloneScriptsDir).filter((f) => f.endsWith(".c")).length
      : 0;
    const standaloneAddon = {
      path: standaloneBase,
      exists: existsSync(standaloneBase),
      fileCount: standaloneFileCount,
    };

    // Scan project path for mods that have handler scripts installed
    const installedMods: DiagnosticReport["installedMods"] = [];
    if (this.config?.projectPath && existsSync(this.config.projectPath)) {
      try {
        for (const entry of readdirSync(this.config.projectPath, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (entry.name === HANDLER_FOLDER) continue; // standalone, covered above
          const handlerDir = join(this.config.projectPath, entry.name, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
          if (existsSync(handlerDir)) {
            const fileCount = readdirSync(handlerDir).filter((f) => f.endsWith(".c")).length;
            installedMods.push({ modDir: join(this.config.projectPath, entry.name), handlerDir, fileCount });
          }
        }
      } catch { /* ignore */ }
    }

    // --- NET API probe ---
    let netApi: DiagnosticReport["netApi"] = "refused";
    let netApiError: string | undefined;
    try {
      await this.rawCall("EMCP_WB_Ping", {}, { timeout: 3000, skipAutoLaunch: true });
      netApi = "up_with_handlers";
    } catch (err) {
      if (err instanceof WorkbenchError) {
        netApiError = err.message;
        if (err.code === "CONNECTION_REFUSED") {
          netApi = "refused";
        } else if (err.code === "TIMEOUT") {
          netApi = "timeout";
        } else if (err.code === "API_ERROR" && err.message.includes("not existing Net API function")) {
          netApi = "up_no_handlers";
        } else {
          netApi = "error";
        }
      } else {
        netApi = "error";
        netApiError = String(err);
      }
    }

    return {
      host,
      port,
      workbenchExe,
      projectPath: projectPathInfo,
      defaultMod,
      bundledScripts,
      standaloneAddon,
      installedMods,
      netApi,
      netApiError,
    };
  }

  /**
   * Remove the standalone EnfusionMCP addon directory if it exists.
   * This prevents duplicate class name errors when handler scripts are injected
   * into a user's mod and the standalone folder is also present in the addons dir.
   */
  private cleanupStandaloneAddon(): void {
    const fallbackBase = this.config?.projectPath;
    if (!fallbackBase) return;
    const standaloneDir = join(fallbackBase, HANDLER_FOLDER);
    if (!existsSync(standaloneDir)) return;
    try {
      rmSync(standaloneDir, { recursive: true, force: true });
      logger.info(`Removed leftover standalone addon: ${standaloneDir}`);
    } catch (e) {
      logger.warn(`Failed to remove standalone addon: ${e}`);
    }
  }

  toString(): string {
    return `WorkbenchClient(${this.host}:${this.port})`;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /** Extract mode from a response object if it contains a `mode` field. */
  private extractMode(result: unknown): void {
    if (result && typeof result === "object" && "mode" in result) {
      const mode = (result as Record<string, unknown>).mode;
      if (mode === "edit") {
        this._state.mode = "edit";
      } else if (mode === "play" || mode === "game") {
        // Scripts return "game" when in play mode (WorldEditorAPI unavailable)
        this._state.mode = "play";
      }
      // "no_world_editor" and unrecognised values leave mode as-is (stays "unknown")
    }
  }

  private async recoverOwnedWorkbench(): Promise<OwnedWorkbenchLaunch | null> {
    const current = this.ownedWorkbench;
    if (current) {
      if (current.process && current.process.exitCode === null && !current.process.killed) {
        return current;
      }
      if (current.marker) {
        const recovered = await this.processGuard.recoverOwnerMarker();
        if (recovered && recovered.token === current.marker.token) {
          const adopted: OwnedWorkbenchLaunch = {
            process: null,
            pid: recovered.pid,
            gprojPath: recovered.gprojPath,
            marker: recovered,
          };
          this.ownedWorkbench = adopted;
          return adopted;
        }
      }
      this.ownedWorkbench = null;
    }

    const marker = await this.processGuard.recoverOwnerMarker();
    if (!marker) return null;
    const adopted: OwnedWorkbenchLaunch = {
      process: null,
      pid: marker.pid,
      gprojPath: marker.gprojPath,
      marker,
    };
    this.ownedWorkbench = adopted;
    logger.info(`Recovered durable ownership of Workbench PID ${marker.pid}.`);
    return adopted;
  }

  private async performOwnedRestart(): Promise<WorkbenchRestartResult> {
    if (!this.config) {
      throw new WorkbenchError("No config provided — cannot restart Workbench.", "LAUNCH_FAILED");
    }

    // Do not race a launch already in progress. It may establish the ownership
    // record needed below, and no other lifecycle operation should overlap it.
    if (this.launchPromise) await this.launchPromise;

    const owned = await this.recoverOwnedWorkbench();
    if (!owned) {
      throw new WorkbenchError(
        "Restart refused: this MCP instance does not own the running Workbench process. " +
          "Close the pre-existing Workbench yourself, then use wb_launch so future clean restarts are owner-scoped.",
        "LAUNCH_FAILED"
      );
    }

    const previousPid = owned.pid;
    const retainedGproj = owned.gprojPath ?? undefined;
    await this.terminateOwnedWorkbench(owned);

    const launch = this.launchWorkbench(retainedGproj, true, true);
    this.launchPromise = launch;
    try {
      await launch;
    } finally {
      if (this.launchPromise === launch) this.launchPromise = null;
    }

    const restarted = this.ownedWorkbench;
    if (!restarted || (restarted.process && restarted.process.exitCode !== null)) {
      throw new WorkbenchError(
        "Workbench restart did not establish ownership of the replacement process.",
        "LAUNCH_FAILED"
      );
    }

    return {
      previousPid,
      pid: restarted.pid,
      gprojPath: restarted.gprojPath,
    };
  }

  private async terminateOwnedWorkbench(owned: OwnedWorkbenchLaunch): Promise<void> {
    // Re-check object identity immediately before termination. If the child
    // exited and a user launched another Workbench, that process is not ours.
    if (this.ownedWorkbench !== owned) {
      throw new WorkbenchError(
        "Restart refused: ownership of the Workbench process was lost before termination.",
        "LAUNCH_FAILED"
      );
    }

    if (owned.marker) {
      try {
        await this.processGuard.terminateVerifiedOwner(owned.marker, OWNED_PROCESS_EXIT_TIMEOUT_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new WorkbenchError(message, "LAUNCH_FAILED");
      }
    } else if (owned.process) {
      // Legacy/in-memory test seam. Production launches always persist a marker
      // before they can be considered owned.
      let signalled = false;
      try {
        signalled = owned.process.kill();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new WorkbenchError(
          `Could not terminate MCP-owned Workbench process ${owned.pid}: ${message}`,
          "LAUNCH_FAILED"
        );
      }
      if (!signalled) {
        throw new WorkbenchError(
          `Could not terminate MCP-owned Workbench process ${owned.pid}; restart aborted.`,
          "LAUNCH_FAILED"
        );
      }
      await this.waitForOwnedProcessExit(owned);
    } else {
      throw new WorkbenchError("Owned Workbench has no verifiable process identity.", "LAUNCH_FAILED");
    }
    if (this.ownedWorkbench === owned) this.ownedWorkbench = null;
    this._state = { connected: false, mode: "unknown", lastUpdated: Date.now() };
    await this.waitForPortRelease();
  }

  private async terminateSpawnedChild(owned: OwnedWorkbenchLaunch): Promise<void> {
    const child = owned.process;
    if (!child || child.exitCode !== null) {
      if (owned.marker) this.processGuard.clearOwnerMarker(owned.marker.token);
      if (this.ownedWorkbench === owned) this.ownedWorkbench = null;
      return;
    }

    if (owned.marker) {
      try {
        await this.processGuard.terminateVerifiedOwner(owned.marker, OWNED_PROCESS_EXIT_TIMEOUT_MS);
      } catch (error) {
        throw new WorkbenchError(
          `Launch failed and exact-child cleanup could not be proven: ${error instanceof Error ? error.message : String(error)}`,
          "LAUNCH_FAILED"
        );
      }
    } else {
      let signalled = false;
      try {
        signalled = child.kill();
      } catch (error) {
        throw new WorkbenchError(
          `Launch failed and spawned child ${owned.pid} could not be terminated: ${error instanceof Error ? error.message : String(error)}`,
          "LAUNCH_FAILED"
        );
      }
      if (!signalled) {
        throw new WorkbenchError(
          `Launch failed and spawned child ${owned.pid} rejected termination.`,
          "LAUNCH_FAILED"
        );
      }
      await this.waitForOwnedProcessExit(owned);
    }
    if (this.ownedWorkbench === owned) this.ownedWorkbench = null;
    this._state = { connected: false, mode: "unknown", lastUpdated: Date.now() };
  }

  private waitForOwnedProcessExit(owned: OwnedWorkbenchLaunch): Promise<void> {
    const ownedProcess = owned.process;
    if (!ownedProcess || ownedProcess.exitCode !== null) return Promise.resolve();

    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new WorkbenchError(
          `MCP-owned Workbench process ${owned.pid} did not exit within ` +
            `${OWNED_PROCESS_EXIT_TIMEOUT_MS / 1000}s; restart aborted without terminating any other process.`,
          "LAUNCH_FAILED"
        ));
      }, OWNED_PROCESS_EXIT_TIMEOUT_MS);

      const onExit = (): void => {
        cleanup();
        resolvePromise();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(new WorkbenchError(
          `MCP-owned Workbench process ${owned.pid} failed while exiting: ${error.message}`,
          "LAUNCH_FAILED"
        ));
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        ownedProcess.off("exit", onExit);
        ownedProcess.off("error", onError);
      };

      ownedProcess.once("exit", onExit);
      ownedProcess.once("error", onError);

      // The child can exit after the status check above but before the event
      // listeners are attached. Re-check after attachment so that race cannot
      // turn a confirmed exit into a false 15-second cleanup timeout.
      if (ownedProcess.exitCode !== null) onExit();
    });
  }

  private async waitForPortRelease(): Promise<void> {
    const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await this.isPortListening())) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, PORT_RELEASE_POLL_MS));
    }

    throw new WorkbenchError(
      `Workbench NET API port ${this.host}:${this.port} remained occupied after the MCP-owned process exited. ` +
        "A different Workbench may now own it; restart aborted.",
      "LAUNCH_FAILED"
    );
  }

  private isPortListening(timeoutMs = 500): Promise<boolean> {
    return new Promise((resolvePromise) => {
      const socket = new Socket();
      let settled = false;
      const finish = (listening: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolvePromise(listening);
      };

      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.connect(this.port, this.host);
    });
  }

  private async launchWorkbench(
    gprojPath?: string,
    requireVacantPort = false,
    forceNoThrow = false
  ): Promise<void> {
    return this.processGuard.withLaunchLock(
      () => this.launchWorkbenchLocked(gprojPath, requireVacantPort, forceNoThrow)
    );
  }

  private async launchWorkbenchLocked(
    gprojPath?: string,
    requireVacantPort = false,
    forceNoThrow = false
  ): Promise<void> {
    // A responsive port is not ownership proof. Recover only a process whose
    // executable, creation time, PID, and random command-line token all match.
    const recovered = await this.recoverOwnedWorkbench();
    if (recovered) {
      if (!requireVacantPort && await this.ping()) {
        logger.info(`Workbench PID ${recovered.pid} is already running and durably MCP-owned.`);
        return;
      }
      throw new WorkbenchError(
        `MCP-owned Workbench PID ${recovered.pid} is still running but its NET API is unavailable. ` +
          "Refusing to spawn a duplicate; restart the verified owner or inspect its logs.",
        "LAUNCH_FAILED"
      );
    }
    if (await this.isPortListening()) {
      throw new WorkbenchError(
        `Workbench NET API port ${this.host}:${this.port} is already occupied. ` +
          "Refusing to launch or replace a process this MCP instance does not own.",
        "LAUNCH_FAILED"
      );
    }
    try {
      await this.processGuard.assertNoWorkbenchProcesses();
    } catch (error) {
      throw new WorkbenchError(error instanceof Error ? error.message : String(error), "LAUNCH_FAILED");
    }

    // 2. Resolve the target .gproj and inject handler scripts into that mod.
    //    Handler scripts must compile as part of the opened project — Workbench
    //    only compiles the active project and its declared dependencies, NOT every
    //    addon folder in the project directory.  A standalone sibling addon will
    //    never be compiled unless the user's project explicitly depends on it.
    let resolvedGproj = gprojPath || this.findFallbackGproj();
    if (resolvedGproj) {
      this.installHandlerScripts(dirname(resolvedGproj));
      // Remove any leftover standalone addon to prevent duplicate class errors.
      // If a previous session created {projectPath}/EnfusionMCP/ it would be
      // picked up as a sibling addon and cause compile-time class name conflicts.
      this.cleanupStandaloneAddon();
    } else {
      // No project found — fall back to standalone addon as last resort and open it
      // directly so its handlers at least compile (user's project won't be open).
      this.installHandlerScripts();
      const fallbackBase = this.config?.projectPath;
      if (fallbackBase) {
        const standaloneGproj = join(fallbackBase, HANDLER_FOLDER, `${HANDLER_FOLDER}.gproj`);
        if (existsSync(standaloneGproj)) {
          resolvedGproj = standaloneGproj;
        }
      }
    }

    // 3. Find executable
    const exePath = this.findWorkbenchExe();
    if (!exePath) {
      const wbPath = this.config?.workbenchPath ?? "(not configured)";
      throw new WorkbenchError(
        `Cannot find ${WORKBENCH_EXE}. Install Arma Reforger Tools from Steam, ` +
          `or set ENFUSION_WORKBENCH_PATH. Searched:\n` +
          `  - ${join(wbPath, WORKBENCH_SUBDIR, WORKBENCH_EXE)}\n` +
          `  - ${join(wbPath, WORKBENCH_EXE)}`,
        "LAUNCH_FAILED"
      );
    }

    // 4. Build dependency-aware launch arguments. Explicit addon roots make
    //    base-game and Workshop dependencies available before the project loads.
    const ownerToken = this.processGuard.createOwnerToken();
    const args = buildWorkbenchLaunchArgs(
      resolvedGproj,
      this.config?.workbenchAddonDirs,
      this.config?.workbenchScriptAuthorizeAll === true,
      // Automated sessions never permit modal assertions. A legacy false
      // setting can no longer weaken this invariant.
      true,
      this.processGuard.ownerArgument(ownerToken)
    );

    // Retain the game install directory as a backward-compatible CWD fallback
    // for configurations that do not provide explicit addon roots.
    const cwd = this.findGameDir() || dirname(exePath);

    logger.info(`Launching Workbench: ${exePath}${args.length ? ` ${args.join(" ")}` : ""} (cwd: ${cwd})`);
    const launchedAtMs = Date.now();
    const proc = spawn(exePath, args, {
      detached: true,
      stdio: "ignore",
      cwd,
    });
    if (proc.pid === undefined) {
      // A failed spawn reports through the asynchronous error event. Consume it
      // so refusing an unowned process cannot become an unhandled exception.
      proc.once("error", (error) => logger.warn(`Workbench spawn failed: ${error.message}`));
      throw new WorkbenchError(
        "Workbench was spawned without a process ID; ownership cannot be proven.",
        "LAUNCH_FAILED"
      );
    }
    const owned: OwnedWorkbenchLaunch = {
      process: proc,
      pid: proc.pid,
      gprojPath: resolvedGproj ?? null,
      marker: null,
    };
    proc.once("error", (error) => {
      owned.spawnError = error;
      if (this.ownedWorkbench === owned) this.ownedWorkbench = null;
    });
    proc.once("exit", () => {
      if (owned.marker) this.processGuard.clearOwnerMarker(owned.marker.token);
      if (this.ownedWorkbench === owned) this.ownedWorkbench = null;
    });
    proc.unref();

    try {
      owned.marker = await this.processGuard.captureOwnerMarker({
        pid: owned.pid,
        executablePath: exePath,
        token: ownerToken,
        launchedAtMs,
        gprojPath: owned.gprojPath,
        host: this.host,
        port: this.port,
      });
      if (this.ownedWorkbench) {
        throw new WorkbenchError(
          `Refusing to overwrite ownership of Workbench PID ${this.ownedWorkbench.pid}.`,
          "LAUNCH_FAILED"
        );
      }
      this.ownedWorkbench = owned;
    } catch (error) {
      await this.terminateSpawnedChild(owned);
      throw error instanceof WorkbenchError
        ? error
        : new WorkbenchError(error instanceof Error ? error.message : String(error), "LAUNCH_FAILED");
    }

    // 5. Wait for NET API — track the last error type so the timeout message is actionable
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    let lastErrorCode: WorkbenchError["code"] | undefined;
    try {
    while (Date.now() < deadline) {
      if (owned.spawnError) {
        throw new WorkbenchError(
          `Workbench process ${owned.pid} failed to start: ${owned.spawnError.message}`,
          "LAUNCH_FAILED"
        );
      }
      if (proc.exitCode !== null) {
        throw new WorkbenchError(
          `Workbench process ${owned.pid} exited before the NET API became available (exit code ${proc.exitCode}).`,
          "LAUNCH_FAILED"
        );
      }
      try {
        await this.rawCall("EMCP_WB_Ping", {}, { timeout: 3000, skipAutoLaunch: true });
        this._state.connected = true;
        this._state.lastUpdated = Date.now();
        logger.info("Workbench NET API is responding.");
        return;
      } catch (err) {
        if (err instanceof WorkbenchError) {
          lastErrorCode = err.code;
          logger.debug(`Workbench poll (${err.code}): ${err.message}`);
        }
      }
      await new Promise((r) => setTimeout(r, LAUNCH_POLL_INTERVAL_MS));
    }

    // Build a specific diagnostic based on what was failing at timeout.
    // CONNECTION_REFUSED = NET API port never opened → NET API likely disabled.
    // API_ERROR = NET API is up but EMCP_WB_Ping isn't registered → handler scripts
    //             didn't compile (project has script errors, or wrong mod directory).
    let hint: string;
    if (lastErrorCode === "API_ERROR") {
      hint =
        `Workbench NET API responded but handler scripts did not load. ` +
        `Check for script compilation errors in Workbench (Script Editor). ` +
        `Fix any errors in the project's scripts so the EnfusionMCP handlers can compile, ` +
        `then try again.`;
    } else {
      hint =
        `NET API port never responded. Ensure NET API is enabled in Workbench: ` +
        `File > Options > General > Net API (checkbox must be on).`;
    }

      throw new WorkbenchError(
        `Workbench launched but did not connect within ${LAUNCH_TIMEOUT_MS / 1000}s. ` +
          `The exact owned child will be terminated before failure is returned.\n\n${hint}`,
        "LAUNCH_FAILED"
      );
    } catch (error) {
      await this.terminateSpawnedChild(owned);
      throw error;
    }
  }

  private findWorkbenchExe(): string | null {
    if (!this.config) return null;
    const subPath = join(this.config.workbenchPath, WORKBENCH_SUBDIR, WORKBENCH_EXE);
    if (existsSync(subPath)) return subPath;

    const rootPath = join(this.config.workbenchPath, WORKBENCH_EXE);
    if (existsSync(rootPath)) return rootPath;

    return null;
  }

  /**
   * Find a .gproj to pass via -gproj so Workbench skips the launcher.
   * Prefers config.defaultMod if set; otherwise picks first addon found.
   * Scans for any .gproj in each addon folder (name need not match folder).
   */
  private findFallbackGproj(): string | null {
    const findGprojInDir = (dir: string): string | null => {
      try {
        for (const f of readdirSync(dir, { withFileTypes: true })) {
          if (!f.isDirectory() && f.name.endsWith(".gproj")) {
            return join(dir, f.name);
          }
        }
      } catch { /* ignore */ }
      return null;
    };

    try {
      const addonsDir = this.config?.projectPath;
      if (!addonsDir || !existsSync(addonsDir)) return null;

      // Prefer the configured default mod over alphabetical first-pick
      const preferred = this.config?.defaultMod;
      if (preferred) {
        const gprojPath = findGprojInDir(join(addonsDir, preferred));
        if (gprojPath) {
          logger.info(`Using defaultMod gproj to skip launcher: ${gprojPath}`);
          return gprojPath;
        }
      }

      for (const entry of readdirSync(addonsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const gprojPath = findGprojInDir(join(addonsDir, entry.name));
        if (gprojPath) {
          logger.info(`Using fallback gproj to skip launcher: ${gprojPath}`);
          return gprojPath;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Derive the Arma Reforger game install directory.
   * Checks ENFUSION_GAME_PATH env var first, then walks up from workbenchPath.
   * workbenchPath may point to the Tools root OR the Workbench subdirectory,
   * so we try both one and two levels up.
   */
  private findGameDir(): string | null {
    // Explicit env var takes priority
    const envGamePath = process.env.ENFUSION_GAME_PATH;
    if (envGamePath && existsSync(join(envGamePath, "addons"))) {
      logger.info(`Using game directory from ENFUSION_GAME_PATH: ${envGamePath}`);
      return envGamePath;
    }

    if (!this.config) return null;
    const toolsDir = this.config.workbenchPath;
    // workbenchPath may be "Arma Reforger Tools" or "Arma Reforger Tools\Workbench"
    const candidates = [
      resolve(toolsDir, "..", "Arma Reforger"),
      resolve(toolsDir, "..", "ArmaReforger"),
      resolve(toolsDir, "..", "..", "Arma Reforger"),
      resolve(toolsDir, "..", "..", "ArmaReforger"),
    ];
    for (const candidate of candidates) {
      if (existsSync(join(candidate, "addons"))) {
        logger.info(`Using game directory as CWD: ${candidate}`);
        return candidate;
      }
    }
    logger.warn("Could not find Arma Reforger game directory. Workbench may fail to resolve base game addon.");
    return null;
  }

  /**
   * Copy handler scripts into a mod directory so they compile as part of that mod.
   * If no modDir given, installs to default project path (standalone, less useful).
   */
  private installHandlerScripts(modDir?: string): void {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const bundledDir = join(packageRoot, "mod", "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    if (!existsSync(bundledDir)) {
      logger.warn("Bundled handler scripts not found in package.");
      return;
    }

    const fallbackBase = this.config?.projectPath;
    if (!modDir && !fallbackBase) {
      logger.warn("No modDir or projectPath configured — cannot install handler scripts.");
      return;
    }
    const isFallback = !modDir;
    const targetBase = modDir || join(fallbackBase!, HANDLER_FOLDER);
    const targetScriptsDir = join(targetBase, "Scripts", "WorkbenchGame", HANDLER_FOLDER);

    logger.info(`Refreshing handler scripts at ${targetScriptsDir}`);
    mkdirSync(targetScriptsDir, { recursive: true });

    const files = readdirSync(bundledDir).filter((f) => f.endsWith(".c"));
    try {
      const bundled = new Set(files);
      for (const existing of readdirSync(targetScriptsDir)) {
        if (existing.endsWith(".c") && !bundled.has(existing)) {
          rmSync(join(targetScriptsDir, existing), { force: true });
        }
      }
      for (const file of files) {
        copyFileSync(join(bundledDir, file), join(targetScriptsDir, file));
      }
      writeFileSync(
        join(targetScriptsDir, ".reforger-forge-handler-bundle.json"),
        `${JSON.stringify({ version: 2, files: files.slice().sort() }, null, 2)}\n`,
        "utf8"
      );
    } catch (e) {
      // Partial installation — clean up to avoid broken state on next attempt
      logger.error(`Failed to install handler scripts, rolling back: ${e}`);
      try {
        rmSync(targetScriptsDir, { recursive: true, force: true });
      } catch { /* best-effort cleanup */ }
      throw e;
    }

    logger.info(`Refreshed ${files.length} handler scripts (bundle version 2).`);

    // When using the standalone fallback path, also write a .gproj so Workbench
    // treats the directory as a loadable addon and compiles the handler scripts.
    if (isFallback) {
      const gprojPath = join(targetBase, `${HANDLER_FOLDER}.gproj`);
      if (!existsSync(gprojPath)) {
        const gprojContent = generateGproj({ name: HANDLER_FOLDER, title: "EnfusionMCP Handlers" });
        writeFileSync(gprojPath, gprojContent, "utf-8");
        logger.info(`Created standalone addon .gproj at ${gprojPath}`);
      }
    }
  }

  /**
   * Raw TCP call — no auto-launch, no retry.
   */
  private rawCall<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options: WorkbenchCallOptions = {}
  ): Promise<T> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const requestBuf = encodeRequest(this.clientId, apiFunc, params);

    return new Promise<T>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;

      const socket = new Socket();

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          socket.destroy();
          reject(
            new WorkbenchError(
              `Workbench call "${apiFunc}" timed out after ${timeout}ms`,
              "TIMEOUT"
            )
          );
        }
      }, timeout);

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeAllListeners();
      };

      socket.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ECONNREFUSED") {
          reject(
            new WorkbenchError(
              `Cannot connect to Workbench at ${this.host}:${this.port}.`,
              "CONNECTION_REFUSED"
            )
          );
        } else {
          reject(
            new WorkbenchError(
              `Connection error: ${err.message}`,
              "PROTOCOL_ERROR"
            )
          );
        }
      });

      socket.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_SIZE) {
          if (!settled) {
            settled = true;
            cleanup();
            socket.destroy();
            reject(
              new WorkbenchError(
                `Response for "${apiFunc}" exceeded ${MAX_RESPONSE_SIZE} bytes — possible malformed data`,
                "PROTOCOL_ERROR"
              )
            );
          }
          return;
        }
        chunks.push(chunk);
      });

      socket.on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();

        const responseBuf = Buffer.concat(chunks);
        if (responseBuf.length === 0) {
          reject(
            new WorkbenchError(
              `Empty response from Workbench for "${apiFunc}" — connection closed without data`,
              "PROTOCOL_ERROR"
            )
          );
          return;
        }

        try {
          const result = decodeResponse<T>(responseBuf);
          logger.debug(`Workbench response for "${apiFunc}":`, result);
          resolve(result);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isApiError = errMsg.startsWith("Workbench error:");
          reject(
            new WorkbenchError(
              isApiError ? errMsg : `Failed to decode response for "${apiFunc}": ${errMsg}`,
              isApiError ? "API_ERROR" : "PROTOCOL_ERROR"
            )
          );
        }
      });

      socket.on("close", (hadError) => {
        if (settled) return;
        // close fired without end — connection dropped unexpectedly
        settled = true;
        cleanup();

        if (hadError) {
          reject(
            new WorkbenchError(
              `Connection to Workbench closed with error for "${apiFunc}"`,
              "PROTOCOL_ERROR"
            )
          );
          return;
        }

        // No end event + no error = unusual. Try to decode what we have.
        const responseBuf = Buffer.concat(chunks);
        if (responseBuf.length === 0) {
          reject(
            new WorkbenchError(
              `Connection closed without response for "${apiFunc}"`,
              "PROTOCOL_ERROR"
            )
          );
          return;
        }

        try {
          const result = decodeResponse<T>(responseBuf);
          resolve(result);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isApiError = errMsg.startsWith("Workbench error:");
          reject(
            new WorkbenchError(
              isApiError ? errMsg : `Failed to decode response for "${apiFunc}": ${errMsg}`,
              isApiError ? "API_ERROR" : "PROTOCOL_ERROR"
            )
          );
        }
      });

      socket.connect(this.port, this.host, () => {
        logger.debug(
          `Connected to Workbench at ${this.host}:${this.port}, calling "${apiFunc}"`
        );
        socket.end(requestBuf);
      });
    });
  }
}

