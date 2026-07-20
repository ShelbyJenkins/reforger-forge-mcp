/**
 * Read-only Workbench configuration, companion, NET API, and lifecycle diagnostics.
 *
 * This module intentionally receives only a lifecycle reader and a NET call
 * callback. It has no staging, retention, ownership, spawn, or termination
 * authority.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
  WORKBENCH_HELPER_ADDON_VERSION,
  WORKBENCH_HELPER_BUILD_IDENTITY,
  WORKBENCH_HELPER_PROTOCOL_VERSION,
  defaultWorkbenchHelperSource,
  verifyWorkbenchHelperSource,
} from "./helper-addon.js";
import type { LifecycleStateRead, WorkbenchProcessGuard } from "./process-guard.js";

const WORKBENCH_EXE = "ArmaReforgerWorkbenchSteamDiag.exe";
const WORKBENCH_SUBDIR = "Workbench";

export interface LifecycleDiagnostic {
  state: "missing" | "valid" | "malformed";
  version: number | null;
  generation: string | null;
  phase: string | null;
  endpoint: string | null;
  target: string | null;
  lease: "current_mcp" | "other_mcp" | "vacant" | "unknown";
  operation: string | null;
  companionBuildIdentity: string | null;
  detail?: string;
}

export interface DiagnosticReport {
  host: string;
  port: number;
  workbenchExe: { path: string; exists: boolean } | null;
  projectPath: { path: string; exists: boolean } | null;
  defaultMod: string | null;
  companionAddon: {
    addonId: string;
    addonGuid: string;
    path: string;
    buildIdentity: string;
    bundleDigest: string;
  } | null;
  netApi: "up_with_companion" | "up_no_companion" | "refused" | "timeout" | "error";
  netApiError?: string;
  lifecycle: LifecycleDiagnostic;
}

export interface WorkbenchDiagnosticNetError {
  readonly code: string;
  readonly message: string;
}

export interface WorkbenchDiagnosticOptions {
  readonly host: string;
  readonly port: number;
  readonly config?: Config;
  readonly lifecycle: Pick<WorkbenchProcessGuard, "mcpInstanceId" | "readLifecycleState">;
  readonly callNetApi: <T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown>,
    options: { timeout: number; skipAutoLaunch: true }
  ) => Promise<T>;
  /** Preserve the caller's public error classification without importing it here. */
  readonly classifyNetError: (error: unknown) => WorkbenchDiagnosticNetError | null;
}

function workbenchExecutable(config: Config): string {
  const candidates = [
    join(config.workbenchPath, WORKBENCH_SUBDIR, WORKBENCH_EXE),
    join(config.workbenchPath, WORKBENCH_EXE),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function emptyLifecycleDiagnostic(
  state: "missing" | "malformed",
  lease: "vacant" | "unknown",
  detail?: string
): LifecycleDiagnostic {
  return {
    state,
    version: null,
    generation: null,
    phase: null,
    endpoint: null,
    target: null,
    lease,
    operation: null,
    companionBuildIdentity: null,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Convert a lifecycle state read into the stable public diagnostic shape. */
export function formatLifecycleDiagnostic(
  read: LifecycleStateRead,
  currentMcpInstanceId: string
): LifecycleDiagnostic {
  if (read.kind === "missing") {
    return emptyLifecycleDiagnostic("missing", "vacant");
  }
  if (read.kind === "malformed") {
    return emptyLifecycleDiagnostic("malformed", "unknown", read.message);
  }

  const state = read.state;
  return {
    state: "valid",
    version: 3,
    generation: state.generation,
    phase: state.phase,
    endpoint: `${state.endpoint.host}:${state.endpoint.port}`,
    target: state.target?.path ?? null,
    lease: !state.mcpOwner
      ? "vacant"
      : state.mcpOwner.instanceId === currentMcpInstanceId
        ? "current_mcp"
        : "other_mcp",
    operation: state.operation ? `${state.operation.kind}:${state.operation.operationId}` : null,
    companionBuildIdentity: state.companion?.buildIdentity ?? null,
  };
}

/** Read lifecycle evidence without locking, claiming, reconciling, or writing it. */
export async function diagnoseLifecycle(
  lifecycle: Pick<WorkbenchProcessGuard, "mcpInstanceId" | "readLifecycleState">
): Promise<LifecycleDiagnostic> {
  try {
    return formatLifecycleDiagnostic(
      await lifecycle.readLifecycleState(),
      lifecycle.mcpInstanceId
    );
  } catch (error) {
    return emptyLifecycleDiagnostic(
      "malformed",
      "unknown",
      error instanceof Error ? error.message : String(error)
    );
  }
}

/** Produce the historical Workbench diagnostic report without lifecycle mutation. */
export async function diagnoseWorkbench(
  options: WorkbenchDiagnosticOptions
): Promise<DiagnosticReport> {
  const workbenchExePath = options.config ? workbenchExecutable(options.config) : null;
  const projectPath = options.config?.projectPath
    ? { path: options.config.projectPath, exists: existsSync(options.config.projectPath) }
    : null;

  let companionAddon: DiagnosticReport["companionAddon"] = null;
  try {
    const verified = verifyWorkbenchHelperSource(defaultWorkbenchHelperSource());
    companionAddon = {
      addonId: verified.manifest.addonId,
      addonGuid: verified.manifest.addonGuid,
      path: verified.sourceDirectory,
      buildIdentity: verified.manifest.buildIdentity,
      bundleDigest: verified.manifest.bundleDigest,
    };
  } catch {
    // Diagnostics are read-only and best-effort; launch reports the exact stage error.
  }

  let netApi: DiagnosticReport["netApi"] = "refused";
  let netApiError: string | undefined;
  try {
    const response = await options.callNetApi<Record<string, unknown>>(
      "EMCP_WB_Ping",
      {},
      { timeout: 3000, skipAutoLaunch: true }
    );
    if (response.status === "ok" &&
        response.helperAddonId === WORKBENCH_HELPER_ADDON_ID &&
        response.helperAddonGuid === WORKBENCH_HELPER_ADDON_GUID &&
        response.helperAddonVersion === WORKBENCH_HELPER_ADDON_VERSION &&
        response.helperProtocolVersion === WORKBENCH_HELPER_PROTOCOL_VERSION &&
        response.workbenchProtocol === WORKBENCH_HELPER_PROTOCOL_VERSION &&
        response.helperBuildIdentity === WORKBENCH_HELPER_BUILD_IDENTITY) {
      netApi = "up_with_companion";
    } else {
      netApi = "up_no_companion";
      netApiError = "NET API responded without the exact managed Workbench companion identity.";
    }
  } catch (error) {
    const classified = options.classifyNetError(error);
    if (classified) {
      netApiError = classified.message;
      if (classified.code === "CONNECTION_REFUSED") netApi = "refused";
      else if (classified.code === "TIMEOUT") netApi = "timeout";
      else if (classified.code === "API_ERROR" &&
        (classified.message.includes("not existing Net API function") ||
          classified.message.includes("Undefined API func"))) {
        netApi = "up_no_companion";
      } else {
        netApi = "error";
      }
    } else {
      netApi = "error";
      netApiError = String(error);
    }
  }

  return {
    host: options.host,
    port: options.port,
    workbenchExe: workbenchExePath
      ? { path: workbenchExePath, exists: existsSync(workbenchExePath) }
      : null,
    projectPath,
    defaultMod: options.config?.defaultMod ?? null,
    companionAddon,
    netApi,
    netApiError,
    lifecycle: await diagnoseLifecycle(options.lifecycle),
  };
}
