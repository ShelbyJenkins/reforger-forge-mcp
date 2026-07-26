import { execFileSync } from "node:child_process";

export type WorkbenchRunnerPrerequisiteErrorCode =
  | "STEAM_CLIENT_NOT_RUNNING"
  | "STEAM_CLIENT_UNVERIFIABLE"
  | "WORKBENCH_STATE_OWNER_MISMATCH"
  | "WORKBENCH_STATE_OWNER_UNVERIFIABLE";

export class WorkbenchRunnerPrerequisiteError extends Error {
  constructor(
    message: string,
    public readonly code: WorkbenchRunnerPrerequisiteErrorCode
  ) {
    super(message);
    this.name = "WorkbenchRunnerPrerequisiteError";
  }
}

export interface SteamClientReadinessDependencies {
  readonly platform?: NodeJS.Platform;
  readonly listProcesses?: () => string;
}

export interface WorkbenchStateOwnership {
  readonly currentSid: string;
  readonly stateDirectoryExists: boolean;
  readonly stateOwnerSid: string | null;
}

export interface WorkbenchStateReadinessDependencies {
  readonly platform?: NodeJS.Platform;
  readonly inspectOwnership?: () => WorkbenchStateOwnership;
}

function listSteamProcesses(): string {
  return execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-Process -Name steam -ErrorAction SilentlyContinue | " +
        "Select-Object -ExpandProperty ProcessName",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }
  );
}

function inspectDefaultWorkbenchStateOwnership(): WorkbenchStateOwnership {
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$ErrorActionPreference = 'Stop'",
        "$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        "$localRoot = $env:LOCALAPPDATA",
        "if ([string]::IsNullOrWhiteSpace($localRoot)) { " +
          "$localRoot = Join-Path $env:USERPROFILE 'AppData\\Local' }",
        "$statePath = Join-Path $localRoot 'ReforgerForge\\Workbench\\v3'",
        "$exists = Test-Path -LiteralPath $statePath -PathType Container",
        "$ownerSid = $null",
        "if ($exists) { " +
          "$owner = (Get-Acl -LiteralPath $statePath).Owner; " +
          "$ownerSid = ([Security.Principal.NTAccount]::new($owner))" +
          ".Translate([Security.Principal.SecurityIdentifier]).Value }",
        "[pscustomobject]@{ currentSid = $currentSid; " +
          "stateDirectoryExists = $exists; stateOwnerSid = $ownerSid } | " +
          "ConvertTo-Json -Compress",
      ].join("; "),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }
  );
  const parsed = JSON.parse(output) as Partial<WorkbenchStateOwnership>;
  if (typeof parsed.currentSid !== "string" ||
      typeof parsed.stateDirectoryExists !== "boolean" ||
      (parsed.stateOwnerSid !== null && typeof parsed.stateOwnerSid !== "string")) {
    throw new Error("PowerShell returned an invalid Workbench state ownership record");
  }
  return {
    currentSid: parsed.currentSid,
    stateDirectoryExists: parsed.stateDirectoryExists,
    stateOwnerSid: parsed.stateOwnerSid ?? null,
  };
}

/**
 * Refuse before the native Workbench executable is spawned when its Steam
 * runtime prerequisite is absent. Process-name presence is only a prerequisite
 * diagnostic; exact Workbench identity remains governed by the lifecycle guard.
 */
export function assertSteamClientReady(
  dependencies: SteamClientReadinessDependencies = {}
): void {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32") {
    throw new WorkbenchRunnerPrerequisiteError(
      `Steam client readiness cannot be verified on unsupported platform '${platform}'. ` +
        "No Workbench process was launched.",
      "STEAM_CLIENT_UNVERIFIABLE"
    );
  }
  let processList: string;
  try {
    processList = (dependencies.listProcesses ?? listSteamProcesses)();
  } catch (error) {
    throw new WorkbenchRunnerPrerequisiteError(
      `Steam client readiness could not be verified before launching Workbench ` +
        `(${error instanceof Error ? error.message : String(error)}). No Workbench process was launched.`,
      "STEAM_CLIENT_UNVERIFIABLE"
    );
  }
  const running = processList
    .split(/\r?\n/)
    .some((line) => line.trim().toLowerCase() === "steam");
  if (!running) {
    throw new WorkbenchRunnerPrerequisiteError(
      "Steam client is not running. Start Steam, wait for it to finish initializing, " +
        "then retry the Workbench command. No Workbench process was launched.",
      "STEAM_CLIENT_NOT_RUNNING"
    );
  }
}

/**
 * A packaged CLI must not open another Windows identity's live LMDB mapping.
 * The native binding can fail before JavaScript receives an exception.
 */
export function assertWorkbenchStateOwnerReady(
  dependencies: WorkbenchStateReadinessDependencies = {}
): void {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32") {
    throw new WorkbenchRunnerPrerequisiteError(
      `Workbench lifecycle state ownership cannot be verified on unsupported platform ` +
        `'${platform}'. No Workbench process was launched.`,
      "WORKBENCH_STATE_OWNER_UNVERIFIABLE"
    );
  }
  let ownership: WorkbenchStateOwnership;
  try {
    ownership = (dependencies.inspectOwnership ??
      inspectDefaultWorkbenchStateOwnership)();
  } catch (error) {
    throw new WorkbenchRunnerPrerequisiteError(
      `Workbench lifecycle state ownership could not be verified before opening durable ` +
        `state (${error instanceof Error ? error.message : String(error)}). ` +
        `No Workbench process was launched.`,
      "WORKBENCH_STATE_OWNER_UNVERIFIABLE"
    );
  }
  if (ownership.stateDirectoryExists &&
      (!ownership.stateOwnerSid ||
        ownership.currentSid.toLowerCase() !== ownership.stateOwnerSid.toLowerCase())) {
    throw new WorkbenchRunnerPrerequisiteError(
      "Workbench lifecycle state is owned by a different Windows identity. " +
        "Run the command as the Windows user that owns the configured LOCALAPPDATA " +
        "directory. No Workbench process was launched.",
      "WORKBENCH_STATE_OWNER_MISMATCH"
    );
  }
}
